# AI Trading Signal — Project Context

> Đọc file này trước khi làm bất kỳ việc gì. Đây là nguồn sự thật duy nhất về kiến trúc hệ thống.

---

## Tổng quan

**AI Trading Signal** là hệ thống tự động phân tích kỹ thuật và phát tín hiệu giao dịch cho cặp **XAU/USD (vàng)** sử dụng Google Gemini AI. Hệ thống chạy theo cron 15 phút, lấy dữ liệu nến từ API thị trường, gửi qua Gemini để phân tích đa khung thời gian, lưu kết quả vào SQLite và gửi thông báo qua Telegram.

- **Ngôn ngữ phân tích AI**: Tiếng Việt (prompt ~400 dòng)
- **Khung thời gian phân tích**: H1, M15, M5 (đã bỏ W1, D1, H4)
- **Múi giờ hoạt động**: Asia/Ho_Chi_Minh (6:00 – 22:00)
- **Môi trường**: Node.js + TypeScript, SQLite, chạy trên Windows

---

## Cấu trúc thư mục

```
D:/ai-trading-signal/
├── CLAUDE.md                          ← file này
├── .env                               ← biến môi trường (không commit)
├── .env.example                       ← template cấu hình
├── package.json
├── tsconfig.json
├── prisma/
│   ├── schema.prisma                  ← schema SQLite
│   └── data.db                        ← database thực tế
├── logs/
│   └── signal.log                     ← log file (Winston, rotate 10MB×5)
└── src/
    ├── index.ts                       ← entry point (khởi động scheduler)
    ├── db.ts                          ← Prisma client singleton
    ├── logger.ts                      ← Winston logger (console + file)
    ├── scheduler.ts                   ← Cron */15 * * * * → analyzeSignal()
    ├── config/
    │   └── trading.ts                 ← đọc toàn bộ config từ .env
    ├── commands/
    │   └── analyzeSignal.ts           ← CLI entry: check giờ → orchestrate
    └── services/
        ├── SignalOrchestrator.ts      ← pipeline chính (fetch→AI→DB→Telegram)
        ├── MarketHoursService.ts      ← kiểm tra giờ giao dịch
        ├── ai/
        │   ├── GeminiAnalystService.ts  ← gọi Gemini API, build prompt, parse JSON
        │   └── dto/
        │       └── AnalysisResult.ts    ← kiểu trả về từ AI
        ├── market/
        │   ├── Candle.ts              ← kiểu dữ liệu nến (OHLCV)
        │   ├── MarketDataProvider.ts  ← interface
        │   ├── MarketDataProviderFactory.ts  ← chọn provider theo config
        │   ├── TwelveDataProvider.ts  ← provider mặc định
        │   └── OandaProvider.ts       ← provider thay thế
        └── telegram/
            └── TelegramNotifier.ts   ← format + gửi tín hiệu lên Telegram
```

---

## Tech Stack

| Layer | Công nghệ |
|-------|-----------|
| Runtime | Node.js (CommonJS) |
| Language | TypeScript 5.6 |
| Database | SQLite via Prisma 5.22 |
| AI | Google Gemini (gemini-2.0-flash) |
| Market Data | TwelveData (default) / OANDA |
| Notification | Telegram Bot API |
| Scheduler | node-cron |
| Logging | Winston |
| HTTP Client | axios |

---

## Luồng dữ liệu

```
[Cron mỗi 15 phút]
       ↓
[analyzeSignal.ts]  → kiểm tra giờ thị trường (6-22h VN)
       ↓
[SignalOrchestrator.run()]
       ├─ MarketDataProvider.fetchCandles(XAU/USD, H1/M15/M5, 100 nến)
       ├─ MarketDataProvider.fetchCurrentPrice()
       ↓
[GeminiAnalystService.analyze()]
       ├─ Tính chỉ báo: RSI(14), EMA(200), HMA(200), BB(34,2.0)
       ├─ Build system prompt (tiếng Việt, ICT/SMC methodology)
       ├─ Build user prompt (bảng nến markdown)
       ├─ POST Gemini API (temperature=0.2, maxTokens=8192)
       ├─ Parse JSON từ response (```json block hoặc fallback search)
       └─ Trả về AnalysisResult
       ↓
