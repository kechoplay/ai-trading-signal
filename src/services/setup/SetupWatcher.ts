import { config } from '../../config/trading';
import { logger } from '../../logger';
import { AnalysisBusyError, currentRun, runAnalysis } from '../AnalysisRunner';
import { analyzeTimeframe, Bias } from '../ai/ict/IctPreprocessor';
import { isCandleForming, zonedParts } from '../market/candleTime';
import { MarketDataProvider } from '../market/MarketDataProvider';
import { makeMarketDataProvider } from '../market/MarketDataProviderFactory';
import { DetectedSetup, detectSetup } from './SetupDetector';

/** Giữ tối đa ngần này key chuỗi đã kích hoạt (đủ cho vài ngày, chặn phình RAM). */
const MAX_TRIGGERED_KEYS = 500;
const SYMBOL_GAP_MS = 400;

interface SymbolSnapshot {
  at: string;
  price: number;
  bias: Bias | null;
  setups: DetectedSetup[];
}

/**
 * Kích hoạt phân tích AI theo SỰ KIỆN. AnalysisScheduler chạy theo đồng hồ (mỗi 15–30
 * phút) nên gần như không bao giờ bắt đúng lúc "đã quét → đã CHoCH → đang retest" — cửa
 * sổ đó chỉ vài nến M5/M15. Watcher này chạy cơ học mỗi vài phút (KHÔNG gọi AI, không
 * tốn quota), dò chuỗi trên khung `setupWatcher.timeframe` bằng facts của IctPreprocessor
 * (chỉ nến đã đóng) và CHỈ gọi runAnalysis khi chuỗi tới bước RETEST.
 *
 * Chặn quota: mỗi chuỗi (sweep + cú phá) chỉ kích hoạt 1 lần; cooldown giữa hai lần kích
 * hoạt cùng symbol; trần số lần/ngày. Dùng chung single-flight của AnalysisRunner — đang
 * có lượt chạy thì bỏ qua và thử lại ở tick sau (chưa đánh dấu chuỗi là đã kích hoạt).
 *
 * State (key đã kích hoạt, đếm ngày) chỉ nằm trong RAM: restart process thì một chuỗi
 * đang RETEST có thể được kích hoạt thêm một lần — chấp nhận được, đổi lại không cần bảng DB.
 */
export class SetupWatcher {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private nextRunAt: Date | null = null;
  private lastTickAt: Date | null = null;
  private lastError: string | null = null;
  private lastTrigger: { symbol: string; at: string; key: string; action: string | null } | null = null;
  private readonly snapshots = new Map<string, SymbolSnapshot>();
  private readonly biasCache = new Map<string, { bias: Bias; at: number }>();
  private readonly triggered = new Set<string>();
  private readonly lastTriggerAt = new Map<string, number>();
  private dayKey = '';
  private dayCount = 0;
  private marketInstance: MarketDataProvider | null = null;

  constructor(
    // Tạo provider lười: thiếu API key thì chỉ watcher lỗi ở tick (log), không làm sập
    // server lúc import như khi tạo ngay trong fromConfig().
    private readonly marketFactory: () => MarketDataProvider,
    private readonly symbols: string[],
  ) {}

  static fromConfig(): SetupWatcher {
    const s = config.scheduler.symbols;
    return new SetupWatcher(makeMarketDataProvider, s.length > 0 ? s : [config.instrument]);
  }

  private get market(): MarketDataProvider {
    this.marketInstance ??= this.marketFactory();
    return this.marketInstance;
  }

  start(): void {
    const cfg = config.setupWatcher;
    if (!cfg.enabled) {
      logger.info('Setup watcher tắt (SETUP_WATCHER_ENABLED=false)');
      return;
    }
    if (cfg.intervalMin < 1 || this.symbols.length === 0) {
      logger.error('Setup watcher cấu hình không hợp lệ — không bật', { intervalMin: cfg.intervalMin, symbols: this.symbols });
      return;
    }
    this.arm();
    logger.info('Setup watcher bật', {
      interval_min: cfg.intervalMin, timeframe: cfg.timeframe, bias_timeframe: cfg.biasTimeframe,
      symbols: this.symbols.join(','), cooldown_min: cfg.cooldownMin, max_per_day: cfg.maxPerDay,
      next_run: this.nextRunAt?.toISOString() ?? null,
    });
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.nextRunAt = null;
  }

