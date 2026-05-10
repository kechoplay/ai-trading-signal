<?php

declare(strict_types=1);

namespace App\Services\Signal;

use Illuminate\Support\Carbon;

class MarketHoursService
{
    public function __construct(
        private readonly int $openHour,
        private readonly int $closeHour,
        private readonly string $timezone,
    ) {
    }

    public static function fromConfig(): self
    {
        return new self(
            openHour: (int) config('trading.market_hours.open', 6),
            closeHour: (int) config('trading.market_hours.close', 22),
            timezone: (string) config('trading.market_hours.timezone', 'Asia/Ho_Chi_Minh'),
        );
    }

    public function isOpen(?Carbon $at = null): bool
    {
        $now = ($at ?? now())->setTimezone($this->timezone);

        return (int) $now->format('G') >= $this->openHour
            && (int) $now->format('G') < $this->closeHour;
    }

    public function status(?Carbon $at = null): string
    {
        $now = ($at ?? now())->setTimezone($this->timezone);

        if ($this->isOpen($now)) {
            return sprintf('OPEN (%s VN)', $now->format('H:i'));
        }

        return sprintf(
            'CLOSED (%s VN — market opens at %02d:00)',
            $now->format('H:i'),
            $this->openHour,
        );
    }
}
