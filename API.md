# API Reference — AI Trading Signal

Base URL: `http://localhost:3000`

## Authentication

Nếu biến môi trường `API_SERVER_KEY` được set, mọi endpoint có `requireApiKey` đều yêu cầu xác thực qua một trong hai cách:

```
X-Api-Key: <API_SERVER_KEY>
# hoặc
Authorization: Bearer <API_SERVER_KEY>
```

Nếu `API_SERVER_KEY` để trống, xác thực bị bỏ qua.

---

## Analyze

### POST `/api/analyze`

Chạy phân tích AI cho một symbol và trả về signal card + reasoning. Kết quả cũng được lưu vào bảng `analysis_logs`.

**Request body** (JSON, tùy chọn):

| Field | Type | Mô tả |
|-------|------|-------|
| `symbol` | string | Symbol cần phân tích (vd: `XAU/USD`). Mặc định: giá trị `TRADING_INSTRUMENT` trong `.env` |

**Response 200:**

```json
{
  "ok": true,
  "symbol": "XAU/USD",
  "duration_ms": 4200,
  "setup": "<HTML signal card>",
  "reasoning": "<HTML analysis text>"
}
```

**Response 500:**

```json
{ "error": "Analysis failed" }
```

---

## Symbols

### GET `/api/symbols`

Lấy danh sách tất cả symbols, sắp xếp: favorite trước, rồi theo tên A-Z.

**Response 200:**

```json
[
  {
    "id": 1,
    "symbol": "XAU/USD",
    "name": "Gold",
    "enabled": true,
    "favorite": true,
    "created_at": "2026-05-29T00:00:00.000Z"
  }
]
```

---

### POST `/api/symbols`

Thêm symbol mới.

**Request body:**

| Field | Type | Bắt buộc | Mô tả |
|-------|------|----------|-------|
| `symbol` | string | Có | Mã symbol, sẽ được uppercase (vd: `EUR/USD`) |
| `name` | string | Có | Tên hiển thị (vd: `Euro / US Dollar`) |

**Response 201:** Object symbol vừa tạo.

**Response 400:** `symbol` hoặc `name` bị thiếu.

**Response 409:** Symbol đã tồn tại.

---

### DELETE `/api/symbols/:symbol`

Xóa symbol theo mã (case-insensitive, tự động uppercase).

**Response 200:**

```json
{ "ok": true, "deleted": "XAU/USD" }
```

**Response 404:** Symbol không tồn tại.

---

### PATCH `/api/symbols/:symbol/favorite`

Cập nhật trạng thái yêu thích của symbol.

**Request body:**

| Field | Type | Mô tả |
|-------|------|-------|
| `favorite` | boolean | `true` để đánh dấu yêu thích, `false` để bỏ. Mặc định: `true` |

**Response 200:** Object symbol đã cập nhật.

**Response 404:** Symbol không tồn tại.

---

## Symbol Groups

### GET `/api/groups`

Lấy danh sách tất cả nhóm symbol, kèm mảng `symbols` chứa các mã trong nhóm.

**Response 200:**

```json
[
  {
    "id": 1,
    "name": "Metals",
    "created_at": "2026-05-29T00:00:00.000Z",
    "symbols": ["XAU/USD", "XAG/USD"]
  }
]
```

---

### POST `/api/groups`

Tạo nhóm mới.

**Request body:**

| Field | Type | Bắt buộc | Mô tả |
|-------|------|----------|-------|
| `name` | string | Có | Tên nhóm |

**Response 201:** `{ id, name, created_at, symbols: [] }`

**Response 400:** `name` bị thiếu.

**Response 409:** Nhóm đã tồn tại.

---

### GET `/api/groups/:id`

Lấy chi tiết một nhóm, kèm danh sách đầy đủ object symbol.

**Response 200:**

```json
{
  "id": 1,
  "name": "Metals",
  "created_at": "2026-05-29T00:00:00.000Z",
  "symbols": [
    { "id": 1, "symbol": "XAU/USD", "name": "Gold", "enabled": true, "favorite": true, "created_at": "..." }
  ]
}
```

**Response 400:** `id` không hợp lệ.

**Response 404:** Nhóm không tồn tại.

---

### DELETE `/api/groups/:id`

Xóa nhóm (cascade xóa cả các `symbol_group_items`).

**Response 200:**

```json
{ "ok": true, "deleted": 1 }
```

**Response 404:** Nhóm không tồn tại.

---

### POST `/api/groups/:id/symbols`

Thêm symbol vào nhóm.

**Request body:**

| Field | Type | Bắt buộc | Mô tả |
|-------|------|----------|-------|
| `symbol` | string | Có | Mã symbol đã có trong bảng `symbols` |

**Response 201:** Object `SymbolGroupItem` vừa tạo.

**Response 400:** `id` hoặc `symbol` không hợp lệ.

**Response 404:** Nhóm hoặc symbol không tồn tại.

**Response 409:** Symbol đã có trong nhóm.

---

### DELETE `/api/groups/:id/symbols/:symbol`

Xóa symbol khỏi nhóm.

**Response 200:**

```json
{ "ok": true, "group_id": 1, "removed": "XAU/USD" }
```

---

## Analysis Logs

### GET `/api/symbols/:symbol/signals`

Lấy lịch sử phân tích của một symbol **trong ngày hôm nay** (theo giờ VN, UTC+7).

**Query params:**

| Param | Type | Mô tả |
|-------|------|-------|
| `limit` | number | Số bản ghi tối đa (mặc định: `20`, tối đa: `100`) |

**Response 200:**

```json
[
  {
    "id": 42,
    "symbol": "XAU/USD",
    "analyzed_at": "2026-05-29T10:30:00.000Z",
    "duration_ms": 4200,
    "setup": "<HTML signal card>",
    "reasoning": "<HTML analysis text>"
  }
]
```

---

## Trading Signals (Legacy)

### GET `/api/signals`

Lấy danh sách trading signals từ bảng `trading_signals` **trong ngày hôm nay** (theo giờ VN). Endpoint này **không yêu cầu API key**.

**Query params:**

| Param | Type | Mô tả |
|-------|------|-------|
| `limit` | number | Số bản ghi tối đa (mặc định: `20`, tối đa: `100`) |

**Response 200:** Mảng signal objects, mỗi phần tử gồm tất cả cột trong `trading_signals` cộng thêm các field được parse từ `raw_ai_response`:

| Field bổ sung | Mô tả |
|--------------|-------|
| `market_structure` | Cấu trúc thị trường từ AI response |
| `key_levels` | Vùng cung cầu / key levels |
| `setups` | Setup giao dịch chi tiết |

---

## Static Files

Thư mục `public/` được serve tĩnh tại `/`. Dashboard web (nếu có) truy cập qua `http://localhost:3000/`.
