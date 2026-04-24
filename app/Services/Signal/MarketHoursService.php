<?php

declare(strict_types=1);

namespace App\Services\Signal;

use Illuminate\Support\Carbon;

/**
 * Checks whether current time falls within active trading sessions.
 *
 * For XAUUSD scalping, the most liquid periods are:
 *   London open  : 07:00–12:00 London time  (14:00–19:00 VN, UTC+7)
 *   NY open      : 13:00–17:00 NY time      (00:00–04:00 VN next day)
 *
 * The user requested 06:00–22:00 VN time (Asia/Ho_Chi_Minh, UTC+7),
 * which covers London pre-open through end of NY afternoon session.
 */
class MarketHoursService
{
    public function __construct(
        private readonly int $openHour,   // 6  (06:00 VN)
        private readonly int $closeHour,  // 22 (22:00 VN)
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

    /**
     * Returns true if the market is currently open for trading.
     */
    public function isOpen(?Carbon $at = null): bool
    {
        $now = ($at ?? now())->setTimezone($this->timezone);
        $hour = (int) $now->format('G'); // 0–23, no leading zero

        return $hour >= $this->openHour && $hour < $this->closeHour;
    }

    /**
     * Returns a human-readable status string.
     */
    public function status(?Carbon $at = null): string
    {
        $now = ($at ?? now())->setTimezone($this->timezone);

        if ($this->isOpen($now)) {
            return sprintf(
                'OPEN (%s VN)',
                $now->format('H:i')
            );
        }

        return sprintf(
            'CLOSED (%s VN — market opens at %02d:00)',
            $now->format('H:i'),
            $this->openHour
        );
    }
}
