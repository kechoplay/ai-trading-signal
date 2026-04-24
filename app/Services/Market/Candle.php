<?php

declare(strict_types=1);

namespace App\Services\Market;

final class Candle
{
    public function __construct(
        public readonly string $time,
        public readonly float $open,
        public readonly float $high,
        public readonly float $low,
        public readonly float $close,
        public readonly int $volume,
    ) {
    }

    public function toArray(): array
    {
        return [
            't' => $this->time,
            'o' => $this->open,
            'h' => $this->high,
            'l' => $this->low,
            'c' => $this->close,
            'v' => $this->volume,
        ];
    }
}
