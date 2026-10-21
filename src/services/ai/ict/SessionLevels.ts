import { Candle } from '../../market/Candle';
import { TF_SECONDS, candleOpenInstant, zonedParts } from '../../market/candleTime';
import { config } from '../../../config/trading';

/**
 * Mức giá theo PHIÊN cho kế hoạch ngày vàng: PDH/PDL, PWH/PWL, range Á, range hôm nay.
 * Crypto (24/7) dùng computeCryptoSessionLevels — ngày theo UTC, không lọc cuối tuần.
 *
 * Vì sao code tự tính thay vì để model đọc nến D: nến D của TwelveData cho XAU/USD cắt
 * lúc 03:00 VN (không phải rollover 17:00 New York) và có cả nến T7/CN đi ngang (~3 USD)
 * → thứ Hai "nến D đã đóng gần nhất" là nến Chủ nhật, PDH/PDL sai hoàn toàn. Ở đây ngày
 * giao dịch được dựng lại từ nến H1 theo rollover thật, tuần từ nến H4.
 *
 * Hàm thuần (chỉ đọc config mặc định) — test được với nến giả.
 */

const NY = 'America/New_York';
const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

type SessionConfig = typeof config.dailyPlan.session;

export interface DayStats {
  day: string;        // YYYY-MM-DD — ngày giao dịch (kết thúc lúc rollover)
  open: number;
  high: number;
  low: number;
  close: number;      // close nến cuối của ngày (hôm nay: giá sống của nến đang chạy)
  bars: number;
}

export interface SessionLevels {
  tradingDay: string;
  rolloverVn: string;               // giờ VN của rollover hôm nay, vd "04:00"
  today: DayStats | null;
  prevDay: DayStats | null;
  thisWeek: { weekOf: string; high: number; low: number } | null;
  prevWeek: { weekOf: string; high: number; low: number; complete: boolean } | null;
  /** null với crypto — thị trường 24/7 không có range Á theo nghĩa ICT vàng. */
  asia: {
    status: 'NOT_STARTED' | 'RUNNING' | 'DONE';
    high: number | null;
    low: number | null;
    bars: number;
    windowNy: string;               // "20:00–24:00"
    windowVn: string;               // "07:00–11:00"
  } | null;
}

/** true = thị trường vàng đóng cửa tại instant (T6 từ closeFri → CN tới openSun, giờ NY). */
export function isGoldMarketClosed(ms: number, s: SessionConfig = config.dailyPlan.session): boolean {
  const p = zonedParts(new Date(ms), NY);
  if (p.weekday === 6) return true;
  if (p.weekday === 5 && p.hour >= s.closeFriNyHour) return true;
  if (p.weekday === 0 && p.hour < s.openSunNyHour) return true;
  return false;
}

/**
 * Bỏ nến mà quá nửa thời gian nằm trong giờ đóng cửa cuối tuần. Provider vẫn trả nến
 * T7/CN đi ngang ở giá đóng cửa T6 — để nguyên thì chúng thành "equal highs/lows" giả,
 * kéo ATR xuống và làm Chủ nhật thành "ngày hôm trước". Nến mở cửa thứ Hai (H4 có nửa
 * thời gian đã mở) được giữ. Khung lạ / timestamp không parse được → giữ nguyên.
 */
export function dropClosedMarketBars(
  candles: Candle[],
  timeframe: string,
  timeZone: string = config.marketHours.timezone,
  s: SessionConfig = config.dailyPlan.session,
): Candle[] {
  const seconds = TF_SECONDS[timeframe];
  if (!seconds) return candles;
  // Giờ đóng/mở cửa là giờ chẵn → lấy mẫu mỗi giờ là đủ chính xác (khung < 1h lấy 1 mẫu).
  const stepMs = Math.min(seconds * 1000, HOUR_MS);
  return candles.filter((c) => {
    const open = candleOpenInstant(c.time, timeZone);
    if (!open) return true;
    let closed = 0;
    let total = 0;
    for (let t = open.getTime(); t < open.getTime() + seconds * 1000; t += stepMs) {
      total++;
      if (isGoldMarketClosed(t, s)) closed++;
    }
    return closed * 2 <= total;
  });
}

/**
 * @param h1 nến H1 (đã/ chưa lọc cuối tuần đều được — hàm tự lọc lại)
 * @param h4 nến H4 — dùng cho high/low tuần (H1 ~5 ngày không phủ được tuần trước)
 */
