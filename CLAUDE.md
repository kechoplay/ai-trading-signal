# AI Trading Signal — Project Context

> Đọc file này trước khi làm bất kỳ việc gì. Đây là nguồn sự thật duy nhất về kiến trúc hệ thống.

---

## Tổng quan

**AI Trading Signal** là hệ thống phân tích kỹ thuật và phát tín hiệu giao dịch cho **XAU/USD (vàng)** và các cặp **crypto (BTC/USD, ETH/USD…)** sử dụng Claude AI (Anthropic). Hệ thống lấy dữ liệu nến từ API thị trường, gửi qua Claude để phân tích đa khung thời gian, lưu kết quả vào SQLite và gửi thông báo qua Telegram. Phân tích được trigger thủ công qua REST API / dashboard (không dùng cron).

- **Ngôn ngữ phân tích AI**: Tiếng Việt
- **Khung thời gian phân tích**: Vàng dùng H4 (context), H1 (bias), M15 (POI), M5 (entry). Crypto dùng bộ khung riêng từ M15: D (context), H4 (bias), H1 (POI), M15 (entry) — cấu hình qua `TRADING_CRYPTO_TIMEFRAMES`, áp dụng khi instrument là crypto và request không truyền timeframes.
- **Tài sản hỗ trợ**: Vàng (prompt scalp ICT/SMC, từ vựng BUY/SELL) và crypto (prompt riêng, từ vựng LONG/SHORT → map về BUY/SELL). Provider tự động chọn `exchange=Binance` cho cặp crypto.
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
    ├── index.ts                       ← entry point (khởi động server)
    ├── server.ts                      ← Express REST API server
    ├── db.ts                          ← Prisma client singleton
    ├── logger.ts                      ← Winston logger (console + file)
    ├── config/
    │   └── trading.ts                 ← đọc toàn bộ config từ .env
    ├── commands/
    │   └── analyzeSignal.ts           ← CLI entry: check giờ → orchestrate
    ├── public/                        ← dashboard tĩnh (Express static)
    │   ├── index.html                 ← bảng tín hiệu intraday + nút phân tích XAU / BTC
    │   ├── longterm.html              ← bảng tín hiệu dài hạn (W/D/H4)
    │   └── docs.html                  ← trang tài liệu
    └── services/
        ├── SignalOrchestrator.ts      ← pipeline chính (fetch→AI→DB→Telegram)
        ├── MarketHoursService.ts      ← kiểm tra giờ giao dịch
        ├── ai/
        │   ├── ClaudeAnalystService.ts  ← gọi Claude API, build prompt (vàng/crypto), parse text
        │   ├── LongTermAnalystService.ts ← prompt swing W/D/H4 (override tfOrder)
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
| AI | Claude (Anthropic, claude-sonnet-4-6) |
| Market Data | TwelveData (default) / OANDA |
| Notification | Telegram Bot API |
| Logging | Winston |
| HTTP Client | axios |

---

## Luồng dữ liệu

```
[POST /api/analyze]  (symbol tùy chọn — XAU/USD hoặc BTC/USD…)
       ↓
[SignalOrchestrator.run(instrument?, timeframes?)]
       │  timeframes: dùng tham số nếu có, fallback về TRADING_TIMEFRAMES trong .env
       ├─ MarketDataProvider.fetchCandles(symbol, H4/H1/M15/M5)  (crypto → exchange=Binance)
       ├─ MarketDataProvider.fetchCurrentPrice()
       ↓
[ClaudeAnalystService.analyze(instrument, …)]
       ├─ Chọn prompt theo instrument: vàng (buildGoldSystemPrompt) hoặc crypto (buildCryptoSystemPrompt)
       ├─ Build user prompt (bảng nến CSV theo tfOrder H4→H1→M15→M5)
       ├─ Stream Claude API (thinking adaptive, max_tokens 64000)
       ├─ Parse TEXT (regex) → action BUY/SELL/NO_TRADE/WATCHLIST
       │    LONG→BUY, SHORT→SELL; WATCHLIST = canh setup, chưa vào lệnh
       └─ Trả về AnalysisResult (+ conditionalSetups)
       ↓
[Prisma] → lưu TradingSignal vào SQLite (raw_ai_response chứa conditional_setups)
       ↓
[TelegramNotifier]
       ├─ formatSignalCard() → HTML card (badge BUY/SELL/WATCHLIST/NO_TRADE)
       ├─ send() → kênh Telegram chính (auto-split nếu >4000 ký tự)
       └─ sendComment() → discussion thread
```

