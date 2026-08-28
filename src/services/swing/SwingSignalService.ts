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
 *     pivot một khoảng đệm ATR; TP1/2/3 = bội số R (`tpR`, mặc định 1R/2R/3R).
 *  4. Chạy tới (forward test) từng tín hiệu cũ trên chính dữ liệu nến để biết nó chạm
 *     TP hay SL → có winrate/tổng R thật thay vì chỉ liệt kê mũi tên.
 *
 * ĐỌC KỸ TRƯỚC KHI SỬA PHẦN KẾ TOÁN KẾT QUẢ:
 *  - `status` mô tả ĐƯỜNG ĐI với SL GỐC và giữ nguyên lệnh: `SL` = đã dính SL gốc (dù
 *    trước đó có chạm TP nào — xem `maxTpHit`), `TP{n}` = chạm hết tới TP cuối,
 *    `RUNNING` = chưa đóng. Bản cũ trả `TP{best}` cho cả lệnh chạm TP rồi quay về SL,
 *    tức ngầm giả định đã thoát đúng đỉnh → winrate và tổng R bị thổi phồng, và câu hỏi
 *    "có nên giữ tới TP cuối không" tự nhiên có lời giải đẹp một cách giả tạo.
 *  - `resultR` KHÔNG còn là một con số duy nhất mang tính "sự thật": nó là kết quả của
 *    LUẬT THOÁT được chọn (`exitRule`). Cả ba luật (`TP1_FULL`, `PARTIAL_BE`,
 *    `TRAIL_PIVOT`) đều chạy song song trên cùng bộ nến và nằm trong `exits` để so sánh
 *    — đây mới là cách trả lời "giữ tới TP cuối có đáng không".
 *  - `mfeR`/`maeR` (đi xa nhất / thụt lùi sâu nhất, quy ra R) và `stats.conditional`
 *    (P(TP2|TP1), P(TP3|TP1), tỉ lệ chạm TP1 rồi vẫn về SL) là số liệu để đặt luật giữ
 *    lệnh. Không có chúng thì mọi quyết định "giữ hay chốt" chỉ là cảm giác.
 *
 * CẢNH BÁO REPAINT: tín hiệu MỚI NHẤT có thể bị rút lại — nếu giá tạo pivot cùng loại
 * cực đoan hơn thì zigzag dời pivot, nhãn cũ biến mất. Tín hiệu đó được đánh dấu
 * `provisional = true`. Mọi tín hiệu phía trước đã cố định.
 *
 * CẢNH BÁO CỠ MẪU: 300 nến M5 ≈ 1,5 ngày → thường chỉ 15–30 nhịp. Winrate/tổng R ở cỡ
 * đó là backtest TRONG MẪU, và `byContext` chia nhỏ nữa thì còn vài lệnh mỗi ô. Dùng để
 * so sánh tham số, không phải kỳ vọng tương lai — muốn số liệu có nghĩa phải nâng
 * `SWING_CANDLES` lên vài nghìn nến.
 */

export type SwingDirection = 'BUY' | 'SELL';
export type SwingStatus = 'RUNNING' | 'SL' | 'TP1' | 'TP2' | 'TP3';
/** Cấu trúc thị trường tại pivot: HH/HL (thuận) hay LH/LL (ngược) so với pivot cùng loại liền trước. */
export type SwingStructure = 'WITH' | 'AGAINST' | 'UNKNOWN';

/**
 * Ba luật thoát chạy song song trên cùng dữ liệu — con số của chúng là cách duy nhất để
 * biết nên chốt sớm hay giữ, thay vì đoán từng lệnh.
 *  - `TP1_FULL`:    chốt toàn bộ tại TP1. Mốc so sánh cơ sở.
 *  - `PARTIAL_BE`:  chốt 50% tại TP1, dời SL về hòa vốn, 50% còn lại chạy tới TP cuối.
 *  - `TRAIL_PIVOT`: KHÔNG có TP cứng — dời SL theo từng pivot đối nghịch mới được xác
 *                   nhận (đáy sau cho BUY), thoát khi bị quét. Luật này đo xem "để nó
 *                   chạy" có thật sự ăn hơn không.
 */
