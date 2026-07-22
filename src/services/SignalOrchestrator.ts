import { ClaudeAnalystService, CryptoExtras, PendingSetup, isCryptoInstrument } from './ai/ClaudeAnalystService';
import { AnalysisResult } from './ai/dto/AnalysisResult';
import { Candle } from './market/Candle';
import { makeMarketDataProvider } from './market/MarketDataProviderFactory';
import { BinanceFuturesService } from './market/BinanceFuturesService';
import { TelegramNotifier } from './telegram/TelegramNotifier';
import { config } from '../config/trading';
import { logger } from '../logger';
import { prisma } from '../db';

// Khung nến BTC dùng làm context cho altcoin (đủ để đọc cấu trúc/hướng chủ đạo).
const BTC_CONTEXT_TIMEFRAMES = ['H4', 'H1'];

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

  async run(instrument?: string, timeframes?: string[], analysisType?: string): Promise<{ result: AnalysisResult; rawText: string; instrument: string; currentPrice: number }> {
    const { instrument: defaultInstrument, timeframes: defaultTimeframes, cryptoTimeframes, candlesByTf: candlesByTfConfig, candlesByTfCrypto, candlesCount } = config;
    instrument = instrument ?? defaultInstrument;
    const isCrypto = isCryptoInstrument(instrument);
    // Crypto (không truyền timeframes riêng) → bộ khung từ M15 (D/H4/H1/M15); còn lại → mặc định.
    const fallbackTimeframes = isCrypto ? cryptoTimeframes : defaultTimeframes;
    const resolvedTimeframes = (timeframes && timeframes.length > 0) ? timeframes : fallbackTimeframes;
    // Số nến tính facts: crypto dùng map riêng (D/H4/H1/M15), vàng dùng map mặc định.
    const candleCounts = isCrypto ? candlesByTfCrypto : (candlesByTfConfig as Record<string, number>);

    logger.info('Signal analysis started', { instrument, timeframes: resolvedTimeframes });

    const candlesByTf: Record<string, Candle[]> = {};
    for (const tf of resolvedTimeframes) {
      const count = candleCounts[tf] ?? candlesCount;
      candlesByTf[tf] = await this.market.fetchCandles(instrument, tf, count);
    }

    const currentPrice = await this.market.fetchCurrentPrice(instrument);

    // Crypto: lấy thêm futures sentiment (funding/OI) + BTC context cho altcoin.
    const extras = await this.fetchCryptoExtras(instrument, candleCounts, candlesCount);

    // Carry-forward: nếu lần phân tích gần nhất (cùng loại) đang canh WATCHLIST và còn
    // trong cửa sổ thời gian → nhét lại để AI kiểm chứng thay vì phân tích lại từ đầu.
    const pending = await this.loadPendingSetup(instrument, analysisType);

    const { result, rawText } = await this.claude.analyze(instrument, candlesByTf, currentPrice, extras, pending);

    await this.notify(result, rawText, instrument, currentPrice);

    return { result, rawText, instrument, currentPrice };
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
   *  - Bản ghi GẦN NHẤT là WATCHLIST → kiểm chứng setup, hoặc BUY/SELL → đánh giá quản lý
   *    lệnh (giữ/thoát). NO_TRADE → không có gì để mang theo.
   *  - Còn trong cửa sổ config.carryForward.windowMin.
   * Fail-soft: mọi lỗi (parse JSON / DB) → trả null, phân tích vẫn chạy bình thường.
   */
  private async loadPendingSetup(instrument: string, analysisType?: string): Promise<PendingSetup | null> {
    if (!config.carryForward.enabled || !analysisType) return null;

    try {
      const last = await prisma.tradingSignal.findFirst({
        where:   { instrument, analysis_type: analysisType },
        orderBy: { created_at: 'desc' },
      });
      const isOrder = last?.action === 'BUY' || last?.action === 'SELL';
      const isWatchlist = last?.action === 'WATCHLIST';
      if (!last || (!isOrder && !isWatchlist)) return null;

      // Order có cửa sổ rộng hơn watchlist (lệnh giữ lâu hơn POI đang canh).
      const windowMin = isOrder ? config.carryForward.orderWindowMin : config.carryForward.windowMin;
      const ageMinutes = Math.round((Date.now() - new Date(last.created_at).getTime()) / 60000);
      if (ageMinutes > windowMin) {
        logger.info('Carry-forward: tín hiệu gần nhất đã quá cửa sổ, bỏ qua', { instrument, ageMinutes, windowMin });
        return null;
      }

      const raw = JSON.parse(last.raw_ai_response ?? '{}');
      const setup = Array.isArray(raw.conditional_setups) ? raw.conditional_setups[0] : null;
      const rawText: string = setup?.rawText?.trim() || '';
      if (!rawText) return null;

      const kind: 'watchlist' | 'order' = isOrder ? 'order' : 'watchlist';
      // Order: hướng = action đã lưu; Watchlist: hướng = hướng dự kiến trong setup.
      const direction: 'BUY' | 'SELL' = isOrder
        ? (last.action as 'BUY' | 'SELL')
        : (setup?.direction === 'SELL' ? 'SELL' : 'BUY');
      const analyzedAtVn = new Date(last.created_at).toLocaleString('vi-VN', {
        timeZone: config.marketHours.timezone, hour12: false,
      });

      logger.info('Carry-forward: nhét tín hiệu lần trước để đánh giá', {
        instrument, analysisType, kind, direction, ageMinutes,
      });
      return {
        kind, direction, ageMinutes, analyzedAtVn,
        priceThen: last.current_price ?? null, rawText,
        entry: last.entry, stopLoss: last.stop_loss, takeProfit: last.take_profit, riskReward: last.risk_reward,
      };
    } catch (err: any) {
      logger.warn('Carry-forward: nạp tín hiệu lần trước thất bại — bỏ qua', { error: err?.message ?? String(err) });
      return null;
    }
  }

  private async notify(
    result: AnalysisResult,
    rawText: string,
    instrument: string,
    currentPrice: number,
  ): Promise<void> {
    try {
      // 1. Gửi signal card lên channel
      const signalCard = this.telegram.formatSignalCard(result, instrument, currentPrice);
      const messageId = await this.telegram.send(signalCard);
      logger.info('Telegram signal sent', { message_id: messageId, action: result.action });

      if (messageId) {
        // 2. Gửi phân tích chi tiết vào discussion thread
        const analysisHtml = this.telegram.formatAnalysis(rawText);
        await this.telegram.sendComment(analysisHtml, messageId);
        logger.info('Telegram analysis thread sent', { reply_to: messageId });

      }
    } catch (err: any) {
      logger.error('Failed to send Telegram message', { error: err.message });
    }
  }
}
