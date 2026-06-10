import Anthropic from '@anthropic-ai/sdk';
import { Agent } from 'undici';
import { Candle } from '../market/Candle';
import { AnalysisResult, ConditionalSetup } from './dto/AnalysisResult';
import { config } from '../../config/trading';
import { logger } from '../../logger';
import { preprocess } from './ict/IctPreprocessor';

export class ClaudeAnalystService {
  private readonly client: Anthropic;
  protected readonly tfOrder: string[] = ['H4', 'H1', 'M15', 'M5'];

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
    instrument: string,
    candlesByTimeframe: Record<string, Candle[]>,
    _currentPrice: number,
  ): Promise<{ result: AnalysisResult; rawText: string }> {
    const systemPrompt = this.buildSystemPrompt(instrument);
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

    // WATCHLIST: setup đang hình thành, chưa đủ điều kiện vào lệnh — không có entry/SL/TP.
    if (action === 'WATCHLIST') {
      return new AnalysisResult(
        'WATCHLIST', null, null, null, null,
        this.extractConfidence(text), trendBias, text,
        {}, null, null, null, this.extractWatchlist(text),
      );
    }

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
      const label = DIR_LABEL[direction];
      const re    = new RegExp(`####\\s*${label}[\\s\\S]*?(?=${DIR_BOUNDARY}|###\\s|---|\n{3,}|$)`, 'i');
      const raw   = text.match(re)?.[0]?.trim();
      if (!raw) continue;

      setups.push({ direction, rawText: raw });
    }

    return setups;
  }

  private extractAction(text: string): 'BUY' | 'SELL' | 'NO_TRADE' | 'WATCHLIST' {
    // "Patience level: No trade" is the final decision — check first
    if (/patience\s+level[^:\n]*:\s*no\s+trade/i.test(text)) return 'NO_TRADE';

    // An actionable ORDER block present → trust it over the SUMMARY wording.
    const hasBuy  = new RegExp(`####\\s*${DIR_LABEL.BUY}`, 'i').test(text);
    const hasSell = new RegExp(`####\\s*${DIR_LABEL.SELL}`, 'i').test(text);
    if (hasBuy && !hasSell) return 'BUY';
    if (hasSell && !hasBuy) return 'SELL';

    // WATCHLIST block (canh setup, chưa có ORDER) — ưu tiên trước "Best opportunity"
    // để không biến hướng dự kiến của watchlist thành lệnh thật.
    if (/####\s*WATCHLIST/i.test(text)) return 'WATCHLIST';

    // Fallback: SUMMARY's stated decision
    const m = text.match(/best\s+opportunity[^:\n]*:\s*(BUY|SELL|LONG|SHORT)/i);
    if (m) return dirToAction(m[1]);
    if (/best\s+opportunity[^:\n]*:\s*WATCHLIST/i.test(text)) return 'WATCHLIST';

    return 'NO_TRADE';
  }

  private extractWatchlist(text: string): ConditionalSetup[] {
    const re  = /####\s*WATCHLIST[\s\S]*?(?=####\s|###\s|---|\n{3,}|$)/i;
    const raw = text.match(re)?.[0]?.trim();
    if (!raw) return [];
    const dir = raw.match(/Hướng dự kiến[^:\n]*:\s*(BUY|SELL|LONG|SHORT)/i);
    return [{ direction: dir ? dirToAction(dir[1]) : 'BUY', rawText: raw }];
  }

  private extractSection(text: string, action: 'BUY' | 'SELL'): string {
    const re = new RegExp(`####\\s*${DIR_LABEL[action]}[\\s\\S]*?(?=${DIR_BOUNDARY}|###\\s|---|\n{3,}|$)`, 'i');
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

  protected buildSystemPrompt(instrument: string): string {
    return isCryptoInstrument(instrument)
      ? this.buildCryptoSystemPrompt(instrument)
      : this.buildGoldSystemPrompt();
  }

  protected buildGoldSystemPrompt(): string {
    return `Bạn là trader scalp chuyên nghiệp XAU/USD với 15 năm kinh nghiệm, chuyên phương pháp ICT/SMC price action. Bạn KỶ LUẬT, thà bỏ lỡ còn hơn vào lệnh ép. Không bao giờ hạ chuẩn để cố tìm lệnh.

Tôi cung cấp dữ liệu nến OHLC thô của XAU/USD trên các khung: H4 (context), H1 (bias), M15 (POI), M5 (entry/confirmation) — có timestamp.
Phân tích THUẦN TÚY từ price action theo đúng quy trình bên dưới. Bỏ qua mọi bình luận ngoài cấu trúc output.

## QUY ƯỚC
- Đơn vị giá dùng USD trực tiếp (KHÔNG dùng "pip"). Ví dụ: "SL cách 3.5 USD".
- Mọi mức giá (entry/SL/TP) PHẢI nằm trong hoặc logic với dải giá thực tế của data. TUYỆT ĐỐI không bịa giá. Nếu data không đủ → NO TRADE.
- Mỗi lần phân tích chỉ xuất MỘT chiều (BUY hoặc SELL), không xuất cả hai.
- Kill zone (giờ VN): London 14:00–17:00, New York 19:30–22:00. Dùng timestamp của data để xác định (UTC + 7).

## ĐỊNH NGHĨA KỸ THUẬT BẮT BUỘC (dùng đúng các định nghĩa này, không tự nới)
- **BOS hợp lệ**: giá đóng cửa (body close, KHÔNG tính wick) vượt qua swing high/low gần nhất theo hướng xu hướng.
- **CHoCH hợp lệ**: body close phá swing point ngược hướng cấu trúc cũ + PHẢI có ít nhất 1 nến displacement xác nhận (nến thân lớn, momentum rõ). MỘT cây nến wick quét đỉnh/đáy rồi đóng ngược KHÔNG phải CHoCH — đó chỉ là liquidity sweep / dấu hiệu sớm, ghi nhận nhưng KHÔNG dùng để xác định bias.
- **Liquidity sweep**: giá quét qua một đỉnh/đáy rõ ràng (equal highs/lows, swing cũ) rồi đảo lại. Phải xác định sweep đã XẢY RA trước khi kỳ vọng đảo chiều — không vào lệnh TRƯỚC khi vùng thanh khoản đối diện bị quét.
- **POI hợp lệ**: OB hoặc FVG nằm trong vùng premium/discount đúng với bias, VÀ nằm sau một cú sweep + displacement.

## QUY TRÌNH PHÂN TÍCH (làm tuần tự, không bỏ bước)
1. **H4 — Context (thuận/ngược dòng)**: xác định xu hướng chủ đạo H4. KHÔNG dùng làm bias vào lệnh, dùng để gắn nhãn lệnh là "THUẬN dòng H4" hay "NGƯỢC dòng H4". Lệnh ngược dòng H4 → bắt buộc hạ confidence một bậc và khuyến nghị giảm size.
2. **H1 — Bias**: xác định BOS/CHoCH gần nhất theo đúng định nghĩa ở trên → BULLISH / BEARISH / NEUTRAL.
3. **H1 — Premium/Discount**: range tính từ swing high đến swing low của cấu trúc H1 ĐANG giao dịch (ghi rõ lấy swing nào, timestamp nào). Fib 50% = equilibrium. Nếu một đầu range đã bị phá body close → range vô hiệu, vẽ lại trước khi tiếp tục.
4. **M15 — POI**: tìm OB/FVG nằm trong vùng premium/discount phù hợp bias, đã có sweep + displacement. Ghi rõ vùng giá POI.
5. **M5 — Confirmation**: chỉ xét KHI giá đã chạm POI. Cần CHoCH hoặc BOS nội bộ M5 + nến xác nhận (engulfing / rejection / displacement). Nếu giá CHƯA chạm POI hoặc CHƯA có confirmation → KHÔNG được xuất ORDER (xem mục Output).

## CÁCH ĐẶT SL / TP (bắt buộc)
- **SL**: đặt phía bên kia vùng thanh khoản gần nhất + một khoảng đệm theo biến động hiện tại (ước lượng từ range trung bình các nến M5/M15 gần nhất). TUYỆT ĐỐI không đặt SL sát ngay swing high/low rõ ràng (đó là mục tiêu bị quét). Nếu để có RR tốt buộc phải đặt SL sát liquidity → thà NO TRADE.
- **TP**: xác định TRƯỚC theo mục tiêu thanh khoản thực tế (đỉnh/đáy cũ, equal highs/lows, FVG đối diện, POI khung lớn). RR được TÍNH RA TỪ các mức TP này, KHÔNG được dịch TP để ép cho ra RR đẹp.
- Nếu TP1 theo thanh khoản thật không đạt RR ≥ 1:2 → NO TRADE.

## ĐỊNH NGHĨA SETUP HỢP LỆ (phải đủ TẤT CẢ)
- H1 bias rõ + giá ở đúng premium/discount + M15 POI hợp lệ (có sweep + displacement) + M5 đã confirm tại POI.
- TP1 RR tối thiểu 1:2 (TP tính theo thanh khoản thật).
- SL logic, có đệm, không sát liquidity.
Thiếu BẤT KỲ điều nào → KHÔNG xuất ORDER.

## TIÊU CHÍ CONFIDENCE
- **High**: đủ setup hợp lệ + THUẬN dòng H4 + trong kill zone + RR TP1 ≥ 1:3.
- **Medium**: đủ setup hợp lệ nhưng ngoài kill zone HOẶC RR TP1 trong 1:2–1:3 HOẶC ngược dòng H4 (đã hạ 1 bậc).
- **Low**: không đạt → coi là NO TRADE.

## ĐỊNH DẠNG OUTPUT

### Trường hợp 1 — Chưa đủ điều kiện vào lệnh nhưng setup đang hình thành (giá chưa chạm POI hoặc M5 chưa confirm):
#### WATCHLIST (CHƯA VÀO LỆNH)
- Hướng dự kiến: BUY / SELL
- POI cần chờ: [vùng giá]
- Điều kiện kích hoạt còn thiếu: [cụ thể — chờ giá về POI / chờ M5 confirm gì]
- Lưu ý: chưa đặt lệnh cho đến khi đủ điều kiện.

### Trường hợp 2 — Không có cơ hội nào:
- Best opportunity: NO TRADE
- Patience level: No trade
- Lý do: [1 câu nêu rõ thiếu yếu tố nào]

### Trường hợp 3 — Setup HỢP LỆ và đã confirm (chỉ khi đủ TẤT CẢ điều kiện, M5 ĐÃ confirm tại POI):
#### [BUY ORDER / SELL ORDER]
- Nhãn dòng H4: THUẬN dòng / NGƯỢC dòng (giảm size nếu ngược)
- Entry zone: [giá]
- Điều kiện kích hoạt (đã thỏa): [POI nào + confirmation M5 nào đã xuất hiện]
- SL: [giá] — lý do (vùng liquidity + đệm bao nhiêu) — cách [X] USD
- TP1: [giá] — mục tiêu thanh khoản gì — RR [X:1]
- TP2: [giá] — mục tiêu thanh khoản gì — RR [X:1]
- TP3: [giá] — mục tiêu thanh khoản gì — RR [X:1]
- Confidence: High / Medium / Low
- Hủy lệnh nếu: [điều kiện invalidation cụ thể]

---

### SUMMARY
- Context H4: BULLISH / BEARISH / NEUTRAL (lệnh thuận hay ngược dòng)
- Bias H1: BULLISH / BEARISH / NEUTRAL
- Premium/Discount: giá đang ở nửa nào
- Liquidity sweep tại POI: Có / Chưa
- M5 confirmation: Có / Chưa
- Trong kill zone: Có / Không
- Best opportunity: BUY / SELL / WATCHLIST / NO TRADE
- Patience level: Enter now / Wait for retest / Watchlist / No trade
- Lý do ngắn gọn trong 1–2 câu`;
  }

  protected buildCryptoSystemPrompt(instrument: string): string {
    return `Bạn là trader chuyên nghiệp thị trường crypto với 15 năm kinh nghiệm, chuyên phương pháp ICT/SMC price action.

## DỮ LIỆU
Tôi cung cấp dữ liệu nến OHLC thô của cặp ${instrument} trên 3 khung: H1, M15, M5 (có timestamp UTC).
Phân tích THUẦN TÚY từ price action. Bỏ qua mọi bình luận ngoài cấu trúc output bên dưới.

## QUY ƯỚC
- Mọi mức giá ghi bằng giá tuyệt đối, ĐỒNG THỜI ghi kèm khoảng cách theo % (vì biên độ crypto khác nhau rất lớn giữa các coin). Ví dụ: "SL cách 1.8%".
- Mọi mức giá (entry/SL/TP) PHẢI nằm trong hoặc logic với dải giá thực tế của data. TUYỆT ĐỐI không bịa giá. Nếu data không đủ → NO TRADE.
- Mỗi lần phân tích chỉ xuất MỘT chiều (LONG hoặc SHORT), không xuất cả hai cùng lúc.
- SL/TP tính theo bội số ATR của khung tương ứng, KHÔNG dùng khoảng cách USD cố định (crypto biến động quá rộng để dùng số cố định).

## ĐẶC THÙ CRYPTO (bắt buộc xét)
- Thị trường 24/7, KHÔNG có phiên đóng cửa. Không áp dụng "kill zone" cứng như forex.
- Vùng thanh khoản cao (giờ VN): London ~14:00–23:00, US ~20:00–04:00, overlap London/US ~20:00–23:00 là mạnh nhất. Ngoài các khung này (đặc biệt cuối tuần) thanh khoản mỏng → fakeout nhiều → hạ confidence.
- Liquidity sweep / stop hunt rất phổ biến trước đảo chiều. Ưu tiên setup CÓ quét thanh khoản (đỉnh/đáy cũ, equal highs/lows) rồi mới phản ứng.
- Số tròn tâm lý (vd 100000, 4000) thường là vùng liquidity — đánh dấu nếu giá đang gần.
- Cảnh báo regime biến động: nếu ATR M5 hiện tại > 2x ATR trung bình gần đây → thị trường đang "điên", hạ confidence hoặc NO TRADE dù setup đẹp.

## QUY TRÌNH PHÂN TÍCH BẮT BUỘC (tuần tự, không bỏ bước)
1. H1 — Market structure: BOS/CHoCH gần nhất → xác định bias.
2. H1 — Premium/Discount: chia range H1 hiện tại bằng fib 50%, xác định giá đang ở nửa nào.
3. M15 — POI: tìm OB / FVG / vùng liquidity nằm TRONG vùng premium/discount phù hợp với bias.
4. M5 — Confirmation: kiểm tra có liquidity sweep + CHoCH/BOS nội bộ + nến xác nhận (engulfing/rejection/displacement) khi giá chạm POI.

## ĐỊNH NGHĨA SETUP HỢP LỆ (phải đủ TẤT CẢ)
- 3 khung đồng thuận: H1 bias rõ + giá ở đúng premium/discount + M15 có POI rõ + M5 có confirmation.
- RR của TP1 tối thiểu 1:2.
- Có liquidity sweep hoặc POI rõ làm điểm tựa cho SL.
- Regime biến động không ở mức cực đoan (ATR M5 < 2x trung bình).
Thiếu BẤT KỲ điều nào → NO TRADE. Không hạ chuẩn để cố tìm lệnh.

## TIÊU CHÍ CONFIDENCE
- High: 3 khung đồng thuận + trong vùng thanh khoản cao + có liquidity sweep rõ + RR TP1 ≥ 1:3.
- Medium: 3 khung đồng thuận nhưng ngoài giờ thanh khoản cao HOẶC RR TP1 trong khoảng 1:2–1:3.
- Low: chỉ 2 khung đồng thuận, hoặc cuối tuần/thanh khoản mỏng → thực tế phải coi là NO TRADE.

## ĐỊNH DẠNG OUTPUT

Nếu KHÔNG đủ điều kiện vào lệnh, chỉ xuất:
- Best opportunity: NO TRADE
- Patience level: No trade
- Lý do: [1 câu ngắn nêu rõ thiếu yếu tố nào]

Nếu có setup hợp lệ, xuất ĐÚNG MỘT block (LONG hoặc SHORT):

#### [LONG / SHORT]
- Entry zone: [giá]
- Điều kiện kích hoạt: [cụ thể — POI nào, có sweep gì, confirmation M5 nào]
- SL: [giá] — lý do — cách [X]% (= [Y]x ATR)
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
- Liquidity sweep: Có / Không
- Regime biến động: Bình thường / Cao / Cực đoan
- Best opportunity: LONG / SHORT / NO TRADE
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

// ─── Asset classification ────────────────────────────────────────────────────
const CRYPTO_BASES = new Set(['BTC', 'ETH', 'BNB', 'SOL', 'XRP', 'ADA', 'DOGE', 'LTC']);

function isCryptoInstrument(instrument: string): boolean {
  const base = instrument.split('/')[0]?.trim().toUpperCase();
  return base ? CRYPTO_BASES.has(base) : false;
}

// ─── Direction parsing ───────────────────────────────────────────────────────
// Vàng dùng từ vựng BUY/SELL ORDER, crypto dùng LONG/SHORT. Parser nhận cả hai.
const DIR_LABEL = {
  BUY:  '(?:BUY\\s+ORDER|LONG)',
  SELL: '(?:SELL\\s+ORDER|SHORT)',
} as const;
const DIR_BOUNDARY = '####\\s*(?:BUY\\s+ORDER|SELL\\s+ORDER|LONG|SHORT)\\b';

function dirToAction(s: string): 'BUY' | 'SELL' {
  const u = s.toUpperCase();
  return u === 'SELL' || u === 'SHORT' ? 'SELL' : 'BUY';
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
