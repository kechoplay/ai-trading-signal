<?php

declare(strict_types=1);

namespace App\Services\Ai;

use App\Services\Ai\Dto\AnalysisResult;
use App\Services\Market\Candle;
use Illuminate\Support\Facades\Http;
use Illuminate\Support\Facades\Log;
use RuntimeException;

class GeminiAnalystService
{
    public function __construct(
        private readonly string $apiKey,
        private readonly string $model,
        private readonly string $baseUrl,
    ) {
    }

    public static function fromConfig(): self
    {
        $apiKey = (string) config('trading.gemini.api_key');

        if ($apiKey === '') {
            throw new RuntimeException('GEMINI_API_KEY is not configured.');
        }

        return new self(
            apiKey: $apiKey,
            model: (string) config('trading.gemini.model'),
            baseUrl: (string) config('trading.gemini.base_url'),
        );
    }

    /**
     * @param  array<string, array<int, Candle>>  $candlesByTimeframe
     */
    public function analyze(
        string $instrument,
        array $candlesByTimeframe,
        float $currentPrice,
        float $minRr,
        string $language = 'vi',
    ): AnalysisResult {
        $systemPrompt = $this->buildSystemPrompt($instrument, $minRr, $language);
        $userPrompt = $this->buildUserPrompt($instrument, $candlesByTimeframe, $currentPrice, $minRr, $language);

        $url = "{$this->baseUrl}/models/{$this->model}:generateContent?key={$this->apiKey}";

        $requestBody = [
            'systemInstruction' => [
                'parts' => [['text' => $systemPrompt]],
            ],
            'contents' => [
                [
                    'role' => 'user',
                    'parts' => [['text' => $userPrompt]],
                ],
            ],
            'generationConfig' => [
                'temperature' => 0.2,
                'maxOutputTokens' => 2048,
            ],
        ];

        $response = $this->postWithRetry($url, $requestBody);

        if ($response->failed()) {
            Log::error('Gemini API call failed', [
                'status' => $response->status(),
                'body' => $response->body(),
            ]);

            throw new RuntimeException(sprintf(
                'Gemini API request failed (%d): %s',
                $response->status(),
                $response->body()
            ));
        }

        $payload = $response->json();
        $text = $this->extractText($payload);
        $json = $this->extractJson($text);

        return AnalysisResult::fromAiJson($json, $payload);
    }

    /**
     * Posts to Gemini with retry on transient errors (429, 5xx). Backoff: 3s, 6s, 9s.
     */
    private function postWithRetry(string $url, array $body): \Illuminate\Http\Client\Response
    {
        $maxAttempts = 4;
        $transientStatuses = [429, 500, 502, 503, 504];
        $response = null;

        for ($attempt = 1; $attempt <= $maxAttempts; $attempt++) {
            $response = Http::timeout(90)->post($url, $body);

            if ($response->successful()) {
                return $response;
            }

            $isTransient = in_array($response->status(), $transientStatuses, true);
            if (! $isTransient || $attempt === $maxAttempts) {
                return $response;
            }

            $sleepSeconds = $attempt * 3;
            Log::warning('Gemini transient error, retrying', [
                'attempt' => $attempt,
                'status' => $response->status(),
                'sleep_seconds' => $sleepSeconds,
            ]);
            sleep($sleepSeconds);
        }

        return $response;
    }

    private function buildSystemPrompt(string $instrument, float $minRr, string $language): string
    {
        $lang = $language === 'vi' ? 'Vietnamese' : 'English';

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
{"action":"BUY"|"SELL"|"NO_TRADE","entry":number|null,"stop_loss":number|null,"take_profit":number|null,"risk_reward":number|null,"confidence":integer,"trend_bias":"BULLISH"|"BEARISH"|"NEUTRAL","reasoning":"string"}
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
        $sections[] = 'Candles are ordered oldest -> newest. Fields: t=time, o,h,l,c=open/high/low/close, v=volume, rsi=RSI(14).';
        $sections[] = '';

        foreach ($candlesByTimeframe as $tf => $candles) {
            $sections[] = "=== {$tf} candles (count=" . count($candles) . ') ===';
            $rsi = $this->calculateRsi($candles, 14);
            $rows = array_map(
                static function (Candle $c) use ($rsi): string {
                    $data = $c->toArray();
                    $data['rsi'] = $rsi[$c->time] ?? null;
                    return json_encode($data, JSON_UNESCAPED_SLASHES | JSON_PRESERVE_ZERO_FRACTION);
                },
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
        $text = $payload['candidates'][0]['content']['parts'][0]['text'] ?? '';

        if ($text === '') {
            throw new RuntimeException('Gemini returned empty text content.');
        }

        return (string) $text;
    }

    /**
     * @param  array<int, Candle>  $candles
     * @return array<string, float>  Keys = candle time string, values = RSI value
     */
    private function calculateRsi(array $candles, int $period = 14): array
    {
        $result = [];
        $n = count($candles);

        if ($n < $period + 1) {
            return $result;
        }

        $avgGain = 0.0;
        $avgLoss = 0.0;

        for ($i = 1; $i <= $period; $i++) {
            $diff = $candles[$i]->close - $candles[$i - 1]->close;
            $diff > 0 ? $avgGain += $diff : $avgLoss += abs($diff);
        }
        $avgGain /= $period;
        $avgLoss /= $period;

        for ($i = $period + 1; $i < $n; $i++) {
            $diff    = $candles[$i]->close - $candles[$i - 1]->close;
            $avgGain = ($avgGain * ($period - 1) + max(0.0, $diff)) / $period;
            $avgLoss = ($avgLoss * ($period - 1) + max(0.0, -$diff)) / $period;
            $rs      = $avgLoss == 0.0 ? 100.0 : $avgGain / $avgLoss;
            $result[$candles[$i]->time] = round(100 - 100 / (1 + $rs), 2);
        }

        return $result;
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
            throw new RuntimeException('Gemini response is not valid JSON: ' . substr($text, 0, 200));
        }

        $jsonStr = substr($trimmed, $start, $end - $start + 1);

        try {
            $decoded = json_decode($jsonStr, true, 512, JSON_THROW_ON_ERROR);
        } catch (\JsonException $e) {
            throw new RuntimeException('Failed to decode Gemini JSON: ' . $e->getMessage());
        }

        if (! is_array($decoded)) {
            throw new RuntimeException('Gemini JSON is not an object.');
        }

        return $decoded;
    }
}
