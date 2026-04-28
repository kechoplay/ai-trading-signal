<?php

declare(strict_types=1);

namespace App\Services\Signal;

use App\Models\TradingSignal;
use App\Services\Ai\GeminiVisionAnalystService;
use App\Services\Ai\Dto\AnalysisResult;
use App\Services\Telegram\TelegramNotifier;
use App\Services\TradingView\TradingViewChartService;
use Illuminate\Support\Facades\Log;
use Throwable;

class TradingViewOrchestrator
{
    public function __construct(
        private readonly TradingViewChartService $chartService,
        private readonly GeminiVisionAnalystService $claude,
        private readonly TelegramNotifier $telegram,
        private readonly MarketHoursService $marketHours,
    ) {
    }

    public static function fromConfig(): self
    {
        return new self(
            chartService: TradingViewChartService::fromConfig(),
            claude: GeminiVisionAnalystService::fromConfig(),
            telegram: TelegramNotifier::fromConfig(),
            marketHours: MarketHoursService::fromConfig(),
        );
    }

    public function run(): TradingViewRunResult
    {
        // Check market hours first (06:00–22:00 VN)
        if (! $this->marketHours->isOpen()) {
            $status = $this->marketHours->status();
            Log::info("Signal skipped: market closed ({$status})");

            return TradingViewRunResult::skipped($status);
        }

        $instrument = (string) config('trading.instrument');
        $timeframes = (array) config('trading.timeframes');
        $minRr = (float) config('trading.min_rr');
        $language = (string) config('trading.language');

        Log::info('TradingView Vision analysis started', [
            'instrument' => $instrument,
            'timeframes' => $timeframes,
        ]);

        // Capture screenshots for each timeframe
        $screenshots = $this->chartService->captureTimeframes($timeframes);

        // Send to Claude Vision
        $result = $this->claude->analyze(
            instrument: $instrument,
            screenshotsByTimeframe: $screenshots,
            minRr: $minRr,
            language: $language,
        );

        // Save signal to DB
        $signal = $this->persistSignal($instrument, $result, $screenshots);

        // Send Telegram notification
        $this->notify($signal);

        return TradingViewRunResult::analyzed($signal);
    }

    /**
     * @param  array<string, string>  $screenshots  base64 PNGs
     */
    private function persistSignal(
        string $instrument,
        AnalysisResult $result,
        array $screenshots,
    ): TradingSignal {
        // Store only screenshot sizes, not the actual base64 (to keep DB lean)
        $screenshotMeta = [];
        foreach ($screenshots as $tf => $b64) {
            $screenshotMeta[$tf] = ['bytes' => strlen(base64_decode($b64, true) ?: '')];
        }

        return TradingSignal::create([
            'instrument' => $instrument,
            'action' => $result->action,
            'timeframe' => 'M5',
            'entry' => $result->entry,
            'stop_loss' => $result->stopLoss,
            'take_profit' => $result->takeProfit,
            'risk_reward' => $result->riskReward,
            'confidence' => $result->confidence,
            'current_price' => $result->entry,
            'reasoning' => $result->reasoning,
            'trend_bias' => $result->trendBias,
            'raw_ai_response' => $result->raw,
            'indicators_snapshot' => [
                'source' => 'tradingview_screenshot',
                'screenshots' => $screenshotMeta,
            ],
        ]);
    }

    private function notify(TradingSignal $signal): void
    {
        try {
            $message = $this->telegram->formatSignal($signal);
            $messageId = $this->telegram->send($message);

            $signal->forceFill([
                'telegram_message_id' => $messageId,
                'sent_at' => now(),
            ])->save();
        } catch (Throwable $e) {
            Log::error('Failed to send Telegram message', [
                'signal_id' => $signal->id,
                'error' => $e->getMessage(),
            ]);
        }
    }
}
