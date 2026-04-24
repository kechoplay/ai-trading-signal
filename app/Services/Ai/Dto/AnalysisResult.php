<?php

declare(strict_types=1);

namespace App\Services\Ai\Dto;

use App\Models\TradingSignal;

final class AnalysisResult
{
    public function __construct(
        public readonly string $action,
        public readonly ?float $entry,
        public readonly ?float $stopLoss,
        public readonly ?float $takeProfit,
        public readonly ?float $riskReward,
        public readonly ?int $confidence,
        public readonly ?string $trendBias,
        public readonly ?string $reasoning,
        public readonly array $raw = [],
    ) {
    }

    public static function fromAiJson(array $data, array $rawResponse = []): self
    {
        $action = strtoupper((string) ($data['action'] ?? 'NO_TRADE'));

        if (! in_array($action, [TradingSignal::ACTION_BUY, TradingSignal::ACTION_SELL, TradingSignal::ACTION_NO_TRADE], true)) {
            $action = TradingSignal::ACTION_NO_TRADE;
        }

        return new self(
            action: $action,
            entry: isset($data['entry']) ? (float) $data['entry'] : null,
            stopLoss: isset($data['stop_loss']) ? (float) $data['stop_loss'] : null,
            takeProfit: isset($data['take_profit']) ? (float) $data['take_profit'] : null,
            riskReward: isset($data['risk_reward']) ? (float) $data['risk_reward'] : null,
            confidence: isset($data['confidence']) ? max(0, min(100, (int) $data['confidence'])) : null,
            trendBias: isset($data['trend_bias']) ? (string) $data['trend_bias'] : null,
            reasoning: isset($data['reasoning']) ? (string) $data['reasoning'] : null,
            raw: $rawResponse,
        );
    }

    public function isTradable(): bool
    {
        return in_array($this->action, [TradingSignal::ACTION_BUY, TradingSignal::ACTION_SELL], true);
    }
}
