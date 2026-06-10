import Anthropic from '@anthropic-ai/sdk';
import { Agent } from 'undici';
import { Candle } from '../market/Candle';
import { AnalysisResult, ConditionalSetup } from './dto/AnalysisResult';
import { config } from '../../config/trading';
import { logger } from '../../logger';
import { preprocess } from './ict/IctPreprocessor';

export class ClaudeAnalystService {
  private readonly client: Anthropic;
  protected readonly tfOrder: string[] = ['H1', 'M15', 'M5'];

  constructor(private readonly model: string) {
    // Stream phân tích có thể chạy nhiều phút (adaptive thinking).
    // undici (engine của fetch) mặc định cắt kết nối nếu không nhận chunk nào
    // trong ~300s (bodyTimeout) hoặc chờ headers >300s (headersTimeout) →
    // ném "terminated". Đặt 0 = VÔ HẠN ở tầng undici để stream dài không bị
    // ngắt sớm; chặn an toàn bằng timeout của SDK bên dưới.
    const dispatcher = new Agent({
      headersTimeout: 0,   // 0 = không giới hạn (hợp lệ với undici)
      bodyTimeout:    0,
    });

    // ⚠️ SDK timeout KHÁC undici: 0 ở đây nghĩa là ~0ms (timeout tức thì), KHÔNG
    // phải vô hạn. Phải đặt số dương — đây là trần cứng tổng thể của request.
    const SDK_TIMEOUT = 10 * 60 * 1000; // 10 phút

    this.client = new Anthropic({
      apiKey:     config.claude.apiKey,
      maxRetries: 4,
      timeout:    SDK_TIMEOUT,
      fetchOptions: { dispatcher },
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

Tôi cung cấp dữ liệu nến OHLC thô của XAU/USD trên 3 khung: H1, M15, M5 (có timestamp).
Phân tích THUẦN TÚY từ price action. Bỏ qua mọi bình luận ngoài cấu trúc output bên dưới.

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

    const lines: string[] = [];

    for (const tf of allTf) {
      const candles = candlesByTimeframe[tf];
      if (!candles) continue;

      logger.info(`[${tf}] Market Data`, { timeframe: tf, total: candles.length });

      const limit = (config.candlesByTf as Record<string, number>)[tf] ?? config.candlesCount;
      const candleSlice = candles.slice(-limit);
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
  return Math.floor(parseMarketTime(time).getTime() / 1000);
}

/**
 * Parse chuỗi thời gian nến thành Date (instant chuẩn xác).
 * TwelveData được gọi với param `timezone=MARKET_HOURS_TIMEZONE` nên trả về
 * "YYYY-MM-DD HH:mm:ss" theo GIỜ ĐỊA PHƯƠNG của timezone đó, KHÔNG có hậu tố.
 * → cần gắn đúng offset của timezone cấu hình thay vì ép thành UTC (Z).
 */
function parseMarketTime(time: string): Date {
  if (/[zZ]|[+-]\d{2}:?\d{2}$/.test(time)) return new Date(time); // đã có timezone
  const iso = time.trim().replace(' ', 'T');
  const naiveUtc = new Date(`${iso}Z`);
  const offsetMin = tzOffsetMinutes(config.marketHours.timezone, naiveUtc);
  return new Date(naiveUtc.getTime() - offsetMin * 60_000);
}

/** Offset (phút) của một IANA timezone tại một thời điểm. VD Asia/Ho_Chi_Minh → 420. */
function tzOffsetMinutes(tz: string, at: Date): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(at);
  const m: Record<string, number> = {};
  for (const p of parts) if (p.type !== 'literal') m[p.type] = parseInt(p.value, 10);
  const asUtc = Date.UTC(m.year, m.month - 1, m.day, m.hour, m.minute, m.second);
  return (asUtc - at.getTime()) / 60_000;
}

function extractPriceFromLine(text: string, keyword: string): number | null {
  const re   = new RegExp(`^[^\\n]*\\b${keyword}\\b[^\\n]*$`, 'im');
  const line = text.match(re)?.[0];
  if (!line) return null;
  const nums = line.match(/\b\d{3,}(?:[.,]\d+)?\b/g);
  if (!nums) return null;
  return parseFloat(nums[0].replace(',', ''));
}
