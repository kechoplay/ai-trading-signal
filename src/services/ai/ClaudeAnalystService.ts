import Anthropic from '@anthropic-ai/sdk';
import { Candle } from '../market/Candle';
import { AnalysisResult, ConditionalSetup } from './dto/AnalysisResult';
import { config } from '../../config/trading';
import { logger } from '../../logger';
import { preprocess } from './ict/IctPreprocessor';

export class ClaudeAnalystService {
  private readonly client: Anthropic;
  protected readonly tfOrder: string[] = ['H1', 'M15', 'M5'];

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
  ): Promise<{ result: AnalysisResult; rawText: string }> {
    const systemPrompt = this.buildSystemPrompt();
    const userPrompt = this.buildOhlcPrompt(candlesByTimeframe);

    logger.info('[Claude] User prompt', { prompt: userPrompt });

    // max_tokens phải đủ lớn cho cả thinking + text response
    // thinking: adaptive không có budget_tokens → model tự phân bổ từ max_tokens
    // Nếu max_tokens quá nhỏ, thinking ăn hết token, text block trả về rỗng
    const stream = this.client.messages.stream({
      model:      this.model,
      max_tokens: 64000,
      thinking:   { type: 'adaptive' },  // disabled
      system:     systemPrompt,
      messages:   [{ role: 'user', content: userPrompt }],
    });

    const message = await stream.finalMessage();

    // Log toàn bộ block types để debug nếu có lỗi
    const blockTypes = message.content.map((b) => b.type);
    logger.info('[Claude] Content blocks', { blockTypes, usage: message.usage });

    // Extract text blocks (bỏ qua thinking blocks)
    const rawText = message.content
      .filter((b): b is Anthropic.TextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('');

    if (!rawText) {
      throw new Error(
        `Claude returned no text content. Blocks received: [${blockTypes.join(', ')}]. ` +
        `Usage: input=${message.usage.input_tokens}, output=${message.usage.output_tokens}`,
      );
    }

    logger.info('[Claude] Raw response:\n' + rawText);

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
    const m = text.match(/Bias\s+(?:W|D|H4|H1|M15|M5|Overall)[^:\n]*:\s*(BULLISH|BEARISH|NEUTRAL)/i);
    return m ? m[1].toUpperCase() : null;
  }

  // ─── Prompt builders ──────────────────────────────────────────────────────

  protected buildSystemPrompt(): string {
    return `Bạn là trader chuyên nghiệp XAU/USD với 15 năm kinh nghiệm, chuyên phương pháp ICT/SMC price action.

Tôi cung cấp dữ liệu nến OHLC thô của XAU/USD trên 3 khung: H1, M15, M5 (có timestamp Unix giây, UTC).
Kèm theo là khối "CÁC MỨC ĐÃ TÍNH SẴN BẰNG CODE" (JSON): swing high/low, range + fib (premium/discount/equilibrium),
ATR, FVG, order block, liquidity (equal highs/lows) và kill zone của nến mới nhất.
Phân tích THUẦN TÚY từ price action. Bỏ qua mọi bình luận ngoài cấu trúc output bên dưới.

## CÁCH DÙNG SỐ LIỆU
- TIN TƯỞNG TUYỆT ĐỐI các con số trong khối JSON đã tính sẵn — KHÔNG tự "bấm máy" tính lại swing/fib/ATR/FVG/OB.
- Dùng các mức đó làm POI, SL, TP, xác định premium/discount và kill zone.
- Chỉ dùng data OHLC thô để đọc thêm context price action (displacement, rejection, nến xác nhận).

## QUY ƯỚC
- Đơn vị giá dùng USD trực tiếp (KHÔNG dùng "pip"). Ví dụ: "SL cách 3.5 USD".
- Mọi mức giá (entry/SL/TP) PHẢI nằm trong hoặc logic với dải giá thực tế của data. TUYỆT ĐỐI không bịa giá. Nếu data không đủ để xác định → NO TRADE.
- Mỗi lần phân tích chỉ xuất MỘT chiều (BUY hoặc SELL), không xuất cả hai cùng lúc.
- Kill zone (giờ VN): London 14:00–17:00, New York 19:30–22:00. Dùng timestamp của data để xác định.

## QUY TRÌNH PHÂN TÍCH BẮT BUỘC (làm tuần tự, không bỏ bước)
1. H1 — Market structure: BOS/CHoCH gần nhất → xác định bias.
2. H1 — Premium/Discount: chia range H1 hiện tại bằng fib 50%, xác định giá đang ở nửa nào.
3. M15 — POI: tìm OB / FVG / vùng liquidity nằm TRONG vùng premium/discount phù hợp với bias.
4. M5 — Confirmation: kiểm tra có CHoCH hoặc BOS nội bộ + nến xác nhận (engulfing/rejection/displacement) khi giá chạm POI.

## ĐỊNH NGHĨA SETUP HỢP LỆ (phải đủ TẤT CẢ)
- 3 khung đồng thuận: H1 bias rõ + giá ở đúng premium/discount + M15 có POI rõ + M5 có confirmation.
- RR của TP1 tối thiểu 1:2.
- Có vùng SL logic (dưới/trên OB hoặc FVG).
Thiếu BẤT KỲ điều nào ở trên → NO TRADE. Không hạ chuẩn để cố tìm lệnh.

## TIÊU CHÍ CONFIDENCE
- High: 3 khung đồng thuận + trong kill zone + RR TP1 ≥ 1:3.
- Medium: 3 khung đồng thuận nhưng ngoài kill zone HOẶC RR TP1 trong khoảng 1:2–1:3.
- Low: chỉ 2 khung đồng thuận → thực tế phải coi là NO TRADE.

## ĐỊNH DẠNG OUTPUT
Nếu KHÔNG đủ điều kiện vào lệnh, chỉ xuất:
- Best opportunity: NO TRADE
- Patience level: No trade
- Lý do: [1 câu ngắn nêu rõ thiếu yếu tố nào]

Nếu có setup hợp lệ, xuất ĐÚNG MỘT block (BUY hoặc SELL):

#### [BUY ORDER / SELL ORDER]
- Entry zone: [giá]
- Điều kiện kích hoạt: [cụ thể — POI nào, confirmation M5 nào]
- SL: [giá] — lý do — cách [X] USD
- TP1: [giá] — RR [X:1]
- TP2: [giá] — RR [X:1]
- TP3: [giá] — RR [X:1]
- Confidence: High / Medium / Low
- Hủy lệnh nếu: [điều kiện invalidation cụ thể]

---

### SUMMARY
- Bias H1: BULLISH / BEARISH / NEUTRAL
- Bias M15: BULLISH / BEARISH / NEUTRAL
- M5 confirmation: Có / Chưa
- Trong kill zone: Có / Không
- Best opportunity: BUY / SELL / NO TRADE
- Patience level: Enter now / Wait for retest / No trade
- Lý do ngắn gọn trong 1-2 câu`;
  }

  protected buildOhlcPrompt(candlesByTimeframe: Record<string, Candle[]>): string {
    const orderedTf = this.tfOrder;
    const allTf = [
      ...orderedTf.filter((tf) => tf in candlesByTimeframe),
      ...Object.keys(candlesByTimeframe).filter((tf) => !orderedTf.includes(tf)),
    ];

    // Cắt nến theo limit từng khung trước, để ICT facts & data thô đồng nhất.
    const slicedByTf: Record<string, Candle[]> = {};
    for (const tf of allTf) {
      const candles = candlesByTimeframe[tf];
      if (!candles) continue;
      const limit = (config.candlesByTf as Record<string, number>)[tf] ?? config.candlesCount;
      slicedByTf[tf] = candles.slice(-limit);
    }

    // Tính sẵn các "facts" ICT/SMC (swing, fib, ATR, FVG, OB, liquidity, kill zone).
    const ictFacts = preprocess(slicedByTf);
    logger.info('[Claude] ICT facts', { killZone: ictFacts.meta.killZone, timeframes: Object.keys(ictFacts.timeframes) });

    const lines: string[] = [];
    lines.push('## CÁC MỨC ĐÃ TÍNH SẴN BẰNG CODE (tin tưởng tuyệt đối, KHÔNG tự tính lại):');
    lines.push('```json');
    lines.push(JSON.stringify(ictFacts, null, 2));
    lines.push('```');
    lines.push('');
    lines.push('## DATA OHLC THÔ (time = Unix timestamp giây, UTC):');

    for (const tf of allTf) {
      const candleSlice = slicedByTf[tf];
      if (!candleSlice) continue;

      logger.info(`[${tf}] Market Data`, { timeframe: tf, total: candlesByTimeframe[tf].length, used: candleSlice.length });

      const csvRows = candleSlice.map((c) =>
        `${toUnixTimestamp(c.time)},${c.open},${c.high},${c.low},${c.close}`,
      );

      lines.push(tf);
      lines.push('timestamp,open,high,low,close');
      lines.push(...csvRows);
      lines.push('');
    }

    return lines.join('\n');
  }

}

function toUnixTimestamp(time: string): number {
  return Math.floor(parseUtc(time).getTime() / 1000);
}

/**
 * Parse chuỗi thời gian thành Date. TwelveData trả "YYYY-MM-DD HH:mm:ss" theo UTC
 * nhưng KHÔNG có hậu tố Z → ép hiểu là UTC để tránh lệch theo giờ máy.
 */
function parseUtc(time: string): Date {
  if (/[zZ]|[+-]\d{2}:?\d{2}$/.test(time)) return new Date(time); // đã có timezone
  const iso = time.trim().replace(' ', 'T');
  return new Date(`${iso}Z`);
}

function extractPriceFromLine(text: string, keyword: string): number | null {
  const re   = new RegExp(`^[^\\n]*\\b${keyword}\\b[^\\n]*$`, 'im');
  const line = text.match(re)?.[0];
  if (!line) return null;
  const nums = line.match(/\b\d{3,}(?:[.,]\d+)?\b/g);
  if (!nums) return null;
  return parseFloat(nums[0].replace(',', ''));
}
