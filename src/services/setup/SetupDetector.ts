import { Bias, RetestZone, StructureEvent, SweepEvent, TimeframeAnalysis } from '../ai/ict/IctPreprocessor';

/**
 * Dò chuỗi setup ICT/SMC theo đúng thứ tự "chờ — xác nhận — retest":
 *
 *   1. SWEPT     — có cú quét thanh khoản (wick vượt đỉnh/đáy rồi body close quay lại)
 *   2. CONFIRMED — sau cú quét có BOS/CHoCH CÓ displacement theo hướng ngược cú quét
 *   3. RETEST    — giá hồi về FVG/OB do chính displacement đó tạo ra
 *
 * Hàm thuần (không I/O): nhận facts của một khung (nến ĐÃ ĐÓNG) + giá sống, trả trạng
 * thái chuỗi cho MỘT hướng. Không dùng AI — SetupWatcher gọi mỗi vài phút và chỉ khi
 * tới RETEST mới kích hoạt phân tích Claude.
 */

export type SetupStage = 'NONE' | 'SWEPT' | 'CONFIRMED' | 'RETEST';

export interface DetectedSetup {
  direction: 'BUY' | 'SELL';
  stage: SetupStage;
  sweep: SweepEvent | null;
  structure: StructureEvent | null;
  zone: RetestZone | null;
  /** Hướng setup có trùng bias khung lớn không (null bias = không biết → false). */
  biasOk: boolean;
  /** Lý do dừng ở stage hiện tại — để soi qua /api/setup-watcher. */
  note: string;
  /** Định danh chuỗi (sweep + cú phá) để không kích hoạt lặp lại cùng một setup. */
  key: string | null;
}

export interface DetectParams {
  maxSweepAgeBars: number;
  maxBarsSweepToBreak: number;
  retestProximityAtr: number;
}

export interface LivePrice {
  /** Giá hiện tại (close của nến cuối, kể cả nến đang chạy). */
  price: number;
  /** High/low của vài nến gần nhất (nến đang chạy + nến vừa đóng) — bắt retest bằng wick giữa hai tick. */
  recentHigh: number;
  recentLow: number;
}

export function detectSetup(
  a: TimeframeAnalysis,
  direction: 'BUY' | 'SELL',
  live: LivePrice,
  higherBias: Bias | null,
  p: DetectParams,
): DetectedSetup {
  const buy = direction === 'BUY';
  const biasOk = higherBias === (buy ? 'BULLISH' : 'BEARISH');
  const base: DetectedSetup = {
    direction, stage: 'NONE', sweep: null, structure: null, zone: null, biasOk, note: '', key: null,
  };

  // 1) Cú quét ngược hướng lệnh: BUY cần quét ĐÁY (sellside), SELL cần quét ĐỈNH (buyside).
  const wantSide = buy ? 'SELLSIDE' : 'BUYSIDE';
  const minIndex = a.closedCount - p.maxSweepAgeBars;
  const sweep = a.sweeps.filter((s) => s.side === wantSide && s.index >= minIndex).pop() ?? null;
  if (!sweep) return { ...base, note: `chưa có cú quét ${buy ? 'đáy' : 'đỉnh'} trong ${p.maxSweepAgeBars} nến gần nhất` };

  // Giá đã vượt râu cú quét → setup đảo chiều vô hiệu (đó thành phá thật).
  if (buy ? live.price < sweep.extreme : live.price > sweep.extreme) {
    return { ...base, sweep, note: `giá ${live.price} đã vượt râu cú quét ${sweep.extreme} — setup vô hiệu` };
  }

  // 2) BOS/CHoCH theo hướng lệnh, xảy ra từ nến xác nhận sweep trở đi, trong cửa sổ cho phép.
  const wantDir = buy ? 'BULLISH' : 'BEARISH';
  const breaks = a.structureEvents.filter((e) =>
    e.direction === wantDir && e.index >= sweep.index && e.index - sweep.index <= p.maxBarsSweepToBreak);
  const structure = breaks.filter((e) => e.displacement).pop() ?? null;
  if (!structure) {
    const weak = breaks.length > 0;
    return {
      ...base, stage: 'SWEPT', sweep,
      note: weak
        ? `có ${breaks[breaks.length - 1].kind} ${wantDir} sau cú quét nhưng KHÔNG displacement — chờ cú phá mạnh`
        : `đã quét, chờ BOS/CHoCH ${wantDir} có displacement`,
    };
  }

  // Cấu trúc đã đảo lại sau cú phá → chuỗi hỏng.
  const flippedBack = a.structureEvents.some((e) => e.index > structure.index && e.direction !== wantDir);
  if (flippedBack) {
    return { ...base, sweep, structure, note: 'cấu trúc đã bị phá ngược lại sau BOS/CHoCH — chuỗi hỏng' };
  }

  const key = `${direction}|${sweep.time}|${structure.time}`;
  const zone = structure.retestZone;
  if (!zone) {
    return { ...base, stage: 'CONFIRMED', sweep, structure, key, note: 'đã có BOS/CHoCH nhưng không có FVG/OB để retest' };
  }
  if (zone.invalidated) {
    return { ...base, sweep, structure, zone, key, note: `vùng retest ${zone.source} ${zone.bottom}–${zone.top} đã bị body close xuyên ${zone.penetrationAtr}× ATR — hỏng` };
  }

  // 3) Retest: giá đang trong/sát vùng, hoặc wick vừa chạm vùng mà giá chưa chạy xa.
  const prox = Math.max(0, p.retestProximityAtr) * a.atr;
  const insideNow = buy
    ? live.price >= zone.bottom && live.price <= zone.top + prox
    : live.price <= zone.top && live.price >= zone.bottom - prox;
  const wickTouched = buy
    ? live.recentLow <= zone.top + prox && live.price >= zone.bottom && live.price <= zone.top + a.atr
    : live.recentHigh >= zone.bottom - prox && live.price <= zone.top && live.price >= zone.bottom - a.atr;

  if (insideNow || wickTouched) {
    return {
      ...base, stage: 'RETEST', sweep, structure, zone, key,
      note: biasOk ? 'đủ chuỗi sweep → BOS/CHoCH → retest' : `đủ chuỗi nhưng NGƯỢC bias khung lớn (${higherBias ?? 'không rõ'})`,
    };
  }
  return {
    ...base, stage: 'CONFIRMED', sweep, structure, zone, key,
    note: `chờ giá hồi về ${zone.source} ${zone.bottom}–${zone.top} (giá ${live.price})`,
  };
}
