/**
 * IctPreprocessor.ts
 * -----------------------------------------------------------------------------
 * Tiền xử lý dữ liệu OHLC XAU/USD cho phân tích ICT/SMC.
 *
 * Mục đích: để CODE tính các con số (swing, fib, ATR, FVG, OB, liquidity,
 * kill zone) thay vì bắt model tự "bấm máy" — vốn là điểm yếu của LLM.
 * Output là một object gọn để ghép vào prompt cùng data thô.
 *
 * Mảng nến phải sắp xếp CŨ -> MỚI (nến mới nhất ở cuối).
 *
 * NẾN ĐANG CHẠY: nếu nến cuối chưa đóng (xem candleTime.isCandleForming), mọi phép tính
 * dựa trên body close / pivot (swing, ATR, ADX, FVG, OB, BOS/CHoCH, sweep) chỉ dùng các
 * nến ĐÃ ĐÓNG. Riêng range/leg/giá hiện tại dùng cả nến đang chạy vì đó là giá sống.
 *
 * Kill zone tính theo thời điểm phân tích (không theo timestamp nến) và theo giờ địa
 * phương London/New York thật — tự xử lý DST, không còn cố định khung giờ mùa hè.
 * -----------------------------------------------------------------------------
 */

import { Candle } from '../../market/Candle';
import { TF_SECONDS, isCandleForming, zonedParts } from '../../market/candleTime';
import { config } from '../../../config/trading';

// ─── Kiểu dữ liệu output ────────────────────────────────────────────────────

/**
 * Trạng thái một mức thanh khoản (swing / equal high-low) sau khi hình thành:
 * - UNSWEPT  : chưa nến nào vượt qua — pool còn nguyên (nam châm DOL).
 * - SWEPT    : wick vượt qua rồi body close QUAY LẠI bên trong (ngay nến đó hoặc trong
 *              `ict.sweepRejectBars` nến sau) — quét thanh khoản thật, dấu hiệu đảo chiều sớm.
 * - BROKEN   : body close bên ngoài và KHÔNG quay lại — phá thật, KHÔNG phải sweep.
 * - BREAKING : đã body close bên ngoài nhưng chưa đủ số nến để kết luận SWEPT hay BROKEN.
 * Trước đây chỉ có cờ `swept` = "có wick vượt qua" → một cú phá thật cũng bị ghi là
 * swept và prompt đọc nhầm thành tín hiệu đảo chiều.
 */
export type LevelStatus = 'UNSWEPT' | 'SWEPT' | 'BROKEN' | 'BREAKING';

export interface Swing {
  index: number;
  time: string;
  price: number;
  /** Chỉ gắn cho các swing được liệt kê trong facts. */
  status?: LevelStatus;
}

export type Bias = 'BULLISH' | 'BEARISH' | 'NEUTRAL';

export interface RangeFib {
  rangeHigh: number;
  rangeLow: number;
  equilibrium: number;
  fib: Record<string, number>;
  currentPrice: number;
  zone: 'PREMIUM' | 'DISCOUNT';
}

/**
 * LEG ĐANG CHẠY (dealing range thật sự) — nhịp giá hiện tại, tính từ pivot đối
 * nghịch gần nhất tới cực trị hiện tại.
 *
 * Lý do tồn tại: `RangeFib` lấy high/low của N nến cố định (H1 = 80 nến ≈ 3 ngày
 * giao dịch vàng). Dùng cái range macro đó làm mẫu số cho một lệnh scalp M5 risk
 * ~6 USD là sai đơn vị đo: nó chỉ nói giá đang ở đâu so với 3 ngày trước, không
 * nói nhịp hiện tại còn chạy được bao xa. Hệ quả thực tế: mọi pullback nông trong
 * một leg tăng đều rơi vào "premium >60%" của range macro và bị HARD GATE 1 chặn,
 * kể cả khi nó nằm ở discount của chính nhịp đang giao dịch.
 */
export interface ActiveLeg {
  direction: 'UP' | 'DOWN';
  /** Điểm khởi đầu leg (swing low nếu UP, swing high nếu DOWN). */
  from: number;
  fromTime: string;
  /** Cực trị hiện tại của leg (đã tính cả phần leg đang mở rộng sau pivot). */
  to: number;
  low: number;
  high: number;
  size: number;
  equilibrium: number;
  /** size theo bội số ATR cùng khung — < 1 nghĩa là leg quá nhỏ, coi như nhiễu. */
  sizeAtr: number;
  /** Vị trí giá hiện tại trong leg: 0% = đáy leg, 100% = đỉnh leg. */
  currentPct: number;
}

/**
 * HỘP RANGE (sideway) — chuỗi swing gần nhất nằm gọn trong một biên hẹp, chạm cả hai biên
 * nhiều lần (ngưỡng ở `ict.rangeBox`).
 *
 * Lý do tồn tại: ADX < 20 chỉ nói "không có xu hướng mạnh", không nói biên range ở đâu.
 * Dealing range là nhịp gần nhất (một đoạn bên trong hộp), range mở rộng là 80 nến — không
 * cái nào cho biết entry đang ở BIÊN hộp (mean-reversion) hay GIỮA hộp (vị trí xấu).
 */
export interface RangeBox {
  top: number;
  bottom: number;
  width: number;
  widthAtr: number;
  equilibrium: number;
  /** Thời điểm swing cũ nhất thuộc hộp. */
  startTime: string;
  /** Số nến đã đóng từ swing cũ nhất của hộp tới nay. */
  bars: number;
  /** Số swing high cách biên trên ≤ `touchTolAtr` × ATR (kể cả swing tạo biên). */
  topTouches: number;
  bottomTouches: number;
  /** Vị trí giá hiện tại trong hộp: 0% = biên dưới, 100% = biên trên (<0 / >100 = đang ngoài hộp). */
  positionPct: number;
  /**
   * INSIDE  : nến đã đóng gần nhất đóng trong hộp.
   * TESTING : 1..`sweepRejectBars` nến đóng liên tiếp ngoài hộp — chưa biết sweep hay phá thật.
   * BROKEN  : nhiều hơn số đó → phá thật, hộp hết hiệu lực.
   */
  state: 'INSIDE' | 'TESTING' | 'BROKEN';
  /** Số nến đã đóng liên tiếp (tính từ nến gần nhất) đóng ngoài hộp, và phía nào. */
  closesOutside: number;
  outsideSide: 'ABOVE' | 'BELOW' | null;
}

export interface Fvg {
  type: 'BULLISH' | 'BEARISH';
  top: number;
  bottom: number;
  midpoint: number;
  index: number;
  time: string;
  /** true = giá đã hồi lại chạm vào gap (POI đã được "ăn"); false = còn nguyên. */
  mitigated: boolean;
}

export interface OrderBlock {
  type: 'BULLISH' | 'BEARISH';
  top: number;
  bottom: number;
  index: number;
  time: string;
  /** true = giá đã hồi lại chạm vào OB; false = còn nguyên (POI tươi). */
  mitigated: boolean;
}

export interface LiquidityLevel {
  price: number;
  times: [string, string];
  /** Index nến của swing SAU trong cặp — thời điểm mức được coi là đã hình thành. */
  index: number;
  status: LevelStatus;
}

export interface Liquidity {
  equalHighs: LiquidityLevel[];
  equalLows: LiquidityLevel[];
}

