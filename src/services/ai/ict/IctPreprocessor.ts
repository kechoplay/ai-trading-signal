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
 * Giả định timestamp là UTC. Kill zone tính theo giờ VN (UTC+7).
 * Nếu data đã là giờ VN, set UTC_OFFSET = 0.
 * -----------------------------------------------------------------------------
 */

import { Candle } from '../../market/Candle';

const UTC_OFFSET = 7; // giờ VN so với UTC. Đổi về 0 nếu data đã là giờ VN.

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

export interface Fvg {
  type: 'BULLISH' | 'BEARISH';
  top: number;
  bottom: number;
  midpoint: number;
  index: number;
  time: string;
}

export interface OrderBlock {
  type: 'BULLISH' | 'BEARISH';
  top: number;
  bottom: number;
  index: number;
  time: string;
}

export interface LiquidityLevel {
  price: number;
  times: [string, string];
}

export interface Liquidity {
  equalHighs: LiquidityLevel[];
  equalLows: LiquidityLevel[];
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
  swingHighs: Swing[];
  swingLows: Swing[];
  fvgs: Fvg[];
  orderBlocks: OrderBlock[];
  liquidity: Liquidity;
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
 * Parse chuỗi thời gian thành Date. TwelveData trả "YYYY-MM-DD HH:mm:ss" theo UTC
 * nhưng KHÔNG có hậu tố Z → ép hiểu là UTC để tránh lệch theo giờ máy.
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

// ─── 4) FAIR VALUE GAP (FVG / imbalance) — mô hình 3 nến ─────────────────────

function findFVGs(candles: Candle[]): Fvg[] {
  const fvgs: Fvg[] = [];
  for (let i = 1; i < candles.length - 1; i++) {
    const a = candles[i - 1];
    const c = candles[i + 1];
    // Bullish FVG: high nến trước < low nến sau
    if (a.high < c.low) {
      fvgs.push({
        type: 'BULLISH',
        top: r2(c.low),
        bottom: r2(a.high),
        midpoint: r2((c.low + a.high) / 2),
        index: i,
        time: candles[i].time,
      });
    }
    // Bearish FVG: low nến trước > high nến sau
    if (a.low > c.high) {
      fvgs.push({
        type: 'BEARISH',
        top: r2(a.low),
        bottom: r2(c.high),
        midpoint: r2((a.low + c.high) / 2),
        index: i,
        time: candles[i].time,
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
    // Bullish OB: nến giảm cuối cùng (prev) trước cú đẩy tăng mạnh
    if (bullishMove && prev.close < prev.open) {
      obs.push({ type: 'BULLISH', top: r2(prev.high), bottom: r2(prev.low), index: i - 1, time: prev.time });
    }
    // Bearish OB: nến tăng cuối cùng (prev) trước cú đẩy giảm mạnh
    if (!bullishMove && prev.close > prev.open) {
      obs.push({ type: 'BEARISH', top: r2(prev.high), bottom: r2(prev.low), index: i - 1, time: prev.time });
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

// ─── 7) LIQUIDITY: equal highs / equal lows (dung sai theo ATR) ──────────────

function findLiquidity(swings: { highs: Swing[]; lows: Swing[] }, atrValue: number): Liquidity {
  const tol = atrValue * 0.15; // dung sai để coi là "bằng nhau"
  const equalHighs: LiquidityLevel[] = [];
  const equalLows: LiquidityLevel[] = [];

  const hs = swings.highs;
  for (let i = 1; i < hs.length; i++) {
    if (Math.abs(hs[i].price - hs[i - 1].price) <= tol) {
      equalHighs.push({ price: r2((hs[i].price + hs[i - 1].price) / 2), times: [hs[i - 1].time, hs[i].time] });
    }
  }
  const ls = swings.lows;
  for (let i = 1; i < ls.length; i++) {
    if (Math.abs(ls[i].price - ls[i - 1].price) <= tol) {
      equalLows.push({ price: r2((ls[i].price + ls[i - 1].price) / 2), times: [ls[i - 1].time, ls[i].time] });
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
    swingHighs: swings.highs.slice(-5),
    swingLows: swings.lows.slice(-5),
    fvgs: findFVGs(candles).slice(-6),
    orderBlocks: findOrderBlocks(candles, atrValue).slice(-6),
    liquidity: findLiquidity(swings, atrValue),
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
