# AI Trading Signal — Project Context

> Đọc file này trước khi làm bất kỳ việc gì. Đây là nguồn sự thật duy nhất về kiến trúc hệ thống.

---

## Tổng quan

**AI Trading Signal** là hệ thống phân tích kỹ thuật và phát tín hiệu giao dịch cho **XAU/USD (vàng)** và các cặp **crypto (BTC/USD, ETH/USD…)** sử dụng Claude AI (Anthropic). Hệ thống lấy dữ liệu nến từ API thị trường, gửi qua Claude để phân tích đa khung thời gian, lưu kết quả vào SQLite và gửi thông báo qua Telegram. Phân tích được trigger theo ba đường: **scheduler nội bộ** theo đồng hồ (`SCHEDULER_INTERVAL_MIN`, 8h–22h, T2–T6 giờ VN), **SetupWatcher** theo sự kiện (chuỗi sweep → CHoCH có displacement → retest, dò cơ học mỗi 5 phút) và **thủ công** qua REST API / dashboard. Ngoài tín hiệu intraday còn có **kế hoạch ngày** cho vàng + BTC/ETH (`DailyPlanScheduler`, 7h/11h/15h/19h T2–T6) — plan bias + kịch bản, không ra lệnh. **Crypto chạy cả T7/CN** (thêm 27/10/2026): `SCHEDULER_CRYPTO_WEEKDAYS` / `DAILY_PLAN_CRYPTO_WEEKDAYS` (mặc định `0,1,2,3,4,5,6`) thay `*_WEEKDAYS` cho symbol crypto ở cả scheduler intraday, SetupWatcher lẫn daily plan — cuối tuần mỗi mốc chỉ chạy symbol crypto, vàng nghỉ; khung giờ vẫn chung. Không dùng cron của OS — scheduler chạy trong process server.

- **Ngôn ngữ phân tích AI**: Tiếng Việt
- **Khung thời gian phân tích**: Vàng dùng D (bối cảnh nhiều ngày — chỉ facts, không phải cổng, không đổi confidence; prompt ghi "Context D", không "Bias D" vì `extractBias` lấy dòng `Bias …:` đầu tiên), H4 (context — thuận/ngược dòng), H1 (bias + POI lớn), M15 (POI + entry/confirmation) — bỏ M5 + thêm D từ 27/10/2026 (`TRADING_TIMEFRAMES=D,H4,H1,M15`, nến D/H4 = `TRADING_CANDLES_D`/`_H4` 120 (H4 trước là 30 — không đủ cho lookback 80/ATR nền 96), +1 request TwelveData/lượt, nến thô M15 = `CLAUDE_RAW_CANDLES_M15` 60; đệm SL ≥0.5× ATR M15 ≈ biên độ 1× ATR M5 cũ; impulsive leg / "≥30 nến" đo trên M15). Crypto dùng bộ khung riêng từ M15: D (context), H4 (bias), H1 (POI), M15 (entry) — cấu hình qua `TRADING_CRYPTO_TIMEFRAMES`, áp dụng khi instrument là crypto và request không truyền timeframes.
- **Tài sản hỗ trợ**: Vàng (prompt scalp ICT/SMC, từ vựng BUY/SELL) và crypto (prompt riêng, từ vựng LONG/SHORT → map về BUY/SELL). Nến + giá crypto lấy từ Binance Futures klines (perpetual USDT-M, có volume); vàng vẫn TwelveData.
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
        ├── DailyPlanScheduler.ts      ← kế hoạch ngày (vàng + crypto) theo mốc giờ (7h/11h/15h/19h, T2–T6)
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
        │   ├── MarketDataProviderFactory.ts  ← chọn provider theo config (+ route crypto sang Binance)
        │   ├── TwelveDataProvider.ts  ← provider mặc định (vàng)
        │   ├── BinanceKlinesProvider.ts ← nến/giá crypto từ /fapi/v1/klines (có volume) + CryptoRoutingProvider
        │   ├── BinanceFuturesService.ts ← funding rate + open interest (crypto)
        │   ├── OandaProvider.ts       ← provider thay thế
        │   └── candleTime.ts          ← nhận diện nến ĐANG CHẠY (chưa đóng) + giờ theo múi IANA
        ├── setup/
        │   ├── SetupDetector.ts       ← dò chuỗi sweep → BOS/CHoCH có displacement → retest (hàm thuần)
        │   └── SetupWatcher.ts        ← job nền mỗi 5p, chỉ gọi AI khi chuỗi tới bước RETEST
        ├── swing/
        │   ├── SwingSignalService.ts  ← engine zigzag pivot (nhịp nhỏ, KHÔNG dùng AI)
        │   └── SwingRunner.ts         ← fetch nến + format báo cáo + Telegram (tùy chọn)
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
[AnalysisScheduler]  (mỗi SCHEDULER_INTERVAL_MIN, 8h–22h, T2–T6)   [POST /api/analyze]  (bấm tay)
       │   [SetupWatcher] (mỗi 5p, cơ học — chỉ khi chuỗi sweep→CHoCH→retest tới RETEST; trigger 'event')
       └──────────────────┬──────────────┴──────────────┘
                          ↓
[runAnalysis()]  ← AnalysisRunner: đường DUY NHẤT có lưu DB
       │  single-flight: đang chạy thì lượt/request thứ 2 bị chặn (scheduler bỏ lượt,
       │  API trả 409) — một lượt mất ~3 phút và tiêu quota subscription dùng chung
       ↓
[SignalOrchestrator.run(instrument?, timeframes?, analysisType?)]
       │  timeframes: dùng tham số nếu có, fallback về TRADING_TIMEFRAMES trong .env
       ├─ MarketDataProvider.fetchCandles(symbol, D/H4/H1/M15)  (crypto → exchange=Binance)
       ├─ MarketDataProvider.fetchCurrentPrice()
       ↓
[ClaudeAnalystService.analyze(instrument, …)]
       ├─ Chọn prompt theo instrument: vàng (buildGoldSystemPrompt) hoặc crypto (buildCryptoSystemPrompt)
       ├─ Build user prompt (bảng nến CSV theo tfOrder D→H4→H1→M15)
       ├─ Stream Claude API (thinking adaptive, max_tokens 64000)
       ├─ Parse TEXT (regex) → action BUY/SELL/NO_TRADE/WATCHLIST
       │    LONG→BUY, SHORT→SELL; WATCHLIST = canh setup, chưa vào lệnh
       └─ Trả về AnalysisResult (+ conditionalSetups)
       ↓
[Prisma] → lưu TradingSignal + AnalysisLog vào SQLite (trong AnalysisRunner, KHÔNG
       phải trong route — scheduler cần bản ghi này để carry-forward hoạt động)
       ↓
[TelegramNotifier]
       ├─ formatSignalSummary() → bản gọn (badge + entry/SL/TP/RR only)
       ├─ send() → kênh Telegram chính (auto-split nếu >4000 ký tự)
       └─ formatSignalCard() (đầy đủ: giá/xu hướng/confidence/kịch bản) + formatAnalysis()
          → sendComment() → discussion thread
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

**Cột `trigger`** (thêm 14/10/2026) trên cả `trading_signals` và `analysis_logs`: nguồn kích hoạt
lượt phân tích — `scheduler` (đồng hồ) / `event` (SetupWatcher) / `api` (bấm tay) / `mcp`; null với
bản ghi cũ. Ghi trong `AnalysisRunner`. `GET /api/signals?trigger=event` lọc theo cột này.

**Bảng `setup_watch_events`** (thêm 14/10/2026): lịch sử SetupWatcher — mỗi bản ghi là một lần một
hướng (symbol × BUY/SELL) **đổi bước** `NONE/SWEPT/CONFIRMED/RETEST` (không ghi mỗi tick): `stage`,
`prev_stage`, `setup_key`, `price`, `bias`, `bias_ok`, `note`, `detail` (JSON `{ sig, sweep,
structure, zone }`), `triggered` + `triggered_at` + `analysis_action` (đã gọi AI chưa + kết quả),
`skip_reason` (RETEST mà không gọi AI: ngược bias / cooldown / chạm trần ngày / đang bận).
Index `(symbol, created_at)`, `(triggered, triggered_at)`.

**Bảng `setup_watch_ticks`** (thêm 16/10/2026): MỖI lần watcher dò một symbol một bản ghi, kể cả khi
không có gì đổi (~170 dòng/symbol/ngày): `price`, `bias`, `buy_stage`/`sell_stage`, `outcome`
(`IDLE` / `TRIGGERED` / `SKIPPED` / `ERROR` / `BUSY` = bỏ tick vì tick trước còn chờ AI), `analysis_action`,
`reason`, `detail` (JSON note từng hướng), `duration_ms`. `created_at` = lúc BẮT ĐẦU dò (ghi tường minh) —
UI dựa vào đó để lồng các bản ghi `setup_watch_events` vào đúng lần dò sinh ra chúng. Index `(symbol, created_at)`.

**Bảng `signal_outcomes`** (thêm 26/10/2026): kết quả THẬT của tín hiệu BUY/SELL intraday, 1-1 với
`trading_signals` qua `signal_id` (không khoá ngoại — bảng thuần cộng thêm). `status`: `PENDING` (chờ giá
chạm entry) / `OPEN` (đã khớp) là trạng thái còn được chấm lại; `TP1` / `SL` / `EXPIRED` / `NO_FILL` /
`NO_DATA` là trạng thái chốt. Có `filled_at`, `exit_at`, `exit_price`, `result_r`, `mfe_r`/`mae_r`,
`missed_tp`, và `trigger`/`confidence` sao chép từ tín hiệu để thống kê. **Tạo bảng bằng `npx prisma db push`
(hoặc migrate) trên server** — DATABASE_URL ở máy dev trỏ thẳng vào DB production, đừng push từ đó.

---

## Theo dõi kết quả lệnh (Outcome tracker)

