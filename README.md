# AI Trading Signal - XAUUSD

Phân tích XAUUSD (giá vàng) trên sàn OANDA bằng AI (Claude), đưa ra tín hiệu Buy/Sell scalp khung M5 + M15 với Entry/SL/TP, rồi gửi về Telegram mỗi 15 phút.

## Kiến trúc

```
Laravel Scheduler (mỗi 15 phút)
  └─> php artisan signal:analyze
        └─> SignalOrchestrator
              ├─ OandaCandleService    (lấy 100 nến M5 + 100 nến M15)
              ├─ ClaudeAnalystService  (gửi cho Claude → JSON signal)
              ├─ DB: trading_signals   (lưu lịch sử)
              └─ TelegramNotifier      (gửi message có format)
```

## Yêu cầu

- PHP >= 8.2 (đã dùng PHP 8.2.12 của XAMPP)
- Composer
- MySQL (XAMPP)
- Tài khoản OANDA Practice (miễn phí) + API Token
- Anthropic API Key (Claude)
- Telegram Bot Token + Chat ID

## Cấu hình `.env`

```env
OANDA_ENV=practice
OANDA_API_TOKEN=<paste ở đây>
OANDA_ACCOUNT_ID=<paste ở đây>

ANTHROPIC_API_KEY=<paste ở đây>
ANTHROPIC_MODEL=claude-sonnet-4-5-20250929

TELEGRAM_BOT_TOKEN=<paste ở đây>
TELEGRAM_CHAT_ID=<paste ở đây>

TRADING_INSTRUMENT=XAU_USD
TRADING_TIMEFRAMES=M5,M15
TRADING_CANDLES_COUNT=100
TRADING_MIN_RR=2.0
TRADING_LANGUAGE=vi
```

## Hướng dẫn lấy API keys

### 1. OANDA API Token (Practice - miễn phí)

1. Đăng ký/đăng nhập tài khoản Practice: https://www.oanda.com/demo-account/
2. Truy cập: https://www.oanda.com/demo-account/tpa/personal_token
3. Nhấn **Generate Token** → copy token
4. Lấy `OANDA_ACCOUNT_ID` trong trang account (dạng `101-011-XXXXXXXX-001`)

### 2. Anthropic Claude API Key

1. https://console.anthropic.com/ → đăng ký
2. Nạp credit (Billing) tối thiểu $5
3. API Keys → Create Key → copy `sk-ant-api03-...`

### 3. Telegram Bot + Chat ID

**Tạo Bot:**
1. Chat với [@BotFather](https://t.me/BotFather) → gửi `/newbot`
2. Đặt tên + username (kết thúc bằng `bot`)
3. Copy token dạng `8012345678:AAH...`

**Lấy Chat ID:**
1. Chat với bot vừa tạo, nhấn Start (gửi "hi")
2. Mở URL: `https://api.telegram.org/bot<TOKEN>/getUpdates`
3. Tìm `"chat":{"id":123456789}` → đó là Chat ID

## Chạy thử thủ công

```powershell
php artisan signal:analyze
```

## Chạy tự động 15 phút/lần (Windows Task Scheduler)

Laravel có scheduler tích hợp — bạn chỉ cần tạo 1 task Windows chạy `php artisan schedule:run` **mỗi phút**. Laravel sẽ tự quyết định khi nào chạy `signal:analyze` (mỗi 15 phút).

### Tạo task bằng PowerShell (chạy Administrator):

```powershell
$action = New-ScheduledTaskAction `
    -Execute "D:\xampp\php\php.exe" `
    -Argument "artisan schedule:run" `
    -WorkingDirectory "D:\ai-trading-signal"

$trigger = New-ScheduledTaskTrigger -Once -At (Get-Date) `
    -RepetitionInterval (New-TimeSpan -Minutes 1) `
    -RepetitionDuration (New-TimeSpan -Days 3650)

$settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -StartWhenAvailable `
    -MultipleInstances IgnoreNew

$principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType S4U -RunLevel Highest

Register-ScheduledTask `
    -TaskName "Laravel - AI Trading Signal" `
    -Action $action `
    -Trigger $trigger `
    -Settings $settings `
    -Principal $principal `
    -Description "Runs Laravel scheduler every minute for XAUUSD signal analysis"
```

### Kiểm tra task đã hoạt động:

```powershell
Get-ScheduledTask -TaskName "Laravel - AI Trading Signal"
Start-ScheduledTask -TaskName "Laravel - AI Trading Signal"
```

### Xóa task (nếu cần):

```powershell
Unregister-ScheduledTask -TaskName "Laravel - AI Trading Signal" -Confirm:$false
```

## Log

- `storage/logs/laravel.log` — log chung của app
- `storage/logs/signal.log` — output của `signal:analyze`

## Xem lịch sử tín hiệu

```sql
-- Vào MySQL (XAMPP)
USE ai_trading_signal;
SELECT id, action, confidence, entry, stop_loss, take_profit, risk_reward, trend_bias, created_at
FROM trading_signals
ORDER BY id DESC
LIMIT 20;
```

## Cấu trúc chính

```
app/
  Console/Commands/
    AnalyzeSignalCommand.php          # php artisan signal:analyze
  Models/
    TradingSignal.php                 # Eloquent model
  Services/
    Oanda/
      OandaCandleService.php          # HTTP client OANDA
      Dto/Candle.php
    Ai/
      ClaudeAnalystService.php        # gọi Claude API
      Dto/AnalysisResult.php
    Telegram/
      TelegramNotifier.php            # gửi tin nhắn
    Signal/
      SignalOrchestrator.php          # điều phối toàn bộ
config/
  trading.php                         # config tập trung
database/migrations/
  ..._create_trading_signals_table.php
routes/
  console.php                         # đăng ký schedule */15 phút
```

## Lưu ý quan trọng

- **Đây là tín hiệu tham khảo** — AI có thể sai. KHÔNG bao giờ trade live bằng tiền thật chỉ dựa vào bot này. Luôn backtest + quản lý vốn.
- OANDA Practice data giống Live về giá (cùng feed), nên không cần trả phí gì.
- Claude call tốn khoảng **$0.01 - $0.03/lần** (tuỳ model). Chạy 15 phút/lần = ~96 lần/ngày → ~$1-3/ngày.