/** Vùng để chờ giá hồi về sau một cú phá cấu trúc — FVG/OB do chính displacement tạo ra. */
export interface RetestZone {
  /** FVG+OB = FVG gộp với OB liền kề (`ict.retestMergeObGapAtr`) thành một vùng dày hơn. */
  source: 'FVG' | 'OB' | 'FVG+OB';
  type: 'BULLISH' | 'BEARISH';
  top: number;
  bottom: number;
  /** Index nến tạo vùng (FVG: nến giữa; OB: nến OB) — trong mảng nến ĐÃ ĐÓNG. */
  index: number;
  /** Giá đã hồi chạm vùng sau khi hình thành chưa. */
  mitigated: boolean;
  /**
   * Đã có nến body close xuyên qua mép xa của vùng QUÁ `ict.retestInvalidateAtr` × ATR
   * → vùng hỏng, không còn là POI. Xuyên nông hơn ngưỡng chỉ ghi vào `penetrationAtr`.
   */
  invalidated: boolean;
  /** Body close xuyên mép xa sâu nhất, quy ra bội số ATR (0 = chưa nến nào đóng qua mép xa). */
  penetrationAtr: number;
}

/** Sự kiện cấu trúc: body-close phá swing gần nhất theo hướng nào. */
export interface StructureEvent {
  kind: 'BOS' | 'CHoCH';
  direction: 'BULLISH' | 'BEARISH';
  level: number;
  time: string;
  /** Index nến phá — trong mảng nến ĐÃ ĐÓNG. */
  index: number;
  /**
   * Có nến displacement đi kèm không: nến phá (hoặc nến liền trước, cùng chiều) có thân
   * ≥ `ict.displacementBodyAtr` × ATR, HOẶC cú phá để lại FVG cùng chiều. false → theo
   * định nghĩa trong prompt, đây KHÔNG phải CHoCH/BOS hợp lệ (chỉ là body close nhích qua).
   */
  displacement: boolean;
  /** Thân lớn nhất trong (nến phá, nến liền trước) quy ra bội số ATR. */
  bodyAtr: number;
  /** FVG/OB do cú phá này tạo ra — vùng chờ retest (null nếu không có). */
  retestZone: RetestZone | null;
  /**
   * Volume cú phá: volume lớn nhất trong (nến phá, nến liền trước cùng chiều) chia trung bình
   * `ict.volumeSmaBars` nến trước cú đẩy. null = khung không có volume (vàng).
   */
  breakVolRatio: number | null;
  /** Volume trung bình các nến SAU cú phá (tối đa `volumeSmaBars` nến), cùng mẫu số. null = chưa có nến nào / không có volume. */
  pullbackVolRatio: number | null;
}

/** Cú quét thanh khoản (đã được xác nhận bằng body close quay lại bên trong). */
export interface SweepEvent {
  /** BUYSIDE = quét đỉnh (stop của phe bán) ; SELLSIDE = quét đáy (stop của phe mua). */
  side: 'BUYSIDE' | 'SELLSIDE';
  levelType: 'SWING' | 'EQUAL';
  level: number;
  /** Đỉnh/đáy râu của cú quét — mức invalidation tự nhiên của setup đảo chiều. */
  extreme: number;
  /** Index nến xác nhận (nến đóng cửa quay lại bên trong) — trong mảng nến ĐÃ ĐÓNG. */
  index: number;
  time: string;
  /**
   * Số nến ĐÃ ĐÓNG liên tiếp, tính ngược từ nến đóng gần nhất về tới nến xác nhận, đóng
   * cửa đúng phía đảo chiều (BUYSIDE: dưới mức, SELLSIDE: trên mức). 0 = nến gần nhất đã
   * đóng lại bên kia mức (đảo chiều thất bại). Dùng cho luật "≥2 nến xác nhận".
   */
  holdCloses: number;
  /** Volume lớn nhất trong các nến của cú quét (wick vượt → nến đóng quay lại) / trung bình trước đó. null = không có volume. */
  volRatio: number | null;
}

/**
 * ADX (Wilder) — đo ĐỘ MẠNH của xu hướng, không đo hướng (hướng lấy từ +DI/−DI).
 * Dùng làm regime filter cho luật vị trí range: trong trend mạnh, giá nằm lì ở
 * premium/discount sâu là BÌNH THƯỜNG, không phải "mua đỉnh".
 */
export interface AdxReading {
  value: number;
  plusDi: number;
  minusDi: number;
  /** RANGE < 20 ≤ WEAK_TREND < 30 ≤ STRONG_TREND */
  regime: 'RANGE' | 'WEAK_TREND' | 'STRONG_TREND';
  /** Hướng suy từ +DI vs −DI — chỉ có ý nghĩa khi regime ≠ RANGE. */
  direction: 'BULLISH' | 'BEARISH';
}

export interface KillZone {
  vnTime: string;
  inKillZone: boolean;
  zone: 'LONDON' | 'NEW_YORK' | 'NONE';
  /** London đang giờ mùa hè (BST) hay giờ chuẩn (GMT) tại thời điểm tính. */
  londonDst: boolean;
  /** New York đang giờ mùa hè (EDT) hay giờ chuẩn (EST). */
  newYorkDst: boolean;
  /** Khung kill zone quy ra giờ VN tương ứng với DST hiện tại, vd "14:00–17:00". */
  londonVn: string;
  newYorkVn: string;
}

export interface TimeframeAnalysis {
  /** Tổng số nến nhận vào (kể cả nến đang chạy nếu có). */
  candleCount: number;
  /** Số nến ĐÃ ĐÓNG dùng cho mọi phép tính dựa trên body close. */
  closedCount: number;
  /** Nến cuối còn đang chạy (chưa đóng) — null nếu nến cuối đã đóng. */
  formingCandle: Candle | null;
  lastPrice: number;
  bias: Bias;
  atr: number;
  /** ATR(14) so với true range trung bình `bars` nến gần nhất. null = chưa đủ nến. */
  atrBaseline: AtrBaseline | null;
  range: RangeFib;
  /** null = chưa đủ swing đối nghịch để xác định nhịp đang chạy. */
  activeLeg: ActiveLeg | null;
  /** null = không có hộp sideway đủ điều kiện `ict.rangeBox`. */
  rangeBox: RangeBox | null;
  swingHighs: Swing[];
  swingLows: Swing[];
  fvgs: Fvg[];
  orderBlocks: OrderBlock[];
  liquidity: Liquidity;
  /** Sự kiện mới nhất (= phần tử cuối của structureEvents) — giữ cho tương thích. */
  recentStructure: StructureEvent | null;
  /** `ict.structureEvents` sự kiện BOS/CHoCH gần nhất, cũ → mới. */
  structureEvents: StructureEvent[];
  /** Cú quét thanh khoản (đã từ chối) gần nhất trong `ict.sweepRecentBars` nến, cũ → mới. */
  sweeps: SweepEvent[];
  /** null = khung không đủ nến để ADX hội tụ (xem MIN_ADX_CANDLES). */
  adx: AdxReading | null;
  /** Volume tương đối của nến đã đóng gần nhất. null = provider không có volume (vàng). */
  volume: VolumeReading | null;
}

export interface VolumeReading {
  /** Số nến làm mẫu số (trung bình volume liền trước). */
  bars: number;
  /** Volume nến đã đóng gần nhất / trung bình `bars` nến trước nó. */
  lastRatio: number;
  /** Trung bình volume 3 nến đã đóng gần nhất / trung bình `bars` nến trước 3 nến đó. */
  recent3Ratio: number;
}

