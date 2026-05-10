<?php

declare(strict_types=1);

namespace App\Console\Commands;

use App\Services\Signal\MarketHoursService;
use App\Services\Signal\SignalOrchestrator;
use Illuminate\Console\Command;
use Throwable;

class AnalyzeSignalCommand extends Command
{
    protected $signature = 'signal:analyze
                            {--force : Skip market-hours check and run anyway}';

    protected $description = 'Fetch XAUUSD candles from TwelveData, analyze with Gemini AI, and send signal to Telegram.';

    public function handle(): int
    {
        if (! $this->option('force')) {
            $marketHours = MarketHoursService::fromConfig();

            if (! $marketHours->isOpen()) {
                $this->warn('Skipped: ' . $marketHours->status());

                return self::SUCCESS;
            }
        }

        try {
            $signal = SignalOrchestrator::fromConfig()->run();

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
        } catch (Throwable $e) {
            $this->error('Analysis failed: ' . $e->getMessage());
            report($e);

            return self::FAILURE;
        }
    }
}