export function computeSessionLevels(
  h1: Candle[],
  h4: Candle[],
  now: Date = new Date(),
  timeZone: string = config.marketHours.timezone,
  s: SessionConfig = config.dailyPlan.session,
): SessionLevels {
  const currentDay = tradingDayOf(now.getTime(), s);
  const currentWeek = weekOf(currentDay);

  // ── Ngày giao dịch từ H1 ─────────────────────────────────────────────────
  const days = new Map<string, DayStats>();
  const asiaBars: Candle[] = [];
  const asiaStartOff = hoursAfterRollover(s.asiaStartNyHour, s);
  const asiaEndOff = hoursAfterRollover(s.asiaEndNyHour, s) || 24;
  for (const c of dropClosedMarketBars(h1, 'H1', timeZone, s)) {
    const open = candleOpenInstant(c.time, timeZone);
    if (!open || open.getTime() > now.getTime()) continue;
    const day = tradingDayOf(open.getTime(), s);
    addToDay(days, day, c);

    if (day === currentDay) {
      const off = hoursAfterRollover(zonedParts(open, NY).hour, s);
      if (off >= asiaStartOff && off < asiaEndOff) asiaBars.push(c);
    }
  }
  const dayKeys = [...days.keys()].sort();
  const prevKey = [...dayKeys].reverse().find((k) => k < currentDay) ?? null;

  // ── Tuần từ H4 ───────────────────────────────────────────────────────────
  const weeks = new Map<string, { high: number; low: number }>();
  for (const c of dropClosedMarketBars(h4, 'H4', timeZone, s)) {
    const open = candleOpenInstant(c.time, timeZone);
    if (!open || open.getTime() > now.getTime()) continue;
    const w = weekOf(tradingDayOf(open.getTime(), s));
    const cur = weeks.get(w);
    weeks.set(w, cur ? { high: Math.max(cur.high, c.high), low: Math.min(cur.low, c.low) } : { high: c.high, low: c.low });
  }
  const weekKeys = [...weeks.keys()].sort();
  const prevWeekKey = [...weekKeys].reverse().find((k) => k < currentWeek) ?? null;
  const thisWeek = weeks.get(currentWeek);
  const prevWeek = prevWeekKey ? weeks.get(prevWeekKey)! : null;

  // ── Range Á ──────────────────────────────────────────────────────────────
  const nowOff = hoursAfterRollover(zonedParts(now, NY).hour, s) + zonedParts(now, NY).minute / 60;
  const asiaStatus: NonNullable<SessionLevels['asia']>['status'] =
    nowOff < asiaStartOff ? 'NOT_STARTED' : nowOff < asiaEndOff ? 'RUNNING' : 'DONE';
  const vnShift = hourShift(now, NY, timeZone);

  return {
    tradingDay: currentDay,
    rolloverVn: hhmm(s.rolloverNyHour + vnShift),
    today: round(days.get(currentDay) ?? null),
    prevDay: round(prevKey ? days.get(prevKey)! : null),
    thisWeek: thisWeek ? { weekOf: currentWeek, high: r2(thisWeek.high), low: r2(thisWeek.low) } : null,
    prevWeek: prevWeek && prevWeekKey
      ? {
        weekOf: prevWeekKey, high: r2(prevWeek.high), low: r2(prevWeek.low),
        // Đủ dữ liệu chỉ khi có nến H4 từ trước tuần đó (không thì đầu tuần bị cắt).
        complete: weekKeys[0] < prevWeekKey,
      }
      : null,
    asia: {
      status: asiaStatus,
      high: asiaBars.length ? r2(Math.max(...asiaBars.map((c) => c.high))) : null,
      low: asiaBars.length ? r2(Math.min(...asiaBars.map((c) => c.low))) : null,
      bars: asiaBars.length,
      windowNy: `${hhmm(s.asiaStartNyHour)}–${s.asiaEndNyHour === 24 ? '24:00' : hhmm(s.asiaEndNyHour)}`,
      windowVn: `${hhmm(s.asiaStartNyHour + vnShift)}–${hhmm(s.asiaEndNyHour + vnShift)}`,
    },
  };
}

/**
 * Mức theo phiên cho CRYPTO (24/7): ngày giao dịch = ngày UTC (nến D Binance đóng lúc
 * 00:00 UTC = 07:00 VN), tuần bắt đầu T2 00:00 UTC. Không lọc nến cuối tuần (crypto giao
 * dịch thật cả T7/CN), không có range Á.
 */
