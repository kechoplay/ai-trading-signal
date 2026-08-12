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
 * TwelveData được gọi với param timezone=MARKET_HOURS_TIMEZONE (Asia/Ho_Chi_Minh)
 * nên timestamp ĐÃ LÀ giờ VN → UTC_OFFSET = 0. Kill zone vốn cũng tính theo giờ VN.
 * Nếu sau này data trả về UTC, đổi UTC_OFFSET = 7.
 * -----------------------------------------------------------------------------
 */

import { Candle } from '../../market/Candle';

const UTC_OFFSET = 0; // data đã là giờ VN (TwelveData timezone=Asia/Ho_Chi_Minh). Đổi về 7 nếu data là UTC.

// ─── Kiểu dữ liệu output ────────────────────────────────────────────────────

export interface Swing {
  index: number;
  time: string;
  price: number;
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
  /** true = giá đã quét qua mức này sau khi nó hình thành; false = pool còn nguyên (nam châm DOL). */
  swept: boolean;
}

export interface Liquidity {
  equalHighs: LiquidityLevel[];
  equalLows: LiquidityLevel[];
}

/** Sự kiện cấu trúc gần nhất: body-close phá swing gần nhất theo hướng nào. */
export interface StructureEvent {
  kind: 'BOS' | 'CHoCH';
  direction: 'BULLISH' | 'BEARISH';
  level: number;
  time: string;
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
}