[Prisma] → lưu TradingSignal vào SQLite
       ↓
[TelegramNotifier]
       ├─ formatSignal() → HTML card
       ├─ send() → kênh Telegram chính (auto-split nếu >4000 ký tự)
       └─ sendComment() → discussion thread (nếu có BUY/SELL)
```

---

## Database Schema

**Bảng `trading_signals`:**

| Cột | Kiểu | Mô tả |
|-----|------|-------|
| id | INT PK | Auto increment |
| instrument | STRING | "XAU/USD" |
| action | STRING | "BUY" / "SELL" / "NO_TRADE" |
| timeframe | STRING | "M5" |
| entry | FLOAT | Giá vào lệnh |
| stop_loss | FLOAT | Điểm dừng lỗ |
| take_profit | FLOAT | Chốt lời (TP1) |
| risk_reward | FLOAT | Tỷ lệ R:R (vd: 2.0 = 1:2) |
| confidence | INT | Độ tin cậy AI (0-100) |
| current_price | FLOAT | Giá thị trường lúc phân tích |
| reasoning | STRING | Lý luận AI |
| trend_bias | STRING | "BULLISH" / "BEARISH" / "NEUTRAL" |
| raw_ai_response | STRING | Toàn bộ JSON từ Gemini |
| indicators_snapshot | STRING | Nến + metadata JSON |
| telegram_message_id | STRING | ID tin nhắn Telegram |
| sent_at | DATETIME | Thời điểm gửi |
| created_at | DATETIME | Thời điểm tạo |

Index: `(instrument, created_at)`

---

## Cấu hình (.env)

```env
# Database
DATABASE_URL="file:./prisma/data.db"

# Logging
LOG_LEVEL=info

# Market Data
MARKET_PROVIDER=twelvedata          # hoặc "oanda"
TRADING_INSTRUMENT=XAU/USD
TRADING_TIMEFRAMES=M5,M15,H1        # khung thời gian phân tích
TRADING_CANDLES_COUNT=100
TRADING_MIN_RR=2.0

# Market Hours (Asia/Ho_Chi_Minh)
MARKET_HOURS_OPEN=6
MARKET_HOURS_CLOSE=22
MARKET_HOURS_TIMEZONE=Asia/Ho_Chi_Minh

