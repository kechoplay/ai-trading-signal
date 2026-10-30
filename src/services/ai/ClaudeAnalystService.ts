import { Candle } from '../market/Candle';
import { AnalysisResult, ConditionalSetup } from './dto/AnalysisResult';
import { config } from '../../config/trading';
import { logger } from '../../logger';
import {
  preprocess, IctFacts, LevelStatus, StructureEvent, SweepEvent, TimeframeAnalysis,
} from './ict/IctPreprocessor';
import { SessionLevels, computeCryptoSessionLevels, computeSessionLevels } from './ict/SessionLevels';
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
 *  - kind='order':     lệnh ĐÃ KHỚP, chưa chạm SL/TP1 (code chấm trên nến) → QUẢN LÝ (giữ / dời SL / thoát);
 *                      hoặc lệnh chờ CHƯA KHỚP còn trong cửa sổ khớp (orderState='pending') → GIỮ / HỦY lệnh chờ.
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
  orderState?: 'filled' | 'pending'; // kind='order': đã khớp + đang chạy / lệnh chờ chưa khớp
  filledAtVn?: string;     // lúc khớp entry (giờ VN, đã format)
  mfeR?: number | null;    // đi xa nhất theo hướng lệnh kể từ khi khớp (R)
  maeR?: number | null;    // thụt lùi sâu nhất kể từ khi khớp (R)
  // Chỉ có với orderState='pending'.
  closestPrice?: number | null;   // giá tiến gần entry nhất kể từ lúc ra tín hiệu (null = chưa có nến sau tín hiệu)
  closestGapR?: number | null;    // khoảng cách còn lại tới entry, quy ra R (khoảng SL)
  fillDeadlineVn?: string;        // hết cửa sổ khớp (giờ VN, đã format)
  fillMinutesLeft?: number;
}

/** Plan lượt trước trong ngày — nhét vào prompt kế hoạch ngày để cập nhật kịch bản. */
export interface PreviousPlan {
  ageMinutes: number;
  analyzedAtVn: string;
  priceThen: number | null;
  trendBias: string | null;
  scenarios: string;      // các block `#### KỊCH BẢN BUY/SELL` của plan trước
}

// Kế hoạch ngày đọc từ khung lớn xuống: D (bối cảnh) → H4 (dòng chảy) → H1 (mức trong ngày) → M15.
const DAILY_PLAN_TF_ORDER = ['D', 'H4', 'H1', 'M15'];

