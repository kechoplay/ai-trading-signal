import { Candle } from '../market/Candle';
import { AnalysisResult, ConditionalSetup } from './dto/AnalysisResult';
import { config } from '../../config/trading';
import { logger } from '../../logger';
import { preprocess, IctFacts, TimeframeAnalysis } from './ict/IctPreprocessor';
import { FuturesSentiment } from '../market/BinanceFuturesService';
import { LlmTransport, Effort, RateLimitSnapshot, TokenUsage } from './transport/LlmTransport';
import { AnthropicApiTransport } from './transport/AnthropicApiTransport';
import { ClaudeSubscriptionTransport } from './transport/ClaudeSubscriptionTransport';

/**
 * Dữ liệu bổ trợ chỉ dùng cho phân tích crypto futures:
 *  - futures: funding rate + open interest (Binance perpetual).
 *  - btcCandles: nến BTC theo khung để làm "BTC context" cho altcoin (BTC tự nó → bỏ trống).
 */
export interface CryptoExtras {
  futures?: FuturesSentiment | null;
  btcCandles?: Record<string, Candle[]> | null;
}

/**
 * Tín hiệu của lần phân tích gần nhất, dùng để "carry-forward" — nhét lại vào prompt
 * cho AI đánh giá tiếp thay vì phân tích lại từ số 0. Cố ý đưa dạng ĐÁNH GIÁ ĐỘC LẬP
 * để tránh anchoring bias.
 *  - kind='watchlist': setup đang canh → KIỂM CHỨNG (đã kích hoạt / vô hiệu / vẫn chờ).
 *  - kind='order':     lệnh đã ra → QUẢN LÝ (giữ / dời SL / thoát / đã đóng).
 */
export interface PendingSetup {
  kind: 'watchlist' | 'order';
  direction: 'BUY' | 'SELL';
  ageMinutes: number;
  analyzedAtVn: string;   // thời điểm phân tích trước (giờ VN, đã format)
  priceThen: number | null;
  rawText: string;        // nội dung block lần trước (POI+SL/TP dự kiến, hoặc lệnh + "Hủy lệnh nếu")
  // Chỉ có với kind='order' — thông số lệnh đã lưu ở cột DB.
  entry?: number | null;
  stopLoss?: number | null;
  takeProfit?: number | null;
  riskReward?: number | null;
}

export class ClaudeAnalystService {
  protected readonly tfOrder: string[] = ['H4', 'H1', 'M15', 'M5'];
  // Crypto dùng bộ khung từ M15 (D context → H4 bias → H1 POI → M15 entry).
  // Tách riêng vì cùng một service xử lý cả vàng (M5) lẫn crypto.
  protected readonly cryptoTfOrder: string[] = ['D', 'H4', 'H1', 'M15'];

  constructor(
    private readonly model: string,
    private readonly transport: LlmTransport,
  ) {}

  static fromConfig(): ClaudeAnalystService {
    return new ClaudeAnalystService(config.claude.model, ClaudeAnalystService.resolveTransport());
  }

  /**
   * Chọn transport theo AI_AUTH_MODE:
   *  - 'subscription' → Claude Agent SDK + CLAUDE_CODE_OAUTH_TOKEN (subscription Pro/Max).
   *  - còn lại ('apikey') → Anthropic Messages API + CLAUDE_API_KEY.
   * Dùng chung cho cả LongTerm & BottomReversal (kế thừa qua constructor).
   */
  static resolveTransport(): LlmTransport {
    if (config.claude.authMode === 'subscription') {
      return new ClaudeSubscriptionTransport();
    }
    if (!config.claude.apiKey) throw new Error('CLAUDE_API_KEY is not configured.');
    return new AnthropicApiTransport(config.claude.apiKey);
  }

