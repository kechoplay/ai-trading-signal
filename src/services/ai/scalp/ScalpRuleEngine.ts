/**
 * ScalpRuleEngine.ts
 * -----------------------------------------------------------------------------
 * Gate SỐ HỌC chạy ở CODE (trước khi gọi LLM). Mọi gate thuần số được chấm tại đây,
 * KHÔNG giao cho LLM (LLM hay sai phép chia và so sánh). Code chấm xong, sinh khối
 * `[GATE_FLAGS]` để chèn vào input LLM.
 *
 * Ranh giới phân công (xem spec rule_engine):
 *  - Code chấm : S0, S1a, S1b, S1c, S2, S4, S5, C1–C3 (thuần số — mọi so sánh trên OHLC).
 *  - LLM chấm  : chọn POI khi có nhiều ứng viên, C4 (nến xác nhận có bám POI không —
 *                phụ thuộc POI do LLM chọn nên code không chấm thay được), và diễn giải.
 *  - S1 tổng   = S1a AND S1b AND S1c → code chấm trọn, LLM chỉ đọc kết quả.
 *
 * C1–C3 chấm trên nến M1 ÁP CHÓT (m1[len-2]) — KHÔNG dùng nến cuối vì nến cuối thường
 * chưa đóng (data lấy giữa chừng nến đang chạy), OHLC của nó còn đổi nên gate chấm trên
 * nó có thể lật ngay sau đó. Nến áp chót là nến ĐÃ ĐÓNG mới nhất → phán quyết ổn định.
 * Chấm cho CẢ HAI hướng (buy/sell) vì hướng lệnh do LLM chốt sau — LLM chỉ đọc cột khớp
 * hướng của mình.
 *
 * S4 dùng KIẾN TRÚC A (một vòng): trước khi gọi LLM chưa có ứng viên SL/TP nên
 * gate_s4 = PENDING; RR thực được hậu kiểm sau khi LLM trả ORDER (evaluateS4()).
 * -----------------------------------------------------------------------------
 */

import { Candle } from '../../market/Candle';
import { IctFacts } from '../ict/IctPreprocessor';

/** Buffer spread mặc định (USD/bên) cho RR thực — tách config để chỉnh theo broker. */
export const SPREAD_BUFFER = 0.3;

/** Hệ số ngưỡng range20 cho S1b (chỉnh 3–4 khi tinh chỉnh). */
const S1B_RANGE_FACTOR = 4;

/** Hệ số ngưỡng S5 chế độ chuẩn: atr_m5_current ≥ 0.8 × atr_m5_avg20. */
const S5_STD_FACTOR = 0.8;

/** Ngưỡng tuyệt đối tạm (USD) cho S5 chế độ fallback khi thiếu atr_m5_avg20. */
const S5_FALLBACK_THRESHOLD = 1.5;

/** RR thực tối thiểu để S4 PASS — LLM cũng tự chặn ở ngưỡng này (prompt nội suy hằng số). */
export const S4_MIN_RR = 1.3;

/** S1a: BOS/CHoCH gần nhất phải cách nến hiện tại tối đa ngần này nến M5. */
const S1A_MAX_BARS = 20;

/** S1c: cửa sổ (số nến M5 cuối) để soi chuỗi swing cao dần / thấp dần. */
const S1C_WINDOW = 20;

/** C2: thân nến ≥ ngần này × range của chính nó. */
const C2_BODY_RATIO = 0.5;

/** S2: cửa sổ nến M5 nhìn lại TRƯỚC nến CHoCH để tìm sweep. */
const S2_LOOKBACK = 20;

type Verdict = 'PASS' | 'FAIL' | 'PENDING' | 'FALLBACK';
type Pf = 'PASS' | 'FAIL';

/** OHLC gọn của một nến — dùng để LLM trích dẫn trong output. */
interface Ohlc {
  time: string;
  open: number;
  high: number;
  low: number;
  close: number;
}

/** Gate phụ thuộc hướng lệnh — code chấm sẵn cả hai cột, LLM đọc cột khớp hướng. */
export interface DirGate {
  buy: Pf;
  sell: Pf;
  detail: string;
}

