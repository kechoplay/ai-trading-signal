import { Candle } from '../market/Candle';

/**
 * SWING SCALP — dò điểm BUY/SELL theo TỪNG NHỊP NHỎ (zigzag pivot), KHÔNG dùng AI.
 *
 * Vì sao tách hẳn khỏi pipeline Claude:
 *  - Cơ học 100% → chạy trong vài ms, KHÔNG tiêu quota subscription (pipeline AI tốn
 *    ~50k token + ~3 phút mỗi lượt, xem CLAUDE.md mục "Quota subscription").
 *  - Không đọc ngữ cảnh (POI, thanh khoản, HARD GATE) như prompt ICT → đây là lớp tín
 *    hiệu THAM KHẢO song song, không thay thế phân tích AI và KHÔNG ghi vào
 *    `trading_signals` (tránh làm nhiễu dashboard + carry-forward của luồng intraday).
 *
 * Cách hoạt động (giống họ indicator zigzag/fractal trên TradingView):
 *  1. Tìm pivot fractal: nến có high cao hơn `lookback` nến hai bên → pivot HIGH (và
 *     ngược lại cho LOW). Pivot chỉ được XÁC NHẬN sau `lookback` nến → đó là thời điểm
 *     sớm nhất có thể vào lệnh thật, nên entry lấy tại nến xác nhận, không phải tại pivot.
 *  2. Lọc nhiễu bằng zigzag: pivot đối nghịch chỉ được nhận khi nhịp vừa chạy ≥
 *     `minLegAtr × ATR`; pivot cùng loại liên tiếp thì giữ cái cực đoan hơn.
 *  3. Mỗi pivot LOW → tín hiệu BUY, pivot HIGH → tín hiệu SELL. SL đặt sau đỉnh/đáy
 *     pivot một khoảng đệm ATR; TP1/2/3 = bội số R (mặc định 1R/2R/3R).
 *  4. Chạy tới (forward test) từng tín hiệu cũ trên chính dữ liệu nến để biết nó chạm
 *     TP hay SL → có winrate/tổng R thật thay vì chỉ liệt kê mũi tên.
 *
 * CẢNH BÁO REPAINT: tín hiệu MỚI NHẤT có thể bị rút lại — nếu giá tạo pivot cùng loại
 * cực đoan hơn thì zigzag dời pivot, nhãn cũ biến mất. Tín hiệu đó được đánh dấu
 * `provisional = true`. Mọi tín hiệu phía trước đã cố định.
 */

export type SwingDirection = 'BUY' | 'SELL';
export type SwingStatus = 'RUNNING' | 'SL' | 'TP1' | 'TP2' | 'TP3';

export interface SwingSignal {
  direction: SwingDirection;
  /** Thời điểm/giá của đỉnh-đáy tạo ra tín hiệu (nơi indicator vẽ nhãn UP/DOWN). */
  pivotTime: string;
  pivotPrice: number;
  /** Nến xác nhận pivot (pivot + lookback) — thời điểm sớm nhất vào được lệnh. */
  signalTime: string;
  entry: number;
  stopLoss: number;
  /** Khoảng rủi ro 1R (|entry − SL|), đơn vị giá. */
  risk: number;
  takeProfits: number[];
  /** Độ lớn nhịp vừa kết thúc tại pivot, quy ra bội số ATR — nhịp càng lớn tín hiệu càng đáng tin. */
  legAtr: number;
  status: SwingStatus;
  /** Kết quả quy ra R: SL = −1, TPn = bội số R của TP đó, RUNNING = lãi/lỗ tạm tính. */
  resultR: number;
  /** Số nến từ lúc vào tới lúc chốt (null nếu còn chạy). */
  barsToResolve: number | null;
  /** Tín hiệu đã ra cách đây bao nhiêu nến — 0 = vừa xuất hiện ở nến cuối. */
  barsAgo: number;
  /** True với tín hiệu cuối khi nhịp đảo chiều chưa đủ lớn → còn khả năng bị dời. */
  provisional: boolean;
}

