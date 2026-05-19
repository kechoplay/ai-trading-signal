import axios from 'axios';
import { Candle } from '../market/Candle';
import { config } from '../../config/trading';
import { logger } from '../../logger';

const CANDLE_TABLE_ROWS = 50;

export class GeminiAnalystService {
  constructor(
    private readonly apiKey: string,
    private readonly model: string,
    private readonly baseUrl: string,
  ) {}

  static fromConfig(): GeminiAnalystService {
    if (!config.gemini.apiKey) throw new Error('GEMINI_API_KEY is not configured.');
    return new GeminiAnalystService(config.gemini.apiKey, config.gemini.model, config.gemini.baseUrl);
  }

  async analyze(
    instrument: string,
    candlesByTimeframe: Record<string, Candle[]>,
    currentPrice: number,
    minRr: number,
  ): Promise<string> {
    const systemPrompt = this.buildSystemPrompt();
    const userPrompt = this.buildOhlcPrompt(instrument, candlesByTimeframe, currentPrice, minRr);

    const url = `${this.baseUrl}/models/${this.model}:generateContent?key=${this.apiKey}`;

    const requestBody = {
      systemInstruction: { parts: [{ text: systemPrompt }] },
      contents: [{ role: 'user', parts: [{ text: userPrompt }] }],
      generationConfig: { temperature: 0.2, maxOutputTokens: 8192 },
    };

    const payload = await this.postWithRetry(url, requestBody);
    const text = this.extractText(payload);
    logger.info('[Gemini] Raw response', { text });

    return text;
  }

  // ─── Prompt builders ──────────────────────────────────────────────────────

  private buildSystemPrompt(): string {
    return `Bạn là trader vàng chuyên nghiệp 15 năm kinh nghiệm.

Tôi cung cấp data OHLC của XAUUSD cho 2 khung thời gian M5 và M15, kèm theo các indicator đã tính sẵn.
Hãy phân tích hoàn chỉnh theo đúng cấu trúc sau.

---

### 1. PHÂN TÍCH ĐA KHUNG THỜI GIAN (MTF)

#### M15 — Xác nhận xu hướng:
- Xu hướng: Tăng / Giảm / Đi ngang
- Vị trí giá so với EMA 20/50/200 và HMA 200
- RSI 14: giá trị + tín hiệu (OB/OS/phân kỳ)
- Swing High & Swing Low quan trọng
- BOS hoặc CHoCH nếu có
- Vùng Hỗ trợ & Kháng cự M15 quan trọng nhất
- Bias M15: BULLISH / BEARISH / NEUTRAL

#### M5 — Tín hiệu vào lệnh:
- Xu hướng ngắn hạn
- Vị trí giá so với EMA 20/50/200 và HMA 200
- RSI 14: giá trị + tín hiệu
- ATR 14: mức biến động hiện tại
- Hình dạng 5 nến gần nhất: tên pattern + ý nghĩa
- BOS hoặc CHoCH nếu có
- Bias M5: BULLISH / BEARISH / NEUTRAL

#### Tổng hợp MTF:
- M15 và M5 đồng thuận hay mâu thuẫn?
- Bias tổng thể: BULLISH / BEARISH / NEUTRAL
- Nếu mâu thuẫn → ghi rõ lý do và khuyến nghị KHÔNG GIAO DỊCH

---

### 2. CẤU TRÚC THỊ TRƯỜNG
- Swing High & Swing Low quan trọng nhất (tổng hợp 2 khung)
- Chuỗi HH-HL hoặc LH-LL
- BOS hoặc CHoCH gần nhất

---

### 3. CÁC MỨC GIÁ QUAN TRỌNG
- Hỗ trợ & Kháng cự chính (tổng hợp M5 + M15)
- Số tròn gần nhất
- FVG (Fair Value Gap) nếu phát hiện được
- Order Block tăng & giảm

---

### 4. VÙNG CUNG & CẦU
- Vùng Cung hoạt động (SELL tiềm năng) — đánh giá Mạnh/TB/Yếu
- Vùng Cầu hoạt động (BUY tiềm năng) — đánh giá Mạnh/TB/Yếu

---

### 5. XÁC NHẬN CHỈ BÁO
- EMA 20/50/200: vị trí và hướng của đường EMA
- HMA 200: đang dốc lên / dốc xuống / phẳng
- RSI 14: giá trị, phân kỳ dương/âm nếu có
- ATR 14: cơ sở tính SL/TP

---

### 6. THIẾT LẬP LỆNH GIAO DỊCH

#### LỆNH BUY (nếu có):
- Vùng vào lệnh: [giá]
- Điều kiện kích hoạt: [cụ thể]
- SL: [giá] — lý do — khoảng cách [X pip]
- TP1: [giá] — RR [X:1]
- TP2: [giá] — RR [X:1]
- TP3: [giá] — RR [X:1]
- Độ tin cậy: Cao / TB / Thấp
- Điều kiện huỷ setup: [cụ thể]

#### LỆNH SELL (nếu có):
- Vùng vào lệnh: [giá]
- Điều kiện kích hoạt: [cụ thể]
- SL: [giá] — lý do — khoảng cách [X pip]
- TP1: [giá] — RR [X:1]
- TP2: [giá] — RR [X:1]
- TP3: [giá] — RR [X:1]
- Độ tin cậy: Cao / TB / Thấp
- Điều kiện huỷ setup: [cụ thể]

---

### 7. QUẢN LÝ VỐN
- Rủi ro mỗi lệnh: 1%
- Lot size gợi ý = (Vốn × 1%) / (SL_pip × pip_value)
- Số lệnh tối đa cùng lúc: 1

---

### 8. TÓM TẮT
- Bias M15: BULLISH / BEARISH / NEUTRAL
- Bias M5: BULLISH / BEARISH / NEUTRAL
- Cơ hội tốt nhất: BUY hay SELL
- Mức độ kiên nhẫn: Vào ngay / Chờ retest / Không giao dịch
- Lý do ngắn gọn 1-2 câu

---

## NGUYÊN TẮC BẮT BUỘC
- Chỉ vào lệnh khi RR tối thiểu 1:2
- Ưu tiên vào lệnh thuận chiều M15
- Không đuổi giá — chờ pullback về vùng
- M15 và M5 mâu thuẫn → KHÔNG GIAO DỊCH
- Tránh vào lệnh 30 phút trước/sau tin tức lớn
- Bảo vệ vốn trước, lợi nhuận sau`;
  }