  /** Trạng thái cho GET /api/setup-watcher — soi chuỗi đang ở bước nào mà không cần đọc log. */
  status(): Record<string, unknown> {
    const cfg = config.setupWatcher;
    const s = config.scheduler;
    const pad = (h: number): string => String(h).padStart(2, '0');
    return {
      enabled: cfg.enabled,
      // Watcher chỉ dò trong khung giờ/ngày của scheduler — dashboard cần để giải thích
      // vì sao snapshot đứng yên (ngoài giờ) thay vì tưởng là lỗi.
      window: `${pad(s.startHour)}:00–${pad(s.endHour)}:00`,
      weekdays: s.weekdays,
      in_window_now: this.inWindow(new Date()),
      running: this.running,
      interval_min: cfg.intervalMin,
      timeframe: cfg.timeframe,
      bias_timeframe: cfg.biasTimeframe,
      require_bias: cfg.requireBias,
      cooldown_min: cfg.cooldownMin,
      max_per_day: cfg.maxPerDay,
      triggers_today: this.dayCount,
      next_run_at: this.nextRunAt?.toISOString() ?? null,
      last_tick_at: this.lastTickAt?.toISOString() ?? null,
      last_trigger: this.lastTrigger,
      last_error: this.lastError,
      symbols: Object.fromEntries(this.snapshots),
    };
  }

  /** Hẹn tick kế tiếp theo ĐỒNG HỒ (bội số intervalMin + offsetSec) để luôn chạy ngay sau khi nến đóng. */
  private arm(): void {
    const { intervalMin, offsetSec } = config.setupWatcher;
    const stepMs = intervalMin * 60_000;
    const now = Date.now();
    let next = Math.floor(now / stepMs) * stepMs + offsetSec * 1000;
    while (next <= now) next += stepMs;
    this.nextRunAt = new Date(next);
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => { void this.fire(); }, next - now);
  }

  /** Cùng khung giờ/ngày với AnalysisScheduler (SCHEDULER_START_HOUR/END_HOUR/WEEKDAYS). */
  private inWindow(at: Date): boolean {
    const s = config.scheduler;
    const p = zonedParts(at, config.marketHours.timezone);
    if (!s.weekdays.includes(p.weekday)) return false;
    const minutes = p.hour * 60 + p.minute;
    return minutes >= s.startHour * 60 && minutes < s.endHour * 60;
  }

  private async fire(): Promise<void> {
    try {
      this.arm();
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      this.lastError = `${new Date().toISOString()} — arm(): ${message}`;
      logger.error('Setup watcher: không hẹn được tick kế tiếp — thử lại sau 1 chu kỳ', { error: message });
      this.timer = setTimeout(() => { void this.fire(); }, config.setupWatcher.intervalMin * 60_000);
    }

    if (!this.inWindow(new Date())) return;
    // Tick trước còn đang chạy (thường vì đang chờ một lượt phân tích AI ~3 phút) → bỏ tick.
    if (this.running) return;

    this.running = true;
    this.lastTickAt = new Date();
    try {
      for (const symbol of this.symbols) {
        try {
          await this.checkSymbol(symbol);
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : String(err);
          this.lastError = `${new Date().toISOString()} — ${symbol}: ${message}`;
          logger.warn('Setup watcher: lỗi khi dò symbol — chờ tick sau', { symbol, error: message });
        }
        if (SYMBOL_GAP_MS > 0) await new Promise((r) => setTimeout(r, SYMBOL_GAP_MS));
      }
    } finally {
      this.running = false;
    }
  }

  /** Bias khung lớn (cache `biasCacheMin` phút — đổi chậm, không đáng tốn request mỗi tick). */
  private async biasFor(symbol: string): Promise<Bias | null> {
    const cfg = config.setupWatcher;
    const cached = this.biasCache.get(symbol);
    if (cached && Date.now() - cached.at < cfg.biasCacheMin * 60_000) return cached.bias;

    const candles = await this.market.fetchCandles(symbol, cfg.biasTimeframe, cfg.biasCandles);
    if (candles.length < 10) return null;
    const forming = isCandleForming(candles[candles.length - 1], cfg.biasTimeframe, config.marketHours.timezone);
    const { bias } = analyzeTimeframe(candles, { formingLast: forming });
    this.biasCache.set(symbol, { bias, at: Date.now() });
    return bias;
  }

  private async checkSymbol(symbol: string): Promise<void> {
    const cfg = config.setupWatcher;
    const tz = config.marketHours.timezone;
    const candles = await this.market.fetchCandles(symbol, cfg.timeframe, cfg.candles);
    if (candles.length < 30) {
      logger.warn('Setup watcher: quá ít nến để dò chuỗi', { symbol, timeframe: cfg.timeframe, count: candles.length });
      return;
    }

    const now = new Date();
    const forming = isCandleForming(candles[candles.length - 1], cfg.timeframe, tz, now);
    const a = analyzeTimeframe(candles, { formingLast: forming });
    const bias = await this.biasFor(symbol);

    // Nến đang chạy + nến vừa đóng: bắt retest bằng wick xảy ra giữa hai tick.
    const tail = candles.slice(-2);
    const live = {
      price: a.lastPrice,
      recentHigh: Math.max(...tail.map((c) => c.high)),
      recentLow: Math.min(...tail.map((c) => c.low)),
    };
    const params = {
      maxSweepAgeBars: cfg.maxSweepAgeBars,
      maxBarsSweepToBreak: cfg.maxBarsSweepToBreak,
      retestProximityAtr: cfg.retestProximityAtr,
    };
    const setups = (['BUY', 'SELL'] as const).map((d) => detectSetup(a, d, live, bias, params));
    this.snapshots.set(symbol, { at: now.toISOString(), price: live.price, bias, setups });

    const ready = setups
      .filter((s) => s.stage === 'RETEST' && s.key != null && !this.triggered.has(s.key))
      .filter((s) => s.biasOk || !cfg.requireBias)
      .sort((x, y) => (y.structure?.index ?? 0) - (x.structure?.index ?? 0))[0];
    if (!ready || !ready.key) return;

    // ── Chặn quota ────────────────────────────────────────────────────────────
    const p = zonedParts(now, tz);
    const today = `${p.year}-${p.month}-${p.day}`;
    if (today !== this.dayKey) { this.dayKey = today; this.dayCount = 0; }
    if (this.dayCount >= cfg.maxPerDay) {
      logger.info('Setup watcher: đủ chuỗi nhưng đã chạm trần lần kích hoạt/ngày', { symbol, key: ready.key, max: cfg.maxPerDay });
      return;
    }
    const last = this.lastTriggerAt.get(symbol);
    if (last != null && Date.now() - last < cfg.cooldownMin * 60_000) {
      logger.info('Setup watcher: đủ chuỗi nhưng còn trong cooldown', { symbol, key: ready.key });
      return;
    }
    if (currentRun()) {
      // Không đánh dấu key → tick sau thử lại nếu chuỗi vẫn ở RETEST.
      logger.info('Setup watcher: đang có phân tích chạy — thử lại tick sau', { symbol, key: ready.key });
      return;
    }

    const note = buildTriggerNote(cfg.timeframe, cfg.biasTimeframe, ready, live.price, bias);
    logger.info('Setup watcher: kích hoạt phân tích AI theo sự kiện', { symbol, key: ready.key, direction: ready.direction });

    this.rememberKey(ready.key);
    this.lastTriggerAt.set(symbol, Date.now());
    this.dayCount++;
    try {
      const r = await runAnalysis({ symbol, analysisType: 'intraday', trigger: 'event', triggerNote: note });
      this.lastTrigger = { symbol, at: new Date().toISOString(), key: ready.key, action: r.action };
    } catch (err: unknown) {
      if (err instanceof AnalysisBusyError) {
        // Bị chen ngay giữa currentRun() và runAnalysis → hoàn lại để tick sau thử lại.
        this.triggered.delete(ready.key);
        this.lastTriggerAt.delete(symbol);
        this.dayCount--;
        logger.warn('Setup watcher: phân tích bị chặn (busy) — thử lại tick sau', { symbol });
        return;
      }
      this.lastTrigger = { symbol, at: new Date().toISOString(), key: ready.key, action: null };
      throw err;
    }
  }

  private rememberKey(key: string): void {
    this.triggered.add(key);
    if (this.triggered.size > MAX_TRIGGERED_KEYS) {
      const oldest = this.triggered.values().next().value;
      if (oldest !== undefined) this.triggered.delete(oldest);
    }
  }
}