export interface GateFlags {
  s0: { verdict: Pf; reason?: string };
  s1a: { verdict: Pf; barsSince: number | null; limit: number; structure: string | null };
  s1b: { verdict: Pf; range20: number | null; threshold: number | null };
  s1c: { verdict: Pf; detail: string };
  /** S1 tổng = S1a AND S1b AND S1c — code chấm trọn, LLM không tổng hợp lại. */
  s1: Pf;
  /** Sweep trước CHoCH. 'N/A' khi cấu trúc gần nhất là BOS (continuation không cần sweep). */
  s2: { buy: Pf | 'N/A'; sell: Pf | 'N/A'; detail: string };
  s4: { verdict: Verdict }; // PENDING trước LLM (kiến trúc A)
  s5: {
    verdict: Pf;
    mode: 'standard' | 'fallback';
    atrCur: number | null;
    threshold: number | null;
  };
  /** C1–C3 chấm trên nến M1 ÁP CHÓT (nến đã đóng mới nhất). C4 do LLM chấm (cần POI). */
  c1: DirGate;
  c2: { verdict: Pf; detail: string };
  c3: DirGate;
  /** OHLC nến M1 áp chót (ứng viên nến xác nhận) — để LLM trích dẫn FACTS trong output. */
  m1Candle: Ohlc | null;
  /** Nến M1 cuối cùng — CHƯA đóng, bị loại khỏi mọi gate. Chỉ hiển thị để LLM khỏi nhầm. */
  m1Running: Ohlc | null;
  modeS5: 'standard' | 'fallback';
  killZone: boolean;
  /** true = một hard gate FAIL → LLM KHÔNG được xuất ORDER (dùng cho chặn sớm nếu muốn). */
  hardBlocked: boolean;
}

const r2 = (x: number): number => Math.round(x * 100) / 100;

/** True Range trung bình N nến gần nhất (USD) — baseline biến động cho S5 (atr_m5_avg20). */
export function meanTrueRange(candles: Candle[] | undefined, period: number): number | null {
  if (!candles || candles.length < period + 1) return null;
  const trs: number[] = [];
  for (let i = 1; i < candles.length; i++) {
    const h = candles[i].high, l = candles[i].low, pc = candles[i - 1].close;
    trs.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)));
  }
  const recent = trs.slice(-period);
  return r2(recent.reduce((a, b) => a + b, 0) / recent.length);
}

/**
 * GATE S0 — Tính toàn vẹn dữ liệu (HARD).
 *  1. Thiếu atr_m5_current hoặc atr_m1_current → FAIL "thiếu ATR".
 *  2. Thiếu atr_m5_avg20 → PASS nhưng ép mode_s5 = fallback (xử lý ở computeS5).
 *  3. Giá trong FACTS (swing/OB/FVG/liquidity M5) nằm ngoài [min_low, max_high] của
 *     nến M5 → FAIL "FACTS mâu thuẫn".
 */
function computeS0(
  m5: Candle[] | undefined,
  atrM5: number | null,
  atrM1: number | null,
  facts: IctFacts,
): GateFlags['s0'] {
  if (atrM5 == null || atrM1 == null) {
    return { verdict: 'FAIL', reason: 'thiếu ATR' };
  }
  if (m5 && m5.length > 0) {
    const minLow = Math.min(...m5.map((c) => c.low));
    const maxHigh = Math.max(...m5.map((c) => c.high));
    const tf = facts.timeframes['M5'];
    if (tf) {
      const prices: number[] = [
        ...tf.swingHighs.map((s) => s.price),
        ...tf.swingLows.map((s) => s.price),
        ...tf.orderBlocks.flatMap((o) => [o.top, o.bottom]),
        ...tf.fvgs.flatMap((f) => [f.top, f.bottom]),
        ...tf.liquidity.equalHighs.map((l) => l.price),
        ...tf.liquidity.equalLows.map((l) => l.price),
      ];
      // Đệm nhỏ theo ATR để tránh loại oan do wick/làm tròn.
      const pad = atrM5 * 0.5;
      const outlier = prices.find((p) => p < minLow - pad || p > maxHigh + pad);
      if (outlier != null) {
        return { verdict: 'FAIL', reason: `FACTS mâu thuẫn (giá ${outlier} ngoài dải nến M5)` };
      }
    }
  }
  return { verdict: 'PASS' };
}

/**
 * GATE S1b — Độ rộng range (HARD, phần số của S1).
 *   range20   = max(high[-20:]) - min(low[-20:])
 *   threshold = S1B_RANGE_FACTOR × atr_m5_current
 *   PASS nếu range20 ≥ threshold.
 */
