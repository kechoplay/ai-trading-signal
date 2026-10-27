/** Gộp kết quả lệnh thành số liệu — hàm thuần, nhận các dòng `signal_outcomes`. */

export interface OutcomeRow {
  instrument: string;
  direction: string;
  trigger: string | null;
  confidence: number | null;
  status: string;
  signal_at: Date;
  entry: number;
  stop_loss: number;
  filled_at: Date | null;
  exit_at: Date | null;
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

/**
 * Gộp tín hiệu trùng thành SETUP — mỗi setup tính một lệnh. Scheduler 30 phút ra lại cùng một kế
 * hoạch nhiều lần (23/10: SELL 4033.8 lặp 13 lần, 6 lần TP1 → +17R cho một lệnh +2.9R thật).
 *
 * Một tín hiệu nhập vào setup trước đó (cùng symbol + hướng) khi: entry lệch ≤ `entryTolR` × khoảng SL
 * so với tín hiệu gần nhất của setup, VÀ ra lúc setup còn hiệu lực (chưa chốt; lệnh chưa khớp còn
 * hiệu lực tới hết `fillWindowMs`). Đại diện setup = tín hiệu KHỚP sớm nhất (lệnh thật sự vào), chưa
 * có thì tín hiệu đầu tiên — nguồn kích hoạt/confidence trong thống kê lấy theo đại diện.
 */
export function dedupeSetups<T extends OutcomeRow>(rows: T[], opts: { fillWindowMs: number; entryTolR: number }): T[] {
  interface Setup { members: T[]; entry: number; risk: number; aliveUntil: number }
  const aliveUntil = (r: T): number => {
    if (r.status === 'PENDING' || r.status === 'OPEN') return Infinity;
    if (r.exit_at) return r.exit_at.getTime();
    if (r.status === 'NO_FILL') return r.signal_at.getTime() + opts.fillWindowMs;
    return r.signal_at.getTime();
  };

  const setups: Setup[] = [];
  const byKey = new Map<string, Setup[]>();
  for (const r of [...rows].sort((a, b) => a.signal_at.getTime() - b.signal_at.getTime())) {
    const key = `${r.instrument}|${r.direction}`;
    const t = r.signal_at.getTime();
    const risk = Math.abs(r.entry - r.stop_loss);
    const list = byKey.get(key) ?? [];
    const s = list.find((x) => t <= x.aliveUntil && Math.abs(r.entry - x.entry) <= opts.entryTolR * Math.max(risk, x.risk));
    if (s) {
      s.members.push(r);
      s.entry = r.entry;
      s.risk = risk;
      s.aliveUntil = Math.max(s.aliveUntil, aliveUntil(r));
    } else {
      const ns: Setup = { members: [r], entry: r.entry, risk, aliveUntil: aliveUntil(r) };
      list.push(ns);
      byKey.set(key, list);
      setups.push(ns);
    }
  }

  return setups.map(({ members }) => {
    const filled = members.filter((m) => m.filled_at != null);
    if (filled.length === 0) return members[0];
    return filled.reduce((a, b) => (b.filled_at!.getTime() < a.filled_at!.getTime() ? b : a));
  });
}

/** Nhóm confidence — Low/Medium/High của prompt không lưu riêng, chỉ có điểm 0–100. */
export function confidenceBand(c: number | null): string {
  if (c == null) return 'unknown';
  if (c >= 70) return '70+';
  if (c >= 50) return '50-69';
  return '<50';
}
