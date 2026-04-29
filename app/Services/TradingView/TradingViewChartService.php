<?php

declare(strict_types=1);

namespace App\Services\TradingView;

use Illuminate\Support\Facades\Http;
use Illuminate\Support\Facades\Log;
use RuntimeException;
use Spatie\Browsershot\Browsershot;

/**
 * Captures chart screenshots using TradingView Lightweight Charts (open-source).
 *
 * Data is fetched from TwelveData in PHP, injected directly into HTML,
 * and rendered with lightweight-charts (Canvas 2D — no WebGL, no iframes).
 *
 * TwelveData interval strings:
 *   M1=1min, M5=5min, M15=15min, M30=30min, H1=1h, H4=4h, D=1day
 */
class TradingViewChartService
{
    private const TWELVEDATA_INTERVAL_MAP = [
        'M1'  => '1min',
        'M5'  => '5min',
        'M15' => '15min',
        'M30' => '30min',
        'H1'  => '1h',
        'H4'  => '4h',
        'D'   => '1day',
        'W'   => '1week',
    ];

    public function __construct(
        private readonly string $symbol,
        private readonly string $dataSymbol,
        private readonly string $apiKey,
        private readonly string $theme,
        private readonly int $width,
        private readonly int $height,
        private readonly int $waitMs,
        private readonly ?string $nodeBinary,
        private readonly ?string $npmBinary,
        private readonly bool $saveScreenshots,
    ) {
    }

    public static function fromConfig(): self
    {
        $apiKey = (string) config('trading.twelvedata.api_key', '');

        if ($apiKey === '') {
            throw new RuntimeException('TWELVEDATA_API_KEY is required for chart screenshots. Add it to your .env file.');
        }

        return new self(
            symbol: (string) config('trading.tradingview.symbol', 'XAUUSD'),
            dataSymbol: (string) config('trading.instrument', 'XAU/USD'),
            apiKey: $apiKey,
            theme: (string) config('trading.tradingview.theme', 'dark'),
            width: (int) config('trading.tradingview.width', 1280),
            height: (int) config('trading.tradingview.height', 720),
            waitMs: (int) config('trading.tradingview.wait_ms', 8000),
            nodeBinary: config('trading.tradingview.node_binary') ?: null,
            npmBinary: config('trading.tradingview.npm_binary') ?: null,
            saveScreenshots: (bool) config('trading.tradingview.save_screenshots', false),
        );
    }

    /**
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

    public function captureChart(string $timeframe): string
    {
        $twInterval = self::TWELVEDATA_INTERVAL_MAP[$timeframe]
            ?? throw new RuntimeException("Unsupported timeframe: {$timeframe}");

        $candles = $this->fetchCandles($twInterval, $timeframe);
        $html = $this->buildChartHtml($candles, $timeframe);

        $png = $this->makeBrowsershot($html)->screenshot();

        if (! $png || strlen($png) < 1000) {
            throw new RuntimeException("Chart screenshot for {$timeframe} returned an empty or too-small image.");
        }

        if ($this->saveScreenshots) {
            $this->persistScreenshot($timeframe, $png);
        }

        return base64_encode($png);
    }

    /**
     * @return array<int, array{time:int,open:float,high:float,low:float,close:float}>
     */
    private function fetchCandles(string $interval, string $timeframe): array
    {
        Log::debug("TwelveData: fetching {$timeframe} candles", [
            'symbol' => $this->dataSymbol,
            'interval' => $interval,
        ]);

        $response = Http::timeout(30)->get('https://api.twelvedata.com/time_series', [
            'symbol'     => $this->dataSymbol,
            'interval'   => $interval,
            'outputsize' => 100,
            'apikey'     => $this->apiKey,
        ]);

        if ($response->failed()) {
            throw new RuntimeException("TwelveData API request failed ({$response->status()}).");
        }

        $data = $response->json();

        if (($data['status'] ?? '') === 'error') {
            throw new RuntimeException("TwelveData error: " . ($data['message'] ?? 'unknown'));
        }

        $values = $data['values'] ?? [];

        if (empty($values)) {
            throw new RuntimeException("TwelveData returned no candle data for {$timeframe}.");
        }

        // TwelveData returns newest-first; reverse to oldest-first for the chart
        return array_map(
            fn ($v) => [
                'time'  => strtotime($v['datetime']),
                'open'  => (float) $v['open'],
                'high'  => (float) $v['high'],
                'low'   => (float) $v['low'],
                'close' => (float) $v['close'],
            ],
            array_reverse($values)
        );
    }