# API Keys
TWELVEDATA_API_KEY=...
OANDA_API_TOKEN=...
OANDA_ACCOUNT_ID=...
OANDA_ENV=practice                  # hoặc "live"
GEMINI_API_KEY=...
GEMINI_MODEL=gemini-2.0-flash       # hoặc gemini-2.5-flash-lite, gemini-1.5-pro
TELEGRAM_BOT_TOKEN=...
TELEGRAM_CHAT_ID=...
TELEGRAM_DISCUSSION_ID=...          # ID nhóm discussion (auto-resolve nếu để trống)
```

---

## NPM Scripts

```bash
npm run dev            # chạy tsx watch (development)
npm start              # chạy compiled JS (production)
npm run build          # biên dịch TypeScript → dist/
npm run analyze        # chạy 1 lần (có check giờ)
npm run analyze:force  # chạy 1 lần (bỏ qua check giờ)
npm run db:generate    # generate Prisma client
npm run db:push        # sync schema → DB
npm run db:migrate     # chạy migration
```

---

## GeminiAnalystService — Chi tiết quan trọng

**File:** `src/services/ai/GeminiAnalystService.ts`

**Prompt strategy (3 bước):**
1. Phân tích kỹ thuật độc lập từng khung (H1 → M15 → M5)
2. Review lệnh cũ (nếu có)
3. Quyết định tổng thể (BUY / SELL / NO_TRADE)

**Cấu trúc prompt phân tích (mục 1A trở đi):**
- `1A. CẤU TRÚC THỊ TRƯỜNG` — H1, M15, M5 (đã bỏ W1/D1/H4)
- `1B. VÙNG CUNG CẦU & KEY LEVELS`
- `1C. CHỈ BÁO KỸ THUẬT`
- `2. QUYẾT ĐỊNH GIAO DỊCH`
- `3. KẾ HOẠCH QUẢN LÝ LỆNH`

**JSON output từ AI:**
```json
{
  "action": "BUY|SELL|NO_TRADE",
  "entry": 2343.00,
  "stop_loss": 2340.00,
  "take_profit": 2350.00,
  "risk_reward": 2.33,
  "confidence": 82,
  "trend_bias": "BULLISH|BEARISH|NEUTRAL",
  "reasoning": "..."
}
```

**Retry logic:** 4 lần, sleep 3s/6s/9s, trigger khi status 429/500/502/503/504

---

## TelegramNotifier — Chi tiết quan trọng

**File:** `src/services/telegram/TelegramNotifier.ts`

- Gửi signal card dạng HTML (không dùng Markdown)
- Auto-split tin nhắn >4000 ký tự
- Discussion thread: tự resolve DISCUSSION_ID nếu chưa set
- Chuyển đổi markdown AI → HTML Telegram (bảng, bold, italic, bullet)
- Thanh confidence: `████████░░` (10 ký tự)

**Format signal card:**
```
━━━━━━━━━━━━━━━━━━━━━
📊 XAU/USD  🟢 MUA (BUY)
━━━━━━━━━━━━━━━━━━━━━
🕐 14/05/2026 10:30 (Giờ VN)
💵 Giá hiện tại: 2343.50
📐 Xu hướng: 📈 Tăng
─ Thông số lệnh ─────────────
🎯 Entry:      2343.00
🛡 Stop Loss:  2340.00
💰 Take Profit: 2350.00
⚖️ R:R:        1 : 2.33
─ Đánh giá AI ───────────────
🔎 Độ tin cậy: 82/100
████████░░
━━━━━━━━━━━━━━━━━━━━━
⚠️ Tín hiệu tham khảo từ AI, không phải lời khuyên đầu tư.
```

---

## Market Data Providers

### TwelveData (default)
```
GET https://api.twelvedata.com/time_series
  ?symbol=XAU/USD&interval=5min&outputsize=100&order=ASC&apikey=...

GET https://api.twelvedata.com/price?symbol=XAU/USD&apikey=...
```
Retry: 2 lần, delay 500ms

### OANDA (thay thế)
```
GET https://api-fxpractice.oanda.com/v3/instruments/XAU_USD/candles
  ?granularity=M5&count=100&price=M
  Authorization: Bearer ...
```

---

## Các Pattern kiến trúc

- **Factory Pattern**: `MarketDataProviderFactory` chọn provider theo config
- **Strategy Pattern**: TwelveData / OANDA cùng implement interface `MarketDataProvider`
- **Static factory methods**: `Service.fromConfig()` thay vì DI container
- **DTO**: `AnalysisResult` bọc output từ AI
- **Retry với backoff**: Gemini và TwelveData đều có retry riêng

---

## Quy tắc quan trọng khi sửa code

1. **Khung thời gian**: Hệ thống hiện dùng H1, M15, M5 — KHÔNG thêm lại W1/D1/H4 trừ khi được yêu cầu rõ ràng
2. **Ngôn ngữ prompt**: Prompt AI viết bằng tiếng Việt — giữ nguyên
3. **Database**: Dùng Prisma — không dùng raw SQL
4. **Telegram**: Dùng HTML parse_mode — không dùng MarkdownV2
5. **Config**: Mọi giá trị cứng phải lấy từ `src/config/trading.ts`, không hardcode
6. **Logging**: Dùng `logger` từ `src/logger.ts`, không dùng `console.log`