**File:** `src/services/outcome/` — `OutcomeEvaluator.ts` (hàm thuần chấm 1 lệnh trên dãy nến),
`outcomeStats.ts` (gộp winrate / R), `SignalOutcomeTracker.ts` (job nền).

Job nền KHÔNG gọi AI, mỗi `OUTCOME_TRACKER_INTERVAL_MIN` (15) phút: (1) đăng ký tín hiệu intraday BUY/SELL
mới (≤ `OUTCOME_BACKFILL_DAYS` = 3 ngày) vào `signal_outcomes`; (2) với các lệnh PENDING/OPEN lấy nến M5 MỘT
lần cho mỗi symbol rồi chấm lại từ đầu (không giữ state → restart/lỡ lượt không sao). Đo trên **TP1** — mức
Cổng 3 đo RR; TP chốt non và TP2/3 không được theo dõi. Vàng tốn ~1 request TwelveData/lượt khi còn lệnh chưa
chốt (≤ ~96/ngày), crypto lấy Binance (miễn phí). Dùng nến vàng đã `dropClosedMarketBars` như intraday.

Quy ước chấm — cố ý bi quan vì không có dữ liệu tick (đổi phải sửa test + CLAUDE.md này):
- Khớp khi range nến chứa entry, khớp đúng giá entry, không trượt giá. Lệnh chờ quá `OUTCOME_FILL_WINDOW_MIN`
  (180) chưa khớp → `NO_FILL`; nếu giá chạy tới TP1 mà chưa chạm entry → `missed_tp = true` (đo "bỏ lỡ lệnh thắng")
  và **hủy lệnh ngay** → `NO_FILL` (`OUTCOME_CANCEL_ON_TP_BEFORE_FILL`, thêm 27/10/2026). Trước đó lệnh chờ tiếp,
  khớp muộn khi giá hồi về rồi dính SL — 2/4 lệnh thua 23–27/10 (sau gộp trùng) là loại này.
- Nến VỪA khớp chỉ xét SL, không xét TP và không tính MFE (không biết thứ tự trong nến). Nến chạm cả SL lẫn TP1 → SL.
- Tín hiệu ra giữa cây nến → bỏ cây đó, chấm từ nến mở SAU `created_at`. Lệnh thị trường
  (`|entry − current_price| ≤ OUTCOME_MARKET_FILL_TOL_R × khoảng SL`, 0.1) coi như khớp ngay lúc ra tín hiệu.
- Đã khớp quá `OUTCOME_HOLD_MAX_HOURS` (24) mà chưa chạm TP1/SL → `EXPIRED`, R theo giá đóng nến cuối.
- `result_r`: TP1 = +`planned_rr`, SL = −1. `NO_DATA` = nến lấy về không phủ tới lúc ra tín hiệu (hoặc mức giá sai phía).

**Gộp tín hiệu trùng khi thống kê** (thêm 27/10/2026, `dedupeSetups()`): scheduler 30 phút lặp lại cùng một
kế hoạch (23/10: SELL 4033.8 ra 13 lần, 6 lần TP1 → +17R cho một lệnh +2.9R thật; 23–27/10: 35 tín hiệu = 12
setup). Tín hiệu nhập setup trước khi cùng symbol + hướng, entry lệch ≤ `OUTCOME_DEDUP_ENTRY_TOL_R` (0.25) ×
khoảng SL so với tín hiệu gần nhất của setup, và ra lúc setup còn hiệu lực (chưa chốt; chưa khớp thì tới hết
cửa sổ khớp). Đại diện = tín hiệu khớp sớm nhất (chưa khớp → tín hiệu đầu) — `trigger`/`confidence` theo đại
diện. Chỉ gộp lúc thống kê, `signal_outcomes` vẫn 1 dòng/tín hiệu. `?raw=1` = không gộp.

**Carry-forward lệnh trước: lệnh ĐÃ KHỚP, không có thì lệnh CHỜ** (27/10/2026, `SignalOrchestrator.loadPendingSetup` +
`evaluatePrevOrder`): khi bản ghi gần nhất là BUY/SELL, xét các lệnh trong `CARRY_FORWARD_ORDER_WINDOW_MIN`, chấm bằng
`evaluateOutcome` (cùng luật `OUTCOME_*`) trên khung nhỏ nhất vừa lấy cho lượt phân tích (vàng + crypto đều M15),
lấy lệnh MỚI NHẤT đang `OPEN` — vì scheduler hay lặp lại lệnh, bản mới nhất có thể là bản lặp chưa khớp. Block "LỆNH
ĐANG MỞ" báo sẵn giờ khớp + MFE/MAE; model khuyến nghị GIỮ / DỜI SL / THOÁT. Không có lệnh `OPEN` → lấy lệnh MỚI NHẤT
`PENDING` (chưa khớp, còn trong `OUTCOME_FILL_WINDOW_MIN`, chưa chạm TP1) → block "LỆNH CHỜ CHƯA KHỚP" (thêm 28/10/2026)
báo giá tiến gần entry nhất (+ khoảng cách theo R) và giờ hết hạn khớp; model khuyến nghị GIỮ / HỦY LỆNH CHỜ, và nếu giá
đã sát entry thì thêm nhánh "nếu đã khớp ở broker". Lý do: 28/10 SELL limit 4058.2 — đỉnh TwelveData 4057.68 (hụt 0.52 =
0.04R) nhưng broker đã khớp, lượt sau bỏ hẳn lệnh. Đã chạm SL/TP1 / hết hạn / `NO_FILL` → không nhét gì.

`POST /api/outcomes/rescore { days? }` (≤ `OUTCOME_BACKFILL_DAYS`): chấm lại MỌI bản ghi trong N ngày theo luật
hiện tại (lượt 15 phút không đụng bản ghi đã chốt) + nạp lại `confidence` null từ `reasoning` bằng parser mới
(cả `trading_signals` lẫn `signal_outcomes`). Gọi một lần sau mỗi lần đổi luật chấm/parser. Bản ghi đã chốt mà
nến không còn phủ tới (ra `NO_DATA`) thì giữ kết quả cũ.

