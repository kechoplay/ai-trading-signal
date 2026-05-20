import { GeminiAnalystService } from './ai/GeminiAnalystService';
import { AnalysisResult } from './ai/dto/AnalysisResult';
import { Candle } from './market/Candle';
import { makeMarketDataProvider } from './market/MarketDataProviderFactory';
import { TelegramNotifier } from './telegram/TelegramNotifier';
import { config } from '../config/trading';
import { logger } from '../logger';

export class SignalOrchestrator {
  constructor(
    private readonly market: ReturnType<typeof makeMarketDataProvider>,
    private readonly gemini: GeminiAnalystService,
    private readonly telegram: TelegramNotifier,
  ) {}

  static fromConfig(): SignalOrchestrator {
    return new SignalOrchestrator(
      makeMarketDataProvider(),
      GeminiAnalystService.fromConfig(),
      TelegramNotifier.fromConfig(),
    );
  }

  /** Number of candles to fetch from market data per timeframe. */
  private static readonly FETCH_COUNT: Record<string, number> = {
    H1:  100,
    M15: 96,
    M5:  60,
  };

  async run(): Promise<string> {
    const { instrument, timeframes, candlesCount, minRr } = config;

    logger.info('Signal analysis started', { instrument, timeframes });

    const candlesByTf: Record<string, Candle[]> = {};
    for (const tf of timeframes) {
      const count = SignalOrchestrator.FETCH_COUNT[tf] ?? candlesCount;
      candlesByTf[tf] = await this.market.fetchCandles(instrument, tf, count);
    }

    const currentPrice = await this.market.fetchCurrentPrice(instrument);
    const { result, rawText } = await this.gemini.analyze(instrument, candlesByTf, currentPrice, minRr);

    await this.notify(result, rawText, instrument, currentPrice, candlesByTf);

    return rawText;
  }

  private async notify(
    result: AnalysisResult,
    rawText: string,
    instrument: string,
    currentPrice: number,
    candlesByTf: Record<string, Candle[]>,
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

        // 3. Gửi file CSV nến từng timeframe vào discussion thread
        await this.telegram.sendCandleFiles(instrument, candlesByTf, messageId);
      }
    } catch (err: any) {
      logger.error('Failed to send Telegram message', { error: err.message });
    }
  }
}
