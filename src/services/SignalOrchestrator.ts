import { ClaudeAnalystService, CryptoExtras, PendingSetup, PreviousPlan, isCryptoInstrument } from './ai/ClaudeAnalystService';
import { AnalysisResult } from './ai/dto/AnalysisResult';
import { Candle } from './market/Candle';
import { closedMarketPadding, dropClosedMarketBars } from './ai/ict/SessionLevels';
import { candleOpenInstant, TF_SECONDS } from './market/candleTime';
import { EvalCandle, evaluateOutcome, validateLevels } from './outcome/OutcomeEvaluator';
import { makeMarketDataProvider } from './market/MarketDataProviderFactory';
import { BinanceFuturesService } from './market/BinanceFuturesService';
import { RateLimitSnapshot, TokenUsage } from './ai/transport/LlmTransport';
import { TelegramNotifier } from './telegram/TelegramNotifier';
import { config } from '../config/trading';
import { logger } from '../logger';
import { prisma } from '../db';

// Khung nến BTC dùng làm context cho altcoin (đủ để đọc cấu trúc/hướng chủ đạo).
const BTC_CONTEXT_TIMEFRAMES = ['H4', 'H1'];

/** analysis_type của kế hoạch ngày (DailyPlanScheduler) — tách khỏi carry-forward intraday. */
export const DAILY_PLAN = 'daily_plan';

export class SignalOrchestrator {
  constructor(
    private readonly market: ReturnType<typeof makeMarketDataProvider>,
    private readonly claude: ClaudeAnalystService,
    private readonly telegram: TelegramNotifier,
    private readonly futures: BinanceFuturesService = BinanceFuturesService.fromConfig(),
  ) {}

  static fromConfig(): SignalOrchestrator {
    return new SignalOrchestrator(
      makeMarketDataProvider(),
      ClaudeAnalystService.fromConfig(),
      TelegramNotifier.fromConfig(),
    );
  }

  /** `trigger` = nguồn kích hoạt (scheduler/event/api/mcp) — chỉ để gắn nhãn tin Telegram. */
  async run(
    instrument?: string, timeframes?: string[], analysisType?: string, triggerNote?: string | null, trigger?: string,
  ): Promise<{
    result: AnalysisResult;
    rawText: string;
    instrument: string;
    currentPrice: number;
    usage: TokenUsage | null;
    rateLimit: RateLimitSnapshot | null;
  }> {
    const { instrument: defaultInstrument, timeframes: defaultTimeframes, cryptoTimeframes, candlesByTf: candlesByTfConfig, candlesByTfCrypto, candlesCount } = config;
    instrument = instrument ?? defaultInstrument;
    if (analysisType === DAILY_PLAN) return this.runDailyPlan(instrument, timeframes, trigger);
    const isCrypto = isCryptoInstrument(instrument);
    // Crypto (không truyền timeframes riêng) → bộ khung từ M15 (D/H4/H1/M15); còn lại → mặc định.
    const fallbackTimeframes = isCrypto ? cryptoTimeframes : defaultTimeframes;
    const resolvedTimeframes = (timeframes && timeframes.length > 0) ? timeframes : fallbackTimeframes;
    // Số nến tính facts: crypto dùng map riêng (D/H4/H1/M15), vàng dùng map mặc định.
    const candleCounts = isCrypto ? candlesByTfCrypto : (candlesByTfConfig as Record<string, number>);

    logger.info('Signal analysis started', { instrument, timeframes: resolvedTimeframes });

    // Vàng: provider trả cả nến T7/CN đi ngang (xem dropClosedMarketBars) → lấy dư đúng số ô
    // cuối tuần nằm trong cửa sổ, lọc bỏ rồi cắt lại `count` nến. Crypto 24/7 giữ nguyên.
    const candlesByTf: Record<string, Candle[]> = {};
    for (const tf of resolvedTimeframes) {
      const count = candleCounts[tf] ?? candlesCount;
      if (isCrypto) {
        candlesByTf[tf] = await this.market.fetchCandles(instrument, tf, count);
        continue;
      }
      const raw = await this.market.fetchCandles(instrument, tf, count + closedMarketPadding(count, tf));
      candlesByTf[tf] = dropClosedMarketBars(raw, tf).slice(-count);
    }

    const currentPrice = await this.market.fetchCurrentPrice(instrument);

    // Crypto: lấy thêm futures sentiment (funding/OI) + BTC context cho altcoin.
    const extras = await this.fetchCryptoExtras(instrument, candleCounts, candlesCount);

    // Carry-forward: nếu lần phân tích gần nhất (cùng loại) đang canh WATCHLIST và còn
    // trong cửa sổ thời gian → nhét lại để AI kiểm chứng thay vì phân tích lại từ đầu.
    const pending = await this.loadPendingSetup(instrument, analysisType, candlesByTf);

    const { result, rawText, usage, rateLimit } =
      await this.claude.analyze(instrument, candlesByTf, currentPrice, extras, pending, triggerNote);

    await this.notify(result, rawText, instrument, currentPrice, trigger);

    return { result, rawText, instrument, currentPrice, usage, rateLimit };
  }