    /**
     * @param array<int, array{time:int,open:float,high:float,low:float,close:float}> $candles
     */
    private function buildChartHtml(array $candles, string $timeframe): string
    {
        $w        = $this->width;
        $mainH    = (int) ($this->height * 0.72);
        $rsiH     = $this->height - $mainH;
        $label    = $this->symbol . ' · ' . $timeframe;
        $isDark   = $this->theme !== 'light';

        $bg        = $isDark ? '#131722' : '#ffffff';
        $textColor = $isDark ? '#d1d4dc' : '#131722';
        $gridColor = $isDark ? '#2a2a2a' : '#e0e3eb';

        $sma20 = $this->calculateSma($candles, 20);
        $ema50 = $this->calculateEma($candles, 50);
        $rsi14 = $this->calculateRsi($candles, 14);

        $ohlcJson  = json_encode(array_values($candles), JSON_THROW_ON_ERROR);
        $sma20Json = json_encode(array_values($sma20), JSON_THROW_ON_ERROR);
        $ema50Json = json_encode(array_values($ema50), JSON_THROW_ON_ERROR);
        $rsi14Json = json_encode(array_values($rsi14), JSON_THROW_ON_ERROR);
        $labelJson = json_encode($label, JSON_THROW_ON_ERROR);

        return <<<HTML
        <!DOCTYPE html>
        <html>
        <head>
          <meta charset="utf-8">
          <style>
            * { margin: 0; padding: 0; box-sizing: border-box; }
            html, body { width: {$w}px; background: {$bg}; overflow: hidden; }
            #label { padding: 6px 10px; color: {$textColor}; font: bold 13px/1 sans-serif; background: {$bg}; }
          </style>
        </head>
        <body>
          <div id="label">{$label} &nbsp; <span style="color:#f5a623;font-weight:normal;font-size:11px">SMA20</span>
            &nbsp; <span style="color:#7b61ff;font-weight:normal;font-size:11px">EMA50</span>
            &nbsp; <span style="color:#2196f3;font-weight:normal;font-size:11px">RSI14</span>
          </div>
          <div id="chart-main"></div>
          <div id="chart-rsi"></div>

          <script src="https://cdn.jsdelivr.net/npm/lightweight-charts@4.2.0/dist/lightweight-charts.standalone.production.js"></script>
          <script>
            const BG = '{$bg}', TEXT = '{$textColor}', GRID = '{$gridColor}';

            const sharedOpts = {
              layout: { background: { color: BG }, textColor: TEXT },
              grid: { vertLines: { color: GRID }, horzLines: { color: GRID } },
              crosshair: { mode: LightweightCharts.CrosshairMode.Normal },
              rightPriceScale: { borderColor: '#485c7b' },
              timeScale: { borderColor: '#485c7b', timeVisible: true, secondsVisible: false },
            };

            // ── Main price chart ──────────────────────────────────────────
            const main = LightweightCharts.createChart(
              document.getElementById('chart-main'),
              { ...sharedOpts, width: {$w}, height: {$mainH} }
            );

            const candles = main.addCandlestickSeries({
              upColor: '#26a69a', downColor: '#ef5350',
              borderVisible: false,
              wickUpColor: '#26a69a', wickDownColor: '#ef5350',
            });
            candles.setData({$ohlcJson});

            const sma20 = {$sma20Json};
            if (sma20.length) {
              const s = main.addLineSeries({ color: '#f5a623', lineWidth: 1, priceLineVisible: false, lastValueVisible: false });
              s.setData(sma20);
            }

            const ema50 = {$ema50Json};
            if (ema50.length) {
              const e = main.addLineSeries({ color: '#7b61ff', lineWidth: 1, priceLineVisible: false, lastValueVisible: false });
              e.setData(ema50);
            }

            main.timeScale().fitContent();

            // ── RSI panel ─────────────────────────────────────────────────
            const rsiChart = LightweightCharts.createChart(
              document.getElementById('chart-rsi'),
              { ...sharedOpts, width: {$w}, height: {$rsiH} }
            );

            const rsi14 = {$rsi14Json};
            if (rsi14.length) {
              const rsiLine = rsiChart.addLineSeries({ color: '#2196f3', lineWidth: 1, priceLineVisible: false, lastValueVisible: true });
              rsiLine.setData(rsi14);

              const obLine = rsiChart.addLineSeries({ color: '#ef5350', lineWidth: 1, lineStyle: LightweightCharts.LineStyle.Dashed, priceLineVisible: false, lastValueVisible: false });
              obLine.setData(rsi14.map(d => ({ time: d.time, value: 70 })));

              const osLine = rsiChart.addLineSeries({ color: '#26a69a', lineWidth: 1, lineStyle: LightweightCharts.LineStyle.Dashed, priceLineVisible: false, lastValueVisible: false });
              osLine.setData(rsi14.map(d => ({ time: d.time, value: 30 })));

              rsiChart.timeScale().fitContent();
            }
          </script>
        </body>
        </html>
        HTML;
    }

