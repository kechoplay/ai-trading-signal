import Anthropic from '@anthropic-ai/sdk';
import { Candle } from '../market/Candle';
import { AnalysisResult, ConditionalSetup } from './dto/AnalysisResult';
import { config } from '../../config/trading';
import { logger } from '../../logger';

/** Max candles to include in the prompt per timeframe. */
const CANDLES_BY_TF: Record<string, number> = {
  H1:  100,
  M15: 96,
  M5:  60,
};

export class ClaudeAnalystService {
  private readonly client: Anthropic;

  constructor(private readonly model: string) {
    this.client = new Anthropic({
      apiKey: config.claude.apiKey,
      maxRetries: 4,
    });
  }

  static fromConfig(): ClaudeAnalystService {
    if (!config.claude.apiKey) throw new Error('CLAUDE_API_KEY is not configured.');
    return new ClaudeAnalystService(config.claude.model);
  }

  async analyze(
    _instrument: string,
    candlesByTimeframe: Record<string, Candle[]>,
    _currentPrice: number,
    _minRr: number,
  ): Promise<{ result: AnalysisResult; rawText: string }> {
    const systemPrompt = this.buildSystemPrompt();
    const userPrompt = this.buildOhlcPrompt(candlesByTimeframe);

    logger.info('[Claude] User prompt', { prompt: userPrompt });

    // Stream due to large input (candle data) + up to 8K output tokens
    const stream = this.client.messages.stream({
      model: this.model,
      max_tokens: 8192,
      thinking: { type: 'disabled' }, // adaptive là có sử dụng thinking
      system: systemPrompt,
      messages: [{ role: 'user', content: userPrompt }],
    });

    const message = await stream.finalMessage();

    // Extract only text blocks (skip thinking blocks)
    const rawText = message.content
      .filter((b): b is Anthropic.TextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('');

    if (!rawText) throw new Error('Claude returned empty text content.');

    logger.info('[Claude] Raw response', { text: rawText });

    const result = this.parseAnalysisResult(rawText);
    return { result, rawText };
  }

  private parseAnalysisResult(text: string): AnalysisResult {
    const action           = this.extractAction(text);
    const trendBias        = this.extractBias(text);
    const conditionalSetups = this.extractAllSetups(text);

    if (action === 'NO_TRADE') {
      return new AnalysisResult(
        'NO_TRADE', null, null, null, null,
        this.extractConfidence(text), trendBias, text,
        {}, null, null, null, conditionalSetups,
      );
    }

    const section    = this.extractSection(text, action);
    const entry      = extractPriceFromLine(section, 'entry');
    const stopLoss   = extractPriceFromLine(section, 'sl');
    const takeProfit = extractPriceFromLine(section, 'tp1');
    const riskReward = this.extractRRFromLine(section, 'tp1') ?? this.extractRR(section);
    const confidence = this.extractConfidence(section) ?? this.extractConfidence(text);

    return new AnalysisResult(
      action, entry, stopLoss, takeProfit, riskReward,
      confidence, trendBias, text,
      {}, null, null, null, conditionalSetups,
    );
  }

  private extractAllSetups(text: string): ConditionalSetup[] {
    const setups: ConditionalSetup[] = [];

    for (const direction of ['BUY', 'SELL'] as const) {
      const label = direction === 'BUY' ? 'BUY\\s+ORDER' : 'SELL\\s+ORDER';
      const re    = new RegExp(`${label}[\\s\\S]*?(?=####\\s*(?:BUY|SELL)\\s+ORDER|###\\s|---|\n{3,}|$)`, 'i');
      const raw   = text.match(re)?.[0]?.trim();
      if (!raw) continue;

      setups.push({ direction, rawText: raw });
    }

    return setups;
  }

  private extractAction(text: string): 'BUY' | 'SELL' | 'NO_TRADE' {
    // "Patience level: No trade" is the final decision — check first
    if (/patience\s+level[^:\n]*:\s*no\s+trade/i.test(text)) return 'NO_TRADE';

    // "Best opportunity: BUY|SELL" from section 8 SUMMARY
    const m = text.match(/best\s+opportunity[^:\n]*:\s*(BUY|SELL)/i);
    if (m) return m[1].toUpperCase() as 'BUY' | 'SELL';

    // Fallback: only one direction has a section header
    const hasBuy  = /####\s*BUY\s+ORDER/i.test(text);
    const hasSell = /####\s*SELL\s+ORDER/i.test(text);
    if (hasBuy && !hasSell) return 'BUY';
    if (hasSell && !hasBuy) return 'SELL';

    return 'NO_TRADE';
  }

  private extractSection(text: string, action: 'BUY' | 'SELL'): string {
    const label = action === 'BUY' ? 'BUY\\s+ORDER' : 'SELL\\s+ORDER';
    const re    = new RegExp(`${label}[\\s\\S]*?(?=####\\s*(?:BUY|SELL)\\s+ORDER|###\\s|---|\n{3,}|$)`, 'i');
    return text.match(re)?.[0] ?? text;
  }

  private extractRR(section: string): number | null {
    const m1 = section.match(/\bRR\s+(\d+(?:\.\d+)?)\s*:\s*1/i);
    if (m1) return parseFloat(m1[1]);
    const m2 = section.match(/\bRR\s+1\s*:\s*(\d+(?:\.\d+)?)/i);
    if (m2) return parseFloat(m2[1]);
    return null;
  }

  /** Extract RR từ dòng TP cụ thể (tp1/tp2/tp3) — handle "RR khoảng 1:1.5", "RR 2:1" */
  private extractRRFromLine(section: string, tp: 'tp1' | 'tp2' | 'tp3'): number | null {
    const re = new RegExp(`\\b${tp}[^\\n]*RR[^0-9\\n]*(\\d+(?:[.,]\\d+)?)\\s*:\\s*(\\d+(?:[.,]\\d+)?)`, 'i');
    const m  = section.match(re);
    if (!m) return null;
    const a = parseFloat(m[1].replace(',', '.'));
    const b = parseFloat(m[2].replace(',', '.'));
    // Reward side: nếu a=1 thì b là reward, nếu b=1 thì a là reward, không thì lấy số lớn hơn
    if (a === 1) return b;
    if (b === 1) return a;
    return Math.max(a, b);
  }

  private extractConfidence(text: string): number | null {
    const m = text.match(/confidence[^:\n]*:\s*(High|Medium|Low)/i);
    if (!m) return null;
    const c = m[1].toLowerCase();
    if (c === 'high') return 85;
    if (c === 'low')  return 45;
    return 65;
  }

  private extractBias(text: string): string | null {
    const m = text.match(/Bias\s+(?:H1|M15|M5|Overall)[^:\n]*:\s*(BULLISH|BEARISH|NEUTRAL)/i);
    return m ? m[1].toUpperCase() : null;
  }

  // ─── Prompt builders ──────────────────────────────────────────────────────

  private buildSystemPrompt(): string {
    return `You are a professional XAU/USD (gold) trader with 15 years of experience.

I provide OHLC data for XAU/USD across M5, M15 and H1 timeframes with pre-calculated indicators.
Analyze thoroughly using the exact structure below.

---

### 1. MULTI-TIMEFRAME ANALYSIS (MTF)

#### H1 — Higher Timeframe Bias:
- Trend: Up / Down / Sideways
- Price position vs EMA 20/50/200 and HMA 200
- Key Swing High & Swing Low
- BOS or CHoCH if present
- Major H1 Support & Resistance zones
- Bias H1: BULLISH / BEARISH / NEUTRAL

#### M15 — Trend Confirmation:
- Trend: Up / Down / Sideways
- Price position vs EMA 20/50/200 and HMA 200
- Key Swing High & Swing Low
- BOS or CHoCH if present
- Most important M15 Support & Resistance zones
- Bias M15: BULLISH / BEARISH / NEUTRAL

#### M5 — Entry Signal:
- Short-term trend
- Price position vs EMA 20/50/200 and HMA 200
- ATR 14: current volatility
- Last 5 candle shapes: pattern name + significance
- BOS or CHoCH if present
- Bias M5: BULLISH / BEARISH / NEUTRAL

#### MTF Summary:
- Do H1, M15 and M5 align or conflict?
- Overall Bias: BULLISH / BEARISH / NEUTRAL
- If conflicting → state reasons clearly and recommend NO TRADE

---

### 2. MARKET STRUCTURE
- Most important Swing High & Swing Low (across both timeframes)
- HH-HL or LH-LL sequence
- Most recent BOS or CHoCH

---

### 3. KEY PRICE LEVELS
- Major Support & Resistance (M5 + M15 combined)
- Nearest round number
- FVG (Fair Value Gap) if detected
- Bullish and Bearish Order Blocks

---

### 4. SUPPLY & DEMAND ZONES
- Active Supply Zone (potential SELL) — rate as Strong/Medium/Weak
- Active Demand Zone (potential BUY) — rate as Strong/Medium/Weak

---

### 5. INDICATOR CONFIRMATION
- EMA 20/50/200: position and direction
- HMA 200: sloping up / sloping down / flat
- RSI 14: value, positive/negative divergence if any
- ATR 14: basis for SL/TP sizing

---

### 6. TRADE SETUPS

#### BUY ORDER (if applicable):
- Entry zone: [price]
- Trigger condition: [specific]
- SL: [price] — reason — distance [X pip]
- TP1: [price] — RR [X:1]
- TP2: [price] — RR [X:1]
- TP3: [price] — RR [X:1]
- Confidence: High / Medium / Low
- Cancel condition: [specific]

#### SELL ORDER (if applicable):
- Entry zone: [price]
- Trigger condition: [specific]
- SL: [price] — reason — distance [X pip]
- TP1: [price] — RR [X:1]
- TP2: [price] — RR [X:1]
- TP3: [price] — RR [X:1]
- Confidence: High / Medium / Low
- Cancel condition: [specific]

---

### 7. SUMMARY
- Bias H1: BULLISH / BEARISH / NEUTRAL
- Bias M15: BULLISH / BEARISH / NEUTRAL
- Bias M5: BULLISH / BEARISH / NEUTRAL
- Best opportunity: BUY or SELL
- Patience level: Enter now / Wait for retest / No trade
- Brief reason in 1-2 sentences`;
  }

  private buildOhlcPrompt(candlesByTimeframe: Record<string, Candle[]>): string {
    const orderedTf = ['H1', 'M15', 'M5'];
    const allTf = [
      ...orderedTf.filter((tf) => tf in candlesByTimeframe),
      ...Object.keys(candlesByTimeframe).filter((tf) => !orderedTf.includes(tf)),
    ];

    const lines: string[] = [];

    for (const tf of allTf) {
      const candles = candlesByTimeframe[tf];
      if (!candles) continue;

      logger.info(`[${tf}] Market Data`, { timeframe: tf, total: candles.length });

      const limit = CANDLES_BY_TF[tf] ?? 100;
      const candleSlice = candles.slice(-limit);
      const csvRows = candleSlice.map((c) =>
        `${formatCandleTime(c.time)},${c.open},${c.high},${c.low},${c.close}`,
      );

      lines.push(tf);
      lines.push('time,open,high,low,close');
      lines.push(...csvRows);
      lines.push('');
    }

    return lines.join('\n');
  }

}

function formatCandleTime(time: string): string {
  const normalised = time.replace('T', ' ').replace(/Z$/, '');
  return normalised.length >= 16 ? normalised.slice(0, 16) : normalised;
}

function extractPriceFromLine(text: string, keyword: string): number | null {
  const re   = new RegExp(`^[^\\n]*\\b${keyword}\\b[^\\n]*$`, 'im');
  const line = text.match(re)?.[0];
  if (!line) return null;
  const nums = line.match(/\b\d{3,}(?:[.,]\d+)?\b/g);
  if (!nums) return null;
  return parseFloat(nums[0].replace(',', ''));
}