  /**
   * Kế hoạch ngày (vàng + crypto): khung D/H4/H1/M15 với số nến riêng, prompt plan, không
   * carry-forward lệnh — thay vào đó đọc plan lượt trước để cập nhật kịch bản. Crypto
   * dùng prompt plan riêng + funding/OI + BTC context (altcoin).
   */
  private async runDailyPlan(instrument: string, timeframes?: string[], trigger?: string): Promise<{
    result: AnalysisResult;
    rawText: string;
    instrument: string;
    currentPrice: number;
    usage: TokenUsage | null;
    rateLimit: RateLimitSnapshot | null;
  }> {
    const { candlesByTf, currentPrice } = await this.fetchDailyPlanData(instrument, timeframes);
    const previous = await this.loadPreviousPlan(instrument);
    const extras = await this.fetchCryptoExtras(instrument, config.dailyPlan.candlesByTf, config.candlesCount);

    const { result, rawText, usage, rateLimit } =
      await this.claude.analyzeDailyPlan(instrument, candlesByTf, currentPrice, previous, extras);

    try {
      const telegram = this.telegram.forInstrument(instrument);
      const messageId = await telegram.send(telegram.formatPlanCard(result, instrument, currentPrice, trigger));
      logger.info('Telegram daily plan sent', { message_id: messageId });
      if (messageId) await telegram.sendComment(telegram.formatAnalysis(rawText), messageId);
    } catch (err: any) {
      logger.error('Failed to send Telegram daily plan', { error: err.message });
    }

    return { result, rawText, instrument, currentPrice, usage, rateLimit };
  }

  /**
   * Nến + giá cho kế hoạch ngày. Vàng: bỏ nến cuối tuần đi ngang (provider vẫn trả nến
   * T7/CN ở giá đóng cửa T6 cho XAU/USD — xem dropClosedMarketBars). Crypto giao dịch thật
   * 24/7 nên giữ nguyên. Public để dry-run dùng chung.
   */
  async fetchDailyPlanData(instrument: string, timeframes?: string[]): Promise<{
    candlesByTf: Record<string, Candle[]>;
    currentPrice: number;
  }> {
    const plan = config.dailyPlan;
    const isCrypto = isCryptoInstrument(instrument);
    const resolvedTimeframes = (timeframes && timeframes.length > 0) ? timeframes : plan.timeframes;
    logger.info('Daily plan analysis started', { instrument, timeframes: resolvedTimeframes });

    const candlesByTf: Record<string, Candle[]> = {};
    for (const tf of resolvedTimeframes) {
      const count = plan.candlesByTf[tf] ?? config.candlesCount;
      const raw = await this.market.fetchCandles(instrument, tf, count);
      candlesByTf[tf] = isCrypto ? raw : dropClosedMarketBars(raw, tf);
      logger.info('Daily plan candles', { tf, fetched: raw.length, kept: candlesByTf[tf].length });
    }
    const currentPrice = await this.market.fetchCurrentPrice(instrument);
    return { candlesByTf, currentPrice };
  }

