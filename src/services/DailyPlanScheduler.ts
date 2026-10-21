import { config } from '../config/trading';
import { logger } from '../logger';
import { AnalysisBusyError, runAnalysis } from './AnalysisRunner';
import { DAILY_PLAN } from './SignalOrchestrator';

const VN_WEEKDAY = ['CN', 'T2', 'T3', 'T4', 'T5', 'T6', 'T7'];

interface ZonedParts {
  weekday: number;   // 0=CN … 6=T7 (khớp Date.getDay)
  hour: number;
  minute: number;
  second: number;
}

/**
 * Lập KẾ HOẠCH NGÀY (vàng + crypto) theo các mốc GIỜ cố định: startHour, startHour + intervalHours,
 * … ≤ endHour (mặc định 7h/11h/15h/19h, T2–T6 giờ VN). Mỗi mốc chạy lần lượt từng symbol.
 *
 * Tách khỏi AnalysisScheduler vì scheduler đó canh mốc theo PHÚT (minute % interval) —
 * chu kỳ 4 giờ sẽ không khớp. Ở đây mốc là đầu giờ trong danh sách `hours`.
 *
 * Khác scheduler intraday khi đụng single-flight: KHÔNG bỏ lượt mà chờ busyRetrySec rồi
 * thử lại (tối đa busyMaxWaitMin) — plan chỉ vài lượt/ngày, mốc 11h/15h/19h trùng mốc
 * :00 của intraday nên gần như chắc chắn có lúc đụng nhau.
 *
 * Mọi lỗi fail-soft: log rồi chờ mốc sau, không làm chết process server.
 */
export class DailyPlanScheduler {
  private timer: NodeJS.Timeout | null = null;
  private nextRunAt: Date | null = null;
  private lastRunAt: Date | null = null;
  private lastResult: string | null = null;
  private lastError: string | null = null;
  private runCount = 0;
  private skipCount = 0;
  private running = false;
  private readonly hours: number[];

  constructor(
    private readonly enabled: boolean,
    startHour: number,
    endHour: number,
    intervalHours: number,
    private readonly weekdays: number[],
    private readonly symbols: string[],
    private readonly offsetSec: number,
    private readonly busyRetrySec: number,
    private readonly busyMaxWaitMin: number,
    private readonly timezone: string,
  ) {
    const hours: number[] = [];
    if (intervalHours >= 1) {
      for (let h = startHour; h <= Math.min(endHour, 23); h += intervalHours) hours.push(h);
    }
    this.hours = hours;
  }

  static fromConfig(): DailyPlanScheduler {
    const p = config.dailyPlan;
    return new DailyPlanScheduler(
      p.enabled, p.startHour, p.endHour, p.intervalHours, p.weekdays, p.symbols,
      p.offsetSec, p.busyRetrySec, p.busyMaxWaitMin, config.marketHours.timezone,
    );
  }

  start(): void {
    if (!this.enabled) {
      logger.info('Daily plan scheduler tắt (DAILY_PLAN_ENABLED=false)');
      return;
    }
    if (this.hours.length === 0 || this.symbols.length === 0 || this.weekdays.length === 0) {
      logger.error('Daily plan scheduler cấu hình không hợp lệ — không bật', {
        hours: this.hours, symbols: this.symbols, weekdays: this.weekdays,
      });
      return;
    }

    this.arm();
    logger.info('Daily plan scheduler bật', {
      hours: this.hours.map((h) => `${this.pad(h)}:00`).join(','),
      timezone: this.timezone,
      weekdays: this.weekdays.map((d) => VN_WEEKDAY[d]).join(','),
      symbols: this.symbols.join(','),
      next_run: this.nextRunAt ? this.fmt(this.nextRunAt) : null,
    });
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.nextRunAt = null;
  }

  /** Trạng thái cho GET /api/daily-plan. */
  status(): Record<string, unknown> {
    return {
      enabled:      this.enabled,
      hours:        this.hours.map((h) => `${this.pad(h)}:00`),
      timezone:     this.timezone,
      weekdays:     this.weekdays.map((d) => VN_WEEKDAY[d]),
      symbols:      this.symbols,
      runs_per_day: this.hours.length * this.symbols.length,
      next_run_at:  this.nextRunAt ? this.fmt(this.nextRunAt) : null,
      last_run_at:  this.lastRunAt ? this.fmt(this.lastRunAt) : null,
      last_result:  this.lastResult,
      last_error:   this.lastError,
      run_count:    this.runCount,
      skip_count:   this.skipCount,
      running:      this.running,
      now:          this.fmt(new Date()),
    };
  }

