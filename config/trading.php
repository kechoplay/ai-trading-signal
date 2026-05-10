<?php

declare(strict_types=1);

return [

    /*
    |--------------------------------------------------------------------------
    | Market Data Provider
    |--------------------------------------------------------------------------
    | Supported: "twelvedata", "oanda"
    |
    | "twelvedata" — fetches OHLCV candles via REST API (free 800 req/day).
    | "oanda"      — fetches OHLCV candles via OANDA REST v3 (requires account).
    */

    'provider' => env('MARKET_PROVIDER', 'twelvedata'),

    /*
    |--------------------------------------------------------------------------
    | Trading Instrument
    |--------------------------------------------------------------------------
    | Format depends on provider:
    |   twelvedata : "XAU/USD"
    |   oanda      : "XAU_USD"
    */

    'instrument' => env('TRADING_INSTRUMENT', 'XAU/USD'),

    'timeframes' => array_filter(array_map(
        'trim',
        explode(',', (string) env('TRADING_TIMEFRAMES', 'M5,M15'))
    )),

    'candles_count' => (int) env('TRADING_CANDLES_COUNT', 100),

    'min_rr' => (float) env('TRADING_MIN_RR', 2.0),

    'language' => env('TRADING_LANGUAGE', 'vi'),

    /*
    |--------------------------------------------------------------------------
    | Market Hours (skip analysis when market closed)
    |--------------------------------------------------------------------------
    | open / close: hour in 24h format, in the specified timezone.
    | Default: 06:00–22:00 Asia/Ho_Chi_Minh (covers London pre-open → NY close)
    | Override with --force to bypass.
    */

    'market_hours' => [
        'open'     => (int) env('MARKET_HOURS_OPEN', 6),
        'close'    => (int) env('MARKET_HOURS_CLOSE', 22),
        'timezone' => env('MARKET_HOURS_TIMEZONE', 'Asia/Ho_Chi_Minh'),
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
    | Google Gemini
    |--------------------------------------------------------------------------
    | Đăng ký API key miễn phí tại: https://aistudio.google.com
    |
    | gemini-2.0-flash (mặc định): miễn phí, 1500 req/ngày
    | gemini-1.5-pro             : chất lượng cao hơn, 50 req/ngày (free)
    */

    'gemini' => [
        'api_key' => env('GEMINI_API_KEY', ''),
        'model' => env('GEMINI_MODEL', 'gemini-2.0-flash'),
        'base_url' => 'https://generativelanguage.googleapis.com/v1beta',
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