  /** Plan gần nhất cùng instrument trong cửa sổ previousPlanMaxAgeMin. Fail-soft → null. */
  private async loadPreviousPlan(instrument: string): Promise<PreviousPlan | null> {
    try {
      const since = new Date(Date.now() - config.dailyPlan.previousPlanMaxAgeMin * 60_000);
      const last = await prisma.tradingSignal.findFirst({
        where:   { instrument, analysis_type: DAILY_PLAN, created_at: { gte: since } },
        orderBy: { created_at: 'desc' },
      });
      if (!last) return null;

      const raw = JSON.parse(last.raw_ai_response ?? '{}');
      const scenarios = Array.isArray(raw.conditional_setups)
        ? raw.conditional_setups.map((s: { rawText?: string }) => s?.rawText?.trim()).filter(Boolean).join('\n\n')
        : '';
      if (!scenarios) return null;

      return {
        ageMinutes:   Math.round((Date.now() - new Date(last.created_at).getTime()) / 60000),
        analyzedAtVn: new Date(last.created_at).toLocaleString('vi-VN', {
          timeZone: config.marketHours.timezone, hour12: false,
        }),
        priceThen: last.current_price ?? null,
        trendBias: last.trend_bias ?? null,
        scenarios,
      };
    } catch (err: any) {
      logger.warn('Daily plan: nạp plan lượt trước thất bại — bỏ qua', { error: err?.message ?? String(err) });
      return null;
    }
  }

  /**
   * Thu thập dữ liệu bổ trợ cho crypto: funding rate + open interest (Binance),
   * và nến BTC làm context khi instrument là altcoin (BTC tự nó thì bỏ qua).
   * Trả undefined cho instrument không phải crypto hoặc khi tính năng bị tắt.
   * Fail-soft: lỗi mạng/geo-block → phần thiếu sẽ là null/bỏ trống, không ném lỗi.
   */
  private async fetchCryptoExtras(
    instrument: string,
    candlesByTfConfig: Record<string, number>,
    candlesCount: number,
  ): Promise<CryptoExtras | undefined> {
    if (!isCryptoInstrument(instrument) || !config.binance.sentimentEnabled) return undefined;

    const futures = await this.futures.fetchSentiment(instrument);

    let btcCandles: Record<string, Candle[]> | null = null;
    const base = instrument.split('/')[0]?.trim().toUpperCase();
    if (base && base !== 'BTC') {
      btcCandles = {};
      for (const tf of BTC_CONTEXT_TIMEFRAMES) {
        const count = candlesByTfConfig[tf] ?? candlesCount;
        try {
          btcCandles[tf] = await this.market.fetchCandles('BTC/USD', tf, count);
        } catch (err: any) {
          logger.warn('Fetch BTC context candles failed — bỏ qua', { tf, error: err?.message ?? String(err) });
        }
      }
    }

    return { futures, btcCandles };
  }

