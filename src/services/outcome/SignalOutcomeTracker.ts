import { prisma } from '../../db';
import { config } from '../../config/trading';
import { logger } from '../../logger';
import { isCryptoInstrument } from '../ai/ClaudeAnalystService';
import { closedMarketPadding, dropClosedMarketBars } from '../ai/ict/SessionLevels';
import { candleOpenInstant, TF_SECONDS } from '../market/candleTime';
import { makeMarketDataProvider } from '../market/MarketDataProviderFactory';
import {
  EvalCandle, evaluateOutcome, plannedRr, validateLevels,
} from './OutcomeEvaluator';

/**
 * Chấm kết quả thật của tín hiệu BUY/SELL intraday — job nền, KHÔNG gọi AI.
 *
 * Mỗi lượt: (1) đăng ký tín hiệu mới vào `signal_outcomes`; (2) với các lệnh chưa chốt
 * (PENDING/OPEN) lấy nến M5 một lần cho mỗi symbol rồi chấm lại TỪ ĐẦU bằng `evaluateOutcome`
 * (không giữ state nên restart/lỡ lượt không sao). Trạng thái chốt thì không đụng lại.
 *
 * Lý do tồn tại: trước đây hệ thống ra tín hiệu mà không biết entry có khớp không, TP1 hay SL
 * tới trước — mọi chỉnh sửa prompt đều chỉ dựa vào cảm tính hoặc một lần đo thủ công.
 *
 * Mọi lỗi fail-soft: log rồi chờ lượt sau, không bao giờ làm chết process server.
 */
export class SignalOutcomeTracker {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private lastRunAt: Date | null = null;
  private lastError: string | null = null;
  private lastResult: Record<string, number> | null = null;

  static fromConfig(): SignalOutcomeTracker {
    return new SignalOutcomeTracker();
  }

