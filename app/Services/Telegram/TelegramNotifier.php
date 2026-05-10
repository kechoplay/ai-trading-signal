<?php

declare(strict_types=1);

namespace App\Services\Telegram;

use App\Models\TradingSignal;
use Illuminate\Support\Facades\Http;
use Illuminate\Support\Facades\Log;
use RuntimeException;

class TelegramNotifier
{
    private const MAX_LENGTH = 4000;

    public function __construct(
        private readonly string $botToken,
        private readonly string $chatId,
        private readonly string $baseUrl,
    ) {
    }

    public static function fromConfig(): self
    {
        $botToken = (string) config('trading.telegram.bot_token');
        $chatId   = (string) config('trading.telegram.chat_id');

        if ($botToken === '' || $chatId === '') {
            throw new RuntimeException('TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID is not configured.');
        }

        return new self(
            botToken: $botToken,
            chatId: $chatId,
            baseUrl: (string) config('trading.telegram.base_url'),
        );
    }

    /**
     * Send a message, splitting into multiple parts if it exceeds Telegram's limit.
     * Returns the message_id of the first part.
     */
    public function send(string $message): ?string
    {
        $parts = $this->splitMessage($message);
        $firstId = null;

        foreach ($parts as $part) {
            $id = $this->sendPart($part);
            $firstId ??= $id;
        }

        return $firstId;
    }

    public function formatSignal(TradingSignal $signal): string
    {
        $instrument = e($signal->instrument);
        $time       = optional($signal->created_at)->format('d/m/Y H:i') . ' (VN)';

        $actionEmoji = match ($signal->action) {
            TradingSignal::ACTION_BUY  => '🟢 BUY',
            TradingSignal::ACTION_SELL => '🔴 SELL',
            default                    => '⚪ NO TRADE',
        };

        $lines   = [];
        $lines[] = "📊 <b>{$instrument} — {$actionEmoji}</b>";
        $lines[] = "🕐 <b>Thời gian:</b> {$time}";

        if ($signal->current_price !== null) {
            $lines[] = "💵 <b>Giá hiện tại:</b> " . number_format((float) $signal->current_price, 3);
        }

        if ($signal->trend_bias !== null) {
            $biasLabel = match (strtoupper($signal->trend_bias)) {
                'BULLISH' => '📈 Tăng',
                'BEARISH' => '📉 Giảm',
                default   => '➖ Trung tính',
            };
            $lines[] = "📐 <b>Xu hướng:</b> {$biasLabel}";
        }

        if ($signal->isTradable()) {
            $lines[] = '';
            $lines[] = "🎯 <b>Entry:</b> "     . number_format((float) $signal->entry, 3);
            $lines[] = "🛡 <b>Stop Loss:</b> " . number_format((float) $signal->stop_loss, 3);
            $lines[] = "💰 <b>Take Profit:</b> " . number_format((float) $signal->take_profit, 3);

            if ($signal->risk_reward !== null) {
                $lines[] = "⚖️ <b>R:R</b> = 1:" . number_format((float) $signal->risk_reward, 2);
            }
        }

        if ($signal->confidence !== null) {
            $lines[] = "🔎 <b>Độ tin cậy:</b> {$signal->confidence}/100";
        }

        // Append full markdown analysis
        if (! empty($signal->reasoning)) {
            $lines[] = '';
            $lines[] = '─────────────────────────';
            $lines[] = $signal->reasoning;
        }

        $lines[] = '';
        $lines[] = '<i>⚠️ Tín hiệu tham khảo từ AI, không phải lời khuyên đầu tư.</i>';

        return implode("\n", $lines);
    }

    // ─── private ──────────────────────────────────────────────────────────────

    private function sendPart(string $text): ?string
    {
        $url = sprintf('%s/bot%s/sendMessage', rtrim($this->baseUrl, '/'), $this->botToken);

        $response = Http::asJson()
            ->timeout(20)
            ->retry(2, 500, throw: false)
            ->post($url, [
                'chat_id'                  => $this->chatId,
                'text'                     => $text,
                'parse_mode'               => 'HTML',
                'disable_web_page_preview' => true,
            ]);

        if ($response->failed()) {
            Log::error('Telegram sendMessage failed', [
                'status' => $response->status(),
                'body'   => $response->body(),
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

    /**
     * Split a long message at paragraph boundaries, keeping each part under MAX_LENGTH.
     *
     * @return array<int, string>
     */
    private function splitMessage(string $message): array
    {
        if (mb_strlen($message) <= self::MAX_LENGTH) {
            return [$message];
        }

        $parts      = [];
        $paragraphs = preg_split('/\n{2,}/', $message) ?: [$message];
        $current    = '';

        foreach ($paragraphs as $paragraph) {
            $candidate = $current === ''
                ? $paragraph
                : $current . "\n\n" . $paragraph;

            if (mb_strlen($candidate) <= self::MAX_LENGTH) {
                $current = $candidate;
            } else {
                if ($current !== '') {
                    $parts[] = $current;
                }
                // If a single paragraph itself is too long, hard-split it
                if (mb_strlen($paragraph) > self::MAX_LENGTH) {
                    foreach (str_split($paragraph, self::MAX_LENGTH) as $chunk) {
                        $parts[] = $chunk;
                    }
                    $current = '';
                } else {
                    $current = $paragraph;
                }
            }
        }

        if ($current !== '') {
            $parts[] = $current;
        }

        return $parts;
    }
}
