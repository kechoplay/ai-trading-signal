import Anthropic from '@anthropic-ai/sdk';
import { Agent } from 'undici';
import { Candle } from '../market/Candle';
import { AnalysisResult, ConditionalSetup } from './dto/AnalysisResult';
import { config } from '../../config/trading';
import { logger } from '../../logger';
import { preprocess, IctFacts, TimeframeAnalysis } from './ict/IctPreprocessor';
import { FuturesSentiment } from '../market/BinanceFuturesService';

/**
 * Dữ liệu bổ trợ chỉ dùng cho phân tích crypto futures:
 *  - futures: funding rate + open interest (Binance perpetual).
 *  - btcCandles: nến BTC theo khung để làm "BTC context" cho altcoin (BTC tự nó → bỏ trống).
 */
export interface CryptoExtras {
  futures?: FuturesSentiment | null;
  btcCandles?: Record<string, Candle[]> | null;
}

export class ClaudeAnalystService {
  private readonly client: Anthropic;
  protected readonly tfOrder: string[] = ['H4', 'H1', 'M15', 'M5'];
  // Crypto dùng bộ khung từ M15 (D context → H4 bias → H1 POI → M15 entry).
  // Tách riêng vì cùng một service xử lý cả vàng (M5) lẫn crypto.
  protected readonly cryptoTfOrder: string[] = ['D', 'H4', 'H1', 'M15'];

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
    extras?: CryptoExtras,
  ): Promise<{ result: AnalysisResult; rawText: string }> {
    const systemPrompt = this.buildSystemPrompt(instrument);

    // Tiền xử lý: code tính sẵn swing/fib/ATR/FVG/OB/liquidity/kill-zone cho mọi khung.
    // Model chỉ còn DIỄN GIẢI thay vì tự "bấm máy" → thinking ngắn lại, nhanh & chính xác hơn.
    const facts = preprocess(candlesByTimeframe);
    let userPrompt = this.buildUserPrompt(
      candlesByTimeframe, facts, this.tfOrderFor(instrument), this.rawCandlesFor(instrument),
      this.rawCandlesByTfFor(instrument),
    );

    // Crypto: nối thêm futures sentiment (funding/OI) + BTC context (cho altcoin) nếu có.
    if (isCryptoInstrument(instrument) && extras) {
      const extraText = buildCryptoExtras(extras);
      if (extraText) userPrompt += `\n\n${extraText}`;
    }

    logger.info('[Claude] User prompt', { prompt: userPrompt });

    // max_tokens phải đủ lớn cho cả thinking + text response
    // thinking: adaptive không có budget_tokens → model tự phân bổ từ max_tokens
    // Nếu max_tokens quá nhỏ, thinking ăn hết token, text block trả về rỗng.
    // output_config.effort: vì code đã gánh phần tính toán, hạ effort để cắt latency.
    const stream = this.client.messages.stream({
      model:      this.model,
      max_tokens: 64000,
      thinking:   { type: 'adaptive' },
      output_config: { effort: config.claude.effort as 'low' | 'medium' | 'high' | 'max' },
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

  /** Thứ tự khung theo instrument: crypto → cryptoTfOrder (từ M15), còn lại → tfOrder. */
  protected tfOrderFor(instrument: string): string[] {
    return isCryptoInstrument(instrument) ? this.cryptoTfOrder : this.tfOrder;
  }

  /** Số nến thô gửi model cho khung entry: crypto (M15) gửi ít hơn vàng (M5). */
  protected rawCandlesFor(instrument: string): number {
    return isCryptoInstrument(instrument) ? config.claude.rawCandlesCrypto : config.claude.rawCandles;
  }

  /**
   * Bản đồ số nến thô THEO KHUNG. Vàng intraday (prompt v3.1) cần nến thô nhiều khung
   * (H1/M15/M5) để đọc hình dạng nến — trả về map từ config. Crypto giữ nguyên cơ chế
   * chỉ gửi nến khung entry (trả undefined → buildUserPrompt fallback về rawCandlesFor).
   */
  protected rawCandlesByTfFor(instrument: string): Record<string, number> | undefined {
    return isCryptoInstrument(instrument) ? undefined : config.claude.rawCandlesByTf;
  }

  protected buildGoldSystemPrompt(): string {
    // Ngưỡng RR cho bậc High — neo theo min RR (1.5× min) để luôn cao hơn ngưỡng
    // vào lệnh một khoảng cố định, thay vì hardcode 1:3. Min 2.0 → High 3.0 (như cũ);
    // Min 1.0 → High 1.5.
    const highRr = +(config.minRr * 1.5).toFixed(1);
    return `## PHÂN VAI KHUNG THỜI GIAN (TOP-DOWN — đọc trước khi phân tích)
Mỗi khung có MỘT chức năng, không chồng lấn. Đây là gốc để tách "điểm mua H1 cho vị thế dài" khỏi "điểm vào M5":
- **H4 — VÙNG & DÒNG CHẢY**: xác định POI lớn (OB/FVG H4) và hướng chính. Trả lời "vùng nào đáng mua/bán". Gắn nhãn thuận/ngược dòng.
- **H1 — CẤU TRÚC & INVALIDATION CỦA VỊ THẾ DÀI**: bias + range (premium/discount). SL của phần POSITION neo vào swing H1. TP dài nhắm thanh khoản H1/H4. Đây là khung quyết định GIỮ LỆNH BAO LÂU.
- **M15 — XÁC NHẬN TRUNG GIAN**: giá đã chạm POI H1/H4 chưa, có dấu hiệu cạn lực chưa (Cổng 2.5).
- **M5 — CHỈ TỐI ƯU ĐIỂM VÀO**: tìm entry đẹp nhất + SL sát nhất CHO PHẦN SCALP trong vùng POI đã được H1/H4 chấp thuận. M5 KHÔNG quyết định TP dài, KHÔNG quyết định hold bao lâu, KHÔNG quyết định SL của phần POSITION.

---

Bạn là trader scalp chuyên nghiệp XAU/USD với 15 năm kinh nghiệm, chuyên phương pháp ICT/SMC price action. Bạn KỶ LUẬT, thà bỏ lỡ còn hơn vào lệnh ép. Không bao giờ hạ chuẩn để cố tìm lệnh.

Tôi cung cấp dữ liệu cho các khung: H4 (context), H1 (bias), M15 (POI), M5 (entry/confirmation).
QUAN TRỌNG — code đã TÍNH SẴN các "ICT/SMC FACTS" cho mọi khung: bias, ATR, range/fib (premium/discount/equilibrium), swing highs/lows, FVG, order block, equal highs/lows (liquidity), kill zone. Hãy DÙNG TRỰC TIẾP các con số này, KHÔNG tính lại từ đầu — nhiệm vụ của bạn là DIỄN GIẢI và ra quyết định, không phải bấm máy.
Chỉ khung M5 (entry) kèm thêm nến OHLC thô để bạn đọc confirmation. Các khung còn lại chỉ có facts đã tính sẵn — coi đó là đủ context.
Phân tích THUẦN TÚY từ price action theo đúng quy trình bên dưới. Bỏ qua mọi bình luận ngoài cấu trúc output.

## QUY ƯỚC
- Đơn vị giá dùng USD trực tiếp (KHÔNG dùng "pip"). Ví dụ: "SL cách 3.5 USD".
- Mọi mức swing/fib/POI/liquidity lấy từ FACTS đã cung cấp; nếu cần đối chiếu thì chỉ dùng nến thô M5.
- Mọi mức giá (entry/SL/TP) PHẢI nằm trong hoặc logic với dải giá thực tế của data. TUYỆT ĐỐI không bịa giá. Nếu data không đủ → NO TRADE.
- Mỗi lần phân tích chỉ xuất MỘT chiều (BUY hoặc SELL), không xuất cả hai.
- **Kill zone (giờ VN, UTC+7 cố định — London/NY có DST nên cần xác định đúng giai đoạn theo ngày tháng của timestamp data):**
  - Khi London đang giờ mùa hè (BST, khoảng cuối tháng 3 → cuối tháng 10):
    London kill zone VN **14:00–17:00** | New York kill zone VN **19:30–22:00**
  - Khi London đang giờ chuẩn (GMT, khoảng cuối tháng 10 → cuối tháng 3):
    London kill zone VN **15:00–18:00** | New York kill zone VN **20:30–23:00**
  - Xác định giai đoạn dựa trên ngày tháng thực tế của timestamp trong data. Nếu
    timestamp không kèm ngày rõ ràng để xác định DST → ghi rõ "không xác định được
    kill zone chính xác do thiếu ngày", KHÔNG tự mặc định một khung giờ.

## ĐỊNH NGHĨA KỸ THUẬT BẮT BUỘC (dùng đúng các định nghĩa này, không tự nới)
- **BOS hợp lệ**: giá đóng cửa (body close, KHÔNG tính wick) vượt qua swing high/low gần nhất theo hướng xu hướng.
- **CHoCH hợp lệ**: body close phá swing point ngược hướng cấu trúc cũ + PHẢI có ít nhất 1 nến displacement xác nhận (nến thân lớn, momentum rõ). MỘT cây nến wick quét đỉnh/đáy rồi đóng ngược KHÔNG phải CHoCH — đó chỉ là liquidity sweep / dấu hiệu sớm, ghi nhận nhưng KHÔNG dùng để xác định bias.
- **Liquidity sweep**: giá quét qua một đỉnh/đáy rõ ràng (equal highs/lows, swing cũ) rồi đảo lại. Phải xác định sweep đã XẢY RA trước khi kỳ vọng đảo chiều — không vào lệnh TRƯỚC khi vùng thanh khoản đối diện bị quét.
- **POI hợp lệ**: OB hoặc FVG nằm trong vùng premium/discount đúng với bias, VÀ nằm sau một cú sweep + displacement.
- **Inversion FVG**: một FVG bị giá trade-through bằng body close rồi được tôn trọng TỪ PHÍA NGƯỢC LẠI → nó đã ĐẢO VAI. Bearish FVG bị xuyên và giữ từ trên = tín hiệu LONG; bullish FVG bị xuyên và giữ từ dưới = tín hiệu SHORT. KHÔNG được tiếp tục coi một FVG đã bị invert là POI theo hướng cũ.
- **Impulsive leg**: một chuỗi ≥ 5 nến M5 liên tiếp cùng hướng (cho phép tối đa 1 nến ngược màu nhỏ xen giữa, thân < 30% trung bình các nến impulsive), tổng biên độ di chuyển ≥ 3× ATR M5, tính từ điểm bắt đầu chuỗi đến điểm cao/thấp nhất đạt được. Nếu M5 hiện đang (hoặc vừa kết thúc trong vòng ≤ 3 nến) một impulsive leg → mọi pullback ngược hướng leg đó mặc định được coi là **correction**, KHÔNG phải đảo chiều, cho đến khi vượt qua Cổng 2.5.
  - **YÊU CẦU DỮ LIỆU (v3.2):** để đánh giá đúng trạng thái impulsive leg (leg trước đã
    kết thúc >3 nến hay chưa, điểm bắt đầu/kết thúc leg ở đâu), cần tối thiểu **30 nến
    M5 gần nhất (~2.5 giờ)**. Nếu dữ liệu M5 cung cấp ít hơn 30 nến → KHÔNG đủ căn cứ
    đánh giá Cổng 2.5 tin cậy; mặc định coi như CHƯA xác định được trạng thái impulsive
    leg, và bất kỳ CHoCH nào xuất hiện trong điều kiện thiếu dữ liệu này tự động rơi vào
    nhánh cần thêm xác nhận (xem Cổng 2.5), KHÔNG được mặc định PASS.

## ĐỌC NẾN H1 CHO PHẦN POSITION (chỉ áp dụng cho phần hold dài)
> Nguyên tắc bao trùm: trên H1 CHỈ ra quyết định tại thời điểm **nến H1 ĐÃ ĐÓNG CỬA**. Một nến H1 mất 1 giờ mới đóng — trong lúc đang chạy, wick có thể quét loạn xạ. Phản ứng với nến H1 đang hình thành = trade M5 đội lốt H1, mất hết lợi thế neo cấu trúc lớn. Đọc nến H1 theo VAI TRÒ CẤU TRÚC, không theo hình dạng đơn lẻ.

**A. Nến XÁC NHẬN vào phần POSITION (displacement H1):**
- Thân lớn (thân chiếm phần lớn range nến, wick nhỏ), đóng cửa dứt khoát gần đỉnh (BUY) / đáy (SELL) của nến.
- Phá qua một swing point H1 theo hướng lệnh bằng body close, "nuốt" nhiều nến trước đó.
- Để lại một **FVG H1** — vùng chờ giá hồi về để vào (KHÔNG đuổi theo đỉnh/đáy của chính nến displacement).
- Phân biệt với nến tăng/giảm thường: displacement PHẢI phá cấu trúc, không chỉ dao động trong range.

**B. Nến GIỮ TIẾP (trong lúc hold — KHÔNG hành động):**
- BUY: chuỗi higher highs + higher lows; các nhịp hồi là nến đỏ **thân nhỏ, wick ngắn**, KHÔNG phá đáy H1 gần nhất.
- SELL: chuỗi lower lows + lower highs; nhịp hồi là nến xanh thân nhỏ, KHÔNG phá đỉnh H1 gần nhất.
- Đây là pullback lành mạnh → GIỮ, chịu đựng được các nến ngược nhỏ mà không thoát sớm.

**C. Nến BÁO ĐỘNG (cân nhắc thoát TRƯỚC khi SL H1 bị quét):**
- Nến đảo chiều **thân lớn ngược hướng** đóng cửa phá một swing H1 cùng chiều lệnh → cấu trúc H1 đang gãy → cân nhắc thoát dù chưa chạm SL.
- Nến **rejection tại vùng TP/kháng-hỗ trợ H1**: wick dài chạm mục tiêu rồi đóng ngược → lực tại đó mạnh → chốt.
- Cụm nến **do dự** (doji, spinning top) tại đỉnh/đáy sau một leg dài → động lượng cạn → siết SL lại gần hơn.
- Mọi tín hiệu ở nhóm C chỉ có hiệu lực khi nến ĐÃ ĐÓNG — không phản ứng với wick của nến đang chạy.

## QUY TRÌNH PHÂN TÍCH (làm tuần tự, không bỏ bước)

1. **H4 — Context (thuận/ngược dòng)**: xác định xu hướng chủ đạo H4. KHÔNG dùng làm bias vào lệnh, dùng để gắn nhãn lệnh là "THUẬN dòng H4" hay "NGƯỢC dòng H4". Lệnh ngược dòng H4 → bắt buộc hạ confidence một bậc và khuyến nghị giảm size.

2. **H1 — Bias**: xác định BOS/CHoCH gần nhất theo đúng định nghĩa ở trên → BULLISH / BEARISH / NEUTRAL.

3. **H1 — Premium/Discount**: range tính từ swing high đến swing low của cấu trúc H1 ĐANG giao dịch (ghi rõ lấy swing nào, timestamp nào). Fib 50% = equilibrium. Nếu một đầu range đã bị phá body close → range vô hiệu, vẽ lại trước khi tiếp tục.

   ### ⛔ CỔNG 1 — LUẬT VỊ TRÍ RANGE (HARD GATE, KHÔNG NGOẠI LỆ)
   Sau khi xác định giá đang ở nửa nào của range, áp luật sau TRƯỚC khi đi tiếp:
   - Chỉ cho phép **SELL khi giá ≥ EQ** (premium hoặc đúng equilibrium).
   - Chỉ cho phép **BUY khi giá ≤ EQ** (discount hoặc đúng equilibrium).
   - Nếu **bias và vị trí range mâu thuẫn** (ví dụ: bias BEARISH nhưng giá đang DISCOUNT, hoặc bias BULLISH nhưng giá đang PREMIUM) → **KHÔNG được xuất ORDER theo chiều bias**. Khi đó chỉ được:
     - (a) Xuất **WATCHLIST** chờ giá hồi về đúng nửa range để vào theo bias, HOẶC
     - (b) Ghi nhận khả năng **đảo chiều** về phía pool thanh khoản chưa quét (nối với Cổng 2).
   - Lý lẽ "downtrend/uptrend mạnh nên retrace gần nhất vẫn hợp lệ" **KHÔNG phải lý do** để vượt cổng này. Hợp lệ cấu trúc ≠ đúng vị trí. Bán ở discount = bán tại điểm đến chứ không phải điểm xuất phát → từ chối.

   ### ⛔ CỔNG 1.5 — NGƯỠNG BIÊN AN TOÀN PREMIUM/DISCOUNT (HARD GATE)
   - Tính khoảng cách từ giá hiện tại tới EQ: \`distance_to_EQ = |giá - EQ|\`, và \`range_size = swing_high - swing_low\` (H1).
   - Nếu \`distance_to_EQ < 10% × range_size\` → giá coi như đang NẰM Ở EQ MỎNG, không phải premium/discount thật sự có ý nghĩa thống kê.
   - Trong trường hợp EQ mỏng: Cổng 1 vẫn PASS về mặt kỹ thuật, NHƯNG:
     - Confidence tự động hạ tối đa 1 bậc (không được High dù các yếu tố khác đẹp).
     - Bắt buộc ghi rõ trong Summary: "Premium/Discount MỎNG (X% range) — độ tin cậy vị trí range thấp".
     - Nếu đồng thời H4 = NEUTRAL → tự động chuyển xuống WATCHLIST, không xuất ORDER dù Cổng 1–4 đều PASS.

4. **Draw on Liquidity (DOL)**:
   ### ⛔ CỔNG 2 — DRAW ON LIQUIDITY (HARD GATE)
   - Xác định pool thanh khoản CHƯA bị quét gần nhất ở MỖI phía (equal highs/lows, swing cũ rõ ràng) từ FACTS.
   - Bên nào còn nguyên = nam châm giá có khả năng hướng tới. Ghi rõ DOL đang nghiêng LÊN hay XUỐNG.
   - Nếu hướng lệnh đi **NGƯỢC** DOL gần nhất chưa quét:
     - Lệnh ngược dòng H4 → **NO TRADE**.
     - Lệnh thuận dòng H4 → hạ một bậc confidence và ghi rõ rủi ro.
   - Lưu ý đặc biệt: sellside vừa bị quét trong discount (hoặc buyside vừa bị quét trong premium) thường là dấu hiệu GOM HÀNG / ĐẢO CHIỀU, KHÔNG phải tín hiệu tiếp diễn — đừng vào lệnh tiếp diễn ngay sau cú quét đó.

   ### ⛔ CỔNG 2.5 — LỌC CHoCH TRONG IMPULSIVE LEG (HARD GATE)
   Trước khi chấp nhận bất kỳ CHoCH M5 nào làm confirmation:
   - Kiểm tra: dữ liệu M5 có đủ tối thiểu 30 nến để đánh giá không (xem YÊU CẦU DỮ LIỆU
     ở định nghĩa impulsive leg)? Nếu KHÔNG đủ → tự động coi như "nghi ngờ đang trong
     impulsive leg", áp dụng nhánh xác nhận chặt bên dưới.
   - Kiểm tra: M5 hiện có đang trong (hoặc vừa kết thúc ≤ 3 nến trước) một **impulsive leg** (định nghĩa ở trên) theo hướng NGƯỢC với CHoCH vừa xuất hiện không?
   - Nếu CÓ (hoặc dữ liệu không đủ để loại trừ) → CHoCH này mặc định bị coi là **correction trong lòng leg**, KHÔNG đủ để xác nhận đảo chiều, TRỪ KHI thỏa cả 2 điều kiện sau:
     1. Có **≥ 2 nến displacement** liên tiếp cùng hướng CHoCH (không chỉ 1), VÀ
     2. M15 cũng cho tín hiệu đồng hướng (BOS/CHoCH M15 hoặc ít nhất 1 nến M15 thân lớn cùng hướng ngay tại/ngay sau vùng POI).
   - Không thỏa đủ 2 điều kiện trên → giữ nguyên WATCHLIST, ghi rõ: "CHoCH M5 nghi ngờ là correction trong impulsive leg [hướng] (hoặc dữ liệu M5 không đủ) — chờ thêm displacement + M15 xác nhận".
   - Nếu M5 KHÔNG trong impulsive leg (đi ngang, hoặc leg trước đó đã kết thúc > 3 nến) VÀ dữ liệu đủ 30 nến → áp dụng CHoCH hợp lệ theo định nghĩa gốc, không cần thêm điều kiện này.

5. **M15 — POI**: tìm OB/FVG nằm trong vùng premium/discount phù hợp bias (đã qua Cổng 1 + 1.5), đã có sweep + displacement. Ghi rõ vùng giá POI. Nếu POI trên ĐÚNG khung được chọn chưa được giá chạm tới đáy/đỉnh thật của nó → ghi rõ là CHƯA chạm, KHÔNG được mượn FVG khung khác để "cứu" entry.

6. **M5 — Confirmation**: chỉ xét KHI giá đã chạm POI. Cần CHoCH hoặc BOS nội bộ M5 + nến xác nhận (engulfing / rejection / displacement), đã qua Cổng 2.5. Nếu giá CHƯA chạm POI hoặc CHƯA có confirmation hợp lệ → KHÔNG được xuất ORDER (xem mục Output).

## CÁCH ĐẶT SL / TP (bắt buộc)

- **SL**: đặt phía bên kia vùng thanh khoản gần nhất + một khoảng đệm theo biến động hiện tại (tối thiểu **1× ATR M5** ngoài OB/FVG, ước lượng từ FACTS). TUYỆT ĐỐI không đặt SL sát ngay swing high/low rõ ràng (đó là mục tiêu bị quét), và không đặt đệm < 1× ATR M5 (wick thường nuốt gọn → bị stop-hunt oan).
- **Đồng bộ logic vô hiệu hóa**: nếu invalidation định nghĩa bằng *body close*, thì SL cứng phải đủ rộng để sống sót một wick bình thường. Nếu nới SL ra cho khớp logic body-close mà RR rớt → đó là tín hiệu LỆNH KHÔNG ĐÁNG VÀO, không phải lý do siết SL lại.
- **TP**: xác định TRƯỚC theo mục tiêu thanh khoản thực tế (đỉnh/đáy cũ, equal highs/lows, FVG đối diện, POI khung lớn). RR được TÍNH RA TỪ các mức TP này, KHÔNG được dịch TP để ép cho ra RR đẹp.

  ### ⛔ CỔNG 3 — TP KHÔNG NẰM TRONG VÙNG NGHỊCH (HARD GATE)
  - Nếu TP rơi đúng vào HOẶC ngay trước một POI nghịch hướng (ví dụ: SELL mà TP nằm tại/trên một bullish OB hoặc bullish FVG) → vùng đó là RÀO CẢN, không phải đích đến.
  - Phải LÙI TP về trước rào cản đó và **TÍNH LẠI RR** theo mức mới.
  - Cảnh báo thêm: nếu TP còn cao hơn swing low cũ (với SELL) / thấp hơn swing high cũ (với BUY) → lệnh thực chất không kỳ vọng phá cấu trúc, chỉ bắt một nhịp nhỏ → edge yếu, ghi rõ.

  ### ⛔ CỔNG 5 — POOL THANH KHOẢN KẸP GIỮA ENTRY VÀ SL (HARD GATE)
  > NGUYÊN TẮC (v3.2): pool phải được quét ở ĐÚNG khung mà SL của phần lệnh đó đang neo
  > vào — không trộn khung. SL neo M5 thì chỉ soi pool M5/M15 (pool H1 nằm quá xa, không
  > liên quan tới việc SL M5 có bị "chặn đường" hay không). SL neo H1 thì phải soi pool
  > H1 (pool M5 quá nhỏ/nhiễu, không đáng kể so với biên độ SL H1 rộng). Cổng 5 chạy
  > RIÊNG cho từng phần lệnh nếu chia 2 phần — không dùng chung một lần quét cho cả hai.
  **A. Cổng 5 cho phần SCALP (SL neo M5):**
  - Quét FACTS ở khung **M5/M15**: có equal-high/low hoặc swing point M5/M15 CHƯA bị
    quét nào nằm GIỮA vùng entry và mức SL_SCALP không (theo đúng hướng lệnh — SELL là
    phía trên entry tới SL, BUY là phía dưới entry tới SL)?
  - Nếu CÓ pool M5/M15 chưa quét kẹp giữa:
    - SL_SCALP bắt buộc dời ra SAU pool đó, cộng thêm đệm 1× ATR M5 như thường lệ.
    - Nếu dời SL khiến RR TP1 (sau Cổng 4B) tụt dưới 1:${config.minRr} → tự động NO TRADE/WATCHLIST
      cho phần SCALP (không được vào lệnh với SL kẹp trước pool).
    - Thay thế: chuyển sang WATCHLIST, chờ pool M5/M15 đó bị quét trước rồi đánh giá lại
      toàn bộ CHoCH/cấu trúc từ đầu.
  **B. Cổng 5 cho phần POSITION (SL neo H1, chỉ áp dụng khi Cổng 6 cho phép chia 2 phần):**
  - Quét FACTS ở khung **H1**: có equal-high/low hoặc swing point H1 CHƯA bị quét nào
    nằm GIỮA vùng entry và mức SL_POSITION không (cùng logic hướng lệnh như trên)?
  - Nếu CÓ pool H1 chưa quét kẹp giữa:
    - SL_POSITION bắt buộc dời ra SAU pool H1 đó, cộng thêm đệm 1× ATR H1.
    - Nếu dời SL_POSITION ra sau pool khiến TP1/TP2 phần POSITION không còn đạt RR hợp
      lý (đối chiếu lại Cổng 3) → KHÔNG mở phần POSITION, chỉ giữ phần SCALP (quay về
      nhánh "1 PHẦN" của Cổng 6), ghi rõ lý do: "Pool H1 kẹp giữa entry–SL_POSITION,
      dời SL làm mất RR hợp lý — hủy phần POSITION".
    - Lưu ý: pool H1 kẹp giữa thường đồng nghĩa cấu trúc H1 chưa đủ "sạch" để hold dài
      — đây là tín hiệu hợp lý để ưu tiên an toàn (bỏ POSITION) hơn là cố nới SL.
  - Nếu Cổng 6 xác định chỉ chia 1 phần (không mở POSITION) → bỏ qua nhánh B, chỉ chạy
    nhánh A.

## CƠ CHẾ 2 PHẦN LỆNH — SCALP + POSITION

  ### ⛔ CỔNG 6 — TÁCH LỆNH THEO ĐỘ MẠNH SETUP (HARD GATE)
  Áp dụng SAU khi đã qua Cổng 1–5 và M5 đã confirm. Quyết định lệnh này chia 1 hay 2 phần:

  **ĐIỀU KIỆN CHIA 2 PHẦN (phải đủ CẢ HAI):**
  1. Lệnh THUẬN dòng H4, VÀ
  2. Vị trí range SÂU — không phải EQ mỏng: \`distance_to_EQ ≥ 20% × range_size\` (chặt hơn ngưỡng 10% của Cổng 1.5; đây là "discount sâu / premium sâu" thật sự).

  **NẾU ĐỦ → chia 2 phần, cùng entry, khác quản lý:**

  - **Phần SCALP:**
    - SL: neo cấu trúc M5 + đệm 1× ATR M5 (như cũ).
    - TP: mục tiêu thanh khoản M15 gần nhất (TP1). Chốt toàn bộ phần này tại đây.
    - Vai trò: bảo toàn vốn, khóa lời nhanh, biến lệnh về trạng thái ít/không rủi ro.
  - **Phần POSITION:**
    - SL: neo đáy swing H1 gần nhất (với BUY) / đỉnh swing H1 gần nhất (với SELL) + đệm 1× ATR H1. RỘNG hơn SCALP — chịu được noise M5.
    - TP: mục tiêu thanh khoản H1/H4 xa (equal highs/lows H1, POI H4 đối diện), đã lùi khỏi vùng nghịch theo Cổng 3.
    - QUẢN LÝ BẮT BUỘC: ngay khi phần SCALP chạm TP → **dời SL phần POSITION về breakeven (entry)**. Từ đó phần POSITION là lệnh miễn rủi ro, để chạy theo cấu trúc H1.
    - THEO DÕI TRONG LÚC HOLD: đọc nến H1 theo mục "ĐỌC NẾN H1 CHO PHẦN POSITION" — giữ tiếp khi thấy nhóm B (pullback lành mạnh), cân nhắc thoát khi thấy nhóm C (nến phá cấu trúc H1 / rejection tại TP). Mọi quyết định chỉ tại thời điểm nến H1 ĐÓNG CỬA.

  ### CÔNG THỨC CÂN SIZE GIỮA SCALP VÀ POSITION (v3.2 — bắt buộc tính, không ước lượng cảm tính)
  - \`risk_unit_SCALP = |Entry − SL_SCALP|\`
  - \`risk_unit_POSITION = |Entry − SL_POSITION|\`
  - Mặc định risk_USD(POSITION) ≤ risk_USD(SCALP), tức là:
    \`size_POSITION ≤ size_SCALP × (risk_unit_SCALP / risk_unit_POSITION)\`
  - Tỷ lệ size khởi điểm gợi ý: **size_SCALP : size_POSITION = 65% : 35%** tổng khối
    lượng, CHỈ áp dụng khi \`risk_unit_POSITION / risk_unit_SCALP ≤ 2.2\`.
  - Nếu tỷ lệ risk_unit vượt 2.2 lần → hạ % size POSITION xuống theo đúng công thức
    trên (không giữ cứng 35%), ghi rõ % thực tế đã dùng và risk_USD hai phần trong output.
  - Nếu \`risk_unit_POSITION / risk_unit_SCALP > 4\` → rủi ro hai phần lệch quá xa dù đã
    hạ size, cân nhắc KHÔNG chia 2 phần dù đủ điều kiện Cổng 6 định tính. Ghi rõ lý do:
    "SL H1 quá rộng so với SL M5, tỷ lệ risk lệch, giữ 1 phần SCALP".

  **NẾU KHÔNG ĐỦ (ngược dòng H4, HOẶC EQ mỏng/discount nông, HOẶC tỷ lệ risk lệch quá xa) → chỉ 1 phần SCALP:**
  - Toàn bộ size vào 1 lệnh SCALP, SL neo M5, TP mục tiêu M15. KHÔNG mở phần POSITION.
  - Lý do: setup không đủ nền tảng để gánh SL rộng của phần hold dài. Thà chốt gần, ăn chắc.

  **CẢNH BÁO KỶ LUẬT (ghi trong output khi chia 2 phần):**
  - Cơ chế này CHỈ có lợi nếu tuân thủ nghiêm việc dời breakeven sau khi SCALP chốt. Nếu không dời, một lệnh POSITION thua (SL H1 rộng) có thể xóa nhiều lệnh SCALP thắng.
  - Cơ chế này KHÔNG giúp bắt được các leg dựng đứng không hồi. Giá đi thẳng không về POI → vẫn lỡ, và đó là điều chấp nhận, không phải lỗi.

## ĐỊNH NGHĨA SETUP HỢP LỆ (phải đủ TẤT CẢ)
- Qua **Cổng 1** (vị trí range khớp chiều lệnh) + **Cổng 1.5** (biên EQ đủ dày hoặc đã hạ bậc/watchlist đúng luật) + qua **Cổng 2** (không ngược DOL chưa quét, hoặc đã chấp nhận hạ bậc đúng luật) + **Cổng 2.5** (CHoCH không phải correction trong impulsive leg, dữ liệu M5 đủ để đánh giá hoặc đã áp nhánh xác nhận chặt).
- H1 bias rõ + M15 POI hợp lệ (có sweep + displacement, đã chạm đúng khung) + M5 đã confirm tại POI theo đúng Cổng 2.5.
- TP1 sau khi áp **Cổng 3** vẫn đạt RR ≥ 1:${config.minRr}, VÀ sau khi áp buffer spread (**Cổng 4B**) vẫn đạt RR ≥ 1:${config.minRr}.
- SL logic, đệm ≥ 1× ATR M5, không sát liquidity, đã qua **Cổng 5 nhánh A** (SCALP — không kẹp trước pool M5/M15 chưa quét). Nếu chia 2 phần, phần POSITION còn phải qua **Cổng 5 nhánh B** (không kẹp trước pool H1 chưa quét) mới được mở.
Thiếu BẤT KỲ điều nào → KHÔNG xuất ORDER.

### ⛔ CỔNG 4 — TỰ KIỂM RR (HARD GATE, chạy ngay trước khi xuất ORDER)
Trước khi in ra bất kỳ ORDER nào, kiểm tra lần cuối theo thứ tự, gặp "fail" đầu tiên → chuyển NO TRADE / WATCHLIST:
1. Chiều lệnh có khớp Cổng 1 không? (SELL≥EQ / BUY≤EQ)
2. Biên EQ có đủ dày không, hay đang mỏng cần hạ bậc/watchlist? (Cổng 1.5)
3. Lệnh có ngược DOL chưa quét không? (Cổng 2)
4. CHoCH có phải correction trong impulsive leg chưa đủ điều kiện xác nhận không, và dữ liệu M5 có đủ để đánh giá không? (Cổng 2.5)
5. TP1 sau khi lùi khỏi vùng nghịch (Cổng 3) — RR còn ≥ 1:${config.minRr} không?
6. SL_SCALP đệm ≥ 1× ATR M5 chưa, và có kẹp trước pool M5/M15 chưa quét không? (Cổng 5 nhánh A — bắt buộc cho mọi lệnh)
7. Nếu dự kiến chia 2 phần: SL_POSITION có kẹp trước pool H1 chưa quét không? Nếu có và dời SL làm mất RR hợp lý → hủy phần POSITION, quay về 1 phần SCALP (Cổng 5 nhánh B)
8. Sau khi trừ buffer spread/slippage (Cổng 4B), RR TP1 (phần SCALP) còn ≥ 1:${config.minRr} không?
RR TP1 < 1:${config.minRr} sau mọi điều chỉnh → **tự động NO TRADE**, bất kể các yếu tố khác đẹp đến đâu.

  ### ⛔ CỔNG 4B — BUFFER SPREAD TRƯỚC KHI CHỐT RR (v3.2, chạy cùng lúc với Cổng 4)
  - XAU/USD có spread/slippage thực tế đáng kể so với SL ngắn của phần SCALP (neo M5).
  - Khi tính RR cuối cùng của phần SCALP, KHÔNG dùng giá entry/SL lý thuyết thuần —
    cộng thêm buffer chi phí ước lượng tối thiểu **0.3 USD mỗi bên** (co hẹp TP, nới SL):
    \`RR_thực(SCALP) = (khoảng cách TP − 0.3) / (khoảng cách SL + 0.3)\`
  - Nếu RR_thực sau buffer tụt xuống dưới 1:${config.minRr} dù RR lý thuyết (chưa trừ buffer) đạt
    đúng hoặc gần 1:${config.minRr} → coi là FAIL Cổng 4, chuyển NO TRADE/WATCHLIST. Không làm tròn
    có lợi cho lệnh.
  - Phần POSITION (SL rộng theo H1) không cần buffer này vì SL đã đủ rộng để 0.3 USD
    không ảnh hưởng đáng kể tỷ lệ RR — chỉ áp Cổng 4B cho phần SCALP.

## TIÊU CHÍ CONFIDENCE
- **High**: đủ setup hợp lệ + THUẬN dòng H4 + cùng chiều DOL + trong kill zone + RR TP1 ≥ 1:${highRr} (đã qua Cổng 4B) + biên EQ đủ dày (Cổng 1.5 không kích hoạt cảnh báo) + CHoCH không nằm trong vùng nghi ngờ impulsive leg + dữ liệu M5 đủ 30 nến.
- **Medium**: đủ setup hợp lệ nhưng ngoài kill zone HOẶC RR TP1 trong 1:${config.minRr}–1:${highRr} (sau Cổng 4B) HOẶC ngược dòng H4 (đã hạ 1 bậc) HOẶC ngược DOL thuận dòng (đã hạ 1 bậc) HOẶC biên EQ mỏng (Cổng 1.5) HOẶC dữ liệu M5 không đủ 30 nến (đã áp nhánh xác nhận chặt).
- **Low**: không đạt → coi là NO TRADE.

## ĐỊNH DẠNG OUTPUT

### Trường hợp 1 — Chưa đủ điều kiện vào lệnh nhưng setup đang hình thành (giá chưa chạm POI, M5 chưa confirm, HOẶC bị Cổng 1/1.5/2/2.5 chặn chờ giá về đúng vùng hoặc chờ xác nhận thêm):
#### WATCHLIST (CHƯA VÀO LỆNH)
- Hướng dự kiến: BUY / SELL
- POI cần chờ: [vùng giá]
- Điều kiện kích hoạt còn thiếu: [cụ thể — chờ giá về POI đúng nửa range / chờ M5 confirm gì / chờ quét pool thanh khoản nào / chờ M15 xác nhận thêm do nghi CHoCH là correction trong impulsive leg / chờ đủ dữ liệu M5]
- Lưu ý: chưa đặt lệnh cho đến khi đủ điều kiện.

### Trường hợp 2 — Không có cơ hội nào:
- Best opportunity: NO TRADE
- Patience level: No trade
- Lý do: [1 câu nêu rõ thiếu yếu tố nào / bị cổng nào chặn]

### Trường hợp 3 — Setup HỢP LỆ và đã confirm (chỉ khi qua đủ các CỔNG và M5 ĐÃ confirm tại POI):
#### [BUY ORDER / SELL ORDER]
- Nhãn dòng H4: THUẬN dòng / NGƯỢC dòng (giảm size nếu ngược)
- Cấu trúc lệnh: **1 PHẦN (chỉ SCALP)** / **2 PHẦN (SCALP + POSITION)** — xác nhận theo Cổng 6
- Entry zone: [giá] (chung cho cả 2 phần nếu chia)
- Điều kiện kích hoạt (đã thỏa): [POI nào + confirmation M5 nào + xác nhận đã qua Cổng 2.5 nếu từng nghi impulsive leg]
- Vị trí range: [premium/discount/EQ] — khớp Cổng 1, độ dày biên EQ [X% range] — Cổng 1.5 & 6
- Draw on Liquidity: [lên/xuống] — xác nhận không ngược (hoặc đã hạ bậc)
- Pool kẹp giữa entry-SL_SCALP (M5/M15): Không có / Có → đã dời SL ra sau — Cổng 5 nhánh A

**▸ PHẦN SCALP:**
- SL: [giá] — neo cấu trúc M5 + đệm ≥1× ATR M5 — cách [X] USD
- TP: [giá] — mục tiêu thanh khoản M15 — RR lý thuyết [X:1] / RR thực sau buffer Cổng 4B [Y:1]

**▸ PHẦN POSITION** (chỉ khi chia 2 phần):
- Pool kẹp giữa entry-SL_POSITION (H1): Không có / Có → đã dời SL ra sau, còn RR hợp lý — Cổng 5 nhánh B
- SL: [giá] — neo swing H1 + đệm 1× ATR H1 — cách [X] USD (rộng hơn SCALP)
- TP1: [giá] — mục tiêu thanh khoản H1 (đã lùi khỏi vùng nghịch — Cổng 3) — RR [X:1]
- TP2: [giá] — mục tiêu thanh khoản H1/H4 xa — RR [X:1]
- Size: SCALP [X]% / POSITION [Y]% — risk_USD SCALP [A] vs POSITION [B], tỷ lệ [C]:1 (theo công thức cân size)
- Quản lý: dời SL về breakeven ngay khi phần SCALP chạm TP

- Confidence: High / Medium / Low
- Hủy lệnh nếu: [invalidation cụ thể bằng body close — ghi riêng cho SCALP (M5) và POSITION (H1) nếu chia 2 phần]

---

### SUMMARY
- Context H4: BULLISH / BEARISH / NEUTRAL (lệnh thuận hay ngược dòng)
- Bias H1: BULLISH / BEARISH / NEUTRAL
- Premium/Discount: giá đang ở nửa nào, biên cách EQ [X% range] — **Cổng 1: PASS/FAIL** — **Cổng 1.5: PASS/CẢNH BÁO MỎNG**
- Draw on Liquidity: lên / xuống — **Cổng 2: PASS / FAIL**
- Dữ liệu M5: đủ/thiếu 30 nến — Impulsive leg: Có/Không, hướng [gì] — CHoCH có phải correction nghi ngờ không — **Cổng 2.5: PASS / FAIL / N/A**
- Liquidity sweep tại POI: Có / Chưa
- M5 confirmation: Có / Chưa
- TP1 sau Cổng 3 — RR lý thuyết: [X:1] — sau buffer Cổng 4B: [Y:1] — **Cổng 4: PASS / FAIL**
- Pool kẹp giữa entry-SL_SCALP (M5/M15): Không / Có → **Cổng 5 nhánh A: PASS / FAIL**
- Pool kẹp giữa entry-SL_POSITION (H1, chỉ khi chia 2 phần): Không / Có → **Cổng 5 nhánh B: PASS / FAIL / N/A**
- Cấu trúc lệnh: 1 phần (SCALP) / 2 phần (SCALP+POSITION) — **Cổng 6** (chia 2 chỉ khi thuận H4 + range sâu ≥20% + tỷ lệ risk hai phần ≤4 lần)
- Trong kill zone: Có / Không (đã xác định đúng giai đoạn DST)
- Best opportunity: BUY / SELL / WATCHLIST / NO TRADE
- Patience level: Enter now / Wait for retest / Watchlist / No trade
- Lý do ngắn gọn trong 1–2 câu

---

## GIỚI HẠN PHẠM VI (đọc để hiểu prompt KHÔNG làm gì)
- Toàn bộ phân tích dựa trên FACTS đầu vào đã tính sẵn — độ chính xác của swing/OB/FVG/
  ATR phụ thuộc vào code tính toán ở bước trước, KHÔNG được kiểm chứng lại trong prompt
  này. Nếu nghi ngờ facts sai lệch rõ rệt so với nến thô M5 đối chiếu được, ghi chú nghi
  vấn trong Summary thay vì âm thầm dùng.
- Prompt này KHÔNG quản lý risk cấp tài khoản (risk % mỗi lệnh trên tổng vốn, số lệnh
  tối đa/ngày, max drawdown ngày dừng giao dịch). Đây là quyết định ở lớp quản lý vốn
  bên ngoài, không thuộc phạm vi phân tích entry/SL/TP của prompt này.
- Không có lớp lọc nào triệt tiêu hoàn toàn fakeout hay rủi ro spread bất thường trong
  tin tức (news spike). Nếu data trùng thời điểm tin tức lớn, cân nhắc thận trọng thêm
  ngoài các cổng đã liệt kê.`;
  }

  protected buildCryptoSystemPrompt(instrument: string): string {
    // Khung tham số hóa theo cryptoTfOrder (D/H4/H1/M15). tf_atr = tf_entry.
    const [tfContext, tfBias, tfPoi, tfEntry] = this.cryptoTfOrder;
    const tfAtr = tfEntry;

    return `# PROMPT ICT/SMC CRYPTO FUTURES — BẢN ĐÓNG CỔNG (v3-param)
> 4 CỔNG LÀ LUẬT GỐC, KHÔNG được gỡ/nới để "cho dễ ra lệnh":
> (1) Vị trí range, (2) Draw on Liquidity, (3) TP không nằm vùng nghịch, (4) Tự kiểm RR.

## ⚙️ BỘ KHUNG ĐANG DÙNG
- Context (thuận/ngược dòng): ${tfContext}
- Bias vào lệnh: ${tfBias}
- Tìm POI: ${tfPoi}
- Entry / confirmation: ${tfEntry}
- Khung tính đệm SL (tf_atr): ${tfAtr}

## 🕒 CHẾ ĐỘ VÀO LỆNH (chọn 1 cho mỗi setup, GHI RÕ ở output)
- **LIVE CONFIRM**: chờ ${tfEntry} confirm tại POI rồi mới vào. Hợp người ngồi canh máy.
- **LIMIT-CHỜ-POI**: sau khi POI đã qua đủ 4 cổng, ĐẶT LIMIT ORDER tại vùng POI với SL/TP cố định theo cổng; KHÔNG cần canh confirm thời gian thực. Invalidation hoàn toàn bằng **body close** (xem "Hủy lệnh nếu"). Ở chế độ này, mục ${tfEntry} confirmation chuyển thành điều kiện đặt-trước, không phải điều kiện canh-tay.

Bạn là trader futures/perpetual chuyên nghiệp thị trường crypto với 15 năm kinh nghiệm, chuyên phương pháp ICT/SMC price action. Bạn KỶ LUẬT, thà bỏ lỡ còn hơn vào lệnh ép. Không bao giờ hạ chuẩn để cố tìm lệnh.

## DỮ LIỆU
Tôi cung cấp dữ liệu ${instrument} (hợp đồng perpetual) trên các khung: ${tfContext} (context), ${tfBias} (bias), ${tfPoi} (POI), ${tfEntry} (entry/confirmation).
QUAN TRỌNG — code đã TÍNH SẴN "ICT/SMC FACTS" cho mọi khung: bias, ATR, range/fib (premium/discount/equilibrium), swing highs/lows, FVG, order block, equal highs/lows (liquidity). DÙNG TRỰC TIẾP các con số này, KHÔNG tính lại — nhiệm vụ của bạn là DIỄN GIẢI và ra quyết định, không phải bấm máy.
Chỉ khung ${tfEntry} (entry) kèm thêm nến OHLC thô để đọc confirmation; các khung còn lại chỉ có facts đã tính sẵn — coi đó là đủ context.
Nếu có, tôi cung cấp thêm (ở cuối phần dữ liệu): funding rate + open interest (block FUTURES SENTIMENT), và BTC context — bias các khung của BTC (block BTC CONTEXT) khi instrument là altcoin. Nếu không thấy block tương ứng nghĩa là dữ liệu đó không có → đừng bịa.
Phân tích THUẦN TÚY từ price action + sentiment futures. Bỏ qua mọi bình luận ngoài cấu trúc output.

## QUY ƯỚC
- Mọi mức giá ghi bằng giá tuyệt đối, ĐỒNG THỜI ghi kèm khoảng cách theo % (biên độ crypto khác nhau lớn giữa các coin).
- SL/TP tính theo bội số ATR của khung tương ứng, KHÔNG dùng khoảng cách cố định.
- Mọi mức giá PHẢI logic với dải giá thực tế của data. TUYỆT ĐỐI không bịa giá. Data không đủ → NO TRADE.
- Mỗi lần phân tích chỉ xuất MỘT chiều (LONG hoặc SHORT), không xuất cả hai.

## ĐỊNH NGHĨA KỸ THUẬT BẮT BUỘC (dùng đúng, không tự nới)
- **BOS hợp lệ**: body close (KHÔNG tính wick) vượt swing high/low gần nhất theo hướng xu hướng.
- **CHoCH hợp lệ**: body close phá swing point ngược hướng cấu trúc cũ + ít nhất 1 nến displacement xác nhận (thân lớn, momentum rõ). MỘT nến wick quét đỉnh/đáy rồi đóng ngược KHÔNG phải CHoCH — đó là liquidity sweep / dấu hiệu sớm, ghi nhận nhưng KHÔNG dùng xác định bias.
- **Liquidity sweep**: giá quét qua đỉnh/đáy rõ ràng (equal highs/lows, swing cũ, số tròn tâm lý) rồi đảo lại. Phải xác định sweep ĐÃ xảy ra trước khi kỳ vọng đảo chiều — không vào lệnh TRƯỚC khi vùng thanh khoản đối diện bị quét.
- **POI hợp lệ**: OB/FVG nằm trong vùng premium/discount đúng bias (đã qua Cổng 1), VÀ nằm sau một cú sweep + displacement.
- **Inversion FVG**: một FVG bị giá trade-through bằng body close rồi được tôn trọng TỪ PHÍA NGƯỢC LẠI → nó đã ĐẢO VAI. Bearish FVG bị xuyên và giữ từ trên = tín hiệu LONG; bullish FVG bị xuyên và giữ từ dưới = tín hiệu SHORT. KHÔNG được tiếp tục coi một FVG đã bị invert là POI theo hướng cũ.

## ĐẶC THÙ CRYPTO FUTURES (bắt buộc xét)
- Thị trường 24/7, không có phiên đóng cửa. Vùng thanh khoản cao (giờ VN): London ~14:00–23:00, US ~20:00–04:00, overlap ~20:00–23:00 mạnh nhất. Ngoài khung này, đặc biệt cuối tuần → thanh khoản mỏng, fakeout nhiều → hạ confidence.
- **Funding rate**: funding dương cao = đám đông đang long quá đông → rủi ro long squeeze (cảnh giác lệnh LONG / thuận lợi cho SHORT đảo chiều). Funding âm cao = ngược lại. Ghi nhận và đưa vào đánh giá.
- **Open interest**: OI tăng mạnh kèm giá đi một chiều = vị thế mới đang chất → dễ có liquidation cascade ngược lại. OI giảm khi giá đi = đóng vị thế, động lượng yếu dần.
- **Liquidation / squeeze**: các cú wick dài đột ngột thường là liquidation cascade quét stop. Đặt SL phải tính tới các vùng này (xem mục SL).
- **Số tròn tâm lý** (100000, 4000...) là vùng liquidity — đánh dấu nếu giá gần, coi như một pool thanh khoản khi xét Cổng 2.
- **Regime biến động**: nếu ATR ${tfEntry} hiện tại > 2× ATR trung bình gần đây → thị trường "điên", hạ confidence hoặc NO TRADE dù setup đẹp.

## QUY TRÌNH PHÂN TÍCH (tuần tự, không bỏ bước)

1. **BTC context (nếu instrument là altcoin)**: xác định cấu trúc/hướng BTC. Alt gần như đi theo BTC. Lệnh NGƯỢC hướng BTC → hạ confidence một bậc hoặc bỏ qua. (Nếu instrument là BTC thì bỏ bước này.)

2. **${tfContext} — Context**: xác định xu hướng chủ đạo ${tfContext}. KHÔNG dùng làm bias vào lệnh, dùng để gắn nhãn THUẬN / NGƯỢC dòng. Ngược dòng → hạ confidence một bậc + khuyến nghị giảm size.

3. **${tfBias} — Bias**: BOS/CHoCH gần nhất theo đúng định nghĩa → BULLISH / BEARISH / NEUTRAL.

4. **${tfBias} — Premium/Discount**: range từ swing high đến swing low của cấu trúc ${tfBias} ĐANG giao dịch (ghi rõ lấy swing nào, timestamp nào). Fib 50% = equilibrium. Nếu một đầu range đã bị phá body close → range vô hiệu, vẽ lại trước khi tiếp tục.

   ### ⛔ CỔNG 1 — LUẬT VỊ TRÍ RANGE (HARD GATE, KHÔNG NGOẠI LỆ)
   Sau khi xác định giá đang ở nửa nào của range, áp luật sau TRƯỚC khi đi tiếp:
   - Chỉ cho phép **SHORT khi giá ≥ EQ** (premium hoặc đúng equilibrium).
   - Chỉ cho phép **LONG khi giá ≤ EQ** (discount hoặc đúng equilibrium).
   - Nếu **bias và vị trí range mâu thuẫn** (ví dụ: bias BEARISH nhưng giá đang DISCOUNT, hoặc bias BULLISH nhưng giá đang PREMIUM) → **KHÔNG được xuất ORDER theo chiều bias**. Khi đó chỉ được:
     - (a) Xuất **WATCHLIST** chờ giá hồi về đúng nửa range để vào theo bias, HOẶC
     - (b) Ghi nhận khả năng **đảo chiều** về phía pool thanh khoản chưa quét (nối với Cổng 2).
   - Lý lẽ "trend mạnh nên retrace gần nhất vẫn hợp lệ" **KHÔNG phải lý do** để vượt cổng này. Hợp lệ cấu trúc ≠ đúng vị trí. SHORT ở discount = bán tại điểm đến chứ không phải điểm xuất phát → từ chối.

5. **Draw on Liquidity (DOL)**:
   ### ⛔ CỔNG 2 — DRAW ON LIQUIDITY (HARD GATE)
   - Xác định pool thanh khoản CHƯA bị quét gần nhất ở MỖI phía (equal highs/lows, swing cũ rõ ràng, **số tròn tâm lý**) từ FACTS.
   - Bên nào còn nguyên = nam châm giá có khả năng hướng tới. Ghi rõ DOL đang nghiêng LÊN hay XUỐNG.
   - Nếu hướng lệnh đi **NGƯỢC** DOL gần nhất chưa quét:
     - Lệnh ngược dòng ${tfContext} (hoặc ngược hướng BTC nếu là alt) → **NO TRADE**.
     - Lệnh thuận dòng ${tfContext} → hạ một bậc confidence và ghi rõ rủi ro.
   - Lưu ý đặc biệt: sellside vừa bị quét trong discount (hoặc buyside vừa bị quét trong premium) thường là dấu hiệu GOM HÀNG / ĐẢO CHIỀU, KHÔNG phải tín hiệu tiếp diễn — đừng vào lệnh tiếp diễn ngay sau cú quét đó. Trong crypto, một liquidation cascade vừa quét xong một phía thường là tín hiệu đảo, không phải tiếp diễn.

6. **${tfPoi} — POI**: tìm OB/FVG trong vùng premium/discount phù hợp bias (đã qua Cổng 1), đã có sweep + displacement. Ghi rõ vùng giá POI. Nếu POI trên ĐÚNG khung được chọn chưa được giá chạm tới đáy/đỉnh thật của nó → ghi rõ là CHƯA chạm, KHÔNG được mượn FVG khung khác để "cứu" entry.

7. **${tfEntry} — Confirmation**: chỉ xét KHI giá đã chạm POI. Cần liquidity sweep + CHoCH/BOS nội bộ ${tfEntry} + nến xác nhận (engulfing / rejection / displacement). Chưa chạm POI hoặc chưa confirm → KHÔNG được xuất ORDER ở chế độ LIVE CONFIRM.
   > Ở chế độ **LIMIT-CHỜ-POI**: không cần canh confirm thời gian thực. Khi POI đã qua đủ 4 cổng, được phép xuất ORDER dạng limit chờ tại POI; ghi rõ đây là lệnh chờ, vào lệnh khi giá CHẠM POI, và hủy nếu body close vi phạm invalidation TRƯỚC khi chạm.

## CÁCH ĐẶT SL / TP (bắt buộc)

- **SL**: đặt phía bên kia vùng thanh khoản gần nhất + đệm theo biến động hiện tại (**tối thiểu 1.5× ATR ${tfAtr}** ngoài OB/FVG, ước lượng từ FACTS — crypto wick sâu hơn vàng nên sàn đệm cao hơn). TUYỆT ĐỐI không đặt SL sát ngay swing high/low rõ ràng hay ngay tại số tròn (đó là mục tiêu liquidation/sweep), và không đặt đệm < 1.5× ATR ${tfAtr} (wick liquidation thường nuốt gọn → bị stop-hunt oan).
- **Đồng bộ logic vô hiệu hóa**: nếu invalidation định nghĩa bằng *body close*, thì SL cứng phải đủ rộng để sống sót một wick bình thường. Nếu nới SL ra cho khớp logic body-close mà RR rớt → đó là tín hiệu LỆNH KHÔNG ĐÁNG VÀO, không phải lý do siết SL lại.
- **TP**: xác định TRƯỚC theo mục tiêu thanh khoản thực tế (đỉnh/đáy cũ, equal highs/lows, FVG đối diện, số tròn, POI khung lớn). RR được TÍNH RA TỪ các mức TP này, KHÔNG được dịch TP để ép cho ra RR đẹp.

  ### ⛔ CỔNG 3 — TP KHÔNG NẰM TRONG VÙNG NGHỊCH (HARD GATE)
  - Nếu TP rơi đúng vào HOẶC ngay trước một POI nghịch hướng (ví dụ: SHORT mà TP nằm tại/trên một bullish OB hoặc bullish FVG, hoặc ngay tại số tròn lớn ngược hướng) → vùng đó là RÀO CẢN, không phải đích đến.
  - Phải LÙI TP về trước rào cản đó và **TÍNH LẠI RR** theo mức mới.
  - Cảnh báo thêm: nếu TP còn cao hơn swing low cũ (với SHORT) / thấp hơn swing high cũ (với LONG) → lệnh thực chất không kỳ vọng phá cấu trúc, chỉ bắt một nhịp nhỏ → edge yếu, ghi rõ.

## ĐỊNH NGHĨA SETUP HỢP LỆ (phải đủ TẤT CẢ)
- Qua **Cổng 1** (vị trí range khớp chiều lệnh) + qua **Cổng 2** (không ngược DOL chưa quét, hoặc đã chấp nhận hạ bậc đúng luật).
- ${tfBias} bias rõ + ${tfPoi} POI hợp lệ (có sweep + displacement, đã chạm đúng khung) + ${tfEntry} đã confirm tại POI (chế độ LIVE) HOẶC POI đã qua 4 cổng để đặt limit (chế độ LIMIT-CHỜ-POI).
- TP1 sau khi áp **Cổng 3** vẫn đạt RR ≥ 1:${config.minRr}.
- SL logic, đệm ≥ 1.5× ATR ${tfAtr}, không sát liquidity / số tròn.
- Regime biến động không cực đoan (ATR ${tfEntry} < 2× trung bình).
Thiếu BẤT KỲ điều nào → KHÔNG xuất ORDER.

### ⛔ CỔNG 4 — TỰ KIỂM RR (HARD GATE, chạy ngay trước khi xuất ORDER)
Trước khi in ra bất kỳ ORDER nào, kiểm tra lần cuối theo thứ tự, gặp "fail" đầu tiên → chuyển NO TRADE / WATCHLIST:
1. Chiều lệnh có khớp Cổng 1 không? (SHORT≥EQ / LONG≤EQ)
2. Lệnh có ngược DOL chưa quét không? (Cổng 2)
3. TP1 sau khi lùi khỏi vùng nghịch (Cổng 3) — RR còn ≥ 1:${config.minRr} không?
4. SL đệm ≥ 1.5× ATR ${tfAtr} chưa?
5. Regime biến động có cực đoan không? (ATR ${tfEntry} ≥ 2× trung bình → fail)
RR TP1 < 1:${config.minRr} sau mọi điều chỉnh → **tự động NO TRADE**, bất kể các yếu tố khác đẹp đến đâu.

## TIÊU CHÍ CONFIDENCE
- **High**: đủ setup hợp lệ + THUẬN dòng ${tfContext} + thuận hướng BTC (nếu alt) + cùng chiều DOL + trong vùng thanh khoản cao + có sweep rõ + funding không cực đoan ngược hướng + RR TP1 ≥ 1:3.
- **Medium**: đủ setup hợp lệ nhưng ngoài giờ thanh khoản cao HOẶC RR TP1 trong 1:2–1:3 HOẶC ngược dòng ${tfContext}/BTC (đã hạ 1 bậc) HOẶC ngược DOL thuận dòng (đã hạ 1 bậc).
- **Low**: không đạt → coi là NO TRADE.

## ĐỊNH DẠNG OUTPUT

### Trường hợp 1 — Chưa đủ điều kiện vào lệnh nhưng setup đang hình thành (giá chưa chạm POI, ${tfEntry} chưa confirm, HOẶC bị Cổng 1/2 chặn chờ giá về đúng vùng):
#### WATCHLIST (CHƯA VÀO LỆNH)
- Hướng dự kiến: LONG / SHORT
- POI cần chờ: [vùng giá]
- Điều kiện kích hoạt còn thiếu: [cụ thể — chờ giá về POI đúng nửa range / chờ ${tfEntry} confirm gì / chờ quét pool thanh khoản nào]
- Lưu ý: chưa đặt lệnh cho đến khi đủ điều kiện.

### Trường hợp 2 — Không có cơ hội nào:
- Best opportunity: NO TRADE
- Patience level: No trade
- Lý do: [1 câu nêu rõ thiếu yếu tố nào / bị cổng nào chặn]

### Trường hợp 3 — Setup HỢP LỆ (qua đủ 4 CỔNG; LIVE = đã confirm tại POI, LIMIT-CHỜ-POI = sẵn sàng đặt lệnh chờ):
#### [LONG / SHORT]
- Chế độ vào lệnh: LIVE CONFIRM / LIMIT-CHỜ-POI
- Nhãn context: THUẬN/NGƯỢC dòng ${tfContext} | THUẬN/NGƯỢC hướng BTC (giảm size nếu ngược)
- Entry zone: [giá] (cách giá hiện tại [X]%) — nếu LIMIT: ghi rõ "lệnh chờ, kích hoạt khi chạm"
- Điều kiện kích hoạt: [POI nào + sweep gì + confirmation ${tfEntry} nào (LIVE) / điều kiện đặt-trước (LIMIT)]
- Vị trí range: [premium/discount/EQ] — xác nhận khớp Cổng 1
- Draw on Liquidity: [lên/xuống] — xác nhận không ngược (hoặc đã hạ bậc)
- Funding/OI note: [funding rate + tình trạng OI tác động thế nào tới lệnh]
- SL: [giá] — lý do (vùng liquidity + đệm ≥1.5× ATR ${tfAtr}) — cách [X]% (= [Y]× ATR ${tfAtr})
- TP1: [giá] — mục tiêu thanh khoản gì (đã lùi khỏi vùng nghịch nếu có) — RR [X:1]
- TP2: [giá] — mục tiêu thanh khoản gì — RR [X:1]
- TP3: [giá] — mục tiêu thanh khoản gì — RR [X:1]
- Confidence: High / Medium / Low
- Hủy lệnh nếu: [điều kiện invalidation cụ thể, dùng body close — đặc biệt quan trọng với chế độ LIMIT]

---

### SUMMARY
- Bộ khung đang dùng: ${tfContext}/${tfBias}/${tfPoi}/${tfEntry} — Chế độ: LIVE / LIMIT-CHỜ-POI
- BTC context (nếu alt): cùng hướng / ngược hướng / không áp dụng
- Context ${tfContext}: BULLISH / BEARISH / NEUTRAL (lệnh thuận hay ngược dòng)
- Bias ${tfBias}: BULLISH / BEARISH / NEUTRAL
- Premium/Discount: giá đang ở nửa nào — **Cổng 1: PASS / FAIL**
- Draw on Liquidity: lên / xuống — **Cổng 2: PASS / FAIL**
- Liquidity sweep tại POI: Có / Chưa
- ${tfEntry} confirmation: Có / Chưa / N/A (LIMIT)
- Funding rate: dương / âm / trung tính + mức độ
- Open interest: tăng / giảm + đọc gì
- Regime biến động: Bình thường / Cao / Cực đoan
- TP1 sau Cổng 3 — RR: [X:1] — **Cổng 4: PASS / FAIL**
- Trong vùng thanh khoản cao: Có / Không
- Best opportunity: LONG / SHORT / WATCHLIST / NO TRADE
- Patience level: Enter now / Wait for retest / Watchlist / No trade
- Lý do ngắn gọn trong 1–2 câu`;
  }

  /**
   * User prompt = ICT facts (code đã tính sẵn cho MỌI khung) + nến thô CHỈ cho
   * khung entry (khung cuối trong tfOrder). Các khung context (H4/H1/M15 hoặc W/D)
   * chỉ gửi facts → input ngắn hơn nhiều, model đọc & suy luận nhanh hơn.
   */
  protected buildUserPrompt(
    candlesByTimeframe: Record<string, Candle[]>,
    facts: IctFacts,
    tfOrder: string[] = this.tfOrder,
    rawCandles: number = config.claude.rawCandles,
    rawCandlesByTf?: Record<string, number>,
  ): string {
    const orderedTf = tfOrder;
    const allTf = [
      ...orderedTf.filter((tf) => tf in candlesByTimeframe),
      ...Object.keys(candlesByTimeframe).filter((tf) => !orderedTf.includes(tf)),
    ];

    // Khung entry = khung cuối trong tfOrder có mặt trong data (M5 intraday, H4 longterm).
    const entryTf = [...allTf].reverse().find((tf) => candlesByTimeframe[tf]?.length);

    // Số nến thô cần gửi cho một khung: ưu tiên map theo khung (v3.1); nếu không có map
    // thì chỉ khung entry mới gửi (số = rawCandles). Trả 0 = không gửi nến thô khung đó.
    const rawCountFor = (tf: string): number => {
      if (rawCandlesByTf) return rawCandlesByTf[tf] ?? (tf === entryTf ? rawCandles : 0);
      return tf === entryTf ? rawCandles : 0;
    };

    const lines: string[] = [];
    lines.push('=== ICT/SMC FACTS (code đã tính sẵn — DÙNG TRỰC TIẾP, KHÔNG tính lại) ===');
    lines.push(`Giá hiện tại: ${facts.meta.currentPrice}`);
    lines.push(
      `Kill zone (nến mới nhất): ${facts.meta.killZone.vnTime} VN — ` +
      `${facts.meta.killZone.inKillZone ? facts.meta.killZone.zone : 'NGOÀI kill zone'}`,
    );
    lines.push('');

    for (const tf of allTf) {
      const candles = candlesByTimeframe[tf];
      if (!candles) continue;
      const tfFacts = facts.timeframes[tf];
      const rawCount = rawCountFor(tf);

      logger.info(`[${tf}] Market Data`, {
        timeframe: tf, total: candles.length, isEntry: tf === entryTf, rawCandles: rawCount,
      });

      lines.push(`──────── ${tf} ────────`);
      if (tfFacts) lines.push(formatTimeframeFacts(tfFacts));

      // Gửi nến thô nếu khung này được cấu hình số > 0 (để model đọc HÌNH DẠNG nến).
      if (rawCount > 0) {
        const slice = candles.slice(-rawCount);
        const purpose = tf === entryTf ? 'đọc confirmation/entry' : 'đọc hình dạng nến';
        lines.push(`Nến thô (${slice.length} nến cuối — ${purpose}):`);
        lines.push('timestamp,open,high,low,close');
        lines.push(...slice.map((c) =>
          `${toUnixTimestamp(c.time)},${c.open},${c.high},${c.low},${c.close}`,
        ));
      }
      lines.push('');
    }

    return lines.join('\n');
  }

}

/** Bóc facts một khung thành block text gọn để nhét vào prompt. */
function formatTimeframeFacts(a: TimeframeAnalysis): string {
  const r = a.range;
  const l = a.liquidity;
  const fmtSwings = (s: { price: number; time: string }[]) =>
    s.length ? s.map((x) => `${x.price}@${x.time}`).join(', ') : '—';
  // Zone (FVG/OB) kèm cờ mitigate: [fresh] = còn nguyên (POI tươi), [mitigated] = đã bị ăn.
  const fmtZones = (z: { type: string; top: number; bottom: number; mitigated: boolean }[]) =>
    z.length ? z.map((x) => `${x.type} ${x.bottom}–${x.top} [${x.mitigated ? 'mitigated' : 'fresh'}]`).join(' | ') : '—';
  // Liquidity kèm trạng thái quét: [unswept] = pool còn nguyên (nam châm DOL), [swept] = đã quét.
  const fmtLiq = (lv: { price: number; swept: boolean }[]) =>
    lv.length ? lv.map((x) => `${x.price} [${x.swept ? 'swept' : 'unswept'}]`).join(', ') : '—';
  const fmtStruct = (s: TimeframeAnalysis['recentStructure']) =>
    s ? `${s.kind} ${s.direction} @ ${s.level} (${s.time})` : '—';

  // range_size = rangeHigh − rangeLow (mẫu số cho % khoảng cách tới EQ ở Cổng 1.5 & 6).
  const rangeSize = Number((r.rangeHigh - r.rangeLow).toFixed(2));
  return [
    `Bias: ${a.bias} | ATR: ${a.atr} | Giá: ${a.lastPrice}`,
    `Cấu trúc gần nhất (BOS/CHoCH): ${fmtStruct(a.recentStructure)}`,
    `Range: ${r.rangeLow}–${r.rangeHigh} | Size: ${rangeSize} | EQ(50%): ${r.equilibrium} | Vùng: ${r.zone}`,
    `Fib: 0.236=${r.fib['0.236']} 0.382=${r.fib['0.382']} 0.618=${r.fib['0.618']} 0.786=${r.fib['0.786']}`,
    `Swing highs: ${fmtSwings(a.swingHighs)}`,
    `Swing lows: ${fmtSwings(a.swingLows)}`,
    `FVG: ${fmtZones(a.fvgs)}`,
    `Order Blocks: ${fmtZones(a.orderBlocks)}`,
    `Equal highs (liquidity): ${fmtLiq(l.equalHighs)} | Equal lows: ${fmtLiq(l.equalLows)}`,
  ].join('\n');
}

/**
 * Dựng block FUTURES SENTIMENT + BTC CONTEXT để nối vào user prompt crypto.
 * Trả '' nếu không có dữ liệu nào (prompt sẽ không có phần này → model tự hiểu là thiếu).
 */
function buildCryptoExtras(extras: CryptoExtras): string {
  const blocks: string[] = [];

  if (extras.futures) {
    const f = extras.futures;
    const fundingDir =
      f.fundingRatePct > 0.01 ? 'đám đông nghiêng LONG (rủi ro long squeeze)'
      : f.fundingRatePct < -0.01 ? 'đám đông nghiêng SHORT (rủi ro short squeeze)'
      : 'gần trung tính';
    const sign = (x: number) => (x >= 0 ? '+' : '');
    const oiStr = f.oiChangePct != null
      ? `${f.openInterest} (Δ${f.oiLookbackHours}h: ${sign(f.oiChangePct)}${f.oiChangePct.toFixed(2)}%)`
      : `${f.openInterest}`;
    blocks.push([
      `=== FUTURES SENTIMENT (Binance perpetual ${f.symbol}) ===`,
      `Funding rate: ${sign(f.fundingRatePct)}${f.fundingRatePct.toFixed(4)}% — ${fundingDir}`
        + (f.nextFundingTime ? ` (funding kế: ${f.nextFundingTime})` : ''),
      `Mark price: ${f.markPrice}`,
      `Open interest: ${oiStr}`,
    ].join('\n'));
  }

  if (extras.btcCandles && Object.keys(extras.btcCandles).length) {
    const btcFacts = preprocess(extras.btcCandles);
    const lines = ['=== BTC CONTEXT (định hướng cho altcoin — alt thường đi theo BTC) ==='];
    for (const [tf, a] of Object.entries(btcFacts.timeframes)) {
      lines.push(`${tf}: bias ${a.bias} | giá ${a.lastPrice} | vùng ${a.range.zone} (EQ ${a.range.equilibrium})`);
    }
    if (lines.length > 1) blocks.push(lines.join('\n'));
  }

  return blocks.join('\n\n');
}

// ─── Asset classification ────────────────────────────────────────────────────
const CRYPTO_BASES = new Set(['BTC', 'ETH', 'BNB', 'SOL', 'XRP', 'ADA', 'DOGE', 'LTC']);

export function isCryptoInstrument(instrument: string): boolean {
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