  private buildOhlcPrompt(
    instrument: string,
    candlesByTimeframe: Record<string, Candle[]>,
    currentPrice: number,
    minRr: number,
  ): string {
    const now = this.formatVnTime(new Date());
    const orderedTf = ['M15', 'M5'];
    const allTf = [
      ...orderedTf,
      ...Object.keys(candlesByTimeframe).filter((tf) => !orderedTf.includes(tf)),
    ];

    const timeframes: Record<string, unknown> = {};
    for (const tf of allTf) {
      const candles = candlesByTimeframe[tf];
      if (!candles) continue;

      const rsi = this.calculateRsi(candles, 14);
      const ema20 = this.calculateEma(candles, 20);
      const ema50 = this.calculateEma(candles, 50);
      const ema200 = this.calculateEma(candles, 200);
      const hma200 = this.calculateHma(candles, 200);
      const bb = this.calculateBB(candles, 34, 2.0);
      const atr = this.calculateAtr(candles, 14);
      const patterns = this.detectCandlePatterns(candles.slice(-5));

      const indicators = {
        ema20: this.lastVal(ema20),
        ema50: this.lastVal(ema50),
        ema200: this.lastVal(ema200),
        hma200: this.lastVal(hma200),
        bb_upper: bb ? round2(bb.upper) : null,
        bb_middle: bb ? round2(bb.middle) : null,
        bb_lower: bb ? round2(bb.lower) : null,
        rsi14: this.lastVal(Object.values(rsi)),
        atr14: this.lastVal(atr),
        patterns,
      };

      const candleRows = candles.slice(-CANDLE_TABLE_ROWS).map((c) => ({
        time: c.time,
        open: c.open,
        high: c.high,
        low: c.low,
        close: c.close,
        rsi14: rsi[c.time] !== undefined ? round2(rsi[c.time]) : null,
      }));

      logger.info(`[${tf}] Market Data`, { timeframe: tf, total: candles.length, indicators, candles: candleRows });

      timeframes[tf] = { indicators, candles: candleRows };
    }

    const ohlc = JSON.stringify(
      { instrument, current_price: currentPrice, min_rr: minRr, timestamp: now, timeframes },
      null,
      2,
    );

    return `${ohlc}`;
  }