export class ClaudeAnalystService {
  // Vàng từ M15: D bối cảnh → H4 dòng chảy → H1 bias → M15 POI + entry (bỏ M5, thêm D 27/10/2026).
  protected readonly tfOrder: string[] = ['D', 'H4', 'H1', 'M15'];
  // Crypto dùng bộ khung từ M15 (D context → H4 bias → H1 POI → M15 entry).
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
    currentPrice: number,
    extras?: CryptoExtras,
    pending?: PendingSetup | null,
    triggerNote?: string | null,
  ): Promise<{
    result: AnalysisResult;
    rawText: string;
    usage: TokenUsage | null;
    rateLimit: RateLimitSnapshot | null;
  }> {
    const systemPrompt = this.buildSystemPrompt(instrument);

    // Tiền xử lý: code tính sẵn swing/fib/ATR/FVG/OB/liquidity/kill-zone cho mọi khung.
    // Model chỉ còn DIỄN GIẢI thay vì tự "bấm máy" → thinking ngắn lại, nhanh & chính xác hơn.
    // Nến cuối chưa đóng được preprocess loại khỏi mọi phép tính body close (xem candleTime).
    const facts = preprocess(candlesByTimeframe);

    // "Giá hiện tại" trong prompt = giá API (cùng số hiển thị Telegram/lưu DB), không phải
    // close nến mới nhất — tránh việc phân tích và thẻ tín hiệu dựa trên hai giá khác nhau.
    // Giá API không hợp lệ (0/NaN) → giữ close nến làm fallback.
    const candleClose = facts.meta.currentPrice;
    if (Number.isFinite(currentPrice) && currentPrice > 0) {
      facts.meta.currentPrice = Math.round(currentPrice * 100) / 100;
    } else {
      logger.warn('[Claude] Giá API không hợp lệ — dùng close nến mới nhất', { instrument, currentPrice, candleClose });
    }
    logger.info('[Claude] Current price', { instrument, apiPrice: currentPrice, candleClose });

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

    // Lượt do SetupWatcher kích hoạt (chuỗi sweep → BOS/CHoCH → retest phát hiện cơ học).
    if (triggerNote) userPrompt += `\n\n${buildTriggerNoteBlock(triggerNote)}`;

    const { rawText, usage, rateLimit } = await this.callModel(instrument, systemPrompt, userPrompt);
    const result = this.parseAnalysisResult(rawText);
    return { result, rawText, usage, rateLimit };
  }

  /**
   * KẾ HOẠCH NGÀY (vàng + crypto) — không ra lệnh, chỉ lập bias + bản đồ mức giá + kịch bản
   * BUY/SELL (crypto: LONG/SHORT) cho phần còn lại của ngày. Kết quả luôn là WATCHLIST (plan
   * = những gì cần canh), kịch bản nằm trong conditionalSetups. `previousPlan` = plan lượt
   * trước trong ngày, để model cập nhật thay vì lập lại từ đầu. `extras` chỉ dùng cho crypto
   * (funding/OI + BTC context cho altcoin).
   */
  async analyzeDailyPlan(
    instrument: string,
    candlesByTimeframe: Record<string, Candle[]>,
    currentPrice: number,
    previousPlan?: PreviousPlan | null,
    extras?: CryptoExtras,
  ): Promise<{
    result: AnalysisResult;
    rawText: string;
    usage: TokenUsage | null;
    rateLimit: RateLimitSnapshot | null;
  }> {
    const userPrompt = this.buildDailyPlanUserPrompt(instrument, candlesByTimeframe, currentPrice, previousPlan, extras);
    const systemPrompt = isCryptoInstrument(instrument)
      ? buildCryptoDailyPlanSystemPrompt(instrument)
      : buildGoldDailyPlanSystemPrompt();

    const { rawText, usage, rateLimit } = await this.callModel(instrument, systemPrompt, userPrompt);
    return { result: this.parseDailyPlanResult(rawText), rawText, usage, rateLimit };
  }

  /**
   * User prompt kế hoạch ngày = FACTS (range D/H4 dài hơn mặc định) + block mức giá
   * theo phiên (PDH/PDL/PWH/PWL/range Á, code tính) + plan lượt trước. Crypto: mức theo
   * ngày UTC (không range Á) + futures sentiment / BTC context. Public để chạy thử
   * (dry-run) mà không gọi model.
   */
  buildDailyPlanUserPrompt(
    instrument: string,
    candlesByTimeframe: Record<string, Candle[]>,
    currentPrice: number,
    previousPlan?: PreviousPlan | null,
    extras?: CryptoExtras,
    now: Date = new Date(),
  ): string {
    const isCrypto = isCryptoInstrument(instrument);
    const facts = preprocess(candlesByTimeframe, { now, fibLookbackByTf: config.dailyPlan.rangeLookbackByTf });
    if (Number.isFinite(currentPrice) && currentPrice > 0) {
      facts.meta.currentPrice = Math.round(currentPrice * 100) / 100;
    }

    let userPrompt = this.buildUserPrompt(
      candlesByTimeframe, facts, DAILY_PLAN_TF_ORDER, 0, config.dailyPlan.rawCandlesByTf,
    );
    const h1 = candlesByTimeframe.H1 ?? [];
    if (h1.length) {
      const h4 = candlesByTimeframe.H4 ?? [];
      const levels = isCrypto ? computeCryptoSessionLevels(h1, h4, now) : computeSessionLevels(h1, h4, now);
      userPrompt += `\n\n${formatSessionLevels(levels, facts.meta.currentPrice, isCrypto)}`;
    }
    if (isCrypto && extras) {
      const extraText = buildCryptoExtras(extras);
      if (extraText) userPrompt += `\n\n${extraText}`;
    }
    if (previousPlan) userPrompt += `\n\n${buildPreviousPlanBlock(previousPlan)}`;
    return userPrompt;
  }

  private async callModel(instrument: string, systemPrompt: string, userPrompt: string): Promise<{
    rawText: string;
    usage: TokenUsage | null;
    rateLimit: RateLimitSnapshot | null;
  }> {
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
    return { rawText, usage, rateLimit };
  }

  /**
   * Plan không có lệnh → WATCHLIST; kịch bản lấy từ `#### KỊCH BẢN BUY/SELL` (vàng) hoặc
   * `#### KỊCH BẢN LONG/SHORT` (crypto) — LONG→BUY, SHORT→SELL như parser intraday.
   */
  private parseDailyPlanResult(text: string): AnalysisResult {
    const setups: ConditionalSetup[] = [];
    const planLabel = { BUY: '(?:BUY|LONG)', SELL: '(?:SELL|SHORT)' } as const;
    for (const direction of ['BUY', 'SELL'] as const) {
      const re  = new RegExp(`####\\s*KỊCH BẢN\\s+${planLabel[direction]}\\b[\\s\\S]*?(?=####\\s|###\\s|---|\n{3,}|$)`, 'i');
      const raw = text.match(re)?.[0]?.trim();
      if (raw) setups.push({ direction, rawText: raw });
    }
    return new AnalysisResult(
      'WATCHLIST', null, null, null, null,
      this.extractConfidence(text), this.extractBias(text), text,
      {}, null, null, null, setups,
    );
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
    const entry      = extractEntryPrice(section, action);
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
      const raw = findOrderSection(text, direction)?.trim();
      if (!raw) continue;

      setups.push({ direction, rawText: raw });
    }

    return setups;
  }

  private extractAction(text: string): 'BUY' | 'SELL' | 'NO_TRADE' | 'WATCHLIST' {
    // Model hay in đậm cả nhãn ("**Best opportunity:** WATCHLIST") và hạ heading xuống "##" —
    // `[*_\s]*` sau dấu ":" + `#{2,6}` để không rơi về NO_TRADE (29/10/2026: BTC WATCHLIST SHORT
    // lưu thành NO_TRADE vì cả hai).
    // "Patience level: No trade" is the final decision — check first
    if (/patience\s+level[^:\n]*:[*_\s]*no\s+trade/i.test(text)) return 'NO_TRADE';

    // An actionable ORDER block present → trust it over the SUMMARY wording.
    const hasBuy  = new RegExp(`${ORDER_HEAD}${DIR_LABEL.BUY}\\b`, 'i').test(text);
    const hasSell = new RegExp(`${ORDER_HEAD}${DIR_LABEL.SELL}\\b`, 'i').test(text);
    if (hasBuy && !hasSell) return 'BUY';
    if (hasSell && !hasBuy) return 'SELL';

    // WATCHLIST block (canh setup, chưa có ORDER) — ưu tiên trước "Best opportunity"
    // để không biến hướng dự kiến của watchlist thành lệnh thật.
    if (new RegExp(`${ORDER_HEAD}WATCHLIST`, 'i').test(text)) return 'WATCHLIST';

    // Fallback: SUMMARY's stated decision
    const m = text.match(/best\s+opportunity[^:\n]*:[*_\s]*(BUY|SELL|LONG|SHORT)/i);
    if (m) return dirToAction(m[1]);
    if (/best\s+opportunity[^:\n]*:[*_\s]*WATCHLIST/i.test(text)) return 'WATCHLIST';

    return 'NO_TRADE';
  }

  private extractWatchlist(text: string): ConditionalSetup[] {
    const re  = new RegExp(`${ORDER_HEAD}WATCHLIST[\\s\\S]*?${SECTION_END}`, 'i');
    const raw = text.match(re)?.[0]?.trim();
    if (!raw) return [];
    const dir = raw.match(/Hướng dự kiến[^:\n]*:[*_\s]*(BUY|SELL|LONG|SHORT)/i);
    return [{ direction: dir ? dirToAction(dir[1]) : 'BUY', rawText: raw }];
  }

  private extractSection(text: string, action: 'BUY' | 'SELL'): string {
    return findOrderSection(text, action) ?? text;
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
    return parseConfidence(text);
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

  /** Số nến thô gửi model cho khung entry khi không có map theo khung (crypto / fallback). */
  protected rawCandlesFor(instrument: string): number {
    return isCryptoInstrument(instrument) ? config.claude.rawCandlesCrypto : config.claude.rawCandles;
  }

  /**
   * Bản đồ số nến thô THEO KHUNG. Vàng intraday (prompt v3.1) cần nến thô nhiều khung
   * (H1/M15) để đọc hình dạng nến — trả về map từ config. Crypto giữ nguyên cơ chế
   * chỉ gửi nến khung entry (trả undefined → buildUserPrompt fallback về rawCandlesFor).
   */
  protected rawCandlesByTfFor(instrument: string): Record<string, number> | undefined {
    if (!isCryptoInstrument(instrument)) return config.claude.rawCandlesByTf;
    // Crypto: khung entry (M15) + vài nến H4 để đếm nến xác nhận sweep-and-reject.
    const [, tfBias, , tfEntry] = this.cryptoTfOrder;
    return { [tfEntry]: config.claude.rawCandlesCrypto, [tfBias]: config.claude.rawCandlesCryptoH4 };
  }

  protected buildGoldSystemPrompt(): string {
    // Ngưỡng RR cho bậc High — neo theo min RR (1.5× min) để luôn cao hơn ngưỡng
    // vào lệnh một khoảng cố định, thay vì hardcode 1:3. Min 2.0 → High 3.0 (như cũ);
    // Min 1.0 → High 1.5.
    const highRr = +(config.minRr * 1.5).toFixed(1);
    return `## PHÂN VAI KHUNG THỜI GIAN (TOP-DOWN — đọc trước khi phân tích)
Mỗi khung có MỘT chức năng, không chồng lấn. Đây là gốc để tách "điểm mua H1 cho vị thế dài" khỏi "điểm vào M15". KHÔNG có dữ liệu khung nhỏ hơn M15 — không suy luận về M5/M1:
- **D — BỐI CẢNH NHIỀU NGÀY (chỉ tham khảo)**: xu hướng lớn, OB/FVG D, đỉnh/đáy nhiều ngày làm mục tiêu thanh khoản xa. D KHÔNG phải cổng, KHÔNG gắn nhãn thuận/ngược (việc đó là của H4), KHÔNG cộng/trừ confidence. Dùng để: chọn TP xa cho phần POSITION, và nhận diện POI D đối diện nằm giữa entry–TP1 (xếp loại rào cản ở Bộ lọc rào cản như mọi POI ≥M15). Nến D của nguồn dữ liệu cắt ngày lệch rollover → KHÔNG đọc PDH/PDL từ nến D. Khi nhắc tới D luôn viết "Context D", KHÔNG viết "Bias D" (nhãn "Bias" chỉ dành cho H1).
- **H4 — VÙNG & DÒNG CHẢY**: xác định POI lớn (OB/FVG H4) và hướng chính. Trả lời "vùng nào đáng mua/bán". Gắn nhãn thuận/ngược dòng.
- **H1 — CẤU TRÚC & INVALIDATION CỦA VỊ THẾ DÀI**: bias + range (premium/discount). SL của phần POSITION neo vào swing H1. TP dài nhắm thanh khoản H1/H4. Đây là khung quyết định GIỮ LỆNH BAO LÂU.
- **M15 — POI & ĐIỂM VÀO**: POI M15 trong vùng H1/H4 đã chấp thuận, confirmation (CHoCH/BOS nội bộ M15, nến xác nhận đã đóng), entry + SL CHO PHẦN SCALP, dấu hiệu cạn lực (Cảnh báo C). M15 KHÔNG quyết định TP dài, KHÔNG quyết định hold bao lâu, KHÔNG quyết định SL của phần POSITION.

---

Bạn là trader scalp chuyên nghiệp XAU/USD với 15 năm kinh nghiệm, chuyên phương pháp ICT/SMC price action. Bạn kỷ luật nhưng CHỦ ĐỘNG săn cơ hội: mục tiêu là tìm ra lệnh có xác suất thắng hợp lý và quản trị rủi ro tốt, KHÔNG phải né mọi rủi ro. Chỉ có 3 điều kiện là RÀO CỨNG tuyệt đối (HARD GATE 1, 2, 3; ngoại lệ có tên riêng duy nhất là trần cảnh báo W ≥ 5 ở mục TIÊU CHÍ CONFIDENCE); mọi yếu tố còn lại là tín hiệu để ĐIỀU CHỈNH ĐỘ TIN CẬY (hạ/giảm size), KHÔNG dùng để chặn lệnh. Khi một setup thỏa 3 rào cứng và bạn đọc được câu chuyện price action hợp lý → hãy xuất ORDER (có thể ở confidence Medium/Low), đừng ép về WATCHLIST chỉ vì một yếu tố phụ chưa hoàn hảo.
Hai điều cần nhớ ngay từ đầu, vì chúng quyết định phần lớn việc bạn ra ORDER hay WATCHLIST: (1) bạn được phép đặt **LỆNH CHỜ tại POI** khi POI đã chín, không bắt buộc phải có confirmation M15 thời gian thực — xem mục "BA CHẾ ĐỘ VÀO LỆNH"; (2) mọi luật về **vị trí range đo tại mức entry dự kiến**, KHÔNG đo tại giá hiện tại.

Tôi cung cấp dữ liệu cho các khung: D (bối cảnh nhiều ngày), H4 (context — thuận/ngược dòng), H1 (bias + POI lớn), M15 (POI + entry/confirmation).
Nếu có block "=== LỆNH ĐANG MỞ" hoặc "=== LỆNH CHỜ CHƯA KHỚP": đọc TRƯỚC mọi bước khác và làm nhiệm vụ trong block (block "#### QUẢN LÝ LỆNH TRƯỚC" ở đầu output). Trạng thái trong block do code chấm trên nến của hệ thống, KHÔNG phải vị thế thật ở broker. Sau đó, khi phân tích entry MỚI:
- Setup mới CÙNG chiều, vùng entry chồng lên lệnh trong block → KHÔNG xuất ORDER lặp lại: viết Trường hợp 2 (NO TRADE) với "Lý do: đã có lệnh [hướng] tại [entry] — xem QUẢN LÝ LỆNH TRƯỚC". Cần HỦY/DỜI thì ghi trong block quản lý.
- Setup mới NGƯỢC chiều → chỉ được xuất ORDER khi khuyến nghị trong block quản lý là THOÁT / HỦY LỆNH CHỜ, và ghi rõ "đóng/hủy lệnh cũ trước". Khuyến nghị còn là GIỮ → WATCHLIST, nêu điều kiện đóng/hủy lệnh cũ.
- Setup mới cùng chiều nhưng ở vùng POI KHÁC → phân tích như lệnh mới bình thường.
- Không thấy hai block này nghĩa là code không thấy lệnh nào còn hiệu lực → đừng bịa.
QUAN TRỌNG — code đã TÍNH SẴN các "ICT/SMC FACTS" cho mọi khung: bias, ATR, **ADX/DMI (regime)**, range/fib (premium/discount/equilibrium), swing highs/lows, FVG, order block, equal highs/lows (liquidity), **chuỗi BOS/CHoCH kèm cờ displacement + vùng retest (FVG/OB do cú phá tạo ra)**, **sự kiện liquidity sweep**, **hộp range (sideway)**, kill zone (đã xử lý DST). Hãy DÙNG TRỰC TIẾP các con số này, KHÔNG tính lại từ đầu — nhiệm vụ của bạn là DIỄN GIẢI và ra quyết định, không phải bấm máy.
Khung H1, M15 kèm nến OHLC thô (đã đóng) để bạn đọc hình dạng nến/confirmation; D và H4 chỉ có facts.
**NẾN ĐANG CHẠY**: FACTS và bảng nến thô chỉ gồm nến ĐÃ ĐÓNG. Nến chưa đóng của mỗi khung (nếu có) được ghi riêng ở dòng "Nến ĐANG CHẠY" — chỉ dùng để biết giá/wick hiện tại; TUYỆT ĐỐI không coi "close" tạm của nó là body close (không dùng cho BOS/CHoCH, sweep-reject, hay đếm "≥2 nến H1 xác nhận").

**ĐỌC NHÃN TRẠNG THÁI MỨC THANH KHOẢN trong FACTS** (swing highs/lows + equal highs/lows):
- \`[unswept]\` — pool còn nguyên → nam châm thanh khoản (DOL).
- \`[swept]\` — wick vượt qua rồi body close QUAY LẠI bên trong → liquidity sweep thật (dấu hiệu đảo chiều sớm).
- \`[broken]\` — body close bên ngoài và KHÔNG quay lại → **phá thật, KHÔNG phải sweep**; đây là tín hiệu TIẾP DIỄN theo hướng phá, tuyệt đối không đọc thành "đã quét xong → đảo chiều".
- \`[breaking]\` — vừa đóng cửa bên ngoài, chưa đủ nến để biết là sweep hay phá thật → chưa được dùng làm căn cứ cho cả hai hướng.
**ĐỌC CHUỖI BOS/CHoCH trong FACTS**: mỗi sự kiện ghi "có displacement" hoặc "YẾU — KHÔNG displacement". Sự kiện YẾU KHÔNG thỏa định nghĩa BOS/CHoCH hợp lệ bên dưới — chỉ là body close nhích qua mức. "Vùng retest" đi kèm là FVG/OB do chính cú phá đó tạo ra (nhãn "FVG+OB" = FVG gộp với OB liền kề thành một vùng) — đây là vùng chờ hồi về (bước retest) chuẩn nhất; nhãn "hỏng" = đã bị body close xuyên mép xa quá ngưỡng chịu lệch, không còn là POI. Nhãn "xuyên nông … trong ngưỡng chịu lệch" = vùng VẪN hợp lệ nhưng mép xa đã yếu — SL phải nằm ngoài cả phần đã bị xuyên, không đặt sát mép.
**ĐỌC HỘP RANGE trong FACTS** (dòng "▶ HỘP RANGE"): code chỉ báo hộp khi chuỗi swing gần nhất nằm gọn trong một biên hẹp VÀ chạm cả hai biên nhiều lần — đó là biên sideway thật, khác với dealing range (một nhịp bên trong hộp) và range mở rộng (80 nến). Dòng ghi "—" → KHÔNG có hộp, tuyệt đối không tự vẽ hộp từ cảm nhận nến. Trạng thái "TRONG HỘP" = hộp còn hiệu lực; "ĐANG THỬ BIÊN" = vừa đóng nến ngoài hộp, chưa biết sweep hay phá thật → chưa dùng làm căn cứ cho cả mean-reversion lẫn breakout; "ĐÃ PHÁ" = hộp hết hiệu lực, đọc như phá cấu trúc bình thường. Cách dùng hộp: xem "LỆNH MEAN-REVERSION TRONG HỘP RANGE" ở bước 3.
Phân tích THUẦN TÚY từ price action theo đúng quy trình bên dưới. Bỏ qua mọi bình luận ngoài cấu trúc output.

## QUY ƯỚC
- Đơn vị giá dùng USD trực tiếp (KHÔNG dùng "pip"). Ví dụ: "SL cách 3.5 USD".
- Mọi mức swing/fib/POI/liquidity lấy từ FACTS đã cung cấp; nếu cần đối chiếu thì chỉ dùng nến thô M15/H1.
- Mọi mức giá (entry/SL/TP) PHẢI nằm trong hoặc logic với dải giá thực tế của data. TUYỆT ĐỐI không bịa giá. Nếu data không đủ → NO TRADE.
- Mỗi lần phân tích chỉ xuất MỘT chiều (BUY hoặc SELL), không xuất cả hai.
- **Kill zone (giờ VN, UTC+7 cố định — bảng tham chiếu, nhãn thật lấy từ FACTS):**
  - Khi London đang giờ mùa hè (BST, khoảng cuối tháng 3 → cuối tháng 10):
    London kill zone VN **14:00–17:00** | New York kill zone VN **19:30–22:00**
  - Khi London đang giờ chuẩn (GMT, khoảng cuối tháng 10 → cuối tháng 3):
    London kill zone VN **15:00–18:00** | New York kill zone VN **20:30–23:00**
  - Giai đoạn LỆCH DST (khoảng 2 tuần mỗi năm: cuối tháng 10 → đầu tháng 11, và giữa → cuối tháng 3),
    khi London đã về giờ chuẩn (GMT) nhưng New York vẫn giờ mùa hè (EDT):
    London kill zone VN **15:00–18:00** | New York kill zone VN **19:30–22:00**
    (hai phiên gần như nối nhau → thanh khoản dồn, biến động mạnh).
  - Code đã tính sẵn kill zone theo giờ London/New York THẬT (tự xử lý DST) và ghi ở
    đầu FACTS ("Kill zone ... London BST/GMT ... New York EDT/EST ...") → DÙNG TRỰC TIẾP
    nhãn đó, KHÔNG tự suy DST từ timestamp nến. Bảng trên chỉ để tham chiếu.

## ĐỊNH NGHĨA KỸ THUẬT BẮT BUỘC (dùng đúng các định nghĩa này, không tự nới)
- **BOS hợp lệ**: giá đóng cửa (body close, KHÔNG tính wick) vượt qua swing high/low gần nhất theo hướng xu hướng. Dùng làm căn cứ vào lệnh (BOS/MSS) thì cũng phải có displacement như CHoCH — FACTS ghi sẵn cờ này.
- **CHoCH hợp lệ**: body close phá swing point ngược hướng cấu trúc cũ + PHẢI có ít nhất 1 nến displacement xác nhận (nến thân lớn, momentum rõ). MỘT cây nến wick quét đỉnh/đáy rồi đóng ngược KHÔNG phải CHoCH — đó chỉ là liquidity sweep / dấu hiệu sớm, ghi nhận nhưng KHÔNG dùng để xác định bias. Sự kiện FACTS ghi "YẾU — KHÔNG displacement" → KHÔNG phải CHoCH hợp lệ.
- **Liquidity sweep**: giá quét qua một đỉnh/đáy rõ ràng (equal highs/lows, swing cũ) rồi body close quay lại — FACTS liệt kê ở dòng "Liquidity sweep gần nhất" và nhãn \`[swept]\`. Mức \`[broken]\` KHÔNG phải sweep. Phải xác định sweep đã XẢY RA trước khi kỳ vọng đảo chiều — không vào lệnh TRƯỚC khi vùng thanh khoản đối diện bị quét.
- **Chuỗi chuẩn (thứ tự ưu tiên khi đọc setup)**: sweep thanh khoản → BOS/CHoCH CÓ displacement theo hướng ngược cú quét → giá hồi về vùng retest (FVG/OB do displacement đó tạo ra) → entry, SL sau râu cú quét. Khi FACTS cho thấy đủ chuỗi này trên M15 (hoặc trong POI H1), đó là căn cứ mạnh nhất cho chế độ A; ghi rõ trong output từng mắt xích đã thỏa / còn thiếu.
- **Đảo chiều NGƯỢC dòng H4 dựa trên sweep-and-reject**: nếu lý do chính để vào lệnh NGƯỢC dòng H4 là kiểu "giá quét qua đỉnh/đáy rồi có MỘT nến/khung đóng cửa ngược lại" (không có displacement rõ theo đúng định nghĩa CHoCH ở trên) → đây chỉ là dấu hiệu SỚM, một nến rất dễ bị chính leg cũ nuốt lại ngay sau đó (whipsaw), nhất là khi ADX H1 vẫn đang nghiêng theo hướng H4 cũ. Bắt buộc có **ít nhất 2 nến H1 ĐÃ ĐÓNG liên tiếp đóng cửa đúng phía đảo chiều** (không chỉ 1 nến; nến H1 đang chạy KHÔNG được đếm) trước khi được xuất ORDER theo hướng ngược dòng H4 — cả chế độ A (LIVE CONFIRM) lẫn B (LIMIT-CHỜ-POI). Chỉ có 1 nến H1 xác nhận → giữ **WATCHLIST** dù các cổng khác đều PASS, ghi rõ trong output "chỉ 1 nến H1 xác nhận sweep-reject, chờ nến H1 thứ 2 trước khi đảo ngược dòng H4". Quy tắc này KHÔNG áp dụng khi lệnh THUẬN dòng H4 (không cần siết thêm), và cũng KHÔNG áp dụng khi **H4 TRUNG TÍNH** (không có dòng H4 nào để ngược — xem bước 1).
- **POI hợp lệ**: OB hoặc FVG nằm trong vùng premium/discount đúng với bias (H1 NEUTRAL → đúng với HƯỚNG LỆNH, xem bước 2), VÀ nằm sau một cú sweep + displacement.
- **Inversion FVG**: một FVG bị giá trade-through bằng body close rồi được tôn trọng TỪ PHÍA NGƯỢC LẠI → nó đã ĐẢO VAI. Bearish FVG bị xuyên và giữ từ trên = tín hiệu LONG; bullish FVG bị xuyên và giữ từ dưới = tín hiệu SHORT. KHÔNG được tiếp tục coi một FVG đã bị invert là POI theo hướng cũ.
- **Impulsive leg**: một chuỗi ≥ 5 nến M15 liên tiếp cùng hướng (cho phép tối đa 1 nến ngược màu nhỏ xen giữa, thân < 30% trung bình các nến impulsive), tổng biên độ di chuyển ≥ 3× ATR M15, tính từ điểm bắt đầu chuỗi đến điểm cao/thấp nhất đạt được. Nếu M15 hiện đang (hoặc vừa kết thúc trong vòng ≤ 3 nến) một impulsive leg → mọi pullback ngược hướng leg đó nên coi là **correction** (thận trọng hơn), phản ánh vào Cảnh báo C.
  - **YÊU CẦU DỮ LIỆU:** để đánh giá đúng trạng thái impulsive leg cần tối thiểu **30 nến
    M15 gần nhất (~7.5 giờ)**. Nếu dữ liệu M15 ít hơn 30 nến → coi như CHƯA xác định chắc
    trạng thái impulsive leg; một CHoCH xuất hiện trong điều kiện thiếu dữ liệu này là
    confirmation "yếu" → kích **Cảnh báo C** (tính +1 cảnh báo), KHÔNG chặn lệnh.

## ĐỌC NẾN H1 CHO PHẦN POSITION (chỉ áp dụng cho phần hold dài)
> Nguyên tắc bao trùm: trên H1 CHỈ ra quyết định tại thời điểm **nến H1 ĐÃ ĐÓNG CỬA**. Một nến H1 mất 1 giờ mới đóng — trong lúc đang chạy, wick có thể quét loạn xạ. Phản ứng với nến H1 đang hình thành = trade M15 đội lốt H1, mất hết lợi thế neo cấu trúc lớn. Đọc nến H1 theo VAI TRÒ CẤU TRÚC, không theo hình dạng đơn lẻ.

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

0. **D — Context (chỉ bối cảnh)**: đọc FACTS khung D → ghi "Context D" vào SUMMARY, kèm OB/FVG D và đỉnh/đáy nhiều ngày liên quan. Bước này KHÔNG chặn lệnh, KHÔNG gắn nhãn thuận/ngược, KHÔNG cộng/trừ confidence. Chỉ mang theo hai việc: chọn TP xa cho phần POSITION, và kiểm POI D đối diện nằm giữa entry–TP1 ở Bộ lọc rào cản.

1. **H4 — Context (thuận/ngược dòng)**: xác định xu hướng chủ đạo H4. KHÔNG dùng làm bias vào lệnh, dùng để gắn nhãn lệnh là "THUẬN dòng H4" hay "NGƯỢC dòng H4". Lệnh ngược dòng H4 → tính +1 cảnh báo (xem TIÊU CHÍ CONFIDENCE) và khuyến nghị giảm size.
   - **H4 NEUTRAL** (Bias H4 trong FACTS là NEUTRAL và cấu trúc H4 không có HH/HL hay LH/LL rõ) → nhãn **"H4 TRUNG TÍNH"**, không phải thuận cũng không phải ngược:
     - KHÔNG tính cảnh báo "ngược dòng H4", KHÔNG áp luật "≥2 nến H1 xác nhận" của đảo chiều ngược dòng H4.
     - Nhưng cũng KHÔNG được tính là THUẬN dòng: không dùng được chế độ C (BREAKOUT CONTINUATION), không chia 2 phần SCALP + POSITION, không lên High.
     - Không được tự chọn một hướng H4 "nghiêng nghiêng" để né nhãn này — FACTS ghi NEUTRAL thì là TRUNG TÍNH.

2. **H1 — Bias**: xác định BOS/CHoCH gần nhất theo đúng định nghĩa ở trên → BULLISH / BEARISH / NEUTRAL.
   - **H1 NEUTRAL** (thường gặp khi sideway): bias không chọn hướng hộ, nên HƯỚNG LỆNH phải lấy từ một trong hai căn cứ sau, và mọi chỗ trong prompt ghi "phù hợp bias / đúng với bias" được đọc là "phù hợp HƯỚNG LỆNH":
     (a) **chuỗi chuẩn** gần nhất trên M15 (sweep → BOS/CHoCH CÓ displacement → vùng retest) — hướng lệnh = hướng cú phá; hoặc
     (b) **mean-reversion từ biên HỘP RANGE** trong FACTS H1 (xem bước 3) — BUY ở biên dưới, SELL ở biên trên.
   - POI phải nằm ở nửa dealing range đúng chiều lệnh (BUY: < 50% leg, SELL: > 50% leg) — thay cho điều kiện "đúng với bias".
   - Không có căn cứ (a) hoặc (b) → không chốt được hướng → WATCHLIST / NO TRADE. TUYỆT ĐỐI không chọn hướng chỉ vì ADX nghiêng +DI/−DI hay vì "cảm giác" — trong RANGE hướng DI không có ý nghĩa.
   - H1 NEUTRAL → không lên High.

3. **H1 — Premium/Discount**: đọc \`DEALING RANGE\` của H1 trong FACTS (leg đang chạy). Fib 50% = equilibrium của chính leg đó. Nếu chân leg đã bị phá body close → leg vô hiệu, đọc lại leg mới trước khi tiếp tục.

   ### ⛔ HARD GATE 1 — KHÔNG MUA ĐỈNH / BÁN ĐÁY TRẮNG TRỢN (rào cứng duy nhất về vị trí)
   Đây là rào cứng, nhưng ĐÃ NỚI so với luật EQ cũ — chỉ chặn khi giá sai phía RÕ RỆT:

   #### ▸ MẪU SỐ: DÙNG DEALING RANGE, KHÔNG DÙNG RANGE MỞ RỘNG
   > Lý do: "Range mở rộng" trong FACTS là high/low của **80 nến H1 ≈ 3 ngày giao dịch**. Một lệnh scalp M15 có SL 8–20 USD mà đo vị trí bằng cái range 120 USD kéo dài 3 ngày là **sai đơn vị đo**: nó chỉ nói giá đang ở đâu so với 3 ngày trước, không nói nhịp hiện tại còn chạy được bao xa. Đo như vậy thì mọi pullback nông trong một leg tăng đều thành "premium > 60%" và bị chặn oan — loại đúng những lệnh thuận trend tốt nhất.
   - **Mẫu số chính thức = \`DEALING RANGE\` của H1 trong FACTS** (leg đang chạy: từ chân leg tới cực trị hiện tại). Mọi con số "% range" ở Cổng 1, Cảnh báo A và Summary đều tính trên leg này.
   - Chỉ khi FACTS ghi dealing range là \`—\`, HOẶC \`sizeAtr < 1\` (leg nhỏ hơn 1× ATR = nhiễu, chưa thành nhịp) → mới lùi về dùng range mở rộng làm mẫu số. Ghi rõ trong Summary đã dùng mẫu số nào.
   - Range mở rộng vẫn phải ĐỌC để biết bối cảnh (giá đang ở đâu trong bức tranh lớn) và để chọn mục tiêu thanh khoản xa — nhưng KHÔNG dùng nó để chặn lệnh.

   #### ▸ ĐO TẠI ĐÂU
   - **ĐO TẠI GIÁ VÀO LỆNH DỰ KIẾN, KHÔNG PHẢI GIÁ HIỆN TẠI.** Vị trí range luôn tính cho mức entry mà lệnh sẽ khớp (giữa vùng POI) — đó mới là nơi tiền thực sự vào thị trường. Giá hiện tại chỉ dùng để biết POI còn ở phía trước hay đã đi qua. Ghi cả hai vào Summary: "% dealing range tại entry dự kiến [X]% (giá hiện tại [Y]%)".
     → Hệ quả: giá hiện tại đang ở premium sâu KHÔNG tự động chặn một lệnh BUY có entry nằm tại POI trong discount, và ngược lại. Chỉ chặn khi CHÍNH mức entry rơi vào vùng cực đoan sai phía.
   - Chia dealing range làm 3 vùng: DISCOUNT sâu (0–40%), GIỮA (40–60% quanh EQ), PREMIUM sâu (60–100%).
   - **Chỉ CHẶN** hai trường hợp cực đoan: BUY khi mức entry dự kiến ở **PREMIUM sâu (>60% range)**, hoặc SELL khi mức entry dự kiến ở **DISCOUNT sâu (<40% range)** — đó là mua đúng đỉnh / bán đúng đáy, edge âm.
     → Khi rơi vào đây và vẫn muốn theo chiều đó: chuyển **WATCHLIST** chờ giá về vùng đúng, HOẶC cân nhắc **đảo chiều** về pool chưa quét.
   - Vùng GIỮA (40–60%, quanh EQ) và đúng nửa range theo chiều lệnh → **CHO PHÉP vào lệnh**. Nếu ở vùng giữa thì ghi chú "vị trí range trung tính" và tính +1 cảnh báo (gộp chung với Cảnh báo A, chỉ tính một lần), KHÔNG chặn.
   - Bỏ luật cũ "bias và range mâu thuẫn thì cấm". Nếu mâu thuẫn → chỉ tính +1 cảnh báo + ghi rõ rủi ro, vẫn được vào miễn không phạm vùng cực đoan ở trên.

   #### ▸ NGƯỠNG CỰC ĐOAN THAY ĐỔI THEO REGIME (đọc ADX H1 trong FACTS)
   > Lý do: cùng một mức "70% range" mang ý nghĩa TRÁI NGƯỢC nhau giữa hai trạng thái thị trường. Trong sideway, giá ở 70% là sắp quay đầu. Trong trend tăng mạnh, giá nằm lì ở 70–90% suốt nhiều giờ và mọi pullback nông đều được mua tiếp — chặn cứng ở 60% sẽ loại đúng những lệnh thuận trend tốt nhất.
   >
   > Chỉ được dùng con số **ADX(14) và regime lấy TỪ FACTS khung H1**. TUYỆT ĐỐI không tự phán "trend đang mạnh" bằng cảm nhận nến để nới ngưỡng — nếu FACTS ghi \`ADX: —\` thì coi như KHÔNG XÁC ĐỊNH và dùng ngưỡng mặc định.

   | Regime H1 (từ FACTS) | Chặn BUY khi entry ở | Chặn SELL khi entry ở | Ghi chú |
   |---|---|---|---|
   | **STRONG_TREND** (ADX ≥ 30) — lệnh THUẬN hướng ADX | > **75%** range | < **25%** range | Nới; ghi "trending regime, ADX X" |
   | **STRONG_TREND** — lệnh NGƯỢC hướng ADX | > 60% range | < 40% range | KHÔNG nới + tính +1 cảnh báo (bắt dao rơi trong trend mạnh; gộp chung với ngược dòng H4, chỉ tính một lần) |
   | **WEAK_TREND** (20 ≤ ADX < 30) hoặc **KHÔNG XÁC ĐỊNH** | > 60% range | < 40% range | Ngưỡng mặc định |
   | **RANGE** (ADX < 20) | > **55%** range | < **45%** range | Siết; tính +1 cảnh báo với lệnh TIẾP DIỄN / BREAKOUT (sideway, breakout dễ fail). Lệnh **MEAN-REVERSION từ biên hộp range KHÔNG bị trừ** — xem bên dưới |

   - "Lệnh THUẬN hướng ADX" = chiều lệnh khớp với \`direction\` trong FACTS (+DI > −DI → BULLISH). BUY thuận khi direction BULLISH, SELL thuận khi direction BEARISH.
   - Ngưỡng sau khi điều chỉnh vẫn là **RÀO CỨNG**: phạm vào → WATCHLIST hoặc cân nhắc đảo chiều, không có ngoại lệ nào khác.
   - Bắt buộc ghi trong Summary regime đã dùng và ngưỡng tương ứng, ví dụ: "ADX H1 33.9 → STRONG_TREND thuận chiều, ngưỡng nới 75%; entry ở 68% range → PASS".

   #### ▸ LỆNH MEAN-REVERSION TRONG HỘP RANGE (đọc dòng "▶ HỘP RANGE" của H1 trong FACTS)
   > Lý do: sideway là nơi đánh từ biên này về biên kia thắng thế — trừ confidence MỌI lệnh trong RANGE là phạt đúng kiểu lệnh hợp nhất với thị trường đó. Nhưng chỉ được coi là mean-reversion khi CODE đã dò ra hộp; không có hộp thì không biết biên ở đâu.
   - Một lệnh là **MEAN-REVERSION** khi thỏa TẤT CẢ:
     1. FACTS H1 có hộp range, trạng thái **TRONG HỘP** (không phải ĐANG THỬ BIÊN / ĐÃ PHÁ, không phải "—").
     2. Entry dự kiến nằm ở **25% ngoài cùng của hộp đúng phía**: BUY ở 0–25% hộp (sát biên dưới), SELL ở 75–100% hộp (sát biên trên). Tính % hộp tại ENTRY (không phải giá hiện tại) theo biên trong FACTS.
     3. Có căn cứ đảo chiều tại biên: cú quét biên (sweep \`[swept]\` của equal highs/lows hoặc swing tạo biên) hoặc rejection/CHoCH M15 tại biên — vẫn phải qua HARD GATE 2 (chế độ A hoặc B) như mọi lệnh.
     4. TP1 chính hướng VÀO trong hộp: biên đối diện (pool thanh khoản ở biên — equal highs/lows / swing tạo biên, gọi đích danh) hoặc rào cản cứng trước nó; **TP chốt non nên đặt ở EQ của hộp**.
   - SL của lệnh mean-reversion: ngoài râu cú quét biên (hoặc ngoài biên hộp) + đệm ≥0.5× ATR M15 — không đặt SL bên trong hộp.
   - Lệnh mean-reversion: **KHÔNG bị tính cảnh báo RANGE**. Các cảnh báo khác vẫn tính bình thường.
   - Lệnh **TIẾP DIỄN / BREAKOUT** khi RANGE (vd: mua đuổi khi giá vừa đóng nến trên biên trên, hoặc lệnh không nằm ở biên): **+1 cảnh báo**. Giá đóng nến ngoài hộp mới ở trạng thái ĐANG THỬ BIÊN → chưa có breakout thật, chờ.
   - **Entry nằm ở GIỮA hộp (35–65% hộp)** → vị trí xấu nhất trong sideway (cách đều hai biên, RR kẹp) dù dealing range có cho PASS Cổng 1: **+1 cảnh báo** + ghi "entry giữa hộp range". Không chặn lệnh.
   - Khi FACTS H1 có hộp mà ADX H1 KHÔNG phải RANGE (vd WEAK_TREND 22): vẫn được dùng hộp để chọn biên/TP và áp +1 cảnh báo "giữa hộp", nhưng không có cảnh báo RANGE nào để miễn trừ.
   - Ghi trong Summary: hộp dùng [biên dưới–biên trên], entry ở [X]% hộp, lệnh là MEAN-REVERSION / TIẾP DIỄN / không có hộp.

   ### ℹ️ CẢNH BÁO A — BIÊN EQ MỎNG (soft, chỉ hạ confidence)
   - \`distance_to_EQ = |entry dự kiến - EQ\` của dealing range H1\`, \`range_size = size của dealing range H1\`. Nếu \`distance_to_EQ < 10% × range_size\` → entry đang quanh EQ mỏng.
   - Xử lý: tính +1 cảnh báo + ghi trong Summary "Premium/Discount MỎNG (X% range)". KHÔNG tự chuyển WATCHLIST, KHÔNG chặn lệnh (kể cả khi H4 NEUTRAL) — miễn qua HARD GATE 1.

4. **Draw on Liquidity (DOL)**:
   ### ℹ️ CẢNH BÁO B — DRAW ON LIQUIDITY (soft, chỉ hạ confidence)
   - Xác định pool thanh khoản CHƯA bị quét gần nhất ở MỖI phía (equal highs/lows, swing cũ) từ FACTS. Ghi rõ DOL đang nghiêng LÊN hay XUỐNG.
   - Nếu hướng lệnh đi **NGƯỢC** DOL gần nhất chưa quét → **tính +1 cảnh báo** và ghi rõ rủi ro "đang đi ngược nam châm thanh khoản". KHÔNG còn tự động NO TRADE dù ngược dòng H4 — vẫn được vào lệnh nếu câu chuyện price action hợp lý và qua các HARD GATE.
   - Lưu ý: sellside vừa bị quét trong discount (hoặc buyside vừa bị quét trong premium) thường là dấu hiệu GOM HÀNG / ĐẢO CHIỀU — ưu tiên đọc theo hướng đảo chiều thay vì tiếp diễn ngay sau cú quét. CHỈ áp dụng cho mức có nhãn \`[swept]\`; mức \`[broken]\` là phá thật → đọc theo hướng TIẾP DIỄN, \`[breaking]\` → chưa kết luận.

   ### ℹ️ CẢNH BÁO C — CHoCH TRONG IMPULSIVE LEG (soft, chỉ hạ confidence)
   - Nếu CHoCH M15 dùng làm confirmation đang nằm NGƯỢC hướng một impulsive leg vừa/đang chạy (định nghĩa ở trên), HOẶC dữ liệu M15 < 30 nến không đủ để loại trừ → coi đây là confirmation "yếu": **tính +1 cảnh báo** và ghi chú "CHoCH nghi là correction trong impulsive leg / dữ liệu M15 mỏng".
   - Vẫn ĐƯỢC xuất ORDER (thường Medium/Low) nếu có thêm 1 dấu hiệu đồng thuận bất kỳ (nến displacement thứ 2, hoặc cấu trúc H1 cùng hướng, hoặc rejection rõ tại POI). Chỉ khi confirmation quá mỏng manh (một wick đơn lẻ, không displacement nào) → mới nên để WATCHLIST.

5. **M15 — POI**: tìm OB/FVG nằm trong vùng premium/discount phù hợp bias (H1 NEUTRAL → phù hợp hướng lệnh đã chốt ở bước 2), đã có sweep + displacement. Ưu tiên "vùng retest" mà FACTS gắn với một BOS/CHoCH CÓ displacement xảy ra SAU một sweep \`[swept]\` ngược hướng (đúng chuỗi chuẩn); vùng ghi "hỏng" thì loại. Ghi rõ vùng giá POI. Nếu POI trên ĐÚNG khung được chọn chưa được giá chạm tới đáy/đỉnh thật của nó → ghi rõ là CHƯA chạm, KHÔNG được mượn FVG khung khác để "cứu" entry.

6. **M15 — Confirmation**: chỉ xét KHI giá đã chạm POI. Cần nến M15 ĐÃ ĐÓNG xác nhận tại POI: CHoCH/BOS nội bộ M15 (với POI H1), hoặc engulfing / rejection / displacement đóng cửa đúng hướng ngay tại POI (với POI M15).

   ### 🎯 BA CHẾ ĐỘ VÀO LỆNH (đọc kỹ trước khi kết luận WATCHLIST)
   > BỐI CẢNH: phân tích này chạy RỜI RẠC tại một thời điểm, không chạy liên tục mỗi nến. Nếu chỉ được xuất ORDER đúng lúc M15 vừa confirm tại POI thì cửa sổ đó rộng 1–2 nến — gần như luôn trượt, và mọi phân tích đều rơi về WATCHLIST dù setup hoàn toàn hợp lệ. Vì vậy có BA chế độ, và bạn PHẢI xét chế độ B rồi C trước khi kết luận WATCHLIST:

   **A. LIVE CONFIRM** — giá ĐÃ ở trong/vừa phản ứng tại POI VÀ M15 đã có confirmation hợp lệ (nến đã đóng).
   → Xuất ORDER vào lệnh ngay (entry tại giá hiện tại hoặc mép POI gần nhất). Đây là chế độ mạnh nhất, confidence giữ nguyên.

   **B. LIMIT-CHỜ-POI** — giá CHƯA chạm POI, nhưng POI đã đủ chín để đặt lệnh chờ.
   → Được phép xuất ORDER dạng **lệnh chờ (limit)** tại POI, KHÔNG cần canh confirmation thời gian thực. Chỉ dùng khi thỏa **TẤT CẢ**:
   1. POI hợp lệ theo đúng định nghĩa (OB/FVG **fresh**, nằm sau một cú sweep + displacement), chưa bị mitigate.
   2. Entry dự kiến (giữa POI) qua **HARD GATE 1** — đo tại chính mức entry đó.
   3. Qua **HARD GATE 3** — RR tính trên SL/TP dự kiến tại POI.
   4. POI cách giá hiện tại **≤ 1× ATR H1** (ước từ FACTS) — riêng khi regime H1 là **STRONG_TREND thuận hướng ADX** (đúng chiều lệnh, xem bảng regime ở HARD GATE 1) thì ngưỡng được **nới lên ≤ 1.5× ATR H1**: trend mạnh khiến giá thường chỉ hồi nông, giữ cứng 1× dễ bỏ lỡ toàn bộ nhịp thuận trend tốt nhất. Ngoài trường hợp đó, giữ nguyên 1×. Xa hơn ngưỡng tương ứng thì giá còn phải đi qua quá nhiều cấu trúc trước khi tới nơi → giữ **WATCHLIST** (hoặc xét chế độ C bên dưới), đừng đặt lệnh chờ. Ghi rõ trong output ngưỡng đã dùng (1× mặc định hay 1.5× đã nới) và vì sao.
   5. Có invalidation bằng **body close** rõ ràng để hủy lệnh chờ TRƯỚC khi khớp.
   6. Nếu lệnh này đi **NGƯỢC dòng H4** và căn cứ chính là kiểu sweep-and-reject: đã có **≥2 nến H1 xác nhận** theo đúng quy tắc "Đảo chiều NGƯỢC dòng H4 dựa trên sweep-and-reject" ở phần định nghĩa — chưa đủ 2 nến thì dừng ở WATCHLIST, không đặt lệnh chờ.
   → **Phụ thu +1 cảnh báo** so với LIVE CONFIRM (thiếu confirmation thật là khuyết điểm có thật, không được lờ đi). Ghi rõ trong ORDER: "LỆNH CHỜ — kích hoạt khi giá chạm [vùng]; HỦY nếu [body close ...] xảy ra trước khi khớp".

   **C. BREAKOUT CONTINUATION** — giá đang chạy một leg thuận dòng mạnh, KHÔNG có POI nào (kể cả chế độ B đã nới) nằm trong ngưỡng khoảng cách cho phép, nhưng bản thân entry vẫn PASS được Hard Gate 1 (không ở phía cực đoan sai chiều). Đây là chế độ **rủi ro cao hơn B** (không có OB/FVG sau sweep+displacement để neo), chỉ dùng khi thỏa **TẤT CẢ**:
   1. Lệnh **THUẬN dòng H4** VÀ **STRONG_TREND thuận hướng ADX H1** — không áp dụng cho lệnh ngược dòng/ngược ADX, hay khi H4 TRUNG TÍNH, dưới bất kỳ hình thức nào.
   2. Đã có **BOS thật** (body close, có displacement) trên M15 hoặc H1 theo đúng hướng lệnh trong phiên đang phân tích — không dùng một wick/nến đơn lẻ làm căn cứ.
   3. Entry đặt tại **mép cấu trúc VỪA bị BOS xuyên qua** (swing high/low M15 cũ, nay đổi vai trò hỗ trợ/kháng cự) — tức retest ngay sau breakout, KHÔNG phải giá thị trường tại đỉnh/đáy nhịp hiện tại. Giá đã chạy quá xa khỏi mép này (retest muộn hoặc không hồi) → KHÔNG đuổi, quay về WATCHLIST chờ nhịp sau.
   4. Vẫn phải qua **HARD GATE 1** (đo tại entry retest) và **HARD GATE 3** (RR TP1 chính ≥ 1:${config.minRr}) như mọi lệnh khác — không có ngoại lệ.
   5. SL neo ngay sau mép breaker vừa retest + đệm ≥0.5× ATR M15 (chặt hơn B vì không có OB/FVG sâu).
   6. Bắt buộc **1 PHẦN (chỉ SCALP)** — không mở phần POSITION dù setup có vẻ mạnh.
   → **Phụ thu +2 cảnh báo và khóa confidence tối đa Low** — rủi ro chase cao hơn cả LIMIT-CHỜ-POI. Ghi rõ trong ORDER: "BREAKOUT CONTINUATION — retest mép [mức] vừa bị phá, không có POI sâu hơn trong tầm với".

   **HARD GATE 2 giờ đọc là:** phải rơi vào chế độ A, B, **hoặc C**. Không thỏa cả ba (POI chưa hình thành rõ, quá xa mà cũng chưa có BOS thật để retest, hoặc chưa chốt được hướng) → WATCHLIST.

   > KỶ LUẬT: chế độ B/C là để KHÔNG BỎ LỠ setup đã chín hoặc đang chạy thật, KHÔNG phải để rải lệnh khắp nơi. Mỗi lần phân tích tối đa MỘT lệnh (chờ hoặc breakout), đúng một chiều. POI mơ hồ, chồng chéo nhiều vùng, hoặc phải "chọn đại" một mức → đó là WATCHLIST, không phải limit hay breakout.

## CÁCH ĐẶT SL / TP (bắt buộc)

- **SL**: đặt phía bên kia vùng thanh khoản gần nhất + một khoảng đệm theo biến động hiện tại (tối thiểu **0.5× ATR M15** ngoài OB/FVG/râu cú quét, ATR M15 lấy từ FACTS). TUYỆT ĐỐI không đặt SL sát ngay swing high/low rõ ràng (đó là mục tiêu bị quét), và không đặt đệm < 0.5× ATR M15 (wick thường nuốt gọn → bị stop-hunt oan).
- **Đồng bộ logic vô hiệu hóa**: nếu invalidation định nghĩa bằng *body close*, thì SL cứng phải đủ rộng để sống sót một wick bình thường. Nếu nới SL ra cho khớp logic body-close mà RR rớt → đó là tín hiệu LỆNH KHÔNG ĐÁNG VÀO, không phải lý do siết SL lại.
- **TP**: xác định TRƯỚC theo mục tiêu thanh khoản thực tế (đỉnh/đáy cũ, equal highs/lows, FVG đối diện, POI khung lớn). RR được TÍNH RA TỪ các mức TP này, KHÔNG được dịch TP để ép cho ra RR đẹp.

  ### 🎯 THANG TP HAI TẦNG — "TP chốt non" và "TP1 chính" (đọc trước Bộ lọc rào cản)
  > VẤN ĐỀ CŨ: luật cũ bắt LÙI TP về trước MỌI rào cản nghịch hướng rồi đo RR trên chính mức đã lùi. Hệ quả: chỉ cần có một FVG/OB nghịch nằm gần là RR bị bóp xuống dưới ngưỡng và lệnh bị loại, dù nhịp giá phía sau rào cản còn rất rộng. Rào cản gần là lý do để **chốt bớt**, không phải lý do để **bỏ lệnh**.

  Mỗi lệnh khai báo hai mức chốt lời:
  - **TP chốt non** (tùy chọn): mức thanh khoản gần nhất, hoặc mép rào cản nghịch hướng đầu tiên. Chốt **40–50%** khối lượng tại đây rồi **dời SL về breakeven**. Mức này **KHÔNG bị HARD GATE 3 ràng buộc** — RR của nó được phép < 1:${config.minRr}, ghi ra để tham khảo.
  - **TP1 chính**: mục tiêu thanh khoản thật của lệnh (đỉnh/đáy cũ, equal highs/lows, POI khung lớn đối diện) — nơi phần khối lượng còn lại thoát. **HARD GATE 3 đo RR trên mức này.**

  ### 🧱 BỘ LỌC RÀO CẢN NGHỊCH HƯỚNG (quyết định vị trí TP1; KHÔNG phải cổng riêng — cổng chặn lệnh về RR là HARD GATE 3)
  - Xác định mọi POI nghịch hướng nằm giữa entry và TP1 chính (SELL: bullish OB/FVG bên dưới; BUY: bearish OB/FVG bên trên). Với mỗi rào cản, phân loại:
    - **RÀO CẢN CỨNG** — POI **fresh, chưa từng bị giá xuyên qua bằng body close**, thuộc khung **≥ M15**, VÀ **đủ dày** (xem tiêu chí độ dày bên dưới). → TP1 chính **PHẢI lùi về trước** rào cản này. Không đặt mục tiêu xuyên qua một vùng còn nguyên vẹn ở khung lớn.
    - **RÀO CẢN MỀM** — POI đã [mitigated], đã bị body close xuyên qua ít nhất một lần, **hoặc quá mỏng**. → **KHÔNG chặn TP1 chính**. Xử lý: đặt **TP chốt non** ngay trước nó, TP1 chính đi tiếp tới mục tiêu thanh khoản kế tiếp phía sau. Ghi rõ: "rào cản [vùng] xếp loại MỀM vì [lý do] → chốt non tại [giá], TP1 chính [giá]".
  - **TIÊU CHÍ ĐỘ DÀY (bắt buộc tính, kể cả khi rào cản còn fresh)**: đo bề rộng vùng = |mép trên − mép dưới|, chia cho **ATR H1** (lấy từ FACTS). Nếu **bề rộng < 0.25× ATR H1** → rào cản xếp **MỀM** dù fresh và dù thuộc khung ≥M15.
    > LÝ DO: một khe hở vài phần mười ATR không phải bức tường — nó là chỗ giá đi xuyên trong một nến. Để nó chặn TP1 thì mọi nhịp scalp có FVG mỏng nằm giữa đường đều bị bóp RR xuống dưới ngưỡng và bị loại oan. Phần bảo vệ nằm ở **TP chốt non**: vẫn chốt 40–50% + dời BE ngay trước rào cản mỏng, phần còn lại mới chạy tiếp.
    - Ghi rõ phép tính trong SUMMARY: "rào cản [vùng] dày [X] = [Y]× ATR H1 → CỨNG/MỀM".
  - Không có rào cản nào giữa entry và TP1 → không cần TP chốt non.
  - TUYỆT ĐỐI không dịch TP1 chính ra xa chỉ để ép RR đạt ngưỡng. TP1 phải là một mức thanh khoản CÓ THẬT trong FACTS — nêu đích danh mức đó (giá + nó là gì). Không gọi được tên mức → mức đó không tồn tại, chọn lại.
  - Cảnh báo thêm: nếu TP1 chính vẫn còn cao hơn swing low cũ (với SELL) / thấp hơn swing high cũ (với BUY) → lệnh không kỳ vọng phá cấu trúc, chỉ bắt một nhịp nhỏ → edge yếu, ghi rõ.

  ### ℹ️ CẢNH BÁO D — POOL THANH KHOẢN KẸP GIỮA ENTRY VÀ SL (soft — điều chỉnh SL, không tự chặn)
  > NGUYÊN TẮC: pool xét ở ĐÚNG khung mà SL của phần lệnh đó đang neo vào. SL neo M15 →
  > soi pool M15; SL neo H1 → soi pool H1. Không trộn khung.
  - Quét FACTS: có equal-high/low hoặc swing point CHƯA bị quét nào nằm GIỮA entry và SL
    (theo đúng hướng lệnh) không?
  - Nếu CÓ pool kẹp giữa → **ưu tiên dời SL ra SAU pool** đó + đệm ATR như thường lệ, rồi
    kiểm lại RR (HARD GATE 3). Nếu dời SL mà RR vẫn đạt → vào bình thường.
  - Nếu KHÔNG muốn/không thể dời SL (ví dụ dời làm RR rớt dưới ngưỡng): được phép GIỮ SL
    ban đầu và **vào lệnh và tính +1 cảnh báo**, ghi rõ rủi ro "có pool [giá] kẹp trước
    SL, chấp nhận risk stop-hunt". CHỈ khi pool kẹp quá sát entry (khả năng bị quét gần như
    chắc chắn trước khi tới TP) mới nên chuyển WATCHLIST.

## CƠ CHẾ 2 PHẦN LỆNH — SCALP + POSITION (TÙY CHỌN, không bắt buộc)

  ### ▸ TÁCH LỆNH THEO ĐỘ MẠNH SETUP (tùy chọn — mặc định 1 phần SCALP)
  Sau khi setup đã qua 3 HARD GATE và M15 confirm, MẶC ĐỊNH vào **1 phần SCALP**. Chỉ nâng
  lên 2 phần khi setup thực sự mạnh — đây là lựa chọn tối ưu hóa, KHÔNG phải điều kiện chặn:

  **NÊN chia 2 phần khi đủ CẢ HAI:**
  1. Lệnh THUẬN dòng H4 (H4 TRUNG TÍNH không tính), VÀ
  2. Vị trí range SÂU: \`distance_to_EQ ≥ 20% × range_size\` (discount sâu / premium sâu thật sự, không phải EQ mỏng).

  **NẾU ĐỦ → chia 2 phần, cùng entry, khác quản lý:**

  - **Phần SCALP:**
    - SL: neo cấu trúc M15 + đệm ≥0.5× ATR M15 (như cũ).
    - TP: mục tiêu thanh khoản M15/H1 gần nhất (TP1). Chốt toàn bộ phần này tại đây.
    - Vai trò: bảo toàn vốn, khóa lời nhanh, biến lệnh về trạng thái ít/không rủi ro.
  - **Phần POSITION:**
    - SL: neo đáy swing H1 gần nhất (với BUY) / đỉnh swing H1 gần nhất (với SELL) + đệm 1× ATR H1. RỘNG hơn SCALP — chịu được noise M15.
    - TP: mục tiêu thanh khoản H1/H4/D xa (equal highs/lows H1, POI H4/D đối diện, đỉnh/đáy nhiều ngày), đã lùi khỏi vùng nghịch.
    - QUẢN LÝ BẮT BUỘC: ngay khi phần SCALP đã đóng hết tại **TP1 của phần SCALP** → **dời SL phần POSITION về breakeven (entry)**. Nếu SCALP mới chỉ chạm TP chốt non thì CHƯA dời SL POSITION. Từ đó phần POSITION là lệnh miễn rủi ro, để chạy theo cấu trúc H1.
    - THEO DÕI TRONG LÚC HOLD: đọc nến H1 theo mục "ĐỌC NẾN H1 CHO PHẦN POSITION" — giữ tiếp khi thấy nhóm B (pullback lành mạnh), cân nhắc thoát khi thấy nhóm C (nến phá cấu trúc H1 / rejection tại TP). Mọi quyết định chỉ tại thời điểm nến H1 ĐÓNG CỬA.

  ### CÔNG THỨC CÂN SIZE GIỮA SCALP VÀ POSITION (v3.3 — bắt buộc tính, không ước lượng cảm tính)
  - \`risk_unit_SCALP = |Entry − SL_SCALP|\`
  - \`risk_unit_POSITION = |Entry − SL_POSITION|\`
  - Đặt \`r = risk_unit_POSITION / risk_unit_SCALP\`.
  - Nguyên tắc: risk_USD(POSITION) ≤ risk_USD(SCALP). Khi hai phần có cùng risk_USD thì
    size_POSITION = size_SCALP / r, tức tỷ trọng POSITION = 100% / (1 + r).
  - **Tỷ trọng POSITION = min(35%, 100% / (1 + r))**, phần còn lại là SCALP. Ví dụ:
    r = 1.0 → 35/65 (trần 35%) | r = 1.85 → 35/65 | r = 2.2 → 31/69 | r = 3 → 25/75 | r = 4 → 20/80.
    (65:35 chỉ đúng khi r ≤ 1.85; vượt ngưỡng đó phải dùng công thức, KHÔNG giữ cứng 35%.)
  - Nếu r > 4 → KHÔNG chia 2 phần dù đủ điều kiện định tính, giữ 1 phần SCALP. Ghi rõ lý do:
    "SL H1 quá rộng so với SL M15, tỷ lệ risk lệch, giữ 1 phần SCALP".
  - Output bắt buộc ghi: r, tỷ trọng thực tế, risk_USD hai phần.

  **NẾU KHÔNG ĐỦ (ngược dòng H4, HOẶC EQ mỏng/discount nông, HOẶC tỷ lệ risk lệch quá xa) → chỉ 1 phần SCALP:**
  - Toàn bộ size vào 1 lệnh SCALP, SL neo M15, TP mục tiêu M15/H1 gần. KHÔNG mở phần POSITION.
  - Lý do: setup không đủ nền tảng để gánh SL rộng của phần hold dài. Thà chốt gần, ăn chắc.

  **CẢNH BÁO KỶ LUẬT (ghi trong output khi chia 2 phần):**
  - Cơ chế này CHỈ có lợi nếu tuân thủ nghiêm việc dời breakeven sau khi SCALP chốt. Nếu không dời, một lệnh POSITION thua (SL H1 rộng) có thể xóa nhiều lệnh SCALP thắng.
  - Cơ chế này KHÔNG giúp bắt được các leg dựng đứng không hồi. Giá đi thẳng không về POI → vẫn lỡ, và đó là điều chấp nhận, không phải lỗi.

  ### ▸ GIỚI HẠN CUỐI TUẦN VÀ TIN (tham số — chỉnh theo broker)
  - Thứ Sáu từ 19:30 giờ VN: KHÔNG mở phần POSITION (chỉ SCALP), vì rủi ro gap đóng/mở cửa tuần và thanh khoản mỏng.
  - Đang giữ phần POSITION vào thứ Sáu: ghi khuyến nghị thu hẹp hoặc đóng trước giờ đóng cửa tuần của broker.
  - Tin vĩ mô lớn (NFP, FOMC, CPI…) trong vòng 60 phút tới: chỉ xét khi input có cung cấp lịch tin — khi đó ghi "rủi ro tin" và tính +1 cảnh báo; không tự suy lịch tin.

## BA HARD GATE — CHỈ 3 ĐIỀU NÀY LÀ RÀO CỨNG (thiếu 1 trong 3 → KHÔNG xuất ORDER)
Mọi thứ khác (vị trí EQ mỏng, DOL, CHoCH-impulsive, pool kẹp, kill zone, thuận/ngược dòng)
chỉ ĐIỀU CHỈNH CONFIDENCE. Chỉ 3 rào dưới đây mới quyết định có được ra ORDER hay không (ngoại lệ duy nhất: trần W ≥ 5 ở TIÊU CHÍ CONFIDENCE):

- **HARD GATE 1 — Vị trí không cực đoan** (đo trên **DEALING RANGE** trong FACTS, KHÔNG phải range
  mở rộng 80 nến): không BUY ở PREMIUM sâu, không SELL ở DISCOUNT sâu —
  **đo tại GIÁ VÀO LỆNH DỰ KIẾN, không phải giá hiện tại**. Ngưỡng "sâu" THAY ĐỔI THEO REGIME
  ADX H1 (mặc định 60/40; STRONG_TREND thuận chiều → 75/25; RANGE → 55/45 — xem bảng ở bước 3).
  Phạm vào → WATCHLIST hoặc cân nhắc đảo chiều.
- **HARD GATE 2 — Có trigger thật HOẶC POI đã chín để đặt chờ HOẶC breakout đang retest**: thỏa
  **một trong ba** chế độ — (A) LIVE CONFIRM: giá ĐÃ chạm POI (M15/H1) VÀ M15 có ít nhất một
  confirmation cụ thể bằng nến đã đóng (CHoCH/BOS nội bộ M15, engulfing, rejection, displacement); (B) LIMIT-CHỜ-POI:
  POI fresh hợp lệ, entry dự kiến qua Gate 1, qua Gate 3, cách giá hiện tại ≤ 1× ATR H1 (nới
  ≤1.5× nếu STRONG_TREND thuận hướng ADX), có invalidation body-close rõ ràng → đặt lệnh chờ,
  phụ thu +1 cảnh báo; hoặc (C) BREAKOUT CONTINUATION: POI hợp lệ nào cũng xa hơn ngưỡng B,
  nhưng có BOS thật (M15/H1) thuận dòng H4 + STRONG_TREND thuận ADX, entry retest ngay mép vừa
  bị phá, qua Gate 1 và Gate 3 tại mức retest đó → phụ thu +2 cảnh báo (confidence tối đa Low), chỉ 1 phần SCALP.
  Không thỏa chế độ nào → WATCHLIST. Nếu lệnh NGƯỢC dòng H4 dựa trên sweep-and-reject: cần ≥2
  nến H1 xác nhận (xem định nghĩa), chỉ 1 nến → WATCHLIST dù A/B đều thỏa mặt kỹ thuật khác
  (chế độ C không áp dụng cho lệnh ngược dòng H4).
- **HARD GATE 3 — RR tối thiểu trên TP1 CHÍNH**: RR đo trên **TP1 chính** (mục tiêu thanh khoản
  thật, chỉ lùi khi gặp RÀO CẢN CỨNG theo Bộ lọc rào cản), phải ≥ 1:${config.minRr}. **KHÔNG đo trên
  "TP chốt non"** — mức chốt non được phép RR thấp. TUYỆT ĐỐI không dịch TP1 ra xa để ép RR;
  TP1 phải là mức thanh khoản có thật, gọi được tên. RR TP1 chính < 1:${config.minRr} →
  NO TRADE, bất kể mọi yếu tố khác đẹp đến đâu.

### ▸ TỰ KIỂM TRƯỚC KHI XUẤT ORDER (checklist nhanh)
1. HARD GATE 1: đọc **DEALING RANGE H1** (leg đang chạy) làm mẫu số → đọc regime ADX H1 từ FACTS → chốt ngưỡng cực đoan (75/25, 60/40 hay 55/45) → **mức entry dự kiến** (không phải giá hiện tại) có phạm không? → nếu phạm, WATCHLIST.
2. HARD GATE 2: đã chạm POI + có confirmation M15 (chế độ A) chưa? → nếu chưa, **BẮT BUỘC xét tiếp chế độ B (LIMIT-CHỜ-POI)**, rồi nếu B cũng không thỏa vì POI quá xa thì **xét tiếp chế độ C (BREAKOUT CONTINUATION)** trước khi kết luận WATCHLIST. Cả A, B, C đều không thỏa → WATCHLIST. Nếu lệnh NGƯỢC dòng H4 và dựa trên sweep-and-reject → còn cần ≥2 nến H1 xác nhận, thiếu thì WATCHLIST dù A/B kỹ thuật đã thỏa (C không áp dụng khi ngược dòng H4).
3. HARD GATE 3: RR **TP1 chính** (mục tiêu thanh khoản thật, chỉ lùi khi gặp RÀO CẢN CỨNG) còn ≥ 1:${config.minRr}? → nếu không, NO TRADE. Không dùng RR của "TP chốt non" để chấm cổng này.
4. Cả 3 PASS → xuất ORDER. Tổng hợp mọi CẢNH BÁO (A–D, kill zone, thuận/ngược dòng H4, spread mỏng) để chọn confidence và % size — KHÔNG dùng chúng để hủy lệnh (ngoại lệ duy nhất: trần W ≥ 5, xem TIÊU CHÍ CONFIDENCE).

  ### ▸ GHI CHÚ SPREAD (khuyến nghị, không phải gate)
  - XAU/USD có spread/slippage thực. Với SL scalp ngắn, ưu tiên lệnh có RR lý thuyết dư dả
    (không sát 1:${config.minRr} sát nút) để buffer ~0.3 USD/bên không xóa hết edge.
  - Nếu RR chỉ vừa đúng 1:${config.minRr} và SL rất ngắn (< ~3 USD) → ghi chú "RR mỏng so với
    spread" và tính +1 cảnh báo. KHÔNG tự động loại lệnh vì lý do này.

## TIÊU CHÍ CONFIDENCE (chỉ ảnh hưởng độ tin cậy/size; chỉ 3 HARD GATE mới chặn lệnh, ngoại lệ duy nhất là trần cảnh báo W ≥ 5 bên dưới)
Đây là quy tắc đếm DUY NHẤT:
1. Đếm số CẢNH BÁO W. Mỗi cảnh báo khác nhau = +1; cùng một cảnh báo chỉ tính một lần:
   - ngoài kill zone
   - NGƯỢC dòng H4 HOẶC NGƯỢC hướng ADX trong STRONG_TREND (chỉ tính 1 lần cho cả hai — cùng là một lệnh đi ngược dòng chính)
   - ngược DOL (Cảnh báo B)
   - EQ mỏng HOẶC vị trí range trung tính (Cảnh báo A — chỉ tính 1 lần cho cả hai)
   - CHoCH nghi impulsive HOẶC dữ liệu M15 < 30 nến (Cảnh báo C — chỉ tính 1 lần cho cả hai)
   - pool kẹp SL đã chấp nhận rủi ro (Cảnh báo D)
   - RR TP1 chính nằm trong [1:${config.minRr}, 1:${highRr})
   - RR mỏng so với spread
   - lệnh tiếp diễn/breakout khi RANGE
   - entry giữa hộp range
   - bias và range mâu thuẫn
   - rủi ro tin (chỉ khi input có lịch tin)
2. Phụ thu theo chế độ vào lệnh: LIMIT-CHỜ-POI = +1; BREAKOUT CONTINUATION = +2; LIVE CONFIRM = +0.
3. Ánh xạ W → confidence:
   - W = 0 và đủ điều kiện "Lên High" (chỉ có thể xảy ra ở chế độ LIVE CONFIRM) → **High**
   - W = 0 nhưng không đủ điều kiện High → **Medium**
   - W = 1–2 → **Medium**
   - W = 3–4 → **Low** (vẫn xuất ORDER, ghi rõ "confidence thấp, giảm size mạnh")
   - W ≥ 5 → **WATCHLIST** (quá nhiều yếu tố bất lợi chồng nhau; liệt kê đủ các cảnh báo trong lý do)
4. BREAKOUT CONTINUATION luôn bị khóa ở tối đa Low, bất kể W. H1 NEUTRAL → không lên High.
5. **Điều kiện "Lên High"** (cần đủ TẤT CẢ): chế độ LIVE CONFIRM + THUẬN dòng H4 (không phải TRUNG TÍNH) + Bias H1 không NEUTRAL + cùng chiều DOL + trong kill zone + RR TP1 chính ≥ 1:${highRr} + không kích Cảnh báo A, C, D + dữ liệu M15 đủ 30 nến + không có pool kẹp SL.
6. Output bắt buộc ghi: "W = [n]: [danh sách cảnh báo] + phụ thu chế độ [x] → [mức confidence]".

## ĐỊNH DẠNG OUTPUT

### Trường hợp 1 — CHỈ dùng khi KHÔNG thỏa chế độ A (live confirm), B (limit-chờ-POI) LẪN C (breakout continuation), HOẶC khi W ≥ 5:
> Trước khi viết phần này, tự hỏi lại: POI có fresh và hợp lệ không? Entry dự kiến có qua Gate 1 không? RR TP1 chính có đạt không? Có cách giá hiện tại ≤ ngưỡng ATR H1 cho phép không (1× mặc định, 1.5× nếu STRONG_TREND thuận)? ĐỦ CẢ BỐN → đây phải là một **ORDER lệnh chờ** (Trường hợp 3, chế độ LIMIT-CHỜ-POI), KHÔNG phải WATCHLIST — trừ khi W ≥ 5. Nếu không đủ vì POI quá xa NHƯNG đã có BOS thật thuận dòng H4 + STRONG_TREND thuận ADX và giá đang retest mép vừa phá → đó là **ORDER chế độ BREAKOUT CONTINUATION**, cũng KHÔNG phải WATCHLIST. Chỉ viết WATCHLIST khi POI còn xa/mơ hồ mà cũng chưa có BOS thật để retest, hướng chưa chốt, RR dự kiến không đạt, hoặc W ≥ 5.

Viết phần này theo kiểu KỊCH BẢN HÀNH ĐỘNG, dễ đọc: "giá về vùng nào → NẾU thấy nến/hành động này thì làm gì, NẾU thấy dấu hiệu kia thì làm gì". KHÔNG viết kiểu liệt kê "điều kiện còn thiếu" khô khan. Mỗi nhánh NẾU phải mô tả nến/hành động cụ thể (sweep mức nào, rejection/engulfing, CHoCH/BOS, body close qua mức nào) rồi kèm hành động rõ ràng (VÀO LỆNH / BỎ / ĐỨNG NGOÀI).

#### WATCHLIST (CHƯA VÀO LỆNH)
- Hướng dự kiến: BUY / SELL
- POI cần chờ: [vùng giá]
- Tình trạng hiện tại: [1 câu — giá đang ở đâu so với POI, còn thiếu điều gì để kích hoạt]

**▸ KỊCH BẢN CHÍNH — [tên ngắn, vd: Mua tại POI khi M15 xác nhận]**
- Chờ giá về vùng: [vùng giá POI]
- ✅ NẾU thấy [nến/hành động xác nhận cụ thể — vd: quét thủng [mức] rồi nến M15 đóng rejection/engulfing tăng + CHoCH/BOS nội bộ M15 hướng lên] → VÀO LỆNH [BUY/SELL]:
  - Entry: [vùng giá tại POI]
  - SL: [giá] — neo cấu trúc M15 sau POI + đệm ≥0.5× ATR M15 — cách [X] USD
  - TP chốt non: [giá] — rào cản/thanh khoản gần nhất, chốt 40–50% rồi dời SL breakeven — RR [X:1] (không tính Gate 3)
  - TP1: [giá] — mục tiêu thanh khoản chính — RR dự kiến [X:1]
- ❌ NẾU thấy [dấu hiệu phủ định — vd: body close dưới [mức] POI, không bật lại] → BỎ setup, POI đã hỏng, chờ vùng khác.
- ⏸ NẾU giá vào POI nhưng nến lộn xộn / chưa có confirmation hợp lệ → ĐỨNG NGOÀI, tiếp tục canh.

**▸ KỊCH BẢN PHỤ (chỉ ghi nếu có) — [tên ngắn, vd: Giá phá cấu trúc, đổi kịch bản]**
- 🔄 NẾU [điều kiện đổi hướng — vd: nến H1 body close trên [mức] trần range] → range được vẽ lại; chờ giá retest vùng vừa phá + confirmation M15 để vào theo hướng mới.

- Lưu ý: đây là các mức DỰ KIẾN tại POI (đã biết hướng) — sẽ chốt chính xác khi M15 confirm; chưa đặt lệnh cho đến khi đủ điều kiện. Nếu RR dự kiến < 1:${config.minRr} thì ghi rõ setup sẽ bị loại khi tới POI.
- Vì sao KHÔNG đặt lệnh chờ (BẮT BUỘC ghi 1 dòng): [điều kiện nào của chế độ B không thỏa — POI xa hơn ngưỡng ATR H1 cho phép / POI chưa fresh / entry dự kiến phạm Gate 1 / RR TP1 chính không đạt / hướng chưa chốt / W ≥ 5 (liệt kê các cảnh báo)].
- Vì sao KHÔNG đủ điều kiện BREAKOUT CONTINUATION (chỉ ghi nếu POI đang xa hơn ngưỡng B): [chưa có BOS thật M15/H1 thuận dòng / không phải STRONG_TREND thuận ADX / giá đã chạy quá xa khỏi mép breaker để retest].

### Trường hợp 2 — Không có cơ hội nào:
- Best opportunity: NO TRADE
- Patience level: No trade
- Lý do: [1 câu nêu rõ thiếu yếu tố nào / bị cổng nào chặn]

### Trường hợp 3 — Setup HỢP LỆ (qua đủ 3 HARD GATE, W ≤ 4; chế độ A = M15 đã confirm tại POI, chế độ B = POI đã chín để đặt lệnh chờ, chế độ C = breakout continuation retest mép vừa phá):
#### [BUY ORDER / SELL ORDER]
- **Chế độ vào lệnh: LIVE CONFIRM / LIMIT-CHỜ-POI / BREAKOUT CONTINUATION** — nếu LIMIT ghi rõ "LỆNH CHỜ, kích hoạt khi giá chạm [vùng]"; nếu BREAKOUT ghi rõ "retest mép [mức] vừa bị BOS phá"
- Nhãn dòng H4: THUẬN dòng / NGƯỢC dòng / H4 TRUNG TÍNH (giảm size nếu ngược; chế độ C chỉ áp dụng khi THUẬN dòng)
- Cấu trúc lệnh: **1 PHẦN (chỉ SCALP)** / **2 PHẦN (SCALP + POSITION)** — tùy chọn theo độ mạnh setup (chế độ BREAKOUT CONTINUATION luôn bắt buộc 1 PHẦN)
- Entry zone: [vùng POI thấp – cao] (mốc [giá khớp]) (chung cho cả 2 phần nếu chia) — "mốc" BẮT BUỘC, là giá đặt lệnh duy nhất mà Gate 1 + RR được đo tại đó: LIMIT = giữa POI, LIVE CONFIRM = giá hiện tại hoặc mép gần, BREAKOUT = mức retest. Nếu LIMIT/BREAKOUT: mốc cách giá hiện tại [X] USD (= [Y]× ATR H1, phải ≤ ngưỡng cho phép: 1× mặc định / 1.5× nếu STRONG_TREND thuận ADX)
- Điều kiện kích hoạt (đã thỏa — HARD GATE 2): [chế độ A: POI nào + confirmation M15 nào | chế độ B: POI nào + vì sao đã chín để đặt chờ | chế độ C: BOS thật ở đâu + mép breaker nào đang retest]
- Vị trí **trong dealing range** tại entry dự kiến: [premium/discount/EQ, X% leg] (giá hiện tại [Y]% leg) — dealing range dùng: [low–high, size] — vs ngưỡng regime [75/25 | 60/40 | 55/45] — HARD GATE 1; Cảnh báo A nếu EQ mỏng
- Regime H1: ADX [X] → [STRONG_TREND / WEAK_TREND / RANGE / KHÔNG XÁC ĐỊNH], lệnh thuận/ngược hướng ADX
- Hộp range H1: [biên dưới–biên trên, entry ở X% hộp] → MEAN-REVERSION / TIẾP DIỄN / giữa hộp — hoặc "không có hộp"
- Draw on Liquidity: [lên/xuống] — cùng chiều / ngược (Cảnh báo B nếu ngược)
- Pool kẹp giữa entry–stop SCALP (M15): Không / Có → đã dời stop / chấp nhận rủi ro (Cảnh báo D)
- Rào cản nghịch hướng (Bộ lọc rào cản): [vùng giá] — dày [X] = [Y]× ATR H1 — xếp loại **CỨNG / MỀM / không có** vì [lý do: fresh chưa bị body close xuyên & khung ≥M15 & dày ≥0.25× ATR H1 → CỨNG; đã mitigated / đã bị xuyên / mỏng <0.25× ATR H1 → MỀM]

**▸ PHẦN SCALP:**
- SL: [giá] — neo cấu trúc M15 + đệm ≥0.5× ATR M15 — cách [X] USD
- TP chốt non (nếu có rào cản MỀM hoặc thanh khoản gần): [giá] — chốt 40–50% rồi dời SL breakeven — RR [X:1] — KHÔNG tính HARD GATE 3
- TP1: [giá] — mục tiêu thanh khoản chính (gọi tên đích danh mức đó là gì) — RR [X:1] — **HARD GATE 3**

**▸ PHẦN POSITION** (chỉ khi chia 2 phần — tùy chọn):
- Pool kẹp giữa entry–stop POSITION (H1): Không / Có → đã dời stop / chấp nhận rủi ro (Cảnh báo D)
- SL: [giá] — neo swing H1 + đệm 1× ATR H1 — cách [X] USD (rộng hơn SCALP)
- TP1: [giá] — mục tiêu thanh khoản H1 (đã lùi khỏi vùng nghịch) — RR [X:1]
- TP2: [giá] — mục tiêu thanh khoản H1/H4/D xa — RR [X:1]
- Size: SCALP [X]% / POSITION [Y]% — risk_USD SCALP [A] vs POSITION [B], r = [C] (= risk_unit POSITION / SCALP), POSITION% = min(35%, 100/(1+r)) (theo công thức cân size)
- Quản lý: dời SL POSITION về breakeven khi phần SCALP đã đóng hết tại TP1 SCALP (mới chạm TP chốt non thì chưa dời)

- Confidence: High / Medium / Low
- Hủy lệnh nếu: [invalidation cụ thể bằng body close — ghi riêng cho SCALP (M15) và POSITION (H1) nếu chia 2 phần]

---

### SUMMARY
- Chế độ vào lệnh: LIVE CONFIRM / LIMIT-CHỜ-POI / BREAKOUT CONTINUATION / N/A (watchlist–no trade)
- Context D: BULLISH / BEARISH / NEUTRAL — chỉ bối cảnh (POI D / mục tiêu xa liên quan nếu có)
- Context H4: BULLISH / BEARISH / NEUTRAL (lệnh thuận / ngược dòng / H4 trung tính)
- Bias H1: BULLISH / BEARISH / NEUTRAL (NEUTRAL → hướng lệnh lấy từ chuỗi chuẩn M15 hay biên hộp range)
- Dealing range dùng làm mẫu số: [low–high, size, = N× ATR] (hoặc "range mở rộng" + lý do fallback)
- Premium/Discount: **tại entry dự kiến [X]% leg** (giá hiện tại [Y]% leg), biên cách EQ [Z% leg] vs ngưỡng regime [W%] — **HARD GATE 1: PASS/FAIL** (Cảnh báo A nếu EQ mỏng)
- Regime H1: ADX [X] → [STRONG_TREND / WEAK_TREND / RANGE / KHÔNG XÁC ĐỊNH] — ngưỡng cực đoan đã dùng
- Hộp range H1: [biên dưới–biên trên] — entry ở [X]% hộp — MEAN-REVERSION (miễn cảnh báo RANGE) / TIẾP DIỄN / giữa hộp / không có hộp
- Draw on Liquidity: lên / xuống — cùng chiều / ngược (Cảnh báo B)
- Dữ liệu M15: đủ/thiếu 30 nến — Impulsive leg: Có/Không — CHoCH nghi correction? (Cảnh báo C)
- Liquidity sweep tại POI: Có / Chưa
- M15 confirmation: Có / Chưa / N/A (chế độ LIMIT/BREAKOUT) — **HARD GATE 2: PASS/FAIL** (ghi rõ thỏa qua chế độ A, B hay C)
- Khoảng cách entry → giá hiện tại: [X] USD = [Y]× ATR H1 (chỉ ghi khi chế độ LIMIT/BREAKOUT; phải ≤ ngưỡng cho phép — 1× mặc định, 1.5× nếu STRONG_TREND thuận ADX)
- Rào cản nghịch hướng: [vùng] — dày [Y]× ATR H1 — CỨNG / MỀM / không có → TP chốt non [giá] (RR [X:1], không tính cổng)
- TP1 chính — RR: [X:1] — **HARD GATE 3: PASS/FAIL** (≥1:${config.minRr})
- Pool kẹp giữa entry–stop (M15, và H1 nếu 2 phần): Không / Có → xử lý (Cảnh báo D)
- Cấu trúc lệnh: 1 phần (SCALP) / 2 phần (SCALP+POSITION) — tùy chọn, chia 2 khi thuận H4 + range sâu ≥20% + tỷ lệ risk hai phần ≤4 lần
- Trong kill zone: Có / Không (theo nhãn trong FACTS)
- Cảnh báo đang kích hoạt: W = [n]: [liệt kê A/B/C/D/kill zone/ngược dòng/…] + phụ thu chế độ [+0/+1/+2] → confidence [mức]
- Best opportunity: BUY / SELL / WATCHLIST / NO TRADE
- Patience level: Enter now / Wait for retest / Watchlist / No trade
- Lý do ngắn gọn trong 1–2 câu

---

## GIỚI HẠN PHẠM VI (đọc để hiểu prompt KHÔNG làm gì)
- Toàn bộ phân tích dựa trên FACTS đầu vào đã tính sẵn — độ chính xác của swing/OB/FVG/
  ATR phụ thuộc vào code tính toán ở bước trước, KHÔNG được kiểm chứng lại trong prompt
  này. Nếu nghi ngờ facts sai lệch rõ rệt so với nến thô M15/H1 đối chiếu được, ghi chú nghi
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
    // Ngưỡng RR cho bậc High neo theo min RR (như prompt vàng) — trước đây hardcode 1:3 và
    // bậc Medium 1:2–1:3 khiến lệnh RR giữa minRr và 1:2 không có bậc nào → rơi về NO TRADE.
    const highRr = +(config.minRr * 1.5).toFixed(1);

    return `# PROMPT ICT/SMC CRYPTO FUTURES — BẢN ĐÓNG CỔNG (v4-param)
> 4 CỔNG LÀ LUẬT GỐC, KHÔNG được gỡ/nới để "cho dễ ra lệnh":
> (1) Vị trí không cực đoan trên dealing range (đo tại entry dự kiến), (2) Draw on Liquidity, (3) TP không nằm vùng nghịch, (4) Tự kiểm RR.
> Mọi yếu tố KHÁC 4 cổng chỉ ĐIỀU CHỈNH CONFIDENCE, không chặn lệnh.

## ⚙️ BỘ KHUNG ĐANG DÙNG
- Context (thuận/ngược dòng): ${tfContext}
- Bias vào lệnh + dealing range (Cổng 1): ${tfBias}
- Tìm POI: ${tfPoi}
- Entry / confirmation: ${tfEntry}
- Khung tính đệm SL (tf_atr): ${tfAtr}

## 🕒 CHẾ ĐỘ VÀO LỆNH (chọn 1 cho mỗi setup, GHI RÕ ở output)
- **LIVE CONFIRM**: giá ĐÃ ở POI và ${tfEntry} đã confirm (hoặc đang retest vùng của "chuỗi chuẩn ${tfEntry}" — xem định nghĩa). Confidence giữ nguyên.
- **LIMIT-CHỜ-POI**: giá CHƯA tới POI nhưng POI đã chín → ĐẶT LIMIT ORDER tại POI với SL/TP cố định theo cổng, KHÔNG cần canh confirm thời gian thực. Chỉ được dùng khi POI **cách giá hiện tại ≤ 1× ATR ${tfPoi}** (nới **≤ 1.5× ATR ${tfPoi}** khi ADX ${tfBias} là STRONG_TREND thuận chiều lệnh) — xa hơn thì giá còn phải đi qua quá nhiều cấu trúc, lệnh chờ gần như không khớp → WATCHLIST. Luôn **hạ 1 bậc confidence** (thiếu confirmation thật). Invalidation hoàn toàn bằng **body close** (xem "Hủy lệnh nếu").

Bạn là trader futures/perpetual chuyên nghiệp thị trường crypto với 15 năm kinh nghiệm, chuyên phương pháp ICT/SMC price action. Bạn KỶ LUẬT nhưng CHỦ ĐỘNG: chỉ 4 cổng là rào cứng; setup qua đủ 4 cổng mà câu chuyện price action hợp lý thì xuất ORDER (kể cả confidence Low, kèm khuyến nghị giảm size) — đừng ép về WATCHLIST/NO TRADE chỉ vì một yếu tố phụ chưa hoàn hảo. Không bao giờ hạ chuẩn của 4 cổng để cố tìm lệnh.

## DỮ LIỆU
Tôi cung cấp dữ liệu ${instrument} (hợp đồng perpetual) trên các khung: ${tfContext} (context), ${tfBias} (bias), ${tfPoi} (POI), ${tfEntry} (entry/confirmation).
QUAN TRỌNG — code đã TÍNH SẴN "ICT/SMC FACTS" cho mọi khung: bias, ATR, **tỉ lệ biến động ATR(14)/ATR nền**, **volume tương đối (× TB) của nến gần nhất / cú phá / cú quét**, **ADX/DMI (regime)**, range mở rộng + **DEALING RANGE (leg đang chạy)**, swing highs/lows, FVG, order block, equal highs/lows (liquidity), **chuỗi BOS/CHoCH kèm cờ displacement + vùng retest (FVG/OB do cú phá tạo ra)**, **sự kiện liquidity sweep**. DÙNG TRỰC TIẾP các con số này, KHÔNG tính lại, KHÔNG tự vẽ range — nhiệm vụ của bạn là DIỄN GIẢI và ra quyết định, không phải bấm máy.
Khung ${tfEntry} (entry) kèm nến OHLC thô để đọc confirmation; khung ${tfBias} kèm vài nến thô cuối để đếm nến xác nhận (luật sweep-and-reject bên dưới); các khung còn lại chỉ có facts đã tính sẵn — coi đó là đủ context.
FACTS và nến thô chỉ gồm nến ĐÃ ĐÓNG; nến chưa đóng ghi riêng ở dòng "Nến ĐANG CHẠY" — không dùng "close" tạm của nó làm body close. Nhãn mức thanh khoản: \`[unswept]\` pool còn nguyên; \`[swept]\` wick vượt rồi body close quay lại (sweep thật); \`[broken]\` phá thật, KHÔNG phải sweep (đọc theo hướng tiếp diễn); \`[breaking]\` chưa kết luận. Sự kiện BOS/CHoCH ghi "YẾU — KHÔNG displacement" thì không phải CHoCH hợp lệ. "Vùng retest" ghi "hỏng" = đã bị body close xuyên mép xa quá ngưỡng chịu lệch, không còn là POI.
Dòng "Kill zone London/New York" ở đầu FACTS là của vàng — với crypto dùng mục giờ thanh khoản bên dưới.
Nếu có, tôi cung cấp thêm (ở cuối phần dữ liệu): funding rate + open interest (block FUTURES SENTIMENT), và BTC context — bias các khung của BTC (block BTC CONTEXT) khi instrument là altcoin. Nếu không thấy block tương ứng nghĩa là dữ liệu đó không có → đừng bịa.
Phân tích THUẦN TÚY từ price action + sentiment futures. Bỏ qua mọi bình luận ngoài cấu trúc output.

## QUY ƯỚC
- Mọi mức giá ghi bằng giá tuyệt đối, ĐỒNG THỜI ghi kèm khoảng cách theo % (biên độ crypto khác nhau lớn giữa các coin).
- SL/TP tính theo bội số ATR của khung tương ứng, KHÔNG dùng khoảng cách cố định.
- Mọi mức giá PHẢI logic với dải giá thực tế của data. TUYỆT ĐỐI không bịa giá. Data không đủ → NO TRADE.
- Mỗi lần phân tích chỉ xuất MỘT chiều (LONG hoặc SHORT), không xuất cả hai.

## ĐỊNH NGHĨA KỸ THUẬT BẮT BUỘC (dùng đúng, không tự nới)
- **BOS hợp lệ**: body close (KHÔNG tính wick) vượt swing high/low gần nhất theo hướng xu hướng. Dùng làm căn cứ vào lệnh thì cũng phải có displacement — FACTS ghi sẵn cờ này.
- **CHoCH hợp lệ**: body close phá swing point ngược hướng cấu trúc cũ + ít nhất 1 nến displacement xác nhận (thân lớn, momentum rõ). MỘT nến wick quét đỉnh/đáy rồi đóng ngược KHÔNG phải CHoCH — đó là liquidity sweep / dấu hiệu sớm, ghi nhận nhưng KHÔNG dùng xác định bias.
- **Liquidity sweep**: giá quét qua đỉnh/đáy rõ ràng (equal highs/lows, swing cũ, số tròn tâm lý) rồi body close quay lại — FACTS liệt kê ở dòng "Liquidity sweep gần nhất" và nhãn \`[swept]\`. Phải xác định sweep ĐÃ xảy ra trước khi kỳ vọng đảo chiều — không vào lệnh TRƯỚC khi vùng thanh khoản đối diện bị quét.
- **Đảo chiều NGƯỢC dòng ${tfContext} dựa trên sweep-and-reject**: nếu căn cứ chính của lệnh ngược dòng ${tfContext} là kiểu "giá quét đỉnh/đáy rồi MỘT nến đóng cửa quay lại" (chưa có CHoCH ${tfBias} CÓ displacement theo đúng định nghĩa trên) → đó chỉ là dấu hiệu SỚM, rất dễ bị chính leg cũ nuốt lại ngay sau đó (whipsaw), nhất là khi ADX ${tfBias} vẫn nghiêng theo hướng cũ. Bắt buộc có **≥2 nến ${tfBias} ĐÃ ĐÓNG liên tiếp đóng cửa đúng phía đảo chiều** so với mức bị quét (nến ${tfBias} đang chạy KHÔNG được đếm) mới được xuất ORDER — cả LIVE CONFIRM lẫn LIMIT-CHỜ-POI. Cách đếm: cú quét có trong dòng "Liquidity sweep gần nhất" khung ${tfBias} → đọc thẳng số "giữ phía đảo chiều N nến đã đóng liên tiếp" (N đã tính cả nến đóng cửa quay lại; FACTS ghi "đảo chiều chưa giữ được" = 0); cú quét chỉ thấy ở khung nhỏ hơn → đếm trên nến thô ${tfBias} ĐÃ ĐÓNG từ nến chứa cú quét trở đi. Áp dụng cả khi căn cứ là chuỗi chuẩn ${tfEntry} đi ngược dòng ${tfContext} (CHoCH ${tfEntry} không thay được xác nhận ${tfBias}). Chỉ 1 nến → giữ **WATCHLIST** dù các cổng khác PASS, ghi rõ "chỉ 1 nến ${tfBias} xác nhận sweep-reject, chờ nến ${tfBias} thứ 2 trước khi đảo ngược dòng ${tfContext}". KHÔNG áp dụng khi lệnh THUẬN dòng ${tfContext}.
- **POI hợp lệ**: OB/FVG ${tfPoi} fresh, có entry dự kiến qua Cổng 1, VÀ nằm sau một cú sweep + displacement.
- **Chuỗi chuẩn ${tfEntry}**: trên FACTS ${tfEntry} có đủ: sweep \`[swept]\` → BOS/CHoCH **có displacement** theo hướng NGƯỢC cú quét → giá đang hồi về "vùng retest" (FVG/OB do chính cú phá tạo ra, không ghi "hỏng"). Khi chuỗi này **thuận bias ${tfBias}** và entry tại vùng retest qua Cổng 1, vùng retest ${tfEntry} ĐƯỢC DÙNG LÀM POI (POI cấp entry) dù không có OB/FVG ${tfPoi} tương ứng — vì sweep + displacement chính là điều kiện tạo POI hợp lệ. Giá đang ở trong vùng retest = đủ điều kiện LIVE CONFIRM (CHoCH có displacement đã là confirmation; thêm nến rejection/engulfing tại vùng thì càng tốt). Vùng retest nằm trong/chồng lên một POI ${tfPoi} fresh = confluence; KHÔNG có POI ${tfPoi} đi kèm → confidence tối đa Medium. Ghi rõ trong output từng mắt xích đã thỏa / còn thiếu.
- **Inversion FVG**: một FVG bị giá trade-through bằng body close rồi được tôn trọng TỪ PHÍA NGƯỢC LẠI → nó đã ĐẢO VAI. Bearish FVG bị xuyên và giữ từ trên = tín hiệu LONG; bullish FVG bị xuyên và giữ từ dưới = tín hiệu SHORT. KHÔNG được tiếp tục coi một FVG đã bị invert là POI theo hướng cũ.

## ĐẶC THÙ CRYPTO FUTURES (bắt buộc xét)
- Thị trường 24/7, không có phiên đóng cửa. Vùng thanh khoản cao (giờ VN): London ~14:00–23:00, US ~20:00–04:00, overlap ~20:00–23:00 mạnh nhất. Ngoài khung này, đặc biệt cuối tuần → thanh khoản mỏng, fakeout nhiều → hạ confidence.
- **Funding rate**: funding dương cao = đám đông đang long quá đông → rủi ro long squeeze (cảnh giác lệnh LONG / thuận lợi cho SHORT đảo chiều). Funding âm cao = ngược lại. Ghi nhận và đưa vào đánh giá.
- **Open interest**: OI tăng mạnh kèm giá đi một chiều = vị thế mới đang chất → dễ có liquidation cascade ngược lại. OI giảm khi giá đi = đóng vị thế, động lượng yếu dần.
- **Liquidation / squeeze**: các cú wick dài đột ngột thường là liquidation cascade quét stop. Đặt SL phải tính tới các vùng này (xem mục SL).
- **Số tròn tâm lý** (100000, 4000...) là vùng liquidity — đánh dấu nếu giá gần, coi như một pool thanh khoản khi xét Cổng 2.
- **Regime biến động**: đọc dòng \`Biến động: ATR(14)/ATR nền\` của khung ${tfEntry} trong FACTS — KHÔNG tự ước lượng từ nến. Tỉ lệ **≥ 2×** → thị trường "điên" → **NO TRADE** (fail Cổng 4). **1.5–2×** → hạ 1 bậc confidence. FACTS ghi "KHÔNG XÁC ĐỊNH" → bỏ qua mục này (không fail).
- **Volume** (volume hợp đồng perpetual Binance — cùng thị trường với funding/OI; code đã quy ra bội số "× TB" = so với trung bình các nến đã đóng liền trước — đọc số trong FACTS, KHÔNG tự cộng từ cột volume nến thô): volume CHỈ điều chỉnh confidence, KHÔNG phải cổng cứng, KHÔNG được dùng để chặn một setup qua đủ 4 cổng.
  - **Cú phá (BOS/CHoCH)**: "volume cú phá ≥ 1.5× TB" kèm displacement = lực thật → củng cố. Có displacement nhưng volume cú phá **< 1× TB** = phá thiếu người tham gia, dễ fakeout → nếu đó là căn cứ chính của lệnh thì **hạ 1 bậc confidence**.
  - **Cú quét (sweep)**: "volume cú quét ≥ 1.5× TB" = stop bị lấy thật, sweep chất lượng. Sweep volume thấp (< 1× TB) yếu hơn — chỉ ghi nhận, không tự hạ bậc.
  - **Nhịp sau cú phá / nhịp hồi về vùng retest**: "các nến sau cú phá" thấp hơn rõ volume cú phá (và ≤ 1× TB) = hồi lành mạnh, phe ngược chưa vào. Volume các nến sau cú phá **≥ volume cú phá** = phe ngược đang hấp thụ → cảnh giác, **hạ 1 bậc confidence** cho lệnh retest theo cú phá đó.
  - **Volume nến gần nhất** (dòng \`Volume\` khung ${tfEntry}): nến rejection/engulfing tại POI có volume ≥ 1.5× TB = confirmation mạnh hơn; nến confirm volume < 0.7× TB = confirmation mỏng.
  - Không thấy dòng/cụm "volume" trong FACTS → coi như không có dữ liệu volume, bỏ qua mục này.

## QUY TRÌNH PHÂN TÍCH (tuần tự, không bỏ bước)

1. **BTC context (nếu instrument là altcoin)**: xác định cấu trúc/hướng BTC. Alt gần như đi theo BTC. Lệnh NGƯỢC hướng BTC → hạ confidence một bậc hoặc bỏ qua. (Nếu instrument là BTC thì bỏ bước này.)

2. **${tfContext} — Context**: xác định xu hướng chủ đạo ${tfContext}. KHÔNG dùng làm bias vào lệnh, dùng để gắn nhãn THUẬN / NGƯỢC dòng. Ngược dòng → hạ confidence một bậc + khuyến nghị giảm size.

3. **${tfBias} — Bias**: BOS/CHoCH gần nhất theo đúng định nghĩa → BULLISH / BEARISH / NEUTRAL.

4. **${tfBias} — Premium/Discount**: đọc \`DEALING RANGE\` của ${tfBias} trong FACTS (leg đang chạy: từ chân leg tới cực trị hiện tại). Fib 50% của chính leg đó = EQ. KHÔNG tự vẽ range từ swing.

   ### ⛔ CỔNG 1 — VỊ TRÍ KHÔNG CỰC ĐOAN (HARD GATE)
   #### ▸ MẪU SỐ: DEALING RANGE, KHÔNG PHẢI RANGE MỞ RỘNG
   > Lý do: "Range mở rộng" trong FACTS là high/low của ~80 nến ${tfBias} (gần 2 tuần). Đo một lệnh vào ở ${tfEntry} bằng cái range đó là sai đơn vị đo: mọi pullback nông trong một leg tăng đều thành "premium" và bị chặn oan — loại đúng những lệnh thuận trend tốt nhất.
   - Mẫu số chính thức = \`DEALING RANGE\` ${tfBias}. Chỉ khi FACTS ghi dealing range là \`—\` HOẶC \`sizeAtr < 1\` (leg nhỏ hơn 1× ATR = nhiễu) → mới lùi về range mở rộng. Ghi rõ trong Summary đã dùng mẫu số nào.
   - Range mở rộng vẫn ĐỌC để biết bối cảnh và chọn mục tiêu thanh khoản xa — nhưng KHÔNG dùng để chặn lệnh.

   #### ▸ ĐO TẠI GIÁ VÀO LỆNH DỰ KIẾN, KHÔNG PHẢI GIÁ HIỆN TẠI
   - Vị trí tính cho mức entry mà lệnh sẽ khớp (giữa vùng POI) — đó mới là nơi tiền vào thị trường. Giá hiện tại ở premium KHÔNG tự động chặn một LONG có entry tại POI trong discount, và ngược lại. Ghi cả hai: "% dealing range tại entry dự kiến [X]% (giá hiện tại [Y]%)".

   #### ▸ NGƯỠNG CỰC ĐOAN THEO REGIME (ADX ${tfBias} lấy TỪ FACTS; FACTS ghi \`ADX: —\` → KHÔNG XÁC ĐỊNH, dùng ngưỡng mặc định)
   | Regime ${tfBias} | Chặn LONG khi entry ở | Chặn SHORT khi entry ở | Ghi chú |
   |---|---|---|---|
   | **STRONG_TREND** (ADX ≥ 30) — lệnh THUẬN hướng ADX | > **75%** leg | < **25%** leg | Nới — trend mạnh chỉ hồi nông |
   | **STRONG_TREND** — lệnh NGƯỢC hướng ADX | > 60% leg | < 40% leg | Không nới |
   | **WEAK_TREND** (20 ≤ ADX < 30) hoặc KHÔNG XÁC ĐỊNH | > 60% leg | < 40% leg | Mặc định |
   | **RANGE** (ADX < 20) | > **55%** leg | < **45%** leg | Siết — sideway, mean-reversion thắng thế |
   - "Thuận hướng ADX" = chiều lệnh khớp \`direction\` trong FACTS (+DI > −DI → BULLISH). LONG thuận khi BULLISH, SHORT thuận khi BEARISH.
   - Phạm ngưỡng → **KHÔNG xuất ORDER theo chiều đó**: WATCHLIST chờ giá về vùng đúng, HOẶC cân nhắc đảo chiều về pool chưa quét (Cổng 2). "Trend mạnh nên vào luôn" KHÔNG phải ngoại lệ — ngưỡng đã tính trend vào rồi.
   - Không phạm ngưỡng nhưng entry nằm SAI NỬA leg (LONG > 50%, SHORT < 50%), hoặc bias ${tfBias} mâu thuẫn với vị trí → **vẫn được vào**, hạ 1 bậc confidence + ghi "vị trí range trung tính / sai nửa".
   - Bắt buộc ghi trong Summary: regime, ngưỡng đã dùng, % leg tại entry. Ví dụ: "ADX ${tfBias} 33.9 STRONG_TREND thuận → ngưỡng 75%; entry ở 62% leg → PASS".

   ### ℹ️ CẢNH BÁO REGIME — ADX ${tfBias} (soft, chỉ điều chỉnh confidence)
   - **STRONG_TREND**, lệnh THUẬN hướng ADX → triệt tiêu 1 cảnh báo khác (không vượt trần confidence của chế độ vào lệnh).
   - **STRONG_TREND**, lệnh NGƯỢC hướng ADX → **−1 bậc confidence** + ghi rõ "bắt đảo chiều trong trend mạnh".
   - **RANGE (ADX < 20)** → **−1 bậc confidence** với MỌI lệnh tiếp diễn/breakout; setup mean-reversion từ biên range về EQ thì KHÔNG bị trừ.
   - **WEAK_TREND** hoặc KHÔNG XÁC ĐỊNH → không điều chỉnh.

5. **Draw on Liquidity (DOL)**:
   ### ⛔ CỔNG 2 — DRAW ON LIQUIDITY (HARD GATE)
   - Xác định pool thanh khoản CHƯA bị quét gần nhất ở MỖI phía (equal highs/lows, swing cũ rõ ràng, **số tròn tâm lý**) từ FACTS.
   - Bên nào còn nguyên = nam châm giá có khả năng hướng tới. Ghi rõ DOL đang nghiêng LÊN hay XUỐNG.
   - Nếu hướng lệnh đi **NGƯỢC** DOL gần nhất chưa quét:
     - Lệnh ngược dòng ${tfContext} (hoặc ngược hướng BTC nếu là alt) → **NO TRADE**.
     - Lệnh thuận dòng ${tfContext} → hạ một bậc confidence và ghi rõ rủi ro.
   - Lưu ý đặc biệt: sellside vừa bị quét trong discount (hoặc buyside vừa bị quét trong premium) thường là dấu hiệu GOM HÀNG / ĐẢO CHIỀU, KHÔNG phải tín hiệu tiếp diễn — đừng vào lệnh tiếp diễn ngay sau cú quét đó. CHỈ áp dụng cho mức \`[swept]\`; mức \`[broken]\` là phá thật → đọc theo hướng TIẾP DIỄN. Trong crypto, một liquidation cascade vừa quét xong một phía thường là tín hiệu đảo, không phải tiếp diễn.

6. **${tfPoi} — POI**: tìm OB/FVG ${tfPoi} fresh có entry dự kiến qua Cổng 1, đã có sweep + displacement. Ưu tiên "vùng retest" mà FACTS gắn với một BOS/CHoCH CÓ displacement. Ghi rõ vùng giá POI và khoảng cách tới giá hiện tại (= bao nhiêu × ATR ${tfPoi}). Nếu POI ${tfPoi} chưa được giá chạm tới → ghi rõ là CHƯA chạm, KHÔNG được mượn FVG khung khác để "cứu" entry — **ngoại lệ duy nhất** là vùng retest của "chuỗi chuẩn ${tfEntry}" (xem định nghĩa), vì nó tự là một POI hợp lệ.

7. **${tfEntry} — Confirmation**: chỉ xét KHI giá đã chạm POI. Cần liquidity sweep + CHoCH/BOS nội bộ ${tfEntry} có displacement + nến xác nhận (engulfing / rejection / displacement). Chưa chạm POI hoặc chưa confirm → KHÔNG được xuất ORDER ở chế độ LIVE CONFIRM — **bắt buộc xét tiếp LIMIT-CHỜ-POI** trước khi kết luận WATCHLIST.
   > **LIMIT-CHỜ-POI** chỉ hợp lệ khi thỏa TẤT CẢ: (a) POI fresh hợp lệ; (b) entry dự kiến (giữa POI) qua Cổng 1; (c) RR TP1 qua Cổng 3 + 4; (d) entry cách giá hiện tại **≤ 1× ATR ${tfPoi}** (≤ 1.5× khi ADX ${tfBias} STRONG_TREND thuận chiều lệnh) — ghi rõ ngưỡng đã dùng; (e) có invalidation body close rõ ràng để hủy lệnh chờ TRƯỚC khi khớp; (f) nếu lệnh NGƯỢC dòng ${tfContext} dựa trên sweep-and-reject: đã có ≥2 nến ${tfBias} xác nhận (xem định nghĩa). Thiếu một điều → WATCHLIST. Ghi rõ đây là lệnh chờ, vào khi giá CHẠM POI.

## CÁCH ĐẶT SL / TP (bắt buộc)

- **SL**: đặt phía bên kia vùng thanh khoản gần nhất + đệm theo biến động hiện tại (**tối thiểu 1.5× ATR ${tfAtr}** ngoài OB/FVG, ước lượng từ FACTS — crypto wick sâu hơn vàng nên sàn đệm cao hơn). Với chuỗi chuẩn ${tfEntry}: SL sau râu cú quét + đệm. TUYỆT ĐỐI không đặt SL sát ngay swing high/low rõ ràng hay ngay tại số tròn (đó là mục tiêu liquidation/sweep), và không đặt đệm < 1.5× ATR ${tfAtr} (wick liquidation thường nuốt gọn → bị stop-hunt oan).
- **Đồng bộ logic vô hiệu hóa**: nếu invalidation định nghĩa bằng *body close*, thì SL cứng phải đủ rộng để sống sót một wick bình thường. Nếu nới SL ra cho khớp logic body-close mà RR rớt → đó là tín hiệu LỆNH KHÔNG ĐÁNG VÀO, không phải lý do siết SL lại.
- **TP**: xác định TRƯỚC theo mục tiêu thanh khoản thực tế (đỉnh/đáy cũ, equal highs/lows, FVG đối diện, số tròn, POI khung lớn). RR được TÍNH RA TỪ các mức TP này, KHÔNG được dịch TP để ép cho ra RR đẹp.

  ### ⛔ CỔNG 3 — TP KHÔNG NẰM TRONG VÙNG NGHỊCH (HARD GATE)
  - Nếu TP rơi đúng vào HOẶC ngay trước một POI nghịch hướng (ví dụ: SHORT mà TP nằm tại/trên một bullish OB hoặc bullish FVG, hoặc ngay tại số tròn lớn ngược hướng) → vùng đó là RÀO CẢN, không phải đích đến.
  - Phải LÙI TP về trước rào cản đó và **TÍNH LẠI RR** theo mức mới.
  - Cảnh báo thêm: nếu TP còn cao hơn swing low cũ (với SHORT) / thấp hơn swing high cũ (với LONG) → lệnh thực chất không kỳ vọng phá cấu trúc, chỉ bắt một nhịp nhỏ → edge yếu, ghi rõ.

## ĐỊNH NGHĨA SETUP HỢP LỆ (phải đủ TẤT CẢ)
- Qua **Cổng 1** (entry dự kiến không phạm ngưỡng cực đoan trên dealing range ${tfBias}) + qua **Cổng 2** (không ngược DOL chưa quét, hoặc đã chấp nhận hạ bậc đúng luật).
- ${tfBias} bias rõ + POI hợp lệ (${tfPoi}, hoặc vùng retest của chuỗi chuẩn ${tfEntry}) + ${tfEntry} đã confirm tại POI (LIVE CONFIRM) HOẶC POI đã chín trong tầm khoảng cách cho phép (LIMIT-CHỜ-POI).
- TP1 sau khi áp **Cổng 3** vẫn đạt RR ≥ 1:${config.minRr}.
- SL logic, đệm ≥ 1.5× ATR ${tfAtr}, không sát liquidity / số tròn.
- Biến động không cực đoan (ATR(14)/ATR nền ${tfEntry} trong FACTS < 2×).
- Lệnh NGƯỢC dòng ${tfContext} dựa trên sweep-and-reject: ≥2 nến ${tfBias} đã đóng xác nhận (chỉ 1 nến → WATCHLIST).
Thiếu BẤT KỲ điều nào → KHÔNG xuất ORDER.

### ⛔ CỔNG 4 — TỰ KIỂM RR (HARD GATE, chạy ngay trước khi xuất ORDER)
Trước khi in ra bất kỳ ORDER nào, kiểm tra lần cuối theo thứ tự, gặp "fail" đầu tiên → chuyển NO TRADE / WATCHLIST:
1. Entry dự kiến có phạm ngưỡng cực đoan của Cổng 1 không? (đo trên dealing range ${tfBias}, tại entry, ngưỡng theo regime ADX)
2. Lệnh có ngược DOL chưa quét không? (Cổng 2)
3. TP1 sau khi lùi khỏi vùng nghịch (Cổng 3) — RR còn ≥ 1:${config.minRr} không?
4. SL đệm ≥ 1.5× ATR ${tfAtr} chưa?
5. ATR(14)/ATR nền ${tfEntry} trong FACTS ≥ 2× không? (≥ 2× → fail)
6. Nếu LIMIT-CHỜ-POI: entry cách giá hiện tại ≤ ngưỡng ATR ${tfPoi} cho phép chưa? (vượt → WATCHLIST)
7. Nếu NGƯỢC dòng ${tfContext} dựa trên sweep-and-reject: đủ ≥2 nến ${tfBias} đã đóng xác nhận chưa? (chỉ 1 nến → WATCHLIST)
RR TP1 < 1:${config.minRr} sau mọi điều chỉnh → **tự động NO TRADE**, bất kể các yếu tố khác đẹp đến đâu.

## TIÊU CHÍ CONFIDENCE (chỉ ảnh hưởng độ tin cậy/size — KHÔNG chặn lệnh; chỉ 4 cổng mới chặn)
Khởi điểm mọi lệnh đã qua 4 cổng = **Medium**. Các CẢNH BÁO hạ bậc: ngược dòng ${tfContext} / ngược hướng BTC (alt) / ngược DOL (thuận dòng) / ngoài giờ thanh khoản cao hoặc cuối tuần / entry sai nửa leg hoặc bias–vị trí mâu thuẫn / ngược ADX trong STRONG_TREND / lệnh tiếp diễn trong RANGE / biến động 1.5–2× / funding cực đoan ngược hướng lệnh.
- **High**: LIVE CONFIRM + KHÔNG dính cảnh báo nào + có sweep rõ + RR TP1 ≥ 1:${highRr} + (nếu dùng chuỗi chuẩn ${tfEntry}) vùng retest chồng lên POI ${tfPoi} fresh.
- **Medium**: dính 1–2 cảnh báo, HOẶC RR TP1 trong 1:${config.minRr}–1:${highRr}.
- **Low**: dính ≥ 3 cảnh báo → VẪN xuất ORDER, ghi rõ "confidence thấp, giảm size mạnh". KHÔNG tự hạ Low thành NO TRADE — chỉ NO TRADE khi phạm 4 cổng.
- **LIMIT-CHỜ-POI luôn hạ 1 bậc** so với mức tính được (áp dụng SAU cùng) → lệnh chờ tối đa Medium.

## ĐỊNH DẠNG OUTPUT

### Trường hợp 1 — Chưa đủ điều kiện vào lệnh nhưng setup đang hình thành (KHÔNG thỏa LIVE CONFIRM lẫn LIMIT-CHỜ-POI):
> Trước khi viết phần này, tự hỏi lại: POI có fresh và hợp lệ không? Entry dự kiến qua Cổng 1 không? RR TP1 đạt không? Entry cách giá ≤ ngưỡng ATR ${tfPoi} cho phép không? ĐỦ CẢ BỐN → đây phải là **ORDER LIMIT-CHỜ-POI** (Trường hợp 3), KHÔNG phải WATCHLIST.
#### WATCHLIST (CHƯA VÀO LỆNH)
- Hướng dự kiến: LONG / SHORT
- POI cần chờ: [vùng giá] (cách giá hiện tại [X]% = [Y]× ATR ${tfPoi})
- Entry zone dự kiến: [vùng giá tại POI — nơi sẽ vào lệnh khi ${tfEntry} confirm hoặc đặt limit]
- SL dự kiến: [giá] — vùng liquidity sau POI + đệm ≥1.5× ATR ${tfAtr} — cách [X]% (= [Y]× ATR ${tfAtr})
- TP dự kiến: [giá] — mục tiêu thanh khoản gần nhất (đã lùi khỏi vùng nghịch) — RR dự kiến [X:1]
- Điều kiện kích hoạt còn thiếu: [cụ thể — chờ giá về POI / chờ ${tfEntry} confirm gì / chờ quét pool thanh khoản nào]
- Vì sao KHÔNG đặt lệnh chờ (BẮT BUỘC 1 dòng): [POI xa hơn ngưỡng ATR ${tfPoi} cho phép / POI chưa fresh / entry dự kiến phạm Cổng 1 / RR TP1 không đạt / hướng chưa chốt]
- Lưu ý: đây là các mức DỰ KIẾN tính trước tại POI (đã biết hướng) — sẽ chốt lại khi ${tfEntry} confirm; chưa đặt lệnh cho đến khi đủ điều kiện. Nếu RR dự kiến < 1:${config.minRr} thì ghi rõ setup sẽ bị loại khi tới POI.

### Trường hợp 2 — Không có cơ hội nào:
- Best opportunity: NO TRADE
- Patience level: No trade
- Lý do: [1 câu nêu rõ thiếu yếu tố nào / bị cổng nào chặn]

### Trường hợp 3 — Setup HỢP LỆ (qua đủ 4 CỔNG; LIVE = đã confirm tại POI, LIMIT-CHỜ-POI = POI đã chín trong tầm khoảng cách):
#### [LONG / SHORT]
- Chế độ vào lệnh: LIVE CONFIRM / LIMIT-CHỜ-POI
- Nhãn context: THUẬN/NGƯỢC dòng ${tfContext} | THUẬN/NGƯỢC hướng BTC (giảm size nếu ngược)
- Entry zone: [vùng POI thấp – cao] (mốc [giá khớp]) (mốc cách giá hiện tại [X]% = [Y]× ATR ${tfPoi}) — "mốc" BẮT BUỘC, là giá đặt lệnh duy nhất mà Cổng 1 + RR được đo tại đó: LIMIT = giữa POI, LIVE CONFIRM = giá hiện tại hoặc mép gần. Nếu LIMIT: ghi rõ "lệnh chờ, kích hoạt khi chạm" + ngưỡng khoảng cách đã dùng (1× / 1.5×)
- Điều kiện kích hoạt: [POI nào (${tfPoi} hay vùng retest chuỗi chuẩn ${tfEntry}) + sweep gì + confirmation ${tfEntry} nào (LIVE) / điều kiện đặt-trước (LIMIT)]
- Vị trí trong dealing range ${tfBias}: tại entry [X]% leg (giá hiện tại [Y]%) — leg dùng [low–high] — ngưỡng regime [75/25 | 60/40 | 55/45] → Cổng 1 PASS
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
- Bộ khung đang dùng: ${tfContext}/${tfBias}/${tfPoi}/${tfEntry} — Chế độ: LIVE / LIMIT-CHỜ-POI / N/A
- BTC context (nếu alt): cùng hướng / ngược hướng / không áp dụng
- Context ${tfContext}: BULLISH / BEARISH / NEUTRAL (lệnh thuận hay ngược dòng)
- Đảo chiều ngược dòng ${tfContext} (sweep-and-reject): [N] nến ${tfBias} đã đóng xác nhận — đủ / thiếu / không áp dụng
- Bias ${tfBias}: BULLISH / BEARISH / NEUTRAL
- Mẫu số Cổng 1: dealing range ${tfBias} [low–high, = N× ATR] (hoặc "range mở rộng" + lý do fallback)
- Premium/Discount: **tại entry dự kiến [X]% leg** (giá hiện tại [Y]%) — regime ADX ${tfBias} [giá trị → regime], ngưỡng [W%] — **Cổng 1: PASS / FAIL**
- Draw on Liquidity: lên / xuống — **Cổng 2: PASS / FAIL**
- Liquidity sweep tại POI: Có / Chưa — Chuỗi chuẩn ${tfEntry}: đủ / thiếu [mắt xích]
- ${tfEntry} confirmation: Có / Chưa / N/A (LIMIT)
- Khoảng cách entry → giá hiện tại: [X]% = [Y]× ATR ${tfPoi} (ngưỡng [1× / 1.5×])
- Funding rate: dương / âm / trung tính + mức độ
- Open interest: tăng / giảm + đọc gì
- Biến động: ATR/ATR nền ${tfEntry} = [X]× → Bình thường / Cao / Cực đoan
- Volume: cú phá [X]× TB / sau cú phá [Y]× TB / nến confirm [Z]× TB → xác nhận / thiếu lực / bị hấp thụ (hoặc "không có dữ liệu")
- TP1 sau Cổng 3 — RR: [X:1] — **Cổng 4: PASS / FAIL**
- Trong vùng thanh khoản cao: Có / Không
- Cảnh báo đang kích hoạt: [liệt kê] → confidence [mức]
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

    // Khung entry = khung cuối trong tfOrder có mặt trong data (M15 intraday, H4 longterm).
    const entryTf = [...allTf].reverse().find((tf) => candlesByTimeframe[tf]?.length);

    // Số nến thô cần gửi cho một khung: ưu tiên map theo khung (v3.1); nếu không có map
    // thì chỉ khung entry mới gửi (số = rawCandles). Trả 0 = không gửi nến thô khung đó.
    const rawCountFor = (tf: string): number => {
      if (rawCandlesByTf) return rawCandlesByTf[tf] ?? (tf === entryTf ? rawCandles : 0);
      return tf === entryTf ? rawCandles : 0;
    };

    const lines: string[] = [];
    lines.push('=== ICT/SMC FACTS (code đã tính sẵn — DÙNG TRỰC TIẾP, KHÔNG tính lại) ===');
    const kz = facts.meta.killZone;
    lines.push(`Giá hiện tại: ${facts.meta.currentPrice}`);
    lines.push(
      `Kill zone (thời điểm phân tích ${kz.vnTime} VN — code ĐÃ xử lý DST): ` +
      `${kz.inKillZone ? kz.zone : 'NGOÀI kill zone'}` +
      ` | London ${kz.londonDst ? 'BST' : 'GMT'} ${kz.londonVn} VN` +
      ` | New York ${kz.newYorkDst ? 'EDT' : 'EST'} ${kz.newYorkVn} VN`,
    );
    lines.push(
      'Quy ước nến: mọi FACTS bên dưới chỉ tính trên nến ĐÃ ĐÓNG. Nến đang chạy (nếu có) ghi riêng ở dòng ' +
      '"Nến ĐANG CHẠY" — chỉ dùng để biết giá/wick hiện tại, KHÔNG dùng làm body close cho BOS/CHoCH/sweep, ' +
      'KHÔNG đếm vào luật "≥2 nến H1 xác nhận".',
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
      // Chỉ liệt kê nến ĐÃ ĐÓNG; nến đang chạy tách ra một dòng riêng để model không
      // đọc nhầm "close" tạm thời của nó thành body close.
      const forming = tfFacts?.formingCandle ?? null;
      if (rawCount > 0) {
        const closedCandles = forming ? candles.slice(0, -1) : candles;
        const slice = closedCandles.slice(-rawCount);
        const purpose = tf === entryTf ? 'đọc confirmation/entry' : 'đọc hình dạng nến';
        // Cột volume chỉ có khi provider trả volume (crypto).
        const withVol = slice.every((c) => c.volume != null);
        lines.push(`Nến thô ĐÃ ĐÓNG (${slice.length} nến cuối — ${purpose}):`);
        lines.push(withVol ? 'timestamp,open,high,low,close,volume' : 'timestamp,open,high,low,close');
        lines.push(...slice.map((c) =>
          `${toUnixTimestamp(c.time)},${c.open},${c.high},${c.low},${c.close}` + (withVol ? `,${c.volume}` : ''),
        ));
      }
      if (forming) {
        lines.push(
          `Nến ĐANG CHẠY (chưa đóng, mở lúc ${forming.time}): open ${forming.open} high ${forming.high} ` +
          `low ${forming.low} giá hiện tại ${forming.close} — KHÔNG dùng làm body close`,
        );
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
  // Trạng thái mức thanh khoản: unswept = pool còn nguyên (nam châm DOL); swept = quét rồi
  // body close quay lại (từ chối); broken = phá thật (KHÔNG phải sweep); breaking = vừa đóng
  // cửa bên ngoài, chưa đủ nến để kết luận.
  const fmtStatus = (s: LevelStatus | undefined) => (s ? s.toLowerCase() : 'unswept');
  const fmtSwings = (s: { price: number; time: string; status?: LevelStatus }[]) =>
    s.length ? s.map((x) => `${x.price}@${x.time} [${fmtStatus(x.status)}]`).join(', ') : '—';
  // Zone (FVG/OB) kèm cờ mitigate: [fresh] = còn nguyên (POI tươi), [mitigated] = đã bị ăn.
  const fmtZones = (z: { type: string; top: number; bottom: number; mitigated: boolean }[]) =>
    z.length ? z.map((x) => `${x.type} ${x.bottom}–${x.top} [${x.mitigated ? 'mitigated' : 'fresh'}]`).join(' | ') : '—';
  const fmtLiq = (lv: { price: number; status: LevelStatus }[]) =>
    lv.length ? lv.map((x) => `${x.price} [${fmtStatus(x.status)}]`).join(', ') : '—';
  // BOS/CHoCH kèm displacement + vùng retest do chính cú phá tạo ra. Không displacement →
  // ghi rõ "YẾU" để khớp định nghĩa CHoCH hợp lệ trong system prompt.
  const fmtEvent = (s: StructureEvent) => {
    const disp = s.displacement
      ? `có displacement (thân ${s.bodyAtr}× ATR)`
      : `YẾU — KHÔNG displacement (thân ${s.bodyAtr}× ATR, không FVG)`;
    const z = s.retestZone;
    const zoneState = z?.invalidated
      ? `hỏng — đã bị body close xuyên ${z.penetrationAtr}× ATR`
      : z?.penetrationAtr
        ? `còn hiệu lực — body close xuyên nông ${z.penetrationAtr}× ATR, trong ngưỡng chịu lệch`
        : z?.mitigated ? 'đã chạm lại' : 'fresh, chưa hồi về';
    const zone = z
      ? ` → vùng retest ${z.source} ${z.bottom}–${z.top} [${zoneState}]`
      : ' → không có FVG/OB để retest';
    // Volume chỉ có với crypto; vàng (null) giữ nguyên dòng cũ.
    const vol = s.breakVolRatio != null
      ? ` | volume cú phá ${s.breakVolRatio}× TB`
        + (s.pullbackVolRatio != null ? `, các nến sau cú phá ${s.pullbackVolRatio}× TB` : '')
      : '';
    return `${s.kind} ${s.direction} phá ${s.level} (${s.time}) — ${disp}${vol}${zone}`;
  };
  const fmtSweeps = (list: SweepEvent[]) =>
    list.length
      ? list.map((e) =>
        `${e.side === 'BUYSIDE' ? 'quét ĐỈNH (buyside)' : 'quét ĐÁY (sellside)'} ${e.levelType === 'EQUAL' ? 'equal level' : 'swing'} ${e.level}`
        + ` — râu tới ${e.extreme}, đóng cửa quay lại lúc ${e.time}`
        + (e.volRatio != null ? `, volume cú quét ${e.volRatio}× TB` : '')
        + (e.holdCloses > 0
          ? `, giữ phía đảo chiều ${e.holdCloses} nến đã đóng liên tiếp tới nay`
          : ', nến đóng gần nhất ĐÃ quay lại bên kia mức (đảo chiều chưa giữ được)')).join(' | ')
      : '— (chưa có cú quét nào bị từ chối gần đây)';

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

  // HỘP RANGE: biên sideway do code dò (swing chạm cả hai biên nhiều lần). Không có hộp →
  // ghi rõ để model không tự vẽ hộp từ cảm nhận.
  const box = a.rangeBox;
  const boxState = !box ? ''
    : box.state === 'INSIDE' ? 'TRONG HỘP'
    : `${box.state === 'BROKEN' ? 'ĐÃ PHÁ' : '⚠️ ĐANG THỬ'} BIÊN ${box.outsideSide === 'ABOVE' ? 'TRÊN' : 'DƯỚI'}`
      + ` (${box.closesOutside} nến đã đóng liên tiếp ngoài hộp)`
      + (box.state === 'BROKEN' ? ' → hộp hết hiệu lực' : ' → chưa biết sweep hay phá thật');
  const boxLine = box
    ? `▶ HỘP RANGE (sideway): ${box.bottom}–${box.top} | rộng ${box.width} (= ${box.widthAtr}× ATR) | EQ(50%): ${box.equilibrium}`
      + ` | từ ${box.startTime} (${box.bars} nến) | chạm biên trên ${box.topTouches} lần, biên dưới ${box.bottomTouches} lần`
      + ` | Giá hiện tại ở ${box.positionPct}% hộp | Trạng thái: ${boxState}`
    : '▶ HỘP RANGE (sideway): — (không có hộp đủ điều kiện — KHÔNG tự vẽ hộp)';

  const structLines = a.structureEvents.length
    ? a.structureEvents.map((e, i) => `  ${i + 1}. ${fmtEvent(e)}`)
    : ['  —'];

  const vol = a.atrBaseline;
  const volLine = vol
    ? `Biến động: ATR(14)/ATR nền = ${vol.ratio}× (ATR nền = TR trung bình ${vol.bars} nến: ${vol.value})`
      + (vol.ratio >= 2 ? ' → ⚠️ CỰC ĐOAN (≥2×)' : vol.ratio >= 1.5 ? ' → cao' : ' → bình thường')
    : 'Biến động: ATR(14)/ATR nền — (không đủ nến, coi như KHÔNG XÁC ĐỊNH)';

  // Volume tương đối — chỉ crypto. "TB" = trung bình volume N nến đã đóng liền trước đoạn đo.
  const vr = a.volume;
  const volumeLine = vr
    ? `Volume (× TB ${vr.bars} nến đã đóng liền trước): nến đóng gần nhất ${vr.lastRatio}× | TB 3 nến gần nhất ${vr.recent3Ratio}×`
    : null;

  return [
    `Bias: ${a.bias} | ATR: ${a.atr} | Giá: ${a.lastPrice}`,
    volLine,
    ...(volumeLine ? [volumeLine] : []),
    adxLine,
    `Cấu trúc BOS/CHoCH (cũ → mới, body close nến đã đóng):`,
    ...structLines,
    `Liquidity sweep gần nhất (wick vượt rồi body close quay lại): ${fmtSweeps(a.sweeps)}`,
    `Range mở rộng (${a.candleCount} nến gần nhất — chỉ để tham chiếu bối cảnh): ${r.rangeLow}–${r.rangeHigh} | Size: ${rangeSize} | EQ(50%): ${r.equilibrium} | Vùng: ${r.zone}`,
    `Fib (range mở rộng): 0.236=${r.fib['0.236']} 0.382=${r.fib['0.382']} 0.618=${r.fib['0.618']} 0.786=${r.fib['0.786']}`,
    legLine,
    boxLine,
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

/**
 * Block cho lượt do SetupWatcher kích hoạt. Bộ lọc cơ học chỉ thấy MỘT chuỗi sweep →
 * BOS/CHoCH → retest trên một khung — framing "gợi ý cần kiểm chứng" để model không
 * coi việc được kích hoạt là bằng chứng setup tốt (anchoring).
 */
function buildTriggerNoteBlock(note: string): string {
  return [
    '=== LÝ DO LƯỢT PHÂN TÍCH NÀY ĐƯỢC KÍCH HOẠT (bộ lọc cơ học, KHÔNG phải AI) ===',
    note,
    '',
    '⚠️ Đây chỉ là chuỗi sự kiện code dò được trên nến đã đóng — KHÔNG phải kết luận. Kiểm chứng ĐỘC LẬP bằng FACTS và nến thô theo đúng quy trình + 3 HARD GATE. Nếu thấy chuỗi này không hợp lệ (sweep yếu, displacement không thật, vùng retest đã hỏng, ngược bias, RR không đạt…) thì cứ ra WATCHLIST/NO TRADE như bình thường. Thêm 1 dòng vào SUMMARY: "Chuỗi kích hoạt: [XÁC NHẬN / BÁC BỎ] — [lý do ngắn]".',
  ].join('\n');
}

/** Plan lượt trước trong ngày — để model nói rõ kịch bản nào đã chạy / vô hiệu / còn chờ. */
function buildPreviousPlanBlock(p: PreviousPlan): string {
  return [
    `=== KẾ HOẠCH LƯỢT TRƯỚC (cách đây ${p.ageMinutes} phút — lúc ${p.analyzedAtVn} giờ VN) ===`,
    `Bias Overall lúc đó: ${p.trendBias ?? 'không rõ'} | Giá lúc đó: ${p.priceThen ?? 'không rõ'}`,
    p.scenarios,
    '',
    '⚠️ Đánh giá ĐỘC LẬP bằng FACTS/nến MỚI — plan cũ chỉ là tham chiếu, được toàn quyền bác bỏ. Với từng kịch bản cũ ' +
    'ghi vào mục "CẬP NHẬT SO VỚI PLAN TRƯỚC": ĐÃ KÍCH HOẠT (giá đã về vùng + phản ứng) / ĐÃ VÔ HIỆU (điều kiện hủy đã xảy ra) / ' +
    'VẪN CHỜ (cập nhật lại mức nếu cần). Đổi bias so với plan trước thì phải nêu sự kiện cấu trúc (nến đã đóng) gây ra thay đổi.',
  ].join('\n');
}

/** Block mức giá theo phiên — model dùng thay cho việc tự đọc PDH/PDL từ nến D. */
function formatSessionLevels(l: SessionLevels, price: number, isCrypto = false): string {
  const lines: string[] = isCrypto
    ? [
      `=== MỨC GIÁ THEO PHIÊN (code tính từ nến H1/H4 — ngày giao dịch theo UTC, bắt đầu 00:00 UTC = ${l.rolloverVn} VN, như nến D Binance; tuần bắt đầu T2 00:00 UTC) ===`,
      'PDH/PDL/PWH/PWL LẤY TỪ BLOCK NÀY, không tự đọc từ nến D (ranh giới ngày của nến D provider có thể lệch mốc UTC).',
    ]
    : [
      `=== MỨC GIÁ THEO PHIÊN (code tính từ nến H1/H4 — ngày giao dịch bắt đầu lúc rollover 17:00 New York = ${l.rolloverVn} VN) ===`,
      'Nến D của provider cắt ngày lệch rollover và có nến T7/CN đi ngang → PDH/PDL/PWH/PWL và range Á LẤY TỪ BLOCK NÀY, không đọc từ nến D.',
    ];
  const vs = (level: number, side: 'HIGH' | 'LOW', todayExtreme: number | undefined, label: string): string => {
    if (todayExtreme == null) return `${label} chưa có nến hôm nay`;
    const taken = side === 'HIGH' ? todayExtreme > level : todayExtreme < level;
    return taken
      ? `hôm nay ĐÃ giao dịch ${side === 'HIGH' ? 'trên' : 'dưới'} ${label} (${side === 'HIGH' ? 'high' : 'low'} hôm nay ${todayExtreme})`
      : `hôm nay CHƯA chạm ${label}`;
  };

  const t = l.today;
  lines.push(t
    ? `Ngày giao dịch hiện tại ${l.tradingDay}: open ${t.open} | high/low đến giờ ${t.high} / ${t.low} (${t.bars} nến H1)`
    : `Ngày giao dịch hiện tại ${l.tradingDay}: chưa có nến (phiên mới chưa mở)`);

  const p = l.prevDay;
  if (p) {
    lines.push(
      `PDH / PDL (ngày ${p.day}): ${p.high} / ${p.low} | close ${p.close} → ` +
      `${vs(p.high, 'HIGH', t?.high, 'PDH')}; ${vs(p.low, 'LOW', t?.low, 'PDL')}`,
    );
  } else {
    lines.push('PDH / PDL: không đủ nến H1 để dựng ngày hôm trước');
  }

  const w = l.prevWeek;
  lines.push(w
    ? `PWH / PWL (tuần từ ${w.weekOf}): ${w.high} / ${w.low}${w.complete ? '' : ' [THIẾU dữ liệu đầu tuần — có thể chưa phải cực trị thật]'}`
    : 'PWH / PWL: không đủ nến H4');
  if (l.thisWeek) lines.push(`Tuần này (từ ${l.thisWeek.weekOf}) đến giờ: high ${l.thisWeek.high} / low ${l.thisWeek.low}`);

  // Crypto (asia = null): không có range Á — chỉ còn dòng vị trí giá so với range hôm qua.
  const a = l.asia;
  const asiaHead = a ? `Range Á (${a.windowNy} NY = ${a.windowVn} VN)` : '';
  if (a && (a.status === 'NOT_STARTED' || a.high == null || a.low == null)) {
    lines.push(`${asiaHead}: CHƯA BẮT ĐẦU — chưa có mức range Á cho hôm nay`);
  } else if (a && a.high != null && a.low != null) {
    const where = price > a.high ? 'TRÊN range Á' : price < a.low ? 'DƯỚI range Á' : 'TRONG range Á';
    lines.push(
      `${asiaHead}: ${a.status === 'DONE' ? 'ĐÃ XONG' : `ĐANG CHẠY (${a.bars} nến H1 — high/low còn có thể đổi)`}` +
      ` | high ${a.high} / low ${a.low} | giá hiện tại ${price} đang ${where}`,
    );
  }
  if (p) {
    const where = price > p.high ? 'TRÊN PDH' : price < p.low ? 'DƯỚI PDL' : 'TRONG range hôm qua';
    lines.push(`Vị trí giá hiện tại ${price}: ${where}`);
  }
  return lines.join('\n');
}

/**
 * System prompt KẾ HOẠCH NGÀY cho vàng. Khác prompt intraday: KHÔNG ra lệnh, KHÔNG có
 * HARD GATE vào lệnh — chỉ lập bản đồ cho phần còn lại của ngày để trader (và các lượt
 * intraday) biết vùng nào cần canh. Format output cố định để parseDailyPlanResult bóc
 * được `Bias Overall` + `#### KỊCH BẢN BUY/SELL` — đổi nhãn thì sửa parser cùng lúc.
 */
function buildGoldDailyPlanSystemPrompt(): string {
  return `Bạn là trader XAU/USD theo phương pháp ICT/SMC, nhiệm vụ là LẬP KẾ HOẠCH GIAO DỊCH TRONG NGÀY — KHÔNG ra lệnh.
Kế hoạch được chạy nhiều lần trong ngày (sáng, trước London, phiên London, trước New York). Mỗi lần lập plan cho PHẦN CÒN LẠI của ngày tính từ thời điểm phân tích, ưu tiên phiên kế tiếp.

## PHÂN VAI KHUNG
- **D — BỐI CẢNH**: hướng chủ đạo, vùng premium/discount của range nhiều ngày, mục tiêu thanh khoản lớn (draw on liquidity).
- **MỨC THEO PHIÊN**: PDH/PDL, PWH/PWL, range Á và high/low hôm nay lấy từ block "MỨC GIÁ THEO PHIÊN" (code tính theo rollover 17:00 New York) — KHÔNG tự đọc từ nến D.
- **H4 — DÒNG CHẢY**: cấu trúc HH/HL hay LH/LL, BOS/CHoCH có displacement, OB/FVG H4 còn fresh = POI chính trong ngày.
- **H1 — MỨC TRONG NGÀY**: swing gần, equal highs/lows, vùng thanh khoản sẽ bị quét; POI H1 tinh chỉnh POI H4.
- **M15 — chỉ để biết giá đang phản ứng thế nào ở vùng gần nhất**, không dùng để đặt bias.

## QUY TẮC
1. Dùng TRỰC TIẾP ICT FACTS code đã tính sẵn (swing, range, FVG/OB [fresh/mitigated], thanh khoản [unswept/swept/broken/breaking], BOS/CHoCH kèm displacement, ATR, ADX). KHÔNG tự tính lại.
2. Chỉ nến ĐÃ ĐÓNG mới được dùng làm body close cho BOS/CHoCH/sweep. Nến ĐANG CHẠY chỉ cho biết giá hiện tại.
3. Một BOS/CHoCH gắn nhãn "YẾU — KHÔNG displacement" KHÔNG được coi là đổi cấu trúc.
4. Mức thanh khoản [swept] = đã quét và bị từ chối (có thể đảo chiều); [broken] = phá thật (tiếp diễn) — không đọc lẫn hai nhãn này.
5. Giờ phiên: dùng dòng "Kill zone" trong FACTS (code đã xử lý DST) — KHÔNG tự suy giờ London/New York. Range Á "CHƯA BẮT ĐẦU" → không có mức range Á; "ĐANG CHẠY" → high/low còn có thể đổi, chỉ dùng làm tham chiếu tạm.
6. Mọi mức giá phải lấy từ FACTS/nến thô — không bịa mức tròn. SL/TP tính theo USD, SL đặt sau swing/POI kèm đệm theo ATR H1, nêu cả khoảng cách USD.
7. Mỗi kịch bản phải có điều kiện kích hoạt QUAN SÁT ĐƯỢC (ví dụ: "giá quét X rồi M5/M15 đóng nến quay lại trên Y" hoặc "giá hồi về FVG H1 A–B") và điều kiện vô hiệu bằng BODY CLOSE.
8. Có đúng HAI kịch bản: một BUY và một SELL. Kịch bản thuận bias Overall gắn nhãn CHÍNH, ngược lại là PHỤ. Bias NEUTRAL → cả hai là PHỤ và nói rõ chờ phá range nào.
9. Tin tức kinh tế: bạn KHÔNG có lịch tin — chỉ nhắc khung giờ thường có tin Mỹ (theo giờ New York trong FACTS) là vùng rủi ro, không bịa tên tin.
10. Viết tiếng Việt, ngắn gọn, mỗi ý một dòng. KHÔNG dùng dòng "---" và KHÔNG để trống 2 dòng liên tiếp bên trong một block kịch bản.

## FORMAT OUTPUT (giữ nguyên tiêu đề và nhãn — hệ thống parse tự động)
### TÓM TẮT PLAN
- Bias Overall: [BULLISH / BEARISH / NEUTRAL]
- Confidence plan: [High / Medium / Low]
- Thời điểm lập plan: [giờ VN] — phiên kế tiếp: [Á / London / New York]
- Một câu: hôm nay ưu tiên làm gì (canh BUY ở đâu / canh SELL ở đâu / đứng ngoài tới khi nào).

### BIAS ĐA KHUNG
- Bias D: [BULLISH / BEARISH / NEUTRAL] — lý do (cấu trúc + vị trí trong range)
- Bias H4: [...] — lý do
- Bias H1: [...] — lý do
- Draw on liquidity: [mức thanh khoản giá có khả năng tìm tới trong ngày + lý do]

### BẢN ĐỒ MỨC GIÁ
- Kháng cự / thanh khoản phía trên (gần → xa): mức — loại (PDH, equal highs, swing H1/H4, FVG/OB) — trạng thái
- Hỗ trợ / thanh khoản phía dưới (gần → xa): ...
- Vùng giá "không giao dịch" (giữa range, không POI): A–B

#### KỊCH BẢN BUY — [CHÍNH / PHỤ]
- Điều kiện kích hoạt: ...
- Vùng entry (POI): A–B (khung, loại vùng)
- SL dự kiến: ... (≈ X USD)
- TP1: ... | TP2: ...  (RR ước tính 1:x tại TP1)
- Vô hiệu nếu: [body close khung nào qua mức nào]
- Khung giờ ưu tiên: [phiên/giờ VN]

#### KỊCH BẢN SELL — [CHÍNH / PHỤ]
- (cùng các dòng như trên)

### LỊCH TRÌNH PHIÊN
- [Phiên kế tiếp + giờ VN]: hành vi kỳ vọng (quét range Á? tiếp diễn? hồi về POI?)
- [Phiên sau đó]: ...
- Khung giờ rủi ro tin Mỹ: ...

### CẬP NHẬT SO VỚI PLAN TRƯỚC
- (Chỉ khi có "KẾ HOẠCH LƯỢT TRƯỚC" trong dữ liệu — mỗi kịch bản cũ: ĐÃ KÍCH HOẠT / ĐÃ VÔ HIỆU / VẪN CHỜ + lý do. Không có thì ghi "Plan đầu tiên trong ngày".)

### LƯU Ý RỦI RO
- 1–3 dòng: điều gì làm cả plan sai, khi nào nên đứng ngoài.`;
}

/**
 * System prompt KẾ HOẠCH NGÀY cho crypto (BTC/ETH…). Cùng khung D/H4/H1/M15 và cùng bố cục
 * với plan vàng, khác ở: từ vựng LONG/SHORT (parser map về BUY/SELL), SL/TP theo % + ATR,
 * thị trường 24/7 (ngày theo UTC, không range Á, không kill zone vàng), có funding/OI và
 * BTC context. Tiêu đề `#### KỊCH BẢN LONG/SHORT` phải khớp parseDailyPlanResult + formatPlanCard.
 */
function buildCryptoDailyPlanSystemPrompt(instrument: string): string {
  return `Bạn là trader crypto futures/perpetual theo phương pháp ICT/SMC, nhiệm vụ là LẬP KẾ HOẠCH GIAO DỊCH TRONG NGÀY cho ${instrument} — KHÔNG ra lệnh.
Kế hoạch được chạy nhiều lần trong ngày (sáng giờ VN, trước London, phiên London, trước Mỹ). Mỗi lần lập plan cho PHẦN CÒN LẠI của ngày tính từ thời điểm phân tích, ưu tiên khung giờ thanh khoản kế tiếp.

## PHÂN VAI KHUNG
- **D — BỐI CẢNH**: hướng chủ đạo, vùng premium/discount của range nhiều ngày, mục tiêu thanh khoản lớn (draw on liquidity).
- **MỨC THEO PHIÊN**: PDH/PDL, PWH/PWL và high/low hôm nay lấy từ block "MỨC GIÁ THEO PHIÊN" (code tính theo ngày UTC như nến D Binance) — KHÔNG tự đọc từ nến D.
- **H4 — DÒNG CHẢY**: cấu trúc HH/HL hay LH/LL, BOS/CHoCH có displacement, OB/FVG H4 còn fresh = POI chính trong ngày.
- **H1 — MỨC TRONG NGÀY**: swing gần, equal highs/lows, vùng thanh khoản sẽ bị quét; POI H1 tinh chỉnh POI H4.
- **M15 — chỉ để biết giá đang phản ứng thế nào ở vùng gần nhất**, không dùng để đặt bias.

## ĐẶC THÙ CRYPTO
- Thị trường 24/7, không có phiên đóng cửa và KHÔNG có range Á kiểu vàng. Dòng "Kill zone London/New York" trong FACTS là của vàng — với crypto dùng khung giờ thanh khoản (giờ VN): London ~14:00–23:00, Mỹ ~20:00–04:00, overlap ~20:00–23:00 mạnh nhất; ngoài khung này (nhất là cuối tuần) thanh khoản mỏng, fakeout nhiều.
- **Funding rate / Open interest** (block FUTURES SENTIMENT nếu có): funding dương cao = đám đông long quá đông → rủi ro long squeeze; âm cao = ngược lại. OI tăng mạnh kèm giá đi một chiều = vị thế mới chất đống → dễ liquidation cascade ngược lại. Không có block → không bịa.
- **BTC context** (block BTC CONTEXT, chỉ khi instrument là altcoin): alt gần như đi theo BTC — kịch bản ngược hướng BTC không được gắn CHÍNH.
- **Số tròn tâm lý** (100000, 4000…) là pool thanh khoản — đưa vào bản đồ mức giá nếu giá gần.
- **Volume** (FACTS ghi "× TB" = so với trung bình các nến đã đóng liền trước): BOS/CHoCH có volume cú phá ≥ 1.5× TB = cấu trúc đáng tin hơn; cú phá < 1× TB = dễ fakeout. Volume các nến sau cú phá ≥ volume cú phá = phe ngược đang hấp thụ. Dùng để xếp kịch bản CHÍNH/PHỤ và confidence plan — không phải luật cứng; không có số volume → bỏ qua.

## QUY TẮC
1. Dùng TRỰC TIẾP ICT FACTS code đã tính sẵn (swing, range + DEALING RANGE, FVG/OB [fresh/mitigated], thanh khoản [unswept/swept/broken/breaking], BOS/CHoCH kèm displacement, ATR, ADX). KHÔNG tự tính lại.
2. Chỉ nến ĐÃ ĐÓNG mới được dùng làm body close cho BOS/CHoCH/sweep. Nến ĐANG CHẠY chỉ cho biết giá hiện tại.
3. Một BOS/CHoCH gắn nhãn "YẾU — KHÔNG displacement" KHÔNG được coi là đổi cấu trúc.
4. Mức thanh khoản [swept] = đã quét và bị từ chối (có thể đảo chiều); [broken] = phá thật (tiếp diễn) — không đọc lẫn hai nhãn này.
5. Kịch bản đảo chiều NGƯỢC dòng D chỉ dựa trên sweep-and-reject (chưa có CHoCH H4 có displacement) phải ghi rõ điều kiện kích hoạt cần ≥2 nến H4 ĐÃ ĐÓNG giữ phía đảo chiều (đọc số "giữ phía đảo chiều N nến" trong dòng "Liquidity sweep gần nhất") — không được gắn CHÍNH khi mới có 1 nến.
6. Mọi mức giá phải lấy từ FACTS/nến thô — không bịa mức tròn ngoài các số tròn tâm lý thật. Ghi giá tuyệt đối KÈM khoảng cách % so với giá hiện tại. SL đặt sau swing/POI kèm đệm theo ATR H1 (ghi cả % và bội số ATR), tính tới vùng wick liquidation.
7. Mỗi kịch bản phải có điều kiện kích hoạt QUAN SÁT ĐƯỢC (ví dụ: "giá quét X rồi M15 đóng nến quay lại trên Y" hoặc "giá hồi về FVG H1 A–B") và điều kiện vô hiệu bằng BODY CLOSE.
8. Có đúng HAI kịch bản: một LONG và một SHORT. Kịch bản thuận bias Overall gắn nhãn CHÍNH, ngược lại là PHỤ. Bias NEUTRAL → cả hai là PHỤ và nói rõ chờ phá range nào.
9. Tin tức: bạn KHÔNG có lịch tin — chỉ nhắc khung giờ thường có tin vĩ mô Mỹ (CPI/FOMC thường rơi 19:30–20:30 hoặc 01:00–02:00 giờ VN) là vùng rủi ro, không bịa tên tin.
10. Viết tiếng Việt, ngắn gọn, mỗi ý một dòng. KHÔNG dùng dòng "---" và KHÔNG để trống 2 dòng liên tiếp bên trong một block kịch bản.

## FORMAT OUTPUT (giữ nguyên tiêu đề và nhãn — hệ thống parse tự động)
### TÓM TẮT PLAN
- Bias Overall: [BULLISH / BEARISH / NEUTRAL]
- Confidence plan: [High / Medium / Low]
- Thời điểm lập plan: [giờ VN] — khung thanh khoản kế tiếp: [Á / London / Mỹ]
- Một câu: hôm nay ưu tiên làm gì (canh LONG ở đâu / canh SHORT ở đâu / đứng ngoài tới khi nào).

### BIAS ĐA KHUNG
- Bias D: [BULLISH / BEARISH / NEUTRAL] — lý do (cấu trúc + vị trí trong range)
- Bias H4: [...] — lý do
- Bias H1: [...] — lý do
- Sentiment futures: [funding / OI nói gì — hoặc "không có dữ liệu"]
- BTC context: [chỉ với altcoin — BTC đang đi hướng nào; BTC thì ghi "—"]
- Draw on liquidity: [mức thanh khoản giá có khả năng tìm tới trong ngày + lý do]

### BẢN ĐỒ MỨC GIÁ
- Kháng cự / thanh khoản phía trên (gần → xa): mức (+x%) — loại (PDH, PWH, equal highs, swing H1/H4, FVG/OB, số tròn) — trạng thái
- Hỗ trợ / thanh khoản phía dưới (gần → xa): mức (−x%) — ...
- Vùng giá "không giao dịch" (giữa range, không POI): A–B

#### KỊCH BẢN LONG — [CHÍNH / PHỤ]
- Điều kiện kích hoạt: ...
- Vùng entry (POI): A–B (khung, loại vùng)
- SL dự kiến: ... (≈ x% | y× ATR H1)
- TP1: ... | TP2: ...  (RR ước tính 1:x tại TP1)
- Vô hiệu nếu: [body close khung nào qua mức nào]
- Khung giờ ưu tiên: [khung thanh khoản / giờ VN]

#### KỊCH BẢN SHORT — [CHÍNH / PHỤ]
- (cùng các dòng như trên)

### LỊCH TRÌNH TRONG NGÀY
- [Khung thanh khoản kế tiếp + giờ VN]: hành vi kỳ vọng (quét PDH/PDL? tiếp diễn? hồi về POI?)
- [Khung sau đó]: ...
- Khung giờ rủi ro tin vĩ mô Mỹ: ...

### CẬP NHẬT SO VỚI PLAN TRƯỚC
- (Chỉ khi có "KẾ HOẠCH LƯỢT TRƯỚC" trong dữ liệu — mỗi kịch bản cũ: ĐÃ KÍCH HOẠT / ĐÃ VÔ HIỆU / VẪN CHỜ + lý do. Không có thì ghi "Plan đầu tiên trong ngày".)

### LƯU Ý RỦI RO
- 1–3 dòng: điều gì làm cả plan sai (squeeze, cascade thanh lý, BTC đảo chiều…), khi nào nên đứng ngoài.`;
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
  if (p.orderState === 'pending') return buildPreviousLimitBlock(p);
  const dir = p.direction === 'BUY' ? 'BUY (LONG)' : 'SELL (SHORT)';
  const priceThen = p.priceThen != null ? `${p.priceThen}` : 'không rõ';
  const num = (x: number | null | undefined) => (x != null ? `${x}` : '—');
  const r = (x: number | null | undefined) => (x != null ? `${x.toFixed(2)}R` : '—');
  return [
    `=== LỆNH ĐANG MỞ — ĐÁNH GIÁ GIỮ HAY THOÁT (lệnh ra cách đây ${p.ageMinutes} phút — lúc ${p.analyzedAtVn} giờ VN) ===`,
    `Lần trước hệ thống đã ra LỆNH ${dir}. Giá lúc đó: ${priceThen}.`,
    `Thông số lệnh: Entry ${num(p.entry)} | SL ${num(p.stopLoss)} | TP1 ${num(p.takeProfit)} | RR ${p.riskReward != null ? `1:${p.riskReward}` : '—'}.`,
    `Trạng thái (code đã chấm trên nến thật, KHÔNG cần tự xác định lại): ĐÃ KHỚP entry lúc ${p.filledAtVn ?? 'không rõ'} giờ VN, CHƯA chạm SL lẫn TP1. Kể từ khi khớp: đi xa nhất +${r(p.mfeR)}, thụt sâu nhất −${r(p.maeR)}.`,
    `Chi tiết lệnh lần trước (gồm điều kiện "Hủy lệnh nếu"):`,
    p.rawText,
    ``,
    `⚠️ NHIỆM VỤ với lệnh trên — làm ĐỘC LẬP trên FACTS/nến MỚI, đánh giá KHÁCH QUAN (đừng thiên vị giữ lệnh vì sunk cost):`,
    `1. Đọc nến kể từ lúc khớp (nhóm C H1: nến thân lớn phá cấu trúc / rejection tại TP chốt non / TP1) và kiểm điều kiện "Hủy lệnh nếu" bằng body close.`,
    `2. KHUYẾN NGHỊ QUẢN LÝ (chọn 1, nêu rõ lý do bằng price action):`,
    `   • GIỮ NGUYÊN — thesis còn nguyên, chưa có tín hiệu thoát.`,
    `   • DỜI SL VỀ BREAKEVEN / SIẾT SL — đã có lời hoặc động lượng cạn dần.`,
    `   • THOÁT SỚM — cấu trúc đã gãy / rejection mạnh / đã thỏa "Hủy lệnh nếu" dù chưa chạm SL.`,
    `3. QUAN TRỌNG: "GIỮ lệnh đang mở" KHÁC "vào lệnh mới". Ví dụ giá lên premium sâu có thể CHẶN một lệnh BUY mới nhưng KHÔNG có nghĩa phải thoát lệnh BUY đang lời — đánh giá hai việc RIÊNG BIỆT.`,
    `4. Đặt ở ĐẦU output một block quản lý:`,
    `   #### QUẢN LÝ LỆNH TRƯỚC`,
    `   - Trạng thái: ĐANG CHẠY`,
    `   - Khuyến nghị: [GIỮ / DỜI SL / THOÁT] — [lý do ngắn bằng price action]`,
    `Sau block đó, TIẾP TỤC phân tích entry MỚI như bình thường — khách quan, độc lập với lệnh cũ (có thể ra ORDER mới, WATCHLIST, hoặc NO TRADE; system prompt có luật riêng về lệnh đã có thì theo luật đó).`,
  ].join('\n');
}

/**
 * Lệnh chờ lần trước CHƯA khớp trên nến của hệ thống nhưng còn trong cửa sổ khớp. Nguồn giá
 * (TwelveData) lệch broker vài chục cent — 28/10/2026 SELL limit 4058.2, đỉnh TwelveData 4057.68,
 * broker đã khớp — nên block báo khoảng cách gần nhất và bắt model trả lời cả nhánh "nếu đã khớp".
 */
function buildPreviousLimitBlock(p: PendingSetup): string {
  const dir = p.direction === 'BUY' ? 'BUY (LONG)' : 'SELL (SHORT)';
  const priceThen = p.priceThen != null ? `${p.priceThen}` : 'không rõ';
  const num = (x: number | null | undefined) => (x != null ? `${x}` : '—');
  const closest = p.closestPrice != null
    ? `giá tiến gần entry nhất ${p.closestPrice} (còn cách ${p.closestGapR != null ? `${p.closestGapR.toFixed(2)}R` : '—'} — nguồn giá hệ thống có thể lệch broker vài chục cent, lệnh SÁT entry có thể đã khớp ở broker)`
    : 'chưa có nến nào đóng/mở sau lúc ra tín hiệu';
  return [
    `=== LỆNH CHỜ CHƯA KHỚP — ĐÁNH GIÁ GIỮ HAY HỦY (lệnh ra cách đây ${p.ageMinutes} phút — lúc ${p.analyzedAtVn} giờ VN) ===`,
    `Lần trước hệ thống đã ra LỆNH ${dir} dạng lệnh chờ. Giá lúc đó: ${priceThen}.`,
    `Thông số lệnh: Entry ${num(p.entry)} | SL ${num(p.stopLoss)} | TP1 ${num(p.takeProfit)} | RR ${p.riskReward != null ? `1:${p.riskReward}` : '—'}.`,
    `Trạng thái (code đã chấm trên nến thật, KHÔNG cần tự xác định lại): CHƯA KHỚP entry, chưa chạm TP1; ${closest}. Lệnh chờ tự hủy lúc ${p.fillDeadlineVn ?? 'không rõ'} giờ VN (còn ${p.fillMinutesLeft ?? '—'} phút).`,
    `Chi tiết lệnh lần trước (gồm điều kiện "Hủy lệnh nếu"):`,
    p.rawText,
    ``,
    `⚠️ NHIỆM VỤ với lệnh chờ trên — làm ĐỘC LẬP trên FACTS/nến MỚI, KHÔNG mặc định giữ hướng cũ:`,
    `1. Kiểm POI/entry còn hợp lệ không: điều kiện "Hủy lệnh nếu" (body close), POI đã bị mitigate/invert chưa, cấu trúc khung bias có đổi không, entry còn qua Cổng 1 + Cổng 3 trên dữ liệu mới không.`,
    `2. KHUYẾN NGHỊ (chọn 1, nêu rõ lý do bằng price action):`,
    `   • GIỮ LỆNH CHỜ — POI + thesis còn nguyên.`,
    `   • HỦY LỆNH CHỜ — đã thỏa "Hủy lệnh nếu" / POI vô hiệu / cấu trúc đổi / RR không còn đạt.`,
    `3. Nếu giá đã SÁT entry, trả lời thêm: nếu lệnh ĐÃ KHỚP ở broker thì GIỮ / DỜI SL / THOÁT.`,
    `4. Đặt ở ĐẦU output một block quản lý:`,
    `   #### QUẢN LÝ LỆNH TRƯỚC`,
    `   - Trạng thái: CHỜ KHỚP`,
    `   - Khuyến nghị: [GIỮ LỆNH CHỜ / HỦY LỆNH CHỜ] — [lý do ngắn bằng price action]`,
    `   - Nếu đã khớp ở broker: [GIỮ / DỜI SL / THOÁT] — [lý do ngắn] (bỏ dòng này nếu giá còn xa entry)`,
    `Sau block đó, TIẾP TỤC phân tích entry MỚI như bình thường — khách quan, độc lập với lệnh cũ (có thể ra ORDER mới, WATCHLIST, hoặc NO TRADE; system prompt có luật riêng về lệnh đã có thì theo luật đó).`,
  ].join('\n');
}

// ─── Asset classification ────────────────────────────────────────────────────
const CRYPTO_BASES = new Set(['BTC', 'ETH', 'BNB', 'SOL', 'XRP', 'ADA', 'DOGE', 'LTC']);

export function isCryptoInstrument(instrument: string): boolean {
  const base = instrument.split('/')[0]?.trim().toUpperCase();
  return base ? CRYPTO_BASES.has(base) : false;
}

// ─── Confidence parsing ──────────────────────────────────────────────────────
/**
 * "Confidence: High/Medium/Low" → 85/65/45. Model hay in đậm mức (`Confidence: **Low**`) —
 * trước 27/10/2026 regex không cho `*` giữa dấu `:` và chữ nên khoảng nửa tín hiệu lưu null.
 * Export để backfill bản ghi cũ (SignalOutcomeTracker.rescore).
 */
export function parseConfidence(text: string): number | null {
  const m = text.match(/confidence[^:\n]*:[\s*_]*(High|Medium|Low)(?![a-z])/i);
  if (!m) return null;
  const c = m[1].toLowerCase();
  if (c === 'high') return 85;
  if (c === 'low')  return 45;
  return 65;
}

// ─── Direction parsing ───────────────────────────────────────────────────────
// Vàng dùng từ vựng BUY/SELL ORDER, crypto dùng LONG/SHORT. Parser nhận cả hai.
const DIR_LABEL = {
  BUY:  '(?:BUY\\s+ORDER|LONG)',
  SELL: '(?:SELL\\s+ORDER|SHORT)',
} as const;
// Heading của block ORDER: prompt mẫu là `#### BUY ORDER` / `#### LONG`, nhưng model hay viết
// `## SHORT`, `### SELL ORDER`, `## 🔴 SELL ORDER`, `## [BUY ORDER]` — 23–27/10/2026 có 7 lệnh
// thật bị lưu NO_TRADE vì chỉ nhận `####`. Nhận 2–6 dấu # + tối đa vài ký tự trang trí trước nhãn.
const ORDER_HEAD = '(?:^|\\n)#{2,6}[ \\t]*[^\\w\\n]{0,8}';
// Section kết thúc ở heading kế tiếp (mọi cấp ≥2), `---` hoặc khoảng trống dài.
const SECTION_END = '(?=\\n#{2,6}\\s|---|\\n{3,}|$)';

/**
 * Block ORDER theo hướng. Model có lúc lồng heading (`## 🟢 LONG — ORDER` rồi ngay dưới là
 * `#### LONG`) → heading ngoài cho section rỗng; lấy section đầu tiên có dòng Entry.
 */
function findOrderSection(text: string, action: 'BUY' | 'SELL'): string | null {
  const re = new RegExp(`${ORDER_HEAD}${DIR_LABEL[action]}\\b[\\s\\S]*?${SECTION_END}`, 'gi');
  const all = [...text.matchAll(re)].map((m) => m[0]);
  return all.find((s) => /entry/i.test(s)) ?? all[0] ?? null;
}

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

/** Bullet / markdown / mũi tên đứng trước nhãn của một dòng thông số. */
const LABEL_PREFIX = /^[\s>▸•·◦\-*–—]+/;

/**
 * Dòng DIỄN GIẢI có nhắc tới entry/SL nhưng không khai báo giá của chúng.
 * VD: "Pool kẹp giữa entry–SL (M5/M15): Có — 4388.47 (higher-low M5)" — 4388.47 là
 * giá pool thanh khoản, KHÔNG phải stop loss. Các dòng này đứng TRƯỚC dòng "SL:"
 * trong block ORDER nên match lỏng sẽ nuốt nhầm chúng.
 */
const NOISE_LINE = /pool|kẹp|breakeven|dời|hủy|thoát|trailing/i;

/**
 * Lấy phần giá trị (sau dấu ":") của dòng có NHÃN bắt đầu bằng `keyword`.
 * "- SL: 4381.90 — ..."       → nhãn "SL"                    → khớp
 * "- Entry zone: 4389.50 …"   → nhãn "Entry zone"            → khớp
 * "- Pool kẹp giữa entry–SL:" → nhãn "Pool kẹp giữa entry–SL" → KHÔNG khớp
 */
function findLabelValue(text: string, keyword: string): string | null {
  const atLabelStart = new RegExp(`^\\*{0,2}${keyword}\\b`, 'i');

  for (const line of text.split('\n')) {
    const colon = line.indexOf(':');
    if (colon < 0) continue;
    const label = line.slice(0, colon).replace(LABEL_PREFIX, '').trim();
    if (atLabelStart.test(label)) return line.slice(colon + 1);
  }
  return null;
}

function firstPrice(text: string): number | null {
  const nums = text.match(/\b\d{3,}(?:[.,]\d+)?\b/g);
  if (!nums) return null;
  return parseFloat(nums[0].replace(',', ''));
}

function extractPriceFromLine(text: string, keyword: string): number | null {
  // Ưu tiên dòng khai báo đúng chuẩn "<keyword>: <giá>".
  const value = findLabelValue(text, keyword);
  if (value) {
    const price = firstPrice(value);
    if (price !== null) return price;
  }

  // Fallback cho cách viết lạc chuẩn ("Stop loss (SL) 4381.90") — vẫn loại dòng diễn giải.
  for (const line of text.split('\n')) {
    if (!new RegExp(`\\b${keyword}\\b`, 'i').test(line)) continue;
    if (NOISE_LINE.test(line)) continue;
    const price = firstPrice(line);
    if (price !== null) return price;
  }

  return null;
}

/** "4389.50 – 4391.50", "4389.5-4391.5", "4389.5 đến 4391.5" — hai giá của một vùng. */
const PRICE_RANGE = /(\d{3,}(?:[.,]\d+)?)\s*(?:–|—|-|~|đến|to)\s*(\d{3,}(?:[.,]\d+)?)/i;

/**
 * Entry: ưu tiên "mốc [giá]" — điểm khớp AI chỉ định trong vùng entry (prompt bắt buộc).
 * Lấy số đầu dòng sẽ ra mép vùng (VD "Entry zone: 4389.50 – 4391.50 (mốc 4390.30)"
 * → 4389.50), khiến entry/SL/TP lưu vào DB không khớp với RR do AI tự tính.
 * Thiếu mốc mà dòng là một vùng → lấy MÉP GẦN (BUY = mép trên, SELL = mép dưới), mức giá
 * chạm trước; số đầu dòng luôn là mép dưới, tức mép XA nhất với BUY.
 */
function extractEntryPrice(text: string, action: 'BUY' | 'SELL'): number | null {
  // Bỏ ** quanh số ("**4075.50** – **4079.00**").
  const value  = findLabelValue(text, 'entry')?.replace(/\*/g, '');
  // Model đôi khi viết "anchor" thay vì "mốc" (gặp trong DB, 10/2026).
  const anchor = value?.match(/(?:mốc|anchor)\s*:?\s*(\d{3,}(?:[.,]\d+)?)/i);
  if (anchor) return parseFloat(anchor[1].replace(',', ''));

  const range = value?.match(PRICE_RANGE);
  if (range) {
    const a = parseFloat(range[1].replace(',', ''));
    const b = parseFloat(range[2].replace(',', ''));
    return action === 'BUY' ? Math.max(a, b) : Math.min(a, b);
  }
  return extractPriceFromLine(text, 'entry');
}
