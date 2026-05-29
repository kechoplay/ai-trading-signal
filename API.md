# AI Trading Signal — API Documentation

Base URL: `http://localhost:3000`

---

## Authentication

Tất cả endpoint có ký hiệu 🔒 đều yêu cầu API key. Truyền key theo một trong hai cách:

```
X-API-Key: your_api_key
```
hoặc
```
Authorization: Bearer your_api_key
```

Cấu hình key trong `.env`:
```env
API_SERVER_KEY=your_api_key
```

> Nếu `API_SERVER_KEY` để trống, tất cả endpoint đều public, không cần xác thực.

---

## Analyze

### POST /api/analyze 🔒

Chạy phân tích AI cho một symbol, gửi tín hiệu lên Telegram và lưu kết quả vào DB.

> ⏱ Thời gian phản hồi thường từ **30–90 giây** do phải fetch dữ liệu nến + gọi AI.

**Request body:**

| Field | Type | Required | Mô tả |
|-------|------|----------|-------|
| `symbol` | string | Không | Symbol cần phân tích. Mặc định lấy từ `TRADING_INSTRUMENT` trong `.env` |

**Ví dụ request:**

```bash
# Dùng symbol mặc định
curl -X POST http://localhost:3000/api/analyze \
  -H "X-API-Key: your_key" \
  -H "Content-Type: application/json"

# Chỉ định symbol
curl -X POST http://localhost:3000/api/analyze \
  -H "X-API-Key: your_key" \
  -H "Content-Type: application/json" \
  -d '{"symbol": "XAU/USD"}'
```

**Response 200:**

```json
{
  "ok": true,
  "symbol": "XAU/USD",
  "duration_ms": 42381,
  "setup": "━━━━━━━━━━━━━━━━━━━━━\n📊 <b>XAU/USD</b>  🟢 <b>MUA (BUY)</b>\n...",
  "reasoning": "📋 <b>PHÂN TÍCH CHI TIẾT</b>\n━━━━━━━━━━━━━━━━━━━━━\n..."
}
```

| Field | Type | Mô tả |
|-------|------|-------|
| `ok` | boolean | `true` nếu thành công |
| `symbol` | string | Symbol đã phân tích |
| `duration_ms` | number | Thời gian xử lý (milliseconds) |
| `setup` | string | Signal card dạng HTML (giống tin nhắn Telegram channel) |
| `reasoning` | string | Phân tích chi tiết dạng HTML (giống comment trong Telegram thread) |

**Response 401:**
```json
{ "error": "Unauthorized" }
```

**Response 500:**
```json
{ "error": "mô tả lỗi" }
```

---

## Symbols

### GET /api/symbols 🔒

Lấy danh sách tất cả symbols. Favorite được hiển thị trước, sau đó sắp xếp theo tên.

```bash
curl http://localhost:3000/api/symbols \
  -H "X-API-Key: your_key"
```

**Response 200:**

```json
[
  {
    "id": 1,
    "symbol": "XAU/USD",
    "name": "Vàng",
    "enabled": true,
    "favorite": true,
    "created_at": "2026-05-27T10:00:00.000Z"
  },
  {
    "id": 3,
    "symbol": "BTC/USD",
    "name": "Bitcoin",
    "enabled": true,
    "favorite": false,
    "created_at": "2026-05-27T10:00:00.000Z"
  }
]
```

---

### POST /api/symbols 🔒

Thêm symbol mới.

**Request body:**

| Field | Type | Required | Mô tả |
|-------|------|----------|-------|
| `symbol` | string | Có | Mã symbol (tự động chuyển thành chữ hoa). Ví dụ: `XAU/USD` |
| `name` | string | Có | Tên hiển thị. Ví dụ: `Vàng` |

```bash
curl -X POST http://localhost:3000/api/symbols \
  -H "X-API-Key: your_key" \
  -H "Content-Type: application/json" \
  -d '{"symbol": "XAU/USD", "name": "Vàng"}'
```

**Response 201:**

```json
{
  "id": 1,
  "symbol": "XAU/USD",
  "name": "Vàng",
  "enabled": true,
  "favorite": false,
  "created_at": "2026-05-27T10:00:00.000Z"
}
```

**Response 400** — thiếu field bắt buộc:
```json
{ "error": "symbol and name are required" }
```

**Response 409** — symbol đã tồn tại:
```json
{ "error": "Symbol 'XAU/USD' already exists" }
```

---

