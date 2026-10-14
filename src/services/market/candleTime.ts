import { Candle } from './Candle';

/**
 * Tiện ích thời gian cho nến — xác định nến cuối đã ĐÓNG hay còn ĐANG CHẠY.
 *
 * Vì sao cần: TwelveData/OANDA trả cả cây nến đang hình thành ở cuối mảng. Scheduler
 * chạy ở mốc :00/:30 → lúc :30 nến H1 mới chạy nửa giờ, "close" của nó chỉ là giá hiện
 * tại. Mọi luật dựa trên body close (BOS/CHoCH, sweep-and-reject, "≥2 nến H1 xác nhận")
 * mà tính trên cây nến đó là phán quyết trên một nến CHƯA đóng → tín hiệu ma.
 */

/** Độ dài một nến theo khung (giây). Khung lạ → undefined (không phán được). */
export const TF_SECONDS: Record<string, number> = {
  M1: 60, M5: 300, M15: 900, M30: 1800,
  H1: 3600, H4: 14_400, D: 86_400, W: 604_800,
};

export interface ZonedParts {
  year: number;
  month: number;
  day: number;
  weekday: number; // 0=CN … 6=T7 (khớp Date.getDay)
  hour: number;
  minute: number;
  second: number;
}

/** Bóc các thành phần giờ địa phương của một instant theo múi giờ IANA. */
export function zonedParts(at: Date, timeZone: string): ZonedParts {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'short',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false,
  }).formatToParts(at);
  const get = (type: string): string => parts.find((x) => x.type === type)?.value ?? '0';
  const wd = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(get('weekday'));
  return {
    year: parseInt(get('year'), 10),
    month: parseInt(get('month'), 10),
    day: parseInt(get('day'), 10),
    weekday: wd < 0 ? 0 : wd,
    // hourCycle h23 trả '24' cho nửa đêm ở một số môi trường Node → chuẩn hoá về 0.
    hour: parseInt(get('hour'), 10) % 24,
    minute: parseInt(get('minute'), 10),
    second: parseInt(get('second'), 10),
  };
}

/** Độ lệch (ms) của múi giờ so với UTC tại một instant: local = utc + offset. */
function tzOffsetMs(at: Date, timeZone: string): number {
  const p = zonedParts(at, timeZone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - (at.getTime() - at.getMilliseconds());
}

/**
 * Chuyển timestamp nến của provider thành instant tuyệt đối.
 * - Có hậu tố múi giờ (OANDA: RFC3339 ...Z) → parse thẳng (cắt phần lẻ giây > 3 chữ số).
 * - Không có (TwelveData gọi với timezone=...) → là giờ treo tường của `timeZone`.
 * Trả null nếu không parse được.
 */
export function candleOpenInstant(time: string, timeZone: string): Date | null {
  const t = time.trim();
  if (!t) return null;
  if (/[zZ]$|[+-]\d{2}:?\d{2}$/.test(t)) {
    const d = new Date(t.replace(/(\.\d{3})\d+/, '$1'));
    return Number.isNaN(d.getTime()) ? null : d;
  }
  const iso = /^\d{4}-\d{2}-\d{2}$/.test(t) ? `${t}T00:00:00` : t.replace(' ', 'T');
  const wallAsUtc = Date.parse(`${iso}Z`);
  if (Number.isNaN(wallAsUtc)) return null;
  return new Date(wallAsUtc - tzOffsetMs(new Date(wallAsUtc), timeZone));
}

/**
 * true = nến này CHƯA đóng tại thời điểm `now` (giờ mở + độ dài khung > now).
 * Khung lạ hoặc timestamp không parse được → false (giữ hành vi cũ, không bỏ nến bừa).
 */
export function isCandleForming(candle: Candle, timeframe: string, timeZone: string, now: Date = new Date()): boolean {
  const seconds = TF_SECONDS[timeframe];
  if (!seconds) return false;
  const open = candleOpenInstant(candle.time, timeZone);
  if (!open) return false;
  return open.getTime() + seconds * 1000 > now.getTime();
}