    /** @param array<int, array{time:int,close:float}> $candles */
    private function calculateSma(array $candles, int $period): array
    {
        $result = [];
        $n = count($candles);

        for ($i = $period - 1; $i < $n; $i++) {
            $sum = 0.0;
            for ($j = $i - $period + 1; $j <= $i; $j++) {
                $sum += $candles[$j]['close'];
            }
            $result[] = ['time' => $candles[$i]['time'], 'value' => round($sum / $period, 5)];
        }

        return $result;
    }

    /** @param array<int, array{time:int,close:float}> $candles */
    private function calculateEma(array $candles, int $period): array
    {
        $result = [];
        $n = count($candles);

        if ($n < $period) {
            return $result;
        }

        $k   = 2.0 / ($period + 1);
        $ema = 0.0;

        for ($i = 0; $i < $period; $i++) {
            $ema += $candles[$i]['close'];
        }
        $ema /= $period;

        for ($i = $period; $i < $n; $i++) {
            $ema = $candles[$i]['close'] * $k + $ema * (1 - $k);
            $result[] = ['time' => $candles[$i]['time'], 'value' => round($ema, 5)];
        }

        return $result;
    }

    /** @param array<int, array{time:int,close:float}> $candles */
    private function calculateRsi(array $candles, int $period): array
    {
        $result = [];
        $n = count($candles);

        if ($n < $period + 1) {
            return $result;
        }

        $avgGain = 0.0;
        $avgLoss = 0.0;

        for ($i = 1; $i <= $period; $i++) {
            $diff = $candles[$i]['close'] - $candles[$i - 1]['close'];
            $diff > 0 ? $avgGain += $diff : $avgLoss += abs($diff);
        }
        $avgGain /= $period;
        $avgLoss /= $period;

        for ($i = $period + 1; $i < $n; $i++) {
            $diff     = $candles[$i]['close'] - $candles[$i - 1]['close'];
            $avgGain  = ($avgGain * ($period - 1) + max(0.0, $diff)) / $period;
            $avgLoss  = ($avgLoss * ($period - 1) + max(0.0, -$diff)) / $period;
            $rs       = $avgLoss == 0 ? 100.0 : $avgGain / $avgLoss;
            $result[] = ['time' => $candles[$i]['time'], 'value' => round(100 - 100 / (1 + $rs), 2)];
        }

        return $result;
    }

    private function persistScreenshot(string $timeframe, string $png): void
    {
        $dir = storage_path('app/screenshots');

        if (! is_dir($dir)) {
            mkdir($dir, 0755, true);
        }

        $filename = sprintf('%s_%s.png', now()->format('Y-m-d_His'), $timeframe);
        $path     = $dir . DIRECTORY_SEPARATOR . $filename;

        file_put_contents($path, $png);

        Log::info("TradingView: screenshot saved", ['path' => $path]);
    }

    private function makeBrowsershot(string $html): Browsershot
    {
        $browsershot = Browsershot::html($html)
            ->windowSize($this->width, $this->height)
            ->setDelay($this->waitMs)
            ->disableJavascript(false)
            ->dismissDialogs()
            ->ignoreHttpsErrors()
            ->noSandbox()
            ->userAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36')
            ->addChromiumArguments([
                '--disable-web-security',
                '--allow-running-insecure-content',
                '--disable-blink-features=AutomationControlled',
                '--no-first-run',
                '--disable-features=PrivacySandboxSettings4',
            ]);

        if ($this->nodeBinary !== null) {
            $browsershot->setNodeBinary($this->nodeBinary);
        }

        if ($this->npmBinary !== null) {
            $browsershot->setNpmBinary($this->npmBinary);
        }

        return $browsershot;
    }
}
