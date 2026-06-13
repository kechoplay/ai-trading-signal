/**
 * BinanceFuturesService.ts
 * -----------------------------------------------------------------------------
 * Lấy "sentiment" thị trường futures/perpetual cho cặp crypto từ Binance Futures
 * API (public, KHÔNG cần API key):
 *   - Funding rate hiện tại + mark price + thời điểm funding kế tiếp
 *   - Open interest hiện tại + xu hướng OI (so với ~24h trước)
 *
 * Dữ liệu này bổ trợ cho prompt crypto (đám đông long/short, rủi ro squeeze,
 * liquidation cascade). Fail-soft: bất kỳ lỗi nào (geo-block, timeout, symbol
 * không có trên futures) → trả về null, KHÔNG làm hỏng pipeline phân tích.
 * -----------------------------------------------------------------------------
 */

import axios from 'axios';
import { config } from '../../config/trading';
import { logger } from '../../logger';

export interface FuturesSentiment {
  symbol: string;             // ký hiệu perpetual Binance, vd "BTCUSDT"
  fundingRatePct: number;     // funding rate gần nhất, đơn vị % (vd 0.0100 = 0.01%)
  nextFundingTime: string;    // ISO string, '' nếu không có
  markPrice: number;
  openInterest: number;       // OI hiện tại (theo coin cơ sở)
  oiChangePct: number | null; // % thay đổi OI qua cửa sổ lookback ('null' nếu thiếu data)
  oiLookbackHours: number;    // độ dài cửa sổ tính oiChangePct (giờ)
}

// Cùng danh sách base crypto như provider market data.
const CRYPTO_BASES = ['BTC', 'ETH', 'BNB', 'SOL', 'XRP', 'ADA', 'DOGE', 'LTC'];

/** "BTC/USD" → "BTCUSDT". Trả null nếu không phải cặp crypto được hỗ trợ. */
export function toFuturesSymbol(instrument: string): string | null {
  const base = instrument.split('/')[0]?.trim().toUpperCase();
  if (!base || !CRYPTO_BASES.includes(base)) return null;
  return `${base}USDT`;
}

export class BinanceFuturesService {
  constructor(private readonly baseUrl: string) {}

  static fromConfig(): BinanceFuturesService {
    return new BinanceFuturesService(config.binance.futuresBaseUrl);
  }

  /**
   * Lấy funding rate + open interest cho 1 cặp perpetual.
   * Fail-soft: trả về null nếu instrument không phải crypto hoặc API lỗi.
   */
  async fetchSentiment(instrument: string): Promise<FuturesSentiment | null> {
    const symbol = toFuturesSymbol(instrument);
    if (!symbol) return null;

    try {
      // premiumIndex: funding rate + mark price; openInterestHist: OI hiện tại + xu hướng.
      const [premium, oiHist] = await Promise.all([
        this.get('/fapi/v1/premiumIndex', { symbol }),
        this.get('/futures/data/openInterestHist', { symbol, period: '1h', limit: 25 }),
      ]);

      const fundingRatePct = parseFloat(premium?.lastFundingRate ?? '0') * 100;
      const markPrice = parseFloat(premium?.markPrice ?? '0');
      const nextFundingTime = premium?.nextFundingTime
        ? new Date(premium.nextFundingTime).toISOString()
        : '';

      let openInterest = 0;
      let oiChangePct: number | null = null;
      let oiLookbackHours = 0;
      if (Array.isArray(oiHist) && oiHist.length) {
        const latest = parseFloat(oiHist[oiHist.length - 1]?.sumOpenInterest ?? '0');
        const earliest = parseFloat(oiHist[0]?.sumOpenInterest ?? '0');
        openInterest = latest;
        oiLookbackHours = oiHist.length - 1; // period=1h → số phần tử - 1 = số giờ
        if (earliest > 0) oiChangePct = ((latest - earliest) / earliest) * 100;
      }

      const sentiment: FuturesSentiment = {
        symbol, fundingRatePct, nextFundingTime, markPrice, openInterest, oiChangePct, oiLookbackHours,
      };
      logger.info('Binance futures sentiment', sentiment);
      return sentiment;
    } catch (err: any) {
      logger.warn('Binance futures sentiment fetch failed — bỏ qua', {
        instrument, error: err?.message ?? String(err),
      });
      return null;
    }
  }

  private async get(path: string, params: Record<string, unknown>): Promise<any> {
    const { data } = await axios.get(`${this.baseUrl}${path}`, { params, timeout: 15_000 });
    return data;
  }
}