  // ─── Indicator calculations ───────────────────────────────────────────────

  private calculateRsi(candles: Candle[], period: number = 14): Record<string, number> {
    const result: Record<string, number> = {};
    const n = candles.length;
    if (n < period + 1) return result;

    let avgGain = 0;
    let avgLoss = 0;

    for (let i = 1; i <= period; i++) {
      const diff = candles[i].close - candles[i - 1].close;
      if (diff > 0) avgGain += diff;
      else avgLoss += Math.abs(diff);
    }
    avgGain /= period;
    avgLoss /= period;

    for (let i = period + 1; i < n; i++) {
      const diff = candles[i].close - candles[i - 1].close;
      avgGain = (avgGain * (period - 1) + Math.max(0, diff)) / period;
      avgLoss = (avgLoss * (period - 1) + Math.max(0, -diff)) / period;
      const rs = avgLoss === 0 ? 100 : avgGain / avgLoss;
      result[candles[i].time] = Math.round((100 - 100 / (1 + rs)) * 100) / 100;
    }

    return result;
  }

  private calculateEma(candles: Candle[], period: number): number[] {
    const n = candles.length;
    if (n < period) return [];

    const k = 2 / (period + 1);
    let ema = candles.slice(0, period).reduce((sum, c) => sum + c.close, 0) / period;
    const result: number[] = [];

    for (let i = period; i < n; i++) {
      ema = candles[i].close * k + ema * (1 - k);
      result.push(ema);
    }

    return result;
  }

  private calculateAtr(candles: Candle[], period: number = 14): number[] {
    const n = candles.length;
    if (n < period + 1) return [];

    const trs: number[] = [];
    for (let i = 1; i < n; i++) {
      const tr = Math.max(
        candles[i].high - candles[i].low,
        Math.abs(candles[i].high - candles[i - 1].close),
        Math.abs(candles[i].low - candles[i - 1].close),
      );
      trs.push(tr);
    }

    // Wilder's smoothing
    let atr = trs.slice(0, period).reduce((s, v) => s + v, 0) / period;
    const result: number[] = [atr];
    for (let i = period; i < trs.length; i++) {
      atr = (atr * (period - 1) + trs[i]) / period;
      result.push(atr);
    }

    return result;
  }

  /** Hull Moving Average: HMA(n) = WMA(2×WMA(n/2) − WMA(n), √n) */
  private calculateHma(candles: Candle[], period: number): number[] {
    const n = candles.length;
    if (n < period) return [];

    const half = Math.round(period / 2);
    const sqrtP = Math.round(Math.sqrt(period));

    const wmaFull = this.wma(candles, period);
    const wmaHalf = this.wma(candles, half);

    const minLen = Math.min(wmaFull.length, wmaHalf.length);
    const diff: { close: number }[] = [];

    for (let i = 0; i < minLen; i++) {
      const iF = wmaFull.length - minLen + i;
      const iH = wmaHalf.length - minLen + i;
      diff.push({ close: 2 * wmaHalf[iH] - wmaFull[iF] });
    }

    return this.wmaRaw(diff, sqrtP);
  }

  private wma(candles: Candle[], period: number): number[] {
    const n = candles.length;
    const result: number[] = [];
    for (let i = period - 1; i < n; i++) {
      let sum = 0, weight = 0;
      for (let j = 0; j < period; j++) {
        const w = j + 1;
        sum += candles[i - (period - 1 - j)].close * w;
        weight += w;
      }
      result.push(sum / weight);
    }
    return result;
  }