export interface TimeframeAnalysis {
  candleCount: number;
  lastPrice: number;
  bias: Bias;
  atr: number;
  range: RangeFib;
  /** null = chưa đủ swing đối nghịch để xác định nhịp đang chạy. */
  activeLeg: ActiveLeg | null;
  swingHighs: Swing[];
  swingLows: Swing[];
  fvgs: Fvg[];
  orderBlocks: OrderBlock[];
  liquidity: Liquidity;
  recentStructure: StructureEvent | null;
  /** null = khung không đủ nến để ADX hội tụ (xem MIN_ADX_CANDLES). */
  adx: AdxReading | null;
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

/**
 * Parse chuỗi "YYYY-MM-DD HH:mm:ss" thành Date bằng cách ép gắn Z (đọc nguyên
 * giờ-phút trong chuỗi qua getUTC*). Dùng cho so sánh tương đối & lấy wall-clock
 * giờ VN (vì data đã là giờ VN, xem UTC_OFFSET=0). KHÔNG dùng cho instant tuyệt đối.
 */
function toDate(t: string): Date {
  if (/[zZ]|[+-]\d{2}:?\d{2}$/.test(t)) return new Date(t); // đã có timezone
  const iso = t.trim().replace(' ', 'T');
  return new Date(`${iso}Z`);
}

// Lấy giờ + phút theo giờ VN từ timestamp
function vnHourMinute(t: string): { hour: number; minute: number; totalMin: number } {
  const d = toDate(t);
  const utcMinutes = d.getUTCHours() * 60 + d.getUTCMinutes();
  const vnMinutes = (utcMinutes + UTC_OFFSET * 60 + 1440) % 1440;
  return { hour: Math.floor(vnMinutes / 60), minute: vnMinutes % 60, totalMin: vnMinutes };
}

// Làm tròn giá gold về 2 chữ số (đủ cho XAU/USD)
const r2 = (x: number): number => Math.round(x * 100) / 100;

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

function rangeAndFib(candles: Candle[], lookbackBars = 80): RangeFib {
  const recent = candles.slice(-lookbackBars);
  const hi = Math.max(...recent.map((c) => c.high));
  const lo = Math.min(...recent.map((c) => c.low));
  const eq = (hi + lo) / 2;
  const last = candles[candles.length - 1].close;

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

  const last = candles[candles.length - 1].close;

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

// ─── 7) LIQUIDITY: equal highs / equal lows (dung sai theo ATR) ──────────────

function findLiquidity(
  swings: { highs: Swing[]; lows: Swing[] },
  atrValue: number,
  candles: Candle[],
): Liquidity {
  const tol = atrValue * 0.15; // dung sai để coi là "bằng nhau"
  const equalHighs: LiquidityLevel[] = [];
  const equalLows: LiquidityLevel[] = [];

  const hs = swings.highs;
  for (let i = 1; i < hs.length; i++) {
    if (Math.abs(hs[i].price - hs[i - 1].price) <= tol) {
      const price = r2((hs[i].price + hs[i - 1].price) / 2);
      // Swept: sau khi mức hình thành (swing sau), có nến nào wick vượt LÊN trên mức.
      const swept = candles.slice(hs[i].index + 1).some((c) => c.high > price);
      equalHighs.push({ price, times: [hs[i - 1].time, hs[i].time], index: hs[i].index, swept });
    }
  }
  const ls = swings.lows;
  for (let i = 1; i < ls.length; i++) {
    if (Math.abs(ls[i].price - ls[i - 1].price) <= tol) {
      const price = r2((ls[i].price + ls[i - 1].price) / 2);
      // Swept: sau khi mức hình thành, có nến nào wick vượt XUỐNG dưới mức.
      const swept = candles.slice(ls[i].index + 1).some((c) => c.low < price);
      equalLows.push({ price, times: [ls[i - 1].time, ls[i].time], index: ls[i].index, swept });
    }
  }
  return { equalHighs, equalLows };
}

// ─── 8) KILL ZONE cho nến mới nhất ───────────────────────────────────────────
//   London 14:00–17:00 VN, New York 19:30–22:00 VN

function killZone(time: string): KillZone {
  const { totalMin, hour, minute } = vnHourMinute(time);
  const london = totalMin >= 14 * 60 && totalMin <= 17 * 60;
  const ny = totalMin >= 19 * 60 + 30 && totalMin <= 22 * 60;
  let zone: KillZone['zone'] = 'NONE';
  if (london) zone = 'LONDON';
  else if (ny) zone = 'NEW_YORK';
  return {
    vnTime: `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`,
    inKillZone: zone !== 'NONE',
    zone,
  };
}

// ─── 9) RECENT STRUCTURE: BOS / CHoCH gần nhất (body close phá swing) ─────────
//   Quét nến từ cũ → mới, luôn tham chiếu swing high/low GẦN NHẤT đã hình thành.
//   Body close vượt swing high → break tăng; vượt swing low → break giảm.
//   Đổi hướng so với break trước = CHoCH, cùng hướng = BOS. Trả sự kiện MỚI NHẤT.

function findRecentStructure(
  candles: Candle[],
  swings: { highs: Swing[]; lows: Swing[] },
): StructureEvent | null {
  const highs = swings.highs;
  const lows = swings.lows;
  let hi = 0;
  let li = 0;
  let refHigh: Swing | null = null;
  let refLow: Swing | null = null;
  let brokenHigh = false;
  let brokenLow = false;
  let trend: 'BULLISH' | 'BEARISH' | null = null;
  let last: StructureEvent | null = null;

  for (let i = 0; i < candles.length; i++) {
    // Swing chỉ được tham chiếu khi đã hình thành trước nến hiện tại.
    while (hi < highs.length && highs[hi].index < i) { refHigh = highs[hi]; brokenHigh = false; hi++; }
    while (li < lows.length && lows[li].index < i) { refLow = lows[li]; brokenLow = false; li++; }

    const close = candles[i].close;
    if (refHigh && !brokenHigh && close > refHigh.price) {
      const kind = trend === 'BEARISH' ? 'CHoCH' : 'BOS';
      last = { kind, direction: 'BULLISH', level: refHigh.price, time: candles[i].time };
      trend = 'BULLISH';
      brokenHigh = true;
    }
    if (refLow && !brokenLow && close < refLow.price) {
      const kind = trend === 'BULLISH' ? 'CHoCH' : 'BOS';
      last = { kind, direction: 'BEARISH', level: refLow.price, time: candles[i].time };
      trend = 'BEARISH';
      brokenLow = true;
    }
  }

  return last;
}

// ─── HÀM TỔNG: phân tích 1 khung ─────────────────────────────────────────────

export function analyzeTimeframe(
  candles: Candle[],
  { fibLookback = 80, swingLookback = 2 }: { fibLookback?: number; swingLookback?: number } = {},
): TimeframeAnalysis {
  const swings = findSwings(candles, swingLookback);
  const atrValue = atr(candles);
  return {
    candleCount: candles.length,
    lastPrice: r2(candles[candles.length - 1].close),
    bias: structureBias(swings),
    atr: atrValue,
    range: rangeAndFib(candles, fibLookback),
    activeLeg: findActiveLeg(candles, swings, atrValue),
    swingHighs: swings.highs.slice(-5),
    swingLows: swings.lows.slice(-5),
    fvgs: findFVGs(candles).slice(-6),
    orderBlocks: findOrderBlocks(candles, atrValue).slice(-6),
    liquidity: findLiquidity(swings, atrValue, candles),
    recentStructure: findRecentStructure(candles, swings),
    adx: adx(candles),
  };
}

// ─── HÀM EXPORT CHÍNH: nhận các khung, trả object để nhét vào prompt ─────────

/** Lookback fib mặc định theo từng khung. */
const FIB_LOOKBACK_BY_TF: Record<string, number> = {
  H1: 80,
  M15: 96,
  M5: 96,
};

/**
 * Tính sẵn các "facts" ICT/SMC cho mọi khung được cung cấp.
 * Bỏ qua khung không đủ nến (cần ≥ 5 nến để có ý nghĩa).
 */
export function preprocess(candlesByTimeframe: Record<string, Candle[]>): IctFacts {
  const timeframes: Record<string, TimeframeAnalysis> = {};
  let latestCandle: Candle | null = null;

  for (const [tf, candles] of Object.entries(candlesByTimeframe)) {
    if (!candles || candles.length < 5) continue;
    timeframes[tf] = analyzeTimeframe(candles, { fibLookback: FIB_LOOKBACK_BY_TF[tf] ?? 80 });

    const last = candles[candles.length - 1];
    if (!latestCandle || toDate(last.time) >= toDate(latestCandle.time)) {
      latestCandle = last;
    }
  }

  return {
    meta: {
      generatedAt: new Date().toISOString(),
      killZone: latestCandle ? killZone(latestCandle.time) : { vnTime: '--:--', inKillZone: false, zone: 'NONE' },
      currentPrice: latestCandle ? r2(latestCandle.close) : 0,
    },
    timeframes,
  };
}
