/**
 * ScalpRuleEngine.ts
 * -----------------------------------------------------------------------------
 * Gate SỐ HỌC chạy ở CODE (trước khi gọi LLM). Mọi gate thuần số được chấm tại đây,
 * KHÔNG giao cho LLM (LLM hay sai phép chia và so sánh). Code chấm xong, sinh khối
 * `[GATE_FLAGS]` để chèn vào input LLM.
 *
 * Ranh giới phân công (xem spec rule_engine):
 *  - Code chấm : S0, S1b, S4, S5 (thuần số).
 *  - LLM chấm  : S1a, S1c, S2, C1–C4 (đọc cấu trúc/nến — định tính).
 *  - S1 tổng   = S1a AND S1b AND S1c; code chỉ chấm S1b, LLM tổng hợp phán quyết cuối.
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

/** RR thực tối thiểu để S4 PASS. */
const S4_MIN_RR = 1.3;

type Verdict = 'PASS' | 'FAIL' | 'PENDING' | 'FALLBACK';

export interface GateFlags {
  s0: { verdict: 'PASS' | 'FAIL'; reason?: string };
  s1b: { verdict: 'PASS' | 'FAIL'; range20: number | null; threshold: number | null };
  s4: { verdict: Verdict }; // PENDING trước LLM (kiến trúc A)
  s5: {
    verdict: 'PASS' | 'FAIL';
    mode: 'standard' | 'fallback';
    atrCur: number | null;
    threshold: number | null;
  };
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
  const atrM5 = facts.timeframes['M5']?.atr ?? null;
  const atrM1 = facts.timeframes['M1']?.atr ?? null;
  const atrM5Avg20 = meanTrueRange(m5, 20);

  const s0 = computeS0(m5, atrM5, atrM1, facts);
  const s1b = computeS1b(m5, atrM5);
  const s5 = computeS5(atrM5, atrM5Avg20);
  const modeS5: 'standard' | 'fallback' = atrM5Avg20 != null ? 'standard' : 'fallback';
  const killZone = facts.meta.killZone.inKillZone;

  // Hard gate chặn ORDER: S0 FAIL, S1b FAIL, S5 FAIL (S4 hậu kiểm riêng).
  const hardBlocked = s0.verdict === 'FAIL' || s1b.verdict === 'FAIL' || s5.verdict === 'FAIL';

  return { s0, s1b, s4: { verdict: 'PENDING' }, s5, modeS5, killZone, hardBlocked };
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
  const s1b =
    `${flags.s1b.verdict}   (range20=${flags.s1b.range20 ?? 'n/a'}, ` +
    `threshold=4*atr_m5_current=${flags.s1b.threshold ?? 'n/a'})`;
  const s4 = `${flags.s4.verdict}   (rr_real=chưa có, need>=${S4_MIN_RR})`;
  const s5 =
    `${flags.s5.verdict}   (mode=${flags.s5.mode}, ` +
    `atr_cur=${flags.s5.atrCur ?? 'n/a'}, threshold=${flags.s5.threshold ?? 'n/a'})`;

  return [
    '=== [GATE_FLAGS] (code chấm sẵn — DÙNG TRỰC TIẾP, KHÔNG tính lại) ===',
    '[GATE_FLAGS]',
    `gate_s0:  ${s0}`,
    `gate_s1b: ${s1b}`,
    `gate_s4:  ${s4}`,
    `gate_s5:  ${s5}`,
    `mode_s5:  ${flags.modeS5}`,
    `kill_zone: ${flags.killZone}`,
  ].join('\n');
}
