import { TradingSignal } from '@prisma/client';
import { prisma } from '../db';
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

  async run(): Promise<TradingSignal> {
    const { instrument, timeframes, candlesCount, minRr } = config;

    logger.info('Signal analysis started', { instrument, timeframes, candlesCount });

    const candlesByTf: Record<string, Candle[]> = {};
    for (const tf of timeframes) {
      candlesByTf[tf] = await this.market.fetchCandles(instrument, tf, candlesCount);
    }

    const currentPrice = await this.market.fetchCurrentPrice(instrument);

    const result = await this.gemini.analyze(instrument, candlesByTf, currentPrice, minRr);

    const signal = await this.persistSignal(instrument, currentPrice, result, candlesByTf);

    await this.notify(signal);

    return prisma.tradingSignal.findUniqueOrThrow({ where: { id: signal.id } });
  }

  private async persistSignal(
    instrument: string,
    currentPrice: number,
    result: AnalysisResult,
    candlesByTf: Record<string, Candle[]>,
  ): Promise<TradingSignal> {
    const lastByTf: Record<string, ReturnType<Candle['toArray']>> = {};
    for (const [tf, candles] of Object.entries(candlesByTf)) {
      const last = candles[candles.length - 1];
      if (last) lastByTf[tf] = last.toArray();
    }

    return prisma.tradingSignal.create({
      data: {
        instrument,
        action: result.action,
        timeframe: 'M5',
        entry: result.entry ?? undefined,
        stop_loss: result.stopLoss ?? undefined,
        take_profit: result.takeProfit ?? undefined,
        risk_reward: result.riskReward ?? undefined,
        confidence: result.confidence ?? undefined,
        current_price: currentPrice,
        reasoning: result.reasoning ?? undefined,
        trend_bias: result.trendBias ?? undefined,
        raw_ai_response: JSON.stringify(result.raw),
        indicators_snapshot: JSON.stringify({ last_candles: lastByTf, price: currentPrice }),
      },
    });
  }

  private async notify(signal: TradingSignal): Promise<void> {
    try {
      const signalCard = this.telegram.formatSignal(signal);
      const messageId = await this.telegram.send(signalCard);

      await prisma.tradingSignal.update({
        where: { id: signal.id },
        data: {
          telegram_message_id: messageId ?? undefined,
          sent_at: new Date(),
        },
      });

      logger.info('Telegram signal sent', { signal_id: signal.id, message_id: messageId });

      if (messageId && signal.reasoning) {
        const analysis = this.telegram.formatAnalysis(signal.reasoning);
        await this.telegram.sendComment(analysis, messageId);
        logger.info('Telegram analysis thread sent', { signal_id: signal.id, reply_to: messageId });
      }
    } catch (err: any) {
      logger.error('Failed to send Telegram message', {
        signal_id: signal.id,
        error: err.message,
      });
    }
  }
}
