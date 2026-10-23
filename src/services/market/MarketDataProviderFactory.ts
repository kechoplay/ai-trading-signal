import { MarketDataProvider } from './MarketDataProvider';
import { TwelveDataProvider } from './TwelveDataProvider';
import { OandaProvider } from './OandaProvider';
import { BinanceKlinesProvider, CryptoRoutingProvider } from './BinanceKlinesProvider';
import { config } from '../../config/trading';

function makePrimaryProvider(): MarketDataProvider {
  switch (config.provider) {
    case 'oanda':
      return OandaProvider.fromConfig();
    default:
      return TwelveDataProvider.fromConfig();
  }
}

/** Crypto lấy nến từ Binance Futures (có volume) trừ khi CRYPTO_CANDLE_SOURCE=provider. */
export function makeMarketDataProvider(): MarketDataProvider {
  const primary = makePrimaryProvider();
  return config.binance.cryptoCandles === 'binance'
    ? new CryptoRoutingProvider(primary, BinanceKlinesProvider.fromConfig())
    : primary;
}
