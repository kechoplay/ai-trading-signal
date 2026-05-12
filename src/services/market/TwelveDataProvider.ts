import axios from 'axios';
import { Candle } from './Candle';
import { MarketDataProvider } from './MarketDataProvider';
import { config } from '../../config/trading';
import { logger } from '../../logger';

const TIMEFRAME_MAP: Record<string, string> = {
  M1: '1min', M5: '5min', M15: '15min', M30: '30min',
  H1: '1h', H4: '4h', D: '1day', W: '1week',
};

export class TwelveDataProvider implements MarketDataProvider {
  constructor(
    private readonly apiKey: string,
    private readonly baseUrl: string,
  ) {}

  static fromConfig(): TwelveDataProvider {
    if (!config.twelvedata.apiKey) throw new Error('TWELVEDATA_API_KEY is not configured.');
    return new TwelveDataProvider(config.twelvedata.apiKey, config.twelvedata.baseUrl);
  }

  async fetchCandles(instrument: string, timeframe: string, count: number = 100): Promise<Candle[]> {
    const interval = TIMEFRAME_MAP[timeframe];
    if (!interval) throw new Error(`Unsupported timeframe: ${timeframe}`);

    const data = await this.get('/time_series', {
      symbol: instrument,
      interval,
      outputsize: count,
      order: 'ASC',
      apikey: this.apiKey,
    });

    logger.debug('TwelveData time_series', { instrument, timeframe, count: data.values?.length ?? 0 });

    if (data.status === 'error') throw new Error(`TwelveData error: ${data.message ?? 'unknown'}`);

    const values: Record<string, string>[] = data.values ?? [];
    if (!values.length) throw new Error(`TwelveData returned no candles for ${instrument} ${timeframe}.`);

    return values.map((row) => new Candle(
      row.datetime ?? '',
      parseFloat(row.open ?? '0'),
      parseFloat(row.high ?? '0'),
      parseFloat(row.low ?? '0'),
      parseFloat(row.close ?? '0'),
      parseInt(row.volume ?? '0', 10),
    ));
  }

  async fetchCurrentPrice(instrument: string): Promise<number> {
    const data = await this.get('/price', { symbol: instrument, apikey: this.apiKey });
    logger.debug('TwelveData price', { instrument, price: data.price });
    if (data.status === 'error') throw new Error(`TwelveData price error: ${data.message ?? 'unknown'}`);
    return parseFloat(data.price ?? '0');
  }

  private async get(path: string, params: Record<string, unknown>): Promise<Record<string, any>> {
    const { data } = await withRetry(() =>
      axios.get(`${this.baseUrl}${path}`, { params, timeout: 20_000 }),
    );
    return data;
  }
}

async function withRetry<T>(fn: () => Promise<T>, retries = 2, delayMs = 500): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i <= retries; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (i < retries) await sleep(delayMs);
    }
  }
  throw lastErr;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