export interface SwingStats {
  total: number;
  resolved: number;
  hitTp1: number;
  hitSl: number;
  winRatePct: number | null;
  /** Tổng R của các tín hiệu đã đóng (giả định thoát toàn bộ tại TP xa nhất chạm được). */
  totalR: number;
  avgR: number | null;
}

export interface SwingReport {
  timeframe: string;
  bars: number;
  atr: number;
  currentPrice: number;
  lastCandleTime: string;
  signals: SwingSignal[];
  latest: SwingSignal | null;
  stats: SwingStats;
  params: SwingParams;
}

export interface SwingParams {
  pivotLookback: number;
  minLegAtr: number;
  slBufferAtr: number;
  tpR: number[];
  atrPeriod: number;
}

export const DEFAULT_SWING_PARAMS: SwingParams = {
  pivotLookback: 2,
  minLegAtr: 1.0,
  slBufferAtr: 0.25,
  tpR: [1, 2, 3],
  atrPeriod: 14,
};

interface Pivot {
  index: number;
  price: number;
  type: 'HIGH' | 'LOW';
}

// ─── Tiện ích ────────────────────────────────────────────────────────────────

/** Số chữ số thập phân theo độ lớn giá: vàng/BTC 2 số, altcoin nhỏ cần nhiều số hơn. */
const digitsFor = (price: number): number => {
  const abs = Math.abs(price);
  return abs >= 100 ? 2 : abs >= 1 ? 4 : 6;
};

function round(price: number): number {
  const f = 10 ** digitsFor(price);
  return Math.round(price * f) / f;
}

/**
 * Làm tròn một KHOẢNG giá (risk, ATR) theo độ chính xác của mức giá tham chiếu.
 * Tự đo theo chính nó thì sai đơn vị: risk 2.3737 USD của vàng nhỏ hơn 100 nên bị
 * hiển thị 4 số lẻ như altcoin, trong khi entry cạnh nó chỉ có 2.
 */
function roundLike(value: number, ref: number): number {
  const f = 10 ** digitsFor(ref);
  return Math.round(value * f) / f;
}

/**
 * ATR Wilder theo từng nến (không phải một giá trị cuối) — tín hiệu cũ phải được đo
 * bằng biến động TẠI THỜI ĐIỂM ĐÓ, nếu dùng ATR hiện tại thì SL/lọc nhiễu của phiên
 * biến động mạnh sẽ bị áp sai lên phiên đi ngang.
 */
function atrSeries(candles: Candle[], period: number): number[] {
  const out: number[] = [];
  let prev = 0;
  let sum = 0;
  for (let i = 0; i < candles.length; i++) {
    const c = candles[i];
    const prevClose = i > 0 ? candles[i - 1].close : c.open;
    const tr = Math.max(
      c.high - c.low,
      Math.abs(c.high - prevClose),
      Math.abs(c.low - prevClose),
    );
    if (i < period) {
      sum += tr;
      prev = sum / (i + 1);
    } else {
      prev = (prev * (period - 1) + tr) / period;
    }
    out.push(prev);
  }
  return out;
}

/** Pivot fractal: high/low cực trị so với `lookback` nến MỖI BÊN (so sánh chặt). */
function rawPivots(candles: Candle[], lookback: number): Pivot[] {
  const pivots: Pivot[] = [];
  for (let i = lookback; i < candles.length - lookback; i++) {
    let isHigh = true;
    let isLow = true;
    for (let j = 1; j <= lookback; j++) {
      if (candles[i].high <= candles[i - j].high || candles[i].high <= candles[i + j].high) isHigh = false;
      if (candles[i].low >= candles[i - j].low || candles[i].low >= candles[i + j].low) isLow = false;
    }
    // Nến outside vừa là fractal high vừa là fractal low → không xác định được chiều đảo, bỏ.
    if (isHigh && !isLow) pivots.push({ index: i, price: candles[i].high, type: 'HIGH' });
    else if (isLow && !isHigh) pivots.push({ index: i, price: candles[i].low, type: 'LOW' });
  }
  return pivots;
}

