import axios from 'axios';
import { Candle } from './Candle';
import { MarketDataProvider } from './MarketDataProvider';
import { config } from '../../config/trading';

const TIMEFRAME_MAP: Record<string, string> = {
  M1: 'M1', M5: 'M5', M15: 'M15', M30: 'M30',
  H1: 'H1', H4: 'H4', D: 'D', W: 'W',
};

export class OandaProvider implements MarketDataProvider {
  constructor(
    private readonly token: string,
    private readonly baseUrl: string,
  ) {}

  static fromConfig(): OandaProvider {
    if (!config.oanda.token) throw new Error('OANDA_API_TOKEN is not configured.');
    return new OandaProvider(config.oanda.token, config.oanda.baseUrl);
  }

  async fetchCandles(instrument: string, timeframe: string, count: number = 100): Promise<Candle[]> {
    const granularity = TIMEFRAME_MAP[timeframe];
    if (!granularity) throw new Error(`Unsupported timeframe: ${timeframe}`);

    const { data } = await axios.get(
      `${this.baseUrl}/v3/instruments/${instrument}/candles`,
      {
        params: { granularity, count, price: 'M' },
        headers: { Authorization: `Bearer ${this.token}` },
        timeout: 20_000,
      },
    );

    const raw: Record<string, any>[] = data.candles ?? [];
    return raw.map((item) => {
      const mid = item.mid ?? {};
      return new Candle(
        item.time ?? '',
        parseFloat(mid.o ?? '0'),
        parseFloat(mid.h ?? '0'),
        parseFloat(mid.l ?? '0'),
        parseFloat(mid.c ?? '0'),
        parseInt(item.volume ?? '0', 10),
      );
    });
  }

  async fetchCurrentPrice(instrument: string): Promise<number> {
    const candles = await this.fetchCandles(instrument, 'M1', 1);
    if (!candles.length) throw new Error('Could not fetch current price from OANDA.');
    return candles[candles.length - 1].close;
  }
}