  start(): void {
    const c = config.outcome;
    if (!c.enabled) {
      logger.info('Outcome tracker tắt (OUTCOME_TRACKER_ENABLED=false)');
      return;
    }
    if (c.intervalMin < 1 || !TF_SECONDS[c.timeframe]) {
      logger.error('Outcome tracker cấu hình không hợp lệ — không bật', { intervalMin: c.intervalMin, timeframe: c.timeframe });
      return;
    }
    // Lượt đầu sau 1 phút để server kịp lên; các lượt sau cách nhau intervalMin kể từ lúc lượt trước XONG.
    this.arm(60_000);
    logger.info('Outcome tracker bật', { interval_min: c.intervalMin, timeframe: c.timeframe });
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  status(): Record<string, unknown> {
    const c = config.outcome;
    return {
      enabled:      c.enabled,
      interval_min: c.intervalMin,
      timeframe:    c.timeframe,
      running:      this.running,
      last_run_at:  this.lastRunAt?.toISOString() ?? null,
      last_result:  this.lastResult,
      last_error:   this.lastError,
    };
  }

  private arm(delayMs: number): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => { void this.fire(); }, delayMs);
  }

  private async fire(): Promise<void> {
    try {
      await this.runOnce();
    } catch (err: unknown) {
      this.lastError = `${new Date().toISOString()} — ${err instanceof Error ? err.message : String(err)}`;
      logger.error('Outcome tracker: lượt chấm thất bại — chờ lượt sau', { error: this.lastError });
    } finally {
      this.arm(config.outcome.intervalMin * 60_000);
    }
  }

  /** Một lượt chấm. Tách riêng để gọi tay/kiểm thử. */
  async runOnce(): Promise<Record<string, number>> {
    if (this.running) return { skipped: 1 };
    this.running = true;
    try {
      const registered = await this.register();
      const evaluated = await this.evaluateActive();
      this.lastRunAt = new Date();
      this.lastError = null;
      this.lastResult = { registered, ...evaluated };
      if (registered > 0 || evaluated.changed > 0) logger.info('Outcome tracker: xong lượt', this.lastResult);
      return this.lastResult;
    } finally {
      this.running = false;
    }
  }

  /** Đưa tín hiệu BUY/SELL chưa có bản ghi kết quả vào sổ theo dõi. */
  private async register(): Promise<number> {
    const since = new Date(Date.now() - config.outcome.backfillDays * 86_400_000);
    const known = await prisma.signalOutcome.findMany({
      where: { signal_at: { gte: since } }, select: { signal_id: true },
    });
    const signals = await prisma.tradingSignal.findMany({
      where: {
        created_at: { gte: since },
        analysis_type: 'intraday',
        action: { in: ['BUY', 'SELL'] },
        entry: { not: null }, stop_loss: { not: null }, take_profit: { not: null },
        id: { notIn: known.map((k) => k.signal_id) },
      },
      orderBy: { created_at: 'asc' },
    });

    let created = 0;
    for (const s of signals) {
      const dir = s.action as 'BUY' | 'SELL';
      const entry = s.entry!, sl = s.stop_loss!, tp = s.take_profit!;
      const valid = validateLevels(dir, entry, sl, tp);
      if (!valid) logger.warn('Outcome tracker: mức giá không hợp lệ — đánh dấu NO_DATA', { signal_id: s.id, dir, entry, sl, tp });
      try {
        await prisma.signalOutcome.create({
          data: {
            signal_id: s.id, instrument: s.instrument, direction: dir, trigger: s.trigger,
            confidence: s.confidence, signal_at: s.created_at,
            entry, stop_loss: sl, take_profit: tp, signal_price: s.current_price,
            planned_rr: valid ? plannedRr(entry, sl, tp) : 0,
            status: valid ? 'PENDING' : 'NO_DATA',
          },
        });
        created++;
      } catch (err: unknown) {
        // Trùng signal_id (hai lượt chồng nhau) là vô hại; lỗi khác để lượt sau thử lại.
        logger.warn('Outcome tracker: không tạo được bản ghi', { signal_id: s.id, error: err instanceof Error ? err.message : String(err) });
      }
    }
    return created;
  }

  /** Chấm lại mọi lệnh PENDING/OPEN: một request nến cho mỗi symbol. */
  private async evaluateActive(): Promise<{ active: number; changed: number; errors: number }> {
    const c = config.outcome;
    const active = await prisma.signalOutcome.findMany({ where: { status: { in: ['PENDING', 'OPEN'] } } });
    const bySymbol = new Map<string, typeof active>();
    for (const o of active) {
      const g = bySymbol.get(o.instrument);
      if (g) g.push(o);
      else bySymbol.set(o.instrument, [o]);
    }

    const tfMs = TF_SECONDS[c.timeframe] * 1000;
    const tz = config.marketHours.timezone;
    const market = makeMarketDataProvider();
    let changed = 0;
    let errors = 0;

    for (const [symbol, rows] of bySymbol) {
      try {
        const now = Date.now();
        const oldest = Math.min(...rows.map((r) => r.signal_at.getTime()));
        const needed = Math.ceil((now - oldest) / tfMs) + 3;
        // Vàng: lấy dư nến cuối tuần rồi bỏ đi (xem closedMarketPadding); crypto 24/7 giữ nguyên.
        const crypto = isCryptoInstrument(symbol);
        const count = Math.min(c.maxCandles, needed + (crypto ? 0 : closedMarketPadding(needed, c.timeframe)));
        const raw = await market.fetchCandles(symbol, c.timeframe, count);
        if (raw.length === 0) {
          logger.warn('Outcome tracker: provider không trả nến — bỏ qua lượt này', { symbol });
          continue;
        }
        const candles: EvalCandle[] = (crypto ? raw : dropClosedMarketBars(raw, c.timeframe))
          .flatMap((k) => {
            const open = candleOpenInstant(k.time, tz);
            return open ? [{ openMs: open.getTime(), high: k.high, low: k.low, close: k.close }] : [];
          });

        for (const o of rows) {
          const r = evaluateOutcome({
            direction: o.direction as 'BUY' | 'SELL',
            entry: o.entry, stopLoss: o.stop_loss, takeProfit: o.take_profit,
            currentPrice: o.signal_price,
            signalMs: o.signal_at.getTime(), tfMs,
            fillWindowMs: c.fillWindowMin * 60_000, holdMaxMs: c.holdMaxHours * 3_600_000,
            marketFillTolR: c.marketFillTolR, nowMs: now,
          }, candles);

          const before = `${o.status}|${o.mfe_r}|${o.mae_r}|${o.missed_tp}`;
          const after = `${r.status}|${r.mfeR}|${r.maeR}|${r.missedTp}`;
          await prisma.signalOutcome.update({
            where: { id: o.id },
            data: {
              status: r.status,
              filled_at: r.filledMs != null ? new Date(r.filledMs) : null,
              exit_at: r.exitMs != null ? new Date(r.exitMs) : null,
              exit_price: r.exitPrice, result_r: r.resultR, mfe_r: r.mfeR, mae_r: r.maeR,
              missed_tp: r.missedTp, checked_at: new Date(now),
            },
          });
          if (before !== after) {
            changed++;
            if (r.status !== o.status) {
              logger.info('Outcome tracker: đổi trạng thái', {
                signal_id: o.signal_id, symbol, dir: o.direction, from: o.status, to: r.status, result_r: r.resultR,
              });
            }
          }
        }
      } catch (err: unknown) {
        errors++;
        this.lastError = `${new Date().toISOString()} — ${symbol}: ${err instanceof Error ? err.message : String(err)}`;
        logger.error('Outcome tracker: chấm symbol thất bại — chờ lượt sau', { symbol, error: this.lastError });
      }
    }
    return { active: active.length, changed, errors };
  }
}