export interface IctFacts {
  meta: {
    generatedAt: string;
    killZone: KillZone;
    currentPrice: number;
  };
  timeframes: Record<string, TimeframeAnalysis>;
}

// ─── Tiện ích cơ bản ────────────────────────────────────────────────────────

// Làm tròn giá gold về 2 chữ số (đủ cho XAU/USD)
const r2 = (x: number): number => Math.round(x * 100) / 100;

const body = (c: Candle): number => Math.abs(c.close - c.open);

// ─── 1) SWING HIGHS / LOWS (fractal, mặc định 2 nến mỗi bên) ─────────────────

function findSwings(candles: Candle[], lookback = 2): { highs: Swing[]; lows: Swing[] } {
  const highs: Swing[] = [];
  const lows: Swing[] = [];
  for (let i = lookback; i < candles.length - lookback; i++) {
    let isHigh = true;
    let isLow = true;
    for (let j = 1; j <= lookback; j++) {
      if (candles[i].high <= candles[i - j].high || candles[i].high <= candles[i + j].high) isHigh = false;
      if (candles[i].low >= candles[i - j].low || candles[i].low >= candles[i + j].low) isLow = false;
    }
    if (isHigh) highs.push({ index: i, time: candles[i].time, price: r2(candles[i].high) });
    if (isLow) lows.push({ index: i, time: candles[i].time, price: r2(candles[i].low) });
  }
  return { highs, lows };
}

// ─── 2) MARKET STRUCTURE: bias từ chuỗi swing gần nhất ───────────────────────

function structureBias(swings: { highs: Swing[]; lows: Swing[] }): Bias {
  const h = swings.highs.slice(-3);
  const l = swings.lows.slice(-3);
  if (h.length < 2 || l.length < 2) return 'NEUTRAL';

  const higherHighs = h[h.length - 1].price > h[h.length - 2].price;
  const higherLows = l[l.length - 1].price > l[l.length - 2].price;
  const lowerHighs = h[h.length - 1].price < h[h.length - 2].price;
  const lowerLows = l[l.length - 1].price < l[l.length - 2].price;

  if (higherHighs && higherLows) return 'BULLISH';
  if (lowerHighs && lowerLows) return 'BEARISH';
  return 'NEUTRAL';
}

// ─── 3) RANGE + FIB (premium / discount / equilibrium) ───────────────────────

function rangeAndFib(candles: Candle[], lookbackBars: number, last: number): RangeFib {
  const recent = candles.slice(-lookbackBars);
  const hi = Math.max(...recent.map((c) => c.high));
  const lo = Math.min(...recent.map((c) => c.low));
  const eq = (hi + lo) / 2;

  return {
    rangeHigh: r2(hi),
    rangeLow: r2(lo),
    equilibrium: r2(eq),
    fib: {
      '0.0': r2(lo),
      '0.236': r2(lo + (hi - lo) * 0.236),
      '0.382': r2(lo + (hi - lo) * 0.382),
      '0.5': r2(eq),
      '0.618': r2(lo + (hi - lo) * 0.618),
      '0.786': r2(lo + (hi - lo) * 0.786),
      '1.0': r2(hi),
    },
    currentPrice: r2(last),
    zone: last > eq ? 'PREMIUM' : 'DISCOUNT',
  };
}

// ─── 3b) LEG ĐANG CHẠY (dealing range cho HARD GATE 1) ───────────────────────

/**
 * Xác định nhịp giá đang chạy: lấy pivot mới nhất, lùi về pivot đối nghịch gần
 * nhất trước nó → đó là chân leg. Đỉnh/đáy leg lấy theo cực trị THỰC TẾ từ chân
 * leg tới nến cuối, nên leg tự mở rộng khi giá vượt pivot cũ (không bị đóng băng
 * ở mức swing đã xác nhận).
 */
function findActiveLeg(
  candles: Candle[],
  swings: { highs: Swing[]; lows: Swing[] },
  atrValue: number,
  last: number,
): ActiveLeg | null {
  const lastHigh = swings.highs[swings.highs.length - 1];
  const lastLow = swings.lows[swings.lows.length - 1];
  if (!lastHigh && !lastLow) return null;

  // Pivot mới nhất quyết định chiều leg; chân leg là pivot đối nghịch TRƯỚC nó.
  let upLeg: boolean;
  let anchor: Swing | undefined;

  if (lastHigh && lastLow) {
    upLeg = lastHigh.index > lastLow.index;
    const newestIndex = upLeg ? lastHigh.index : lastLow.index;
    anchor = (upLeg ? swings.lows : swings.highs)
      .filter((s) => s.index < newestIndex)
      .pop();
    // Không có pivot đối nghịch nào trước đó → dùng pivot đối nghịch gần nhất hiện có.
    anchor ??= upLeg ? lastLow : lastHigh;
  } else {
    // Cấu trúc một chiều (chỉ có một loại pivot): leg chạy từ pivot đó tới hiện tại.
    upLeg = Boolean(lastLow);
    anchor = lastLow ?? lastHigh;
  }
  if (!anchor) return null;

  const tail = candles.slice(anchor.index);
  if (!tail.length) return null;

  const from = anchor.price;
  const to = upLeg ? Math.max(...tail.map((c) => c.high)) : Math.min(...tail.map((c) => c.low));
  const low = Math.min(from, to);
  const high = Math.max(from, to);
  const size = high - low;
  if (size <= 0) return null;

  return {
    direction: upLeg ? 'UP' : 'DOWN',
    from: r2(from),
    fromTime: anchor.time,
    to: r2(to),
    low: r2(low),
    high: r2(high),
    size: r2(size),
    equilibrium: r2((low + high) / 2),
    sizeAtr: atrValue > 0 ? Number((size / atrValue).toFixed(2)) : 0,
    currentPct: Number((((last - low) / size) * 100).toFixed(1)),
  };
}

// ─── 3c) HỘP RANGE (sideway) ─────────────────────────────────────────────────

/**
 * Đi ngược từ swing mới nhất, nhận dần các swing chừng nào biên (swing high cao nhất −
 * swing low thấp nhất) còn ≤ `maxWidthAtr` × ATR. Biên hộp = high/low thật của các nến
 * từ swing cũ nhất tới swing mới nhất được nhận; nến sau đó chỉ dùng để xét trạng thái
 * (đóng trong / thử biên / phá). Một cú phá đã thành swing mới ngoài hộp chỉ chạm biên
 * mới 1 lần → không đủ `minTouches` → không báo hộp (range đã kết thúc).
 */