---

## Database Schema

**Bảng `trading_signals`:**

| Cột | Kiểu | Mô tả |
|-----|------|-------|
| id | INT PK | Auto increment |
| instrument | STRING | "XAU/USD" |
| action | STRING | "BUY" / "SELL" / "NO_TRADE" / "WATCHLIST" |
| timeframe | STRING | "M5" |
| entry | FLOAT | Giá vào lệnh |
| stop_loss | FLOAT | Điểm dừng lỗ |
| take_profit | FLOAT | Chốt lời (TP1) |
| risk_reward | FLOAT | Tỷ lệ R:R (vd: 2.0 = 1:2) |
| confidence | INT | Độ tin cậy AI (0-100) |
| current_price | FLOAT | Giá thị trường lúc phân tích |
| reasoning | STRING | Lý luận AI |
| trend_bias | STRING | "BULLISH" / "BEARISH" / "NEUTRAL" |
| raw_ai_response | STRING | JSON `{ conditional_setups, … }` — dùng để web hiển thị chi tiết WATCHLIST/kịch bản |
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
TRADING_TIMEFRAMES=H4,H1,M15,M5    # H4 context → M5 entry
TRADING_CANDLES_COUNT=214
TRADING_CANDLES_H4=30               # H4 chỉ làm context → ít nến
TRADING_CANDLES_H1=214
TRADING_CANDLES_M15=240
TRADING_CANDLES_M5=180
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
CLAUDE_API_KEY=...
CLAUDE_MODEL=claude-sonnet-4-6      # hoặc claude-opus-4-8, claude-haiku-4-5
TELEGRAM_BOT_TOKEN=...
TELEGRAM_CHAT_ID=...
TELEGRAM_DISCUSSION_ID=...          # ID nhóm discussion (auto-resolve nếu để trống)

# API Server
PORT=3000
API_SERVER_KEY=...                  # để trống = không yêu cầu auth
```

---

## NPM Scripts

```bash
npm run dev            # chạy tsx watch (development)
npm start              # chạy compiled JS (production)
npm run build          # biên dịch TypeScript → dist/
npm run analyze        # chạy phân tích 1 lần (có check giờ)
npm run analyze:force  # chạy phân tích 1 lần (bỏ qua check giờ)
npm run db:generate    # generate Prisma client
npm run db:push        # sync schema → DB
npm run db:migrate     # chạy migration
```

---

## ClaudeAnalystService — Chi tiết quan trọng

**File:** `src/services/ai/ClaudeAnalystService.ts`

**Chọn prompt theo instrument** (`buildSystemPrompt(instrument)`):
- `isCryptoInstrument()` (BTC/ETH/BNB/SOL/XRP/ADA/DOGE/LTC) → `buildCryptoSystemPrompt()` (từ vựng LONG/SHORT, SL/TP theo % + ATR, 24/7, liquidity sweep).
- Còn lại → `buildGoldSystemPrompt()` (trader scalp XAU/USD, từ vựng BUY/SELL, SL/TP theo USD, kill zone London/NY, có trạng thái WATCHLIST).

**Output là TEXT markdown (KHÔNG phải JSON)** — parse bằng regex, không dùng `JSON.parse`:
- `extractAction()` trả về `BUY | SELL | NO_TRADE | WATCHLIST`. Thứ tự ưu tiên: ORDER block thật → `#### WATCHLIST` → dòng `Best opportunity:` trong SUMMARY.
- `dirToAction()`: **LONG→BUY, SHORT→SELL** (crypto dùng LONG/SHORT, hệ thống lưu BUY/SELL).
- `WATCHLIST` = setup đang hình thành, chưa đủ điều kiện vào lệnh → không có entry/SL/TP; thông tin "POI đang canh" nằm trong `conditionalSetups`.
- Các hằng số parser dùng chung: `DIR_LABEL` (`BUY ORDER|LONG`, `SELL ORDER|SHORT`), `DIR_BOUNDARY`.

**Block ORDER mẫu (vàng):**
```
#### [BUY ORDER / SELL ORDER]
- Nhãn dòng H4: THUẬN dòng / NGƯỢC dòng
- Entry zone / SL / TP1-3 / Confidence / Hủy lệnh nếu
```

**Streaming:** dùng `messages.stream()` (thinking adaptive, max_tokens 64000), `maxRetries: 4`, SDK timeout 10 phút; undici dispatcher đặt timeout = 0 (vô hạn) để stream dài không bị ngắt.

---

## REST API Server — Chi tiết quan trọng

