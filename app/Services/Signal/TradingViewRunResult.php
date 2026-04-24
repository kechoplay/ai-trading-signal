<?php

declare(strict_types=1);

namespace App\Services\Signal;

use App\Models\TradingSignal;

final class TradingViewRunResult
{
    private function __construct(
        public readonly bool $wasSkipped,
        public readonly ?string $skipReason,
        public readonly ?TradingSignal $signal,
    ) {
    }

    public static function skipped(string $reason): self
    {
        return new self(true, $reason, null);
    }

    public static function analyzed(TradingSignal $signal): self
    {
        return new self(false, null, $signal);
    }
}