function findRangeBox(
  closed: Candle[],
  swings: { highs: Swing[]; lows: Swing[] },
  atrValue: number,
  last: number,
): RangeBox | null {
  const cfg = config.ict.rangeBox;
  if (!(atrValue > 0)) return null;
  const maxWidth = cfg.maxWidthAtr * atrValue;

  const pivots = [
    ...swings.highs.map((s) => ({ ...s, kind: 'HIGH' as const })),
    ...swings.lows.map((s) => ({ ...s, kind: 'LOW' as const })),
  ].sort((a, b) => b.index - a.index);

  let top = -Infinity;
  let bottom = Infinity;
  const accepted: typeof pivots = [];
  for (const p of pivots) {
    const nextTop = p.kind === 'HIGH' ? Math.max(top, p.price) : top;
    const nextBottom = p.kind === 'LOW' ? Math.min(bottom, p.price) : bottom;
    if (Number.isFinite(nextTop) && Number.isFinite(nextBottom) && nextTop - nextBottom > maxWidth) break;
    top = nextTop;
    bottom = nextBottom;
    accepted.push(p);
  }
  if (!Number.isFinite(top) || !Number.isFinite(bottom)) return null;

  // Chuỗi dài nhất vừa biên thường kéo theo 1 swing của nhịp trend trước hộp làm lệch biên
  // (biên đó chỉ chạm 1 lần) → thử từ chuỗi dài nhất ngắn dần, lấy chuỗi đầu tiên đạt điều kiện.
  const tol = cfg.touchTolAtr * atrValue;
  const end = accepted[0].index;
  let box: { start: number; top: number; bottom: number; topTouches: number; bottomTouches: number } | null = null;
  for (let k = accepted.length; k >= 2 && !box; k--) {
    const group = accepted.slice(0, k);
    const start = group[k - 1].index;
    if (closed.length - start < cfg.minBars) break;
    const span = closed.slice(start, end + 1);
    const hi = Math.max(...span.map((c) => c.high));
    const lo = Math.min(...span.map((c) => c.low));
    if (hi - lo > maxWidth || hi - lo < cfg.minWidthAtr * atrValue) continue;
    const topTouches = group.filter((p) => p.kind === 'HIGH' && p.price >= hi - tol).length;
    const bottomTouches = group.filter((p) => p.kind === 'LOW' && p.price <= lo + tol).length;
    if (topTouches >= cfg.minTouches && bottomTouches >= cfg.minTouches) {
      box = { start, top: hi, bottom: lo, topTouches, bottomTouches };
    }
  }
  if (!box) return null;
  const { start, topTouches, bottomTouches } = box;
  top = box.top;
  bottom = box.bottom;
  const width = top - bottom;
  const bars = closed.length - start;

  let closesOutside = 0;
  let outsideSide: 'ABOVE' | 'BELOW' | null = null;
  for (let i = closed.length - 1; i > end; i--) {
    const c = closed[i].close;
    const side = c > top ? 'ABOVE' : c < bottom ? 'BELOW' : null;
    if (!side || (outsideSide && side !== outsideSide)) break;
    outsideSide = side;
    closesOutside++;
  }

  return {
    top: r2(top),
    bottom: r2(bottom),
    width: r2(width),
    widthAtr: Number((width / atrValue).toFixed(2)),
    equilibrium: r2((top + bottom) / 2),
    startTime: closed[start].time,
    bars,
    topTouches,
    bottomTouches,
    positionPct: Number((((last - bottom) / width) * 100).toFixed(1)),
    state: closesOutside === 0 ? 'INSIDE' : closesOutside > config.ict.sweepRejectBars ? 'BROKEN' : 'TESTING',
    closesOutside,
    outsideSide,
  };
}

// ─── 4) FAIR VALUE GAP (FVG / imbalance) — mô hình 3 nến ─────────────────────

function findFVGs(candles: Candle[]): Fvg[] {
  const fvgs: Fvg[] = [];
  for (let i = 1; i < candles.length - 1; i++) {
    const a = candles[i - 1];
    const c = candles[i + 1];
    // Bullish FVG: high nến trước < low nến sau
    if (a.high < c.low) {
      const top = r2(c.low);
      const bottom = r2(a.high);
      // Mitigated: một nến sau đó hồi xuống chạm vào gap (low ≤ top).
      const mitigated = candles.slice(i + 2).some((k) => k.low <= top);
      fvgs.push({
        type: 'BULLISH', top, bottom,
        midpoint: r2((c.low + a.high) / 2),
        index: i, time: candles[i].time, mitigated,
      });
    }
    // Bearish FVG: low nến trước > high nến sau
    if (a.low > c.high) {
      const top = r2(a.low);
      const bottom = r2(c.high);
      // Mitigated: một nến sau đó hồi lên chạm vào gap (high ≥ bottom).
      const mitigated = candles.slice(i + 2).some((k) => k.high >= bottom);
      fvgs.push({
        type: 'BEARISH', top, bottom,
        midpoint: r2((a.low + c.high) / 2),
        index: i, time: candles[i].time, mitigated,
      });
    }
  }
  return fvgs;
}

// ─── 5) ORDER BLOCK ứng viên ─────────────────────────────────────────────────
//   Nến ngược hướng cuối cùng trước một cú displacement (nến đẩy mạnh).

function findOrderBlocks(candles: Candle[], atrValue: number): OrderBlock[] {
  const obs: OrderBlock[] = [];
  const displacementSize = atrValue * 1.2; // nến đẩy phải lớn hơn 1.2*ATR
  for (let i = 1; i < candles.length - 1; i++) {
    const prev = candles[i - 1];
    const cur = candles[i];
    const body = Math.abs(cur.close - cur.open);
    if (body < displacementSize) continue;

    const bullishMove = cur.close > cur.open;
    const top = r2(prev.high);
    const bottom = r2(prev.low);
    // Bullish OB: nến giảm cuối cùng (prev) trước cú đẩy tăng mạnh
    if (bullishMove && prev.close < prev.open) {
      // Mitigated: giá hồi xuống chạm vào OB (low ≤ top) sau cú đẩy.
      const mitigated = candles.slice(i + 1).some((k) => k.low <= top);
      obs.push({ type: 'BULLISH', top, bottom, index: i - 1, time: prev.time, mitigated });
    }
    // Bearish OB: nến tăng cuối cùng (prev) trước cú đẩy giảm mạnh
    if (!bullishMove && prev.close > prev.open) {
      // Mitigated: giá hồi lên chạm vào OB (high ≥ bottom) sau cú đẩy.
      const mitigated = candles.slice(i + 1).some((k) => k.high >= bottom);
      obs.push({ type: 'BEARISH', top, bottom, index: i - 1, time: prev.time, mitigated });
    }
  }
  return obs;
}

// ─── 6) ATR (Average True Range) ─────────────────────────────────────────────

function atr(candles: Candle[], period = 14): number {
  if (candles.length < period + 1) return 0;
  const trs: number[] = [];
  for (let i = 1; i < candles.length; i++) {
    const h = candles[i].high;
    const l = candles[i].low;
    const pc = candles[i - 1].close;
    trs.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)));
  }
  const recent = trs.slice(-period);
  return r2(recent.reduce((a, b) => a + b, 0) / recent.length);
}

export interface AtrBaseline {
  /** True range trung bình của `bars` nến đã đóng gần nhất. */
  value: number;
  bars: number;
  /** ATR(14) / value — > 2 = biến động bất thường so với nền. */
  ratio: number;
}

/**
 * Nền biến động để so với ATR(14): true range trung bình của `bars` nến gần nhất. Cần ít
 * nhất 3× period nến, nếu không ATR(14) chiếm gần hết mẫu và tỉ lệ luôn ≈ 1 (vô nghĩa).
 */
function atrBaseline(candles: Candle[], atrValue: number, bars: number, period = 14): AtrBaseline | null {
  const n = Math.min(bars, candles.length - 1);
  if (n < period * 3 || atrValue <= 0) return null;
  let sum = 0;
  for (let i = candles.length - n; i < candles.length; i++) {
    const { high: h, low: l } = candles[i];
    const pc = candles[i - 1].close;
    sum += Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc));
  }
  const value = sum / n;
  return value > 0 ? { value: r2(value), bars: n, ratio: Number((atrValue / value).toFixed(2)) } : null;
}