### DELETE /api/symbols/:symbol 🔒

Xóa symbol. Toàn bộ lịch sử phân tích (`analysis_logs`) của symbol này cũng bị xóa theo (cascade).

> ⚠️ Symbol trong URL phải encode `/` thành `%2F`.

```bash
curl -X DELETE "http://localhost:3000/api/symbols/XAU%2FUSD" \
  -H "X-API-Key: your_key"
```

**Response 200:**
```json
{ "ok": true, "deleted": "XAU/USD" }
```

**Response 404:**
```json
{ "error": "Symbol 'XAU/USD' not found" }
```

---

### PATCH /api/symbols/:symbol/favorite 🔒

Thêm hoặc bỏ symbol khỏi danh sách favorite.

**Request body:**

| Field | Type | Required | Mô tả |
|-------|------|----------|-------|
| `favorite` | boolean | Không | `true` để thêm favorite, `false` để bỏ. Mặc định `true` nếu không truyền |

```bash
# Thêm favorite
curl -X PATCH "http://localhost:3000/api/symbols/XAU%2FUSD/favorite" \
  -H "X-API-Key: your_key" \
  -H "Content-Type: application/json" \
  -d '{"favorite": true}'

# Bỏ favorite
curl -X PATCH "http://localhost:3000/api/symbols/XAU%2FUSD/favorite" \
  -H "X-API-Key: your_key" \
  -H "Content-Type: application/json" \
  -d '{"favorite": false}'
```

**Response 200:**
```json
{
  "id": 1,
  "symbol": "XAU/USD",
  "name": "Vàng",
  "enabled": true,
  "favorite": true,
  "created_at": "2026-05-27T10:00:00.000Z"
}
```

**Response 404:**
```json
{ "error": "Symbol 'XAU/USD' not found" }
```

---

### GET /api/symbols/:symbol/signals 🔒

Lấy lịch sử phân tích của một symbol, mới nhất lên đầu.

**Query params:**

| Param | Type | Default | Mô tả |
|-------|------|---------|-------|
| `limit` | number | `20` | Số bản ghi trả về. Tối đa `100` |

```bash
curl "http://localhost:3000/api/symbols/XAU%2FUSD/signals?limit=10" \
  -H "X-API-Key: your_key"
```

**Response 200:**

```json
[
  {
    "id": 7,
    "symbol": "XAU/USD",
    "analyzed_at": "2026-05-27T10:30:00.000Z",
    "duration_ms": 42381,
    "setup": "━━━━━━━━━━━━━━━━━━━━━\n📊 <b>XAU/USD</b>  🟢 <b>MUA (BUY)</b>\n...",
    "reasoning": "📋 <b>PHÂN TÍCH CHI TIẾT</b>\n━━━━━━━━━━━━━━━━━━━━━\n..."
  }
]
```

| Field | Type | Mô tả |
|-------|------|-------|
| `id` | number | ID bản ghi |
| `symbol` | string | Symbol |
| `analyzed_at` | string | Thời điểm phân tích (ISO 8601) |
| `duration_ms` | number | Thời gian AI xử lý (milliseconds) |
| `setup` | string | Signal card HTML |
| `reasoning` | string | Phân tích chi tiết HTML |

---

## Signals (Legacy)

### GET /api/signals

Lấy danh sách tín hiệu giao dịch từ bảng `trading_signals` (cron job ghi vào).

**Query params:**

| Param | Type | Default | Mô tả |
|-------|------|---------|-------|
| `limit` | number | `20` | Số bản ghi. Tối đa `100` |

```bash
curl "http://localhost:3000/api/signals?limit=5"
```

---

## Symbols mặc định

Hệ thống seed sẵn 4 symbols khi khởi tạo DB:

| Symbol | Tên |
|--------|-----|
| `XAU/USD` | Vàng |
| `XAG/USD` | Bạc |
| `BTC/USD` | Bitcoin |
| `ETH/USD` | Ethereum |

---

## Mã lỗi HTTP

| Status | Ý nghĩa |
|--------|---------|
| `200` | Thành công |
| `201` | Tạo mới thành công |
| `400` | Request không hợp lệ (thiếu field bắt buộc) |
| `401` | Sai hoặc thiếu API key |
| `404` | Không tìm thấy resource |
| `409` | Conflict (symbol đã tồn tại) |
| `500` | Lỗi server |

---

## Khởi động server

```bash
# Development (auto-reload)
npm run server:dev

# Production
npm run server
```
