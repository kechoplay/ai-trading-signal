import 'dotenv/config';
import { MarketHoursService } from '../services/MarketHoursService';
import { SignalOrchestrator } from '../services/SignalOrchestrator';
import { logger } from '../logger';

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
    const { result } = await SignalOrchestrator.fromConfig().run();
    logger.info('Analysis complete', { action: result.action, confidence: result.confidence });
  } catch (err: any) {
    logger.error('Analysis failed: ' + err.message, { stack: err.stack });
    throw err;
  }
}

// Run directly when executed as a script
if (require.main === module) {
  analyzeSignal()
    .catch(() => process.exit(1));
}