// ─── 6a) VOLUME tương đối (chỉ crypto — vàng không có volume) ────────────────
//   Mọi tỉ lệ đều chia cho trung bình volume các nến đã đóng LIỀN TRƯỚC đoạn được đo,
//   để chính cú phá/cú quét không tự kéo mẫu số lên.

/** Trung bình volume `bars` nến ngay trước `start`. null = thiếu volume hoặc < 5 nến làm mẫu. */
function volumeBaseline(candles: Candle[], start: number, bars = config.ict.volumeSmaBars): number | null {
  const from = Math.max(0, start - bars);
  const window = candles.slice(from, start);
  if (window.length < 5 || window.some((c) => c.volume == null)) return null;
  const avg = window.reduce((s, c) => s + (c.volume as number), 0) / window.length;
  return avg > 0 ? avg : null;
}

/** Volume trung bình của candles[from..to] (gồm cả hai đầu) / mẫu số trước `from`. */
function volumeRatio(candles: Candle[], from: number, to: number, reduce: 'max' | 'avg' = 'avg'): number | null {
  if (from < 0 || to < from || to >= candles.length) return null;
  const base = volumeBaseline(candles, from);
  const span = candles.slice(from, to + 1);
  if (base == null || span.some((c) => c.volume == null)) return null;
  const vols = span.map((c) => c.volume as number);
  const v = reduce === 'max' ? Math.max(...vols) : vols.reduce((a, b) => a + b, 0) / vols.length;
  return Number((v / base).toFixed(2));
}

function volumeReading(candles: Candle[]): VolumeReading | null {
  const n = candles.length;
  const lastRatio = volumeRatio(candles, n - 1, n - 1);
  const recent3Ratio = volumeRatio(candles, n - 3, n - 1);
  if (lastRatio == null || recent3Ratio == null) return null;
  return { bars: Math.min(config.ict.volumeSmaBars, n - 3), lastRatio, recent3Ratio };
}

// ─── 6b) ADX / DMI (Wilder) — regime filter cho luật vị trí range ────────────
//   ADX chỉ nói xu hướng MẠNH hay YẾU. Hướng lấy từ +DI vs −DI.
//   Dùng để nới/siết ngưỡng "premium sâu / discount sâu" trong prompt: cùng một
//   mức 70% range mang ý nghĩa khác hẳn giữa thị trường sideway và trend mạnh.

/**
 * Số nến tối thiểu để ADX đáng tin. ADX là trung bình trượt Wilder LỒNG hai lần
 * (RMA của DX, mà DX lại tính từ RMA của DM/TR) nên giai đoạn seed rất dài —
 * với period 14 cần ~3× period thì giá trị mới hết phụ thuộc vào seed.
 * Ít hơn ngưỡng này → trả null (thà không có còn hơn có số rác kèm luật cứng).
 */
const MIN_ADX_CANDLES = 43; // period(14) * 3 + 1

function adx(candles: Candle[], period = 14): AdxReading | null {
  if (candles.length < MIN_ADX_CANDLES) return null;

  // 1) TR, +DM, −DM cho từng nến (bắt đầu từ nến thứ 2 vì cần nến trước).
  const tr: number[] = [];
  const plusDm: number[] = [];
  const minusDm: number[] = [];
  for (let i = 1; i < candles.length; i++) {
    const c = candles[i];
    const p = candles[i - 1];
    tr.push(Math.max(c.high - c.low, Math.abs(c.high - p.close), Math.abs(c.low - p.close)));
    // Chỉ bên nào vượt trội mới được tính DM; hòa hoặc âm → 0.
    const up = c.high - p.high;
    const down = p.low - c.low;
    plusDm.push(up > down && up > 0 ? up : 0);
    minusDm.push(down > up && down > 0 ? down : 0);
  }

  // 2) Wilder smoothing: seed = tổng `period` giá trị đầu, sau đó prev − prev/period + current.
  const wilder = (xs: number[]): number[] => {
    const out: number[] = [];
    let sum = 0;
    for (let i = 0; i < period; i++) sum += xs[i];
    out.push(sum);
    for (let i = period; i < xs.length; i++) {
      sum = sum - sum / period + xs[i];
      out.push(sum);
    }
    return out;
  };
  const trS = wilder(tr);
  const plusS = wilder(plusDm);
  const minusS = wilder(minusDm);

  // 3) DX từng bước = 100 × |+DI − −DI| / (+DI + −DI).
  const dxs: number[] = [];
  for (let i = 0; i < trS.length; i++) {
    if (trS[i] === 0) { dxs.push(0); continue; }
    const pdi = (100 * plusS[i]) / trS[i];
    const mdi = (100 * minusS[i]) / trS[i];
    const sum = pdi + mdi;
    dxs.push(sum === 0 ? 0 : (100 * Math.abs(pdi - mdi)) / sum);
  }
  if (dxs.length < period) return null;

  // 4) ADX = RMA của DX (seed = trung bình `period` DX đầu tiên).
  let value = dxs.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < dxs.length; i++) {
    value = (value * (period - 1) + dxs[i]) / period;
  }

  const lastTr = trS[trS.length - 1];
  const plusDi = lastTr === 0 ? 0 : (100 * plusS[plusS.length - 1]) / lastTr;
  const minusDi = lastTr === 0 ? 0 : (100 * minusS[minusS.length - 1]) / lastTr;

  const r1 = (x: number): number => Math.round(x * 10) / 10;
  return {
    value: r1(value),
    plusDi: r1(plusDi),
    minusDi: r1(minusDi),
    regime: value >= 30 ? 'STRONG_TREND' : value >= 20 ? 'WEAK_TREND' : 'RANGE',
    direction: plusDi >= minusDi ? 'BULLISH' : 'BEARISH',
  };
}

// ─── 7) TRẠNG THÁI MỨC THANH KHOẢN: unswept / swept / broken / breaking ──────

interface LevelCheck {
  status: LevelStatus;
  /** Index nến xác nhận sự kiện CUỐI: nến đóng cửa quay lại (SWEPT) / nến phá (BROKEN). */
  eventIndex: number | null;
  /** Râu xa nhất của cú quét cuối (chỉ có khi SWEPT) — mức invalidation của setup đảo chiều. */
  extreme: number | null;
}

/**
 * Lần theo một mức thanh khoản từ `fromIndex`. Mỗi lần wick vượt qua mức thì phân loại:
 *  - body close quay lại bên trong ngay nến đó hoặc trong `rejectBars` nến sau → SWEPT
 *  - đóng cửa bên ngoài suốt cửa sổ đó → BROKEN (phá thật), dừng — mức đã mất tác dụng
 *  - đóng cửa bên ngoài nhưng chưa đủ nến để kết luận → BREAKING
 * Trạng thái trả về là của sự kiện CUỐI: từng bị quét rồi sau đó bị phá thật = BROKEN.
 */
