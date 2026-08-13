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

  twelvedata: {
    apiKey: process.env.TWELVEDATA_API_KEY ?? '',
    baseUrl: process.env.TWELVEDATA_BASE_URL ?? 'https://api.twelvedata.com',
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
  },

  telegram: {
    botToken: process.env.TELEGRAM_BOT_TOKEN ?? '',
    chatId: process.env.TELEGRAM_CHAT_ID ?? '',
    discussionId: process.env.TELEGRAM_DISCUSSION_ID ?? '',
    baseUrl: 'https://api.telegram.org',
  },

  server: {
    port: parseInt(process.env.PORT ?? '3000', 10),
    apiKey: process.env.API_SERVER_KEY ?? '',
    get domain(): string {
      return process.env.APP_DOMAIN?.trim() || `http://localhost:${this.port}`;
    },
  },
};