function computeS1b(m5: Candle[] | undefined, atrM5: number | null): GateFlags['s1b'] {
  if (!m5 || m5.length < 20 || atrM5 == null || atrM5 <= 0) {
    return { verdict: 'FAIL', range20: null, threshold: null };
  }
  const last20 = m5.slice(-20);
  const range20 = r2(Math.max(...last20.map((c) => c.high)) - Math.min(...last20.map((c) => c.low)));
  const threshold = r2(S1B_RANGE_FACTOR * atrM5);
  return { verdict: range20 >= threshold ? 'PASS' : 'FAIL', range20, threshold };
}

/**
 * GATE S1a — Độ tươi cấu trúc (phần số của S1).
 *   barsSince = (index nến cuối) − (index nến tạo BOS/CHoCH gần nhất)
 *   PASS nếu barsSince ≤ S1A_MAX_BARS. Không có BOS/CHoCH trong data → FAIL.
 */
function computeS1a(m5: Candle[] | undefined, facts: IctFacts): GateFlags['s1a'] {
  const rs = facts.timeframes['M5']?.recentStructure ?? null;
  const base = { limit: S1A_MAX_BARS, structure: rs ? `${rs.kind} ${rs.direction} @ ${rs.level}` : null };
  if (!m5 || m5.length === 0 || !rs) {
    return { verdict: 'FAIL', barsSince: null, ...base };
  }
  const idx = m5.findIndex((c) => c.time === rs.time);
  if (idx < 0) return { verdict: 'FAIL', barsSince: null, ...base };
  const barsSince = m5.length - 1 - idx;
  return { verdict: barsSince <= S1A_MAX_BARS ? 'PASS' : 'FAIL', barsSince, ...base };
}

/**
 * GATE S1c — Cấu trúc swing đơn điệu (phần số của S1).
 *   Hướng tham chiếu = hướng BOS/CHoCH gần nhất (M5).
 *   Xét swing M5 nằm trong S1C_WINDOW nến cuối:
 *     - Cần ít nhất một phía (highs hoặc lows) có ≥ 2 swing, nếu không → FAIL (không đủ dữ liệu).
 *     - Phía nào có ≥ 2 swing thì chuỗi phải đơn điệu ĐÚNG hướng (bullish: tăng dần;
 *       bearish: giảm dần). Phía có < 2 swing được bỏ qua.
 *     - Bất kỳ phía nào đủ swing mà đan xen/ngược hướng → FAIL.
 */
function computeS1c(m5: Candle[] | undefined, facts: IctFacts): GateFlags['s1c'] {
  const tf = facts.timeframes['M5'];
  const rs = tf?.recentStructure ?? null;
  if (!m5 || m5.length === 0 || !tf || !rs) {
    return { verdict: 'FAIL', detail: 'thiếu nến M5 hoặc không có BOS/CHoCH để lấy hướng' };
  }
  const start = m5.length - S1C_WINDOW;
  const highs = tf.swingHighs.filter((s) => s.index >= start).map((s) => s.price);
  const lows = tf.swingLows.filter((s) => s.index >= start).map((s) => s.price);
  if (highs.length < 2 && lows.length < 2) {
    return {
      verdict: 'FAIL',
      detail: `chỉ ${highs.length} swing high + ${lows.length} swing low trong ${S1C_WINDOW} nến cuối — không đủ để xác định chuỗi`,
    };
  }

  const bullish = rs.direction === 'BULLISH';
  const monotonic = (xs: number[]): boolean =>
    xs.every((v, i) => i === 0 || (bullish ? v > xs[i - 1] : v < xs[i - 1]));

  const highsOk = highs.length < 2 || monotonic(highs);
  const lowsOk = lows.length < 2 || monotonic(lows);
  const word = bullish ? 'cao dần' : 'thấp dần';
  const detail =
    `hướng=${rs.direction}, highs=[${highs.join(', ') || '—'}] ${highsOk ? 'ok' : `KHÔNG ${word}`}, ` +
    `lows=[${lows.join(', ') || '—'}] ${lowsOk ? 'ok' : `KHÔNG ${word}`}`;
  return { verdict: highsOk && lowsOk ? 'PASS' : 'FAIL', detail };
}

/**
 * GATE S2 — Liquidity sweep TRƯỚC CHoCH (chỉ áp dụng cho reversal).
 *
 * Định nghĩa sweep (chặt, thuần số):
 *   Sweep buyside = tồn tại equal-high M5 mức L và một nến M5 tại index i thỏa CẢ BA:
 *     1. i nằm trong [chochIdx − S2_LOOKBACK, chochIdx]  (cửa sổ nhìn lại trước CHoCH)
 *     2. i > L.index                                     (mức đã hình thành trước khi bị quét)
 *     3. high[i] > L.price  VÀ  close[i] < L.price       (wick vượt mức rồi ĐÓNG LẠI dưới mức
 *                                                         → quét thanh khoản + từ chối, không
 *                                                         phải break thật)
 *   Sweep sellside = đối xứng (low[i] < L.price và close[i] > L.price) trên equal-lows.
 *
 * SELL reversal cần sweep buyside; BUY reversal cần sweep sellside.
 * Cấu trúc gần nhất là BOS (continuation) → S2 = N/A cho cả hai hướng.
 */
