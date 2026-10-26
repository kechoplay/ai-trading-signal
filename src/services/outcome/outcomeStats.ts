/** Gộp kết quả lệnh thành số liệu — hàm thuần, nhận các dòng `signal_outcomes`. */

export interface OutcomeRow {
  instrument: string;
  direction: string;
  trigger: string | null;
  confidence: number | null;
  status: string;
  planned_rr: number;
  result_r: number | null;
  mfe_r: number | null;
  mae_r: number | null;
  missed_tp: boolean;
}

export interface OutcomeBucket {
  /** Tín hiệu đã vào sổ theo dõi (kể cả chưa chốt). */
  signals: number;
  /** Chưa chốt: PENDING + OPEN. */
  active: number;
  filled: number;
  /** filled / (signals đã chốt khớp-hay-không) — NO_DATA và chưa chốt không tính. */
  fill_rate_pct: number | null;
  tp1: number;
  sl: number;
  expired: number;
  no_fill: number;
  /** Lệnh chờ không khớp mà giá vẫn chạy tới TP1 (bỏ lỡ lệnh thắng). */
  missed_tp: number;
  /** TP1 / (TP1 + SL) — không tính EXPIRED. */
  win_rate_pct: number | null;
  /** Tổng R các lệnh đã khớp và chốt (TP1, SL, EXPIRED). */
  total_r: number;
  /** total_r / số lệnh đã khớp và chốt — kỳ vọng mỗi lệnh. */
  expectancy_r: number | null;
  avg_planned_rr: number | null;
  median_mfe_r: number | null;
  median_mae_r: number | null;
}

const CLOSED_FILLED = new Set(['TP1', 'SL', 'EXPIRED']);
const ACTIVE = new Set(['PENDING', 'OPEN']);

const round = (n: number, d = 2): number => Math.round(n * 10 ** d) / 10 ** d;
const pct = (a: number, b: number): number | null => (b > 0 ? round((a / b) * 100, 1) : null);

function median(xs: number[]): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return round(s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2);
}

export function summarize(rows: OutcomeRow[]): OutcomeBucket {
  const count = (st: string): number => rows.filter((r) => r.status === st).length;
  const tp1 = count('TP1');
  const sl = count('SL');
  const expired = count('EXPIRED');
  const noFill = count('NO_FILL');
  const closedFilled = rows.filter((r) => CLOSED_FILLED.has(r.status));
  const openFilled = rows.filter((r) => r.status === 'OPEN').length;
  const decided = closedFilled.length + noFill; // đã biết khớp hay không
  const totalR = closedFilled.reduce((s, r) => s + (r.result_r ?? 0), 0);
  const measured = rows.filter((r) => CLOSED_FILLED.has(r.status) || r.status === 'OPEN');

  return {
    signals: rows.length,
    active: rows.filter((r) => ACTIVE.has(r.status)).length,
    filled: closedFilled.length + openFilled,
    fill_rate_pct: pct(closedFilled.length, decided),
    tp1, sl, expired,
    no_fill: noFill,
    missed_tp: rows.filter((r) => r.status === 'NO_FILL' && r.missed_tp).length,
    win_rate_pct: pct(tp1, tp1 + sl),
    total_r: round(totalR),
    expectancy_r: closedFilled.length > 0 ? round(totalR / closedFilled.length) : null,
    avg_planned_rr: rows.length > 0 ? round(rows.reduce((s, r) => s + r.planned_rr, 0) / rows.length) : null,
    median_mfe_r: median(measured.map((r) => r.mfe_r).filter((x): x is number => x != null)),
    median_mae_r: median(measured.map((r) => r.mae_r).filter((x): x is number => x != null)),
  };
}

export function groupBy(rows: OutcomeRow[], key: (r: OutcomeRow) => string): Record<string, OutcomeBucket> {
  const groups = new Map<string, OutcomeRow[]>();
  for (const r of rows) {
    const k = key(r);
    const g = groups.get(k);
    if (g) g.push(r);
    else groups.set(k, [r]);
  }
  return Object.fromEntries([...groups].sort(([a], [b]) => a.localeCompare(b)).map(([k, g]) => [k, summarize(g)]));
}

/** Nhóm confidence — Low/Medium/High của prompt không lưu riêng, chỉ có điểm 0–100. */
export function confidenceBand(c: number | null): string {
  if (c == null) return 'unknown';
  if (c >= 70) return '70+';
  if (c >= 50) return '50-69';
  return '<50';
}