  async analyze(
    instrument: string,
    candlesByTimeframe: Record<string, Candle[]>,
    _currentPrice: number,
    extras?: CryptoExtras,
    pending?: PendingSetup | null,
  ): Promise<{
    result: AnalysisResult;
    rawText: string;
    usage: TokenUsage | null;
    rateLimit: RateLimitSnapshot | null;
  }> {
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

    // Carry-forward: setup WATCHLIST lần trước → yêu cầu AI kiểm chứng độc lập.
    if (pending) userPrompt += `\n\n${buildPendingSetupBlock(pending)}`;

    logger.info('[Claude] User prompt', { prompt: userPrompt });

    // Gọi LLM qua transport đã chọn (API key hoặc subscription). max_tokens đủ lớn cho
    // cả thinking + text; parser bên dưới xử lý text trả về giống nhau ở cả hai đường.
    const effort = config.claude.effort as Effort;
    logger.info('[Claude] Analyze request', {
      instrument,
      model:     this.model,
      effort,
      transport: this.transport.name,
    });

    const { text: rawText, meta, usage, rateLimit } = await this.transport.complete({
      model:     this.model,
      system:    systemPrompt,
      userPrompt,
      maxTokens: 64000,
      effort,
    });

    logger.info('[Claude] Response meta', {
      instrument,
      model:     this.model,
      effort,
      transport: this.transport.name,
      ...meta,
    });

    if (!rawText) {
      throw new Error(
        `Claude returned no text content. Transport=${this.transport.name}, meta=${JSON.stringify(meta)}`,
      );
    }

    logger.info('[Claude] Raw response:\n' + rawText);

    const result = this.parseAnalysisResult(rawText);
    return { result, rawText, usage, rateLimit };
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
- **M15 — XÁC NHẬN TRUNG GIAN**: giá đã chạm POI H1/H4 chưa, có dấu hiệu cạn lực chưa (dùng cho Cảnh báo C).
- **M5 — CHỈ TỐI ƯU ĐIỂM VÀO**: tìm entry đẹp nhất + SL sát nhất CHO PHẦN SCALP trong vùng POI đã được H1/H4 chấp thuận. M5 KHÔNG quyết định TP dài, KHÔNG quyết định hold bao lâu, KHÔNG quyết định SL của phần POSITION.

---

Bạn là trader scalp chuyên nghiệp XAU/USD với 15 năm kinh nghiệm, chuyên phương pháp ICT/SMC price action. Bạn kỷ luật nhưng CHỦ ĐỘNG săn cơ hội: mục tiêu là tìm ra lệnh có xác suất thắng hợp lý và quản trị rủi ro tốt, KHÔNG phải né mọi rủi ro. Chỉ có 3 điều kiện là RÀO CỨNG tuyệt đối (xem HARD GATE); mọi yếu tố còn lại là tín hiệu để ĐIỀU CHỈNH ĐỘ TIN CẬY (hạ/giảm size), KHÔNG dùng để chặn lệnh. Khi một setup thỏa 3 rào cứng và bạn đọc được câu chuyện price action hợp lý → hãy xuất ORDER (có thể ở confidence Medium/Low), đừng ép về WATCHLIST chỉ vì một yếu tố phụ chưa hoàn hảo.
Hai điều cần nhớ ngay từ đầu, vì chúng quyết định phần lớn việc bạn ra ORDER hay WATCHLIST: (1) bạn được phép đặt **LỆNH CHỜ tại POI** khi POI đã chín, không bắt buộc phải có confirmation M5 thời gian thực — xem mục "HAI CHẾ ĐỘ VÀO LỆNH"; (2) mọi luật về **vị trí range đo tại mức entry dự kiến**, KHÔNG đo tại giá hiện tại.

Tôi cung cấp dữ liệu cho các khung: H4 (context), H1 (bias), M15 (POI), M5 (entry/confirmation).
QUAN TRỌNG — code đã TÍNH SẴN các "ICT/SMC FACTS" cho mọi khung: bias, ATR, **ADX/DMI (regime)**, range/fib (premium/discount/equilibrium), swing highs/lows, FVG, order block, equal highs/lows (liquidity), kill zone. Hãy DÙNG TRỰC TIẾP các con số này, KHÔNG tính lại từ đầu — nhiệm vụ của bạn là DIỄN GIẢI và ra quyết định, không phải bấm máy.
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
- **Impulsive leg**: một chuỗi ≥ 5 nến M5 liên tiếp cùng hướng (cho phép tối đa 1 nến ngược màu nhỏ xen giữa, thân < 30% trung bình các nến impulsive), tổng biên độ di chuyển ≥ 3× ATR M5, tính từ điểm bắt đầu chuỗi đến điểm cao/thấp nhất đạt được. Nếu M5 hiện đang (hoặc vừa kết thúc trong vòng ≤ 3 nến) một impulsive leg → mọi pullback ngược hướng leg đó nên coi là **correction** (thận trọng hơn), phản ánh vào Cảnh báo C.
  - **YÊU CẦU DỮ LIỆU:** để đánh giá đúng trạng thái impulsive leg cần tối thiểu **30 nến
    M5 gần nhất (~2.5 giờ)**. Nếu dữ liệu M5 ít hơn 30 nến → coi như CHƯA xác định chắc
    trạng thái impulsive leg; một CHoCH xuất hiện trong điều kiện thiếu dữ liệu này là
    confirmation "yếu" → kích **Cảnh báo C** (hạ 1 bậc confidence), KHÔNG chặn lệnh.

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

3. **H1 — Premium/Discount**: đọc \`DEALING RANGE\` của H1 trong FACTS (leg đang chạy). Fib 50% = equilibrium của chính leg đó. Nếu chân leg đã bị phá body close → leg vô hiệu, đọc lại leg mới trước khi tiếp tục.

   ### ⛔ HARD GATE 1 — KHÔNG MUA ĐỈNH / BÁN ĐÁY TRẮNG TRỢN (rào cứng duy nhất về vị trí)
   Đây là rào cứng, nhưng ĐÃ NỚI so với luật EQ cũ — chỉ chặn khi giá sai phía RÕ RỆT:

   #### ▸ MẪU SỐ: DÙNG DEALING RANGE, KHÔNG DÙNG RANGE MỞ RỘNG
   > Lý do: "Range mở rộng" trong FACTS là high/low của **80 nến H1 ≈ 3 ngày giao dịch**. Một lệnh scalp M5 có SL 6–12 USD mà đo vị trí bằng cái range 120 USD kéo dài 3 ngày là **sai đơn vị đo**: nó chỉ nói giá đang ở đâu so với 3 ngày trước, không nói nhịp hiện tại còn chạy được bao xa. Đo như vậy thì mọi pullback nông trong một leg tăng đều thành "premium > 60%" và bị chặn oan — loại đúng những lệnh thuận trend tốt nhất.
   - **Mẫu số chính thức = \`DEALING RANGE\` của H1 trong FACTS** (leg đang chạy: từ chân leg tới cực trị hiện tại). Mọi con số "% range" ở Cổng 1, Cảnh báo A và Summary đều tính trên leg này.
   - Chỉ khi FACTS ghi dealing range là \`—\`, HOẶC \`sizeAtr < 1\` (leg nhỏ hơn 1× ATR = nhiễu, chưa thành nhịp) → mới lùi về dùng range mở rộng làm mẫu số. Ghi rõ trong Summary đã dùng mẫu số nào.
   - Range mở rộng vẫn phải ĐỌC để biết bối cảnh (giá đang ở đâu trong bức tranh lớn) và để chọn mục tiêu thanh khoản xa — nhưng KHÔNG dùng nó để chặn lệnh.

   #### ▸ ĐO TẠI ĐÂU
   - **ĐO TẠI GIÁ VÀO LỆNH DỰ KIẾN, KHÔNG PHẢI GIÁ HIỆN TẠI.** Vị trí range luôn tính cho mức entry mà lệnh sẽ khớp (giữa vùng POI) — đó mới là nơi tiền thực sự vào thị trường. Giá hiện tại chỉ dùng để biết POI còn ở phía trước hay đã đi qua. Ghi cả hai vào Summary: "% dealing range tại entry dự kiến [X]% (giá hiện tại [Y]%)".
     → Hệ quả: giá hiện tại đang ở premium sâu KHÔNG tự động chặn một lệnh BUY có entry nằm tại POI trong discount, và ngược lại. Chỉ chặn khi CHÍNH mức entry rơi vào vùng cực đoan sai phía.
   - Chia dealing range làm 3 vùng: DISCOUNT sâu (0–40%), GIỮA (40–60% quanh EQ), PREMIUM sâu (60–100%).
   - **Chỉ CHẶN** hai trường hợp cực đoan: BUY khi giá đang ở **PREMIUM sâu (>60% range)**, hoặc SELL khi giá đang ở **DISCOUNT sâu (<40% range)** — đó là mua đúng đỉnh / bán đúng đáy, edge âm.
     → Khi rơi vào đây và vẫn muốn theo chiều đó: chuyển **WATCHLIST** chờ giá về vùng đúng, HOẶC cân nhắc **đảo chiều** về pool chưa quét.
   - Vùng GIỮA (40–60%, quanh EQ) và đúng nửa range theo chiều lệnh → **CHO PHÉP vào lệnh**. Nếu ở vùng giữa thì ghi chú "vị trí range trung tính" và hạ 1 bậc confidence, KHÔNG chặn.
   - Bỏ luật cũ "bias và range mâu thuẫn thì cấm". Nếu mâu thuẫn → chỉ hạ confidence + ghi rõ rủi ro, vẫn được vào miễn không phạm vùng cực đoan ở trên.

   #### ▸ NGƯỠNG CỰC ĐOAN THAY ĐỔI THEO REGIME (đọc ADX H1 trong FACTS)
   > Lý do: cùng một mức "70% range" mang ý nghĩa TRÁI NGƯỢC nhau giữa hai trạng thái thị trường. Trong sideway, giá ở 70% là sắp quay đầu. Trong trend tăng mạnh, giá nằm lì ở 70–90% suốt nhiều giờ và mọi pullback nông đều được mua tiếp — chặn cứng ở 60% sẽ loại đúng những lệnh thuận trend tốt nhất.
   >
   > Chỉ được dùng con số **ADX(14) và regime lấy TỪ FACTS khung H1**. TUYỆT ĐỐI không tự phán "trend đang mạnh" bằng cảm nhận nến để nới ngưỡng — nếu FACTS ghi \`ADX: —\` thì coi như KHÔNG XÁC ĐỊNH và dùng ngưỡng mặc định.

   | Regime H1 (từ FACTS) | Chặn BUY khi giá ở | Chặn SELL khi giá ở | Ghi chú |
   |---|---|---|---|
   | **STRONG_TREND** (ADX ≥ 30) — lệnh THUẬN hướng ADX | > **75%** range | < **25%** range | Nới; ghi "trending regime, ADX X" |
   | **STRONG_TREND** — lệnh NGƯỢC hướng ADX | > 60% range | < 40% range | KHÔNG nới + hạ 1 bậc confidence (bắt dao rơi trong trend mạnh) |
   | **WEAK_TREND** (20 ≤ ADX < 30) hoặc **KHÔNG XÁC ĐỊNH** | > 60% range | < 40% range | Ngưỡng mặc định |
   | **RANGE** (ADX < 20) | > **55%** range | < **45%** range | Siết + hạ 1 bậc confidence: sideway, breakout dễ fail, mean-reversion thắng thế |

   - "Lệnh THUẬN hướng ADX" = chiều lệnh khớp với \`direction\` trong FACTS (+DI > −DI → BULLISH). BUY thuận khi direction BULLISH, SELL thuận khi direction BEARISH.
   - Ngưỡng sau khi điều chỉnh vẫn là **RÀO CỨNG**: phạm vào → WATCHLIST hoặc cân nhắc đảo chiều, không có ngoại lệ nào khác.
   - Bắt buộc ghi trong Summary regime đã dùng và ngưỡng tương ứng, ví dụ: "ADX H1 33.9 → STRONG_TREND thuận chiều, ngưỡng nới 75%; giá ở 68% range → PASS".

   ### ℹ️ CẢNH BÁO A — BIÊN EQ MỎNG (soft, chỉ hạ confidence)
   - \`distance_to_EQ = |entry dự kiến - EQ\` của dealing range H1\`, \`range_size = size của dealing range H1\`. Nếu \`distance_to_EQ < 10% × range_size\` → entry đang quanh EQ mỏng.
   - Xử lý: hạ tối đa 1 bậc confidence + ghi trong Summary "Premium/Discount MỎNG (X% range)". KHÔNG tự chuyển WATCHLIST, KHÔNG chặn lệnh (kể cả khi H4 NEUTRAL) — miễn qua HARD GATE 1.

4. **Draw on Liquidity (DOL)**:
   ### ℹ️ CẢNH BÁO B — DRAW ON LIQUIDITY (soft, chỉ hạ confidence)
   - Xác định pool thanh khoản CHƯA bị quét gần nhất ở MỖI phía (equal highs/lows, swing cũ) từ FACTS. Ghi rõ DOL đang nghiêng LÊN hay XUỐNG.
   - Nếu hướng lệnh đi **NGƯỢC** DOL gần nhất chưa quét → **hạ 1 bậc confidence** và ghi rõ rủi ro "đang đi ngược nam châm thanh khoản". KHÔNG còn tự động NO TRADE dù ngược dòng H4 — vẫn được vào lệnh nếu câu chuyện price action hợp lý và qua các HARD GATE.
   - Lưu ý: sellside vừa bị quét trong discount (hoặc buyside vừa bị quét trong premium) thường là dấu hiệu GOM HÀNG / ĐẢO CHIỀU — ưu tiên đọc theo hướng đảo chiều thay vì tiếp diễn ngay sau cú quét.

   ### ℹ️ CẢNH BÁO C — CHoCH TRONG IMPULSIVE LEG (soft, chỉ hạ confidence)
   - Nếu CHoCH M5 dùng làm confirmation đang nằm NGƯỢC hướng một impulsive leg vừa/đang chạy (định nghĩa ở trên), HOẶC dữ liệu M5 < 30 nến không đủ để loại trừ → coi đây là confirmation "yếu": **hạ 1 bậc confidence** và ghi chú "CHoCH nghi là correction trong impulsive leg / dữ liệu M5 mỏng".
   - Vẫn ĐƯỢC xuất ORDER (thường Medium/Low) nếu có thêm 1 dấu hiệu đồng thuận bất kỳ (nến displacement thứ 2, hoặc M15 cùng hướng, hoặc rejection rõ tại POI). Chỉ khi confirmation quá mỏng manh (một wick đơn lẻ, không displacement nào) → mới nên để WATCHLIST.

5. **M15 — POI**: tìm OB/FVG nằm trong vùng premium/discount phù hợp bias, đã có sweep + displacement. Ghi rõ vùng giá POI. Nếu POI trên ĐÚNG khung được chọn chưa được giá chạm tới đáy/đỉnh thật của nó → ghi rõ là CHƯA chạm, KHÔNG được mượn FVG khung khác để "cứu" entry.

6. **M5 — Confirmation**: chỉ xét KHI giá đã chạm POI. Cần CHoCH hoặc BOS nội bộ M5 + nến xác nhận (engulfing / rejection / displacement).

   ### 🎯 HAI CHẾ ĐỘ VÀO LỆNH (đọc kỹ trước khi kết luận WATCHLIST)
   > BỐI CẢNH: phân tích này chạy RỜI RẠC tại một thời điểm, không chạy liên tục mỗi nến. Nếu chỉ được xuất ORDER đúng lúc M5 vừa confirm tại POI thì cửa sổ đó rộng 1–2 nến — gần như luôn trượt, và mọi phân tích đều rơi về WATCHLIST dù setup hoàn toàn hợp lệ. Vì vậy có HAI chế độ, và bạn PHẢI xét chế độ B trước khi kết luận WATCHLIST:

   **A. LIVE CONFIRM** — giá ĐÃ ở trong/vừa phản ứng tại POI VÀ M5 đã có confirmation hợp lệ.
   → Xuất ORDER vào lệnh ngay (entry tại giá hiện tại hoặc mép POI gần nhất). Đây là chế độ mạnh nhất, confidence giữ nguyên.

   **B. LIMIT-CHỜ-POI** — giá CHƯA chạm POI, nhưng POI đã đủ chín để đặt lệnh chờ.
   → Được phép xuất ORDER dạng **lệnh chờ (limit)** tại POI, KHÔNG cần canh confirmation thời gian thực. Chỉ dùng khi thỏa **TẤT CẢ**:
   1. POI hợp lệ theo đúng định nghĩa (OB/FVG **fresh**, nằm sau một cú sweep + displacement), chưa bị mitigate.
   2. Entry dự kiến (giữa POI) qua **HARD GATE 1** — đo tại chính mức entry đó.
   3. Qua **HARD GATE 3** — RR tính trên SL/TP dự kiến tại POI.
   4. POI cách giá hiện tại **≤ 1× ATR H1** (ước từ FACTS). Xa hơn ngưỡng này thì giá còn phải đi qua quá nhiều cấu trúc trước khi tới nơi → giữ **WATCHLIST**, đừng đặt lệnh chờ.
   5. Có invalidation bằng **body close** rõ ràng để hủy lệnh chờ TRƯỚC khi khớp.
   → **Hạ 1 bậc confidence** so với LIVE CONFIRM (thiếu confirmation thật là khuyết điểm có thật, không được lờ đi). Ghi rõ trong ORDER: "LỆNH CHỜ — kích hoạt khi giá chạm [vùng]; HỦY nếu [body close ...] xảy ra trước khi khớp".

   **HARD GATE 2 giờ đọc là:** phải rơi vào chế độ A **hoặc** B. Không thỏa cả hai (POI chưa hình thành rõ, quá xa, hoặc chưa chốt được hướng) → WATCHLIST.

   > KỶ LUẬT: chế độ B là để KHÔNG BỎ LỠ setup đã chín, KHÔNG phải để rải lệnh chờ khắp nơi. Mỗi lần phân tích tối đa MỘT lệnh chờ, đúng một chiều. POI mơ hồ, chồng chéo nhiều vùng, hoặc phải "chọn đại" một mức → đó là WATCHLIST, không phải limit.

## CÁCH ĐẶT SL / TP (bắt buộc)

- **SL**: đặt phía bên kia vùng thanh khoản gần nhất + một khoảng đệm theo biến động hiện tại (tối thiểu **1× ATR M5** ngoài OB/FVG, ước lượng từ FACTS). TUYỆT ĐỐI không đặt SL sát ngay swing high/low rõ ràng (đó là mục tiêu bị quét), và không đặt đệm < 1× ATR M5 (wick thường nuốt gọn → bị stop-hunt oan).
- **Đồng bộ logic vô hiệu hóa**: nếu invalidation định nghĩa bằng *body close*, thì SL cứng phải đủ rộng để sống sót một wick bình thường. Nếu nới SL ra cho khớp logic body-close mà RR rớt → đó là tín hiệu LỆNH KHÔNG ĐÁNG VÀO, không phải lý do siết SL lại.
- **TP**: xác định TRƯỚC theo mục tiêu thanh khoản thực tế (đỉnh/đáy cũ, equal highs/lows, FVG đối diện, POI khung lớn). RR được TÍNH RA TỪ các mức TP này, KHÔNG được dịch TP để ép cho ra RR đẹp.

  ### 🎯 THANG TP HAI TẦNG — "TP chốt non" và "TP1 chính" (đọc trước Cổng 3)
  > VẤN ĐỀ CŨ: luật cũ bắt LÙI TP về trước MỌI rào cản nghịch hướng rồi đo RR trên chính mức đã lùi. Hệ quả: chỉ cần có một FVG/OB nghịch nằm gần là RR bị bóp xuống dưới ngưỡng và lệnh bị loại, dù nhịp giá phía sau rào cản còn rất rộng. Rào cản gần là lý do để **chốt bớt**, không phải lý do để **bỏ lệnh**.

  Mỗi lệnh khai báo hai mức chốt lời:
  - **TP chốt non** (tùy chọn): mức thanh khoản gần nhất, hoặc mép rào cản nghịch hướng đầu tiên. Chốt **40–50%** khối lượng tại đây rồi **dời SL về breakeven**. Mức này **KHÔNG bị HARD GATE 3 ràng buộc** — RR của nó được phép < 1:${config.minRr}, ghi ra để tham khảo.
  - **TP1 chính**: mục tiêu thanh khoản thật của lệnh (đỉnh/đáy cũ, equal highs/lows, POI khung lớn đối diện) — nơi phần khối lượng còn lại thoát. **HARD GATE 3 đo RR trên mức này.**

  ### ⛔ CỔNG 3 — RÀO CẢN NGHỊCH HƯỚNG (HARD GATE)
  - Xác định mọi POI nghịch hướng nằm giữa entry và TP1 chính (SELL: bullish OB/FVG bên dưới; BUY: bearish OB/FVG bên trên). Với mỗi rào cản, phân loại:
    - **RÀO CẢN CỨNG** — POI **fresh, chưa từng bị giá xuyên qua bằng body close**, thuộc khung **≥ M15**, VÀ **đủ dày** (xem tiêu chí độ dày bên dưới). → TP1 chính **PHẢI lùi về trước** rào cản này. Không đặt mục tiêu xuyên qua một vùng còn nguyên vẹn ở khung lớn.
    - **RÀO CẢN MỀM** — POI đã [mitigated], đã bị body close xuyên qua ít nhất một lần, chỉ thuộc khung M5, **hoặc quá mỏng**. → **KHÔNG chặn TP1 chính**. Xử lý: đặt **TP chốt non** ngay trước nó, TP1 chính đi tiếp tới mục tiêu thanh khoản kế tiếp phía sau. Ghi rõ: "rào cản [vùng] xếp loại MỀM vì [lý do] → chốt non tại [giá], TP1 chính [giá]".
  - **TIÊU CHÍ ĐỘ DÀY (bắt buộc tính, kể cả khi rào cản còn fresh)**: đo bề rộng vùng = |mép trên − mép dưới|, chia cho **ATR H1** (lấy từ FACTS). Nếu **bề rộng < 0.25× ATR H1** → rào cản xếp **MỀM** dù fresh và dù thuộc khung ≥M15.
    > LÝ DO: một khe hở vài phần mười ATR không phải bức tường — nó là chỗ giá đi xuyên trong một nến. Để nó chặn TP1 thì mọi nhịp scalp có FVG mỏng nằm giữa đường đều bị bóp RR xuống dưới ngưỡng và bị loại oan. Phần bảo vệ nằm ở **TP chốt non**: vẫn chốt 40–50% + dời BE ngay trước rào cản mỏng, phần còn lại mới chạy tiếp.
    - Ghi rõ phép tính trong SUMMARY: "rào cản [vùng] dày [X] = [Y]× ATR H1 → CỨNG/MỀM".
  - Không có rào cản nào giữa entry và TP1 → không cần TP chốt non.
  - TUYỆT ĐỐI không dịch TP1 chính ra xa chỉ để ép RR đạt ngưỡng. TP1 phải là một mức thanh khoản CÓ THẬT trong FACTS — nêu đích danh mức đó (giá + nó là gì). Không gọi được tên mức → mức đó không tồn tại, chọn lại.
  - Cảnh báo thêm: nếu TP1 chính vẫn còn cao hơn swing low cũ (với SELL) / thấp hơn swing high cũ (với BUY) → lệnh không kỳ vọng phá cấu trúc, chỉ bắt một nhịp nhỏ → edge yếu, ghi rõ.

  ### ℹ️ CẢNH BÁO D — POOL THANH KHOẢN KẸP GIỮA ENTRY VÀ SL (soft — điều chỉnh SL, không tự chặn)
  > NGUYÊN TẮC: pool xét ở ĐÚNG khung mà SL của phần lệnh đó đang neo vào. SL neo M5 →
  > soi pool M5/M15; SL neo H1 → soi pool H1. Không trộn khung.
  - Quét FACTS: có equal-high/low hoặc swing point CHƯA bị quét nào nằm GIỮA entry và SL
    (theo đúng hướng lệnh) không?
  - Nếu CÓ pool kẹp giữa → **ưu tiên dời SL ra SAU pool** đó + đệm ATR như thường lệ, rồi
    kiểm lại RR (HARD GATE 3). Nếu dời SL mà RR vẫn đạt → vào bình thường.
  - Nếu KHÔNG muốn/không thể dời SL (ví dụ dời làm RR rớt dưới ngưỡng): được phép GIỮ SL
    ban đầu và **vào lệnh với confidence hạ 1 bậc**, ghi rõ rủi ro "có pool [giá] kẹp trước
    SL, chấp nhận risk stop-hunt". CHỈ khi pool kẹp quá sát entry (khả năng bị quét gần như
    chắc chắn trước khi tới TP) mới nên chuyển WATCHLIST.

## CƠ CHẾ 2 PHẦN LỆNH — SCALP + POSITION (TÙY CHỌN, không bắt buộc)

  ### ▸ TÁCH LỆNH THEO ĐỘ MẠNH SETUP (tùy chọn — mặc định 1 phần SCALP)
  Sau khi setup đã qua 3 HARD GATE và M5 confirm, MẶC ĐỊNH vào **1 phần SCALP**. Chỉ nâng
  lên 2 phần khi setup thực sự mạnh — đây là lựa chọn tối ưu hóa, KHÔNG phải điều kiện chặn:

  **NÊN chia 2 phần khi đủ CẢ HAI:**
  1. Lệnh THUẬN dòng H4, VÀ
  2. Vị trí range SÂU: \`distance_to_EQ ≥ 20% × range_size\` (discount sâu / premium sâu thật sự, không phải EQ mỏng).

  **NẾU ĐỦ → chia 2 phần, cùng entry, khác quản lý:**

  - **Phần SCALP:**
    - SL: neo cấu trúc M5 + đệm 1× ATR M5 (như cũ).
    - TP: mục tiêu thanh khoản M15 gần nhất (TP1). Chốt toàn bộ phần này tại đây.
    - Vai trò: bảo toàn vốn, khóa lời nhanh, biến lệnh về trạng thái ít/không rủi ro.
  - **Phần POSITION:**
    - SL: neo đáy swing H1 gần nhất (với BUY) / đỉnh swing H1 gần nhất (với SELL) + đệm 1× ATR H1. RỘNG hơn SCALP — chịu được noise M5.
    - TP: mục tiêu thanh khoản H1/H4 xa (equal highs/lows H1, POI H4 đối diện), đã lùi khỏi vùng nghịch.
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
    hạ size, cân nhắc KHÔNG chia 2 phần dù đủ điều kiện định tính. Ghi rõ lý do:
    "SL H1 quá rộng so với SL M5, tỷ lệ risk lệch, giữ 1 phần SCALP".

  **NẾU KHÔNG ĐỦ (ngược dòng H4, HOẶC EQ mỏng/discount nông, HOẶC tỷ lệ risk lệch quá xa) → chỉ 1 phần SCALP:**
  - Toàn bộ size vào 1 lệnh SCALP, SL neo M5, TP mục tiêu M15. KHÔNG mở phần POSITION.
  - Lý do: setup không đủ nền tảng để gánh SL rộng của phần hold dài. Thà chốt gần, ăn chắc.

  **CẢNH BÁO KỶ LUẬT (ghi trong output khi chia 2 phần):**
  - Cơ chế này CHỈ có lợi nếu tuân thủ nghiêm việc dời breakeven sau khi SCALP chốt. Nếu không dời, một lệnh POSITION thua (SL H1 rộng) có thể xóa nhiều lệnh SCALP thắng.
  - Cơ chế này KHÔNG giúp bắt được các leg dựng đứng không hồi. Giá đi thẳng không về POI → vẫn lỡ, và đó là điều chấp nhận, không phải lỗi.

## BA HARD GATE — CHỈ 3 ĐIỀU NÀY LÀ RÀO CỨNG (thiếu 1 trong 3 → KHÔNG xuất ORDER)
Mọi thứ khác (vị trí EQ mỏng, DOL, CHoCH-impulsive, pool kẹp, kill zone, thuận/ngược dòng)
chỉ ĐIỀU CHỈNH CONFIDENCE. Chỉ 3 rào dưới đây mới quyết định có được ra ORDER hay không:

- **HARD GATE 1 — Vị trí không cực đoan** (đo trên **DEALING RANGE** trong FACTS, KHÔNG phải range
  mở rộng 80 nến): không BUY ở PREMIUM sâu, không SELL ở DISCOUNT sâu —
  **đo tại GIÁ VÀO LỆNH DỰ KIẾN, không phải giá hiện tại**. Ngưỡng "sâu" THAY ĐỔI THEO REGIME
  ADX H1 (mặc định 60/40; STRONG_TREND thuận chiều → 75/25; RANGE → 55/45 — xem bảng ở bước 3).
  Phạm vào → WATCHLIST hoặc cân nhắc đảo chiều.
- **HARD GATE 2 — Có trigger thật HOẶC POI đã chín để đặt chờ**: thỏa **một trong hai** chế độ —
  (A) LIVE CONFIRM: giá ĐÃ chạm POI (M15/H1) VÀ M5 có ít nhất một confirmation cụ thể
  (CHoCH/BOS nội bộ M5, engulfing, rejection, displacement); hoặc (B) LIMIT-CHỜ-POI: POI fresh
  hợp lệ, entry dự kiến qua Gate 1, qua Gate 3, cách giá hiện tại ≤ 1× ATR H1, có invalidation
  body-close rõ ràng → đặt lệnh chờ, hạ 1 bậc confidence. Không thỏa chế độ nào → WATCHLIST.
- **HARD GATE 3 — RR tối thiểu trên TP1 CHÍNH**: RR đo trên **TP1 chính** (mục tiêu thanh khoản
  thật, chỉ lùi khi gặp RÀO CẢN CỨNG theo Cổng 3), phải ≥ 1:${config.minRr}. **KHÔNG đo trên
  "TP chốt non"** — mức chốt non được phép RR thấp. TUYỆT ĐỐI không dịch TP1 ra xa để ép RR;
  TP1 phải là mức thanh khoản có thật, gọi được tên. RR TP1 chính < 1:${config.minRr} →
  NO TRADE, bất kể mọi yếu tố khác đẹp đến đâu.

### ▸ TỰ KIỂM TRƯỚC KHI XUẤT ORDER (checklist nhanh)
1. HARD GATE 1: đọc **DEALING RANGE H1** (leg đang chạy) làm mẫu số → đọc regime ADX H1 từ FACTS → chốt ngưỡng cực đoan (75/25, 60/40 hay 55/45) → **mức entry dự kiến** (không phải giá hiện tại) có phạm không? → nếu phạm, WATCHLIST.
2. HARD GATE 2: đã chạm POI + có confirmation M5 (chế độ A) chưa? → nếu chưa, **BẮT BUỘC xét tiếp chế độ B (LIMIT-CHỜ-POI)** trước khi kết luận. Cả A lẫn B đều không thỏa → WATCHLIST.
3. HARD GATE 3: RR **TP1 chính** (mục tiêu thanh khoản thật, chỉ lùi khi gặp RÀO CẢN CỨNG) còn ≥ 1:${config.minRr}? → nếu không, NO TRADE. Không dùng RR của "TP chốt non" để chấm cổng này.
4. Cả 3 PASS → xuất ORDER. Tổng hợp mọi CẢNH BÁO (A–D, kill zone, thuận/ngược dòng H4, spread mỏng) để chọn confidence và % size — KHÔNG dùng chúng để hủy lệnh.

  ### ▸ GHI CHÚ SPREAD (khuyến nghị, không phải gate)
  - XAU/USD có spread/slippage thực. Với SL scalp ngắn, ưu tiên lệnh có RR lý thuyết dư dả
    (không sát 1:${config.minRr} sát nút) để buffer ~0.3 USD/bên không xóa hết edge.
  - Nếu RR chỉ vừa đúng 1:${config.minRr} và SL rất ngắn (< ~3 USD) → ghi chú "RR mỏng so với
    spread" và hạ 1 bậc confidence. KHÔNG tự động loại lệnh vì lý do này.

## TIÊU CHÍ CONFIDENCE (chỉ ảnh hưởng độ tin cậy/size, KHÔNG chặn lệnh)
Khởi điểm mọi lệnh đã qua 3 HARD GATE = **Medium**. Cộng/trừ theo các yếu tố:
- **Chế độ LIMIT-CHỜ-POI luôn hạ 1 bậc** so với mức tính được (thiếu confirmation M5 thật). Áp dụng SAU khi cộng/trừ các yếu tố dưới đây → hệ quả: lệnh chờ tối đa chỉ đạt Medium.
- **Lên High**: chế độ LIVE CONFIRM + THUẬN dòng H4 + cùng chiều DOL + trong kill zone + RR TP1 chính ≥ 1:${highRr} + biên EQ đủ dày (không kích Cảnh báo A) + CHoCH không nghi impulsive (không kích Cảnh báo C) + dữ liệu M5 đủ 30 nến + không có pool kẹp SL.
- **Giữ Medium**: qua 3 HARD GATE nhưng dính 1–2 cảnh báo (ngoài kill zone / ngược dòng H4 / ngược DOL / EQ mỏng / CHoCH nghi impulsive / M5 < 30 nến / pool kẹp đã chấp nhận rủi ro / RR trong 1:${config.minRr}–1:${highRr}).
- **Low**: qua 3 HARD GATE nhưng dính ≥ 3 cảnh báo cùng lúc → vẫn được vào ORDER nhưng ghi rõ "confidence thấp, giảm size mạnh". KHÔNG tự hạ Low thành NO TRADE — chỉ NO TRADE khi phạm HARD GATE.

## ĐỊNH DẠNG OUTPUT

### Trường hợp 1 — CHỈ dùng khi KHÔNG thỏa cả chế độ A (live confirm) LẪN chế độ B (limit-chờ-POI):
> Trước khi viết phần này, tự hỏi lại: POI có fresh và hợp lệ không? Entry dự kiến có qua Gate 1 không? RR TP1 chính có đạt không? Có cách giá hiện tại ≤ 1× ATR H1 không? ĐỦ CẢ BỐN → đây phải là một **ORDER lệnh chờ** (Trường hợp 3, chế độ LIMIT-CHỜ-POI), KHÔNG phải WATCHLIST. Chỉ viết WATCHLIST khi POI còn xa/mơ hồ, hướng chưa chốt, hoặc RR dự kiến không đạt.

Viết phần này theo kiểu KỊCH BẢN HÀNH ĐỘNG, dễ đọc: "giá về vùng nào → NẾU thấy nến/hành động này thì làm gì, NẾU thấy dấu hiệu kia thì làm gì". KHÔNG viết kiểu liệt kê "điều kiện còn thiếu" khô khan. Mỗi nhánh NẾU phải mô tả nến/hành động cụ thể (sweep mức nào, rejection/engulfing, CHoCH/BOS, body close qua mức nào) rồi kèm hành động rõ ràng (VÀO LỆNH / BỎ / ĐỨNG NGOÀI).

#### WATCHLIST (CHƯA VÀO LỆNH)
- Hướng dự kiến: BUY / SELL
- POI cần chờ: [vùng giá]
- Tình trạng hiện tại: [1 câu — giá đang ở đâu so với POI, còn thiếu điều gì để kích hoạt]

**▸ KỊCH BẢN CHÍNH — [tên ngắn, vd: Mua tại POI khi M5 xác nhận]**
- Chờ giá về vùng: [vùng giá POI]
- ✅ NẾU thấy [nến/hành động xác nhận cụ thể — vd: quét thủng [mức] rồi bật lên với nến rejection/engulfing tăng + CHoCH/BOS nội bộ M5 hướng lên] → VÀO LỆNH [BUY/SELL]:
  - Entry: [vùng giá tại POI]
  - SL: [giá] — neo cấu trúc M5 sau POI + đệm ≥1× ATR M5 — cách [X] USD
  - TP chốt non: [giá] — rào cản/thanh khoản gần nhất, chốt 40–50% rồi dời SL breakeven — RR [X:1] (không tính Gate 3)
  - TP1: [giá] — mục tiêu thanh khoản chính — RR dự kiến [X:1]
- ❌ NẾU thấy [dấu hiệu phủ định — vd: body close dưới [mức] POI, không bật lại] → BỎ setup, POI đã hỏng, chờ vùng khác.
- ⏸ NẾU giá vào POI nhưng nến lộn xộn / chưa có confirmation hợp lệ → ĐỨNG NGOÀI, tiếp tục canh.

**▸ KỊCH BẢN PHỤ (chỉ ghi nếu có) — [tên ngắn, vd: Giá phá cấu trúc, đổi kịch bản]**
- 🔄 NẾU [điều kiện đổi hướng — vd: nến H1 body close trên [mức] trần range] → range được vẽ lại; chờ giá retest vùng vừa phá + confirmation M5 để vào theo hướng mới.

- Lưu ý: đây là các mức DỰ KIẾN tại POI (đã biết hướng) — sẽ chốt chính xác khi M5 confirm; chưa đặt lệnh cho đến khi đủ điều kiện. Nếu RR dự kiến < 1:${config.minRr} thì ghi rõ setup sẽ bị loại khi tới POI.
- Vì sao KHÔNG đặt lệnh chờ (BẮT BUỘC ghi 1 dòng): [điều kiện nào của chế độ B không thỏa — POI xa hơn 1× ATR H1 / POI chưa fresh / entry dự kiến phạm Gate 1 / RR TP1 chính không đạt / hướng chưa chốt].

### Trường hợp 2 — Không có cơ hội nào:
- Best opportunity: NO TRADE
- Patience level: No trade
- Lý do: [1 câu nêu rõ thiếu yếu tố nào / bị cổng nào chặn]

### Trường hợp 3 — Setup HỢP LỆ (qua đủ 3 HARD GATE; chế độ A = M5 đã confirm tại POI, chế độ B = POI đã chín để đặt lệnh chờ):
#### [BUY ORDER / SELL ORDER]
- **Chế độ vào lệnh: LIVE CONFIRM / LIMIT-CHỜ-POI** — nếu LIMIT ghi rõ "LỆNH CHỜ, kích hoạt khi giá chạm [vùng]"
- Nhãn dòng H4: THUẬN dòng / NGƯỢC dòng (giảm size nếu ngược)
- Cấu trúc lệnh: **1 PHẦN (chỉ SCALP)** / **2 PHẦN (SCALP + POSITION)** — tùy chọn theo độ mạnh setup
- Entry zone: [giá] (chung cho cả 2 phần nếu chia) — nếu LIMIT: cách giá hiện tại [X] USD (= [Y]× ATR H1, phải ≤ 1×)
- Điều kiện kích hoạt (đã thỏa — HARD GATE 2): [chế độ A: POI nào + confirmation M5 nào | chế độ B: POI nào + vì sao đã chín để đặt chờ]
- Vị trí **trong dealing range** tại entry dự kiến: [premium/discount/EQ, X% leg] (giá hiện tại [Y]% leg) — dealing range dùng: [low–high, size] — vs ngưỡng regime [75/25 | 60/40 | 55/45] — HARD GATE 1; Cảnh báo A nếu EQ mỏng
- Regime H1: ADX [X] → [STRONG_TREND / WEAK_TREND / RANGE / KHÔNG XÁC ĐỊNH], lệnh thuận/ngược hướng ADX
- Draw on Liquidity: [lên/xuống] — cùng chiều / ngược (Cảnh báo B nếu ngược)
- Pool kẹp giữa entry-SL_SCALP (M5/M15): Không / Có → đã dời SL / chấp nhận rủi ro (Cảnh báo D)
- Rào cản nghịch hướng (Cổng 3): [vùng giá] — dày [X] = [Y]× ATR H1 — xếp loại **CỨNG / MỀM / không có** vì [lý do: fresh chưa bị body close xuyên & khung ≥M15 & dày ≥0.25× ATR H1 → CỨNG; đã mitigated / đã bị xuyên / chỉ khung M5 / mỏng <0.25× ATR H1 → MỀM]

**▸ PHẦN SCALP:**
- SL: [giá] — neo cấu trúc M5 + đệm ≥1× ATR M5 — cách [X] USD
- TP chốt non (nếu có rào cản MỀM hoặc thanh khoản gần): [giá] — chốt 40–50% rồi dời SL breakeven — RR [X:1] — KHÔNG tính HARD GATE 3
- TP1: [giá] — mục tiêu thanh khoản chính (gọi tên đích danh mức đó là gì) — RR [X:1] — **HARD GATE 3**

**▸ PHẦN POSITION** (chỉ khi chia 2 phần — tùy chọn):
- Pool kẹp giữa entry-SL_POSITION (H1): Không / Có → đã dời SL / chấp nhận rủi ro (Cảnh báo D)
- SL: [giá] — neo swing H1 + đệm 1× ATR H1 — cách [X] USD (rộng hơn SCALP)
- TP1: [giá] — mục tiêu thanh khoản H1 (đã lùi khỏi vùng nghịch) — RR [X:1]
- TP2: [giá] — mục tiêu thanh khoản H1/H4 xa — RR [X:1]
- Size: SCALP [X]% / POSITION [Y]% — risk_USD SCALP [A] vs POSITION [B], tỷ lệ [C]:1 (theo công thức cân size)
- Quản lý: dời SL về breakeven ngay khi phần SCALP chạm TP

- Confidence: High / Medium / Low
- Hủy lệnh nếu: [invalidation cụ thể bằng body close — ghi riêng cho SCALP (M5) và POSITION (H1) nếu chia 2 phần]

---

### SUMMARY
- Chế độ vào lệnh: LIVE CONFIRM / LIMIT-CHỜ-POI / N/A (watchlist–no trade)
- Context H4: BULLISH / BEARISH / NEUTRAL (lệnh thuận hay ngược dòng)
- Bias H1: BULLISH / BEARISH / NEUTRAL
- Dealing range dùng làm mẫu số: [low–high, size, = N× ATR] (hoặc "range mở rộng" + lý do fallback)
- Premium/Discount: **tại entry dự kiến [X]% leg** (giá hiện tại [Y]% leg), biên cách EQ [Z% leg] vs ngưỡng regime [W%] — **HARD GATE 1: PASS/FAIL** (Cảnh báo A nếu EQ mỏng)
- Regime H1: ADX [X] → [STRONG_TREND / WEAK_TREND / RANGE / KHÔNG XÁC ĐỊNH] — ngưỡng cực đoan đã dùng
- Draw on Liquidity: lên / xuống — cùng chiều / ngược (Cảnh báo B)
- Dữ liệu M5: đủ/thiếu 30 nến — Impulsive leg: Có/Không — CHoCH nghi correction? (Cảnh báo C)
- Liquidity sweep tại POI: Có / Chưa
- M5 confirmation: Có / Chưa / N/A (chế độ LIMIT) — **HARD GATE 2: PASS/FAIL** (ghi rõ thỏa qua chế độ A hay B)
- Khoảng cách entry → giá hiện tại: [X] USD = [Y]× ATR H1 (chỉ ghi khi chế độ LIMIT; phải ≤ 1×)
- Rào cản nghịch hướng: [vùng] — dày [Y]× ATR H1 — CỨNG / MỀM / không có → TP chốt non [giá] (RR [X:1], không tính cổng)
- TP1 chính — RR: [X:1] — **HARD GATE 3: PASS/FAIL** (≥1:${config.minRr})
- Pool kẹp giữa entry-SL (M5/M15, và H1 nếu 2 phần): Không / Có → xử lý (Cảnh báo D)
- Cấu trúc lệnh: 1 phần (SCALP) / 2 phần (SCALP+POSITION) — tùy chọn, chia 2 khi thuận H4 + range sâu ≥20% + tỷ lệ risk hai phần ≤4 lần
- Trong kill zone: Có / Không (đã xác định đúng giai đoạn DST)
- Cảnh báo đang kích hoạt: [liệt kê A/B/C/D/kill zone/ngược dòng nếu có] → confidence [mức]
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
QUAN TRỌNG — code đã TÍNH SẴN "ICT/SMC FACTS" cho mọi khung: bias, ATR, **ADX/DMI (regime)**, range/fib (premium/discount/equilibrium), swing highs/lows, FVG, order block, equal highs/lows (liquidity). DÙNG TRỰC TIẾP các con số này, KHÔNG tính lại — nhiệm vụ của bạn là DIỄN GIẢI và ra quyết định, không phải bấm máy.
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
   - Lý lẽ "trend mạnh nên retrace gần nhất vẫn hợp lệ" **KHÔNG phải lý do** để vượt cổng này. Hợp lệ cấu trúc ≠ đúng vị trí. SHORT ở discount = bán tại điểm đến chứ không phải điểm xuất phát → từ chối. Chỉ số ADX cao cũng KHÔNG phải ngoại lệ — ADX chỉ điều chỉnh confidence (xem Cảnh báo REGIME), không mở cổng.

   ### ℹ️ CẢNH BÁO REGIME — ADX ${tfBias} (soft, chỉ điều chỉnh confidence)
   Dùng \`ADX(14)\` và \`regime\` lấy TỪ FACTS khung ${tfBias}; nếu FACTS ghi \`ADX: —\` thì coi như KHÔNG XÁC ĐỊNH và bỏ qua mục này. Không tự phán regime bằng cảm nhận nến.
   - **STRONG_TREND (ADX ≥ 30)**, lệnh THUẬN hướng ADX (\`direction\` khớp chiều lệnh) → **+1 bậc confidence**, tối đa High. Đây là điều kiện thuận lợi nhất cho lệnh tiếp diễn.
   - **STRONG_TREND**, lệnh NGƯỢC hướng ADX → **−1 bậc confidence** + ghi rõ "bắt đảo chiều trong trend mạnh". Vẫn được vào nếu qua đủ 4 cổng.
   - **RANGE (ADX < 20)** → **−1 bậc confidence** với MỌI lệnh tiếp diễn/breakout (sideway, breakout tỉ lệ fail cao); các setup mean-reversion từ biên range về EQ thì KHÔNG bị trừ.
   - **WEAK_TREND (20 ≤ ADX < 30)** hoặc KHÔNG XÁC ĐỊNH → không điều chỉnh.

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
- POI cần chờ: [vùng giá] (cách giá hiện tại [X]%)
- Entry zone dự kiến: [vùng giá tại POI — nơi sẽ vào lệnh khi ${tfEntry} confirm hoặc đặt limit]
- SL dự kiến: [giá] — vùng liquidity sau POI + đệm ≥1.5× ATR ${tfAtr} — cách [X]% (= [Y]× ATR ${tfAtr})
- TP dự kiến: [giá] — mục tiêu thanh khoản gần nhất (đã lùi khỏi vùng nghịch) — RR dự kiến [X:1]
- Điều kiện kích hoạt còn thiếu: [cụ thể — chờ giá về POI đúng nửa range / chờ ${tfEntry} confirm gì / chờ quét pool thanh khoản nào]
- Lưu ý: đây là các mức DỰ KIẾN tính trước tại POI (đã biết hướng) — sẽ chốt lại khi ${tfEntry} confirm; chưa đặt lệnh cho đến khi đủ điều kiện. Nếu RR dự kiến < 1:${config.minRr} thì ghi rõ setup sẽ bị loại khi tới POI.

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

  // ADX: regime filter cho luật vị trí range. null = khung không đủ nến để ADX hội tụ
  // → ghi rõ "không đủ nến" thay vì bỏ trống, để model không đoán bừa regime.
  const adxLine = a.adx
    ? `ADX(14): ${a.adx.value} → ${a.adx.regime}`
      + ` (+DI ${a.adx.plusDi} / −DI ${a.adx.minusDi} → nghiêng ${a.adx.direction})`
    : 'ADX(14): — (không đủ nến để tính, coi như regime KHÔNG XÁC ĐỊNH)';

  // DEALING RANGE = mẫu số CHÍNH THỨC của HARD GATE 1. Range mở rộng ở trên chỉ là
  // bối cảnh — đo entry scalp bằng nó sẽ chặn nhầm mọi pullback nông trong trend.
  const leg = a.activeLeg;
  const legLine = leg
    ? `▶ DEALING RANGE (leg đang chạy — MẪU SỐ CHÍNH THỨC của Cổng 1):`
      + ` ${leg.low}–${leg.high} | hướng ${leg.direction} | chân leg ${leg.from} (${leg.fromTime})`
      + ` | Size: ${leg.size} (= ${leg.sizeAtr}× ATR) | EQ(50%): ${leg.equilibrium}`
      + ` | Giá hiện tại ở ${leg.currentPct}% leg`
      + (leg.sizeAtr < 1 ? ' | ⚠️ leg < 1× ATR = nhiễu, dùng range mở rộng thay thế' : '')
    : '▶ DEALING RANGE (leg đang chạy): — (chưa đủ swing đối nghịch → dùng range mở rộng thay thế)';

  return [
    `Bias: ${a.bias} | ATR: ${a.atr} | Giá: ${a.lastPrice}`,
    adxLine,
    `Cấu trúc gần nhất (BOS/CHoCH): ${fmtStruct(a.recentStructure)}`,
    `Range mở rộng (${a.candleCount} nến gần nhất — chỉ để tham chiếu bối cảnh): ${r.rangeLow}–${r.rangeHigh} | Size: ${rangeSize} | EQ(50%): ${r.equilibrium} | Vùng: ${r.zone}`,
    `Fib (range mở rộng): 0.236=${r.fib['0.236']} 0.382=${r.fib['0.382']} 0.618=${r.fib['0.618']} 0.786=${r.fib['0.786']}`,
    legLine,
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

/**
 * Block carry-forward — nhét tín hiệu lần trước vào prompt theo hướng ĐÁNH GIÁ ĐỘC LẬP,
 * KHÔNG phải gợi ý tiếp tục. Phân nhánh theo kind:
 *  - watchlist → KIỂM CHỨNG setup (đã kích hoạt / vô hiệu / vẫn chờ).
 *  - order     → QUẢN LÝ lệnh (giữ / dời SL / thoát / đã đóng).
 * Framing anti-anchoring: trao toàn quyền bác bỏ, tách "quản lý lệnh cũ" khỏi "vào lệnh mới".
 */
function buildPendingSetupBlock(p: PendingSetup): string {
  return p.kind === 'order' ? buildPreviousOrderBlock(p) : buildPreviousWatchlistBlock(p);
}

function buildPreviousWatchlistBlock(p: PendingSetup): string {
  const dir = p.direction === 'BUY' ? 'BUY (LONG)' : 'SELL (SHORT)';
  const priceThen = p.priceThen != null ? `${p.priceThen}` : 'không rõ';
  return [
    `=== SETUP ĐANG CHỜ KIỂM CHỨNG (từ lần phân tích GẦN NHẤT, cách đây ${p.ageMinutes} phút — lúc ${p.analyzedAtVn} giờ VN) ===`,
    `Lần trước hệ thống KHÔNG vào lệnh, chỉ để WATCHLIST với hướng dự kiến ${dir}. Giá lúc đó: ${priceThen}.`,
    `Nội dung watchlist lần trước:`,
    p.rawText,
    ``,
    `⚠️ NHIỆM VỤ với setup trên — làm ĐỘC LẬP dựa trên FACTS/nến MỚI, KHÔNG mặc định tiếp tục hướng cũ:`,
    `1. Xác định setup này HIỆN ở trạng thái nào:`,
    `   • ĐÃ KÍCH HOẠT — giá đã về POI + có confirmation hợp lệ → đưa vào quy trình bình thường (được xuất ORDER nếu qua đủ các cổng/HARD GATE).`,
    `   • ĐÃ VÔ HIỆU — body close đã phá POI, cấu trúc đã đổi, hoặc POI bị invert → BỎ hẳn hướng cũ, phân tích lại từ đầu như chưa từng có watchlist.`,
    `   • VẪN CHỜ — POI còn nguyên, giá chưa chạm → giữ WATCHLIST, cập nhật lại Entry/SL/TP dự kiến theo giá mới.`,
    `2. Bạn được TOÀN QUYỀN bác bỏ hướng dự kiến cũ nếu FACTS mới mâu thuẫn. TUYỆT ĐỐI KHÔNG vào lệnh hay giữ WATCHLIST chỉ vì lần trước đã canh chiều đó — hướng cũ chỉ là thông tin tham chiếu, không phải kết luận.`,
    `3. Thêm 1 dòng vào SUMMARY: "Setup lần trước: [ĐÃ KÍCH HOẠT / ĐÃ VÔ HIỆU / VẪN CHỜ] — [lý do ngắn]".`,
  ].join('\n');
}

function buildPreviousOrderBlock(p: PendingSetup): string {
  const dir = p.direction === 'BUY' ? 'BUY (LONG)' : 'SELL (SHORT)';
  const priceThen = p.priceThen != null ? `${p.priceThen}` : 'không rõ';
  const num = (x: number | null | undefined) => (x != null ? `${x}` : '—');
  return [
    `=== LỆNH LẦN TRƯỚC — ĐÁNH GIÁ GIỮ HAY THOÁT (từ lần phân tích GẦN NHẤT, cách đây ${p.ageMinutes} phút — lúc ${p.analyzedAtVn} giờ VN) ===`,
    `Lần trước hệ thống đã ra LỆNH ${dir}. Giá lúc đó: ${priceThen}.`,
    `Thông số lệnh: Entry ${num(p.entry)} | SL ${num(p.stopLoss)} | TP ${num(p.takeProfit)} | RR ${p.riskReward != null ? `1:${p.riskReward}` : '—'}.`,
    `Chi tiết lệnh lần trước (gồm điều kiện "Hủy lệnh nếu"):`,
    p.rawText,
    ``,
    `⚠️ NHIỆM VỤ với lệnh trên — làm ĐỘC LẬP trên FACTS/nến MỚI, đánh giá KHÁCH QUAN (đừng thiên vị giữ lệnh vì sunk cost):`,
    `1. Xác định trạng thái lệnh hiện tại:`,
    `   • CHƯA KHỚP ENTRY — giá chưa chạm entry zone → lệnh còn hiệu lực (chờ khớp) hay đã lỡ/vô hiệu (giá đã bỏ đi không quay lại)?`,
    `   • ĐANG CHẠY — giá đã qua entry, chưa chạm SL/TP → đọc nến (nhóm C H1: nến thân lớn phá cấu trúc / rejection tại TP) để quyết định.`,
    `   • ĐÃ ĐÓNG — giá đã chạm TP (thắng) / SL (thua) / thỏa "Hủy lệnh nếu" bằng body close → lệnh kết thúc.`,
    `2. KHUYẾN NGHỊ QUẢN LÝ (chọn 1, nêu rõ lý do bằng price action):`,
    `   • GIỮ NGUYÊN — thesis còn nguyên, chưa có tín hiệu thoát.`,
    `   • DỜI SL VỀ BREAKEVEN / SIẾT SL — đã có lời hoặc động lượng cạn dần.`,
    `   • THOÁT SỚM — cấu trúc đã gãy / rejection mạnh dù chưa chạm SL.`,
    `   • ĐÃ ĐÓNG — nêu rõ đóng tại TP / SL / invalidation nào.`,
    `3. QUAN TRỌNG: "GIỮ lệnh đang mở" KHÁC "vào lệnh mới". Ví dụ giá lên premium sâu có thể CHẶN một lệnh BUY mới nhưng KHÔNG có nghĩa phải thoát lệnh BUY đang lời — đánh giá hai việc RIÊNG BIỆT.`,
    `4. Đặt ở ĐẦU output một block quản lý:`,
    `   #### QUẢN LÝ LỆNH TRƯỚC`,
    `   - Trạng thái: [CHƯA KHỚP / ĐANG CHẠY / ĐÃ ĐÓNG]`,
    `   - Khuyến nghị: [GIỮ / DỜI SL / THOÁT / ĐÃ ĐÓNG] — [lý do ngắn bằng price action]`,
    `Sau block đó, TIẾP TỤC phân tích entry MỚI như bình thường — khách quan, độc lập với lệnh cũ (có thể ra ORDER mới, WATCHLIST, hoặc NO TRADE).`,
  ].join('\n');
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