export function computeCryptoSessionLevels(
  h1: Candle[],
  h4: Candle[],
  now: Date = new Date(),
  timeZone: string = config.marketHours.timezone,
): SessionLevels {
  const utcDay = (ms: number): string => new Date(ms).toISOString().slice(0, 10);
  const currentDay = utcDay(now.getTime());
  const currentWeek = weekOf(currentDay);

  const days = new Map<string, DayStats>();
  for (const c of h1) {
    const open = candleOpenInstant(c.time, timeZone);
    if (!open || open.getTime() > now.getTime()) continue;
    addToDay(days, utcDay(open.getTime()), c);
  }
  const prevKey = [...days.keys()].sort().reverse().find((k) => k < currentDay) ?? null;

  const weeks = new Map<string, { high: number; low: number }>();
  for (const c of h4) {
    const open = candleOpenInstant(c.time, timeZone);
    if (!open || open.getTime() > now.getTime()) continue;
    const w = weekOf(utcDay(open.getTime()));
    const cur = weeks.get(w);
    weeks.set(w, cur ? { high: Math.max(cur.high, c.high), low: Math.min(cur.low, c.low) } : { high: c.high, low: c.low });
  }
  const weekKeys = [...weeks.keys()].sort();
  const prevWeekKey = [...weekKeys].reverse().find((k) => k < currentWeek) ?? null;
  const thisWeek = weeks.get(currentWeek);
  const prevWeek = prevWeekKey ? weeks.get(prevWeekKey)! : null;

  return {
    tradingDay: currentDay,
    rolloverVn: hhmm(hourShift(now, 'UTC', timeZone)),
    today: round(days.get(currentDay) ?? null),
    prevDay: round(prevKey ? days.get(prevKey)! : null),
    thisWeek: thisWeek ? { weekOf: currentWeek, high: r2(thisWeek.high), low: r2(thisWeek.low) } : null,
    prevWeek: prevWeek && prevWeekKey
      ? { weekOf: prevWeekKey, high: r2(prevWeek.high), low: r2(prevWeek.low), complete: weekKeys[0] < prevWeekKey }
      : null,
    asia: null,
  };
}

// ─── helpers ──────────────────────────────────────────────────────────────

/**
 * Ngày giao dịch của một instant: giờ NY dời thêm (24 − rollover) giờ → mọi thứ sau
 * 17:00 NY thuộc ngày hôm sau. T7 → gộp về T6, CN (phiên mở cửa tối CN) → gộp về T2.
 */
function tradingDayOf(ms: number, s: SessionConfig): string {
  const p = zonedParts(new Date(ms + (24 - s.rolloverNyHour) * HOUR_MS), NY);
  let utc = Date.UTC(p.year, p.month - 1, p.day);
  if (p.weekday === 6) utc -= DAY_MS;
  if (p.weekday === 0) utc += DAY_MS;
  return new Date(utc).toISOString().slice(0, 10);
}

/** Thứ Hai của tuần chứa ngày giao dịch (đã là T2–T6). */
function weekOf(day: string): string {
  const d = new Date(`${day}T00:00:00Z`);
  const wd = d.getUTCDay();
  return new Date(d.getTime() - ((wd + 6) % 7) * DAY_MS).toISOString().slice(0, 10);
}

/** Số giờ kể từ rollover tới giờ NY `hour` (0..23). */
function hoursAfterRollover(hour: number, s: SessionConfig): number {
  return (((hour - s.rolloverNyHour) % 24) + 24) % 24;
}

/** Độ lệch giờ (to − from) tại instant, vd NY → VN = 11 (mùa hè) / 12 (mùa đông). */
function hourShift(at: Date, from: string, to: string): number {
  const a = zonedParts(at, from);
  const b = zonedParts(at, to);
  const minutes = (b.hour * 60 + b.minute) - (a.hour * 60 + a.minute);
  return Math.round((((minutes % 1440) + 1440) % 1440) / 60);
}

function addToDay(days: Map<string, DayStats>, day: string, c: Candle): void {
  const cur = days.get(day);
  if (!cur) {
    days.set(day, { day, open: c.open, high: c.high, low: c.low, close: c.close, bars: 1 });
    return;
  }
  cur.high = Math.max(cur.high, c.high);
  cur.low = Math.min(cur.low, c.low);
  cur.close = c.close;
  cur.bars++;
}

function round(d: DayStats | null): DayStats | null {
  return d ? { ...d, open: r2(d.open), high: r2(d.high), low: r2(d.low), close: r2(d.close) } : null;
}

function hhmm(h: number): string {
  return `${String(((h % 24) + 24) % 24).padStart(2, '0')}:00`;
}

function r2(n: number): number {
  return Math.round(n * 100) / 100;
}