function computeS2(m5: Candle[] | undefined, facts: IctFacts): GateFlags['s2'] {
  const tf = facts.timeframes['M5'];
  const rs = tf?.recentStructure ?? null;
  if (!m5 || m5.length === 0 || !tf || !rs) {
    return { buy: 'FAIL', sell: 'FAIL', detail: 'thiếu nến M5 hoặc không có BOS/CHoCH' };
  }
  if (rs.kind !== 'CHoCH') {
    return { buy: 'N/A', sell: 'N/A', detail: 'cấu trúc gần nhất = BOS (continuation) → S2 không áp dụng' };
  }
  const chochIdx = m5.findIndex((c) => c.time === rs.time);
  if (chochIdx < 0) {
    return { buy: 'FAIL', sell: 'FAIL', detail: 'không định vị được nến CHoCH trong data M5' };
  }
  const from = Math.max(0, chochIdx - S2_LOOKBACK);

  const scan = (
    levels: { price: number; index: number }[],
    hit: (c: Candle, price: number) => boolean,
  ): string | null => {
    for (const lv of levels) {
      for (let i = Math.max(from, lv.index + 1); i <= chochIdx; i++) {
        if (hit(m5[i], lv.price)) return `mức ${lv.price} bị quét @ ${m5[i].time}`;
      }
    }
    return null;
  };

  const buyside = scan(tf.liquidity.equalHighs, (c, p) => c.high > p && c.close < p);
  const sellside = scan(tf.liquidity.equalLows, (c, p) => c.low < p && c.close > p);

  return {
    buy: sellside ? 'PASS' : 'FAIL',
    sell: buyside ? 'PASS' : 'FAIL',
    detail:
      `CHoCH ${rs.direction} @ ${m5[chochIdx].time}, cửa sổ ${S2_LOOKBACK} nến trước đó | ` +
      `sweep sellside (cho BUY): ${sellside ?? 'không có'} | sweep buyside (cho SELL): ${buyside ?? 'không có'}`,
  };
}

/**
 * GATE C1/C2/C3 — nến xác nhận M1 (thuần số).
 *
 * Nến chấm = nến M1 ÁP CHÓT (m1[len-2]) = nến ĐÃ ĐÓNG mới nhất. Nến cuối (m1[len-1])
 * thường đang chạy dở → OHLC còn đổi → bị LOẠI khỏi mọi gate.
 *   C1: close > open (BUY) / close < open (SELL).
 *   C2: |close − open| ≥ C2_BODY_RATIO × (high − low)  — không phụ thuộc hướng.
 *   C3: close vượt điểm giữa nến M1 liền trước ((high_prev + low_prev)/2) THEO HƯỚNG,
 *       HOẶC engulf thân nến trước (thân nến hiện tại bao trọn thân nến trước, đúng hướng).
 * C4 (nến xác nhận có bám POI không) do LLM chấm vì phụ thuộc POI LLM chọn.
 */
