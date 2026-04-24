<?php

declare(strict_types=1);

return [

    /*
    |--------------------------------------------------------------------------
    | Market Data Provider
    |--------------------------------------------------------------------------
    | Supported: "tradingview", "twelvedata", "oanda"
    |
    | "tradingview" — captures screenshots via headless browser, sends to Claude Vision.
    |                 No API key needed for market data. Requires Node.js + puppeteer.
    | "twelvedata"  — fetches OHLCV candles via REST API (free 800 req/day).
    | "oanda"       — fetches OHLCV candles via OANDA REST v3 (requires account).
    */

    'provider' => env('MARKET_PROVIDER', 'tradingview'),

    /*
    |--------------------------------------------------------------------------
    | Trading Instrument
    |--------------------------------------------------------------------------
    | Format depends on your chosen provider:
    |   tradingview : "OANDA:XAUUSD"  (symbol shown on TradingView)
    |   twelvedata  : "XAU/USD"
    |   oanda       : "XAU_USD"
    */

    'instrument' => env('TRADING_INSTRUMENT', 'OANDA:XAUUSD'),

    'timeframes' => array_filter(array_map(
        'trim',
        explode(',', (string) env('TRADING_TIMEFRAMES', 'M5,M15'))
    )),

    'candles_count' => (int) env('TRADING_CANDLES_COUNT', 100),

    'min_rr' => (float) env('TRADING_MIN_RR', 2.0),

    'language' => env('TRADING_LANGUAGE', 'vi'),

    /*
    |--------------------------------------------------------------------------
    | Market Hours (for TradingView mode — skips analysis when market closed)
    |--------------------------------------------------------------------------
    | open / close: hour in 24h format, in the specified timezone.
    | Default: 06:00–22:00 Asia/Ho_Chi_Minh (covers London pre-open → NY close)
    */

    'market_hours' => [
        'open' => (int) env('MARKET_HOURS_OPEN', 6),
        'close' => (int) env('MARKET_HOURS_CLOSE', 22),
        'timezone' => env('MARKET_HOURS_TIMEZONE', 'Asia/Ho_Chi_Minh'),
    ],

    /*
    |--------------------------------------------------------------------------
    | TradingView Screenshot Config
    |--------------------------------------------------------------------------
    | symbol   : TradingView symbol (e.g. "OANDA:XAUUSD", "CAPITALCOM:GOLD")
    | theme    : "dark" | "light"
    | width/height : screenshot resolution (recommend 1280×720 for token savings)
    | wait_ms  : milliseconds to wait for chart to fully render (3000–6000)
    | node_binary / npm_binary : leave empty to auto-detect from PATH
    */

    'tradingview' => [
        'symbol' => env('TV_SYMBOL', 'OANDA:XAUUSD'),
        'theme' => env('TV_THEME', 'dark'),
        'timezone' => env('TV_TIMEZONE', 'Asia/Ho_Chi_Minh'),
        'width' => (int) env('TV_WIDTH', 1280),
        'height' => (int) env('TV_HEIGHT', 720),
        'wait_ms' => (int) env('TV_WAIT_MS', 5000),
        'node_binary' => env('TV_NODE_BINARY', ''),
        'npm_binary' => env('TV_NPM_BINARY', ''),
    ],

    /*
    |--------------------------------------------------------------------------
    | TwelveData API
    |--------------------------------------------------------------------------
    | Sign up free: https://twelvedata.com — 800 req/day, no credit card.
    */

    'twelvedata' => [
        'api_key' => env('TWELVEDATA_API_KEY'),
        'base_url' => env('TWELVEDATA_BASE_URL', 'https://api.twelvedata.com'),
    ],

    /*
    |--------------------------------------------------------------------------
    | OANDA API (optional)
    |--------------------------------------------------------------------------
    */

    'oanda' => [
        'env' => env('OANDA_ENV', 'practice'),
        'token' => env('OANDA_API_TOKEN'),
        'account_id' => env('OANDA_ACCOUNT_ID'),
        'base_url' => env('OANDA_ENV', 'practice') === 'live'
            ? 'https://api-fxtrade.oanda.com'
            : 'https://api-fxpractice.oanda.com',
    ],

    /*
    |--------------------------------------------------------------------------
    | Anthropic Claude
    |--------------------------------------------------------------------------
    | For TradingView vision mode, claude-haiku is cheaper (10x less than sonnet).
    | For OHLCV text mode, sonnet gives better analysis.
    */

    'anthropic' => [
        'api_key' => env('ANTHROPIC_API_KEY'),
        'model' => env('ANTHROPIC_MODEL', 'claude-haiku-4-5'),
        'base_url' => 'https://api.anthropic.com/v1',
        'version' => '2023-06-01',
    ],

    /*
    |--------------------------------------------------------------------------
    | Telegram
    |--------------------------------------------------------------------------
    */

    'telegram' => [
        'bot_token' => env('TELEGRAM_BOT_TOKEN'),
        'chat_id' => env('TELEGRAM_CHAT_ID'),
        'base_url' => 'https://api.telegram.org',
    ],

];
