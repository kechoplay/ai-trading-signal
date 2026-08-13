import { config } from '../config/trading';
import { logger } from '../logger';
import { AnalysisBusyError, currentRun, runAnalysis } from './AnalysisRunner';

const VN_WEEKDAY = ['CN', 'T2', 'T3', 'T4', 'T5', 'T6', 'T7'];

interface ZonedParts {
  weekday: number;   // 0=CN … 6=T7 (khớp Date.getDay)
  hour: number;
  minute: number;
  second: number;
}

/**
 * Tự chạy phân tích intraday theo chu kỳ trong khung giờ giao dịch (mặc định mỗi 15
 * phút, 8h–22h, T2–T6 giờ VN).
 *
 * Vì sao setTimeout tự hẹn lại thay vì setInterval: một lần phân tích mất ~3 phút,
 * setInterval sẽ trôi dần và có thể xếp hàng chồng lên nhau. Mỗi tick tự tính mốc kế
 * tiếp theo ĐỒNG HỒ (…:00/:15/:30/:45) nên không trôi, và luôn chạy ngay sau khi nến
 * M15 đóng — đúng khung entry của prompt vàng.
 *
 * Mọi lỗi đều fail-soft: log rồi chờ tick sau, không bao giờ làm chết process server.
 */
export class AnalysisScheduler {
  private timer: NodeJS.Timeout | null = null;
  private nextRunAt: Date | null = null;
  private lastRunAt: Date | null = null;
  private lastAction: string | null = null;
  private lastError: string | null = null;
  private runCount = 0;
  private skipCount = 0;

  constructor(
    private readonly enabled: boolean,
    private readonly intervalMin: number,
    private readonly startHour: number,
    private readonly endHour: number,
    private readonly weekdays: number[],
    private readonly symbols: string[],
    private readonly offsetSec: number,
    private readonly timezone: string,
  ) {}

  static fromConfig(): AnalysisScheduler {
    const s = config.scheduler;
    return new AnalysisScheduler(
      s.enabled,
      s.intervalMin,
      s.startHour,
      s.endHour,
      s.weekdays,
      s.symbols.length > 0 ? s.symbols : [config.instrument],
      s.offsetSec,
      config.marketHours.timezone,
    );
  }

  start(): void {
    if (!this.enabled) {
      logger.info('Scheduler tắt (SCHEDULER_ENABLED=false) — chỉ chạy phân tích khi bấm tay');
      return;
    }
    if (this.intervalMin < 1 || this.symbols.length === 0 || this.weekdays.length === 0) {
      logger.error('Scheduler cấu hình không hợp lệ — không bật', {
        intervalMin: this.intervalMin, symbols: this.symbols, weekdays: this.weekdays,
      });
      return;
    }

    this.arm();
    logger.info('Scheduler bật', {
      interval_min: this.intervalMin,
      window: `${this.pad(this.startHour)}:00–${this.pad(this.endHour)}:00 ${this.timezone}`,
      weekdays: this.weekdays.map((d) => VN_WEEKDAY[d]).join(','),
      symbols: this.symbols.join(','),
      runs_per_day: this.runsPerDay(),
      next_run: this.nextRunAt ? this.fmt(this.nextRunAt) : null,
    });
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.nextRunAt = null;
  }

  /** Trạng thái cho GET /api/scheduler — soi được lần kế tiếp và lỗi gần nhất. */
  status(): Record<string, unknown> {
    return {
      enabled:      this.enabled,
      interval_min: this.intervalMin,
      window:       `${this.pad(this.startHour)}:00–${this.pad(this.endHour)}:00`,
      timezone:     this.timezone,
      weekdays:     this.weekdays.map((d) => VN_WEEKDAY[d]),
      symbols:      this.symbols,
      runs_per_day: this.runsPerDay(),
      next_run_at:  this.nextRunAt ? this.fmt(this.nextRunAt) : null,
      last_run_at:  this.lastRunAt ? this.fmt(this.lastRunAt) : null,
      last_action:  this.lastAction,
      last_error:   this.lastError,
      run_count:    this.runCount,
      skip_count:   this.skipCount,
      running:      currentRun(),
      now:          this.fmt(new Date()),
    };
  }

