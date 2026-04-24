<?php

declare(strict_types=1);

namespace App\Console\Commands;

use App\Services\Signal\SignalOrchestrator;
use Illuminate\Console\Command;
use Throwable;

class AnalyzeSignalCommand extends Command
{
    protected $signature = 'signal:analyze';

    protected $description = 'Fetch XAUUSD candles from OANDA, ask Claude to analyze, then send a signal to Telegram.';

    public function handle(): int
    {
        $this->info('Starting XAUUSD analysis...');

        try {
            $orchestrator = SignalOrchestrator::fromConfig();
            $signal = $orchestrator->run();
        } catch (Throwable $e) {
            $this->error('Analysis failed: ' . $e->getMessage());
            report($e);

            return self::FAILURE;
        }

        $this->info(sprintf(
            'Signal #%d: %s (confidence=%s) - telegram_msg=%s',
            $signal->id,
            $signal->action,
            $signal->confidence ?? 'n/a',
            $signal->telegram_message_id ?? 'not sent'
        ));

        if ($signal->isTradable()) {
            $this->line(sprintf(
                '  Entry=%s | SL=%s | TP=%s | RR=1:%s',
                $signal->entry,
                $signal->stop_loss,
                $signal->take_profit,
                $signal->risk_reward
            ));
        }

        return self::SUCCESS;
    }
}
