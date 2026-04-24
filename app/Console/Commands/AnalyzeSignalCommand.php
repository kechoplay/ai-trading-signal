<?php

declare(strict_types=1);

namespace App\Console\Commands;

use App\Services\Signal\SignalOrchestrator;
use App\Services\Signal\TradingViewOrchestrator;
use Illuminate\Console\Command;
use Throwable;

class AnalyzeSignalCommand extends Command
{
    protected $signature = 'signal:analyze
                            {--force : Skip market-hours check and run anyway}';

    protected $description = 'Analyze XAUUSD and send a trading signal to Telegram. Uses TradingView screenshot (vision) or OHLCV API depending on MARKET_PROVIDER.';

    public function handle(): int
    {
        $provider = strtolower((string) config('trading.provider', 'twelvedata'));

        $this->info("Provider: {$provider}");

        try {
            if ($provider === 'tradingview') {
                return $this->runTradingViewMode();
            }

            return $this->runApiMode();
        } catch (Throwable $e) {
            $this->error('Analysis failed: ' . $e->getMessage());
            report($e);

            return self::FAILURE;
        }
    }

    private function runTradingViewMode(): int
    {
        $orchestrator = TradingViewOrchestrator::fromConfig();

        if ($this->option('force')) {
            $this->warn('--force: skipping market-hours check.');
        }

        $result = $this->option('force')
            ? $this->runForced($orchestrator)
            : $orchestrator->run();

        if ($result->wasSkipped) {
            $this->warn('Skipped: ' . $result->skipReason);

            return self::SUCCESS;
        }

        $signal = $result->signal;

        $this->info(sprintf(
            'Signal #%d: %s (confidence=%s) - telegram_msg=%s',
            $signal->id,
            $signal->action,
            $signal->confidence ?? 'n/a',
            $signal->telegram_message_id ?? 'not sent',
        ));

        if ($signal->isTradable()) {
            $this->line(sprintf(
                '  Entry=%s | SL=%s | TP=%s | RR=1:%s',
                $signal->entry,
                $signal->stop_loss,
                $signal->take_profit,
                $signal->risk_reward,
            ));
        }

        return self::SUCCESS;
    }

    private function runApiMode(): int
    {
        $orchestrator = SignalOrchestrator::fromConfig();
        $signal = $orchestrator->run();

        $this->info(sprintf(
            'Signal #%d: %s (confidence=%s) - telegram_msg=%s',
            $signal->id,
            $signal->action,
            $signal->confidence ?? 'n/a',
            $signal->telegram_message_id ?? 'not sent',
        ));

        if ($signal->isTradable()) {
            $this->line(sprintf(
                '  Entry=%s | SL=%s | TP=%s | RR=1:%s',
                $signal->entry,
                $signal->stop_loss,
                $signal->take_profit,
                $signal->risk_reward,
            ));
        }

        return self::SUCCESS;
    }

    /**
     * Force-run TradingViewOrchestrator even when market is closed (for testing).
     */
    private function runForced(TradingViewOrchestrator $orchestrator): \App\Services\Signal\TradingViewRunResult
    {
        // Temporarily override market hours check by calling internal run via reflection bypass:
        // Simplest approach: inject a fake "always open" market hours by calling captureAndAnalyze directly
        $chartService = \App\Services\TradingView\TradingViewChartService::fromConfig();
        $claude = \App\Services\Ai\ClaudeVisionAnalystService::fromConfig();
        $telegram = \App\Services\Telegram\TelegramNotifier::fromConfig();

        $instrument = (string) config('trading.instrument');
        $timeframes = (array) config('trading.timeframes');
        $minRr = (float) config('trading.min_rr');
        $language = (string) config('trading.language');

        $this->info('Capturing TradingView screenshots...');
        $screenshots = $chartService->captureTimeframes($timeframes);

        $this->info('Sending to Claude Vision...');
        $result = $claude->analyze($instrument, $screenshots, $minRr, $language);

        // Build signal directly
        $signal = \App\Models\TradingSignal::create([
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
            'indicators_snapshot' => ['source' => 'tradingview_screenshot_forced'],
        ]);

        try {
            $messageId = $telegram->send($telegram->formatSignal($signal));
            $signal->forceFill(['telegram_message_id' => $messageId, 'sent_at' => now()])->save();
        } catch (\Throwable $e) {
            $this->warn('Telegram send failed: ' . $e->getMessage());
        }

        return \App\Services\Signal\TradingViewRunResult::analyzed($signal);
    }
}