function checkLevel(
  candles: Candle[],
  level: number,
  side: 'HIGH' | 'LOW',
  fromIndex: number,
  rejectBars: number,
): LevelCheck {
  const beyondWick = (c: Candle): boolean => (side === 'HIGH' ? c.high > level : c.low < level);
  const beyondClose = (c: Candle): boolean => (side === 'HIGH' ? c.close > level : c.close < level);
  let result: LevelCheck = { status: 'UNSWEPT', eventIndex: null, extreme: null };

  let j = Math.max(0, fromIndex);
  while (j < candles.length) {
    if (!beyondWick(candles[j])) { j++; continue; }

    let back = -1;
    const lastK = Math.min(j + rejectBars, candles.length - 1);
    for (let k = j; k <= lastK; k++) {
      if (!beyondClose(candles[k])) { back = k; break; }
    }

    if (back >= 0) {
      const span = candles.slice(j, back + 1);
      const extreme = side === 'HIGH'
        ? Math.max(...span.map((c) => c.high))
        : Math.min(...span.map((c) => c.low));
      result = { status: 'SWEPT', eventIndex: back, extreme: r2(extreme) };
      j = back + 1;
      continue;
    }

    const enoughBars = candles.length - 1 - j >= rejectBars;
    return { status: enoughBars ? 'BROKEN' : 'BREAKING', eventIndex: j, extreme: null };
  }
  return result;
}

// ─── 7a) LIQUIDITY: equal highs / equal lows (dung sai theo ATR) ─────────────

function findLiquidity(
  swings: { highs: Swing[]; lows: Swing[] },
  atrValue: number,
  candles: Candle[],
): Liquidity {
  const tol = atrValue * 0.15; // dung sai để coi là "bằng nhau"
  const rejectBars = config.ict.sweepRejectBars;
  const equalHighs: LiquidityLevel[] = [];
  const equalLows: LiquidityLevel[] = [];

  const hs = swings.highs;
  for (let i = 1; i < hs.length; i++) {
    if (Math.abs(hs[i].price - hs[i - 1].price) <= tol) {
      const price = r2((hs[i].price + hs[i - 1].price) / 2);
      const { status } = checkLevel(candles, price, 'HIGH', hs[i].index + 1, rejectBars);
      equalHighs.push({ price, times: [hs[i - 1].time, hs[i].time], index: hs[i].index, status });
    }
  }
  const ls = swings.lows;
  for (let i = 1; i < ls.length; i++) {
    if (Math.abs(ls[i].price - ls[i - 1].price) <= tol) {
      const price = r2((ls[i].price + ls[i - 1].price) / 2);
      const { status } = checkLevel(candles, price, 'LOW', ls[i].index + 1, rejectBars);
      equalLows.push({ price, times: [ls[i - 1].time, ls[i].time], index: ls[i].index, status });
    }
  }
  return { equalHighs, equalLows };
}

// ─── 7b) SWEEP EVENTS: cú quét đỉnh/đáy đã bị từ chối gần nhất ───────────────
//   Đây là bước "chờ giá quét thanh khoản" của quy trình: một wick vượt đỉnh/đáy
//   (swing đơn lẻ hoặc equal level) rồi body close quay lại. Chỉ giữ sự kiện mà mức đó
//   VẪN ở trạng thái SWEPT (chưa bị phá thật về sau).

/** Chuỗi nến đã đóng liên tiếp (tính từ nến cuối lùi về `fromIndex`) đóng cửa đúng phía đảo chiều. */
function holdCloses(candles: Candle[], level: number, side: 'HIGH' | 'LOW', fromIndex: number): number {
  let n = 0;
  for (let i = candles.length - 1; i >= fromIndex; i--) {
    const back = side === 'HIGH' ? candles[i].close < level : candles[i].close > level;
    if (!back) break;
    n++;
  }
  return n;
}

function findSweeps(
  candles: Candle[],
  swings: { highs: Swing[]; lows: Swing[] },
  liquidity: Liquidity,
): SweepEvent[] {
  const { sweepRejectBars, sweepRecentBars } = config.ict;
  const minIndex = candles.length - sweepRecentBars;
  const raw: SweepEvent[] = [];

  const consider = (level: number, from: number, side: 'HIGH' | 'LOW', levelType: 'SWING' | 'EQUAL'): void => {
    const chk = checkLevel(candles, level, side, from, sweepRejectBars);
    if (chk.status !== 'SWEPT' || chk.eventIndex == null || chk.extreme == null) return;
    if (chk.eventIndex < minIndex) return;
    // Nến đầu của cú quét: lùi từ nến đóng quay lại qua các nến còn đóng cửa bên ngoài mức
    // (tối đa sweepRejectBars cây — đúng cửa sổ checkLevel đã dùng).
    const closeBeyond = (c: Candle): boolean => (side === 'HIGH' ? c.close > level : c.close < level);
    let start = chk.eventIndex;
    while (start - 1 >= Math.max(0, chk.eventIndex - sweepRejectBars) && closeBeyond(candles[start - 1])) start--;
    raw.push({
      side: side === 'HIGH' ? 'BUYSIDE' : 'SELLSIDE',
      levelType,
      level,
      extreme: chk.extreme,
      index: chk.eventIndex,
      time: candles[chk.eventIndex].time,
      holdCloses: holdCloses(candles, level, side, chk.eventIndex),
      volRatio: volumeRatio(candles, start, chk.eventIndex, 'max'),
    });
  };

  for (const s of swings.highs) consider(s.price, s.index + 1, 'HIGH', 'SWING');
  for (const s of swings.lows) consider(s.price, s.index + 1, 'LOW', 'SWING');
  for (const l of liquidity.equalHighs) consider(l.price, l.index + 1, 'HIGH', 'EQUAL');
  for (const l of liquidity.equalLows) consider(l.price, l.index + 1, 'LOW', 'EQUAL');

  // Một nến quét nhiều mức cùng phía → giữ mức XA nhất (pool lớn nhất bị lấy).
  const byCandle = new Map<string, SweepEvent>();
  for (const e of raw) {
    const key = `${e.side}@${e.index}`;
    const prev = byCandle.get(key);
    const farther = !prev || (e.side === 'BUYSIDE' ? e.level > prev.level : e.level < prev.level);
    if (farther) byCandle.set(key, e);
  }
  return [...byCandle.values()].sort((a, b) => a.index - b.index).slice(-3);
}

// ─── 8) KILL ZONE theo thời điểm phân tích, có xử lý DST ─────────────────────
//   London KZ = 08:00–11:00 giờ London; New York KZ = 08:30–11:00 giờ New York.
//   Quy ra giờ VN: mùa hè 14:00–17:00 / 19:30–22:00, mùa đông 15:00–18:00 / 20:30–23:00.
//   Bản cũ cố định khung mùa hè nên từ cuối tháng 10 (London về GMT) facts gắn nhãn sai.

const LONDON_KZ: [number, number] = [8 * 60, 11 * 60];
const NEW_YORK_KZ: [number, number] = [8 * 60 + 30, 11 * 60];

