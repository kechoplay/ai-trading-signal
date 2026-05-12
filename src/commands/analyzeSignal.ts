import 'dotenv/config';
import { MarketHoursService } from '../services/MarketHoursService';
import { SignalOrchestrator } from '../services/SignalOrchestrator';
import { logger } from '../logger';
import { prisma } from '../db';

export async function analyzeSignal(options: { force?: boolean } = {}): Promise<void> {
  const force = options.force ?? process.argv.includes('--force');

  if (!force) {
    const marketHours = MarketHoursService.fromConfig();
    if (!marketHours.isOpen()) {
      logger.warn('Skipped: ' + marketHours.status());
      return;
    }
  }

  try {
    const signal = await SignalOrchestrator.fromConfig().run();

    logger.info(
      `Signal #${signal.id}: ${signal.action} (confidence=${signal.confidence ?? 'n/a'}) — telegram_msg=${signal.telegram_message_id ?? 'not sent'}`,
    );

    if (signal.action === 'BUY' || signal.action === 'SELL') {
      logger.info(
        `  Entry=${signal.entry} | SL=${signal.stop_loss} | TP=${signal.take_profit} | RR=1:${signal.risk_reward}`,
      );
    }
  } catch (err: any) {
    logger.error('Analysis failed: ' + err.message, { stack: err.stack });
    throw err;
  }
}

// Run directly when executed as a script
if (require.main === module) {
  analyzeSignal()
    .catch(() => process.exit(1))
    .finally(() => prisma.$disconnect());
}