export type ExitRuleName = 'TP1_FULL' | 'PARTIAL_BE' | 'TRAIL_PIVOT';

export const EXIT_RULES: ExitRuleName[] = ['TP1_FULL', 'PARTIAL_BE', 'TRAIL_PIVOT'];

export const EXIT_RULE_LABEL: Record<ExitRuleName, string> = {
  TP1_FULL:    'Chốt hết ở TP1',
  PARTIAL_BE:  'Chốt 50% ở TP1 + BE, phần còn lại tới TP cuối',
  TRAIL_PIVOT: 'Trailing theo pivot (không TP cứng)',
};

export interface SwingExit {
  /** Kết quả quy ra R theo luật này (SL = −1). */
  r: number;
  /** Đã đóng hẳn chưa (false = còn chạy tới nến cuối, `r` là lãi/lỗ tạm tính). */
  closed: boolean;
  /** Số nến từ lúc vào tới lúc đóng (null nếu còn chạy). */
  barsToResolve: number | null;
  /** Mô tả ngắn cách thoát: "TP1", "SL", "BE sau TP1", "trailing 4512.30". */
  note: string;
}

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
  /** HH/HL hay LH/LL so với pivot cùng loại liền trước — dùng chia nhóm trong `byContext`. */
  structure: SwingStructure;
  /** TP xa nhất giá đã CHẠM trước khi dính SL gốc (0 = chưa chạm TP nào). */
  maxTpHit: number;
  /** Đã dính SL GỐC chưa (giữ nguyên lệnh, không dời SL). */
  hitSl: boolean;
  /** Đi xa nhất bao nhiêu R theo hướng có lợi trước khi đóng (Max Favorable Excursion). */
  mfeR: number;
  /** Thụt lùi sâu nhất bao nhiêu R trước khi đóng (Max Adverse Excursion, số dương). */
  maeR: number;
  status: SwingStatus;
  /** Kết quả theo LUẬT THOÁT đang chọn (`params.exitRule`) — xem `exits` để so cả ba. */
  resultR: number;
  /** Số nến từ lúc vào tới lúc chốt theo luật đang chọn (null nếu còn chạy). */
  barsToResolve: number | null;
  /** Kết quả của cả ba luật thoát trên cùng đường giá. */
  exits: Record<ExitRuleName, SwingExit>;
  /** Tín hiệu đã ra cách đây bao nhiêu nến — 0 = vừa xuất hiện ở nến cuối. */
  barsAgo: number;
  /** True với tín hiệu cuối khi nhịp đảo chiều chưa đủ lớn → còn khả năng bị dời. */
  provisional: boolean;
}

/** Xác suất CÓ ĐIỀU KIỆN — trả lời "chạm TP1 rồi thì cửa đi tiếp bao nhiêu". */
export interface SwingConditional {
  /** Số tín hiệu đã chạm TP1. */
  reachedTp1: number;
  /** Với mỗi mốc TP2, TP3…: số lệnh chạm tới + % trong số đã chạm TP1. */
  levels: { level: number; hit: number; pctGivenTp1: number | null }[];
  /** Số lệnh chạm TP1 rồi vẫn quay về dính SL gốc (giữ nguyên lệnh = mất trắng 1R). */
  giveBack: number;
  giveBackPct: number | null;
}

export interface SwingRuleStats {
  closed: number;
  winRatePct: number | null;
  totalR: number;
  avgR: number | null;
}

export interface SwingContextBucket {
  key: string;
  n: number;
  closed: number;
  winRatePct: number | null;
  avgR: number | null;
  /** % lệnh trong nhóm chạm được TP cuối. */
  tpFinalPct: number | null;
}

