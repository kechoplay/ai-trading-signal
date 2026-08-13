# AI Trading Signal — Project Context

> Đọc file này trước khi làm bất kỳ việc gì. Đây là nguồn sự thật duy nhất về kiến trúc hệ thống.

---

## Tổng quan

**AI Trading Signal** là hệ thống phân tích kỹ thuật và phát tín hiệu giao dịch cho **XAU/USD (vàng)** và các cặp **crypto (BTC/USD, ETH/USD…)** sử dụng Claude AI (Anthropic). Hệ thống lấy dữ liệu nến từ API thị trường, gửi qua Claude để phân tích đa khung thời gian, lưu kết quả vào SQLite và gửi thông báo qua Telegram. Phân tích được trigger theo hai đường: **scheduler nội bộ** (mặc định mỗi 15 phút, 8h–22h, T2–T6 giờ VN) và **thủ công** qua REST API / dashboard. Không dùng cron của OS — scheduler chạy trong process server.

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
    │   └── docs.html                  ← trang tài liệu
    └── services/
        ├── SignalOrchestrator.ts      ← pipeline chính (fetch→AI→Telegram)
        ├── AnalysisRunner.ts          ← orchestrator + lưu DB + single-flight lock
        ├── AnalysisScheduler.ts       ← tự chạy theo chu kỳ (15p, 8h–22h, T2–T6)
        ├── MarketHoursService.ts      ← kiểm tra giờ giao dịch
        ├── ai/
        │   ├── ClaudeAnalystService.ts  ← gọi Claude (build prompt vàng/crypto, parse text)
        │   ├── UsageTracker.ts           ← giữ token + hạn mức của lượt gần nhất (RAM)
        │   ├── transport/               ← lớp gọi LLM (API key hoặc subscription)
        │   │   ├── LlmTransport.ts        ← interface chung
        │   │   ├── AnthropicApiTransport.ts ← CLAUDE_API_KEY (messages.stream)
        │   │   └── ClaudeSubscriptionTransport.ts ← subscription qua Claude Agent SDK
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
[AnalysisScheduler]  (mỗi 15p, 8h–22h, T2–T6)   [POST /api/analyze]  (bấm tay)
       └──────────────────┬─────────────────────────────┘
                          ↓
[runAnalysis()]  ← AnalysisRunner: đường DUY NHẤT có lưu DB
       │  single-flight: đang chạy thì lượt/request thứ 2 bị chặn (scheduler bỏ lượt,
       │  API trả 409) — một lượt mất ~3 phút và tiêu quota subscription dùng chung
       ↓
[SignalOrchestrator.run(instrument?, timeframes?, analysisType?)]
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
[Prisma] → lưu TradingSignal + AnalysisLog vào SQLite (trong AnalysisRunner, KHÔNG
       phải trong route — scheduler cần bản ghi này để carry-forward hoạt động)
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

**Bảng `analysis_logs`** (mỗi lượt chạy 1 bản ghi): ngoài `symbol/duration_ms/setup/reasoning` còn có
`input_tokens`, `output_tokens`, `cache_read_tokens`, `cache_write_tokens` — token của lượt gọi Claude,
null với bản ghi cũ hoặc khi transport không báo cáo. `/api/usage` cộng dồn 4 cột này theo ngày.

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
TRADING_MIN_RR=1.0

# Market Hours (Asia/Ho_Chi_Minh)
MARKET_HOURS_OPEN=6
MARKET_HOURS_CLOSE=22
MARKET_HOURS_TIMEZONE=Asia/Ho_Chi_Minh

# Scheduler — tự chạy phân tích intraday theo chu kỳ (dùng MARKET_HOURS_TIMEZONE)
SCHEDULER_ENABLED=true
SCHEDULER_INTERVAL_MIN=15           # mốc canh theo đồng hồ :00/:15/:30/:45
SCHEDULER_START_HOUR=8
SCHEDULER_END_HOUR=22               # 22 = lượt cuối 21:45
SCHEDULER_WEEKDAYS=1,2,3,4,5        # 1=T2 … 5=T6 (0=CN, 6=T7)
SCHEDULER_SYMBOLS=                  # trống = TRADING_INSTRUMENT
SCHEDULER_OFFSET_SEC=0

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

