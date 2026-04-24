<?php

declare(strict_types=1);

namespace App\Services\TradingView;

use Illuminate\Support\Facades\Log;
use RuntimeException;
use Spatie\Browsershot\Browsershot;

/**
 * Captures TradingView chart screenshots for Claude Vision analysis.
 *
 * Uses spatie/browsershot (Puppeteer) to open TradingView widget URLs
 * and take 1280×720 screenshots — no login required.
 *
 * TradingView timeframe intervals:
 *   M5=5, M15=15, M30=30, H1=60, H4=240, D=1D
 */
class TradingViewChartService
{
    private const INTERVAL_MAP = [
        'M1' => '1',
        'M5' => '5',
        'M15' => '15',
        'M30' => '30',
        'H1' => '60',
        'H4' => '240',
        'D' => '1D',
        'W' => '1W',
    ];

    public function __construct(
        private readonly string $symbol,
        private readonly string $theme,
        private readonly string $timezone,
        private readonly int $width,
        private readonly int $height,
        private readonly int $waitMs,
        private readonly ?string $nodeBinary,
        private readonly ?string $npmBinary,
    ) {
    }

    public static function fromConfig(): self
    {
        return new self(
            symbol: (string) config('trading.tradingview.symbol', 'OANDA:XAUUSD'),
            theme: (string) config('trading.tradingview.theme', 'dark'),
            timezone: (string) config('trading.tradingview.timezone', 'Asia/Ho_Chi_Minh'),
            width: (int) config('trading.tradingview.width', 1280),
            height: (int) config('trading.tradingview.height', 720),
            waitMs: (int) config('trading.tradingview.wait_ms', 5000),
            nodeBinary: config('trading.tradingview.node_binary') ?: null,
            npmBinary: config('trading.tradingview.npm_binary') ?: null,
        );
    }

    /**
     * Take screenshots of multiple timeframes.
     *
     * @param  array<int, string>  $timeframes  e.g. ['M5', 'M15']
     * @return array<string, string>  Keys = timeframe, values = base64-encoded PNG
     */
    public function captureTimeframes(array $timeframes): array
    {
        $screenshots = [];

        foreach ($timeframes as $tf) {
            Log::info("TradingView: capturing {$tf} chart...");
            $screenshots[$tf] = $this->captureChart($tf);
        }

        return $screenshots;
    }

    /**
     * Capture a single timeframe chart and return base64 PNG.
     */
    public function captureChart(string $timeframe): string
    {
        $interval = self::INTERVAL_MAP[$timeframe]
            ?? throw new RuntimeException("Unsupported timeframe: {$timeframe}");

        $url = $this->buildWidgetUrl($interval);

        Log::debug("TradingView: opening URL", ['url' => $url, 'tf' => $timeframe]);

        $png = $this->makeBrowsershot($url)->screenshot();

        if (! $png || strlen($png) < 1000) {
            throw new RuntimeException("TradingView screenshot for {$timeframe} returned an empty or too-small image.");
        }

        return base64_encode($png);
    }

    private function buildWidgetUrl(string $interval): string
    {
        // TradingView advanced chart embed — no login required, shows full candle chart
        $params = http_build_query([
            'symbol' => $this->symbol,
            'interval' => $interval,
            'theme' => $this->theme,
            'timezone' => $this->timezone,
            'style' => '1',         // candlestick
            'locale' => 'en',
            'toolbar_bg' => '#1a1a2e',
            'enable_publishing' => '0',
            'hide_side_toolbar' => '0',
            'allow_symbol_change' => '0',
            'save_image' => '0',
            'hide_volume' => '0',
            'studies' => implode(',', [
                'MASimple@tv-basicstudies',   // SMA 20
                'MAExp@tv-basicstudies',       // EMA 50
                'RSI@tv-basicstudies',         // RSI 14
            ]),
        ]);

        return "https://www.tradingview.com/widgetembed/?{$params}";
    }

    private function makeBrowsershot(string $url): Browsershot
    {
        $browsershot = Browsershot::url($url)
            ->windowSize($this->width, $this->height)
            ->waitUntilNetworkIdle()
            ->setDelay($this->waitMs)
            ->disableJavascript(false)
            ->dismissDialogs()
            ->ignoreHttpsErrors();

        if ($this->nodeBinary !== null) {
            $browsershot->setNodeBinary($this->nodeBinary);
        }

        if ($this->npmBinary !== null) {
            $browsershot->setNpmBinary($this->npmBinary);
        }

        return $browsershot;
    }
}
