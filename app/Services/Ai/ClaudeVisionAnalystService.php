<?php

declare(strict_types=1);

namespace App\Services\Ai;

use App\Services\Ai\Dto\AnalysisResult;
use Illuminate\Support\Facades\Http;
use Illuminate\Support\Facades\Log;
use RuntimeException;

/**
 * Sends TradingView chart screenshots to Claude Vision for analysis.
 * Claude "sees" the chart like a real trader would.
 */
class ClaudeVisionAnalystService
{
    public function __construct(
        private readonly string $apiKey,
        private readonly string $model,
        private readonly string $baseUrl,
        private readonly string $version,
    ) {
    }

    public static function fromConfig(): self
    {
        $apiKey = (string) config('trading.anthropic.api_key');

        if ($apiKey === '') {
            throw new RuntimeException('ANTHROPIC_API_KEY is not configured.');
        }

        return new self(
            apiKey: $apiKey,
            model: (string) config('trading.anthropic.model'),
            baseUrl: (string) config('trading.anthropic.base_url'),
            version: (string) config('trading.anthropic.version'),
        );
    }

    /**
     * Analyze TradingView chart screenshots and return a trading signal.
     *
     * @param  array<string, string>  $screenshotsByTimeframe  Keys = timeframe, values = base64 PNG
     */
    public function analyze(
        string $instrument,
        array $screenshotsByTimeframe,
        float $minRr,
        string $language = 'vi',
    ): AnalysisResult {
        $systemPrompt = $this->buildSystemPrompt($instrument, $minRr, $language);
        $userContent = $this->buildUserContent($instrument, $screenshotsByTimeframe, $minRr, $language);

        $response = Http::baseUrl($this->baseUrl)
            ->withHeaders([
                'x-api-key' => $this->apiKey,
                'anthropic-version' => $this->version,
                'content-type' => 'application/json',
            ])
            ->timeout(120)
            ->retry(2, 1000, throw: false)
            ->post('/messages', [
                'model' => $this->model,
                'max_tokens' => 1024,
                'temperature' => 0.2,
                'system' => $systemPrompt,
                'messages' => [
                    [
                        'role' => 'user',
                        'content' => $userContent,
                    ],
                ],
            ]);

        if ($response->failed()) {
            Log::error('Claude Vision API call failed', [
                'status' => $response->status(),
                'body' => $response->body(),
            ]);

            throw new RuntimeException(sprintf(
                'Claude Vision API request failed (%d): %s',
                $response->status(),
                $response->body()
            ));
        }

        $payload = $response->json();
        $text = $this->extractText($payload);
        $json = $this->extractJson($text);

        return AnalysisResult::fromAiJson($json, $payload);
    }

    private function buildSystemPrompt(string $instrument, float $minRr, string $language): string
    {
        $lang = $language === 'vi' ? 'Vietnamese' : 'English';

        return <<<PROMPT
You are a senior professional scalping trader specialized in {$instrument}.
You are given TradingView chart screenshots showing candlestick price action.

Your analysis process:
1. Look at the M15 chart FIRST to determine the higher timeframe trend/bias (bullish/bearish/neutral).
2. Look at the M5 chart for precise entry — find confluence zones: key S/R levels, BOS/CHoCH, rejection candles, engulfing, pin bars, inside bars at value areas.
3. Use visible indicators on the chart (moving averages, RSI) to confirm or filter setups.
4. Only trade WITH the M15 bias unless a very strong reversal pattern appears at a major level.
5. Set SL below/above the nearest swing with a buffer. Set TP at next significant resistance/support.
6. Minimum Risk:Reward must be {$minRr}:1. If you cannot find a clean setup meeting this criteria, output NO_TRADE.
7. If market is ranging, choppy, or at middle of range with no clear direction, output NO_TRADE.

CRITICAL OUTPUT RULES:
- Respond ONLY with a valid JSON object. No markdown, no code fences, no explanation before or after.
- `reasoning` MUST be in {$lang}, max 500 characters, mention what you saw on the charts.
- `entry`, `stop_loss`, `take_profit` must be realistic prices based on chart levels you can see.
- `confidence` is 0-100 integer reflecting setup quality.
- `trend_bias`: what M15 chart shows overall.

JSON schema (required exactly):
{"action":"BUY"|"SELL"|"NO_TRADE","entry":number|null,"stop_loss":number|null,"take_profit":number|null,"risk_reward":number|null,"confidence":integer,"trend_bias":"BULLISH"|"BEARISH"|"NEUTRAL","reasoning":"string"}
PROMPT;
    }

    /**
     * @param  array<string, string>  $screenshotsByTimeframe
     * @return array<int, array<string, mixed>>
     */
    private function buildUserContent(
        string $instrument,
        array $screenshotsByTimeframe,
        float $minRr,
        string $language,
    ): array {
        $content = [];

        $now = now()->format('Y-m-d H:i T');
        $langNote = $language === 'vi'
            ? 'Viết "reasoning" bằng tiếng Việt.'
            : 'Write "reasoning" in English.';

        // Add intro text
        $content[] = [
            'type' => 'text',
            'text' => "Instrument: {$instrument} | Time: {$now} | Min R:R: {$minRr} | {$langNote}",
        ];

        // Add each chart screenshot
        foreach ($screenshotsByTimeframe as $timeframe => $base64Png) {
            $content[] = [
                'type' => 'text',
                'text' => "=== {$timeframe} Chart ===",
            ];

            $content[] = [
                'type' => 'image',
                'source' => [
                    'type' => 'base64',
                    'media_type' => 'image/png',
                    'data' => $base64Png,
                ],
            ];
        }

        // Add final instruction
        $content[] = [
            'type' => 'text',
            'text' => 'Analyze the charts above. Return ONLY the JSON object, nothing else.',
        ];

        return $content;
    }

    private function extractText(array $payload): string
    {
        $content = $payload['content'] ?? [];
        $text = '';

        foreach ($content as $block) {
            if (($block['type'] ?? '') === 'text') {
                $text .= (string) ($block['text'] ?? '');
            }
        }

        if ($text === '') {
            throw new RuntimeException('Claude Vision returned empty text content.');
        }

        return $text;
    }

    private function extractJson(string $text): array
    {
        $trimmed = trim($text);

        if (preg_match('/```(?:json)?\s*(\{.*\})\s*```/s', $trimmed, $m) === 1) {
            $trimmed = $m[1];
        }

        $start = strpos($trimmed, '{');
        $end = strrpos($trimmed, '}');

        if ($start === false || $end === false || $end <= $start) {
            throw new RuntimeException('Claude Vision response is not valid JSON: ' . substr($text, 0, 200));
        }

        $jsonStr = substr($trimmed, $start, $end - $start + 1);

        try {
            $decoded = json_decode($jsonStr, true, 512, JSON_THROW_ON_ERROR);
        } catch (\JsonException $e) {
            throw new RuntimeException('Failed to decode Claude Vision JSON: ' . $e->getMessage());
        }

        if (! is_array($decoded)) {
            throw new RuntimeException('Claude Vision JSON is not an object.');
        }

        return $decoded;
    }
}