**Prompt vàng — hai cơ chế quyết định việc ra ORDER (đọc kỹ trước khi sửa HARD GATE):**
- **HAI CHẾ ĐỘ VÀO LỆNH** (HARD GATE 2): `LIVE CONFIRM` (giá đã ở POI + M5 đã confirm) **hoặc** `LIMIT-CHỜ-POI` (POI fresh, entry dự kiến qua Gate 1 + Gate 3, cách giá hiện tại ≤ 1× ATR H1, có invalidation body-close → xuất ORDER lệnh chờ, tự hạ 1 bậc confidence). Lý do tồn tại: phân tích chạy rời rạc theo lần bấm nút, nếu bắt buộc live-confirm thì cửa sổ chỉ 1–2 nến M5 → gần như luôn trượt về WATCHLIST. WATCHLIST giờ chỉ dùng khi KHÔNG thỏa cả hai chế độ.
- **HARD GATE 1 đo tại GIÁ VÀO LỆNH DỰ KIẾN**, không phải giá hiện tại — nếu không, giá hiện tại ở premium sâu sẽ chặn oan một lệnh BUY có entry nằm ở POI discount.
- **HARD GATE 1 đo trên DEALING RANGE, không phải range 80 nến.** `RangeFib` trong `IctPreprocessor` lấy high/low của lookback cố định (H1 = 80 nến ≈ 3 ngày vàng) — dùng range macro ~120 USD đó làm mẫu số cho entry scalp SL 6–12 USD là sai đơn vị đo, mọi pullback nông trong leg tăng đều thành "premium >60%" và bị chặn oan. Mẫu số chính thức là `activeLeg` (`findActiveLeg()`): nhịp từ pivot đối nghịch gần nhất tới cực trị hiện tại, tự mở rộng khi giá vượt pivot cũ. Fallback về range mở rộng khi `activeLeg = null` hoặc `sizeAtr < 1` (leg nhỏ hơn 1× ATR = nhiễu). Range mở rộng vẫn gửi vào prompt làm bối cảnh + chọn mục tiêu thanh khoản xa, nhưng KHÔNG dùng để chặn lệnh. **Lưu ý: prompt crypto chưa áp dụng — vẫn dùng luật EQ trên range mở rộng.**
- **THANG TP HAI TẦNG**: `TP chốt non` (mức thanh khoản/rào cản gần nhất, chốt 40–50% + dời breakeven, **không** bị Gate 3 ràng buộc) và `TP1 chính` (mục tiêu thật — **HARD GATE 3 đo RR trên mức này**). Cổng 3 phân loại rào cản nghịch hướng: **CỨNG** (fresh, chưa bị body close xuyên, khung ≥M15, **và dày ≥0.25× ATR H1** → bắt buộc lùi TP1) vs **MỀM** (đã mitigated / đã bị xuyên / chỉ khung M5 / **mỏng <0.25× ATR H1** → không chặn TP1, chỉ đặt chốt non trước nó). Tiêu chí độ dày thêm vào 13/08/2026: một FVG rộng <0.25× ATR H1 không phải bức tường, để nó chặn TP1 thì mọi scalp có FVG mỏng nằm giữa đường đều bị bóp RR và loại oan.
- Parser lấy `take_profit`/`risk_reward` từ dòng chứa token `TP1` **đầu tiên** trong block ORDER — dòng `TP chốt non` cố ý không chứa token đó nên không bị bắt nhầm. Đổi nhãn TP trong prompt phải kiểm lại `extractPriceFromLine(section, 'tp1')`.

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

**409 Conflict** khi scheduler (hoặc một request khác) đang chạy phân tích — single-flight trong `AnalysisRunner`, không bao giờ có 2 lượt song song.

### GET /api/scheduler

Trạng thái scheduler: `enabled`, `interval_min`, `window`, `weekdays`, `symbols`, `runs_per_day`, `next_run_at`, `last_run_at`, `last_action`, `last_error`, `run_count`, `skip_count`, `running` (lượt đang chạy hoặc null). Dùng để soi mốc chạy kế tiếp và lỗi gần nhất mà không cần đọc log.

### GET /api/usage

Token đã dùng + hạn mức còn lại. Không yêu cầu API key (dashboard tự gọi mỗi 60s).

```json
{
  "today":      { "since": "...", "runs": 12, "input_tokens": 604000, "output_tokens": 148000,
                  "cache_read_tokens": 52000, "cache_write_tokens": 0 },
  "last_run":   { "symbol": "XAU/USD", "at": "...", "duration_ms": 182000, "usage": { ... } },
  "rate_limit": { "inputTokensRemaining": 180000, "inputTokensLimit": 2000000, "...": "..." },
  "auth_mode":  "apikey"
}
```

- `today.*`: cộng dồn từ cột token trong `analysis_logs` (giờ VN).
- `rate_limit`: ảnh chụp hạn mức của lượt gọi Claude GẦN NHẤT, giữ trong RAM
  (`src/services/ai/UsageTracker.ts`) — **null cho tới lượt phân tích đầu tiên sau khi khởi động server**.
  Là union phân biệt bằng `source`, hai đường xác thực cho hai loại số liệu KHÁC HẲN nhau:

