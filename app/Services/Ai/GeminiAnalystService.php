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
    private const CANDLE_TABLE_ROWS = 50;

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
    ): AnalysisResult {
        $systemPrompt = $this->buildSystemPrompt();
        $userPrompt   = $this->buildUserPrompt($instrument, $candlesByTimeframe, $currentPrice, $minRr);

        $url = "{$this->baseUrl}/models/{$this->model}:generateContent?key={$this->apiKey}";

        $requestBody = [
            'systemInstruction' => [
                'parts' => [['text' => $systemPrompt]],
            ],
            'contents' => [
                [
                    'role'  => 'user',
                    'parts' => [['text' => $userPrompt]],
                ],
            ],
            'generationConfig' => [
                'temperature'     => 0.2,
                'maxOutputTokens' => 4096,
            ],
        ];

        $response = $this->postWithRetry($url, $requestBody);

        if ($response->failed()) {
            Log::error('Gemini API call failed', [
                'status' => $response->status(),
                'body'   => $response->body(),
            ]);

            throw new RuntimeException(sprintf(
                'Gemini API request failed (%d): %s',
                $response->status(),
                $response->body()
            ));
        }

        $payload = $response->json();
        $text    = $this->extractText($payload);
        $json    = $this->extractJson($text);

        // Store full markdown analysis (everything before the JSON block) as reasoning
        $fullAnalysis = trim((string) preg_replace('/```json[\s\S]*?```/i', '', $text));
        $json['reasoning'] = $fullAnalysis ?: ($json['reasoning'] ?? '');

        return AnalysisResult::fromAiJson($json, $payload);
    }

    private function buildSystemPrompt(): string
    {
        return <<<'PROMPT'
Bạn là một trader vàng chuyên nghiệp với hơn 15 năm kinh nghiệm phân tích kỹ thuật và giao dịch XAUUSD.

Khi nhận được dữ liệu giá vàng, hãy phân tích và đưa ra kế hoạch giao dịch hoàn chỉnh theo khung bắt buộc dưới đây.

## KHUNG PHÂN TÍCH BẮT BUỘC

### 1. CẤU TRÚC THỊ TRƯỜNG
- Xu hướng hiện tại: TĂNG / GIẢM / SIDEWAY
- Xác định Swing High & Swing Low gần nhất
- Chuỗi: HH–HL (tăng) hoặc LH–LL (giảm)
- Nhận diện BOS (Break of Structure) hoặc CHoCH (Change of Character) nếu có

### 2. CÁC MỨC GIÁ QUAN TRỌNG
- Kháng cự gần / xa
- Hỗ trợ gần / xa
- Số tròn quan trọng trong vùng
- FVG (Fair Value Gap) nếu nhận diện được
- Order Block (OB) gần nhất

### 3. VÙNG CUNG & CẦU
Liệt kê dạng bảng:
| Loại | Vùng Giá | Độ Mạnh | Ghi chú |
|------|----------|---------|---------|

### 4. XÁC NHẬN CHỈ BÁO
| Chỉ báo | Giá trị | Tín hiệu |
|---------|---------|---------|
| EMA 200 | ... | Giá trên/dưới → Bull/Bear |
| HMA 200 | ... | Giá trên/dưới → Bull/Bear |
| BB(34)  | ... | Mở rộng/Co lại |
| RSI(14) | ... | OB/OS/Bình thường/Phân kỳ |
| Volume  | ... | Xác nhận/Mâu thuẫn |

### 5. PHÂN TÍCH ĐA KHUNG (MTF)
Tóm tắt ngắn gọn theo từng khung có dữ liệu.

### 6. THIẾT LẬP LỆNH GIAO DỊCH

#### 🟢 BUY SETUP (nếu có):
| Thông số | Chi tiết |
|----------|---------|
| Vùng vào lệnh | XXXX – XXXX |
| Điều kiện kích hoạt | ... |
| Stop Loss (SL) | XXXX — lý do |
| TP1 | XXXX — RR X:1 |
| TP2 | XXXX — RR X:1 |
| TP3 | XXXX — RR X:1 |
| Mức tin cậy | Cao / Trung bình / Thấp |
| Điều kiện hủy | ... |

#### 🔴 SELL SETUP (nếu có):
| Thông số | Chi tiết |
|----------|---------|
| Vùng vào lệnh | XXXX – XXXX |
| Điều kiện kích hoạt | ... |
| Stop Loss (SL) | XXXX — lý do |
| TP1 | XXXX — RR X:1 |
| TP2 | XXXX — RR X:1 |
| TP3 | XXXX — RR X:1 |
| Mức tin cậy | Cao / Trung bình / Thấp |
| Điều kiện hủy | ... |

### 7. QUẢN LÝ VỐN
- Rủi ro/lệnh: 1–2% tài khoản
- Chiến lược chốt lời: 50% tại TP1, dời SL về vốn, 50% còn lại đến TP2/TP3
- Số lệnh tối đa cùng lúc: 1–2

### 8. BỐI CẢNH VĨ MÔ
- DXY, US10Y, tâm lý thị trường
- Tin tức quan trọng sắp tới
- Khuyến nghị: Vào lệnh bình thường / Thận trọng / Tránh giao dịch

### 9. TÓM TẮT ĐỊNH HƯỚNG
| | |
|--|--|
| Xu hướng tổng thể | TĂNG / GIẢM / TRUNG LẬP |
| Cơ hội tốt nhất | BUY / SELL / KHÔNG GIAO DỊCH |
| Khung thời gian entry | M5 / M15 / H1 |
| Hành động ngay | Vào lệnh / Chờ retest / Bỏ qua |
| Mức độ rủi ro thị trường | Thấp / Trung bình / Cao |

### 10. CẢNH BÁO & GHI CHÚ CUỐI
Tối đa 3–5 điểm rủi ro cần theo dõi, dạng bullet ngắn gọn.

---

## NGUYÊN TẮC BẮT BUỘC:
✅ Chỉ đề xuất lệnh khi RR tối thiểu 1:2
✅ Không đuổi giá — chỉ vào lệnh khi giá về vùng
✅ Cấu trúc không rõ ràng → GHI RÕ "KHÔNG GIAO DỊCH"
✅ Có tin tức trong 30 phút → CẢNH BÁO rõ ràng
✅ Ưu tiên bảo vệ vốn trước lợi nhuận
✅ Kết quả phải có số liệu cụ thể, KHÔNG mơ hồ
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
    ): string {
        $now = now()->setTimezone('Asia/Ho_Chi_Minh')->format('d/m/Y H:i');

        $sections   = [];
        $sections[] = "## DỮ LIỆU ĐẦU VÀO\n";
        $sections[] = "**Công cụ:** {$instrument}";
        $sections[] = "**Thời điểm:** {$now} (Asia/Ho_Chi_Minh)";
        $sections[] = "**Giá hiện tại:** {$currentPrice}";
        $sections[] = "**RR tối thiểu:** {$minRr}:1\n";

        foreach ($candlesByTimeframe as $tf => $candles) {
            $sections[] = $this->buildTimeframeSection($tf, $candles);
        }

        $sections[] = <<<INSTRUCTION

---

Hãy phân tích đầy đủ theo khung 10 mục đã được chỉ định trong system prompt.

Sau khi hoàn thành toàn bộ phân tích, kết thúc response bằng block JSON sau để hệ thống tự động xử lý:

```json
{
  "action": "BUY" hoặc "SELL" hoặc "NO_TRADE",
  "entry": số thực hoặc null,
  "stop_loss": số thực hoặc null,
  "take_profit": số thực (TP1) hoặc null,
  "risk_reward": số thực hoặc null,
  "confidence": số nguyên 0–100,
  "trend_bias": "BULLISH" hoặc "BEARISH" hoặc "NEUTRAL",
  "reasoning": "tóm tắt 1–2 câu lý do chính bằng tiếng Việt"
}
```
INSTRUCTION;

        return implode("\n", $sections);
    }

    /**
     * @param  array<int, Candle>  $candles
     */
    private function buildTimeframeSection(string $tf, array $candles): string
    {
        $total   = count($candles);
        $display = array_slice($candles, -self::CANDLE_TABLE_ROWS);

        $rsi   = $this->calculateRsi($candles, 14);
        $ema200 = $this->calculateEma($candles, 200);
        $hma200 = $this->calculateHma($candles, 200);
        $bb     = $this->calculateBB($candles, 34, 2.0);

        $lastRsi  = $rsi   ? round(end($rsi),   2) : 'N/A';
        $lastEma  = $ema200 ? round(end($ema200), 2) : 'N/A';
        $lastHma  = $hma200 ? round(end($hma200), 2) : 'N/A';
        $lastBbU  = $bb ? round($bb['upper'], 2) : 'N/A';
        $lastBbM  = $bb ? round($bb['middle'], 2) : 'N/A';
        $lastBbL  = $bb ? round($bb['lower'], 2) : 'N/A';

        $lastCandle = end($candles);
        $vol        = $lastCandle ? number_format($lastCandle->volume) : 'N/A';

        $lines   = [];
        $lines[] = "\n### [{$tf}] — {$total} nến";
        $lines[] = '';
        $lines[] = "**Chỉ báo kỹ thuật (nến cuối):**";
        $lines[] = "| Chỉ báo | Giá trị |";
        $lines[] = "|---------|---------|";
        $lines[] = "| EMA 200 | {$lastEma} |";
        $lines[] = "| HMA 200 | {$lastHma} |";
        $lines[] = "| BB(34) Upper | {$lastBbU} |";
        $lines[] = "| BB(34) Middle | {$lastBbM} |";
        $lines[] = "| BB(34) Lower | {$lastBbL} |";
        $lines[] = "| RSI(14) | {$lastRsi} |";
        $lines[] = "| Volume nến cuối | {$vol} |";
        $lines[] = '';
        $lines[] = "**Dữ liệu nến (" . count($display) . " nến gần nhất):**";
        $lines[] = "| Thời gian | Open | High | Low | Close | Volume | RSI(14) |";
        $lines[] = "|-----------|------|------|-----|-------|--------|---------|";

        foreach ($display as $c) {
            $rsiVal = isset($rsi[$c->time]) ? round($rsi[$c->time], 2) : '-';
            $lines[] = "| {$c->time} | {$c->open} | {$c->high} | {$c->low} | {$c->close} | {$c->volume} | {$rsiVal} |";
        }

        Log::debug("RSI(14) [{$tf}]", $rsi);

        return implode("\n", $lines);
    }

    // ─── Indicator calculations ───────────────────────────────────────────────

    /**
     * @param  array<int, Candle>  $candles
     * @return array<string, float>  keyed by candle time
     */
    private function calculateRsi(array $candles, int $period = 14): array
    {
        $result = [];
        $n      = count($candles);

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

    /**
     * @param  array<int, Candle>  $candles
     * @return array<int, float>
     */
    private function calculateEma(array $candles, int $period): array
    {
        $n = count($candles);

        if ($n < $period) {
            return [];
        }

        $k      = 2.0 / ($period + 1);
        $result = [];
        $ema    = 0.0;

        for ($i = 0; $i < $period; $i++) {
            $ema += $candles[$i]->close;
        }
        $ema /= $period;

        for ($i = $period; $i < $n; $i++) {
            $ema      = $candles[$i]->close * $k + $ema * (1 - $k);
            $result[] = $ema;
        }

        return $result;
    }

    /**
     * Hull Moving Average: HMA(n) = WMA(2×WMA(n/2) − WMA(n), √n)
     *
     * @param  array<int, Candle>  $candles
     * @return array<int, float>
     */
    private function calculateHma(array $candles, int $period): array
    {
        $n = count($candles);

        if ($n < $period) {
            return [];
        }

        $half  = (int) round($period / 2);
        $sqrt  = (int) round(sqrt($period));

        $wmaFull = $this->wma($candles, $period);
        $wmaHalf = $this->wma($candles, $half);

        $minLen = min(count($wmaFull), count($wmaHalf));
        $diff   = [];

        for ($i = 0; $i < $minLen; $i++) {
            $iF = count($wmaFull) - $minLen + $i;
            $iH = count($wmaHalf) - $minLen + $i;

            $diff[] = (object) ['close' => 2 * $wmaHalf[$iH] - $wmaFull[$iF]];
        }

        return $this->wmaRaw($diff, $sqrt);
    }

    /**
     * @param  array<int, Candle>  $candles
     * @return array<int, float>
     */
    private function wma(array $candles, int $period): array
    {
        $n      = count($candles);
        $result = [];

        for ($i = $period - 1; $i < $n; $i++) {
            $sum    = 0.0;
            $weight = 0;

            for ($j = 0; $j < $period; $j++) {
                $w       = $j + 1;
                $sum    += $candles[$i - ($period - 1 - $j)]->close * $w;
                $weight += $w;
            }

            $result[] = $sum / $weight;
        }

        return $result;
    }

    /**
     * @param  array<int, object{close: float}>  $items
     * @return array<int, float>
     */
    private function wmaRaw(array $items, int $period): array
    {
        $n      = count($items);
        $result = [];

        for ($i = $period - 1; $i < $n; $i++) {
            $sum    = 0.0;
            $weight = 0;

            for ($j = 0; $j < $period; $j++) {
                $w       = $j + 1;
                $sum    += $items[$i - ($period - 1 - $j)]->close * $w;
                $weight += $w;
            }

            $result[] = $sum / $weight;
        }

        return $result;
    }

    /**
     * @param  array<int, Candle>  $candles
     * @return array{upper:float,middle:float,lower:float}|null
     */
    private function calculateBB(array $candles, int $period, float $mult): ?array
    {
        $n = count($candles);

        if ($n < $period) {
            return null;
        }

        $slice  = array_slice($candles, -$period);
        $closes = array_map(fn (Candle $c) => $c->close, $slice);
        $sma    = array_sum($closes) / $period;

        $variance = array_sum(array_map(fn ($c) => ($c - $sma) ** 2, $closes)) / $period;
        $std      = sqrt($variance);

        return [
            'upper'  => $sma + $mult * $std,
            'middle' => $sma,
            'lower'  => $sma - $mult * $std,
        ];
    }

    // ─── HTTP / parsing ───────────────────────────────────────────────────────

    private function postWithRetry(string $url, array $body): \Illuminate\Http\Client\Response
    {
        $maxAttempts       = 4;
        $transientStatuses = [429, 500, 502, 503, 504];
        $response          = null;

        for ($attempt = 1; $attempt <= $maxAttempts; $attempt++) {
            $response = Http::timeout(120)->post($url, $body);

            if ($response->successful()) {
                return $response;
            }

            $isTransient = in_array($response->status(), $transientStatuses, true);

            if (! $isTransient || $attempt === $maxAttempts) {
                return $response;
            }

            $sleep = $attempt * 3;
            Log::warning('Gemini transient error, retrying', [
                'attempt' => $attempt,
                'status'  => $response->status(),
                'sleep'   => $sleep,
            ]);
            sleep($sleep);
        }

        return $response;
    }

    private function extractText(array $payload): string
    {
        $text = $payload['candidates'][0]['content']['parts'][0]['text'] ?? '';

        if ($text === '') {
            throw new RuntimeException('Gemini returned empty text content.');
        }

        return (string) $text;
    }

    private function extractJson(string $text): array
    {
        $trimmed = trim($text);

        if (preg_match('/```(?:json)?\s*(\{.*?\})\s*```/s', $trimmed, $m) === 1) {
            $trimmed = $m[1];
        }

        $start = strpos($trimmed, '{');
        $end   = strrpos($trimmed, '}');

        if ($start === false || $end === false || $end <= $start) {
            throw new RuntimeException('Gemini response contains no valid JSON: ' . substr($text, 0, 300));
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