function killZone(now: Date): KillZone {
  const minutesOf = (tz: string): number => {
    const p = zonedParts(now, tz);
    return p.hour * 60 + p.minute;
  };
  const utcMin = now.getUTCHours() * 60 + now.getUTCMinutes();
  // Độ lệch so với UTC (phút), chuẩn hoá về [-720, 720).
  const offsetOf = (localMin: number): number => ((((localMin - utcMin + 720) % 1440) + 1440) % 1440) - 720;
  const fmt = (m: number): string => {
    const x = ((m % 1440) + 1440) % 1440;
    return `${String(Math.floor(x / 60)).padStart(2, '0')}:${String(x % 60).padStart(2, '0')}`;
  };

  const vnMin = minutesOf(config.marketHours.timezone);
  const ldnMin = minutesOf('Europe/London');
  const nyMin = minutesOf('America/New_York');
  const vnOff = offsetOf(vnMin);
  const ldnOff = offsetOf(ldnMin);
  const nyOff = offsetOf(nyMin);

  const inRange = (m: number, [a, b]: [number, number]): boolean => m >= a && m <= b;
  const toVn = ([a, b]: [number, number], off: number): string => `${fmt(a - off + vnOff)}–${fmt(b - off + vnOff)}`;

  let zone: KillZone['zone'] = 'NONE';
  if (inRange(ldnMin, LONDON_KZ)) zone = 'LONDON';
  else if (inRange(nyMin, NEW_YORK_KZ)) zone = 'NEW_YORK';

  return {
    vnTime: fmt(vnMin),
    inKillZone: zone !== 'NONE',
    zone,
    londonDst: ldnOff === 60,
    newYorkDst: nyOff === -240,
    londonVn: toVn(LONDON_KZ, ldnOff),
    newYorkVn: toVn(NEW_YORK_KZ, nyOff),
  };
}

// ─── 9) STRUCTURE: BOS / CHoCH (body close phá swing) + displacement + vùng retest ─
//   Quét nến từ cũ → mới, luôn tham chiếu swing high/low GẦN NHẤT đã hình thành.
//   Body close vượt swing high → break tăng; vượt swing low → break giảm.
//   Đổi hướng so với break trước = CHoCH, cùng hướng = BOS.
//   Mỗi sự kiện được chấm displacement + gắn FVG/OB do chính cú phá tạo ra (vùng retest).

function describeBreak(
  candles: Candle[],
  i: number,
  direction: 'BULLISH' | 'BEARISH',
  atrValue: number,
  fvgs: Fvg[],
  obs: OrderBlock[],
): Pick<StructureEvent, 'displacement' | 'bodyAtr' | 'retestZone' | 'breakVolRatio' | 'pullbackVolRatio'> {
  const bullish = direction === 'BULLISH';
  const sameDir = (c: Candle): boolean => (bullish ? c.close > c.open : c.close < c.open);

  // Nến phá hoặc nến liền trước (cú đẩy hay bắt đầu sớm hơn nến phá một cây).
  let maxBody = 0;
  for (const k of [i, i - 1]) {
    if (k >= 0 && sameDir(candles[k])) maxBody = Math.max(maxBody, body(candles[k]));
  }
  const bodyAtr = atrValue > 0 ? Number((maxBody / atrValue).toFixed(2)) : 0;

  // Volume: cú đẩy = nến phá (+ nến liền trước nếu cùng chiều); nhịp sau phá đo cùng mẫu số
  // (trung bình trước cú đẩy) để hai số so được với nhau.
  const pushStart = i - 1 >= 0 && sameDir(candles[i - 1]) ? i - 1 : i;
  const breakVolRatio = volumeRatio(candles, pushStart, i, 'max');
  const base = volumeBaseline(candles, pushStart);
  const after = candles.slice(i + 1, i + 1 + config.ict.volumeSmaBars);
  const pullbackVolRatio = base != null && after.length && after.every((c) => c.volume != null)
    ? Number((after.reduce((s, c) => s + (c.volume as number), 0) / after.length / base).toFixed(2))
    : null;

  // FVG cùng chiều sinh ra quanh cú phá (nến giữa của FVG nằm trong [i-2, i+1]).
  const fvg = fvgs.filter((f) => f.type === direction && f.index >= i - 2 && f.index <= i + 1).pop();
  // OB = nến ngược cuối cùng trước cú đẩy, nằm ngay trước/tại nến phá.
  const ob = obs.filter((o) => o.type === direction && o.index >= i - 3 && o.index <= i).pop();

  const displacement = (atrValue > 0 && maxBody >= atrValue * config.ict.displacementBodyAtr) || Boolean(fvg);

  type Box = { top: number; bottom: number; index: number; mitigated: boolean };
  const zoneOf = (source: RetestZone['source'], z: Box): RetestZone => {
    // Vùng hỏng khi có nến body close xuyên qua mép XA sau cú phá, sâu hơn ngưỡng chịu lệch.
    const startAt = Math.max(i + 1, z.index + 2);
    let depth = 0;
    for (const c of candles.slice(startAt)) {
      depth = Math.max(depth, bullish ? z.bottom - c.close : c.close - z.top);
    }
    const tolerance = Math.max(0, config.ict.retestInvalidateAtr) * atrValue;
    const invalidated = depth > tolerance;
    const penetrationAtr = depth > 0 && atrValue > 0 ? Number((depth / atrValue).toFixed(2)) : 0;
    return {
      source, type: direction, top: z.top, bottom: z.bottom, index: z.index,
      mitigated: z.mitigated, invalidated, penetrationAtr,
    };
  };

  let retestZone: RetestZone | null = null;
  if (fvg) {
    const fvgOb = ob ?? obBeforeFvg(candles, fvg, direction);
    const merged = fvgOb ? mergeFvgOb(fvg, fvgOb, atrValue) : null;
    retestZone = merged ? zoneOf('FVG+OB', merged) : zoneOf('FVG', fvg);
  } else if (ob) {
    retestZone = zoneOf('OB', ob);
  }

  return { displacement, bodyAtr, retestZone, breakVolRatio, pullbackVolRatio };
}

/**
 * OB của chính cú đẩy tạo ra FVG: nến ngược chiều cuối cùng trước nến đẩy (nến giữa FVG),
 * lùi tối đa 3 cây. `findOrderBlocks` đòi nến đẩy ≥ 1.2× ATR nên bỏ sót OB của những cú
 * phá vừa đủ displacement (~1× ATR) — đúng loại hay để lại FVG mỏng cần gộp nhất.
 */
function obBeforeFvg(candles: Candle[], fvg: Fvg, direction: 'BULLISH' | 'BEARISH'): OrderBlock | null {
  const bullish = direction === 'BULLISH';
  for (let k = fvg.index - 1; k >= Math.max(0, fvg.index - 3); k--) {
    const c = candles[k];
    if (bullish ? c.close < c.open : c.close > c.open) {
      const top = r2(c.high);
      const bottom = r2(c.low);
      // Mitigated tính từ sau nến thứ 3 của FVG — trước đó là chính cú đẩy.
      const after = candles.slice(fvg.index + 2);
      const mitigated = after.some((x) => (bullish ? x.low <= top : x.high >= bottom));
      return { type: direction, top, bottom, index: k, time: c.time, mitigated };
    }
  }
  return null;
}

/** Gộp FVG + OB thành một hộp khi hai vùng chồng nhau hoặc cách ≤ `retestMergeObGapAtr` × ATR. */
function mergeFvgOb(
  fvg: Fvg,
  ob: OrderBlock,
  atrValue: number,
): { top: number; bottom: number; index: number; mitigated: boolean } | null {
  const maxGap = config.ict.retestMergeObGapAtr;
  if (maxGap < 0) return null;
  const gap = Math.max(0, Math.max(fvg.bottom, ob.bottom) - Math.min(fvg.top, ob.top));
  if (gap > maxGap * atrValue) return null;
  return {
    top: Math.max(fvg.top, ob.top),
    bottom: Math.min(fvg.bottom, ob.bottom),
    // Index muộn hơn: phép kiểm "hỏng" chỉ bắt đầu sau khi cả hai vùng đã hình thành.
    index: Math.max(fvg.index, ob.index),
    mitigated: fvg.mitigated || ob.mitigated,
  };
}