  private wmaRaw(items: { close: number }[], period: number): number[] {
    const n = items.length;
    const result: number[] = [];
    for (let i = period - 1; i < n; i++) {
      let sum = 0, weight = 0;
      for (let j = 0; j < period; j++) {
        const w = j + 1;
        sum += items[i - (period - 1 - j)].close * w;
        weight += w;
      }
      result.push(sum / weight);
    }
    return result;
  }

  private calculateBB(
    candles: Candle[],
    period: number,
    mult: number,
  ): { upper: number; middle: number; lower: number } | null {
    const n = candles.length;
    if (n < period) return null;

    const slice = candles.slice(-period);
    const closes = slice.map((c) => c.close);
    const sma = closes.reduce((sum, c) => sum + c, 0) / period;
    const variance = closes.reduce((sum, c) => sum + Math.pow(c - sma, 2), 0) / period;
    const std = Math.sqrt(variance);

    return { upper: sma + mult * std, middle: sma, lower: sma - mult * std };
  }

  private detectCandlePatterns(candles: Candle[]): string[] {
    const patterns: string[] = [];

    for (let i = 0; i < candles.length; i++) {
      const c = candles[i];
      const body = Math.abs(c.close - c.open);
      const range = c.high - c.low;
      if (range === 0) continue;

      const upperWick = c.high - Math.max(c.open, c.close);
      const lowerWick = Math.min(c.open, c.close) - c.low;
      const isBull = c.close > c.open;

      if (body / range < 0.1) {
        patterns.push('Doji');
      } else if (lowerWick > body * 2 && upperWick < body * 0.5) {
        patterns.push(isBull ? 'Hammer' : 'Hanging Man');
      } else if (upperWick > body * 2 && lowerWick < body * 0.5) {
        patterns.push(isBull ? 'Inverted Hammer' : 'Shooting Star');
      } else if (i > 0) {
        const prev = candles[i - 1];
        const prevBull = prev.close > prev.open;
        const prevBody = Math.abs(prev.close - prev.open);
        if (!prevBull && isBull && c.open < prev.close && c.close > prev.open && body > prevBody) {
          patterns.push('Bullish Engulfing');
        } else if (prevBull && !isBull && c.open > prev.close && c.close < prev.open && body > prevBody) {
          patterns.push('Bearish Engulfing');
        }
      }
    }

    return [...new Set(patterns)];
  }

  // ─── Helpers ──────────────────────────────────────────────────────────────

  private lastVal(arr: number[]): number | 'N/A' {
    return arr.length ? round2(arr[arr.length - 1]) : 'N/A';
  }

  // ─── HTTP / parsing ───────────────────────────────────────────────────────

  private async postWithRetry(url: string, body: Record<string, unknown>): Promise<Record<string, any>> {
    const maxAttempts = 4;
    const transientStatuses = [429, 500, 502, 503, 504];
    let lastErr: unknown;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const { data } = await axios.post(url, body, { timeout: 120_000 });
        return data;
      } catch (err: any) {
        lastErr = err;
        const status: number | undefined = err.response?.status;

        if (status !== undefined && !transientStatuses.includes(status)) {
          throw new Error(`Gemini API request failed (${status}): ${JSON.stringify(err.response?.data)}`);
        }

        if (attempt === maxAttempts) break;

        const sleepMs = attempt * 3_000;
        logger.warn('Gemini transient error, retrying', { attempt, status, sleepMs });
        await new Promise((r) => setTimeout(r, sleepMs));
      }
    }

    throw lastErr ?? new Error('Gemini request failed after max attempts');
  }

  private extractText(payload: Record<string, any>): string {
    const text: string = payload?.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
    if (!text) throw new Error('Gemini returned empty text content.');
    return text;
  }

  private formatVnTime(date: Date): string {
    const parts = new Intl.DateTimeFormat('en-GB', {
      day: '2-digit', month: '2-digit', year: 'numeric',
      hour: '2-digit', minute: '2-digit',
      hour12: false, timeZone: 'Asia/Ho_Chi_Minh',
    }).formatToParts(date);
    const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
    return `${get('day')}/${get('month')}/${get('year')} ${get('hour')}:${get('minute')}`;
  }
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
