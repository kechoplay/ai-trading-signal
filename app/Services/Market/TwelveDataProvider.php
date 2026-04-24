<?php

declare(strict_types=1);

namespace App\Services\Market;

use Illuminate\Http\Client\PendingRequest;
use Illuminate\Support\Facades\Http;
use RuntimeException;

/**
 * TwelveData REST API — https://twelvedata.com/docs
 *
 * Free plan: 800 req/day, 8 req/min.
 * For this app running every 15 min (2 req each: M5 + M15) = ~192 req/day — well within limits.
 *
 * Timeframe mapping (TwelveData interval notation):
 *   M1=1min, M5=5min, M15=15min, M30=30min, H1=1h, H4=4h, D=1day
 */
class TwelveDataProvider implements MarketDataProvider
{
    private const TIMEFRAME_MAP = [
        'M1' => '1min',
        'M5' => '5min',
        'M15' => '15min',
        'M30' => '30min',
        'H1' => '1h',
        'H4' => '4h',
        'D' => '1day',
        'W' => '1week',
    ];

    public function __construct(
        private readonly string $apiKey,
        private readonly string $baseUrl,
    ) {
    }

    public static function fromConfig(): self
    {
        $apiKey = (string) config('trading.twelvedata.api_key');

        if ($apiKey === '') {
            throw new RuntimeException('TWELVEDATA_API_KEY is not configured.');
        }

        return new self(
            apiKey: $apiKey,
            baseUrl: (string) config('trading.twelvedata.base_url'),
        );
    }

    /**
     * @return array<int, Candle>
     */
    public function fetchCandles(string $instrument, string $timeframe, int $count = 100): array
    {
        $interval = self::TIMEFRAME_MAP[$timeframe]
            ?? throw new RuntimeException("Unsupported timeframe: {$timeframe}");

        $response = $this->client()->get('/time_series', [
            'symbol' => $instrument,
            'interval' => $interval,
            'outputsize' => $count,
            'order' => 'ASC',
            'apikey' => $this->apiKey,
        ]);

        if ($response->failed()) {
            throw new RuntimeException(sprintf(
                'TwelveData request failed (%d): %s',
                $response->status(),
                $response->body()
            ));
        }

        $payload = $response->json();

        if (($payload['status'] ?? '') === 'error') {
            throw new RuntimeException('TwelveData API error: ' . ($payload['message'] ?? 'unknown'));
        }

        $values = $payload['values'] ?? [];

        if (empty($values)) {
            throw new RuntimeException("TwelveData returned no candles for {$instrument} {$timeframe}.");
        }

        return array_map(
            static fn (array $row): Candle => new Candle(
                time: (string) ($row['datetime'] ?? ''),
                open: (float) ($row['open'] ?? 0),
                high: (float) ($row['high'] ?? 0),
                low: (float) ($row['low'] ?? 0),
                close: (float) ($row['close'] ?? 0),
                volume: (int) ($row['volume'] ?? 0),
            ),
            $values
        );
    }

    public function fetchCurrentPrice(string $instrument): float
    {
        $response = $this->client()->get('/price', [
            'symbol' => $instrument,
            'apikey' => $this->apiKey,
        ]);

        if ($response->failed()) {
            throw new RuntimeException(sprintf(
                'TwelveData price request failed (%d): %s',
                $response->status(),
                $response->body()
            ));
        }

        $payload = $response->json();

        if (($payload['status'] ?? '') === 'error') {
            throw new RuntimeException('TwelveData price error: ' . ($payload['message'] ?? 'unknown'));
        }

        return (float) ($payload['price'] ?? 0);
    }

    private function client(): PendingRequest
    {
        return Http::baseUrl($this->baseUrl)
            ->acceptJson()
            ->timeout(20)
            ->retry(2, 500);
    }
}