**File:** `src/server.ts`

Chạy cùng process với scheduler (qua `src/index.ts`), lắng nghe port `PORT` (mặc định 3000).

**Authentication:** Header `x-api-key` hoặc `Authorization: Bearer <key>`. Bỏ qua nếu `API_SERVER_KEY` không set.

### POST /api/analyze

Trigger phân tích thủ công.

**Request body:**
```json
{
  "symbol":     "XAU/USD",          // tùy chọn — mặc định TRADING_INSTRUMENT
  "timeframes": ["H1", "M15"]       // tùy chọn — mặc định TRADING_TIMEFRAMES
}
```

`timeframes` chấp nhận cả array `["H1","M15"]` lẫn string phân cách phẩy `"H1,M15"`. Nếu không truyền, dùng timeframes trong `.env`.

**Response:**
```json
{
  "ok": true,
  "symbol": "XAU/USD",
  "duration_ms": 4200,
  "setup": "<HTML signal card>",
  "reasoning": "<HTML analysis>"
}
```

### GET /api/signals

Lấy danh sách tín hiệu trong ngày (giờ VN). Query param: `?limit=20` (tối đa 100).

### GET /api/symbols / POST /api/symbols / DELETE /api/symbols/:symbol

CRUD danh sách symbol theo dõi.

### GET /api/groups / POST /api/groups / DELETE /api/groups/:id

CRUD nhóm symbol.

### GET /api/symbols/:symbol/signals

Lấy analysis logs của symbol trong ngày.

---

## Web Dashboard — Chi tiết quan trọng

**File:** `public/index.html` (intraday), `public/longterm.html` (dài hạn) — phục vụ static qua Express.

- Nút **⚡ Phân tích XAU** → `POST /api/analyze {}`; nút **₿ Phân tích BTC** → `POST /api/analyze { symbol: "BTC/USD" }`. Hàm chung `runAnalyze(btnId, symbol?)`.
- API key lưu ở `localStorage`; nếu server trả 401 sẽ prompt nhập key rồi thử lại.
- `renderSignalBanner()` hiển thị badge theo action: BUY/SELL/WATCHLIST (`👁 ĐANG CANH`)/NO_TRADE. Hàng Entry/SL/TP chỉ hiện cho BUY/SELL.
- `renderConditionalSetups()` hiển thị chi tiết WATCHLIST (POI đang canh) — đọc `conditional_setups` từ `raw_ai_response` (server `parseSignal()` bóc ra).
- Tự refresh mỗi 60s.

---

## TelegramNotifier — Chi tiết quan trọng

**File:** `src/services/telegram/TelegramNotifier.ts`

- Gửi signal card dạng HTML (không dùng Markdown)
- Badge action: 🟢 MUA / 🔴 BÁN / 👁 ĐANG CANH (WATCHLIST) / ⚪ KHÔNG VÀO LỆNH
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

# Cặp crypto tự thêm exchange=Binance (cryptoExchange() trong TwelveDataProvider)
GET https://api.twelvedata.com/time_series
  ?symbol=BTC/USD&interval=5min&order=ASC&exchange=Binance&apikey=...

GET https://api.twelvedata.com/price?symbol=XAU/USD&apikey=...
```
Retry: 2 lần, delay 500ms. `exchange` chỉ gửi khi instrument là crypto (vàng KHÔNG kèm exchange).

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

1. **Khung thời gian**: Intraday dùng H4 (context), H1, M15, M5 — thứ tự gửi nến do `tfOrder` trong `ClaudeAnalystService` quyết định. Long-term (W/D/H4) do `LongTermAnalystService` xử lý riêng.
2. **Ngôn ngữ prompt**: Prompt AI viết bằng tiếng Việt — giữ nguyên. Vàng dùng từ vựng BUY/SELL, crypto dùng LONG/SHORT — khi sửa parser phải giữ map LONG→BUY, SHORT→SELL.
3. **Database**: Dùng Prisma — không dùng raw SQL. Sau mỗi thay đổi schema (`prisma/schema.prisma`), bắt buộc chạy:
   ```bash
   npx prisma generate   # cập nhật Prisma Client
   npx prisma db push    # sync schema → DB (dev) hoặc db:migrate (prod)
   ```
4. **Telegram**: Dùng HTML parse_mode — không dùng MarkdownV2
5. **Config**: Mọi giá trị cứng phải lấy từ `src/config/trading.ts`, không hardcode
6. **Logging**: Dùng `logger` từ `src/logger.ts`, không dùng `console.log`
