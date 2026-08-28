import 'dotenv/config';
import { runSwingAnalysis } from '../services/swing/SwingRunner';
import { EXIT_RULES, ExitRuleName } from '../services/swing/SwingSignalService';
import { logger } from '../logger';

/**
 * CLI dò nhịp nhỏ: `npm run swing -- [SYMBOL] [TIMEFRAME] [--rule=TP1_FULL] [--notify]`
 * In thẳng bản markdown ra stdout (dễ đọc trên terminal hơn HTML Telegram).
 * Không check giờ thị trường: engine chỉ đọc nến có sẵn, gọi lúc nào cũng cho kết quả.
 *
 * `--rule` đổi luật thoát dùng cho thống kê chính (TP1_FULL | PARTIAL_BE | TRAIL_PIVOT)
 * cho riêng lần chạy này — cả ba luật vẫn luôn hiện trong bảng so sánh.
 */
export async function analyzeSwing(): Promise<void> {
  const args = process.argv.slice(2).filter((a) => !a.startsWith('--'));
  const flag = (name: string): string | undefined =>
    process.argv.find((a) => a.startsWith(`--${name}=`))?.split('=')[1];

  const rule = (flag('rule') ?? '').toUpperCase();

  const { markdown } = await runSwingAnalysis({
    symbol: args[0], timeframe: args[1],
    notify: process.argv.includes('--notify'),
    exitRule: (EXIT_RULES as string[]).includes(rule) ? (rule as ExitRuleName) : undefined,
  });
  process.stdout.write(`\n${markdown}\n\n`);
}

if (require.main === module) {
  analyzeSwing().catch((err: any) => {
    logger.error('Swing analysis failed: ' + err.message, { stack: err.stack });
    process.exit(1);
  });
}
