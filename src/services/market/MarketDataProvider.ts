import { Candle } from './Candle';

export interface MarketDataProvider {
  fetchCandles(instrument: string, timeframe: string, count: number): Promise<Candle[]>;
  fetchCurrentPrice(instrument: string): Promise<number>;
}