function findStructureEvents(
  candles: Candle[],
  swings: { highs: Swing[]; lows: Swing[] },
  atrValue: number,
  fvgs: Fvg[],
  obs: OrderBlock[],
): StructureEvent[] {
  const highs = swings.highs;
  const lows = swings.lows;
  let hi = 0;
  let li = 0;
  let refHigh: Swing | null = null;
  let refLow: Swing | null = null;
  let brokenHigh = false;
  let brokenLow = false;
  let trend: 'BULLISH' | 'BEARISH' | null = null;
  const events: StructureEvent[] = [];

  for (let i = 0; i < candles.length; i++) {
    // Swing chỉ được tham chiếu khi đã hình thành trước nến hiện tại.
    while (hi < highs.length && highs[hi].index < i) { refHigh = highs[hi]; brokenHigh = false; hi++; }
    while (li < lows.length && lows[li].index < i) { refLow = lows[li]; brokenLow = false; li++; }

    const close = candles[i].close;
    if (refHigh && !brokenHigh && close > refHigh.price) {
      const kind = trend === 'BEARISH' ? 'CHoCH' : 'BOS';
      events.push({
        kind, direction: 'BULLISH', level: refHigh.price, time: candles[i].time, index: i,
        ...describeBreak(candles, i, 'BULLISH', atrValue, fvgs, obs),
      });
      trend = 'BULLISH';
      brokenHigh = true;
    }
    if (refLow && !brokenLow && close < refLow.price) {
      const kind = trend === 'BULLISH' ? 'CHoCH' : 'BOS';
      events.push({
        kind, direction: 'BEARISH', level: refLow.price, time: candles[i].time, index: i,
        ...describeBreak(candles, i, 'BEARISH', atrValue, fvgs, obs),
      });
      trend = 'BEARISH';
      brokenLow = true;
    }
  }

  return events.slice(-Math.max(1, config.ict.structureEvents));
}

// ─── HÀM TỔNG: phân tích 1 khung ─────────────────────────────────────────────

export function analyzeTimeframe(
  candles: Candle[],
  { fibLookback = 80, swingLookback = 2, formingLast = false }:
    { fibLookback?: number; swingLookback?: number; formingLast?: boolean } = {},
): TimeframeAnalysis {
  // Nến đang chạy bị loại khỏi mọi phép tính dựa trên body close/pivot. Chỉ bỏ khi vẫn
  // còn đủ nến đã đóng để tính (giữ hành vi cũ với mảng quá ngắn).
  const dropLast = formingLast && candles.length > 5;
  const closed = dropLast ? candles.slice(0, -1) : candles;
  // Giá sống = close của nến cuối (kể cả đang chạy) — dùng cho range/leg/giá hiện tại.
  const last = candles[candles.length - 1].close;

  const swings = findSwings(closed, swingLookback);
  const atrValue = atr(closed);
  const fvgs = findFVGs(closed);
  const orderBlocks = findOrderBlocks(closed, atrValue);
  const liquidity = findLiquidity(swings, atrValue, closed);
  const structureEvents = findStructureEvents(closed, swings, atrValue, fvgs, orderBlocks);
  const rejectBars = config.ict.sweepRejectBars;
  const withStatus = (list: Swing[], side: 'HIGH' | 'LOW'): Swing[] =>
    list.map((s) => ({ ...s, status: checkLevel(closed, s.price, side, s.index + 1, rejectBars).status }));

  return {
    candleCount: candles.length,
    closedCount: closed.length,
    formingCandle: dropLast ? candles[candles.length - 1] : null,
    lastPrice: r2(last),
    bias: structureBias(swings),
    atr: atrValue,
    atrBaseline: atrBaseline(closed, atrValue, config.ict.atrBaselineBars),
    range: rangeAndFib(candles, fibLookback, last),
    // swings tính trên `closed` là tiền tố của `candles` → index vẫn hợp lệ.
    activeLeg: findActiveLeg(candles, swings, atrValue, last),
    rangeBox: findRangeBox(closed, swings, atrValue, last),
    swingHighs: withStatus(swings.highs.slice(-5), 'HIGH'),
    swingLows: withStatus(swings.lows.slice(-5), 'LOW'),
    fvgs: fvgs.slice(-6),
    orderBlocks: orderBlocks.slice(-6),
    liquidity,
    recentStructure: structureEvents[structureEvents.length - 1] ?? null,
    structureEvents,
    sweeps: findSweeps(closed, swings, liquidity),
    adx: adx(closed),
    volume: volumeReading(closed),
  };
}

// ─── HÀM EXPORT CHÍNH: nhận các khung, trả object để nhét vào prompt ─────────

/** Lookback fib mặc định theo từng khung. */
const FIB_LOOKBACK_BY_TF: Record<string, number> = {
  H1: 80,
  M15: 96,
  M5: 96,
};

export interface PreprocessOptions {
  /** Thời điểm phân tích — quyết định nến nào đang chạy + kill zone. Mặc định: bây giờ. */
  now?: Date;
  /** Giá hiện tại từ provider; không có → close của nến mới nhất (khung nhỏ nhất). */
  currentPrice?: number;
  /** Ghi đè lookback range/fib theo khung (kế hoạch ngày dùng D/H4 dài hơn bảng mặc định). */
  fibLookbackByTf?: Record<string, number>;
}

/**
 * Tính sẵn các "facts" ICT/SMC cho mọi khung được cung cấp.
 * Bỏ qua khung không đủ nến (cần ≥ 5 nến để có ý nghĩa).
 * Key của `candlesByTimeframe` phải là mã khung (M5/M15/H1/H4/D…) để nhận ra nến đang chạy.
 */
export function preprocess(candlesByTimeframe: Record<string, Candle[]>, opts: PreprocessOptions = {}): IctFacts {
  const now = opts.now ?? new Date();
  const tz = config.marketHours.timezone;
  const timeframes: Record<string, TimeframeAnalysis> = {};
  // Giá dự phòng: close nến cuối của khung có độ dài nến NGẮN nhất (cập nhật nhất).
  let fallbackPrice = 0;
  let shortestTf = Infinity;

  for (const [tf, candles] of Object.entries(candlesByTimeframe)) {
    if (!candles || candles.length < 5) continue;
    const formingLast = isCandleForming(candles[candles.length - 1], tf, tz, now);
    timeframes[tf] = analyzeTimeframe(candles, { fibLookback: opts.fibLookbackByTf?.[tf] ?? FIB_LOOKBACK_BY_TF[tf] ?? 80, formingLast });

    const seconds = TF_SECONDS[tf] ?? Infinity;
    if (seconds < shortestTf || fallbackPrice === 0) {
      shortestTf = Math.min(shortestTf, seconds);
      fallbackPrice = candles[candles.length - 1].close;
    }
  }

  return {
    meta: {
      generatedAt: now.toISOString(),
      killZone: killZone(now),
      currentPrice: r2(opts.currentPrice && opts.currentPrice > 0 ? opts.currentPrice : fallbackPrice),
    },
    timeframes,
  };
}