/**
 * Zigzag: ép chuỗi pivot xen kẽ HIGH → LOW → HIGH và loại nhịp quá nhỏ.
 * Không lọc thì mỗi 3 nến lại có một fractal → hàng chục "tín hiệu" mỗi phiên, phần lớn
 * là nhiễu trong cùng một nhịp.
 */
function zigzag(pivots: Pivot[], atr: number[], minLegAtr: number): Pivot[] {
  const zz: Pivot[] = [];
  for (const p of pivots) {
    const last = zz[zz.length - 1];
    if (!last) {
      zz.push(p);
      continue;
    }
    if (last.type === p.type) {
      // Cùng chiều → nhịp chưa đảo, chỉ đẩy cực trị đi xa hơn.
      const moreExtreme = p.type === 'HIGH' ? p.price > last.price : p.price < last.price;
      if (moreExtreme) zz[zz.length - 1] = p;
      continue;
    }
    const legSize = Math.abs(p.price - last.price);
    if (legSize < minLegAtr * (atr[p.index] || 0)) continue; // nhịp quá nhỏ → nhiễu
    zz.push(p);
  }
  return zz;
}

/**
 * Chạy tới từ nến sau nến vào lệnh để xem chạm SL hay TP nào trước.
 * Nến chạm CẢ SL lẫn TP trong cùng một cây → tính SL (không có dữ liệu tick để biết
 * cái nào tới trước, nên chọn phía bi quan, tránh thổi phồng winrate).
 */
function simulate(
  candles: Candle[],
  from: number,
  dir: SwingDirection,
  entry: number,
  stopLoss: number,
  tps: number[],
  risk: number,
): { status: SwingStatus; resultR: number; barsToResolve: number | null } {
  let best = 0; // số TP đã chạm
  for (let i = from; i < candles.length; i++) {
    const c = candles[i];
    const hitSl = dir === 'BUY' ? c.low <= stopLoss : c.high >= stopLoss;
    if (hitSl) {
      // Đã chạm TP1 trước đó ở nến khác → coi như đã dời SL về breakeven, kết quả tính theo TP đã chạm.
      if (best > 0) {
        return { status: `TP${best}` as SwingStatus, resultR: bestR(best, tps, entry, risk, dir), barsToResolve: i - from + 1 };
      }
      return { status: 'SL', resultR: -1, barsToResolve: i - from + 1 };
    }
    while (best < tps.length) {
      const tp = tps[best];
      const hit = dir === 'BUY' ? c.high >= tp : c.low <= tp;
      if (!hit) break;
      best++;
    }
    if (best === tps.length) {
      return { status: `TP${best}` as SwingStatus, resultR: bestR(best, tps, entry, risk, dir), barsToResolve: i - from + 1 };
    }
  }

  const last = candles[candles.length - 1];
  if (best > 0) {
    // Đã ăn được TP nhưng chưa chạm SL/TP cuối → vẫn coi là đang chạy, R tính theo TP đã chạm.
    return { status: 'RUNNING', resultR: bestR(best, tps, entry, risk, dir), barsToResolve: null };
  }
  const openR = last ? ((dir === 'BUY' ? last.close - entry : entry - last.close) / risk) : 0;
  return { status: 'RUNNING', resultR: Math.round(openR * 100) / 100, barsToResolve: null };
}

function bestR(count: number, tps: number[], entry: number, risk: number, dir: SwingDirection): number {
  const tp = tps[count - 1];
  const r = (dir === 'BUY' ? tp - entry : entry - tp) / risk;
  return Math.round(r * 100) / 100;
}

// ─── Engine ──────────────────────────────────────────────────────────────────

