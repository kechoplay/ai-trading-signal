export const config = {
  provider: process.env.MARKET_PROVIDER ?? 'twelvedata',

  instrument: process.env.TRADING_INSTRUMENT ?? 'XAU/USD',

  timeframes: (process.env.TRADING_TIMEFRAMES ?? 'H1,M15,M5')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),

  longtermTimeframes: (process.env.TRADING_LONGTERM_TIMEFRAMES ?? 'W,D,H4')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),

  candlesCount: parseInt(process.env.TRADING_CANDLES_COUNT ?? '214', 10),

  candlesByTf: {
    H1:  parseInt(process.env.TRADING_CANDLES_H1  ?? '214', 10),
    M15: parseInt(process.env.TRADING_CANDLES_M15 ?? '240', 10),
    M5:  parseInt(process.env.TRADING_CANDLES_M5  ?? '180', 10),
    W:   parseInt(process.env.TRADING_CANDLES_W   ?? '104', 10),
    D:   parseInt(process.env.TRADING_CANDLES_D   ?? '200', 10),
    H4:  parseInt(process.env.TRADING_CANDLES_H4  ?? '200', 10),
  },

  minRr: parseFloat(process.env.TRADING_MIN_RR ?? '2.0'),

  marketHours: {
    open: parseInt(process.env.MARKET_HOURS_OPEN ?? '6', 10),
    close: parseInt(process.env.MARKET_HOURS_CLOSE ?? '22', 10),
    timezone: process.env.MARKET_HOURS_TIMEZONE ?? 'Asia/Ho_Chi_Minh',
  },

  twelvedata: {
    apiKey: process.env.TWELVEDATA_API_KEY ?? '',
    baseUrl: process.env.TWELVEDATA_BASE_URL ?? 'https://api.twelvedata.com',
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
    apiKey: process.env.CLAUDE_API_KEY ?? '',
    model: process.env.CLAUDE_MODEL ?? 'claude-sonnet-4-6',
    // Độ sâu suy luận (low|medium|high|max). Vì code đã tính sẵn ICT facts nên
    // bài toán nhẹ đi → mặc định 'medium' để giảm latency. Hỗ trợ Sonnet 4.6 / Opus 4.x.
    effort: process.env.CLAUDE_EFFORT ?? 'medium',
    // Số nến thô gửi cho khung entry (M5 intraday / H4 longterm). Các khung còn lại
    // chỉ gửi ICT facts đã tính sẵn → input ngắn, model đọc nhanh hơn.
    rawCandles: parseInt(process.env.CLAUDE_RAW_CANDLES ?? '60', 10),
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