function computeConfirmation(m1: Candle[] | undefined): {
  c1: DirGate;
  c2: GateFlags['c2'];
  c3: DirGate;
  m1Candle: GateFlags['m1Candle'];
  m1Running: GateFlags['m1Running'];
} {
  const pick = (c: Candle): Ohlc =>
    ({ time: c.time, open: c.open, high: c.high, low: c.low, close: c.close });

  // Cần ≥ 3 nến: [len-3] = nến trước (cho C3), [len-2] = nến chấm, [len-1] = nến đang chạy.
  const na = 'thiếu nến M1 (cần ≥ 3 nến để chấm trên nến áp chót)';
  if (!m1 || m1.length < 3) {
    return {
      c1: { buy: 'FAIL', sell: 'FAIL', detail: na },
      c2: { verdict: 'FAIL', detail: na },
      c3: { buy: 'FAIL', sell: 'FAIL', detail: na },
      m1Candle: null,
      m1Running: m1?.length ? pick(m1[m1.length - 1]) : null,
    };
  }
  const cur = m1[m1.length - 2];  // nến áp chót — đã đóng
  const prev = m1[m1.length - 3];

  const body = r2(Math.abs(cur.close - cur.open));
  const range = r2(cur.high - cur.low);
  const ratio = range > 0 ? r2(body / range) : 0;

  const midPrev = r2((prev.high + prev.low) / 2);
  const prevTop = Math.max(prev.open, prev.close);
  const prevBottom = Math.min(prev.open, prev.close);
  const engulfBuy = cur.close > cur.open && cur.close >= prevTop && cur.open <= prevBottom;
  const engulfSell = cur.close < cur.open && cur.open >= prevTop && cur.close <= prevBottom;

  return {
    c1: {
      buy: cur.close > cur.open ? 'PASS' : 'FAIL',
      sell: cur.close < cur.open ? 'PASS' : 'FAIL',
      detail: `nến M1 áp chót: o=${cur.open} c=${cur.close} → ${cur.close > cur.open ? 'xanh' : cur.close < cur.open ? 'đỏ' : 'doji'}`,
    },
    c2: {
      verdict: range > 0 && body >= C2_BODY_RATIO * range ? 'PASS' : 'FAIL',
      detail: `body=${body}, range=${range}, ratio=${ratio} (cần ≥ ${C2_BODY_RATIO})`,
    },
    c3: {
      buy: cur.close > midPrev || engulfBuy ? 'PASS' : 'FAIL',
      sell: cur.close < midPrev || engulfSell ? 'PASS' : 'FAIL',
      detail: `close=${cur.close}, mid nến M1 trước=${midPrev}, engulf buy=${engulfBuy}, engulf sell=${engulfSell}`,
    },
    m1Candle: pick(cur),
    m1Running: pick(m1[m1.length - 1]),
  };
}

/**
 * GATE S5 — Bộ lọc biến động (HARD).
 *   Chuẩn (có atr_m5_avg20)   : PASS nếu atr_m5_current ≥ 0.8 × atr_m5_avg20.
 *   Fallback (thiếu avg20)     : PASS nếu atr_m5_current ≥ 1.5 USD (kém tin cậy).
 *   FAIL → WATCHLIST (không NO TRADE).
 */
function computeS5(atrM5: number | null, atrM5Avg20: number | null): GateFlags['s5'] {
  if (atrM5 == null) {
    return { verdict: 'FAIL', mode: 'fallback', atrCur: null, threshold: S5_FALLBACK_THRESHOLD };
  }
  if (atrM5Avg20 != null) {
    const threshold = r2(S5_STD_FACTOR * atrM5Avg20);
    return { verdict: atrM5 >= threshold ? 'PASS' : 'FAIL', mode: 'standard', atrCur: atrM5, threshold };
  }
  return {
    verdict: atrM5 >= S5_FALLBACK_THRESHOLD ? 'PASS' : 'FAIL',
    mode: 'fallback',
    atrCur: atrM5,
    threshold: S5_FALLBACK_THRESHOLD,
  };
}

/**
 * Chấm toàn bộ gate số học và trả về cấu trúc GateFlags.
 * S4 = PENDING (kiến trúc A: hậu kiểm sau khi LLM trả SL/TP — xem evaluateS4).
 */
export function computeGateFlags(candlesByTimeframe: Record<string, Candle[]>, facts: IctFacts): GateFlags {
  const m5 = candlesByTimeframe['M5'];
  const m1 = candlesByTimeframe['M1'];
  const atrM5 = facts.timeframes['M5']?.atr ?? null;
  const atrM1 = facts.timeframes['M1']?.atr ?? null;
  const atrM5Avg20 = meanTrueRange(m5, 20);

  const s0 = computeS0(m5, atrM5, atrM1, facts);
  const s1a = computeS1a(m5, facts);
  const s1b = computeS1b(m5, atrM5);
  const s1c = computeS1c(m5, facts);
  const s1: Pf =
    s1a.verdict === 'PASS' && s1b.verdict === 'PASS' && s1c.verdict === 'PASS' ? 'PASS' : 'FAIL';
  const s2 = computeS2(m5, facts);
  const s5 = computeS5(atrM5, atrM5Avg20);
  const { c1, c2, c3, m1Candle, m1Running } = computeConfirmation(m1);
  const modeS5: 'standard' | 'fallback' = atrM5Avg20 != null ? 'standard' : 'fallback';
  const killZone = facts.meta.killZone.inKillZone;

  // Hard gate chặn ORDER: S0 FAIL, S1 tổng FAIL, S5 FAIL (S4 hậu kiểm riêng).
  const hardBlocked = s0.verdict === 'FAIL' || s1 === 'FAIL' || s5.verdict === 'FAIL';

  return {
    s0, s1a, s1b, s1c, s1, s2, s4: { verdict: 'PENDING' }, s5,
    c1, c2, c3, m1Candle, m1Running, modeS5, killZone, hardBlocked,
  };
}