`GET /api/outcomes/stats?days=30&symbol=` gộp theo `overall` / `by_trigger` (so Watcher với lịch với bấm tay) /
`by_symbol` / `by_direction` / `by_confidence` (`<50`, `50-69`, `70+`): số lệnh, tỉ lệ khớp, winrate
(TP1/(TP1+SL)), tổng R, **kỳ vọng R mỗi lệnh khớp**, `missed_tp`, trung vị MFE/MAE. `GET /api/outcomes` liệt kê
bản ghi gần nhất. `/api/signals` và `/api/signals/latest` kèm trường `outcome` (null nếu chưa chấm hoặc bảng
chưa tạo). Chưa chia được theo chế độ vào lệnh A/B/C — mã chế độ chưa được lưu cùng tín hiệu.

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
TRADING_TIMEFRAMES=D,H4,H1,M15     # D bối cảnh → H4 dòng → M15 entry
TRADING_CANDLES_COUNT=214
TRADING_CANDLES_D=120               # D/H4 chỉ gửi facts → nhiều nến không tốn token;
TRADING_CANDLES_H4=120              # ≥110 cho lookback range 80 + ATR nền 96 + ADX(14)
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
SCHEDULER_CRYPTO_WEEKDAYS=0,1,2,3,4,5,6   # symbol crypto (scheduler + watcher) — 24/7
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
npm run swing          # dò nhịp nhỏ (zigzag, không dùng AI):
                       #   npm run swing -- BTC/USD M15 [--rule=TP1_FULL] [--notify]
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
- **BA CHẾ ĐỘ VÀO LỆNH** (HARD GATE 2): `LIVE CONFIRM` (giá đã ở POI + M5 đã confirm) **hoặc** `LIMIT-CHỜ-POI` (POI fresh, entry dự kiến qua Gate 1 + Gate 3, cách giá hiện tại ≤ 1× ATR H1 — **nới ≤ 1.5× ATR H1 khi regime H1 là STRONG_TREND thuận hướng ADX**, có invalidation body-close → xuất ORDER lệnh chờ, tự hạ 1 bậc confidence) **hoặc** `BREAKOUT CONTINUATION` (POI hợp lệ nào cũng xa hơn ngưỡng B, nhưng có BOS thật M15/H1 thuận dòng H4 + STRONG_TREND thuận ADX, entry retest ngay mép vừa bị BOS phá, vẫn qua Gate 1 + Gate 3 tại mức retest, luôn 1 phần SCALP → tự hạ 2 bậc confidence). Lý do tồn tại: phân tích chạy rời rạc theo lần bấm nút, nếu bắt buộc live-confirm thì cửa sổ chỉ 1–2 nến M5 → gần như luôn trượt về WATCHLIST. WATCHLIST giờ chỉ dùng khi KHÔNG thỏa cả ba chế độ.
- **Nới ngưỡng ATR H1 của chế độ B + thêm chế độ C** (thêm 02/09/2026, Hard Gate 2 trong `buildGoldSystemPrompt`). Trước đó ngưỡng "POI cách giá hiện tại ≤ 1× ATR H1" là cố định, không phân biệt regime — quan sát thực tế: một lệnh BUY bị đẩy về WATCHLIST vì POI cách đúng 1.02× ATR H1 (nhỉnh hơn ngưỡng 0.02) dù regime đang STRONG_TREND thuận chiều lệnh, và nhiều lệnh chờ khác đặt được nhưng giá chạy thẳng 3–4× ATR M5 không hồi về POI, khiến tỷ lệ khớp lệnh thấp có hệ thống ở cả hai chiều BUY/SELL trong thị trường trending. Xử lý hai lớp: (1) nới ngưỡng lên 1.5× ATR H1 riêng khi STRONG_TREND thuận hướng ADX — giữ nguyên 1× cho các regime khác; (2) thêm chế độ C `BREAKOUT CONTINUATION` cho trường hợp POI hợp lệ còn xa hơn cả ngưỡng đã nới nhưng đã có BOS thật để retest — đổi lại RR/độ an toàn kém hơn B nên luôn hạ 2 bậc confidence + ép 1 phần SCALP, không cho phép khi ngược dòng H4. **Prompt crypto (20/10/2026): có giới hạn khoảng cách LIMIT-CHỜ-POI ≤1× ATR H1 (nới 1.5× khi ADX H4 STRONG_TREND thuận) + hạ 1 bậc; KHÔNG có chế độ C.**
- **HARD GATE 1 đo tại GIÁ VÀO LỆNH DỰ KIẾN**, không phải giá hiện tại — nếu không, giá hiện tại ở premium sâu sẽ chặn oan một lệnh BUY có entry nằm ở POI discount.
- **HARD GATE 1 đo trên DEALING RANGE, không phải range 80 nến.** `RangeFib` trong `IctPreprocessor` lấy high/low của lookback cố định (H1 = 80 nến ≈ 3 ngày vàng) — dùng range macro ~120 USD đó làm mẫu số cho entry scalp SL 6–12 USD là sai đơn vị đo, mọi pullback nông trong leg tăng đều thành "premium >60%" và bị chặn oan. Mẫu số chính thức là `activeLeg` (`findActiveLeg()`): nhịp từ pivot đối nghịch gần nhất tới cực trị hiện tại, tự mở rộng khi giá vượt pivot cũ. Fallback về range mở rộng khi `activeLeg = null` hoặc `sizeAtr < 1` (leg nhỏ hơn 1× ATR = nhiễu). Range mở rộng vẫn gửi vào prompt làm bối cảnh + chọn mục tiêu thanh khoản xa, nhưng KHÔNG dùng để chặn lệnh. **Prompt crypto đã áp dụng từ 20/10/2026** — Cổng 1 đo trên `DEALING RANGE` H4 tại entry dự kiến, ngưỡng 75/25 · 60/40 · 55/45 theo ADX H4.
Cùng đợt: thang confidence neo theo `minRr` (High ≥ 1.5× minRr), Low vẫn ra ORDER (giảm size) thay vì
NO TRADE; "biến động cực đoan" đọc từ dòng FACTS `Biến động: ATR(14)/ATR nền` (`atrBaseline` trong
`IctPreprocessor`, `ICT_ATR_BASELINE_BARS` = 96) — ≥2× khung M15 là fail Cổng 4; vùng retest của chuỗi
chuẩn M15 (sweep → CHoCH displacement → retest) được dùng làm POI dù không có POI H1 (tối đa Medium).
- **THANG TP HAI TẦNG**: `TP chốt non` (mức thanh khoản/rào cản gần nhất, chốt 40–50% + dời breakeven, **không** bị Gate 3 ràng buộc) và `TP1 chính` (mục tiêu thật — **HARD GATE 3 đo RR trên mức này**). Cổng 3 phân loại rào cản nghịch hướng: **CỨNG** (fresh, chưa bị body close xuyên, khung ≥M15, **và dày ≥0.25× ATR H1** → bắt buộc lùi TP1) vs **MỀM** (đã mitigated / đã bị xuyên / chỉ khung M5 / **mỏng <0.25× ATR H1** → không chặn TP1, chỉ đặt chốt non trước nó). Tiêu chí độ dày thêm vào 13/08/2026: một FVG rộng <0.25× ATR H1 không phải bức tường, để nó chặn TP1 thì mọi scalp có FVG mỏng nằm giữa đường đều bị bóp RR và loại oan.
- **ĐẢO CHIỀU NGƯỢC DÒNG H4 DỰA TRÊN SWEEP-AND-REJECT — cần ≥2 nến H1 xác nhận** (thêm 21/08/2026, phần "ĐỊNH NGHĨA KỸ THUẬT BẮT BUỘC" + Hard Gate 2 chế độ B trong `buildGoldSystemPrompt`). Trước đó, một lệnh ngược dòng H4 có thể được xuất ORDER chỉ dựa vào MỘT nến H1 đóng cửa ngược lại sau cú sweep đỉnh/đáy (kiểu "giá quét lên rồi H1 đóng nến quay lại dưới mức cũ" = sweep-and-reject) — không phải CHoCH thật (thiếu displacement). Sự cố quan sát được: 21/08/2026 giá quét 4547.99 rồi H1 đóng nến 4541.01 (dưới 4544.49), hệ thống lập tức đảo từ BUY sang SELL dù H4 vẫn BULLISH và ADX H1 vẫn nghiêng bullish suốt — 15–20 phút sau giá phá ngược trở lại, vô hiệu hoàn toàn setup SELL (whipsaw). Luật mới: lệnh ngược dòng H4 dùng lý do sweep-and-reject phải có **≥2 nến H1 liên tiếp** đóng cửa đúng phía đảo chiều mới được xuất ORDER (cả LIVE CONFIRM lẫn LIMIT-CHỜ-POI); chỉ 1 nến → giữ WATCHLIST. Không áp dụng khi lệnh THUẬN dòng H4. **Prompt crypto áp dụng từ 20/10/2026, dịch một bậc khung**: lệnh ngược dòng D dựa trên sweep-and-reject
cần ≥2 nến **H4** đã đóng xác nhận (kể cả khi căn cứ là chuỗi chuẩn M15). Vì crypto chỉ gửi nến thô M15,
số nến xác nhận do code đếm: `SweepEvent.holdCloses` (nến đã đóng liên tiếp tính từ nến mới nhất ngược về
nến từ chối, đóng đúng phía đảo chiều) in trong dòng "Liquidity sweep gần nhất" của mọi khung (cả vàng);
thêm `CLAUDE_RAW_CANDLES_CRYPTO_H4` (12) nến thô H4 để model đếm khi mức bị quét chỉ là swing khung nhỏ.
- **Lệnh chờ (LIMIT-CHỜ-POI) giữ entry GIỮA POI — đừng kéo về mép gần khi chưa có số liệu.** Đo 22/10/2026
  trên 202 lệnh XAU (18/09–22/10, nến M5 thật, lệnh chờ 3h, TP1/SL trong 24h): khớp 67%, 59/67 lệnh không
  khớp vẫn chạy tới TP1 — nhưng dời entry về phía giá làm tổng R GIẢM (entry hiện tại +10.5R; 75% quãng
  +4.5R; 50% −8.4R; vào ngay −20.7R) vì RR tụt nhanh hơn winrate tăng. Lợi thế mỏng (+0.08R/lệnh khớp,
  winrate 38%). Thử mép gần chỉ khi có bộ theo dõi kết quả lệnh thật.
  Dòng `Entry zone: [thấp – cao] (mốc [giá khớp])` — "mốc" bắt buộc (LIMIT = giữa POI). `extractEntryPrice(section,
  action)` đọc `mốc` hoặc `anchor` (model hay viết tiếng Anh), thiếu cả hai mà là vùng thì lấy mép gần theo hướng
  (trước đây lấy số đầu = mép dưới, tức mép XA với BUY).
- **Sideway: hộp range + mean-reversion + bias NEUTRAL** (thêm 27/10/2026, chỉ prompt vàng intraday). Trước đó RANGE
  (ADX H1 < 20) trừ 1 bậc confidence MỌI lệnh, kể cả lệnh đánh từ biên về EQ — đúng kiểu lệnh hợp với sideway; cộng
  với −1 lệnh chờ và −1 vùng giữa → gần như mọi lệnh sideway về Low. Nay:
  (1) `IctPreprocessor.findRangeBox()` → `TimeframeAnalysis.rangeBox` + dòng FACTS "▶ HỘP RANGE" (mọi khung, mọi
  prompt; không có hộp → in "—" để model không tự vẽ). Đi ngược từ swing mới nhất, nhận swing tới khi biên >
  `ICT_RANGE_BOX_MAX_WIDTH_ATR` (6)× ATR, rồi thử từ chuỗi dài nhất ngắn dần (swing của nhịp trend trước hộp làm lệch
  biên chỉ chạm 1 lần) tới chuỗi đầu tiên có ≥ `MIN_TOUCHES` (2) swing chạm mỗi biên (cách ≤ `TOUCH_TOL_ATR` 0.5× ATR),
  ≥ `MIN_BARS` (20) nến, rộng ≥ `MIN_WIDTH_ATR` (1.5)× ATR. `state`: INSIDE / TESTING (1..`ICT_SWEEP_REJECT_BARS` nến
  đóng ngoài) / BROKEN. Đo trên BTC/ETH 23–27/10: hộp H1 có ở ~1/3–1/2 số thời điểm, rộng thường 5–6× ATR — nới/siết
  bằng `MAX_WIDTH_ATR`. (2) Lệnh **MEAN-REVERSION** (hộp H1 TRONG HỘP + entry ở 25% ngoài cùng đúng phía + căn cứ đảo
  chiều tại biên + TP1 vào trong hộp, chốt non ở EQ hộp) KHÔNG bị trừ bậc RANGE; tiếp diễn/breakout vẫn −1; entry
  35–65% hộp −1 ("giữa hộp", soft). Khớp prompt crypto (vốn đã miễn trừ). (3) **H4 NEUTRAL** → nhãn "H4 TRUNG TÍNH":
  không trừ ngược dòng, không áp luật ≥2 nến H1, nhưng không được chế độ C / chia 2 phần / High. **H1 NEUTRAL** →
  hướng lệnh phải từ chuỗi chuẩn M15 hoặc biên hộp, "phù hợp bias" đọc là "phù hợp hướng lệnh" + nửa dealing range đúng
  chiều, không lên High. KHÔNG đổi 3 HARD GATE (Cổng 3 vẫn xếp FVG/OB trong hộp như cũ). Chưa có số liệu theo regime —
  outcome tracker chưa lưu regime/hộp.
- `parseConfidence()` (export, dùng chung với outcome rescore): `Confidence: High/Medium/Low` → 85/65/45, chấp
  nhận in đậm/nghiêng (`Confidence: **Low**`, `_High_`). Trước 27/10/2026 regex không cho `*` sau dấu `:` →
  16/35 tín hiệu 23–27/10 lưu `confidence = null` (thực tế đều Low/Medium).