export function analyzeSwings(
  candles: Candle[],
  timeframe: string,
  currentPrice: number,
  params: SwingParams = DEFAULT_SWING_PARAMS,
): SwingReport {
  const { pivotLookback, minLegAtr, slBufferAtr, tpR, atrPeriod } = params;
  const atr = atrSeries(candles, atrPeriod);
  const zz = zigzag(rawPivots(candles, pivotLookback), atr, minLegAtr);
  const lastCandle = candles[candles.length - 1];
  const lastAtr = atr[atr.length - 1] ?? 0;

  const signals: SwingSignal[] = [];
  for (let k = 1; k < zz.length; k++) {
    const p = zz[k];
    const prev = zz[k - 1];
    const confirmIndex = p.index + pivotLookback;
    // Pivot sát mép dữ liệu chưa đủ nến xác nhận → chưa phải tín hiệu.
    if (confirmIndex >= candles.length) continue;

    const dir: SwingDirection = p.type === 'LOW' ? 'BUY' : 'SELL';
    const entry = candles[confirmIndex].close;
    const atrAt = atr[p.index] || lastAtr;
    const stopLoss = dir === 'BUY'
      ? p.price - slBufferAtr * atrAt
      : p.price + slBufferAtr * atrAt;
    const risk = Math.abs(entry - stopLoss);
    // Entry đã chạy quá xa pivot (vào lệnh muộn) → risk phình to, R:R vô nghĩa. Bỏ.
    if (risk <= 0 || risk > 2 * atrAt) continue;

    const tps = tpR.map((r) => (dir === 'BUY' ? entry + r * risk : entry - r * risk));
    const sim = simulate(candles, confirmIndex + 1, dir, entry, stopLoss, tps, risk);

    // Nhịp đảo chiều tính từ pivot tới cực trị hiện có — chưa đủ minLegAtr nghĩa là
    // zigzag chưa chốt pivot này, giá còn có thể phá qua và dời nhãn.
    const tail = candles.slice(p.index);
    const extreme = dir === 'BUY'
      ? Math.max(...tail.map((c) => c.high))
      : Math.min(...tail.map((c) => c.low));
    const provisional = Math.abs(extreme - p.price) < minLegAtr * atrAt;

    signals.push({
      direction: dir,
      pivotTime: candles[p.index].time,
      pivotPrice: round(p.price),
      signalTime: candles[confirmIndex].time,
      entry: round(entry),
      stopLoss: round(stopLoss),
      risk: roundLike(risk, entry),
      takeProfits: tps.map(round),
      legAtr: Math.round((Math.abs(p.price - prev.price) / (atrAt || 1)) * 10) / 10,
      status: sim.status,
      resultR: sim.resultR,
      barsToResolve: sim.barsToResolve,
      barsAgo: candles.length - 1 - confirmIndex,
      provisional: provisional && k === zz.length - 1,
    });
  }

  return {
    timeframe,
    bars: candles.length,
    atr: roundLike(lastAtr, currentPrice),
    currentPrice: round(currentPrice),
    lastCandleTime: lastCandle?.time ?? '',
    signals,
    latest: signals[signals.length - 1] ?? null,
    stats: summarize(signals),
    params,
  };
}

function summarize(signals: SwingSignal[]): SwingStats {
  const closed = signals.filter((s) => s.status !== 'RUNNING');
  const hitTp1 = closed.filter((s) => s.status.startsWith('TP')).length;
  const hitSl = closed.filter((s) => s.status === 'SL').length;
  const totalR = closed.reduce((sum, s) => sum + s.resultR, 0);
  return {
    total: signals.length,
    resolved: closed.length,
    hitTp1,
    hitSl,
    winRatePct: closed.length ? Math.round((hitTp1 / closed.length) * 100) : null,
    totalR: Math.round(totalR * 100) / 100,
    avgR: closed.length ? Math.round((totalR / closed.length) * 100) / 100 : null,
  };
}
