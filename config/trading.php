<?php

declare(strict_types=1);

return [

    /*
    |--------------------------------------------------------------------------
    | Market Data Provider
    |--------------------------------------------------------------------------
    | Supported: "twelvedata", "oanda"
    */

    'provider' => env('MARKET_PROVIDER', 'twelvedata'),

    /*
    |--------------------------------------------------------------------------
    | Trading Instrument & Timeframes
    |--------------------------------------------------------------------------
    | instrument: symbol used by your chosen provider
    |   - TwelveData : "XAU/USD"
    |   - OANDA      : "XAU_USD"
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
    | TwelveData API
    |--------------------------------------------------------------------------
    | Sign up free at https://twelvedata.com — 800 req/day, no credit card.
    */

    'twelvedata' => [
        'api_key' => env('TWELVEDATA_API_KEY'),
        'base_url' => env('TWELVEDATA_BASE_URL', 'https://api.twelvedata.com'),
    ],

    /*
    |--------------------------------------------------------------------------
    | OANDA API (optional — use if you have a practice account)
    |--------------------------------------------------------------------------
    | Environments: practice | live
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
    */

    'anthropic' => [
        'api_key' => env('ANTHROPIC_API_KEY'),
        'model' => env('ANTHROPIC_MODEL', 'claude-sonnet-4-5-20250929'),
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