  /** Số lần chạy mỗi ngày làm việc — để đối chiếu quota trước khi đổi interval. */
  private runsPerDay(): number {
    return Math.max(0, Math.round(((this.endHour - this.startHour) * 60) / this.intervalMin));
  }

  private arm(): void {
    const next = this.nextTick(new Date());
    this.nextRunAt = next;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => { void this.fire(); }, Math.max(0, next.getTime() - Date.now()));
  }

  private async fire(): Promise<void> {
    // Hẹn lần kế tiếp TRƯỚC khi chạy: phân tích mất ~3 phút, nếu hẹn sau thì mốc sẽ
    // trôi khỏi đồng hồ (…:00/:15) và lệch dần khỏi thời điểm nến M15 đóng.
    // Bọc try/catch vì đây là mắt duy nhất nối chuỗi timer — arm() ném lỗi là scheduler
    // ngừng chạy vĩnh viễn trong im lặng cho tới lần restart process.
    try {
      this.arm();
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      this.lastError = `${this.fmt(new Date())} — arm(): ${message}`;
      logger.error('Scheduler: không hẹn được mốc kế tiếp — thử lại sau 1 chu kỳ', { error: message });
      this.timer = setTimeout(() => { void this.fire(); }, this.intervalMin * 60_000);
    }
    this.lastRunAt = new Date();

    for (const symbol of this.symbols) {
      try {
        const r = await runAnalysis({ symbol, analysisType: 'intraday', trigger: 'scheduler' });
        this.runCount++;
        this.lastAction = `${r.symbol} → ${r.action}`;
        this.lastError = null;
      } catch (err: unknown) {
        this.skipCount++;
        if (err instanceof AnalysisBusyError) {
          // Bấm tay trên dashboard đúng lúc tick chạy → bỏ tick này, không chạy song song.
          logger.warn('Scheduler bỏ lượt — đang có phân tích chạy', { symbol, reason: err.message });
        } else {
          const message = err instanceof Error ? err.message : String(err);
          this.lastError = `${this.fmt(new Date())} — ${symbol}: ${message}`;
          logger.error('Scheduler: phân tích thất bại — chờ lượt sau', { symbol, error: message });
        }
      }
    }

    logger.info('Scheduler: xong lượt', {
      runs: this.runCount, skips: this.skipCount,
      next_run: this.nextRunAt ? this.fmt(this.nextRunAt) : null,
    });
  }

  /**
   * Mốc chạy kế tiếp: bội số của intervalMin theo đồng hồ + offsetSec, nằm trong khung
   * giờ và đúng ngày làm việc. Ngoài khung (đêm, T7/CN) thì nhảy tiếp từng interval cho
   * tới mốc hợp lệ — cuối tuần nghỉ 2 ngày vẫn chỉ là ~300 vòng lặp.
   */
  private nextTick(from: Date): Date {
    const p = this.partsIn(from);
    // Mốc boundary của chu kỳ hiện tại (giây 0), tính theo phút của múi giờ đích để
    // đúng cả với các múi lệch 30/45 phút.
    const boundary =
      from.getTime()
      - from.getMilliseconds()
      - p.second * 1000
      - (p.minute % this.intervalMin) * 60_000;

    let candidate = boundary + this.offsetSec * 1000;
    while (candidate <= from.getTime()) candidate += this.intervalMin * 60_000;

    for (let i = 0; i < 20_000; i++) {
      const at = new Date(candidate);
      if (this.inWindow(at)) return at;
      candidate += this.intervalMin * 60_000;
    }
    // Không thể xảy ra với cấu hình hợp lệ (đã chặn weekdays rỗng ở start()).
    throw new Error('Scheduler: không tìm được mốc chạy hợp lệ — kiểm tra SCHEDULER_WEEKDAYS/START_HOUR/END_HOUR');
  }

  /** Trong khung giờ giao dịch và đúng ngày làm việc (theo múi giờ cấu hình). */
  private inWindow(at: Date): boolean {
    const p = this.partsIn(at);
    if (!this.weekdays.includes(p.weekday)) return false;
    const minutes = p.hour * 60 + p.minute;
    return minutes >= this.startHour * 60 && minutes < this.endHour * 60;
  }

  /** Bóc weekday/hour/minute/second của một mốc UTC theo múi giờ cấu hình. */
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
