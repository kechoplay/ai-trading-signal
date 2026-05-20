export const config = {
  provider: process.env.MARKET_PROVIDER ?? 'twelvedata',

  instrument: process.env.TRADING_INSTRUMENT ?? 'XAU/USD',

  timeframes: (process.env.TRADING_TIMEFRAMES ?? 'H1,M15,M5')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),

  candlesCount: parseInt(process.env.TRADING_CANDLES_COUNT ?? '214', 10),

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

  gemini: {
    apiKey: process.env.GEMINI_API_KEY ?? '',
    model: process.env.GEMINI_MODEL ?? 'gemini-2.0-flash',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
  },

  telegram: {
    botToken: process.env.TELEGRAM_BOT_TOKEN ?? '',
    chatId: process.env.TELEGRAM_CHAT_ID ?? '',
    discussionId: process.env.TELEGRAM_DISCUSSION_ID ?? '',
    baseUrl: 'https://api.telegram.org',
  },
};
