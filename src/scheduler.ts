import cron from 'node-cron';
import { analyzeSignal } from './commands/analyzeSignal';
import { logger } from './logger';

logger.info('Scheduler started — signal analysis every 15 minutes');

// Every 15 minutes: 0, 15, 30, 45 of every hour
cron.schedule('*/15 * * * *', async () => {
  logger.info('Cron triggered: running signal analysis');
  try {
    await analyzeSignal({ force: false });
  } catch (err: any) {
    logger.error('Cron job error', { error: err.message });
  }
});
