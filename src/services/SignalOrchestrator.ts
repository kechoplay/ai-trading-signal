import { GeminiAnalystService } from './ai/GeminiAnalystService';
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

  async run(): Promise<string> {
    const { instrument, timeframes, candlesCount, minRr } = config;

    logger.info('Signal analysis started', { instrument, timeframes, candlesCount });

    const candlesByTf: Record<string, Candle[]> = {};
    for (const tf of timeframes) {
      candlesByTf[tf] = await this.market.fetchCandles(instrument, tf, candlesCount);
    }

    const currentPrice = await this.market.fetchCurrentPrice(instrument);
    const analysis = await this.gemini.analyze(instrument, candlesByTf, currentPrice, minRr);

    await this.notify(analysis);

    return analysis;
  }

  private async notify(analysis: string): Promise<void> {
    try {
      const message = this.telegram.formatAnalysis(analysis);
      const messageId = await this.telegram.send(message);
      logger.info('Telegram analysis sent', { message_id: messageId });

      if (messageId) {
        await this.telegram.sendComment(message, messageId);
        logger.info('Telegram analysis thread sent', { reply_to: messageId });
      }
    } catch (err: any) {
      logger.error('Failed to send Telegram message', { error: err.message });
    }
  }
}
