<?php

declare(strict_types=1);

namespace App\Models;

use Illuminate\Database\Eloquent\Factories\HasFactory;
use Illuminate\Database\Eloquent\Model;

/**
 * @property int $id
 * @property string $instrument
 * @property string $action
 * @property string|null $timeframe
 * @property float|null $entry
 * @property float|null $stop_loss
 * @property float|null $take_profit
 * @property float|null $risk_reward
 * @property int|null $confidence
 * @property float|null $current_price
 * @property string|null $reasoning
 * @property string|null $trend_bias
 * @property array|null $raw_ai_response
 * @property array|null $indicators_snapshot
 * @property string|null $telegram_message_id
 * @property \Illuminate\Support\Carbon|null $sent_at
 */
class TradingSignal extends Model
{
    use HasFactory;

    public const ACTION_BUY = 'BUY';
    public const ACTION_SELL = 'SELL';
    public const ACTION_NO_TRADE = 'NO_TRADE';

    protected $fillable = [
        'instrument',
        'action',
        'timeframe',
        'entry',
        'stop_loss',
        'take_profit',
        'risk_reward',
        'confidence',
        'current_price',
        'reasoning',
        'trend_bias',
        'raw_ai_response',
        'indicators_snapshot',
        'telegram_message_id',
        'sent_at',
    ];

    protected function casts(): array
    {
        return [
            'entry' => 'float',
            'stop_loss' => 'float',
            'take_profit' => 'float',
            'risk_reward' => 'float',
            'confidence' => 'integer',
            'current_price' => 'float',
            'raw_ai_response' => 'array',
            'indicators_snapshot' => 'array',
            'sent_at' => 'datetime',
        ];
    }

    public function isTradable(): bool
    {
        return in_array($this->action, [self::ACTION_BUY, self::ACTION_SELL], true);
    }
}
