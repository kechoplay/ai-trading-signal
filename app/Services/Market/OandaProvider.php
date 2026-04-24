<?php

declare(strict_types=1);

namespace App\Services\Market;

use Illuminate\Http\Client\PendingRequest;
use Illuminate\Support\Facades\Http;
use RuntimeException;

/**
 * OANDA REST v3 — https://developer.oanda.com/rest-live-v20/instrument-ep/
 *
 * Timeframe mapping (OANDA granularity):
 *   M1=M1, M5=M5, M15=M15, M30=M30, H1=H1, H4=H4, D=D
 */
class OandaProvider implements MarketDataProvider
{
    private const TIMEFRAME_MAP = [
        'M1' => 'M1',
        'M5' => 'M5',
        'M15' => 'M15',
        'M30' => 'M30',
        'H1' => 'H1',
        'H4' => 'H4',
        'D' => 'D',
        'W' => 'W',
    ];

    public function __construct(
        private readonly string $token,
        private readonly string $baseUrl,
    ) {
    }

    public static function fromConfig(): self
    {
        $token = (string) config('trading.oanda.token');

        if ($token === '') {
            throw new RuntimeException('OANDA_API_TOKEN is not configured.');
        }

        return new self(
            token: $token,
            baseUrl: (string) config('trading.oanda.base_url'),
        );
    }

    /**
     * @return array<int, Candle>
     */
    public function fetchCandles(string $instrument, string $timeframe, int $count = 100): array
    {
        $granularity = self::TIMEFRAME_MAP[$timeframe]
            ?? throw new RuntimeException("Unsupported timeframe: {$timeframe}");

        $response = $this->client()
            ->get("/v3/instruments/{$instrument}/candles", [
                'granularity' => $granularity,
                'count' => $count,
                'price' => 'M',
            ]);

        if ($response->failed()) {
            throw new RuntimeException(sprintf(
                'OANDA candles request failed (%d): %s',
                $response->status(),
                $response->body()
            ));
        }

        $raw = $response->json('candles') ?? [];

        return array_map(static function (array $item): Candle {
            $mid = $item['mid'] ?? [];

            return new Candle(
                time: (string) ($item['time'] ?? ''),
                open: (float) ($mid['o'] ?? 0),
                high: (float) ($mid['h'] ?? 0),
                low: (float) ($mid['l'] ?? 0),
                close: (float) ($mid['c'] ?? 0),
                volume: (int) ($item['volume'] ?? 0),
            );
        }, $raw);
    }

    public function fetchCurrentPrice(string $instrument): float
    {
        $candles = $this->fetchCandles($instrument, 'M1', 1);

        if ($candles === []) {
            throw new RuntimeException('Could not fetch current price from OANDA.');
        }

        return end($candles)->close;
    }

    private function client(): PendingRequest
    {
        return Http::baseUrl($this->baseUrl)
            ->withToken($this->token)
            ->acceptJson()
            ->timeout(20)
            ->retry(2, 500);
    }
}
