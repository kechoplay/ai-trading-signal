<?php

declare(strict_types=1);

namespace App\Services\Signal;

use App\Models\TradingSignal;
use App\Services\Ai\ClaudeAnalystService;
use App\Services\Ai\Dto\AnalysisResult;
use App\Services\Market\Candle;
use App\Services\Market\MarketDataProvider;
use App\Services\Market\MarketDataProviderFactory;
use App\Services\Telegram\TelegramNotifier;
use Illuminate\Support\Facades\Log;
use Throwable;

class SignalOrchestrator
{
    public function __construct(
        private readonly MarketDataProvider $market,
        private readonly ClaudeAnalystService $claude,
        private readonly TelegramNotifier $telegram,
    ) {
    }

    public static function fromConfig(): self
    {
        return new self(
            market: MarketDataProviderFactory::make(),
            claude: ClaudeAnalystService::fromConfig(),
            telegram: TelegramNotifier::fromConfig(),
        );
    }

    public function run(): TradingSignal
    {
        $instrument = (string) config('trading.instrument');
        $timeframes = (array) config('trading.timeframes');
        $candlesCount = (int) config('trading.candles_count');
        $minRr = (float) config('trading.min_rr');
        $language = (string) config('trading.language');

        Log::info('Signal analysis started', [
            'instrument' => $instrument,
            'timeframes' => $timeframes,
            'candles_count' => $candlesCount,
        ]);

        $candlesByTf = [];
        foreach ($timeframes as $tf) {
            $candlesByTf[$tf] = $this->market->fetchCandles($instrument, $tf, $candlesCount);
        }

        $currentPrice = $this->market->fetchCurrentPrice($instrument);

        $result = $this->claude->analyze(
            instrument: $instrument,
            candlesByTimeframe: $candlesByTf,
            currentPrice: $currentPrice,
            minRr: $minRr,
            language: $language,
        );

        $signal = $this->persistSignal($instrument, $currentPrice, $result, $candlesByTf);

        $this->notify($signal);

        return $signal;
    }

    /**
     * @param  array<string, array<int, Candle>>  $candlesByTf
     */
    private function persistSignal(
        string $instrument,
        float $currentPrice,
        AnalysisResult $result,
        array $candlesByTf,
    ): TradingSignal {
        $lastByTf = [];
        foreach ($candlesByTf as $tf => $candles) {
            $last = end($candles);
            if ($last instanceof Candle) {
                $lastByTf[$tf] = $last->toArray();
            }
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
            'current_price' => $currentPrice,
            'reasoning' => $result->reasoning,
            'trend_bias' => $result->trendBias,
            'raw_ai_response' => $result->raw,
            'indicators_snapshot' => [
                'last_candles' => $lastByTf,
                'price' => $currentPrice,
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