/** Mô tả chuỗi vừa dò được để nhét vào prompt (block "LÝ DO LƯỢT PHÂN TÍCH"). */
function buildTriggerNote(tf: string, biasTf: string, s: DetectedSetup, price: number, bias: Bias | null): string {
  const lines = [`Hướng dò được: ${s.direction} trên khung ${tf} (giá lúc kích hoạt ${price}).`];
  if (s.sweep) {
    lines.push(
      `1) Quét ${s.sweep.side === 'SELLSIDE' ? 'ĐÁY (sellside)' : 'ĐỈNH (buyside)'} ` +
      `${s.sweep.levelType === 'EQUAL' ? 'equal level' : 'swing'} ${s.sweep.level}, râu tới ${s.sweep.extreme}, ` +
      `body close quay lại lúc ${s.sweep.time}.`,
    );
  }
  if (s.structure) {
    lines.push(
      `2) ${s.structure.kind} ${s.structure.direction} phá ${s.structure.level} lúc ${s.structure.time}, ` +
      `displacement thân ${s.structure.bodyAtr}× ATR.`,
    );
  }
  if (s.zone) {
    lines.push(`3) Giá đang retest ${s.zone.source} ${s.zone.bottom}–${s.zone.top} do cú phá trên tạo ra.`);
  }
  lines.push(`Bias ${biasTf} (cơ học, swing HH/HL): ${bias ?? 'không rõ'}.`);
  return lines.join('\n');
}