/**
 * Hậu kiểm S4 (kiến trúc A) — gọi SAU khi LLM đã đề xuất entry/SL/TP.
 *   rr_real = (dist_tp - SPREAD_BUFFER) / (dist_sl + SPREAD_BUFFER)
 *   PASS nếu rr_real ≥ 1.3.
 * Trả về null nếu chưa đủ ứng viên (PENDING).
 */
export function evaluateS4(
  entry: number | null,
  sl: number | null,
  tp: number | null,
): { verdict: 'PASS' | 'FAIL'; rrReal: number } | null {
  if (entry == null || sl == null || tp == null) return null;
  const distTp = Math.abs(tp - entry);
  const distSl = Math.abs(entry - sl);
  if (distSl + SPREAD_BUFFER <= 0) return null;
  const rrReal = r2((distTp - SPREAD_BUFFER) / (distSl + SPREAD_BUFFER));
  return { verdict: rrReal >= S4_MIN_RR ? 'PASS' : 'FAIL', rrReal };
}

/** Dựng khối [GATE_FLAGS] text để chèn vào đầu user prompt gửi cho LLM. */
export function renderGateFlags(flags: GateFlags): string {
  const s0 = flags.s0.verdict === 'PASS' ? 'PASS' : `FAIL:${flags.s0.reason ?? 'không rõ'}`;
  const s1a =
    `${flags.s1a.verdict}   (bars_since=${flags.s1a.barsSince ?? 'n/a'}, limit=${flags.s1a.limit}, ` +
    `structure=${flags.s1a.structure ?? 'không có'})`;
  const s1b =
    `${flags.s1b.verdict}   (range20=${flags.s1b.range20 ?? 'n/a'}, ` +
    `threshold=${S1B_RANGE_FACTOR}*atr_m5_current=${flags.s1b.threshold ?? 'n/a'})`;
  const s1c = `${flags.s1c.verdict}   (${flags.s1c.detail})`;
  const s1 = `${flags.s1}   (= s1a AND s1b AND s1c)`;
  const s2 = `buy=${flags.s2.buy} sell=${flags.s2.sell}   (${flags.s2.detail})`;
  const s4 = `${flags.s4.verdict}   (rr_real=chưa có, need>=${S4_MIN_RR})`;
  const s5 =
    `${flags.s5.verdict}   (mode=${flags.s5.mode}, ` +
    `atr_cur=${flags.s5.atrCur ?? 'n/a'}, threshold=${flags.s5.threshold ?? 'n/a'})`;
  const fmtOhlc = (c: GateFlags['m1Candle']): string =>
    c ? `${c.time}  o=${c.open} h=${c.high} l=${c.low} c=${c.close}` : 'không có';

  return [
    '=== [GATE_FLAGS] (code chấm sẵn — DÙNG TRỰC TIẾP, KHÔNG tính lại) ===',
    '[GATE_FLAGS]',
    `gate_s0:  ${s0}`,
    `gate_s1a: ${s1a}`,
    `gate_s1b: ${s1b}`,
    `gate_s1c: ${s1c}`,
    `gate_s1:  ${s1}`,
    `gate_s2:  ${s2}`,
    `gate_s4:  ${s4}`,
    `gate_s5:  ${s5}`,
    `mode_s5:  ${flags.modeS5}`,
    `kill_zone: ${flags.killZone}`,
    '',
    `m1_confirm_candle: ${fmtOhlc(flags.m1Candle)}   # nến M1 ÁP CHÓT (đã đóng) — nến chấm C1–C3`,
    `m1_running_candle: ${fmtOhlc(flags.m1Running)}   # nến M1 cuối, CHƯA đóng — ĐÃ LOẠI khỏi mọi gate`,
    `gate_c1:  buy=${flags.c1.buy} sell=${flags.c1.sell}   (${flags.c1.detail})`,
    `gate_c2:  ${flags.c2.verdict}   (${flags.c2.detail})`,
    `gate_c3:  buy=${flags.c3.buy} sell=${flags.c3.sell}   (${flags.c3.detail})`,
  ].join('\n');
}
