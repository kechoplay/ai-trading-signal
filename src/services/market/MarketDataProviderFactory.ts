import { MarketDataProvider } from './MarketDataProvider';
import { TwelveDataProvider } from './TwelveDataProvider';
import { OandaProvider } from './OandaProvider';
import { config } from '../../config/trading';

export function makeMarketDataProvider(): MarketDataProvider {
  switch (config.provider) {
    case 'oanda':
      return OandaProvider.fromConfig();
    default:
      return TwelveDataProvider.fromConfig();
  }
}
