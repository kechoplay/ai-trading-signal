<?php

declare(strict_types=1);

namespace App\Services\Telegram;

use App\Models\TradingSignal;
use Illuminate\Support\Facades\Http;
use Illuminate\Support\Facades\Log;
use RuntimeException;

class TelegramNotifier
{
    public function __construct(
        private readonly string $botToken,
        private readonly string $chatId,
        private readonly string $baseUrl,
    ) {
    }

    public static function fromConfig(): self
    {
        $botToken = (string) config('trading.telegram.bot_token');
        $chatId = (string) config('trading.telegram.chat_id');

        if ($botToken === '' || $chatId === '') {
            throw new RuntimeException('TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID is not configured.');
        }

        return new self(
            botToken: $botToken,
            chatId: $chatId,
            baseUrl: (string) config('trading.telegram.base_url'),
        );
    }

    public function send(string $message): ?string
    {
        $url = sprintf('%s/bot%s/sendMessage', rtrim($this->baseUrl, '/'), $this->botToken);

        $response = Http::asJson()
            ->timeout(20)
            ->retry(2, 500, throw: false)
            ->post($url, [
                'chat_id' => $this->chatId,
                'text' => $message,
                'parse_mode' => 'HTML',
                'disable_web_page_preview' => true,
            ]);

        if ($response->failed()) {
            Log::error('Telegram sendMessage failed', [
                'status' => $response->status(),
                'body' => $response->body(),
            ]);

            throw new RuntimeException(sprintf(
                'Telegram sendMessage failed (%d): %s',
                $response->status(),
                $response->body()
            ));
        }

        $messageId = data_get($response->json(), 'result.message_id');

        return $messageId === null ? null : (string) $messageId;
    }

    public function formatSignal(TradingSignal $signal): string
    {
        $instrument = e($signal->instrument);
        $time = optional($signal->created_at)->format('Y-m-d H:i') . ' ' . config('app.timezone');

        $actionEmoji = match ($signal->action) {
            TradingSignal::ACTION_BUY => '🟢 BUY',
            TradingSignal::ACTION_SELL => '🔴 SELL',
            default => '⚪ NO TRADE',
        };

        $lines = [];
        $lines[] = "<b>📊 XAUUSD Signal</b>";
        $lines[] = "<b>Thời gian:</b> {$time}";
        $lines[] = "<b>Cặp:</b> {$instrument}";
        $lines[] = "<b>Hành động:</b> <b>{$actionEmoji}</b>";

        if ($signal->current_price !== null) {
            $lines[] = "<b>Giá hiện tại:</b> " . number_format((float) $signal->current_price, 3);
        }

        if ($signal->trend_bias !== null) {
            $biasLabel = match (strtoupper($signal->trend_bias)) {
                'BULLISH' => '📈 Tăng',
                'BEARISH' => '📉 Giảm',
                default => '➖ Trung tính',
            };
            $lines[] = "<b>Xu hướng M15:</b> {$biasLabel}";
        }

        if ($signal->isTradable()) {
            $lines[] = '';
            $lines[] = "🎯 <b>Entry:</b> " . number_format((float) $signal->entry, 3);
            $lines[] = "🛡 <b>Stop Loss:</b> " . number_format((float) $signal->stop_loss, 3);
            $lines[] = "💰 <b>Take Profit:</b> " . number_format((float) $signal->take_profit, 3);

            if ($signal->risk_reward !== null) {
                $lines[] = "⚖️ <b>R:R</b> = 1:" . number_format((float) $signal->risk_reward, 2);
            }
        }

        if ($signal->confidence !== null) {
            $lines[] = "🔎 <b>Độ tin cậy:</b> {$signal->confidence}/100";
        }

        if (! empty($signal->reasoning)) {
            $lines[] = '';
            $lines[] = '<b>📝 Phân tích:</b>';
            $lines[] = e($signal->reasoning);
        }

        $lines[] = '';
        $lines[] = '<i>⚠️ Đây là tín hiệu tham khảo từ AI, không phải lời khuyên đầu tư. Hãy tự chịu trách nhiệm với giao dịch của mình.</i>';

        return implode("\n", $lines);
    }
}
