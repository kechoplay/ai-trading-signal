/**
 * Chấm kết quả một tín hiệu BUY/SELL bằng nến thật — HÀM THUẦN, không đụng DB/mạng.
 *
 * Quy ước (cố ý bi quan, cùng tinh thần SwingSignalService.simulate — không có dữ liệu tick):
 * - Khớp lệnh khi range nến [low, high] chứa entry (gồm cả gap). Khớp đúng giá entry, không trượt giá.
 * - Nến VỪA khớp: chỉ xét SL (nếu nến chạm SL → SL), KHÔNG xét TP — không biết thứ tự trong nến.
 *   Cũng không tính MFE trên nến đó (phần râu có thể xảy ra TRƯỚC lúc khớp).
 * - Nến chạm cả SL lẫn TP1 → tính SL.
 * - Tín hiệu ra giữa một cây nến: cây nến đó bị bỏ (đã chạy một phần trước khi người dùng nhận
 *   tín hiệu); chấm từ cây nến mở SAU thời điểm ra tín hiệu. Riêng lệnh thị trường (entry sát
 *   giá lúc phân tích, xem marketFillTolR) coi như khớp ngay lúc ra tín hiệu.
 * - Chốt EXPIRED: giá nến cuối cùng đã có, quy ra R (có thể dương hoặc âm).
 * - Giá chạm TP1 khi lệnh chờ CHƯA khớp → setup đã chạy xong, coi như trader hủy lệnh: NO_FILL ngay
 *   (`cancelOnTpBeforeFill`, thêm 27/10/2026). Trước đó lệnh vẫn chờ tiếp, khớp lúc giá hồi về rồi
 *   thường dính SL — đo trên dữ liệu thật 23–27/10: 2/4 lệnh thua (sau khi gộp trùng) thuộc loại này.
 */

export type OutcomeStatus = 'PENDING' | 'OPEN' | 'TP1' | 'SL' | 'EXPIRED' | 'NO_FILL' | 'NO_DATA';

/** Trạng thái chốt — không chấm lại. */
export const FINAL_STATUSES: readonly OutcomeStatus[] = ['TP1', 'SL', 'EXPIRED', 'NO_FILL', 'NO_DATA'];

export interface EvalCandle {
  /** Giờ MỞ nến (epoch ms). */
  openMs: number;
  high: number;
  low: number;
  close: number;
}

export interface EvalInput {
  direction: 'BUY' | 'SELL';
  entry: number;
  stopLoss: number;
  takeProfit: number;
  /** Giá tại lúc phân tích — chỉ dùng để nhận diện lệnh thị trường. */
  currentPrice: number | null;
  signalMs: number;
  /** Độ dài một nến (ms). */
  tfMs: number;
  fillWindowMs: number;
  holdMaxMs: number;
  marketFillTolR: number;
  /** true = giá chạm TP1 trước khi khớp entry thì hủy lệnh chờ (NO_FILL ngay). */
  cancelOnTpBeforeFill: boolean;
  nowMs: number;
}

export interface EvalResult {
  status: OutcomeStatus;
  filledMs: number | null;
  exitMs: number | null;
  exitPrice: number | null;
  resultR: number | null;
  mfeR: number | null;
  maeR: number | null;
  missedTp: boolean;
}

/** null nếu mức giá không hợp lệ cho hướng (SL/TP sai phía entry, khoảng SL = 0). */
export function validateLevels(direction: 'BUY' | 'SELL', entry: number, sl: number, tp: number): boolean {
  if (![entry, sl, tp].every(Number.isFinite)) return false;
  return direction === 'BUY' ? sl < entry && entry < tp : tp < entry && entry < sl;
}

export function plannedRr(entry: number, sl: number, tp: number): number {
  return Math.abs(tp - entry) / Math.abs(entry - sl);
}

