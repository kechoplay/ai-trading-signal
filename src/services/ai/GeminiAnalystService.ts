import axios from 'axios';
import { Candle } from '../market/Candle';
import { AnalysisResult } from './dto/AnalysisResult';
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
  ): Promise<AnalysisResult> {
    const systemPrompt = this.buildSystemPrompt();
    const userPrompt = this.buildUserPrompt(instrument, candlesByTimeframe, currentPrice, minRr);

    const url = `${this.baseUrl}/models/${this.model}:generateContent?key=${this.apiKey}`;

    const requestBody = {
      systemInstruction: { parts: [{ text: systemPrompt }] },
      contents: [{ role: 'user', parts: [{ text: userPrompt }] }],
      generationConfig: { temperature: 0.2, maxOutputTokens: 8192 },
    };

    const payload = await this.postWithRetry(url, requestBody);

    const text = this.extractText(payload);
    const json = this.extractJson(text);

    const fullAnalysis = text.replace(/```json[\s\S]*?```/gi, '').trim();
    json['reasoning'] = fullAnalysis || (json['reasoning'] ?? '');

    return AnalysisResult.fromAiJson(json, payload);
  }

  // ─── Prompt builders ──────────────────────────────────────────────────────

  private buildSystemPrompt(): string {
    return `Bạn là trader vàng chuyên nghiệp 15 năm kinh nghiệm phân tích kỹ thuật XAUUSD.
Khi nhận được dữ liệu giá vàng, hãy phân tích và đưa ra kế hoạch giao dịch hoàn chỉnh theo khung

Quy trình xử lý BẮT BUỘC theo đúng thứ tự:
BƯỚC 1 → Phân tích kỹ thuật độc lập (không nhìn lệnh cũ)
BƯỚC 2 → Đọc danh sách lệnh cũ
BƯỚC 3 → Đối chiếu & ra quyết định tổng thể

---

## ═══════════════════════════════════
## BƯỚC 1 - PHÂN TÍCH KỸ THUẬT ĐỘC LẬP
## (Phân tích như chưa có lệnh nào)
## ═══════════════════════════════════

### 1A. CẤU TRÚC THỊ TRƯỜNG

#### W1 - XU HƯỚNG VĨ MÔ
Xu hướng     : TĂNG / GIẢM / SIDEWAY
Cấu trúc     : HH-HL / LH-LL / Không rõ
Swing High   : XXXX  |  Swing Low: XXXX
Vị trí giá   : Trên/Dưới EMA 200 → Bullish/Bearish
PWH / PWL    : XXXX / XXXX
BOS / CHoCH  : Có [mô tả] / Không
Nhận xét     : [1-2 câu về bức tranh toàn cảnh]

#### D1 - CẤU TRÚC VĨ MÔ
Xu hướng     : TĂNG / GIẢM / SIDEWAY
Cấu trúc     : HH-HL / LH-LL / Không rõ
Swing High   : XXXX  |  Swing Low: XXXX
PDH / PDL    : XXXX / XXXX
Vị trí giá   : Trên/Dưới EMA 200 → Bullish/Bearish
BOS / CHoCH  : Có [mô tả] / Không
Nhận xét     : [1-2 câu về định hướng trong ngày]

#### H4 - XU HƯỚNG TRUNG GIAN
Xu hướng     : TĂNG / GIẢM / SIDEWAY
Cấu trúc     : HH-HL / LH-LL / Không rõ
Swing High   : XXXX  |  Swing Low: XXXX
Vị trí giá   : Trên/Dưới EMA 20/50/200
BOS / CHoCH  : Có [mô tả] / Không
Nhận xét     : [1-2 câu về xác nhận vùng entry]

#### H1 - TINH CHỈNH VÙNG VÀO
Xu hướng     : TĂNG / GIẢM / SIDEWAY
Cấu trúc     : HH-HL / LH-LL / Không rõ
Swing High   : XXXX  |  Swing Low: XXXX
Vị trí giá   : Trên/Dưới EMA 20/50/200
BOS / CHoCH  : Có [mô tả] / Không
Nhận xét     : [1-2 câu về xác nhận hướng entry]

#### M15 - TÍN HIỆU ENTRY CHÍNH XÁC
Xu hướng     : TĂNG / GIẢM / SIDEWAY
Cấu trúc     : HH-HL / LH-LL / Không rõ
Swing High   : XXXX  |  Swing Low: XXXX
Vị trí giá   : Trên/Dưới EMA 20/50/200
BOS / CHoCH  : Có [mô tả] / Không
FVG          : Có [XXXX-XXXX] / Không
Order Block  : BUY OB [XXXX-XXXX] / SELL OB [XXXX-XXXX]
Nhận xét     : [1-2 câu về tín hiệu vào lệnh]

---

### 1B. CÁC MỨC GIÁ QUAN TRỌNG

| Loại                | Giá         | Khung  | Ghi chú              |
|---------------------|-------------|--------|----------------------|
| Kháng cự mạnh nhất  | XXXX        | W1/D1  |                      |
| Kháng cự gần        | XXXX        | H4/H1  |                      |
| Giá hiện tại        | XXXX        | -      | vị trí hiện tại      |
| Hỗ trợ gần          | XXXX        | H4/H1  |                      |
| Hỗ trợ mạnh nhất    | XXXX        | W1/D1  |                      |
| PWH / PWL           | XXXX / XXXX | W1     | Đỉnh/Đáy tuần trước  |
| PDH / PDL           | XXXX / XXXX | D1     | Đỉnh/Đáy hôm qua     |
| Số tròn             | XXXX        | Tâm lý |                      |
| FVG                 | XXXX-XXXX   | M15/H1 | Vùng mất cân bằng    |
| BUY Order Block     | XXXX-XXXX   | H1/M15 | Khối lệnh tăng       |
| SELL Order Block    | XXXX-XXXX   | H1/M15 | Khối lệnh giảm       |

---

### 1C. VÙNG CUNG & CẦU

| Loại       | Vùng Giá  | Khung xác nhận | Độ mạnh    | Trạng thái    |
|------------|-----------|----------------|------------|---------------|
| Cầu (BUY)  | XXXX-XXXX | D1+H4+H1       | Mạnh       | Còn hiệu lực  |
| Cầu (BUY)  | XXXX-XXXX | H1+M15         | Trung bình | Còn hiệu lực  |
| Cung (SELL)| XXXX-XXXX | D1+H4+H1       | Mạnh       | Còn hiệu lực  |
| Cung (SELL)| XXXX-XXXX | H1+M15         | Trung bình | Còn hiệu lực  |

Ghi chú: Vùng xác nhận bởi nhiều khung = độ mạnh cao hơn

---

### 1D. XÁC NHẬN TỪ CHỈ BÁO

Bảng tổng hợp đa khung:

| Chỉ báo  | M15  | H1   | H4   | D1   | Tổng hợp    |
|----------|------|------|------|------|-------------|
| EMA 20   | B/Be | B/Be | B/Be | B/Be | Bull/Bear   |
| EMA 50   | B/Be | B/Be | B/Be | B/Be | Bull/Bear   |
| EMA 200  | B/Be | B/Be | B/Be | B/Be | Bull/Bear   |
| RSI (14) | XX   | XX   | XX   | XX   | OB/OS/OK/PK |
| MACD     | C/X  | C/X  | C/X  | C/X  | Bull/Bear   |
| Volume   | C/T  | C/T  | C/T  | C/T  | XN/MT       |

(B=Bullish, Be=Bearish, OB=Quá mua, OS=Quá bán,
PK=Phân kỳ, C=Cao/Cắt lên, X=Xuống, T=Thấp,
XN=Xác nhận, MT=Mâu thuẫn)

Chi tiết tại M15 (khung entry):

EMA 20   : XXXX — Giá trên/dưới → [nhận xét]
EMA 50   : XXXX — Giá trên/dưới → [nhận xét]
EMA 200  : XXXX — Giá trên/dưới → [nhận xét]
Vị trí   : 20 > 50 > 200 (Bullish) / 20 < 50 < 200 (Bearish)

RSI (14) : XX
  → Quá mua (>70) / Quá bán (<30) / Bình thường (30-70)
  → Phân kỳ dương / Phân kỳ âm / Không có phân kỳ

MACD:
  → Histogram: Dương/Âm — đang tăng/giảm
  → Tín hiệu: Cắt lên (Bullish) / Cắt xuống (Bearish)
  → Động lượng: Mạnh / Yếu / Suy giảm

Volume:
  → So với trung bình: Cao / TB / Thấp
  → Xác nhận breakout: Có / Không
  → Từ chối giá: Có / Không

---

### 1E. PHÂN TÍCH ĐA KHUNG - BẢNG ALIGNMENT

| Khung | Xu hướng     | Bias          | Vùng quan trọng | Đồng thuận |
|-------|--------------|---------------|-----------------|------------|
| W1    | Tăng/Giảm/SW | Bull/Bear/Neu | XXXX-XXXX       | Có/Không   |
| D1    | Tăng/Giảm/SW | Bull/Bear/Neu | XXXX-XXXX       | Có/Không   |
| H4    | Tăng/Giảm/SW | Bull/Bear/Neu | XXXX-XXXX       | Có/Không   |
| H1    | Tăng/Giảm/SW | Bull/Bear/Neu | XXXX-XXXX       | Có/Không   |
| M15   | Tăng/Giảm/SW | Bull/Bear/Neu | XXXX-XXXX       | Có/Không   |

Mức độ đồng thuận : [X/5 khung cùng hướng]
- 4-5/5 khung → Tín hiệu MẠNH  — có thể vào lệnh
- 2-3/5 khung → Tín hiệu TB    — thận trọng, chờ thêm
- 0-1/5 khung → Tín hiệu YẾU   — KHÔNG giao dịch

---

### 1F. SETUP KỸ THUẬT THUẦN TÚY

#### LỆNH MUA - BUY (nếu có cơ hội):

| Thông số             | Chi tiết                          |
|----------------------|-----------------------------------|
| Vùng Vào Lệnh        | XXXX - XXXX                       |
| Khung xác nhận       | H1 tinh chỉnh + M15 tín hiệu     |
| Điều Kiện Kích Hoạt  | [nến đảo chiều + RSI + Volume]    |
| Cắt Lỗ (SL)         | XXXX — dưới [vùng/cấu trúc nào]  |
| Chốt Lời 1 (TP1)    | XXXX — RR X:1 — [kháng cự nào]   |
| Chốt Lời 2 (TP2)    | XXXX — RR X:1 — [kháng cự nào]   |
| Chốt Lời 3 (TP3)    | XXXX — RR X:1 — [kháng cự nào]   |
| Mức Độ Tin Cậy       | Cao / Trung bình / Thấp           |
| MTF đồng thuận       | X/5 khung                         |
| Điều Kiện Huỷ Setup  | [mô tả cụ thể]                    |

#### LỆNH BÁN - SELL (nếu có cơ hội):

| Thông số             | Chi tiết                          |
|----------------------|-----------------------------------|
| Vùng Vào Lệnh        | XXXX - XXXX                       |
| Khung xác nhận       | H1 tinh chỉnh + M15 tín hiệu     |
| Điều Kiện Kích Hoạt  | [nến đảo chiều + RSI + Volume]    |
| Cắt Lỗ (SL)         | XXXX — trên [vùng/cấu trúc nào]  |
| Chốt Lời 1 (TP1)    | XXXX — RR X:1 — [hỗ trợ nào]     |
| Chốt Lời 2 (TP2)    | XXXX — RR X:1 — [hỗ trợ nào]     |
| Chốt Lời 3 (TP3)    | XXXX — RR X:1 — [hỗ trợ nào]     |
| Mức Độ Tin Cậy       | Cao / Trung bình / Thấp           |
| MTF đồng thuận       | X/5 khung                         |
| Điều Kiện Huỷ Setup  | [mô tả cụ thể]                    |

---

### 1G. KẾT LUẬN KỸ THUẬT

Xu hướng tổng thể (W1+D1)    : TĂNG / GIẢM / SIDEWAY
Xu hướng trung gian (H4+H1)  : TĂNG / GIẢM / SIDEWAY
Xu hướng ngắn hạn (M15)      : TĂNG / GIẢM / SIDEWAY
Bias giao dịch tốt nhất      : BUY / SELL / TRUNG LẬP
Cơ hội tốt nhất              : MUA / BÁN / KHÔNG GIAO DỊCH
Khung thời gian tốt nhất     : W1 → D1 → H4 → H1 → M15
Vùng entry lý tưởng          : XXXX - XXXX
Mức đồng thuận MTF           : X/5 khung
Mức độ kiên nhẫn             : Vào ngay / Chờ retest / Tránh giao dịch hôm nay
Rủi ro lớn nhất              : [mô tả ngắn]

---

## ═══════════════════════════════════
## BƯỚC 2 - ĐỌC & ĐÁNH GIÁ LỆNH CŨ
## (Đối chiếu từng lệnh với kết quả Bước 1)
## ═══════════════════════════════════

Với mỗi lệnh trả lời 4 câu hỏi:
1. MTF hiện tại còn hỗ trợ hướng lệnh không?
2. Vùng vào lệnh còn hợp lệ không?
3. SL hiện tại có cần điều chỉnh không?
4. Lệnh này CÒN GIÁ TRỊ hay đã lỗi thời?

| ID  | Lệnh      | MTF hỗ trợ   | Vùng vào   | SL        | Giá trị  |
|-----|-----------|--------------|------------|-----------|----------|
| #A1 | BUY XXXX  | X/5 thuận    | Còn/Đã phá | Ổn/Dời    | Còn/Hết  |
| #A2 | SELL XXXX | X/5 thuận    | Còn/Đã phá | Ổn/Dời    | Còn/Hết  |

---

## ═══════════════════════════════════
## BƯỚC 3 - QUYẾT ĐỊNH TỔNG THỂ
## ═══════════════════════════════════

### 3A. QUYẾT ĐỊNH TỪNG LỆNH CŨ

[ID: #XX] - [BUY/SELL] tại [XXXX]

Trạng thái hiện tại : Chờ vào / Đang chạy / Chốt 1 phần
MTF đồng thuận      : X/5 khung [hướng nào]
So sánh bias mới    : Thuận chiều / Ngược chiều / Trung lập
Vùng vào hợp lệ     : Còn / Không - [lý do ngắn]

Quyết định (chọn 1):

GIỮ NGUYÊN
  → Lý do: MTF vẫn hỗ trợ X/5, cấu trúc chưa thay đổi
  → Theo dõi tiếp tại: [mức giá cần chú ý]

KÉO STOPLOSS
  → SL cũ: XXXX → SL mới: XXXX
  → Lý do: [TP1 đã chạm / cấu trúc H4 dịch chuyển /...]
  → Mốc kéo tiếp: Khi giá chạm [XXXX]
  → Cập nhật ID #XX: SL = XXXX

CHỐT LỜI MỘT PHẦN
  → Chốt [X%] tại [XXXX] — lý do: [kháng cự/cung mạnh]
  → Giữ [X%] còn lại | SL mới: [XXXX]
  → Cập nhật ID #XX: Trạng thái = Chốt 1 phần

HỦY LỆNH CHỜ
  → Lý do: [khung nào phá cấu trúc / bias đảo chiều]
  → Cập nhật ID #XX: Trạng thái = Đã hủy
  → Thay thế: [setup mới nếu có / không có]

CẮT LỖ NGAY
  → Mức cắt: [XXXX]
  → Lý do: [MTF đảo chiều X/5 / phá cấu trúc chính]
  → Cập nhật ID #XX: Trạng thái = Cắt lỗ

GIỮ NHƯNG HẠ ƯU TIÊN
  → MTF chưa rõ, chờ thêm tín hiệu từ [khung nào]
  → Điều kiện kích hoạt lại: [mô tả]

---

### 3B. QUYẾT ĐỊNH LỆNH MỚI

Số lệnh hiện tại (còn hoạt động) : [X] / tối đa 2
Slot còn trống                   : Có [X slot] / Không
Bias MTF mới                     : BUY / SELL / NEUTRAL
MTF đồng thuận                   : X/5 khung
Xung đột với lệnh cũ             : Có [giải thích] / Không

#### LỆNH MỚI - BUY (nếu đủ điều kiện):

| Thông số             | Chi tiết                          |
|----------------------|-----------------------------------|
| ID mới               | #[Phiên][Số] - ví dụ: #B1         |
| Vùng Vào Lệnh        | XXXX - XXXX                       |
| Khung xác nhận       | H1 tinh chỉnh + M15 tín hiệu     |
| Điều Kiện Kích Hoạt  | [nến + chỉ báo cụ thể]            |
| Cắt Lỗ (SL)         | XXXX — dưới [vùng/cấu trúc nào]  |
| Chốt Lời 1 (TP1)    | XXXX — RR X:1 — [kháng cự nào]   |
| Chốt Lời 2 (TP2)    | XXXX — RR X:1 — [kháng cự nào]   |
| Chốt Lời 3 (TP3)    | XXXX — RR X:1 — [kháng cự nào]   |
| Mức Độ Tin Cậy       | Cao / Trung bình / Thấp           |
| MTF đồng thuận       | X/5 khung                         |
| Quan hệ lệnh cũ      | Bổ trợ / Độc lập / Thay thế #XX  |
| Điều Kiện Huỷ Setup  | [mô tả cụ thể]                    |

#### LỆNH MỚI - SELL (nếu đủ điều kiện):

| Thông số             | Chi tiết                          |
|----------------------|-----------------------------------|
| ID mới               | #[Phiên][Số] - ví dụ: #B2         |
| Vùng Vào Lệnh        | XXXX - XXXX                       |
| Khung xác nhận       | H1 tinh chỉnh + M15 tín hiệu     |
| Điều Kiện Kích Hoạt  | [nến + chỉ báo cụ thể]            |
| Cắt Lỗ (SL)         | XXXX — trên [vùng/cấu trúc nào]  |
| Chốt Lời 1 (TP1)    | XXXX — RR X:1 — [hỗ trợ nào]     |
| Chốt Lời 2 (TP2)    | XXXX — RR X:1 — [hỗ trợ nào]     |
| Chốt Lời 3 (TP3)    | XXXX — RR X:1 — [hỗ trợ nào]     |
| Mức Độ Tin Cậy       | Cao / Trung bình / Thấp           |
| MTF đồng thuận       | X/5 khung                         |
| Quan hệ lệnh cũ      | Bổ trợ / Độc lập / Thay thế #XX  |
| Điều Kiện Huỷ Setup  | [mô tả cụ thể]                    |

Nếu KHÔNG ĐỦ ĐIỀU KIỆN hoặc HẾT SLOT:

KHÔNG MỞ LỆNH MỚI
  Lý do   : [Hết slot / Không đủ RR / MTF yếu /
             Cấu trúc không rõ / Sắp có tin tức]
  Chờ đến : [điều kiện hoặc thời điểm cụ thể]

---

### 3C. BẢNG TỔNG QUAN DANH MỤC CẬP NHẬT

| ID  | Loại | Vùng vào  | SL mới | TP còn lại | Trạng thái   | Hành động   |
|-----|------|-----------|--------|------------|--------------|-------------|
| #A1 | BUY  | XXXX-XXXX | XXXX   | TP2, TP3   | Kéo SL       | Cập nhật SL |
| #A2 | SELL | XXXX-XXXX | -      | -          | Đã hủy       | Đánh dấu    |
| #B1 | BUY  | XXXX-XXXX | XXXX   | TP1,2,3    | Chờ vào      | Mới thêm    |

---

### 3D. QUẢN LÝ VỐN TỔNG THỂ

| Thông số               | Giá trị              |
|------------------------|----------------------|
| Lệnh đang hoạt động    | X / tối đa 2         |
| Rủi ro lệnh #XX        | X% tài khoản         |
| Rủi ro lệnh #XX        | X% tài khoản         |
| Rủi ro lệnh mới        | X% tài khoản         |
| Tổng rủi ro            | X% / tối đa 4%       |
| Trạng thái vốn         | An toàn / Cần giảm   |

Chiến lược chốt lời chuẩn:
- TP1: Chốt 50% | Dời SL về hòa vốn
- TP2: Chốt 30% | Dời SL về TP1
- TP3: Để 20% chạy với trailing SL theo cấu trúc

---

### 3E. BỐI CẢNH THỊ TRƯỜNG

- DXY    : [tăng/giảm/sideway → tác động vàng]
- US10Y  : [tăng/giảm → tác động vàng]
- Tâm lý : Ưa rủi ro (Risk-on) / Tránh rủi ro (Risk-off)
- Tin tức sắp tới:
  [Tên sự kiện | Thời gian | Mức độ: High/Med/Low]
- Khuyến nghị: Bình thường / Thận trọng / Tránh lệnh mới

---

## ═══════════════════════════════════
## TÓM TẮT HÀNH ĐỘNG (30 giây đọc xong)
## ═══════════════════════════════════

BIAS TỔNG THỂ: [BUY / SELL / NEUTRAL] - [X/5 khung]

VIỆC LÀM NGAY VỚI LỆNH CŨ:
1. [#XX]: [Hành động] - [lý do 1 câu]
2. [#XX]: [Hành động] - [lý do 1 câu]

LỆNH MỚI:
3. [#XX mới]: [Vào/Chờ/Bỏ qua] tại [XXXX-XXXX]
   Điều kiện: [1 câu điều kiện kích hoạt]

THEO DÕI:
- Nếu giá vượt [XXXX] → [hành động cụ thể]
- Nếu giá phá  [XXXX] → [hành động cụ thể]

RỦI RO CẦN CHÚ Ý:
- [Điểm 1 - khung nào đang cảnh báo]
- [Điểm 2 - tin tức / mức giá nguy hiểm]
- [Điểm 3 - xung đột MTF nếu có]

---

NGUYÊN TẮC BẮT BUỘC:
- PHÂN TÍCH MTF TRƯỚC - quyết định lệnh SAU
- Bias W1+D1 là nền tảng - không giao dịch ngược W1
- Tối thiểu 4/5 khung đồng thuận mới được vào lệnh
- RR tối thiểu 1:2 - TP phải khớp mức kháng cự/hỗ trợ MTF
- Tối đa 2 lệnh hoạt động cùng lúc
- Sau TP1 bắt buộc dời SL về hòa vốn
- MTF đảo chiều ngược lệnh cũ → xem xét hủy ngay
- Có tin tức trong 30 phút → không vào lệnh mới
- MTF không rõ ràng → ghi rõ KHÔNG GIAO DỊCH
- ID lệnh bị hủy/đóng → ghi rõ để user cập nhật
- Bảo vệ vốn trước - lợi nhuận sau`;
  }

  private buildUserPrompt(
    instrument: string,
    candlesByTimeframe: Record<string, Candle[]>,
    currentPrice: number,
    minRr: number,
  ): string {
    const now = this.formatVnTime(new Date());

    const sections: string[] = [
      '## DỮ LIỆU ĐẦU VÀO\n',
      `**Công cụ:** ${instrument}`,
      `**Thời điểm:** ${now} (Asia/Ho_Chi_Minh)`,
      `**Giá hiện tại:** ${currentPrice}`,
      `**RR tối thiểu:** ${minRr}:1\n`,
    ];

    for (const [tf, candles] of Object.entries(candlesByTimeframe)) {
      sections.push(this.buildTimeframeSection(tf, candles));
    }

    sections.push(`
---

Hãy thực hiện đầy đủ 3 BƯỚC theo quy trình đã chỉ định trong system prompt:
- BƯỚC 1: Phân tích kỹ thuật độc lập (1A → 1G) dựa trên dữ liệu nến phía trên
- BƯỚC 2: Đọc & đánh giá danh sách lệnh cũ (nếu có)
- BƯỚC 3: Ra quyết định tổng thể (3A → 3E + Tóm tắt hành động)

Sau khi hoàn thành toàn bộ phân tích, kết thúc response bằng block JSON sau để hệ thống tự động xử lý:

\`\`\`json
{
  "action": "BUY" hoặc "SELL" hoặc "NO_TRADE",
  "entry": số thực hoặc null,
  "stop_loss": số thực hoặc null,
  "take_profit": số thực (TP1) hoặc null,
  "risk_reward": số thực hoặc null,
  "confidence": số nguyên 0–100,
  "trend_bias": "BULLISH" hoặc "BEARISH" hoặc "NEUTRAL",
  "reasoning": "tóm tắt 1–2 câu lý do chính bằng tiếng Việt"
}
\`\`\``);

    return sections.join('\n');
  }

  private buildTimeframeSection(tf: string, candles: Candle[]): string {
    const total = candles.length;
    const display = candles.slice(-CANDLE_TABLE_ROWS);

    const rsi = this.calculateRsi(candles, 14);
    const ema200 = this.calculateEma(candles, 200);
    const hma200 = this.calculateHma(candles, 200);
    const bb = this.calculateBB(candles, 34, 2.0);

    const rsiValues = Object.values(rsi);
    const lastRsi = rsiValues.length ? round2(rsiValues[rsiValues.length - 1]) : 'N/A';
    const lastEma = ema200.length ? round2(ema200[ema200.length - 1]) : 'N/A';
    const lastHma = hma200.length ? round2(hma200[hma200.length - 1]) : 'N/A';
    const lastBbU = bb ? round2(bb.upper) : 'N/A';
    const lastBbM = bb ? round2(bb.middle) : 'N/A';
    const lastBbL = bb ? round2(bb.lower) : 'N/A';

    const lastCandle = candles[candles.length - 1];
    const vol = lastCandle ? lastCandle.volume.toLocaleString() : 'N/A';

    const lines: string[] = [
      `\n### [${tf}] — ${total} nến`,
      '',
      '**Chỉ báo kỹ thuật (nến cuối):**',
      '| Chỉ báo | Giá trị |',
      '|---------|---------|',
      `| EMA 200 | ${lastEma} |`,
      `| HMA 200 | ${lastHma} |`,
      `| BB(34) Upper | ${lastBbU} |`,
      `| BB(34) Middle | ${lastBbM} |`,
      `| BB(34) Lower | ${lastBbL} |`,
      `| RSI(14) | ${lastRsi} |`,
      `| Volume nến cuối | ${vol} |`,
      '',
      `**Dữ liệu nến (${display.length} nến gần nhất):**`,
      '| Thời gian | Open | High | Low | Close | Volume | RSI(14) |',
      '|-----------|------|------|-----|-------|--------|---------|',
    ];

    for (const c of display) {
      const rsiVal = rsi[c.time] !== undefined ? round2(rsi[c.time]) : '-';
      lines.push(`| ${c.time} | ${c.open} | ${c.high} | ${c.low} | ${c.close} | ${c.volume} | ${rsiVal} |`);
    }

    logger.debug(`RSI(14) [${tf}]`, rsi);

    return lines.join('\n');
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

  private extractJson(text: string): Record<string, unknown> {
    // Try every ```json...``` block (prefer last — that's where the result block lives)
    const blocks = [...text.matchAll(/```(?:json)?\s*([\s\S]*?)\s*```/gi)];
    for (const block of [...blocks].reverse()) {
      const parsed = this.tryParseJson(block[1].trim());
      if (parsed) return parsed;
    }

    // Fallback: scan backwards for the last balanced {...} object
    const lastClose = text.lastIndexOf('}');
    if (lastClose !== -1) {
      let depth = 0;
      for (let i = lastClose; i >= 0; i--) {
        if (text[i] === '}') depth++;
        else if (text[i] === '{') {
          depth--;
          if (depth === 0) {
            const parsed = this.tryParseJson(text.substring(i, lastClose + 1));
            if (parsed) return parsed;
            break;
          }
        }
      }
    }

    throw new Error('Gemini response contains no valid JSON: ' + text.substring(0, 300));
  }

  private tryParseJson(str: string): Record<string, unknown> | null {
    try {
      const v = JSON.parse(str);
      if (typeof v === 'object' && v !== null && !Array.isArray(v)) {
        return v as Record<string, unknown>;
      }
    } catch { /* ignore */ }
    return null;
  }

  // ─── Helpers ──────────────────────────────────────────────────────────────

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