  private arm(): void {
    const next = this.nextTick(new Date());
    this.nextRunAt = next;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => { void this.fire(); }, Math.max(0, next.getTime() - Date.now()));
  }

  private async fire(): Promise<void> {
    // Hẹn mốc kế tiếp TRƯỚC khi chạy (lượt có thể kéo dài cả chục phút nếu phải chờ busy).
    try {
      this.arm();
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      this.lastError = `${this.fmt(new Date())} — arm(): ${message}`;
      logger.error('Daily plan: không hẹn được mốc kế tiếp — thử lại sau 1 giờ', { error: message });
      this.timer = setTimeout(() => { void this.fire(); }, 3_600_000);
    }
    if (this.running) {
      logger.warn('Daily plan: lượt trước chưa xong — bỏ mốc này');
      this.skipCount++;
      return;
    }

    this.running = true;
    this.lastRunAt = new Date();
    try {
      for (const symbol of this.symbols) await this.runOne(symbol);
    } finally {
      this.running = false;
    }
  }

  /** Chạy một symbol; đụng single-flight thì chờ rồi thử lại tới busyMaxWaitMin. */
  private async runOne(symbol: string): Promise<void> {
    const deadline = Date.now() + this.busyMaxWaitMin * 60_000;
    for (;;) {
      try {
        const r = await runAnalysis({
          symbol, analysisType: DAILY_PLAN, timeframes: config.dailyPlan.timeframes, trigger: 'scheduler',
        });
        this.runCount++;
        this.lastResult = `${r.symbol} — ${this.fmt(new Date())} (${Math.round(r.durationMs / 1000)}s)`;
        this.lastError = null;
        return;
      } catch (err: unknown) {
        if (err instanceof AnalysisBusyError && Date.now() + this.busyRetrySec * 1000 < deadline) {
          logger.info('Daily plan: đang có phân tích khác chạy — chờ rồi thử lại', {
            symbol, retry_in_sec: this.busyRetrySec, reason: err.message,
          });
          await new Promise((r) => setTimeout(r, this.busyRetrySec * 1000));
          continue;
        }
        this.skipCount++;
        const message = err instanceof Error ? err.message : String(err);
        this.lastError = `${this.fmt(new Date())} — ${symbol}: ${message}`;
        logger.error('Daily plan: lập plan thất bại — chờ mốc sau', { symbol, error: message });
        return;
      }
    }
  }

  /**
   * Mốc kế tiếp: đầu giờ (+offsetSec) thuộc `hours`, đúng ngày làm việc. Bước từng giờ
   * theo đồng hồ của múi giờ cấu hình — nghỉ cuối tuần cũng chỉ ~70 vòng.
   */
  private nextTick(from: Date): Date {
    const p = this.partsIn(from);
    const topOfHour = from.getTime() - from.getMilliseconds() - p.second * 1000 - p.minute * 60_000;

    let candidate = topOfHour + this.offsetSec * 1000;
    while (candidate <= from.getTime()) candidate += 3_600_000;

    for (let i = 0; i < 24 * 8; i++) {
      // Kiểm giờ/ngày tại đầu giờ (bỏ offset) để offset vài phút không đẩy sang giờ khác.
      const q = this.partsIn(new Date(candidate - this.offsetSec * 1000));
      if (this.weekdays.includes(q.weekday) && this.hours.includes(q.hour)) return new Date(candidate);
      candidate += 3_600_000;
    }
    throw new Error('Daily plan: không tìm được mốc chạy hợp lệ — kiểm tra DAILY_PLAN_WEEKDAYS/START_HOUR/END_HOUR');
  }

  private partsIn(at: Date): ZonedParts {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: this.timezone,
      weekday: 'short',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
      hour12: false,
    }).formatToParts(at);

    const get = (type: string): string => parts.find((x) => x.type === type)?.value ?? '0';
    const wd = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(get('weekday'));
    // hourCycle h23 trả '24' cho nửa đêm ở một số môi trường Node → chuẩn hoá về 0.
    const hour = parseInt(get('hour'), 10) % 24;

    return { weekday: wd < 0 ? 0 : wd, hour, minute: parseInt(get('minute'), 10), second: parseInt(get('second'), 10) };
  }

  private fmt(at: Date): string {
    return at.toLocaleString('vi-VN', { timeZone: this.timezone, hour12: false });
  }

  private pad(h: number): string {
    return String(h).padStart(2, '0');
  }
}
