<?php

declare(strict_types=1);

namespace App\Services\Ai;

use App\Services\Ai\Dto\AnalysisResult;
use App\Services\Market\Candle;
use Illuminate\Support\Facades\Http;
use Illuminate\Support\Facades\Log;
use RuntimeException;

class ClaudeAnalystService
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
     * Ask Claude to analyze candles and return a structured signal.
     *
     * @param  array<string, array<int, Candle>>  $candlesByTimeframe  e.g. ['M5' => [...], 'M15' => [...]]
     */
    public function analyze(
        string $instrument,
        array $candlesByTimeframe,
        float $currentPrice,
        float $minRr,
        string $language = 'vi',
    ): AnalysisResult {
        $userPrompt = $this->buildUserPrompt($instrument, $candlesByTimeframe, $currentPrice, $minRr, $language);
        $systemPrompt = $this->buildSystemPrompt($instrument, $minRr, $language);

        $response = Http::baseUrl($this->baseUrl)
            ->withHeaders([
                'x-api-key' => $this->apiKey,
                'anthropic-version' => $this->version,
                'content-type' => 'application/json',
            ])
            ->timeout(90)
            ->retry(2, 1000, throw: false)
            ->post('/messages', [
                'model' => $this->model,
                'max_tokens' => 2048,
                'temperature' => 0.2,
                'system' => $systemPrompt,
                'messages' => [
                    [
                        'role' => 'user',
                        'content' => $userPrompt,
                    ],
                ],
            ]);

        if ($response->failed()) {
            Log::error('Claude API call failed', [
                'status' => $response->status(),
                'body' => $response->body(),
            ]);

            throw new RuntimeException(sprintf(
                'Claude API request failed (%d): %s',
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
        $lang = $language === 'vi'
            ? 'Vietnamese'
            : 'English';

        return <<<PROMPT
You are a senior professional scalping trader specialized in {$instrument} on OANDA.
You analyze multi-timeframe price action (M5 and M15) to produce high-probability scalp setups.

Your analysis principles:
- Identify the higher timeframe (M15) trend/bias first, then look for entries on M5.
- Use market structure (HH/HL vs LH/LL), swing points, support/resistance, liquidity.
- Apply indicators that can be inferred from OHLCV: EMA 20/50, recent range, ATR (approx via high-low), RSI-style momentum.
- Prefer trading with the M15 bias unless a clear M5 reversal setup exists at strong level.
- Set SL beyond the most recent swing with a small buffer. Set TP respecting structure and minimum Risk:Reward of {$minRr}.
- If market is ranging, choppy, or unclear, output action = "NO_TRADE".
- NEVER invent data. Use only the candles provided.

CRITICAL OUTPUT RULES:
- Respond with ONE valid minified JSON object and NOTHING else. No markdown, no code fences, no prose.
- The `reasoning` field MUST be written in {$lang}, concise (max ~500 chars).
- All prices MUST be numbers (not strings), formatted with the same precision as the input candles.
- `confidence` is an integer from 0 to 100 reflecting setup quality.
- `risk_reward` is computed as |TP - Entry| / |Entry - SL|.

Required JSON schema:
{
  "action": "BUY" | "SELL" | "NO_TRADE",
  "entry": number | null,
  "stop_loss": number | null,
  "take_profit": number | null,
  "risk_reward": number | null,
  "confidence": number,
  "trend_bias": "BULLISH" | "BEARISH" | "NEUTRAL",
  "reasoning": "string"
}
PROMPT;
    }

    /**
     * @param  array<string, array<int, Candle>>  $candlesByTimeframe
     */
    private function buildUserPrompt(
        string $instrument,
        array $candlesByTimeframe,
        float $currentPrice,
        float $minRr,
        string $language,
    ): string {
        $now = now()->toIso8601String();

        $sections = [];
        $sections[] = "Instrument: {$instrument}";
        $sections[] = "Current mid price: {$currentPrice}";
        $sections[] = "Current time (server tz): {$now}";
        $sections[] = "Minimum risk:reward required: {$minRr}";
        $sections[] = 'Candles are ordered oldest -> newest. Fields: t=time, o,h,l,c=open/high/low/close, v=volume.';
        $sections[] = '';

        foreach ($candlesByTimeframe as $tf => $candles) {
            $sections[] = "=== {$tf} candles (count=" . count($candles) . ') ===';
            $rows = array_map(
                static fn (Candle $c): string => json_encode($c->toArray(), JSON_UNESCAPED_SLASHES | JSON_PRESERVE_ZERO_FRACTION),
                $candles
            );
            $sections[] = implode("\n", $rows);
            $sections[] = '';
        }

        $langNote = $language === 'vi'
            ? 'Viết phần "reasoning" bằng tiếng Việt, ngắn gọn, súc tích.'
            : 'Write the "reasoning" field in English, concise.';

        $sections[] = $langNote;
        $sections[] = 'Return ONLY the JSON object, no explanation before or after.';

        return implode("\n", $sections);
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
            throw new RuntimeException('Claude returned empty text content.');
        }

        return $text;
    }

    private function extractJson(string $text): array
    {
        $trimmed = trim($text);

        // Strip ```json ... ``` or ``` ... ``` if present.
        if (preg_match('/```(?:json)?\s*(\{.*\})\s*```/s', $trimmed, $m) === 1) {
            $trimmed = $m[1];
        }

        // Fallback: take substring between first { and last }.
        $start = strpos($trimmed, '{');
        $end = strrpos($trimmed, '}');

        if ($start === false || $end === false || $end <= $start) {
            throw new RuntimeException('Claude response is not valid JSON: ' . substr($text, 0, 200));
        }

        $jsonStr = substr($trimmed, $start, $end - $start + 1);

        try {
            $decoded = json_decode($jsonStr, true, 512, JSON_THROW_ON_ERROR);
        } catch (\JsonException $e) {
            throw new RuntimeException('Failed to decode Claude JSON: ' . $e->getMessage());
        }

        if (! is_array($decoded)) {
            throw new RuntimeException('Claude JSON is not an object.');
        }

        return $decoded;
    }
}
