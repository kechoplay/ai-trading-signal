/**
 * BinanceKlinesProvider.ts
 * -----------------------------------------------------------------------------
 * Nến crypto từ Binance Futures (perpetual USDT-M) — `/fapi/v1/klines`, API public,
 * KHÔNG cần key, KHÔNG tốn credit TwelveData.
 *
 * Vì sao không dùng TwelveData cho crypto: `time_series` BTC/USD exchange=Binance chỉ trả
 * OHLC, không có volume (đã gọi thử 23/10/2026). Klines futures có volume thật của chính
 * hợp đồng perpetual mà funding/OI (BinanceFuturesService) đang đo.
 *
 * Giá là giá BTCUSDT perpetual, lệch vài USD so với BTC/USD spot trên chart.
 * Timestamp xuất ra cùng định dạng TwelveData ("YYYY-MM-DD HH:mm:ss", giờ treo tường của
 * MARKET_HOURS_TIMEZONE) để candleTime / SessionLevels / prompt đọc như cũ.
 * -----------------------------------------------------------------------------
 */

import axios from 'axios';
import { Candle } from './Candle';
import { MarketDataProvider } from './MarketDataProvider';
import { toFuturesSymbol } from './BinanceFuturesService';
import { zonedParts } from './candleTime';
import { config } from '../../config/trading';
import { logger } from '../../logger';

const INTERVAL_MAP: Record<string, string> = {
  M1: '1m', M5: '5m', M15: '15m', M30: '30m',
  H1: '1h', H4: '4h', D: '1d', W: '1w',
};

// Trần `limit` của /fapi/v1/klines.
const MAX_LIMIT = 1500;

const pad = (n: number): string => String(n).padStart(2, '0');

/** Epoch ms → "YYYY-MM-DD HH:mm:ss" theo giờ treo tường của `timeZone` (như TwelveData). */
function wallClock(ms: number, timeZone: string): string {
  const p = zonedParts(new Date(ms), timeZone);
  return `${p.year}-${pad(p.month)}-${pad(p.day)} ${pad(p.hour)}:${pad(p.minute)}:${pad(p.second)}`;
}

export class BinanceKlinesProvider implements MarketDataProvider {
  constructor(private readonly baseUrl: string) {}

  static fromConfig(): BinanceKlinesProvider {
    return new BinanceKlinesProvider(config.binance.futuresBaseUrl);
  }

  async fetchCandles(instrument: string, timeframe: string, count: number = 100): Promise<Candle[]> {
    const symbol = toFuturesSymbol(instrument);
    if (!symbol) throw new Error(`Binance klines: ${instrument} không phải cặp crypto được hỗ trợ.`);
    const interval = INTERVAL_MAP[timeframe];
    if (!interval) throw new Error(`Unsupported timeframe: ${timeframe}`);

    const { data } = await axios.get(`${this.baseUrl}/fapi/v1/klines`, {
      params: { symbol, interval, limit: Math.min(Math.max(1, count), MAX_LIMIT) },
      timeout: 20_000,
    });
    if (!Array.isArray(data) || !data.length) {
      throw new Error(`Binance returned no klines for ${symbol} ${timeframe}.`);
    }

    // Mỗi kline: [openTime, open, high, low, close, volume, closeTime, ...] — cũ → mới,
    // phần tử cuối là nến đang chạy (như TwelveData).
    const tz = config.marketHours.timezone;
    return data.map((k: unknown[]) => new Candle(
      wallClock(Number(k[0]), tz),
      parseFloat(String(k[1])),
      parseFloat(String(k[2])),
      parseFloat(String(k[3])),
      parseFloat(String(k[4])),
      parseFloat(String(k[5])),
    ));
  }

  async fetchCurrentPrice(instrument: string): Promise<number> {
    const symbol = toFuturesSymbol(instrument);
    if (!symbol) throw new Error(`Binance price: ${instrument} không phải cặp crypto được hỗ trợ.`);
    const { data } = await axios.get(`${this.baseUrl}/fapi/v1/ticker/price`, {
      params: { symbol },
      timeout: 15_000,
    });
    const price = parseFloat(data?.price ?? '0');
    logger.debug('Binance price', { instrument, symbol, price });
    if (!(price > 0)) throw new Error(`Binance price error for ${symbol}.`);
    return price;
  }
}

/**
 * Chọn nguồn theo symbol: crypto → Binance klines, còn lại (vàng) → provider cấu hình.
 * Binance lỗi (geo-block, timeout…) → rơi về provider chính (mất volume nhưng không mất lượt
 * phân tích), log warn.
 */
export class CryptoRoutingProvider implements MarketDataProvider {
  constructor(
    private readonly primary: MarketDataProvider,
    private readonly crypto: BinanceKlinesProvider,
  ) {}

  async fetchCandles(instrument: string, timeframe: string, count: number): Promise<Candle[]> {
    if (!toFuturesSymbol(instrument)) return this.primary.fetchCandles(instrument, timeframe, count);
    try {
      return await this.crypto.fetchCandles(instrument, timeframe, count);
    } catch (err: any) {
      logger.warn('Binance klines lỗi — dùng provider chính (không có volume)', {
        instrument, timeframe, error: err?.message ?? String(err),
      });
      return this.primary.fetchCandles(instrument, timeframe, count);
    }
  }

  async fetchCurrentPrice(instrument: string): Promise<number> {
    if (!toFuturesSymbol(instrument)) return this.primary.fetchCurrentPrice(instrument);
    try {
      return await this.crypto.fetchCurrentPrice(instrument);
    } catch (err: any) {
      logger.warn('Binance price lỗi — dùng provider chính', {
        instrument, error: err?.message ?? String(err),
      });
      return this.primary.fetchCurrentPrice(instrument);
    }
  }
}
