<?php

declare(strict_types=1);

namespace App\Services\Market;

use RuntimeException;

class MarketDataProviderFactory
{
    public static function make(): MarketDataProvider
    {
        $provider = strtolower((string) config('trading.provider', 'twelvedata'));

        return match ($provider) {
            'oanda' => OandaProvider::fromConfig(),
            'twelvedata' => TwelveDataProvider::fromConfig(),
            default => throw new RuntimeException(
                "Unknown market data provider: \"{$provider}\". Supported: oanda, twelvedata."
            ),
        };
    }
}