export interface SwingStats {
  total: number;
  resolved: number;
  /** Số lệnh CHẠM TP1 (kể cả sau đó quay về SL). */
  hitTp1: number;
  /** Số lệnh dính SL GỐC. */
  hitSl: number;
  /** % lệnh đã đóng có R dương THEO LUẬT ĐANG CHỌN. */
  winRatePct: number | null;
  totalR: number;
  avgR: number | null;
  /** Đi xa nhất được bao nhiêu R (trung vị / trung bình) — mốc để đặt TP thực tế. */
  mfeMedianR: number | null;
  mfeAvgR: number | null;
  /** Thụt lùi sâu nhất (trung vị) — mốc để biết SL có bị đặt quá sát không. */
  maeMedianR: number | null;
  conditional: SwingConditional;
  byRule: Record<ExitRuleName, SwingRuleStats>;
  byContext: SwingContextBucket[];
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
  /** TP1/TP2/TP3 theo bội số R. */
  tpR: number[];
  atrPeriod: number;
  /** Luật thoát dùng cho `resultR`/`stats` chính. Cả ba luật vẫn luôn được tính. */
  exitRule: ExitRuleName;
}

export const DEFAULT_SWING_PARAMS: SwingParams = {
  pivotLookback: 2,
  minLegAtr: 1.0,
  slBufferAtr: 0.25,
  tpR: [1, 2, 3],
  atrPeriod: 14,
  exitRule: 'PARTIAL_BE',
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
 * Tự đo theo chính nó thì sai đơn vị: risk 2.3737 USD của vàng nhỏ hơn 100 nên bị hiển
 * thị 4 số lẻ như altcoin, trong khi entry cạnh nó chỉ có 2.
 */
function roundLike(value: number, ref: number): number {
  const f = 10 ** digitsFor(ref);
  return Math.round(value * f) / f;
}

const r2 = (n: number): number => Math.round(n * 100) / 100;

function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return r2(s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2);
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

// ─── Mô phỏng đường giá ──────────────────────────────────────────────────────

interface TradePath {
  /** Nến chạm từng TP (index tuyệt đối), null nếu chưa chạm. */
  tpBars: (number | null)[];
  /** Nến dính SL gốc, null nếu chưa. */
  slBar: number | null;
  maxTpHit: number;
  mfeR: number;
  maeR: number;
}

/**
 * Đi tới từng nến với SL GỐC, giữ nguyên lệnh — ghi lại toàn bộ đường đi để mọi luật
 * thoát và mọi thống kê đọc lại từ cùng một sự thật.
 * Nến chạm CẢ SL lẫn TP trong cùng một cây → tính SL (không có dữ liệu tick để biết cái
 * nào tới trước, nên chọn phía bi quan, tránh thổi phồng winrate). Vì thế nến dính SL
 * KHÔNG được tính vào MFE.
 */
function walkPath(
  candles: Candle[],
  from: number,
  dir: SwingDirection,
  entry: number,
  stopLoss: number,
  tps: number[],
  risk: number,
): TradePath {
  const tpBars: (number | null)[] = tps.map(() => null);
  let maxTpHit = 0;
  let mfeR = 0;
  let maeR = 0;

  for (let i = from; i < candles.length; i++) {
    const c = candles[i];
    const adverse = dir === 'BUY' ? entry - c.low : c.high - entry;
    if (adverse > 0) maeR = Math.max(maeR, adverse / risk);

    const hitSl = dir === 'BUY' ? c.low <= stopLoss : c.high >= stopLoss;
    if (hitSl) return { tpBars, slBar: i, maxTpHit, mfeR: r2(mfeR), maeR: r2(maeR) };

    const favorable = dir === 'BUY' ? c.high - entry : entry - c.low;
    if (favorable > 0) mfeR = Math.max(mfeR, favorable / risk);

    while (maxTpHit < tps.length) {
      const tp = tps[maxTpHit];
      const hit = dir === 'BUY' ? c.high >= tp : c.low <= tp;
      if (!hit) break;
      tpBars[maxTpHit] = i;
      maxTpHit++;
    }
    if (maxTpHit === tps.length) return { tpBars, slBar: null, maxTpHit, mfeR: r2(mfeR), maeR: r2(maeR) };
  }

  return { tpBars, slBar: null, maxTpHit, mfeR: r2(mfeR), maeR: r2(maeR) };
}

/** Lãi/lỗ tạm tính tại nến cuối, quy ra R. */
function openR(candles: Candle[], dir: SwingDirection, entry: number, risk: number): number {
  const last = candles[candles.length - 1];
  if (!last) return 0;
  return r2((dir === 'BUY' ? last.close - entry : entry - last.close) / risk);
}

/** Luật 1 — chốt toàn bộ tại TP1. */
function exitTp1Full(
  candles: Candle[], path: TradePath, from: number,
  dir: SwingDirection, entry: number, risk: number, tpR: number[],
): SwingExit {
  const tp1Bar = path.tpBars[0];
  if (tp1Bar != null) {
    return { r: tpR[0], closed: true, barsToResolve: tp1Bar - from + 1, note: 'TP1' };
  }
  if (path.slBar != null) {
    return { r: -1, closed: true, barsToResolve: path.slBar - from + 1, note: 'SL' };
  }
  return { r: openR(candles, dir, entry, risk), closed: false, barsToResolve: null, note: 'đang chạy' };
}

/**
 * Luật 2 — chốt 50% tại TP1, dời SL về hòa vốn, phần còn lại chạy tới TP CUỐI.
 * Phải quét lại từ sau nến chạm TP1 vì SL hòa vốn nằm TRƯỚC SL gốc (chặt hơn) nên
 * `walkPath` không nhìn thấy thời điểm nó bị quét.
 */
function exitPartialBe(
  candles: Candle[], path: TradePath, from: number,
  dir: SwingDirection, entry: number, risk: number, tps: number[], tpR: number[],
): SwingExit {
  const tp1Bar = path.tpBars[0];
  if (tp1Bar == null) {
    if (path.slBar != null) {
      return { r: -1, closed: true, barsToResolve: path.slBar - from + 1, note: 'SL trước TP1' };
    }
    return { r: openR(candles, dir, entry, risk), closed: false, barsToResolve: null, note: 'đang chạy, chưa tới TP1' };
  }
  if (tps.length === 1) {
    // Chỉ một mốc TP → TP1 chính là TP cuối, không có phần chạy tiếp.
    return { r: tpR[0], closed: true, barsToResolve: tp1Bar - from + 1, note: 'TP1 (mốc duy nhất)' };
  }

  const booked = tpR[0] / 2;               // nửa lệnh đã chốt tại TP1
  const target = tps[tps.length - 1];
  const targetR = tpR[tpR.length - 1];

  for (let i = tp1Bar + 1; i < candles.length; i++) {
    const c = candles[i];
    // Bi quan như mọi chỗ khác: cùng một nến chạm cả BE lẫn TP cuối thì tính BE.
    const hitBe = dir === 'BUY' ? c.low <= entry : c.high >= entry;
    if (hitBe) return { r: r2(booked), closed: true, barsToResolve: i - from + 1, note: 'BE sau TP1' };

    const hitTarget = dir === 'BUY' ? c.high >= target : c.low <= target;
    if (hitTarget) {
      return { r: r2(booked + targetR / 2), closed: true, barsToResolve: i - from + 1, note: `TP1 + TP${tps.length}` };
    }
  }
  return {
    r: r2(booked + openR(candles, dir, entry, risk) / 2),
    closed: false, barsToResolve: null, note: 'nửa lệnh còn chạy sau TP1',
  };
}

/**
 * Luật 3 — trailing theo pivot, KHÔNG có TP cứng.
 * SL dời lên đáy zigzag mới nhất ĐÃ ĐƯỢC XÁC NHẬN (pivot + lookback nến) trừ đệm ATR,
 * và chỉ dời theo hướng có lợi. Đây là luật "để nó chạy" — dùng để đo xem giữ lệnh có
 * thật sự ăn hơn chốt sớm không, thay vì tranh luận cảm tính.
 */
function exitTrailPivot(
  candles: Candle[], pivots: Pivot[], atr: number[], from: number, pivotIndex: number,
  dir: SwingDirection, entry: number, stopLoss: number, risk: number,
  pivotLookback: number, slBufferAtr: number,
): SwingExit {
  const wantType = dir === 'BUY' ? 'LOW' : 'HIGH';
  let stop = stopLoss;

  for (let i = from; i < candles.length; i++) {
    // Dời SL bằng các pivot đối nghịch đã xác nhận tính tới nến i (sau pivot vào lệnh).
    for (const p of pivots) {
      if (p.type !== wantType || p.index <= pivotIndex) continue;
      if (p.index + pivotLookback > i) continue;
      const buf = slBufferAtr * (atr[p.index] || 0);
      const cand = dir === 'BUY' ? p.price - buf : p.price + buf;
      stop = dir === 'BUY' ? Math.max(stop, cand) : Math.min(stop, cand);
    }

    const c = candles[i];
    const hit = dir === 'BUY' ? c.low <= stop : c.high >= stop;
    if (hit) {
      const r = r2((dir === 'BUY' ? stop - entry : entry - stop) / risk);
      return { r, closed: true, barsToResolve: i - from + 1, note: `trailing ${round(stop)}` };
    }
  }
  return { r: openR(candles, dir, entry, risk), closed: false, barsToResolve: null, note: 'đang chạy (trailing)' };
}

// ─── Engine ──────────────────────────────────────────────────────────────────

export function analyzeSwings(
  candles: Candle[],
  timeframe: string,
  currentPrice: number,
  params: SwingParams = DEFAULT_SWING_PARAMS,
): SwingReport {
  const { pivotLookback, minLegAtr, slBufferAtr, tpR, atrPeriod, exitRule } = params;
  const atr = atrSeries(candles, atrPeriod);
  const allPivots = rawPivots(candles, pivotLookback);
  const zz = zigzag(allPivots, atr, minLegAtr);
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

    const from = confirmIndex + 1;
    const path = walkPath(candles, from, dir, entry, stopLoss, tps, risk);
    const exits: Record<ExitRuleName, SwingExit> = {
      TP1_FULL:    exitTp1Full(candles, path, from, dir, entry, risk, tpR),
      PARTIAL_BE:  exitPartialBe(candles, path, from, dir, entry, risk, tps, tpR),
      TRAIL_PIVOT: exitTrailPivot(
        candles, allPivots, atr, from, p.index, dir, entry, stopLoss, risk,
        pivotLookback, slBufferAtr,
      ),
    };
    const chosen = exits[exitRule] ?? exits.PARTIAL_BE;

    const status: SwingStatus = path.slBar != null
      ? 'SL'
      : path.maxTpHit === tps.length
        ? (`TP${Math.min(path.maxTpHit, 3)}` as SwingStatus)
        : 'RUNNING';

    // Nhịp đảo chiều tính từ pivot tới cực trị hiện có — chưa đủ minLegAtr nghĩa là
    // zigzag chưa chốt pivot này, giá còn có thể phá qua và dời nhãn.
    const tail = candles.slice(p.index);
    const extreme = dir === 'BUY'
      ? Math.max(...tail.map((c) => c.high))
      : Math.min(...tail.map((c) => c.low));
    const provisional = Math.abs(extreme - p.price) < minLegAtr * atrAt;

    // Cấu trúc: so với pivot CÙNG LOẠI liền trước (zigzag xen kẽ nên cách 2 bậc).
    const prevSame = zz[k - 2];
    const structure: SwingStructure = !prevSame
      ? 'UNKNOWN'
      : dir === 'BUY'
        ? (p.price > prevSame.price ? 'WITH' : 'AGAINST')
        : (p.price < prevSame.price ? 'WITH' : 'AGAINST');

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
      structure,
      maxTpHit: path.maxTpHit,
      hitSl: path.slBar != null,
      mfeR: path.mfeR,
      maeR: path.maeR,
      status,
      resultR: chosen.r,
      barsToResolve: chosen.barsToResolve,
      exits,
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
    stats: summarize(signals, exitRule),
    params,
  };
}