  /**
   * Nạp tín hiệu của lần phân tích GẦN NHẤT (cùng instrument + analysis_type) để
   * carry-forward. Điều kiện:
   *  - Tính năng đang bật + có analysisType (longterm không truyền → bỏ, cửa sổ 2h không hợp).
   *  - BUY/SELL trong cửa sổ orderWindowMin, BẤT KỂ bản ghi gần nhất là gì (lượt sau có thể ra
   *    NO_TRADE/WATCHLIST khi lệnh vẫn chạy — prompt vàng cấm lặp ORDER cùng vùng): chấm trên chính
   *    bộ nến vừa lấy, cùng luật với outcome tracker (evaluatePrevOrder), lấy lệnh mới nhất ĐÃ KHỚP
   *    + chưa chạm SL/TP1 → quản lý lệnh; không có thì lệnh chờ mới nhất CHƯA KHỚP còn trong cửa sổ
   *    khớp → giữ/hủy lệnh chờ (thêm 28/10/2026 — nguồn giá lệch broker, lệnh hụt entry vài chục
   *    cent trên TwelveData vẫn có thể đã khớp ở broker).
   *  - Không có lệnh nào: bản ghi GẦN NHẤT là WATCHLIST còn trong cửa sổ windowMin → kiểm chứng
   *    setup. Còn lại → bỏ, phân tích như chưa có lệnh.
   * Fail-soft: mọi lỗi (parse JSON / DB) → trả null, phân tích vẫn chạy bình thường.
   */
  private async loadPendingSetup(
    instrument: string,
    analysisType: string | undefined,
    candlesByTf: Record<string, Candle[]>,
  ): Promise<PendingSetup | null> {
    if (!config.carryForward.enabled || !analysisType) return null;

    try {
      const last = await prisma.tradingSignal.findFirst({
        where:   { instrument, analysis_type: analysisType },
        orderBy: { created_at: 'desc' },
      });
      if (!last) return null;

      const tz = config.marketHours.timezone;
      const fmtVn = (d: Date) => d.toLocaleString('vi-VN', { timeZone: tz, hour12: false });

      // Order: ưu tiên lệnh đã khớp + đang chạy. Scheduler hay lặp lại cùng một lệnh mỗi lượt, bản
      // ghi mới nhất có thể là bản lặp chưa khớp trong khi bản trước đã khớp → xét các lệnh trong
      // cửa sổ, lấy lệnh MỚI NHẤT đang mở; không có thì lấy lệnh chờ MỚI NHẤT còn trong cửa sổ khớp.
      const orders = await prisma.tradingSignal.findMany({
        where: {
          instrument, analysis_type: analysisType, action: { in: ['BUY', 'SELL'] },
          created_at: { gte: new Date(Date.now() - config.carryForward.orderWindowMin * 60_000) },
        },
        orderBy: { created_at: 'desc' },
        take: 20,
      });
      const states = orders.map((o) => ({ o, s: this.evaluatePrevOrder(o, o.action as 'BUY' | 'SELL', candlesByTf) }));
      const pick = states.find((x) => x.s?.status === 'OPEN') ?? states.find((x) => x.s?.status === 'PENDING');

      let src = last;
      let orderInfo: Partial<PendingSetup> | undefined;
      if (pick?.s) {
        src = pick.o;
        const s = pick.s;
        orderInfo = s.status === 'OPEN'
          ? { orderState: 'filled', filledAtVn: fmtVn(new Date(s.filledMs)), mfeR: s.mfeR, maeR: s.maeR }
          : {
              orderState: 'pending', closestPrice: s.closestPrice, closestGapR: s.closestGapR,
              fillDeadlineVn: fmtVn(new Date(s.deadlineMs)),
              fillMinutesLeft: Math.max(0, Math.round((s.deadlineMs - Date.now()) / 60000)),
            };
      } else {
        const ageMinutes = Math.round((Date.now() - new Date(last.created_at).getTime()) / 60000);
        if (last.action !== 'WATCHLIST' || ageMinutes > config.carryForward.windowMin) {
          logger.info('Carry-forward: không có lệnh đang chạy/chờ khớp hay watchlist còn hiệu lực — bỏ qua', {
            instrument, checked: orders.length, last_action: last.action, ageMinutes,
          });
          return null;
        }
      }
      const isOrder = orderInfo != null;

      const raw = JSON.parse(src.raw_ai_response ?? '{}');
      const setup = Array.isArray(raw.conditional_setups) ? raw.conditional_setups[0] : null;
      const rawText: string = setup?.rawText?.trim() || '';
      if (!rawText) return null;

      const kind: 'watchlist' | 'order' = isOrder ? 'order' : 'watchlist';
      // Order: hướng = action đã lưu; Watchlist: hướng = hướng dự kiến trong setup.
      const direction: 'BUY' | 'SELL' = isOrder
        ? (src.action as 'BUY' | 'SELL')
        : (setup?.direction === 'SELL' ? 'SELL' : 'BUY');
      const srcAge = Math.round((Date.now() - new Date(src.created_at).getTime()) / 60000);

      logger.info('Carry-forward: nhét tín hiệu lần trước để đánh giá', {
        instrument, analysisType, kind, direction, ageMinutes: srcAge, signal_id: src.id,
        order_state: orderInfo?.orderState, filled_at: orderInfo?.filledAtVn, closest_price: orderInfo?.closestPrice,
      });
      return {
        kind, direction, ageMinutes: srcAge, analyzedAtVn: fmtVn(new Date(src.created_at)),
        priceThen: src.current_price ?? null, rawText,
        entry: src.entry, stopLoss: src.stop_loss, takeProfit: src.take_profit, riskReward: src.risk_reward,
        ...orderInfo,
      };
    } catch (err: any) {
      logger.warn('Carry-forward: nạp tín hiệu lần trước thất bại — bỏ qua', { error: err?.message ?? String(err) });
      return null;
    }
  }

