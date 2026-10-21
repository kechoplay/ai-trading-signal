import { EXIT_RULES, ExitRuleName } from '../services/swing/SwingSignalService';

/** "1,2,3" → [1,2,3]; bỏ mọi phần tử không phải số dương (rỗng → []). */
const numList = (raw: string): number[] =>
  raw.split(',').map((x) => parseFloat(x.trim())).filter((n) => Number.isFinite(n) && n > 0);

const exitRule = (raw?: string): ExitRuleName => {
  const v = (raw ?? '').trim().toUpperCase();
  return (EXIT_RULES as string[]).includes(v) ? (v as ExitRuleName) : 'PARTIAL_BE';
};

export const config = {
  provider: process.env.MARKET_PROVIDER ?? 'twelvedata',

  instrument: process.env.TRADING_INSTRUMENT ?? 'XAU/USD',

  timeframes: (process.env.TRADING_TIMEFRAMES ?? 'H1,M15,M5')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),

  // Crypto noise nhiều hơn vàng → entry tối thiểu M15 (bỏ M5). Cấu trúc ICT 4 khung:
  // D (context) → H4 (bias) → H1 (POI) → M15 (entry). Dùng khi instrument là crypto
  // và request không truyền timeframes riêng.
  cryptoTimeframes: (process.env.TRADING_CRYPTO_TIMEFRAMES ?? 'D,H4,H1,M15')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),

  candlesCount: parseInt(process.env.TRADING_CANDLES_COUNT ?? '214', 10),

  candlesByTf: {
    H1:  parseInt(process.env.TRADING_CANDLES_H1  ?? '214', 10),
    M15: parseInt(process.env.TRADING_CANDLES_M15 ?? '240', 10),
    M5:  parseInt(process.env.TRADING_CANDLES_M5  ?? '180', 10),
    M1:  parseInt(process.env.TRADING_CANDLES_M1  ?? '240', 10),
    W:   parseInt(process.env.TRADING_CANDLES_W   ?? '104', 10),
    D:   parseInt(process.env.TRADING_CANDLES_D   ?? '200', 10),
    H4:  parseInt(process.env.TRADING_CANDLES_H4  ?? '200', 10),
  },

  // Số nến tính FACTS riêng cho crypto (bộ khung D/H4/H1/M15). Tách khỏi candlesByTf
  // vì các khung H4/H1/M15 dùng chung tên với vàng nhưng cần số nến khác.
  candlesByTfCrypto: {
    D:   parseInt(process.env.TRADING_CRYPTO_CANDLES_D   ?? '90', 10),
    H4:  parseInt(process.env.TRADING_CRYPTO_CANDLES_H4  ?? '120', 10),
    H1:  parseInt(process.env.TRADING_CRYPTO_CANDLES_H1  ?? '180', 10),
    M15: parseInt(process.env.TRADING_CRYPTO_CANDLES_M15 ?? '200', 10),
  } as Record<string, number>,

  minRr: parseFloat(process.env.TRADING_MIN_RR ?? '2.0'),

  // Carry-forward: nếu lần phân tích GẦN NHẤT (cùng instrument + analysis_type) là
  // WATCHLIST và còn trong cửa sổ thời gian, nhét lại setup đó vào prompt như "setup
  // ĐANG CHỜ KIỂM CHỨNG" để AI theo dõi tiếp thay vì phân tích lại từ số 0. Đưa vào
  // dạng kiểm chứng ĐỘC LẬP (AI được toàn quyền bác bỏ) để tránh anchoring bias.
  // windowMin (watchlist) nhỏ vì scalp intraday — POI cũ quá 2h dễ lỗi thời.
  // orderWindowMin rộng hơn: lệnh đang giữ có thể sống lâu hơn, cần review giữ/thoát muộn hơn.
  carryForward: {
    enabled: (process.env.CARRY_FORWARD_WATCHLIST ?? 'true').toLowerCase() !== 'false',
    windowMin: parseInt(process.env.CARRY_FORWARD_WINDOW_MIN ?? '120', 10),
    orderWindowMin: parseInt(process.env.CARRY_FORWARD_ORDER_WINDOW_MIN ?? '240', 10),
  },

  // Ngưỡng của IctPreprocessor cho sweep / displacement (xem IctPreprocessor.ts).
  ict: {
    // Nến phá cấu trúc (hoặc nến liền trước, cùng chiều) có thân ≥ N× ATR → displacement.
    // Không đạt mà cũng không để lại FVG → BOS/CHoCH bị gắn nhãn "không displacement".
    displacementBodyAtr: parseFloat(process.env.ICT_DISPLACEMENT_BODY_ATR ?? '1.0'),
    // Sau khi body close vượt mức thanh khoản, còn bao nhiêu nến để đóng cửa quay lại
    // bên trong thì vẫn tính là SWEEP (quét rồi từ chối); quá số này → BROKEN (phá thật).
    sweepRejectBars: parseInt(process.env.ICT_SWEEP_REJECT_BARS ?? '2', 10),
    // Chỉ liệt kê sự kiện sweep xảy ra trong N nến (đã đóng) gần nhất của mỗi khung.
    sweepRecentBars: parseInt(process.env.ICT_SWEEP_RECENT_BARS ?? '24', 10),
    // Số sự kiện BOS/CHoCH gần nhất gửi vào prompt cho mỗi khung.
    structureEvents: parseInt(process.env.ICT_STRUCTURE_EVENTS ?? '3', 10),
    // Vùng retest (FVG/OB của cú phá) chỉ bị coi là HỎNG khi body close xuyên mép xa
    // QUÁ N× ATR. 0 = xuyên 1 tick cũng hỏng (hành vi cũ) — với FVG mỏng vài giá điều
    // đó hủy oan cả chuỗi chỉ vì nến đóng nhích qua mép vài cent.
    retestInvalidateAtr: parseFloat(process.env.ICT_RETEST_INVALIDATE_ATR ?? '0.25'),
    // Gộp FVG với OB (nến ngược cuối cùng trước cú đẩy) khi hai vùng cách nhau ≤ N× ATR
    // → một vùng retest dày hơn. Số âm = tắt gộp, chỉ dùng FVG (hoặc OB khi không có FVG).
    retestMergeObGapAtr: parseFloat(process.env.ICT_RETEST_MERGE_OB_GAP_ATR ?? '0.5'),
    // "ATR nền" = true range trung bình của N nến đã đóng gần nhất; FACTS in tỉ lệ
    // ATR(14) / ATR nền để prompt xét "biến động cực đoan" bằng số thay vì model ước lượng.
    atrBaselineBars: parseInt(process.env.ICT_ATR_BASELINE_BARS ?? '96', 10),
  },

  // SETUP WATCHER — kích hoạt phân tích AI theo SỰ KIỆN thay vì chỉ theo đồng hồ.
  // Job nền cơ học (KHÔNG gọi AI) mỗi intervalMin phút dò chuỗi trên khung `timeframe`:
  //   quét thanh khoản → BOS/CHoCH có displacement → giá hồi về FVG/OB do displacement tạo ra
  // Chỉ khi chuỗi tới bước RETEST mới gọi runAnalysis (trigger 'event'). Dùng chung khung
  // giờ/ngày/symbol với `scheduler`. Mỗi lần kích hoạt tốn quota như một lượt phân tích →
  // chặn bằng cooldownMin + maxPerDay.
  setupWatcher: {
    enabled: (process.env.SETUP_WATCHER_ENABLED ?? 'true').toLowerCase() !== 'false',
    // Danh sách riêng của watcher (vd XAU/USD,BTC/USD,ETH/USD) — trống → SCHEDULER_SYMBOLS
    // → TRADING_INSTRUMENT. Tách khỏi scheduler để dò thêm symbol mà không thêm lượt AI
    // theo đồng hồ. Mỗi symbol ≈ 1 request/tick + 1 request bias/giờ (xem biasCacheMin).
    symbols: (process.env.SETUP_WATCHER_SYMBOLS ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    intervalMin: parseInt(process.env.SETUP_WATCHER_INTERVAL_MIN ?? '5', 10),
    // Lùi vài giây sau mốc để provider kịp chốt nến vừa đóng.
    offsetSec: parseInt(process.env.SETUP_WATCHER_OFFSET_SEC ?? '10', 10),
    timeframe: process.env.SETUP_WATCHER_TIMEFRAME ?? 'M15',
    candles: parseInt(process.env.SETUP_WATCHER_CANDLES ?? '200', 10),
    biasTimeframe: process.env.SETUP_WATCHER_BIAS_TIMEFRAME ?? 'H1',
    // Crypto lấy bias ở H4 — khớp khung bias của prompt crypto (D/H4/H1/M15). Lọc theo H1
    // thì watcher kích hoạt cả những chuỗi mà prompt sẽ bác vì ngược bias H4 → phí quota.
    cryptoBiasTimeframe: process.env.SETUP_WATCHER_CRYPTO_BIAS_TIMEFRAME ?? 'H4',
    biasCandles: parseInt(process.env.SETUP_WATCHER_BIAS_CANDLES ?? '120', 10),
    // Bias chỉ tính trên nến ĐÃ ĐÓNG → cache tới lúc nến bias đang chạy đóng (H1 = 1
    // request/giờ). biasCacheMin chỉ dùng khi nến cuối không còn chạy (thị trường nghỉ).
    biasCacheMin: parseInt(process.env.SETUP_WATCHER_BIAS_CACHE_MIN ?? '15', 10),
    // true = hướng setup phải TRÙNG bias khung lớn (NEUTRAL cũng không kích hoạt).
    requireBias: (process.env.SETUP_WATCHER_REQUIRE_BIAS ?? 'true').toLowerCase() !== 'false',
    // Sweep phải nằm trong N nến gần nhất; BOS/CHoCH phải xảy ra ≤ M nến sau sweep.
    maxSweepAgeBars: parseInt(process.env.SETUP_WATCHER_MAX_SWEEP_AGE_BARS ?? '24', 10),
    maxBarsSweepToBreak: parseInt(process.env.SETUP_WATCHER_MAX_BARS_SWEEP_TO_BREAK ?? '12', 10),
    // Giá cách mép gần của vùng retest ≤ N× ATR (khung watcher) là coi như đang retest.
    retestProximityAtr: parseFloat(process.env.SETUP_WATCHER_RETEST_PROXIMITY_ATR ?? '0.3'),
    cooldownMin: parseInt(process.env.SETUP_WATCHER_COOLDOWN_MIN ?? '30', 10),
    // Trần lần kích hoạt AI/ngày, CHUNG mọi symbol. 0 = không giới hạn (chỉ còn cooldown +
    // mỗi chuỗi 1 lần chặn quota).
    maxPerDay: parseInt(process.env.SETUP_WATCHER_MAX_PER_DAY ?? '8', 10),
  },

  // SWING SCALP — dò điểm BUY/SELL theo từng nhịp nhỏ bằng zigzag pivot (KHÔNG dùng AI,
  // không tiêu quota). Xem src/services/swing/SwingSignalService.ts.
  // minLegAtr là núm chỉnh chính: cao → ít tín hiệu, chỉ nhịp lớn; thấp → bắt nhịp nhỏ
  // hơn nhưng nhiễu nhiều. slBufferAtr là đệm SL sau đỉnh/đáy pivot để không bị quét râu.
  swing: {
    timeframe: process.env.SWING_TIMEFRAME ?? 'M5',
    candles: parseInt(process.env.SWING_CANDLES ?? '300', 10),
    pivotLookback: parseInt(process.env.SWING_PIVOT_LOOKBACK ?? '2', 10),
    minLegAtr: parseFloat(process.env.SWING_MIN_LEG_ATR ?? '1.0'),
    slBufferAtr: parseFloat(process.env.SWING_SL_BUFFER_ATR ?? '0.25'),
    tpR: numList(process.env.SWING_TP_R ?? '1,2,3'),
    // Luật thoát dùng cho winrate/tổng R chính. Cả ba luật luôn được tính song song để
    // so sánh (xem stats.byRule) — đây là cách trả lời "giữ tới TP cuối có đáng không".
    exitRule: exitRule(process.env.SWING_EXIT_RULE),
    atrPeriod: parseInt(process.env.SWING_ATR_PERIOD ?? '14', 10),
    // Tín hiệu cũ hơn ngần này nến thì giá đã rời entry — coi như hết hiệu lực.
    staleBars: parseInt(process.env.SWING_STALE_BARS ?? '6', 10),
  },

  marketHours: {
    open: parseInt(process.env.MARKET_HOURS_OPEN ?? '6', 10),
    close: parseInt(process.env.MARKET_HOURS_CLOSE ?? '22', 10),
    timezone: process.env.MARKET_HOURS_TIMEZONE ?? 'Asia/Ho_Chi_Minh',
  },

  // Scheduler tự chạy phân tích intraday theo chu kỳ (trước đây chỉ trigger tay qua
  // API/dashboard). Mốc chạy canh theo ĐỒNG HỒ (…:00/:15/:30/:45) để phân tích ngay sau
  // khi nến M15 đóng. Múi giờ dùng chung marketHours.timezone.
  // CẢNH BÁO QUOTA: mỗi lần chạy tiêu ~50k input + ~12k output token của subscription
  // (dùng chung với session Claude Code). 15 phút × 8h–22h = 56 lần/ngày — trước khi
  // hạ intervalMin xuống nữa thì kiểm `/usage` để chắc còn hạn mức.
  scheduler: {
    enabled: (process.env.SCHEDULER_ENABLED ?? 'false').toLowerCase() === 'true',
    intervalMin: parseInt(process.env.SCHEDULER_INTERVAL_MIN ?? '15', 10),
    startHour: parseInt(process.env.SCHEDULER_START_HOUR ?? '8', 10),
    endHour: parseInt(process.env.SCHEDULER_END_HOUR ?? '22', 10),
    // 1=T2 … 5=T6 (chuẩn Date.getDay: 0=CN, 6=T7). Vàng nghỉ T7/CN nên mặc định bỏ.
    weekdays: (process.env.SCHEDULER_WEEKDAYS ?? '1,2,3,4,5')
      .split(',')
      .map((s) => parseInt(s.trim(), 10))
      .filter((n) => Number.isInteger(n) && n >= 0 && n <= 6),
    // Trống → dùng TRADING_INSTRUMENT. Nhiều symbol → chạy LẦN LƯỢT trong cùng một tick
    // (không song song, vì single-flight trong AnalysisRunner chặn chạy đồng thời).
    symbols: (process.env.SCHEDULER_SYMBOLS ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    // Lùi vài giây sau mốc nến đóng nếu provider trả nến cuối chậm.
    offsetSec: parseInt(process.env.SCHEDULER_OFFSET_SEC ?? '0', 10),
  },

  // KẾ HOẠCH NGÀY (vàng + crypto) — lịch riêng, chạy theo GIỜ (không phải phút như `scheduler`):
  // startHour, startHour+intervalHours, … ≤ endHour (mặc định 7h/11h/15h/19h, T2–T6).
  // Mỗi lượt Claude lập plan cho phần còn lại của ngày (bias D/H4/H1, bản đồ mức giá,
  // kịch bản BUY/SELL, lịch phiên) — KHÔNG ra lệnh. Lưu analysis_type='daily_plan' nên
  // không trộn vào carry-forward của intraday. Tốn quota như một lượt intraday.
  dailyPlan: {
    enabled: (process.env.DAILY_PLAN_ENABLED ?? 'true').toLowerCase() !== 'false',
    startHour: parseInt(process.env.DAILY_PLAN_START_HOUR ?? '7', 10),
    endHour: parseInt(process.env.DAILY_PLAN_END_HOUR ?? '22', 10),
    intervalHours: parseInt(process.env.DAILY_PLAN_INTERVAL_HOURS ?? '4', 10),
    weekdays: (process.env.DAILY_PLAN_WEEKDAYS ?? '1,2,3,4,5')
      .split(',')
      .map((s) => parseInt(s.trim(), 10))
      .filter((n) => Number.isInteger(n) && n >= 0 && n <= 6),
    // Vàng dùng prompt plan vàng; symbol crypto (BTC/ETH…) tự dùng prompt plan crypto
    // (LONG/SHORT, ngày UTC, funding/OI). Mỗi mốc chạy lần lượt từng symbol (~3 phút/symbol).
    symbols: (process.env.DAILY_PLAN_SYMBOLS ?? 'XAU/USD,BTC/USD,ETH/USD')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    offsetSec: parseInt(process.env.DAILY_PLAN_OFFSET_SEC ?? '30', 10),
    // Trùng mốc với scheduler intraday / SetupWatcher (single-flight) → chờ rồi thử lại
    // thay vì bỏ lượt như intraday: plan chỉ vài lượt/ngày, mất một lượt là mất nửa phiên.
    busyRetrySec: parseInt(process.env.DAILY_PLAN_BUSY_RETRY_SEC ?? '60', 10),
    busyMaxWaitMin: parseInt(process.env.DAILY_PLAN_BUSY_MAX_WAIT_MIN ?? '15', 10),
    timeframes: (process.env.DAILY_PLAN_TIMEFRAMES ?? 'D,H4,H1,M15')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    // Số nến tính FACTS riêng cho plan — H4 của intraday vàng chỉ 30 nến (context), plan
    // cần đọc cấu trúc H4/D nên lấy nhiều hơn.
    // Số này là số nến LẤY VỀ — nến cuối tuần (thị trường đóng) bị lọc bỏ sau đó, nên
    // dư ra ~30%: D 170 → ~120 ngày giao dịch, H4 160 → ~4 tuần, H1 160 → ~5 ngày.
    candlesByTf: {
      D:   parseInt(process.env.DAILY_PLAN_CANDLES_D   ?? '170', 10),
      H4:  parseInt(process.env.DAILY_PLAN_CANDLES_H4  ?? '160', 10),
      H1:  parseInt(process.env.DAILY_PLAN_CANDLES_H1  ?? '160', 10),
      M15: parseInt(process.env.DAILY_PLAN_CANDLES_M15 ?? '96', 10),
    } as Record<string, number>,
    // Range premium/discount riêng cho plan (bảng FIB_LOOKBACK_BY_TF của preprocessor chỉ
    // có H1/M15/M5 và dùng chung với crypto → D/H4 rơi về 80 nến). Khung không liệt kê
    // giữ mặc định của preprocessor.
    rangeLookbackByTf: {
      D:  parseInt(process.env.DAILY_PLAN_RANGE_LOOKBACK_D  ?? '120', 10),
      H4: parseInt(process.env.DAILY_PLAN_RANGE_LOOKBACK_H4 ?? '120', 10),
    } as Record<string, number>,
    // Lịch phiên vàng theo giờ New York (Intl tự xử lý DST):
    //  - rolloverNyHour: ngày giao dịch bắt đầu lúc 17:00 NY (04:00 VN mùa hè / 05:00 mùa
    //    đông) — PDH/PDL tính theo mốc này, KHÔNG theo nến D của TwelveData (cắt 03:00 VN
    //    và có cả nến T7/CN đi ngang).
    //  - đóng cửa cuối tuần: T6 closeFriNyHour → CN openSunNyHour.
    //  - range Á (ICT Asian range): asiaStartNyHour → asiaEndNyHour (24 = nửa đêm NY).
    session: {
      rolloverNyHour:  parseInt(process.env.DAILY_PLAN_ROLLOVER_NY_HOUR   ?? '17', 10),
      closeFriNyHour:  parseInt(process.env.DAILY_PLAN_CLOSE_FRI_NY_HOUR  ?? '17', 10),
      openSunNyHour:   parseInt(process.env.DAILY_PLAN_OPEN_SUN_NY_HOUR   ?? '18', 10),
      asiaStartNyHour: parseInt(process.env.DAILY_PLAN_ASIA_START_NY_HOUR ?? '20', 10),
      asiaEndNyHour:   parseInt(process.env.DAILY_PLAN_ASIA_END_NY_HOUR   ?? '24', 10),
    },
    // Nến thô gửi kèm theo khung (0 = chỉ facts). Plan đọc hình dạng nến D/H4/H1.
    rawCandlesByTf: {
      D:   parseInt(process.env.DAILY_PLAN_RAW_CANDLES_D   ?? '10', 10),
      H4:  parseInt(process.env.DAILY_PLAN_RAW_CANDLES_H4  ?? '18', 10),
      H1:  parseInt(process.env.DAILY_PLAN_RAW_CANDLES_H1  ?? '24', 10),
      M15: parseInt(process.env.DAILY_PLAN_RAW_CANDLES_M15 ?? '0', 10),
    } as Record<string, number>,
    // Plan trước đó (cùng symbol) trong N phút gần nhất → nhét vào prompt để cập nhật
    // kịch bản nào đã kích hoạt / vô hiệu. 300 phút: bắt được plan cách 4h, nhưng lượt
    // 7h sáng KHÔNG đọc lại plan 19h hôm trước.
    previousPlanMaxAgeMin: parseInt(process.env.DAILY_PLAN_PREVIOUS_MAX_AGE_MIN ?? '300', 10),
  },

  twelvedata: {
    apiKey: process.env.TWELVEDATA_API_KEY ?? '',
    baseUrl: process.env.TWELVEDATA_BASE_URL ?? 'https://api.twelvedata.com',
    // Trần request/phút của gói (basic = 8). Mọi request trong process đi qua một cửa
    // sổ trượt 60s — vượt thì CHỜ thay vì để TwelveData trả lỗi 429. 0 = tắt.
    maxRequestsPerMin: parseInt(process.env.TWELVEDATA_MAX_REQUESTS_PER_MIN ?? '8', 10),
  },

  // Binance Futures (perpetual) — dùng cho funding rate + open interest của cặp crypto.
  // API public, KHÔNG cần key. Fail-soft: lỗi/timeout → bỏ qua phần sentiment.
  binance: {
    futuresBaseUrl: process.env.BINANCE_FAPI_BASE_URL ?? 'https://fapi.binance.com',
    // Bật/tắt lấy futures sentiment (funding/OI/BTC context) cho phân tích crypto.
    sentimentEnabled: (process.env.CRYPTO_FUTURES_SENTIMENT ?? 'true').toLowerCase() !== 'false',
  },

  oanda: {
    token: process.env.OANDA_API_TOKEN ?? '',
    env: process.env.OANDA_ENV ?? 'practice',
    accountId: process.env.OANDA_ACCOUNT_ID ?? '',
    get baseUrl(): string {
      return this.env === 'live'
        ? 'https://api-fxtrade.oanda.com'
        : 'https://api-fxpractice.oanda.com';
    },
  },

  claude: {
    // Cách xác thực: 'apikey' (mặc định — CLAUDE_API_KEY, tính phí theo token) hoặc
    // 'subscription' (Claude Agent SDK + CLAUDE_CODE_OAUTH_TOKEN, tiêu quota Pro/Max).
    authMode: (process.env.AI_AUTH_MODE ?? 'apikey').toLowerCase(),
    apiKey: process.env.CLAUDE_API_KEY ?? '',
    // Token subscription sinh từ `claude setup-token`. Chỉ dùng khi authMode=subscription.
    oauthToken: process.env.CLAUDE_CODE_OAUTH_TOKEN ?? '',
    model: process.env.CLAUDE_MODEL ?? 'claude-sonnet-4-6',
    // Độ sâu suy luận (low|medium|high|max). Vì code đã tính sẵn ICT facts nên
    // bài toán nhẹ đi → mặc định 'medium' để giảm latency. Hỗ trợ Sonnet 4.6 / Opus 4.x.
    effort: process.env.CLAUDE_EFFORT ?? 'medium',
    // Số nến thô gửi cho khung entry (M5 intraday / H4 longterm). Các khung còn lại
    // chỉ gửi ICT facts đã tính sẵn → input ngắn, model đọc nhanh hơn.
    rawCandles: parseInt(process.env.CLAUDE_RAW_CANDLES ?? '60', 10),
    // Số nến thô cho khung entry crypto (M15) — crypto noise hơn nên gửi ít hơn.
    rawCandlesCrypto: parseInt(process.env.CLAUDE_RAW_CANDLES_CRYPTO ?? '40', 10),
    // Số nến thô gửi kèm THEO KHUNG cho phân tích intraday vàng (v3.1). Prompt v3.1
    // cần HÌNH DẠNG nến ở nhiều khung: nhóm A/B/C của H1 (hold dài), "nến M15 thân
    // lớn" cho Cổng 2.5, impulsive leg + CHoCH nội bộ M5. Khung có số > 0 → gửi nến
    // thô; H4 không liệt kê → chỉ facts (chọn vùng là đủ). Chỉ áp dụng cho vàng.
    rawCandlesByTf: {
      H1:  parseInt(process.env.CLAUDE_RAW_CANDLES_H1  ?? '40', 10),
      M15: parseInt(process.env.CLAUDE_RAW_CANDLES_M15 ?? '20', 10),
      M5:  parseInt(process.env.CLAUDE_RAW_CANDLES_M5  ?? '60', 10),
    } as Record<string, number>,
    // Nến thô H4 cho crypto — để model đếm "≥2 nến H4 xác nhận" khi đảo chiều ngược dòng D
    // dựa trên sweep-and-reject (khung entry M15 vẫn dùng rawCandlesCrypto). 0 = chỉ facts.
    rawCandlesCryptoH4: parseInt(process.env.CLAUDE_RAW_CANDLES_CRYPTO_H4 ?? '12', 10),
  },

  telegram: {
    botToken: process.env.TELEGRAM_BOT_TOKEN ?? '',
    chatId: process.env.TELEGRAM_CHAT_ID ?? '',
    discussionId: process.env.TELEGRAM_DISCUSSION_ID ?? '',
    baseUrl: 'https://api.telegram.org',
    // Kênh riêng theo symbol: "BTC/USD:-100…,ETH/USD:-100…[:discussionId]". Symbol không
    // có trong map → kênh mặc định (TELEGRAM_CHAT_ID). Không ghi discussionId → tự dò nhóm
    // discussion gắn với kênh đó (KHÔNG dùng TELEGRAM_DISCUSSION_ID — nhóm đó của kênh mặc định).
    channelsBySymbol: (process.env.TELEGRAM_CHANNELS_BY_SYMBOL ?? '')
      .split(',')
      .map((s) => s.trim().split(':').map((x) => x.trim()))
      .filter(([symbol, chatId]) => symbol && chatId)
      .reduce<Record<string, { chatId: string; discussionId: string }>>((acc, [symbol, chatId, discussionId]) => {
        acc[symbol.toUpperCase()] = { chatId, discussionId: discussionId ?? '' };
        return acc;
      }, {}),
  },

  server: {
    port: parseInt(process.env.PORT ?? '3000', 10),
    apiKey: process.env.API_SERVER_KEY ?? '',
    get domain(): string {
      return process.env.APP_DOMAIN?.trim() || `http://localhost:${this.port}`;
    },
  },
};
