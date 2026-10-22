import axios from 'axios';
import { Candle } from './Candle';
import { MarketDataProvider } from './MarketDataProvider';
import { config } from '../../config/trading';
import { logger } from '../../logger';

const TIMEFRAME_MAP: Record<string, string> = {
  M1: '1min', M5: '5min', M15: '15min', M30: '30min',
  H1: '1h', H4: '4h', D: '1day', W: '1week',
};

// TwelveData yêu cầu tham số `exchange` cho cặp crypto (vd: BTC/USD → Binance).
const CRYPTO_BASES = ['BTC', 'ETH', 'BNB', 'SOL', 'XRP', 'ADA', 'DOGE', 'LTC'];

function cryptoExchange(instrument: string): string | undefined {
  const base = instrument.split('/')[0]?.trim().toUpperCase();
  return base && CRYPTO_BASES.includes(base) ? 'Binance' : undefined;
}

export class TwelveDataProvider implements MarketDataProvider {
  constructor(
    private readonly apiKeys: string[],
    private readonly baseUrl: string,
  ) {}

  static fromConfig(): TwelveDataProvider {
    if (!config.twelvedata.apiKeys.length) throw new Error('TWELVEDATA_API_KEY is not configured.');
    return new TwelveDataProvider(config.twelvedata.apiKeys, config.twelvedata.baseUrl);
  }

  async fetchCandles(instrument: string, timeframe: string, count: number = 100): Promise<Candle[]> {
    const interval = TIMEFRAME_MAP[timeframe];
    if (!interval) throw new Error(`Unsupported timeframe: ${timeframe}`);

    const exchange = cryptoExchange(instrument);
    const data = await this.get('/time_series', {
      symbol: instrument,
      interval,
      outputsize: count,
      order: 'ASC',
      timezone: config.marketHours.timezone,
      ...(exchange ? { exchange } : {}),
    });

    if (data.status === 'error') throw new Error(`TwelveData error: ${data.message ?? 'unknown'}`);

    const values: Record<string, string>[] = data.values ?? [];
    if (!values.length) throw new Error(`TwelveData returned no candles for ${instrument} ${timeframe}.`);

    logger.info(JSON.stringify(data));

    const candles = values.map((row) => new Candle(
      row.datetime ?? '',
      parseFloat(row.open ?? '0'),
      parseFloat(row.high ?? '0'),
      parseFloat(row.low ?? '0'),
      parseFloat(row.close ?? '0'),
    ));

    return candles;
  }

  async fetchCurrentPrice(instrument: string): Promise<number> {
    const exchange = cryptoExchange(instrument);
    const data = await this.get('/price', { symbol: instrument, ...(exchange ? { exchange } : {}) });
    logger.debug('TwelveData price', { instrument, price: data.price });
    if (data.status === 'error') throw new Error(`TwelveData price error: ${data.message ?? 'unknown'}`);
    return parseFloat(data.price ?? '0');
  }

  private async get(path: string, params: Record<string, unknown>): Promise<Record<string, any>> {
    return withRetry(async () => {
      // Mỗi vòng thử một key còn dùng được; key bị TwelveData từ chối thì đánh dấu rồi thử
      // key kế. Hết key → pickKey() ném lỗi nên vòng lặp luôn dừng.
      for (;;) {
        const key = pickKey(this.apiKeys);
        await acquireSlot();
        const res = await axios.get(`${this.baseUrl}${path}`, {
          params: { ...params, apikey: key },
          timeout: 20_000,
          // TwelveData báo hết credit / sai key bằng body `{ code, status: 'error' }` (có khi
          // kèm HTTP 4xx) — nhận mọi status để tự phân loại thay vì để axios ném lỗi.
          validateStatus: () => true,
        });
        const data: Record<string, any> = res.data ?? {};
        const code = Number(data.code ?? res.status);
        const message = String(data.message ?? '');

        const blockedUntil = keyBlockedUntil(code, message);
        if (blockedUntil != null) {
          blockKey(key, this.apiKeys, blockedUntil, code, message);
          continue;
        }
        if (res.status >= 400) throw new Error(`TwelveData HTTP ${res.status}: ${message || 'unknown'}`);
        return data;
      }
    });
  }
}

