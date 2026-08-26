import 'dotenv/config';
import { runSwingAnalysis } from '../services/swing/SwingRunner';
import { logger } from '../logger';

/**
 * CLI dò nhịp nhỏ: `npm run swing -- [SYMBOL] [TIMEFRAME] [--notify]`.
 * In thẳng bản markdown ra stdout (dễ đọc trên terminal hơn HTML Telegram).
 * Không check giờ thị trường: engine chỉ đọc nến có sẵn, gọi lúc nào cũng cho kết quả.
 */
export async function analyzeSwing(): Promise<void> {
  const args = process.argv.slice(2).filter((a) => !a.startsWith('--'));
  const notify = process.argv.includes('--notify');

  const { markdown } = await runSwingAnalysis({
    symbol: args[0], timeframe: args[1], notify,
  });
  process.stdout.write(`\n${markdown}\n\n`);
}

if (require.main === module) {
  analyzeSwing().catch((err: any) => {
    logger.error('Swing analysis failed: ' + err.message, { stack: err.stack });
    process.exit(1);
  });
}