  /**
   * Chấm lệnh BUY/SELL lần trước trên khung nhỏ nhất vừa lấy (vàng + crypto đều M15) bằng
   * evaluateOutcome — cùng luật bi quan với outcome tracker. OPEN → thông tin khớp; PENDING (chưa
   * khớp, còn trong cửa sổ khớp, chưa chạm TP1) → giá tiến gần entry nhất + hạn khớp; null khi đã
   * chạm SL/TP1 / hết hạn / NO_FILL / thiếu mức giá / nến không phủ tới.
   */
  private evaluatePrevOrder(
    last: { id: number; entry: number | null; stop_loss: number | null; take_profit: number | null;
            current_price: number | null; created_at: Date },
    direction: 'BUY' | 'SELL',
    candlesByTf: Record<string, Candle[]>,
  ): { status: 'OPEN'; filledMs: number; mfeR: number | null; maeR: number | null }
    | { status: 'PENDING'; deadlineMs: number; closestPrice: number | null; closestGapR: number | null }
    | null {
    const { entry, stop_loss: sl, take_profit: tp } = last;
    if (entry == null || sl == null || tp == null || !validateLevels(direction, entry, sl, tp)) {
      logger.info('Carry-forward: lệnh lần trước thiếu/sai mức giá — bỏ qua', { signal_id: last.id });
      return null;
    }

    const tf = Object.keys(candlesByTf)
      .filter((k) => TF_SECONDS[k] && candlesByTf[k].length > 0)
      .sort((a, b) => TF_SECONDS[a] - TF_SECONDS[b])[0];
    if (!tf) return null;

    const tz = config.marketHours.timezone;
    const candles: EvalCandle[] = candlesByTf[tf].flatMap((k) => {
      const open = candleOpenInstant(k.time, tz);
      return open ? [{ openMs: open.getTime(), high: k.high, low: k.low, close: k.close }] : [];
    });
    const c = config.outcome;
    const signalMs = last.created_at.getTime();
    const tfMs = TF_SECONDS[tf] * 1000;
    const fillWindowMs = c.fillWindowMin * 60_000;
    const r = evaluateOutcome({
      direction, entry, stopLoss: sl, takeProfit: tp,
      currentPrice: last.current_price,
      signalMs, tfMs, fillWindowMs, holdMaxMs: c.holdMaxHours * 3_600_000,
      marketFillTolR: c.marketFillTolR, cancelOnTpBeforeFill: c.cancelOnTpBeforeFill, nowMs: Date.now(),
    }, candles);

    if (r.status === 'OPEN' && r.filledMs != null) {
      return { status: 'OPEN', filledMs: r.filledMs, mfeR: r.mfeR, maeR: r.maeR };
    }
    if (r.status === 'PENDING') {
      // Cùng tập nến evaluateOutcome xét khớp: từ nến mở sau lúc ra tín hiệu (gồm nến đang chạy).
      const firstOpen = Math.ceil(signalMs / tfMs) * tfMs;
      const after = candles.filter((k) => k.openMs >= firstOpen);
      const closestPrice = after.length === 0 ? null
        : direction === 'BUY' ? Math.min(...after.map((k) => k.low)) : Math.max(...after.map((k) => k.high));
      const closestGapR = closestPrice == null ? null : Math.abs(entry - closestPrice) / Math.abs(entry - sl);
      return { status: 'PENDING', deadlineMs: signalMs + fillWindowMs, closestPrice, closestGapR };
    }
    logger.info('Carry-forward: lệnh lần trước không còn đang chạy / đang chờ khớp — bỏ qua', {
      signal_id: last.id, status: r.status, tf,
    });
    return null;
  }

  private async notify(
    result: AnalysisResult,
    rawText: string,
    instrument: string,
    currentPrice: number,
    trigger?: string,
  ): Promise<void> {
    try {
      // Kênh theo symbol (BTC/ETH có kênh riêng — TELEGRAM_CHANNELS_BY_SYMBOL).
      const telegram = this.telegram.forInstrument(instrument);
      // 1. Gửi bản gọn (chỉ entry/SL/TP) lên channel
      const summary = telegram.formatSignalSummary(result, instrument, trigger);
      const messageId = await telegram.send(summary);
      logger.info('Telegram signal sent', { message_id: messageId, action: result.action });

      if (messageId) {
        // 2. Gửi bản đầy đủ (giá/xu hướng/confidence/kịch bản + phân tích chi tiết) vào discussion thread
        const signalCard = telegram.formatSignalCard(result, instrument, currentPrice, trigger);
        const analysisHtml = telegram.formatAnalysis(rawText);
        await telegram.sendComment(`${signalCard}\n\n${analysisHtml}`, messageId);
        logger.info('Telegram analysis thread sent', { reply_to: messageId });

      }
    } catch (err: any) {
      logger.error('Failed to send Telegram message', { error: err.message });
    }
  }
}
