<?php

declare(strict_types=1);

namespace App\Services\Market;

interface MarketDataProvider
{
    /**
     * Fetch OHLCV candles for a given instrument and timeframe.
     *
     * @param  string  $instrument  Provider-specific symbol (e.g. "XAU/USD")
     * @param  string  $timeframe   Normalized timeframe: M1, M5, M15, M30, H1, H4, D
     * @param  int     $count       Number of candles to fetch
     * @return array<int, Candle>
     */
    public function fetchCandles(string $instrument, string $timeframe, int $count = 100): array;

    /**
     * Fetch the most recent close price for the instrument.
     */
    public function fetchCurrentPrice(string $instrument): float;
}