| `source` | Nguồn | Nội dung |
|----------|-------|----------|
| `api-headers` | Header `anthropic-ratelimit-*` của Messages API (`AI_AUTH_MODE=apikey`) | Còn bao nhiêu **token/request tuyệt đối** + mốc reset |
| `subscription` | Message `rate_limit_event` của Claude Agent SDK (`AI_AUTH_MODE=subscription`) | **% đã dùng** của cửa sổ (`five_hour`/`seven_day`/`seven_day_opus`…) + mốc reset — Anthropic KHÔNG cho biết số token còn lại của gói |

  Subscription: SDK chỉ phát `rate_limit_event` khi thông tin thay đổi → có lượt không có event, khi đó
  `UsageTracker` giữ nguyên số liệu lần trước (chỉ ghi đè khi lượt mới thực sự đo được).

### GET /api/signals

Lấy danh sách tín hiệu trong ngày (giờ VN). Query param: `?limit=20` (tối đa 100).

### GET /api/symbols / POST /api/symbols / DELETE /api/symbols/:symbol

CRUD danh sách symbol theo dõi.

### GET /api/groups / POST /api/groups / DELETE /api/groups/:id

CRUD nhóm symbol.

### GET /api/symbols/:symbol/signals

Lấy analysis logs của symbol trong ngày — kèm `input_tokens`, `output_tokens`, `cache_read_tokens`,
`cache_write_tokens` (null với bản ghi cũ). Modal "Tín hiệu từ Claude" ở `/chart` hiển thị badge token
trên từng bản ghi + dải tổng token trong ngày.

---

## Web Dashboard — Chi tiết quan trọng

**File:** `public/index.html` (intraday) — phục vụ static qua Express.

- Nút **⚡ Phân tích XAU** → `POST /api/analyze {}`; nút **₿ Phân tích BTC** → `POST /api/analyze { symbol: "BTC/USD" }`. Hàm chung `runAnalyze(btnId, symbol?)`.
- API key lưu ở `localStorage`; nếu server trả 401 sẽ prompt nhập key rồi thử lại.
- `renderSignalBanner()` hiển thị badge theo action: BUY/SELL/WATCHLIST (`👁 ĐANG CANH`)/NO_TRADE. Hàng Entry/SL/TP chỉ hiện cho BUY/SELL.
- `renderConditionalSetups()` hiển thị chi tiết WATCHLIST (POI đang canh) — đọc `conditional_setups` từ `raw_ai_response` (server `parseSignal()` bóc ra).
- `renderUsage()` (thanh `#usageRow` dưới header) hiển thị token in/out trong ngày + hạn mức còn lại — đọc `GET /api/usage`. Tô cam khi còn ≤30%, đỏ khi ≤10%.
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

1. **Khung thời gian**: Intraday dùng H4 (context), H1, M15, M5 — thứ tự gửi nến do `tfOrder` trong `ClaudeAnalystService` quyết định.
2. **Ngôn ngữ prompt**: Prompt AI viết bằng tiếng Việt — giữ nguyên. Vàng dùng từ vựng BUY/SELL, crypto dùng LONG/SHORT — khi sửa parser phải giữ map LONG→BUY, SHORT→SELL.
3. **Database**: Dùng Prisma — không dùng raw SQL. Sau mỗi thay đổi schema (`prisma/schema.prisma`), bắt buộc chạy:
   ```bash
   npx prisma generate   # cập nhật Prisma Client
   npx prisma db push    # sync schema → DB (dev) hoặc db:migrate (prod)
   ```
4. **Telegram**: Dùng HTML parse_mode — không dùng MarkdownV2
5. **Config**: Mọi giá trị cứng phải lấy từ `src/config/trading.ts`, không hardcode
6. **Logging**: Dùng `logger` từ `src/logger.ts`, không dùng `console.log`
7. **Chạy phân tích**: Mọi đường trigger mới PHẢI gọi `runAnalysis()` trong `AnalysisRunner.ts`, không gọi thẳng `SignalOrchestrator.run()` — nếu không sẽ gửi Telegram mà không lưu DB, làm carry-forward và dashboard mất dữ liệu (lỗi này còn tồn tại ở `mcp-server.ts:133`).
8. **Quota subscription**: Một lượt phân tích tiêu ~50k input + ~12k output token và mất ~3 phút (Opus 5, effort=high), dùng CHUNG hạn mức với session Claude Code. Trước khi hạ `SCHEDULER_INTERVAL_MIN` xuống dưới 15 hoặc mở rộng khung giờ, tính lại số lượt/ngày (`runs_per_day` trong `/api/scheduler`) và kiểm `/usage`.