// Xoay vòng key khi một key hết hạn mức. Trạng thái dùng chung MỌI instance trong process
// (như cửa sổ trượt bên dưới). Luôn ưu tiên key đứng trước trong TWELVEDATA_API_KEY, nên
// khi key đầu được mở lại (credit ngày reset 00:00 UTC = 07:00 VN) hệ thống tự quay về nó.
// Không lưu DB: restart thì key đầu bị thử lại một lần, TwelveData từ chối mà không trừ
// credit rồi chuyển key ngay.
const blockedKeys = new Map<string, number>();

function pickKey(keys: string[]): string {
  const now = Date.now();
  for (const key of keys) {
    const until = blockedKeys.get(key);
    if (until == null || until <= now) return key;
  }
  const reopenAt = Math.min(...keys.map((k) => blockedKeys.get(k) ?? now));
  throw new Error(
    `TwelveData: cả ${keys.length} API key đều đang hết hạn mức / bị từ chối — mở lại lúc ${new Date(reopenAt).toISOString()}.`,
  );
}

/** Thời điểm mở lại key nếu lỗi là do KEY (hết credit, sai key); null = lỗi khác, không đổi key. */
function keyBlockedUntil(code: number, message: string): number | null {
  const now = Date.now();
  if (code === 429) {
    // "run out of API credits for the day" → khoá tới lượt reset ngày; còn lại là trần
    // theo phút (key bị process khác dùng chung) → khoá hết phút đó.
    if (/for the day|daily/i.test(message)) return nextUtcMidnight(now);
    return now + WINDOW_MS;
  }
  // Sai / bị thu hồi key — không tự hết, thử lại sau 1 giờ phòng trường hợp đã sửa trên dashboard.
  if (code === 401 || code === 403) return now + 60 * 60_000;
  return null;
}

function blockKey(key: string, keys: string[], until: number, code: number, message: string): void {
  blockedKeys.set(key, until);
  const next = keys.find((k) => (blockedKeys.get(k) ?? 0) <= Date.now());
  logger.warn('TwelveData: key bị từ chối — chuyển key', {
    key: describeKey(key, keys),
    code,
    reason: message,
    blocked_until: new Date(until).toISOString(),
    next_key: next ? describeKey(next, keys) : null,
  });
}

/** "#2 (…a1b2)" — không bao giờ log nguyên key. */
function describeKey(key: string, keys: string[]): string {
  return `#${keys.indexOf(key) + 1} (…${key.slice(-4)})`;
}

function nextUtcMidnight(now: number): number {
  const d = new Date(now);
  d.setUTCHours(24, 0, 0, 0);
  return d.getTime();
}

// Cửa sổ trượt 60s dùng chung MỌI instance trong process (scheduler, SetupWatcher, API
// mỗi nơi tự tạo provider riêng). Tick :00/:30 của scheduler (~5 request) trùng tick watcher
// (1 request/symbol + bias) là vượt trần 8/phút của gói basic → TwelveData trả lỗi 429 và
// lượt đó hỏng. Chờ cho tới khi có chỗ thay vì gửi rồi lỗi. Cửa sổ trượt chặt hơn trần
// theo phút lịch nên không bao giờ vượt.
const WINDOW_MS = 61_000;
const sentAt: number[] = [];
let queue: Promise<void> = Promise.resolve();

function acquireSlot(): Promise<void> {
  const limit = config.twelvedata.maxRequestsPerMin;
  if (limit <= 0) return Promise.resolve();
  const slot = queue.then(async () => {
    for (;;) {
      const now = Date.now();
      while (sentAt.length > 0 && now - sentAt[0] >= WINDOW_MS) sentAt.shift();
      if (sentAt.length < limit) break;
      const waitMs = WINDOW_MS - (now - sentAt[0]);
      logger.debug('TwelveData: chạm trần request/phút — chờ', { limit, wait_ms: waitMs });
      await sleep(waitMs);
    }
    sentAt.push(Date.now());
  });
  queue = slot.catch(() => undefined);
  return slot;
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