export function evaluateOutcome(inp: EvalInput, candles: EvalCandle[]): EvalResult {
  const sign = inp.direction === 'BUY' ? 1 : -1;
  const risk = Math.abs(inp.entry - inp.stopLoss);
  const toR = (price: number): number => (sign * (price - inp.entry)) / risk;
  const slHit = (c: EvalCandle): boolean => (sign > 0 ? c.low <= inp.stopLoss : c.high >= inp.stopLoss);
  const tpHit = (c: EvalCandle): boolean => (sign > 0 ? c.high >= inp.takeProfit : c.low <= inp.takeProfit);
  const touchesEntry = (c: EvalCandle): boolean => c.low <= inp.entry && inp.entry <= c.high;
  const fillDeadline = inp.signalMs + inp.fillWindowMs;

  // Cây nến đầu tiên mở sau thời điểm ra tín hiệu.
  const firstOpen = Math.ceil(inp.signalMs / inp.tfMs) * inp.tfMs;
  const usable = candles.filter((c) => c.openMs >= firstOpen).sort((a, b) => a.openMs - b.openMs);

  // Không có nến nào phủ tới lúc ra tín hiệu (nến đầu tiên lấy về mở quá muộn) → không chấm được.
  const earliest = candles.reduce((m, c) => Math.min(m, c.openMs), Infinity);
  if (candles.length === 0 || earliest > firstOpen + inp.tfMs) {
    return blank('NO_DATA');
  }

  let filledMs: number | null = null;
  let mfe = 0;
  let mae = 0;
  let missedTp = false;
  let lastClose: { price: number; ms: number } | null = null;

  const marketLike =
    inp.currentPrice != null && Math.abs(inp.entry - inp.currentPrice) <= inp.marketFillTolR * risk;
  if (marketLike) filledMs = inp.signalMs;

  for (const c of usable) {
    lastClose = { price: c.close, ms: c.openMs + inp.tfMs };

    if (filledMs == null) {
      if (c.openMs >= fillDeadline) break;
      if (!touchesEntry(c)) {
        // Giá chạy thẳng tới TP1 mà chưa hề chạm entry → lệnh chờ bị bỏ lỡ.
        if (tpHit(c)) {
          missedTp = true;
          if (inp.cancelOnTpBeforeFill) return { ...blank('NO_FILL'), missedTp };
        }
        continue;
      }
      filledMs = c.openMs;
      if (sign > 0 ? c.low < inp.entry : c.high > inp.entry) mae = Math.max(mae, -toR(sign > 0 ? c.low : c.high));
      if (slHit(c)) return done('SL', c.openMs + inp.tfMs, inp.stopLoss, -1);
      continue; // nến vừa khớp: không xét TP, không tính MFE
    }

    if (c.openMs >= filledMs + inp.holdMaxMs) break;

    const best = sign > 0 ? c.high : c.low;
    const worst = sign > 0 ? c.low : c.high;
    if (slHit(c)) {
      mae = Math.max(mae, 1);
      return done('SL', c.openMs + inp.tfMs, inp.stopLoss, -1);
    }
    mfe = Math.max(mfe, toR(best));
    mae = Math.max(mae, -toR(worst));
    if (tpHit(c)) return done('TP1', c.openMs + inp.tfMs, inp.takeProfit, toR(inp.takeProfit));
  }

  if (filledMs != null) {
    // Lệnh thị trường chưa có nến sau nó, hoặc đang chạy.
    if (inp.nowMs >= filledMs + inp.holdMaxMs) {
      const px = lastClose?.price ?? inp.entry;
      return done('EXPIRED', lastClose?.ms ?? inp.nowMs, px, toR(px));
    }
    return { ...blank('OPEN'), filledMs, mfeR: mfe, maeR: mae, missedTp };
  }

  if (inp.nowMs >= fillDeadline) return { ...blank('NO_FILL'), missedTp };
  return { ...blank('PENDING'), missedTp };

  function blank(status: OutcomeStatus): EvalResult {
    return { status, filledMs: null, exitMs: null, exitPrice: null, resultR: null, mfeR: null, maeR: null, missedTp: false };
  }

  function done(status: OutcomeStatus, exitMs: number, exitPrice: number, r: number): EvalResult {
    return { status, filledMs, exitMs, exitPrice, resultR: r, mfeR: mfe, maeR: mae, missedTp };
  }
}
