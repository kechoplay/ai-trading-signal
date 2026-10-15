import { config } from '../../config/trading';
import { prisma } from '../../db';
import { logger } from '../../logger';
import { AnalysisBusyError, currentRun, runAnalysis } from '../AnalysisRunner';
import { analyzeTimeframe, Bias } from '../ai/ict/IctPreprocessor';
import { candleOpenInstant, isCandleForming, zonedParts } from '../market/candleTime';
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

/** Bản ghi lịch sử gần nhất của một (symbol, hướng) — để chỉ ghi khi ĐỔI bước. */
interface LastRecorded {
  id: number;
  stage: string;
  /** stage + thời điểm sweep + thời điểm cú phá: đổi một trong ba = bước/chuỗi mới. */
  sig: string;
  skipReason: string | null;
  /** Bản ghi này là lần đã gọi AI — không ghi đè skip_reason lên nó. */
  triggered: boolean;
}

/** Chữ ký của trạng thái một hướng — cùng bước nhưng sweep/cú phá khác = chuỗi khác. */
function sigOf(s: DetectedSetup): string {
  return `${s.stage}|${s.sweep?.time ?? ''}|${s.structure?.time ?? ''}`;
}

/** 00:00 hôm nay theo múi giờ cấu hình (giờ VN) — mốc đếm "lần kích hoạt trong ngày". */
function startOfToday(now: Date, tz: string): Date {
  const p = zonedParts(now, tz);
  const d = `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
  return candleOpenInstant(`${d} 00:00:00`, tz) ?? now;
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
 * Lịch sử: mỗi lần một hướng ĐỔI bước (không phải mỗi tick) được ghi vào bảng
 * `setup_watch_events`, kèm việc có gọi AI không + kết quả, hoặc lý do bỏ qua. Khi khởi
 * động, watcher nạp lại từ bảng này các chuỗi đã kích hoạt, mốc cooldown và số lần kích
 * hoạt trong ngày → restart không làm kích hoạt lặp. Mọi lỗi DB đều fail-soft (chỉ log):
 * mất lịch sử còn hơn làm watcher ngừng dò.
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
  /** key chuỗi đã kích hoạt → thời điểm kích hoạt (ms) — để ghi lý do khi chuỗi retest lại. */
  private readonly triggered = new Map<string, number>();
  private readonly lastTriggerAt = new Map<string, number>();
  private dayKey = '';
  private dayCount = 0;
  private marketInstance: MarketDataProvider | null = null;
  /** key `${symbol}|${direction}` → bản ghi lịch sử gần nhất; null = DB chưa có bản ghi nào. */
  private readonly lastRecorded = new Map<string, LastRecorded | null>();
  private hydrating: Promise<void> | null = null;

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
    // Nạp lịch sử ngay khi khởi động (không đợi tick đầu trong khung giờ) để status —
    // triggers_today, last_trigger — đúng cả khi restart ngoài giờ.
    void this.hydrate();
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
    await this.recordTransitions(symbol, cfg.timeframe, live.price, bias, setups);

    // RETEST nhưng ngược/chưa rõ bias → ghi lý do vào lịch sử (không kích hoạt).
    if (cfg.requireBias) {
      for (const s of setups) {
        if (s.stage === 'RETEST' && !s.biasOk) {
          await this.setSkipReason(symbol, s.direction, `ngược / chưa rõ bias ${cfg.biasTimeframe} (${bias ?? 'không rõ'})`);
        }
      }
    }

    // RETEST của chuỗi đã gọi AI rồi → ghi lý do, nếu không thẻ lịch sử trông như bị bỏ qua vô cớ.
    for (const s of setups) {
      const firedAt = s.key != null ? this.triggered.get(s.key) : undefined;
      if (s.stage === 'RETEST' && firedAt != null && (s.biasOk || !cfg.requireBias)) {
        const at = new Date(firedAt).toLocaleTimeString('vi-VN', { timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false });
        await this.setSkipReason(symbol, s.direction, `chuỗi này đã gọi AI lúc ${at} — mỗi chuỗi chỉ kích hoạt 1 lần`);
      }
    }

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
      await this.setSkipReason(symbol, ready.direction, `đã chạm trần ${cfg.maxPerDay} lần kích hoạt/ngày`);
      return;
    }
    const last = this.lastTriggerAt.get(symbol);
    if (last != null && Date.now() - last < cfg.cooldownMin * 60_000) {
      logger.info('Setup watcher: đủ chuỗi nhưng còn trong cooldown', { symbol, key: ready.key });
      const leftMin = Math.ceil((cfg.cooldownMin * 60_000 - (Date.now() - last)) / 60_000);
      await this.setSkipReason(symbol, ready.direction, `còn cooldown (${cfg.cooldownMin}p, còn ~${leftMin}p)`);
      return;
    }
    if (currentRun()) {
      // Không đánh dấu key → tick sau thử lại nếu chuỗi vẫn ở RETEST.
      logger.info('Setup watcher: đang có phân tích chạy — thử lại tick sau', { symbol, key: ready.key });
      await this.setSkipReason(symbol, ready.direction, 'đang có lượt phân tích khác chạy — thử lại tick sau');
      return;
    }

    const note = buildTriggerNote(cfg.timeframe, cfg.biasTimeframe, ready, live.price, bias);
    logger.info('Setup watcher: kích hoạt phân tích AI theo sự kiện', { symbol, key: ready.key, direction: ready.direction });

    // Bản ghi lịch sử của bước RETEST vừa/đã ghi — đánh dấu kích hoạt ngay TRƯỚC khi chạy
    // (~3 phút) để restart giữa chừng vẫn đếm đúng cooldown/trần ngày.
    const rec = this.lastRecorded.get(`${symbol}|${ready.direction}`) ?? null;
    const eventId = rec?.id ?? null;
    if (rec) rec.triggered = true;
    this.rememberKey(ready.key, Date.now());
    this.lastTriggerAt.set(symbol, Date.now());
    this.dayCount++;
    await this.updateEvent(eventId, { triggered: true, triggered_at: new Date(), skip_reason: null });
    try {
      const r = await runAnalysis({ symbol, analysisType: 'intraday', trigger: 'event', triggerNote: note });
      this.lastTrigger = { symbol, at: new Date().toISOString(), key: ready.key, action: r.action };
      await this.updateEvent(eventId, { analysis_action: r.action });
    } catch (err: unknown) {
      if (err instanceof AnalysisBusyError) {
        // Bị chen ngay giữa currentRun() và runAnalysis → hoàn lại để tick sau thử lại.
        this.triggered.delete(ready.key);
        if (rec) rec.triggered = false;
        this.lastTriggerAt.delete(symbol);
        this.dayCount--;
        await this.updateEvent(eventId, { triggered: false, triggered_at: null });
        logger.warn('Setup watcher: phân tích bị chặn (busy) — thử lại tick sau', { symbol });
        return;
      }
      this.lastTrigger = { symbol, at: new Date().toISOString(), key: ready.key, action: null };
      await this.updateEvent(eventId, { analysis_action: 'ERROR' });
      throw err;
    }
  }

  // ── Lịch sử (bảng setup_watch_events) ─────────────────────────────────────────

  /**
   * Nạp lại từ DB (1 lần, gọi từ start() và trước tick đầu): key các chuỗi đã kích hoạt 2
   * ngày gần nhất, mốc cooldown từng symbol, số lần kích hoạt hôm nay và lần kích hoạt gần
   * nhất — để restart không kích hoạt lặp và modal "Hiện tại" không mất "kích hoạt gần nhất".
   * Mọi caller dùng chung một promise: tick đầu chờ nạp xong rồi mới dò (không kích hoạt lặp).
   */
  private hydrate(): Promise<void> {
    // Lỗi cũng không thử lại mỗi tick — chạy tiếp với state rỗng.
    this.hydrating ??= this.loadHistory();
    return this.hydrating;
  }

  private async loadHistory(): Promise<void> {
    try {
      const now = new Date();
      const rows = await prisma.setupWatchEvent.findMany({
        where: { triggered: true, triggered_at: { gte: new Date(now.getTime() - 2 * 86_400_000) } },
        select: { symbol: true, setup_key: true, triggered_at: true, analysis_action: true },
        orderBy: { triggered_at: 'asc' },
      });
      const todayStart = startOfToday(now, config.marketHours.timezone).getTime();
      for (const r of rows) {
        const at = r.triggered_at?.getTime();
        if (at == null) continue;
        if (r.setup_key) this.rememberKey(r.setup_key, at);
        this.lastTriggerAt.set(r.symbol, Math.max(this.lastTriggerAt.get(r.symbol) ?? 0, at));
        if (at >= todayStart) this.dayCount++;
      }
      // Bản ghi cuối (sort asc) = lần kích hoạt gần nhất. analysis_action null = lượt bị
      // ngắt giữa chừng (vd restart khi AI đang chạy) — modal hiện như lỗi.
      const last = rows[rows.length - 1];
      if (last?.triggered_at && !this.lastTrigger) {
        this.lastTrigger = {
          symbol: last.symbol, at: last.triggered_at.toISOString(),
          key: last.setup_key ?? '', action: last.analysis_action,
        };
      }
      const p = zonedParts(now, config.marketHours.timezone);
      this.dayKey = `${p.year}-${p.month}-${p.day}`;
      logger.info('Setup watcher: nạp lại lịch sử kích hoạt từ DB', { keys: this.triggered.size, today: this.dayCount });
    } catch (err: unknown) {
      logger.warn('Setup watcher: nạp lịch sử từ DB thất bại — chạy với state rỗng', { error: errMsg(err) });
    }
  }

  /** Ghi một bản ghi cho mỗi hướng vừa ĐỔI bước (hoặc đổi sang chuỗi khác). */
  private async recordTransitions(
    symbol: string, timeframe: string, price: number, bias: Bias | null, setups: DetectedSetup[],
  ): Promise<void> {
    await this.hydrate();
    for (const s of setups) {
      const k = `${symbol}|${s.direction}`;
      try {
        let prev = this.lastRecorded.get(k);
        if (prev === undefined) {
          // Lần đầu từ khi khởi động → đọc bản ghi cuối trong DB để không ghi trùng sau restart.
          const row = await prisma.setupWatchEvent.findFirst({
            where: { symbol, direction: s.direction, timeframe },
            orderBy: { id: 'desc' },
            select: { id: true, stage: true, detail: true, skip_reason: true, triggered: true },
          });
          prev = row
            ? { id: row.id, stage: row.stage, sig: parseSig(row.detail), skipReason: row.skip_reason, triggered: row.triggered }
            : null;
          this.lastRecorded.set(k, prev);
        }

        const sig = sigOf(s);
        if (prev && prev.sig === sig) continue;
        // Đứng yên ở "chưa có gì" thì không đáng ghi; chỉ ghi NONE khi một chuỗi vừa hỏng/hết hạn.
        if (s.stage === 'NONE' && (!prev || prev.stage === 'NONE')) continue;

        const row = await prisma.setupWatchEvent.create({
          data: {
            symbol, timeframe, direction: s.direction, stage: s.stage,
            prev_stage: prev?.stage ?? null,
            setup_key: s.key,
            price,
            bias,
            bias_ok: s.biasOk,
            note: s.note,
            detail: JSON.stringify({ sig, sweep: s.sweep, structure: s.structure, zone: s.zone }),
          },
          select: { id: true },
        });
        this.lastRecorded.set(k, { id: row.id, stage: s.stage, sig, skipReason: null, triggered: false });
      } catch (err: unknown) {
        logger.warn('Setup watcher: ghi lịch sử thất bại', { symbol, direction: s.direction, error: errMsg(err) });
      }
    }
  }

  /** Ghi lý do RETEST mà không kích hoạt — chỉ ghi khi lý do đổi (tránh update mỗi tick). */
  private async setSkipReason(symbol: string, direction: 'BUY' | 'SELL', reason: string): Promise<void> {
    const rec = this.lastRecorded.get(`${symbol}|${direction}`);
    if (!rec || rec.triggered || rec.skipReason === reason) return;
    rec.skipReason = reason;
    await this.updateEvent(rec.id, { skip_reason: reason });
  }

  private async updateEvent(
    id: number | null,
    data: { triggered?: boolean; triggered_at?: Date | null; analysis_action?: string | null; skip_reason?: string | null },
  ): Promise<void> {
    if (id == null) return;
    try {
      await prisma.setupWatchEvent.update({ where: { id }, data });
    } catch (err: unknown) {
      logger.warn('Setup watcher: cập nhật lịch sử thất bại', { id, error: errMsg(err) });
    }
  }

  /**
   * Lịch sử chuyển bước trong một ngày (giờ VN) — cho GET /api/setup-watcher/history.
   * `date` dạng YYYY-MM-DD, mặc định hôm nay; mới nhất trước.
   */
  async history(opts: { symbol?: string; date?: string; limit?: number }): Promise<Record<string, unknown>> {
    const tz = config.marketHours.timezone;
    const now = new Date();
    const date = opts.date && /^\d{4}-\d{2}-\d{2}$/.test(opts.date)
      ? opts.date
      : (() => { const p = zonedParts(now, tz); return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`; })();
    const from = candleOpenInstant(`${date} 00:00:00`, tz) ?? startOfToday(now, tz);
    const to = new Date(from.getTime() + 86_400_000);
    const limit = Math.min(Math.max(opts.limit ?? 200, 1), 500);

    const rows = await prisma.setupWatchEvent.findMany({
      where: { created_at: { gte: from, lt: to }, ...(opts.symbol ? { symbol: opts.symbol } : {}) },
      orderBy: { id: 'desc' },
      take: limit,
    });
    const events = rows.map(({ detail, ...r }) => {
      let parsed: Record<string, unknown> = {};
      try { parsed = JSON.parse(detail ?? '{}'); } catch { /* bản ghi hỏng JSON → bỏ chi tiết */ }
      const { sig: _sig, ...rest } = parsed;
      return { ...r, ...rest };
    });
    return {
      date,
      events,
      triggered: events.filter((e) => e.triggered).length,
    };
  }

  private rememberKey(key: string, at: number): void {
    this.triggered.set(key, at);
    if (this.triggered.size > MAX_TRIGGERED_KEYS) {
      const oldest = this.triggered.keys().next().value;
      if (oldest !== undefined) this.triggered.delete(oldest);
    }
  }
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Lấy chữ ký trạng thái đã lưu trong cột `detail` (JSON) — '' nếu thiếu/hỏng. */
function parseSig(detail: string | null): string {
  try {
    const sig = (JSON.parse(detail ?? '{}') as { sig?: unknown }).sig;
    return typeof sig === 'string' ? sig : '';
  } catch {
    return '';
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
