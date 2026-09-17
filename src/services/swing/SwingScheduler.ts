import { prisma } from '../../db';
import { logger } from '../../logger';
import { config } from '../../config/trading';
import { runSwingAnalysis } from './SwingRunner';
import { SwingSocketHub } from '../realtime/SwingSocketHub';

// Nghỉ giữa các symbol trong cùng một tick — tránh dồn nhiều request cùng lúc vào
// TwelveData/OANDA (free tier giới hạn request/phút) khi danh sách theo dõi dài.
const SYMBOL_GAP_MS = 400;

/**
 * Job nền dò nhịp nhỏ (zigzag pivot, KHÔNG dùng AI — không tốn quota) theo chu kỳ cho
 * mọi symbol trong danh sách theo dõi (bảng `symbols`, đúng danh sách trên dashboard),
 * rồi đẩy kết quả qua SwingSocketHub cho GUI cập nhật realtime.
 *
 * Đọc danh sách symbol lại từ DB ở MỖI tick (không cache cố định lúc khởi động) để tự
 * theo kịp khi người dùng thêm/xóa coin trên dashboard.
 */
export class SwingScheduler {
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    private readonly hub: SwingSocketHub,
    private readonly intervalMin: number,
  ) {}

  static fromConfig(hub: SwingSocketHub): SwingScheduler {
    return new SwingScheduler(hub, config.swingScheduler.intervalMin);
  }

  start(): void {
    if (!config.swingScheduler.enabled) {
      logger.info('Swing scheduler tắt (SWING_SCHEDULER_ENABLED=false)');
      return;
    }
    if (this.intervalMin < 1) {
      logger.error('Swing scheduler: SWING_SCHEDULER_INTERVAL_MIN không hợp lệ — không bật', {
        intervalMin: this.intervalMin,
      });
      return;
    }
    void this.tick(); // chạy ngay lượt đầu, không đợi hết chu kỳ mới có dữ liệu
    this.timer = setInterval(() => { void this.tick(); }, this.intervalMin * 60_000);
    logger.info('Swing scheduler bật', { interval_min: this.intervalMin });
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private async tick(): Promise<void> {
    // Tick trước chưa xong (danh sách dài / mạng chậm) → bỏ tick này, không xếp chồng.
    if (this.running) {
      logger.warn('Swing scheduler: bỏ tick — lượt trước chưa xong');
      return;
    }
    this.running = true;
    const startedAt = Date.now();
    let ok = 0;
    let failed = 0;

    try {
      const symbols = await prisma.symbol.findMany({ select: { symbol: true } });
      for (const { symbol } of symbols) {
        try {
          const result = await runSwingAnalysis({ symbol }); // dùng SWING_TIMEFRAME mặc định, không gửi Telegram
          this.hub.publish({
            symbol: result.symbol,
            timeframe: result.report.timeframe,
            actionable: result.actionable,
            latest: result.report.latest,
            stats: result.report.stats,
            signals: result.report.signals,
            params: result.report.params,
            currentPrice: result.report.currentPrice,
            generatedAt: new Date().toISOString(),
          });
          ok++;
        } catch (err: any) {
          failed++;
          logger.warn('Swing scheduler: bỏ qua symbol lỗi', { symbol, error: err?.message ?? String(err) });
        }
        if (SYMBOL_GAP_MS > 0) await new Promise((r) => setTimeout(r, SYMBOL_GAP_MS));
      }
    } catch (err: any) {
      logger.error('Swing scheduler: đọc danh sách symbol thất bại', { error: err?.message ?? String(err) });
    } finally {
      this.running = false;
      logger.info('Swing scheduler: xong tick', {
        ok, failed, duration_ms: Date.now() - startedAt, clients: this.hub.clientCount(),
      });
    }
  }
}
