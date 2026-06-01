import { ClaudeAnalystService } from './ai/ClaudeAnalystService';
import { AnalysisResult } from './ai/dto/AnalysisResult';
import { Candle } from './market/Candle';
import { makeMarketDataProvider } from './market/MarketDataProviderFactory';
import { TelegramNotifier } from './telegram/TelegramNotifier';
import { config } from '../config/trading';
import { logger } from '../logger';

export class SignalOrchestrator {
  constructor(
    private readonly market: ReturnType<typeof makeMarketDataProvider>,
    private readonly claude: ClaudeAnalystService,
    private readonly telegram: TelegramNotifier,
  ) {}

  static fromConfig(): SignalOrchestrator {
    return new SignalOrchestrator(
      makeMarketDataProvider(),
      ClaudeAnalystService.fromConfig(),
      TelegramNotifier.fromConfig(),
    );
  }

  async run(instrument?: string, timeframes?: string[]): Promise<{ result: AnalysisResult; rawText: string; instrument: string; currentPrice: number }> {
    const { instrument: defaultInstrument, timeframes: defaultTimeframes, candlesByTf: candlesByTfConfig, candlesCount } = config;
    instrument = instrument ?? defaultInstrument;
    const resolvedTimeframes = (timeframes && timeframes.length > 0) ? timeframes : defaultTimeframes;

    logger.info('Signal analysis started', { instrument, timeframes: resolvedTimeframes });

    const candlesByTf: Record<string, Candle[]> = {};
    for (const tf of resolvedTimeframes) {
      const count = (candlesByTfConfig as Record<string, number>)[tf] ?? candlesCount;
      candlesByTf[tf] = await this.market.fetchCandles(instrument, tf, count);
    }

    const currentPrice = await this.market.fetchCurrentPrice(instrument);
    const { result, rawText } = await this.claude.analyze(instrument, candlesByTf, currentPrice);

    await this.notify(result, rawText, instrument, currentPrice);

    return { result, rawText, instrument, currentPrice };
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