- Parser lấy `take_profit`/`risk_reward` từ dòng chứa token `TP1` **đầu tiên** trong block ORDER — dòng `TP chốt non` cố ý không chứa token đó nên không bị bắt nhầm. Đổi nhãn TP trong prompt phải kiểm lại `extractPriceFromLine(section, 'tp1')`.

**Output là TEXT markdown (KHÔNG phải JSON)** — parse bằng regex, không dùng `JSON.parse`:
- `extractAction()` trả về `BUY | SELL | NO_TRADE | WATCHLIST`. Thứ tự ưu tiên: ORDER block thật → `#### WATCHLIST` → dòng `Best opportunity:` trong SUMMARY.
- `dirToAction()`: **LONG→BUY, SHORT→SELL** (crypto dùng LONG/SHORT, hệ thống lưu BUY/SELL).
- `WATCHLIST` = setup đang hình thành, chưa đủ điều kiện vào lệnh → không có entry/SL/TP; thông tin "POI đang canh" nằm trong `conditionalSetups`.
- Các hằng số parser dùng chung: `DIR_LABEL` (`BUY ORDER|LONG`, `SELL ORDER|SHORT`), `ORDER_HEAD`, `SECTION_END`.
- **Heading + in đậm lỏng** (sửa 29/10/2026): model hay lệch mẫu `#### …` — viết `## SHORT`, `### SELL ORDER`,
  `## 🔴 SELL ORDER`, `## [BUY ORDER]`, `## WATCHLIST`, hoặc lồng `## 🟢 LONG — ORDER` rồi `#### LONG`; và in đậm cả
  nhãn `**Best opportunity:** SHORT`. Parser cũ chỉ nhận `####` và chữ ngay sau `:` → rơi về NO_TRADE: trên 2117 bản
  ghi có 49 lệnh BUY/SELL thật + 131 WATCHLIST bị lưu NO_TRADE (vd #2205 BTC 29/10, #2116/#2088/#2085 26–27/10).
  Nay `ORDER_HEAD` = 2–6 dấu # + ≤8 ký tự trang trí, `[*_\s]*` sau dấu `:`, `findOrderSection()` lấy section đầu
  tiên có dòng Entry. Bản ghi cũ trong DB CHƯA được parse lại.

**Block ORDER mẫu (vàng):**
```
#### [BUY ORDER / SELL ORDER]
- Nhãn dòng H4: THUẬN dòng / NGƯỢC dòng
- Entry zone / SL / TP1-3 / Confidence / Hủy lệnh nếu
```

**Streaming:** dùng `messages.stream()` (thinking adaptive, max_tokens 64000), `maxRetries: 4`, SDK timeout 10 phút; undici dispatcher đặt timeout = 0 (vô hạn) để stream dài không bị ngắt.

**FACTS — nến đang chạy, sweep, displacement, kill zone** (thêm 14/10/2026, `IctPreprocessor` +
`candleTime.ts`). Đọc trước khi động vào preprocessor:
- **Nến đang chạy bị loại khỏi mọi phép tính body close.** Provider trả cả cây nến chưa đóng ở
  cuối mảng; scheduler chạy ở :00/:30 nên lúc :30 nến H1 mới chạy nửa giờ và "close" của nó chỉ
  là giá hiện tại → `findRecentStructure` cũ báo BOS/CHoCH ma, luật "≥2 nến H1 xác nhận" đếm nhầm.
  Nay `preprocess()` dùng `isCandleForming()` (giờ mở + độ dài khung > now) cho từng khung; swing/
  ATR/ADX/FVG/OB/BOS/CHoCH/sweep chỉ tính trên nến ĐÃ ĐÓNG, còn range/leg/giá hiện tại vẫn dùng
  nến đang chạy (giá sống). Nến thô gửi model chỉ gồm nến đã đóng; nến đang chạy là một dòng
  riêng "Nến ĐANG CHẠY". Timestamp TwelveData không có hậu tố múi giờ → hiểu là giờ treo tường
  của `MARKET_HOURS_TIMEZONE` (đúng với param `timezone` gửi lên).
- **Trạng thái mức thanh khoản 4 nhãn** thay cờ `swept` cũ (cũ = "có wick vượt qua" → một cú
  phá thật cũng thành `swept` và prompt đọc thành "đã quét → đảo chiều", tức đọc NGƯỢC hướng):
  `UNSWEPT` / `SWEPT` (wick vượt rồi body close quay lại trong ≤ `ICT_SWEEP_REJECT_BARS` nến) /
  `BROKEN` (phá thật) / `BREAKING` (chưa đủ nến để kết luận). Áp cho equal highs/lows và 5 swing
  gần nhất. `sweeps[]` = cú quét đã từ chối trong `ICT_SWEEP_RECENT_BARS` nến gần nhất.
- **BOS/CHoCH kèm displacement + vùng retest.** `structureEvents[]` (3 sự kiện gần nhất) — mỗi
  sự kiện có `displacement` (nến phá hoặc nến liền trước cùng chiều có thân ≥
  `ICT_DISPLACEMENT_BODY_ATR`× ATR, hoặc cú phá để lại FVG) và `retestZone` (FVG/OB do chính cú
  phá tạo ra, kèm cờ `invalidated` khi đã bị body close xuyên mép xa). Prompt in sự kiện không
  displacement thành "YẾU" — khớp định nghĩa CHoCH hợp lệ. `recentStructure` giữ để tương thích.
- **Vùng retest có ngưỡng chịu lệch + gộp FVG/OB** (thêm 15/10/2026, `describeBreak`). Trước đó
  một nến M15 đóng thân xuyên mép xa của FVG 0.7 USD chỉ 0.12 USD đã đánh dấu vùng `invalidated`
  → SetupWatcher hủy cả chuỗi sweep → BOS trước khi tới RETEST. Nay: (1) chỉ `invalidated` khi
  body close xuyên mép xa QUÁ `ICT_RETEST_INVALIDATE_ATR` (0.25)× ATR; độ xuyên sâu nhất ghi ở
  `penetrationAtr` (FACTS in "xuyên nông … trong ngưỡng chịu lệch"); (2) FVG gộp với OB của chính
  cú đẩy (nến ngược chiều cuối cùng trước nến giữa FVG, lùi ≤3 cây — `obBeforeFvg()`, vì
  `findOrderBlocks` đòi nến đẩy ≥1.2× ATR nên bỏ sót) khi hai vùng cách ≤
  `ICT_RETEST_MERGE_OB_GAP_ATR` (0.5)× ATR → `source = 'FVG+OB'`, hộp = hợp của hai vùng. Đặt
  `ICT_RETEST_INVALIDATE_ATR=0` + `ICT_RETEST_MERGE_OB_GAP_ATR=-1` = hành vi cũ. Áp dụng cho cả
  FACTS gửi Claude lẫn SetupWatcher.
- **Kill zone tính theo thời điểm phân tích + giờ London/New York thật** (`Intl`, tự xử lý DST).
  Bản cũ cố định 14–17h / 19:30–22h VN (giờ mùa hè) nên từ cuối tháng 10 gắn nhãn sai. Prompt
  vàng giờ bảo model dùng nhãn trong FACTS thay vì tự suy DST từ timestamp.
- **Nến cuối tuần bị lọc khỏi intraday vàng + SetupWatcher** (thêm 23/10/2026). TwelveData trả nến
  T7/CN đi ngang cho XAU/USD ở mọi khung (xem Kế hoạch ngày). `SignalOrchestrator.run` và
  `SetupWatcher.fetchCandles` (cả khung dò lẫn khung bias) lấy `count + closedMarketPadding(count, tf)`
  nến, `dropClosedMarketBars()` rồi `.slice(-count)` → số nến gửi đi không đổi, chỉ nến cũ hơn (T6)
  nối tiếp như chart MT4. `closedMarketPadding` đếm số ô cuối tuần nằm xen trong `count` ô giao dịch
  tính từ bây giờ — chỉ khác 0 khi cửa sổ chạm cuối tuần (M5 180 → chỉ sáng thứ Hai, pad 588; H1 214
  → luôn 49–98). Lấy dư không tốn credit (TwelveData tính theo request, không theo `outputsize`).
  Không lấy dư thì sáng thứ Hai M15 240 chỉ còn 44 nến, M5 180 còn 24, watcher M15 200 còn 8.
  Số liệu thật thứ Hai 19/10/2026 07:00 VN trước khi lọc: 196/240 nến M15 và 156/180 nến M5 là nến
  cuối tuần → ATR H1 2.91 (thật 14.9), ADX M15 70 STRONG_TREND (thật 18.6 RANGE), hàng chục equal
  highs/lows giả ở 4164.86/4164.61 và một SELLSIDE sweep giả mà watcher đọc thành chuỗi BUY; bias H1
  watcher NEUTRAL (thật BULLISH). Giữa tuần (T4 15:00) M5/M15 không đổi, H1 chỉ bỏ equal H/L giả +
  `atrBaseline`. Crypto (`isCryptoInstrument`) KHÔNG lọc. `SwingRunner` (nhịp nhỏ) lọc theo cùng cách.
- **Volume tương đối — chỉ crypto** (thêm 23/10/2026). `Candle.volume` (null mặc định). TwelveData
  KHÔNG trả volume (cả XAU/USD lẫn BTC/USD exchange=Binance — đã gọi thử), nên nến crypto chuyển sang
  `BinanceKlinesProvider` (volume hợp đồng perpetual, xem Market Data Providers); vàng giữ null nên
  FACTS/prompt vàng KHÔNG đổi. Binance lỗi → rơi về TwelveData, mất volume, mọi dòng volume tự ẩn. Mọi tỉ lệ "× TB" chia cho trung bình
  volume `ICT_VOLUME_SMA_BARS` (20) nến đã đóng LIỀN TRƯỚC đoạn đo (để cú phá không tự kéo mẫu số):
  `TimeframeAnalysis.volume` (nến đóng gần nhất + TB 3 nến), `StructureEvent.breakVolRatio` (max của
  nến phá + nến liền trước cùng chiều) và `pullbackVolRatio` (TB tối đa 20 nến sau cú phá, cùng mẫu số),
  `SweepEvent.volRatio` (max các nến của cú quét). Nến thô crypto có thêm cột `volume`. Prompt crypto
  (intraday + plan) dùng volume CHỈ để chỉnh confidence: cú phá < 1× TB hoặc volume sau cú phá ≥ volume
  cú phá → hạ 1 bậc; không phải cổng cứng. SUMMARY crypto thêm dòng `Volume:`.
- Những thay đổi này KHÔNG đổi 3 HARD GATE / chế độ A-B-C — chỉ làm dữ liệu đúng hơn. Kỳ vọng
  ít CHoCH hơn (các cú phá không displacement không còn được coi là CHoCH).

---

## Kế hoạch ngày (Daily Plan) — vàng + crypto

**File:** `src/services/DailyPlanScheduler.ts` (lịch) + `SignalOrchestrator.runDailyPlan()` +
`ClaudeAnalystService.analyzeDailyPlan()` / `buildGoldDailyPlanSystemPrompt()` +
`TelegramNotifier.formatPlanCard()`.

- **Lịch theo GIỜ, không theo phút**: mốc = `DAILY_PLAN_START_HOUR` (7), cộng
  `DAILY_PLAN_INTERVAL_HOURS` (4) tới ≤ `DAILY_PLAN_END_HOUR` (22) → 7h/11h/15h/19h, T2–T6
  giờ VN (crypto theo `DAILY_PLAN_CRYPTO_WEEKDAYS`, mặc định cả tuần → T7/CN mốc chỉ lập plan
  BTC/ETH), +`DAILY_PLAN_OFFSET_SEC`. Bấm tay (`run-all`) vẫn chạy mọi symbol bất kể ngày. Tách khỏi `AnalysisScheduler` vì scheduler đó canh mốc
  bằng `minute % interval` — không chạy được chu kỳ nhiều giờ.
- **Đi qua `runAnalysis({ analysisType: 'daily_plan' })`** như mọi đường trigger khác (lưu DB +
  single-flight). Đụng lượt khác (11h/15h/19h trùng mốc :00 của intraday) → KHÔNG bỏ lượt như
  intraday mà chờ `BUSY_RETRY_SEC` rồi thử lại, tối đa `BUSY_MAX_WAIT_MIN`.
- **Prompt riêng, không ra lệnh**: khung D/H4/H1/M15 (`DAILY_PLAN_TIMEFRAMES`, số nến riêng
  `dailyPlan.candlesByTf`), output cố định: `Bias Overall:` + `#### KỊCH BẢN BUY — CHÍNH/PHỤ` +
  `#### KỊCH BẢN SELL — …`. `parseDailyPlanResult()` luôn trả `WATCHLIST`, kịch bản vào
  `conditionalSetups`. Đổi nhãn trong prompt phải sửa parser + `formatPlanCard` cùng lúc.
- **Crypto dùng chung lịch** (thêm 21/10/2026): `DAILY_PLAN_SYMBOLS` mặc định
  `XAU/USD,BTC/USD,ETH/USD`, mỗi mốc chạy lần lượt từng symbol (~3 phút/symbol → 12 lượt AI/ngày).
  Symbol crypto → `buildCryptoDailyPlanSystemPrompt()`: cùng khung + bố cục, nhưng tiêu đề
  `#### KỊCH BẢN LONG/SHORT` (parser map LONG→BUY, SHORT→SELL; `formatPlanCard` hiện nhãn LONG/SHORT),
  SL/TP theo % + ATR H1, giờ thanh khoản crypto thay kill zone vàng, luật ≥2 nến H4 cho kịch bản
  ngược dòng D dựa trên sweep-and-reject, kèm FUTURES SENTIMENT + BTC CONTEXT (altcoin) qua
  `fetchCryptoExtras`. Nến crypto KHÔNG qua `dropClosedMarketBars` (giao dịch thật T7/CN); mức theo
  phiên dùng `computeCryptoSessionLevels()` — ngày theo UTC (00:00 UTC = 07:00 VN, như nến D Binance),
  tuần từ T2 00:00 UTC, `asia = null` (không range Á).
- **Plan lượt trước** (cùng symbol, ≤ `DAILY_PLAN_PREVIOUS_MAX_AGE_MIN` = 300 phút) được nhét
  vào prompt để model ghi kịch bản cũ ĐÃ KÍCH HOẠT / ĐÃ VÔ HIỆU / VẪN CHỜ. Lượt 7h không đọc
  plan 19h hôm trước.
- **Nến cuối tuần bị lọc + mức theo phiên do code tính** (thêm 15/10/2026, `ict/SessionLevels.ts`).
  TwelveData trả nến T7/CN đi ngang ở giá đóng cửa T6 cho XAU/USD ở MỌI khung (D/H4/H1 — ~40/120
  nến H1 vào thứ Năm), và nến D cắt lúc 03:00 VN chứ không phải rollover. Plan nên:
  (1) `dropClosedMarketBars()` bỏ nến có quá nửa thời gian nằm trong T6 17:00 → CN 18:00 NY (vì thế
  số nến lấy về dư ~30%: D 170 / H4 160 / H1 160); (2) `computeSessionLevels()` dựng ngày giao dịch
  từ H1 theo rollover 17:00 NY (T7 → gộp T6, CN → gộp T2) → PDH/PDL, high/low hôm nay, range Á
  (20:00–24:00 NY, trạng thái CHƯA BẮT ĐẦU/ĐANG CHẠY/ĐÃ XONG); tuần từ H4 → PWH/PWL (cờ thiếu
  dữ liệu đầu tuần). Block "MỨC GIÁ THEO PHIÊN" nối vào user prompt, prompt cấm tự đọc PDH/PDL từ
  nến D; (3) range premium/discount D/H4 dùng `DAILY_PLAN_RANGE_LOOKBACK_*` (120) qua
  `preprocess({ fibLookbackByTf })` — bảng `FIB_LOOKBACK_BY_TF` dùng chung với crypto nên không sửa.
  Intraday + SetupWatcher cũng lọc từ 23/10/2026 (xem FACTS), nhưng lấy dư theo `closedMarketPadding`
  thay vì dư cố định như plan.
- `analysis_type='daily_plan'` → không lẫn vào carry-forward intraday (`loadPendingSetup` lọc
  theo analysis_type); `/api/signals/latest` bỏ qua plan. Telegram: kênh chính nhận
  `formatPlanCard` (bias + 2 kịch bản), comment nhận phân tích đầy đủ.

## Setup Watcher — kích hoạt phân tích theo sự kiện

**File:** `src/services/setup/SetupWatcher.ts` (job) + `SetupDetector.ts` (hàm thuần)

Lý do tồn tại: quy trình ICT "chờ quét thanh khoản → chờ CHoCH có displacement → chờ hồi về
FVG/OB → vào lệnh" là quy trình CHỜ THEO SỰ KIỆN, cửa sổ chỉ vài nến M5/M15. `AnalysisScheduler`
lấy mẫu theo đồng hồ (15–30 phút) nên gần như không bao giờ rơi đúng lúc retest — đó là lý do
prompt phải bù bằng chế độ B (limit tại POI, khớp ngay trong cú quét, trước khi có CHoCH).

Cơ chế: mỗi `SETUP_WATCHER_INTERVAL_MIN` (5) phút, canh theo đồng hồ + `OFFSET_SEC`, trong cùng
khung giờ/ngày với `SCHEDULER_*`. Symbol lấy từ `SETUP_WATCHER_SYMBOLS` (thêm 20/10/2026 — hiện
`XAU/USD,BTC/USD,ETH/USD`; trống → `SCHEDULER_SYMBOLS` → `TRADING_INSTRUMENT`), tách khỏi scheduler
để dò thêm crypto mà không thêm lượt AI theo đồng hồ. Symbol crypto kích hoạt AI thì
`SignalOrchestrator` tự dùng prompt + bộ khung crypto. Crypto dò trong khung giờ 8h–22h cả tuần
(`SCHEDULER_CRYPTO_WEEKDAYS`, từ 27/10/2026; trước đó chỉ T2–T6) — T7/CN chỉ dò symbol crypto, status trả
`active_symbols` để modal báo symbol đang nghỉ. Nến crypto lấy Binance nên dò cuối tuần không tốn credit TwelveData,
nhưng lượt AI do watcher kích hoạt cuối tuần vẫn tiêu quota subscription.
Fetch nến `SETUP_WATCHER_TIMEFRAME` (M15) + bias khung
`SETUP_WATCHER_BIAS_TIMEFRAME` (H1; crypto dùng `SETUP_WATCHER_CRYPTO_BIAS_TIMEFRAME` = H4 cho khớp khung bias của prompt crypto; cache tới lúc nến H1 đang chạy đóng — bias chỉ tính trên nến
đã đóng nên refetch sớm hơn là thừa; `BIAS_CACHE_MIN` chỉ dùng khi nến cuối không còn chạy), chạy `analyzeTimeframe` (nến đã đóng), rồi
`detectSetup()` cho từng hướng: `NONE → SWEPT → CONFIRMED → RETEST`. Chỉ khi `RETEST` (+ KHÔNG ngược
bias nếu `REQUIRE_BIAS`) mới gọi `runAnalysis({ trigger: 'event', triggerNote })` — `triggerNote` mô tả
chuỗi, được nối vào user prompt dưới dạng "gợi ý cần kiểm chứng độc lập" (chống anchoring).

**Luật bias (đổi 22/10/2026):** `biasOk` = "không NGƯỢC bias rõ ràng" — chỉ chặn BUY khi bias
`BEARISH`, SELL khi `BULLISH`; `NEUTRAL` (và bias `null`) vẫn gọi AI. Trước đó `biasOk` đòi TRÙNG
bias nên `NEUTRAL` cũng bị chặn. Lý do: bias cơ học (`structureBias`: 2 swing high + 2 swing low gần
nhất, pivot 2 nến mỗi bên trên nến đã đóng) chậm ~2 giờ, nên chuỗi đảo chiều ngay đáy/đỉnh — đúng
loại setup watcher săn — gần như luôn rơi vào lúc H1 còn `NEUTRAL` (vd 22/10: đỉnh cao dần + đáy thấp
dần). Claude tự đánh giá lại bias trên dữ liệu đầy đủ. Cột `bias_ok` trong `setup_watch_events` /
`detail` của `setup_watch_ticks` đổi nghĩa từ ngày này (bản ghi cũ: `false` khi NEUTRAL) — UI suy
nhãn 3 trạng thái (trùng / trung tính / ngược) từ `bias` + hướng, không đọc `bias_ok`.

Chặn quota: mỗi chuỗi (key = hướng + thời điểm sweep + thời điểm cú phá) chỉ kích hoạt 1 lần;
`COOLDOWN_MIN` giữa hai lần cùng symbol; `MAX_PER_DAY` lần/ngày — **trần chung cho MỌI symbol**
(quota Claude là một), không phải mỗi symbol; `0` = không giới hạn (`.env` đang để 0 từ 20/10/2026 —
khi đó chỉ còn cooldown + mỗi chuỗi 1 lần chặn quota, trần lý thuyết ≈ 28 lần/symbol/ngày). Đang có lượt chạy (single-flight)
→ không đánh dấu, thử lại tick sau.

Lịch sử (`setup_watch_events`, `recordTransitions()`): chỉ ghi khi một hướng ĐỔI bước — so bằng
"chữ ký" `stage|sweep.time|structure.time` (lưu trong `detail.sig`), nên cùng bước nhưng sweep/cú
phá khác vẫn ra bản ghi mới; `NONE` chỉ ghi khi một chuỗi vừa hỏng/hết hạn, không ghi khi đứng yên.
Bản ghi RETEST được đánh dấu `triggered/triggered_at` NGAY TRƯỚC khi gọi AI (lượt AI ~3 phút), rồi
`analysis_action` khi xong (`ERROR` nếu lỗi; busy → hoàn lại). Ngay trong `start()`, `hydrate()` nạp lại
từ bảng: key chuỗi đã kích hoạt 2 ngày gần nhất (kèm giờ kích hoạt), mốc cooldown, số lần kích hoạt
hôm nay và `last_trigger` → restart KHÔNG kích hoạt lặp và modal không mất "kích hoạt gần nhất"
(trước 15/10/2026 `last_trigger` chỉ nằm trong RAM, và hydrate chỉ chạy ở tick đầu TRONG khung giờ).
Tick đầu chờ chung promise của hydrate. Chuỗi đã kích hoạt mà retest lại → ghi `skip_reason`
"chuỗi này đã gọi AI lúc HH:MM" (không ghi đè lên bản ghi đã gọi AI). Bản ghi cuối mỗi (symbol, hướng) cũng đọc lại từ DB để không ghi trùng sau
restart. Mọi lỗi DB fail-soft (chỉ log) — watcher vẫn dò tiếp.
Watcher KHÔNG thay scheduler đồng hồ — hai đường chạy song song; nếu watcher đang chạy một lượt
AI đúng lúc scheduler tới mốc thì scheduler bỏ lượt (AnalysisBusyError, như bấm tay).
Request dữ liệu: ~1 request/symbol mỗi 5 phút + 1 request bias/giờ (≈182 request/ngày/symbol
trong khung 8h–22h) — đây là job nền duy nhất còn gọi provider liên tục (SwingScheduler
đã bị gỡ 17/09 vì đốt quota), chỉ quét `SETUP_WATCHER_SYMBOLS` chứ không quét cả danh sách theo dõi.
**Ngân sách TwelveData (gói basic: 800/ngày, 8/phút):** từ 23/10/2026 crypto lấy nến/giá từ Binance
(không tốn credit), nên chỉ còn vàng: watcher XAU ≈ 182 + scheduler 30p (~5 request/lượt × 28) ≈ 140 +
daily plan XAU 4×5 = 20 → ~342/ngày, mỗi lượt AI vàng do watcher kích hoạt thêm ~5. (Trước đó 3 symbol
≈ 754/ngày, sát trần.) Binance lỗi thì crypto rơi về TwelveData và lại tốn credit như cũ — nếu Binance
bị chặn lâu dài thì đặt `CRYPTO_CANDLE_SOURCE=provider` và tính lại ngân sách. Trần 8/phút được giữ bởi cửa sổ trượt
dùng chung trong `TwelveDataProvider` (`TWELVEDATA_MAX_REQUESTS_PER_MIN`): tick :00/:30 của
scheduler trùng tick watcher thì request thừa CHỜ (≤ ~60s) thay vì ăn lỗi 429.

**Giao diện theo dõi** (`chart.html`): nút **🎯 Watcher** trên header cạnh nút Scheduler — đọc
`GET /api/setup-watcher` mỗi 60s, hiện bước xa nhất đang có (`chờ` / `đã quét` / `chờ retest` vàng /
`RETEST` xanh) + số lần kích hoạt AI hôm nay. Bấm mở modal: dải tóm tắt (khung, cooldown, tick
gần nhất/kế tiếp), cảnh báo ngoài khung giờ (`in_window_now`), lần kích hoạt gần nhất + lỗi gần
nhất, rồi từng symbol × BUY/SELL với thanh 3 bước ① Quét → ② BOS/CHoCH + displacement → ③ Hồi
về FVG/OB, nhãn trùng / trung tính / ngược bias, `note` và các mức sweep/cú phá/vùng retest. Modal mở thì tự làm
mới mỗi 30s. Watcher chỉ cập nhật snapshot trong khung giờ — ngoài giờ modal hiện số liệu lần dò cuối.
Tab **Lịch sử** trong modal (chọn ngày, giờ VN) đọc `GET /api/setup-watcher/history`: dòng thời gian
MỌI lần dò (`ticks` — giá, bias, bước BUY/SELL, kết quả), các lần đổi bước ("bước trước → bước sau",
các mức, "⚡ Đã gọi AI → kết quả" / "⏸ Không gọi AI: lý do") lồng dưới lần dò tương ứng. Bộ lọc
"Chỉ lần có thay đổi / gọi AI" ẩn các lần dò đứng yên.
Hàng **tab symbol** (Tất cả / từng symbol, thêm 20/10/2026) dưới hàng Hiện tại/Lịch sử lọc cả hai chế độ
phía client (không gọi lại API); danh sách lấy từ `watch_symbols` trong `GET /api/setup-watcher`, tab ở chế độ
Hiện tại có chấm màu theo bước xa nhất, ở Lịch sử có số lần đổi bước trong ngày; tab chọn nhớ ở
`localStorage.watcherSym`. Chỉ 1 symbol → ẩn hàng tab.
Modal "Tín hiệu từ Claude" gắn nhãn nguồn kích hoạt trên từng bản ghi (🎯 Watcher / ⏱ Theo lịch /
👆 Bấm tay) từ cột `trigger`, cộng badge `🗺 Plan` khi `analysis_type = 'daily_plan'` (plan cũng là `scheduler`).

---

## Nhịp nhỏ (Swing scalp) — Chi tiết quan trọng

**File:** `src/services/swing/SwingSignalService.ts` (engine) + `SwingRunner.ts` (chạy + format)

Lớp tín hiệu **CƠ HỌC, KHÔNG gọi Claude** — dò điểm BUY/SELL theo từng nhịp nhỏ giống họ
indicator zigzag/fractal trên TradingView. Chạy vài ms, **không tiêu quota**, nên gọi bao
nhiêu lần cũng được. Đây là lớp **song song**, KHÔNG thay thế phân tích ICT/AI.

Thuật toán: pivot fractal (`lookback` nến mỗi bên) → zigzag ép xen kẽ HIGH/LOW và loại
nhịp nhỏ hơn `minLegAtr × ATR` → pivot LOW = BUY, pivot HIGH = SELL → SL sau pivot một
khoảng `slBufferAtr × ATR`, TP1/2/3 theo bội số R → forward-test từng tín hiệu cũ trên
chính bộ nến để có winrate/tổng R thật.

**BA LUẬT THOÁT + kế toán kết quả** (thêm 26/08/2026 — đọc trước khi động vào `simulate`):
bản cũ tính lệnh "chạm TP2 rồi quay về SL" thành **+2R**, tức ngầm giả định đã thoát đúng
đỉnh → winrate và tổng R bị thổi phồng, và câu hỏi "giữ tới TP3 có đáng không" tự có lời
giải đẹp một cách giả tạo. Nay:
- `status` chỉ mô tả đường đi với SL GỐC: `SL` (dù trước đó chạm TP nào — xem `maxTpHit`),
  `TP{n}` khi chạm đủ mọi mốc, `RUNNING`.
- `resultR` là kết quả của LUẬT THOÁT đang chọn (`SWING_EXIT_RULE`), không phải "sự thật"
  duy nhất. Cả ba luật — `TP1_FULL`, `PARTIAL_BE` (mặc định), `TRAIL_PIVOT` — luôn chạy
  song song trên cùng đường giá và nằm trong `signal.exits` + `stats.byRule`.
- `stats.conditional` cho P(TP2|TP1), P(TP3|TP1) và tỉ lệ "chạm TP1 rồi vẫn về SL";
  `mfeR`/`maeR` (đi xa nhất / thụt lùi sâu nhất, quy ra R) có trên từng tín hiệu và tổng
  hợp trung vị trong `stats`. Đây là bộ số để đặt luật giữ lệnh — muốn biết có nên giữ tới
  TP xa thì đọc bảng so sánh luật thoát, đừng đọc winrate gộp.
- `stats.byContext` chia theo độ lớn nhịp và cấu trúc HH/HL — LUÔN đọc kèm cột `n`, 300 nến
  M5 chỉ cho 15–30 nhịp nên mỗi ô còn vài lệnh. Muốn số có nghĩa thì nâng `SWING_CANDLES`.

Ba điểm phải nhớ trước khi sửa:
- **Entry lấy tại nến XÁC NHẬN (`pivot.index + lookback`), không phải tại pivot.** Pivot chỉ
  biết được sau `lookback` nến; lấy giá pivot làm entry là nhìn trộm tương lai → winrate ảo.
- **Tín hiệu MỚI NHẤT có thể repaint** — pivot cùng loại cực đoan hơn sẽ dời zigzag. Trường
  `provisional` đánh dấu trường hợp này. Mọi tín hiệu trước đó đã cố định.
- **Nến chạm cả SL lẫn TP trong cùng một cây → tính SL** (không có dữ liệu tick). Chọn phía
  bi quan để winrate không bị thổi phồng.
- **Vàng bỏ nến cuối tuần** (thêm 23/10/2026, như intraday — xem FACTS): `runSwingAnalysis` lấy
  `SWING_CANDLES + closedMarketPadding`, `dropClosedMarketBars` rồi cắt lại. Sáng thứ Hai 19/10 07:00
  VN, 276/300 nến M5 là nến cuối tuần → chỉ 2 tín hiệu (1 SELL giả lúc 02:35 VN khi thị trường đóng);
  sau lọc 14 tín hiệu nối tiếp từ thứ Sáu. Crypto không lọc.

Kết quả **KHÔNG ghi `trading_signals`**: đây là số liệu tính lại được từ nến bất cứ lúc nào,
lưu vào đó sẽ trộn với tín hiệu AI trên dashboard và làm hỏng carry-forward
(`SignalOrchestrator.loadPendingSetup` đọc bản ghi gần nhất theo instrument).

Ba đường gọi thủ công: `GET /api/swing`, nút **🔄** trong panel Nhịp nhỏ ở `/chart`,
`npm run swing`. Mỗi lần gọi là fetch nến mới rồi tính lại từ đầu, không giữ state, không
ghi DB. Tham số chỉnh trong `.env` (`SWING_*`) — `SWING_MIN_LEG_ATR` là núm chính;
`?rule=` (và `--rule=` ở CLI) đổi luật thoát cho riêng một lần gọi.

**Chỉ chạy khi bấm nút — không job nền, không WebSocket (đổi 17/09/2026):** bản trước có
`SwingScheduler` quét nền mỗi vài phút cho mọi symbol rồi đẩy realtime qua
`SwingSocketHub` (WebSocket `/ws/swing`), cộng thêm poll REST 30s bù cho trường hợp khung
đang xem khác khung job nền quét. Đã **bỏ toàn bộ** (kèm `SWING_SCHEDULER_*` trong config
và dependency `ws`): mỗi lần quét là một loạt request tới TwelveData/OANDA cho từng symbol
trong danh sách theo dõi — chạy nền liên tục đốt quota provider cho dữ liệu gần như không
ai đang nhìn. Giờ panel Nhịp nhỏ ở `/chart` chỉ dò khi người dùng bấm **🔄**
(`runSwing()` → `loadSwingPanel()`), lấy khung timeframe từ interval hiện tại của chart
ngay lúc bấm (`getCurrentTvInterval()`). Đổi symbol hoặc đổi interval **không** tự dò lại
— panel hiện lời nhắc bấm 🔄; không còn cache theo symbol, mỗi lần bấm là tính lại từ nến
mới. `swingTimeframe` chỉ còn một việc: bỏ response về trễ khi người dùng đã đổi
symbol/khung trong lúc chờ.

---

## REST API Server — Chi tiết quan trọng

**File:** `src/server.ts`

Chạy cùng process với scheduler (qua `src/index.ts`), lắng nghe port `PORT` (mặc định 3000).

**Authentication:** Header `x-api-key` hoặc `Authorization: Bearer <key>`. Bỏ qua nếu `API_SERVER_KEY` không set. Mọi `/api/*` đều qua `requireApiKey` (kể cả `/api/signals`, `/api/signals/latest`, `/api/usage` — trước 26/10/2026 ba route này public); so key bằng `safeEqual()` (SHA-256 + `timingSafeEqual`, `services/auth/security.ts`). `POST /authorize/submit` (đăng nhập MCP) chặn theo IP sau `AUTHORIZE_MAX_FAILURES` (10) lần sai trong `AUTHORIZE_WINDOW_MIN` (15) phút → 429 (`FailureLimiter`, RAM). Chạy sau reverse proxy phải đặt `TRUST_PROXY` (số hop), nếu không `req.ip` là IP proxy và mọi client bị khoá chung.

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

### GET /api/swing

Dò nhịp nhỏ (zigzag pivot) — **không gọi AI**, trả về trong vài ms.

Query: `?symbol=XAU/USD&timeframe=M5&limit=15&notify=true&rule=TP1_FULL` (đều tùy chọn;
`notify=true` mới gửi Telegram). `rule` = luật thoát dùng cho thống kê chính, ghi đè
`SWING_EXIT_RULE` cho riêng lần gọi đó.

Trả `latest` (tín hiệu mới nhất), `actionable` (còn vào được không), `stats` (winrate /
tổng R + `conditional` P(TPn|TP1) + `byRule` so sánh 3 luật thoát + `byContext`),
`exit_rules` (nhãn 3 luật), `signals[]`, `setup`/`reasoning` (HTML cùng định dạng với phân
tích AI).

Không đụng single-flight của `runAnalysis` — không gọi AI, không ghi DB nên không tranh chấp gì.

### GET /api/setup-watcher

Trạng thái SetupWatcher: cấu hình, `triggers_today`, `next_run_at`, `last_trigger`, `last_error`
và `symbols[symbol].setups[]` — mỗi hướng BUY/SELL đang ở bước nào (`stage`), sweep/cú phá/vùng
retest dò được và `note` giải thích vì sao dừng ở bước đó. Yêu cầu API key.

### GET /api/setup-watcher/history

Lịch sử watcher trong một ngày giờ VN, mới nhất trước. Query: `?date=YYYY-MM-DD` (mặc định hôm nay)
`&symbol=XAU/USD` `&limit=N` (mặc định = trần 5000/loại, tức trả hết cả ngày). Trả
`{ date, events[], ticks[], triggered }` — `events` từ `setup_watch_events` (`detail` đã bóc thành
`sweep`/`structure`/`zone`), `ticks` từ `setup_watch_ticks` (`detail` bóc thành `setups`). Yêu cầu API key.

### GET /api/daily-plan / POST /api/daily-plan/run

`GET`: trạng thái `DailyPlanScheduler` (`hours`, `next_run_at`, `last_result`, `last_error`,
`running`, `current_symbol`, `last_batch` = kết quả từng symbol của lượt gần nhất…). `POST` (body `{ symbol? }`, mặc định symbol đầu của `DAILY_PLAN_SYMBOLS`): lập plan
ngay, trả `setup`/`reasoning` HTML như `/api/analyze`; 409 khi đang có lượt khác. Cả hai yêu cầu API key.

`POST /api/daily-plan/run-all` (thêm 22/10/2026, nút **🗺 Kế hoạch ngày** trên header `/chart`): lập plan cho
MỌI symbol của `DAILY_PLAN_SYMBOLS`, lần lượt, CHẠY NỀN trong `DailyPlanScheduler.runAllNow()` (cùng vòng
`runBatch` với mốc theo lịch, `trigger: 'api'`) → trả 202 ngay vì ~3 phút/symbol dễ bị proxy cắt request.
Đụng single-flight intraday thì chờ như mốc theo lịch; 409 khi một lượt plan khác chưa xong (và ngược lại,
mốc theo lịch tới giữa lượt bấm tay thì bỏ mốc). Nút poll `GET /api/daily-plan` mỗi 10s để hiện tiến độ.

### GET /api/scheduler

Trạng thái scheduler: `enabled`, `interval_min`, `window`, `weekdays`, `symbols`, `runs_per_day`, `next_run_at`, `last_run_at`, `last_action`, `last_error`, `run_count`, `skip_count`, `running` (lượt đang chạy hoặc null). Dùng để soi mốc chạy kế tiếp và lỗi gần nhất mà không cần đọc log.

### GET /api/usage

Token đã dùng + hạn mức còn lại. Yêu cầu API key (dashboard tự gọi mỗi 60s, gửi key từ `localStorage`).

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

Lấy danh sách tín hiệu trong ngày (giờ VN). Query param: `?limit=20` (tối đa 100), `?trigger=event`
(lọc theo nguồn kích hoạt: `event` / `scheduler` / `api` / `mcp`).

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
- API key lưu ở `localStorage`; nếu server trả 401 ở nút phân tích sẽ prompt nhập key rồi thử lại; ở lượt tự refresh (60s) thì hiện nút "🔑 Nhập API key" thay vì prompt liên tục.
- `renderSignalBanner()` hiển thị badge theo action: BUY/SELL/WATCHLIST (`👁 ĐANG CANH`)/NO_TRADE. Hàng Entry/SL/TP chỉ hiện cho BUY/SELL.
- `renderConditionalSetups()` hiển thị chi tiết WATCHLIST (POI đang canh) — đọc `conditional_setups` từ `raw_ai_response` (server `parseSignal()` bóc ra).
- `renderUsage()` (thanh `#usageRow` dưới header) hiển thị token in/out trong ngày + hạn mức còn lại — đọc `GET /api/usage`. Tô cam khi còn ≤30%, đỏ khi ≤10%.
- Tự refresh mỗi 60s.

**Chart `/chart` (`public/chart.html`)** là widget nhúng TradingView (`tv.js`), KHÔNG phải Charting Library:
không vẽ được dữ liệu của hệ thống lên chart, không chạy Pine/script cộng đồng (script SonicR gốc là
protected, không lấy được). **EMA 34 / 89 / 200 bật sẵn** (thêm 23/10/2026, `EMA_STUDIES`), dựng bằng
1 study `STD;MA%Ribbon` (đường thứ 4 tắt). Không dùng 3 study `MAExp@tv-basicstudies` vì widget bỏ qua màu theo study (`override`) lẫn `studies_overrides` → mọi EMA cùng
màu; Ribbon nhận màu qua inputs: đường n (0..3) = `in_{5n}`..`in_{5n+4}` (bật, loại, nguồn, độ dài, màu).
Thanh chọn khung chỉ hiện `favorites.intervals` (1/5/15/60/240/1D — bỏ 30p).

---

## TelegramNotifier — Chi tiết quan trọng

**File:** `src/services/telegram/TelegramNotifier.ts`

- **Kênh chính** nhận bản gọn (`formatSignalSummary`): chỉ header + entry/SL/TP/RR, không kèm giá hiện tại/xu hướng/confidence/kịch bản tiềm năng. **Comment** (discussion thread) mới nhận bản đầy đủ: `formatSignalCard` (giá, xu hướng, confidence, kịch bản) nối với `formatAnalysis` (phân tích chi tiết). `setup` trả về trong response `POST /api/analyze` (cho dashboard) vẫn dùng `formatSignalCard` đầy đủ, không đổi.
- Gửi signal card dạng HTML (không dùng Markdown)
- Badge action: 🟢 MUA / 🔴 BÁN / 👁 ĐANG CANH (WATCHLIST) / ⚪ KHÔNG VÀO LỆNH
- **Dòng nguồn** `🔔 Nguồn: 🎯 Watcher / ⏱ Theo lịch / 👆 Bấm tay / 🤖 MCP` ngay dưới dòng giờ (`TRIGGER_LABEL`), trên cả kênh chính lẫn comment, kể cả thẻ kế hoạch ngày. `trigger` đi `runAnalysis` → `SignalOrchestrator.run(…, trigger)` → `notify`. Thẻ `setup` lưu `analysis_logs` KHÔNG kèm dòng này (dashboard có badge riêng).
- **Kênh riêng theo symbol** (thêm 21/10/2026): `TELEGRAM_CHANNELS_BY_SYMBOL=BTC/USD:-100…,ETH/USD:-100…[:discussionId]`
  → `notifier.forInstrument(symbol)` trả notifier của kênh đó (cache theo chatId); symbol không liệt kê
  → kênh mặc định `TELEGRAM_CHAT_ID`. Mọi đường gửi (intraday `notify`, daily plan, swing `notify=true`)
  đều đi qua `forInstrument`. Kênh riêng KHÔNG dùng `TELEGRAM_DISCUSSION_ID` (nhóm của kênh mặc định) —
  tự dò `linked_chat_id`; kênh chưa gắn nhóm discussion thì bỏ qua comment phân tích đầy đủ (chỉ log warn).
  Hiện `.env` cho BTC + ETH dùng CHUNG nhóm discussion `-1003825713286` (phần thứ 3). Nhóm đó đang gắn
  với kênh ETH → bài ETH được Telegram tự chuyển sang như vàng; kênh BTC không gắn nhóm (Telegram chỉ cho
  1 nhóm gắn 1 kênh) → `findForwardedMessageId` thấy nhóm ≠ `linked_chat_id` nên `forwardMessage` bài
  BTC sang làm mốc rồi trả lời dưới đó (không chờ getUpdates 12s). Hệ quả: bài BTC trên kênh không có nút
  Comments — phân tích BTC chỉ thấy trong nhóm chung.
- Auto-split tin nhắn >4000 ký tự
- Discussion thread: tự resolve DISCUSSION_ID nếu chưa set
- Chuyển đổi markdown AI → HTML Telegram (bảng, bold, italic, bullet)
- Thanh confidence: `████████░░` (10 ký tự)

**Bản gọn — gửi kênh chính (`formatSignalSummary`):**
```
━━━━━━━━━━━━━━━━━━━━━
📊 XAU/USD  🟢 MUA (BUY)
━━━━━━━━━━━━━━━━━━━━━
🕐 14/05/2026 10:30 (Giờ VN)

🎯 Entry:      2343.00
🛡 Stop Loss:  2340.00
💰 Take Profit: 2350.00
⚖️ R:R:        1 : 2.33
━━━━━━━━━━━━━━━━━━━━━
⚠️ Tín hiệu tham khảo từ AI, không phải lời khuyên đầu tư.
```

**Bản đầy đủ — gửi comment/discussion thread (`formatSignalCard` + `formatAnalysis`):** thêm 💵 Giá hiện tại, 📐 Xu hướng, ─ Đánh giá AI ─ (confidence bar), ─ Kịch bản tiềm năng ─ (nếu có conditional setups), rồi tới 📋 PHÂN TÍCH CHI TIẾT.

---

## Market Data Providers

### Binance Futures klines (crypto — thêm 23/10/2026)
```
GET https://fapi.binance.com/fapi/v1/klines?symbol=BTCUSDT&interval=15m&limit=240
GET https://fapi.binance.com/fapi/v1/ticker/price?symbol=BTCUSDT
```
`makeMarketDataProvider()` bọc provider chính trong `CryptoRoutingProvider`: symbol crypto
(`toFuturesSymbol`: BTC/ETH/BNB/SOL/XRP/ADA/DOGE/LTC → `<BASE>USDT`) → `BinanceKlinesProvider`, còn lại →
TwelveData/OANDA. Áp cho MỌI đường gọi (intraday, daily plan, BTC context, watcher, swing, MCP). Public,
không key, không tốn credit TwelveData, `limit` tối đa 1500. Lỗi (geo-block/timeout) → log warn rồi
gọi provider chính (không volume). `CRYPTO_CANDLE_SOURCE=provider` = tắt, dùng TwelveData như cũ.
- **Có volume** (cột 5 của kline = volume theo coin cơ sở) — lý do chuyển nguồn, xem FACTS "Volume tương đối".
- **Giá là BTCUSDT perpetual**, lệch vài USD so với BTC/USD spot trên chart TradingView.
- Timestamp xuất cùng định dạng TwelveData: `"YYYY-MM-DD HH:mm:ss"` giờ treo tường `MARKET_HOURS_TIMEZONE`
  (nến D/H4 mở lúc 00:00 UTC = 07:00 VN, H4 lệch 03/07/11/15/19/23h VN) → `candleTime`, `SessionLevels`,
  prompt đọc như cũ. Nến cuối là nến đang chạy, như TwelveData.

### TwelveData (default — vàng)
```
GET https://api.twelvedata.com/time_series
  ?symbol=XAU/USD&interval=5min&outputsize=100&order=ASC&apikey=...

GET https://api.twelvedata.com/price?symbol=XAU/USD&apikey=...
```
Retry: 2 lần, delay 500ms. Crypto chỉ còn tới đây khi Binance lỗi hoặc `CRYPTO_CANDLE_SOURCE=provider` —
khi đó tự thêm `exchange=Binance` (`cryptoExchange()`), KHÔNG có volume.

**Nhiều API key** (thêm 22/10/2026): `TWELVEDATA_API_KEY=key1,key2` → `config.twelvedata.apiKeys`.
Luôn dùng key đầu còn dùng được; TwelveData trả `code 429` "for the day" → khoá key tới 00:00 UTC
(07:00 VN, lúc reset credit), 429 theo phút → khoá 61s, 401/403 → khoá 1 giờ, rồi thử ngay key kế
trong cùng request. Trạng thái khoá nằm trong RAM (dùng chung mọi instance), log `warn` chỉ in
`#n (…4 ký tự cuối)`. Cửa sổ trượt 8/phút vẫn là MỘT cho cả process (mỗi lúc chỉ dùng một key).
Hai key gói basic = 1600 request/ngày — ngân sách ở phần SetupWatcher tính cho 1 key.

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

1. **Khung thời gian**: Intraday vàng dùng D (bối cảnh), H4 (context), H1, M15 (entry) — thứ tự gửi nến do `tfOrder` trong `ClaudeAnalystService` quyết định.
2. **Ngôn ngữ prompt**: Prompt AI viết bằng tiếng Việt — giữ nguyên. Vàng dùng từ vựng BUY/SELL, crypto dùng LONG/SHORT — khi sửa parser phải giữ map LONG→BUY, SHORT→SELL.
3. **Database**: Dùng Prisma — không dùng raw SQL. Sau mỗi thay đổi schema (`prisma/schema.prisma`), bắt buộc chạy:
   ```bash
   npx prisma generate   # cập nhật Prisma Client
   npx prisma db push    # sync schema → DB (dev) hoặc db:migrate (prod)
   ```
4. **Telegram**: Dùng HTML parse_mode — không dùng MarkdownV2
5. **Config**: Mọi giá trị cứng phải lấy từ `src/config/trading.ts`, không hardcode
6. **Logging**: Dùng `logger` từ `src/logger.ts`, không dùng `console.log`
7. **Chạy phân tích**: Mọi đường trigger mới PHẢI gọi `runAnalysis()` trong `AnalysisRunner.ts`, không gọi thẳng `SignalOrchestrator.run()` — nếu không sẽ gửi Telegram mà không lưu DB, làm carry-forward và dashboard mất dữ liệu. (Tool MCP `run_full_analysis` từng gọi thẳng — đã chuyển sang `runAnalysis({ trigger: 'mcp' })` ngày 22/10/2026, trả lỗi `busy` khi đụng single-flight.)
8. **Quota subscription**: Một lượt phân tích tiêu ~50k input + ~12k output token và mất ~3 phút (Opus 5, effort=high), dùng CHUNG hạn mức với session Claude Code. Trước khi hạ `SCHEDULER_INTERVAL_MIN` xuống dưới 15 hoặc mở rộng khung giờ, tính lại số lượt/ngày (`runs_per_day` trong `/api/scheduler`) và kiểm `/usage`.