// ─── Thống kê ────────────────────────────────────────────────────────────────

function ruleStats(signals: SwingSignal[], rule: ExitRuleName): SwingRuleStats {
  const closed = signals.filter((s) => s.exits[rule].closed);
  const totalR = closed.reduce((sum, s) => sum + s.exits[rule].r, 0);
  const wins = closed.filter((s) => s.exits[rule].r > 0).length;
  return {
    closed: closed.length,
    winRatePct: closed.length ? Math.round((wins / closed.length) * 100) : null,
    totalR: r2(totalR),
    avgR: closed.length ? r2(totalR / closed.length) : null,
  };
}

function bucket(key: string, signals: SwingSignal[], rule: ExitRuleName): SwingContextBucket {
  const rs = ruleStats(signals, rule);
  const tpFinal = signals.filter((s) => s.maxTpHit === s.takeProfits.length).length;
  return {
    key,
    n: signals.length,
    closed: rs.closed,
    winRatePct: rs.winRatePct,
    avgR: rs.avgR,
    tpFinalPct: signals.length ? Math.round((tpFinal / signals.length) * 100) : null,
  };
}

function summarize(signals: SwingSignal[], exitRule: ExitRuleName): SwingStats {
  const main = ruleStats(signals, exitRule);
  const hitTp1 = signals.filter((s) => s.maxTpHit >= 1).length;
  const hitSl = signals.filter((s) => s.hitSl).length;

  const tpCount = signals[0]?.takeProfits.length ?? 0;
  const levels: SwingConditional['levels'] = [];
  for (let lvl = 2; lvl <= tpCount; lvl++) {
    const hit = signals.filter((s) => s.maxTpHit >= lvl).length;
    levels.push({ level: lvl, hit, pctGivenTp1: hitTp1 ? Math.round((hit / hitTp1) * 100) : null });
  }
  const giveBack = signals.filter((s) => s.maxTpHit >= 1 && s.hitSl).length;

  const byRule = EXIT_RULES.reduce((acc, r) => {
    acc[r] = ruleStats(signals, r);
    return acc;
  }, {} as Record<ExitRuleName, SwingRuleStats>);

  // Chia nhóm bối cảnh: chỉ 2 trục rẻ tiền và đọc được ngay từ zigzag. Cỡ mẫu nhỏ nên
  // `n` luôn hiển thị kèm — dưới ~10 lệnh thì con số chỉ để tham khảo.
  const byContext: SwingContextBucket[] = [
    bucket('Nhịp lớn (≥1.5× ATR)', signals.filter((s) => s.legAtr >= 1.5), exitRule),
    bucket('Nhịp nhỏ (<1.5× ATR)', signals.filter((s) => s.legAtr < 1.5), exitRule),
    bucket('Thuận cấu trúc (HH/HL)', signals.filter((s) => s.structure === 'WITH'), exitRule),
    bucket('Ngược cấu trúc (LH/LL)', signals.filter((s) => s.structure === 'AGAINST'), exitRule),
  ].filter((b) => b.n > 0);

  return {
    total: signals.length,
    resolved: main.closed,
    hitTp1,
    hitSl,
    winRatePct: main.winRatePct,
    totalR: main.totalR,
    avgR: main.avgR,
    mfeMedianR: median(signals.map((s) => s.mfeR)),
    mfeAvgR: signals.length ? r2(signals.reduce((a, s) => a + s.mfeR, 0) / signals.length) : null,
    maeMedianR: median(signals.map((s) => s.maeR)),
    conditional: {
      reachedTp1: hitTp1,
      levels,
      giveBack,
      giveBackPct: hitTp1 ? Math.round((giveBack / hitTp1) * 100) : null,
    },
    byRule,
    byContext,
  };
}
