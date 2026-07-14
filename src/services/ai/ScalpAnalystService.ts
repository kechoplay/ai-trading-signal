import { ClaudeAnalystService } from './ClaudeAnalystService';
import { config } from '../../config/trading';
import { Candle } from '../market/Candle';
import { IctFacts } from './ict/IctPreprocessor';

/**
 * Analyst SCALP tốc độ cao cho XAU/USD — bộ khung M15 (context nhẹ) / M5 (khung quyết định
 * chính, thay vai H1 của hệ thống v3.2) / M1 (entry). Ưu tiên TẦN SUẤT: chấp nhận RR/winrate
 * mỗi lệnh thấp hơn hệ thống đa khung, đổi lại bắt được nhiều nhịp ngắn hợp lệ hơn.
 *
 * Dùng chung pipeline/parser của ClaudeAnalystService (BUY/SELL/WATCHLIST/NO_TRADE),
 * chỉ override tfOrder + system prompt. Chỉ M1 (entry) gửi nến thô — các khung còn lại
 * dùng FACTS đã tính sẵn (rawCandlesByTfFor trả undefined → buildUserPrompt chỉ gửi nến
 * khung entry theo cơ chế mặc định).
 */
export class ScalpAnalystService extends ClaudeAnalystService {
  protected readonly tfOrder = ['M15', 'M5', 'M1'];

  static fromConfig(): ScalpAnalystService {
    if (!config.claude.apiKey) throw new Error('CLAUDE_API_KEY is not configured.');
    return new ScalpAnalystService(config.claude.model);
  }

  /** Scalp chỉ gửi nến thô khung entry (M1) — trả undefined để dùng cơ chế mặc định. */
  protected rawCandlesByTfFor(): Record<string, number> | undefined {
    return undefined;
  }

  /**
   * Chèn khối [STATE] (Gate S0 bắt buộc) lên đầu user prompt, trước block FACTS.
   * Pipeline không tự sinh [STATE] → nếu thiếu atr_m5_avg20, Gate S5 rơi về chế độ fallback
   * và confidence bị trần Medium.
   */
  protected buildUserPrompt(
    candlesByTimeframe: Record<string, Candle[]>,
    facts: IctFacts,
    tfOrder: string[] = this.tfOrder,
    rawCandles: number = config.claude.rawCandles,
    rawCandlesByTf?: Record<string, number>,
  ): string {
    const base  = super.buildUserPrompt(candlesByTimeframe, facts, tfOrder, rawCandles, rawCandlesByTf);
    const state = this.buildStateBlock(candlesByTimeframe, facts);
    return `${state}\n\n${base}`;
  }

  /**
   * Dựng khối [STATE] mà prompt scalp yêu cầu: chỉ các trường ATR + giờ server. Kỷ luật
   * "một lệnh tại một thời điểm" và bộ lọc tin tức KHÔNG còn là gate model tự kiểm (prompt
   * chuyển thành khối nhắc người dùng tự thực thi), nên [STATE] không mang open_scalp_position
   * hay lịch tin.
   */
  private buildStateBlock(candlesByTimeframe: Record<string, Candle[]>, facts: IctFacts): string {
    const atrM5      = facts.timeframes['M5']?.atr;
    const atrM1      = facts.timeframes['M1']?.atr;
    const atrM5Avg20 = this.meanTrueRange(candlesByTimeframe['M5'], 20);
    const serverTimeVn = new Intl.DateTimeFormat('en-GB', {
      timeZone: config.marketHours.timezone, hour12: false,
      hour: '2-digit', minute: '2-digit',
    }).format(new Date());

    const lines = [
      '=== [STATE] (trạng thái runtime — DÙNG cho Gate S0/S5) ===',
      '[STATE]',
      ...(atrM5      != null ? [`- atr_m5_current: ${atrM5}`]    : []),
      ...(atrM5Avg20 != null ? [`- atr_m5_avg20: ${atrM5Avg20}`] : []),
      ...(atrM1      != null ? [`- atr_m1_current: ${atrM1}`]    : []),
      `- server_time_vn: ${serverTimeVn}`,
    ];
    return lines.join('\n');
  }

  /** True Range trung bình N nến gần nhất (USD) — baseline biến động cho Gate S5. */
  private meanTrueRange(candles: Candle[] | undefined, period: number): number | null {
    if (!candles || candles.length < period + 1) return null;
    const trs: number[] = [];
    for (let i = 1; i < candles.length; i++) {
      const h = candles[i].high, l = candles[i].low, pc = candles[i - 1].close;
      trs.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)));
    }
    const recent = trs.slice(-period);
    return Math.round((recent.reduce((a, b) => a + b, 0) / recent.length) * 100) / 100;
  }

  protected buildSystemPrompt(): string {
    return `## PHÂN VAI KHUNG THỜI GIAN
- **M15 — CONTEXT NHẸ**: chỉ dùng để tránh đưa TP vào giữa một vùng nghịch lớn (Gate S3). KHÔNG dùng làm điều kiện bias bắt buộc.
- **M5 — KHUNG QUYẾT ĐỊNH CHÍNH**: xác định bias/trend, BOS/CHoCH, POI (OB/FVG), premium/discount ngắn hạn. Đây là khung "sếp" của cả hệ thống scalp này — thay thế vai trò của H1 trong hệ thống v3.2.
- **M1 — ĐIỂM VÀO**: tối ưu entry, SL sát nhất, xác nhận cuối cùng bằng nến M1 (theo tiêu chí định lượng ở mục Confirmation).

---

Bạn là trader scalp chuyên nghiệp XAU/USD, phong cách phản ứng nhanh, ra lệnh nhiều lần trong phiên khi thị trường đủ điều kiện. Bạn KỶ LUẬT về quản lý rủi ro (SL/RR luôn rõ ràng) nhưng KHÔNG cầu toàn về số lượng tín hiệu — mục tiêu là bắt được nhiều nhịp ngắn hợp lệ, không phải chỉ vài setup hoàn hảo/ngày.

Tôi cung cấp dữ liệu cho các khung: M15 (context nhẹ), M5 (bias/POI — khung chính), M1 (entry).
Code đã TÍNH SẴN "FACTS": bias, ATR, range/fib, swing highs/lows, FVG, OB, equal highs/lows, kill zone. DÙNG TRỰC TIẾP, không tính lại. Khung M1 kèm nến OHLC thô để đọc confirmation cuối.
Phân tích THUẦN TÚY price action. Bỏ qua bình luận ngoài cấu trúc output.

## ⬛ INPUT SCHEMA BẮT BUỘC (MỚI — Gate S0)

Ngoài FACTS kỹ thuật, MỖI lần phân tích input PHẢI kèm khối trạng thái sau. Thiếu bất kỳ trường nào → điền "KHÔNG CÓ DỮ LIỆU" vào SUMMARY và xử lý theo quy tắc fallback ghi tại từng gate. KHÔNG được tự giả định giá trị.

\`\`\`
[STATE]
- atr_m5_current: [số]                     # ATR M5 hiện tại (USD)
- atr_m5_avg20: [số]                       # ATR M5 trung bình 20 nến (USD) — phục vụ Gate S5
- atr_m1_current: [số]                     # ATR M1 hiện tại (USD) — phục vụ đệm SL
- server_time_vn: [HH:MM]                  # giờ VN hiện tại — xác định kill zone
\`\`\`

### ⛔ GATE S0 — TÍNH TOÀN VẸN DỮ LIỆU (HARD GATE, MỚI)
- \`atr_m5_avg20\` thiếu → Gate S5 chạy chế độ fallback (xem S5) và confidence tối đa chỉ được **Medium**.
- Dữ liệu giá (swing/OB/FVG) mâu thuẫn nhau hoặc nằm ngoài dải high-low của nến trong data → NO TRADE, ghi rõ "FACTS mâu thuẫn".
- Hệ thống KHÔNG nhận dữ liệu lịch tin — bộ lọc tin tức là trách nhiệm người dùng (xem Gate S5 và khối nhắc thực thi). Model KHÔNG BAO GIỜ tự khẳng định "không có tin tức" hay ghi PASS cho mục tin tức.

## QUY ƯỚC
- Đơn vị giá USD trực tiếp (không dùng "pip").
- **QUY TẮC TRÍCH NGUỒN (chống bịa giá)**: MỌI mức giá xuất hiện trong output (entry, SL, TP, POI, swing, mục tiêu thanh khoản) PHẢI trích dẫn từ ĐÚNG dòng dữ liệu đã cung cấp, dùng CHÍNH nhãn có trong data — KHÔNG tự đặt tên trường không tồn tại.
  - Với mức giá từ block FACTS kỹ thuật: cú pháp \`[FACTS: <khung> <nhãn dòng> = <giá trị>]\`, trong đó \`<nhãn dòng>\` là nhãn CÓ THẬT trong block khung đó (ví dụ: "Swing lows", "Swing highs", "Order Blocks", "FVG", "Equal highs", "Equal lows", "EQ(50%)", "ATR"). Ví dụ: \`SL: 3312.10 — neo swing low M5 [FACTS: M5 Swing lows = 3312.60] − đệm 0.5 × ATR M1 [STATE: atr_m1_current = 1.00]\`.
  - Với giá trị từ khối [STATE]: cú pháp \`[STATE: tên_trường = giá trị]\` (ví dụ \`atr_m5_current\`, \`atr_m5_avg20\`, \`atr_m1_current\`).
  - Mức giá KHÔNG trích được từ FACTS/[STATE] (kể cả giá suy ra từ phép cộng/trừ phải ghi rõ phép tính) → không được dùng → nếu vì thế không đặt được SL/TP → NO TRADE với lý do "data không đủ".
- Mỗi lần phân tích xuất MỘT chiều (BUY hoặc SELL).
- **Khung giờ giao dịch**: KHÔNG giới hạn cứng theo kill zone — lọc bằng biến động thực tế (Gate S5). Vẫn GHI RÕ trong output nếu đang trong/ngoài kill zone London (14:00–17:00 hoặc 15:00–18:00 giờ VN tùy DST) / NY (19:30–22:00 hoặc 20:30–23:00 giờ VN tùy DST), xác định bằng \`server_time_vn\`, để người dùng tự cân nhắc thêm.
- **Time-stop (SỬA — hết ngoại lệ mềm)**: lệnh không chạm TP cũng không chạm SL sau **6 nến M5 (30 phút)** → khuyến nghị THOÁT THỦ CÔNG tại giá thị trường. Ngoại lệ DUY NHẤT và ĐỊNH LƯỢNG: nếu tại thời điểm hết hạn, giá đã đi được ≥ 50% quãng đường Entry→TP và nến M5 hiện tại đóng cửa thuận hướng lệnh → được gia hạn MỘT lần thêm 3 nến M5, sau đó thoát vô điều kiện. Không có ngoại lệ nào khác — "cảm giác giá vẫn đúng hướng" không phải căn cứ.

## ĐỊNH NGHĨA KỸ THUẬT
- **BOS hợp lệ (M5)**: body close vượt swing high/low M5 gần nhất theo hướng.
- **CHoCH hợp lệ (M5)**: body close phá swing point M5 ngược hướng cấu trúc cũ + tối thiểu 1 nến M5 có thân ≥ 50% range của chính nó, đóng cửa theo hướng mới.
- **Liquidity sweep**: giá quét qua đỉnh/đáy rõ ràng (equal highs/lows M5/M15) rồi đảo lại trong vòng ≤ 3 nến M5.
- **POI hợp lệ**: OB/FVG M5 (ưu tiên) hoặc M15 (bổ trợ), nằm đúng hướng lệnh dự kiến, có trong FACTS.
- **Continuation setup**: M5 đang trend rõ (chuỗi BOS cùng hướng, chưa có CHoCH ngược) + pullback về OB/FVG M5 gần nhất theo hướng trend. KHÔNG cần chờ discount/premium sâu. Đây là điểm cho phép tần suất cao.
- **Reversal setup**: sweep rõ + CHoCH M5 xác nhận + POI đúng hướng. Không cần khớp bias H1.

## QUY TRÌNH PHÂN TÍCH

1. **M5 — Bias & cấu trúc**: xác định BOS/CHoCH gần nhất → BULLISH / BEARISH / SIDEWAYS. Ghi rõ **continuation** hay **reversal**.
   ### ⛔ GATE S1 — LOẠI SIDEWAYS (HARD GATE, ĐÃ ĐỊNH LƯỢNG)
   M5 bị coi là SIDEWAYS (FAIL) nếu vi phạm BẤT KỲ điều nào sau, dựa trên FACTS:
   - **S1a — Độ tươi cấu trúc**: BOS/CHoCH hợp lệ gần nhất cách hiện tại > 20 nến M5.
   - **S1b — Độ rộng range**: tổng range 20 nến M5 gần nhất (high nhất − low nhất) < **4 × atr_m5_current**. Range hẹp so với ATR nghĩa là giá giãy trong hộp — môi trường whipsaw.
   - **S1c — Cấu trúc swing**: trong 20 nến gần nhất, các swing high/low KHÔNG tạo được chuỗi cao dần hoặc thấp dần (tức swing sau chồng lấn/đan xen swing trước theo FACTS).
   → FAIL bất kỳ mục nào → WATCHLIST hoặc NO TRADE, ghi rõ mục vi phạm (S1a/S1b/S1c).

2. **M5/M15 — POI**: xác định OB/FVG gần nhất đúng hướng bias (continuation) hoặc đúng hướng sau CHoCH (reversal).
   ### ⛔ GATE S2 — SWEEP CHO REVERSAL (HARD GATE, chỉ áp cho REVERSAL)
   - Reversal BẮT BUỘC có liquidity sweep ngược phía lệnh dự kiến TRƯỚC khi CHoCH xảy ra (SELL sau CHoCH → phải có sweep buyside trước đó), sweep phải trích được từ FACTS (equal highs/lows bị quét).
   - Không có sweep → hạ WATCHLIST.
   - Continuation KHÔNG cần qua gate này.

3. **M1 — Confirmation & entry (ĐÃ SIẾT)**: chờ giá chạm POI. Nến M1 xác nhận phải thỏa TẤT CẢ:
   - **C1**: đóng cửa đúng hướng lệnh (BUY → nến xanh, SELL → nến đỏ).
   - **C2**: thân nến ≥ 50% tổng range của chính nó (loại nến doji/nhiễu).
   - **C3**: close vượt qua điểm giữa (50%) của nến M1 liền trước, HOẶC engulf toàn bộ thân nến trước.
   - **C4**: nến xác nhận hình thành TRONG hoặc NGAY SAU khi giá chạm POI (≤ 3 nến M1 kể từ lúc chạm) — chạm POI xong đi xa rồi mới có nến đẹp thì KHÔNG tính.
   → Đọc trực tiếp từ OHLC M1 trong data, ghi rõ OHLC của nến xác nhận trong output.

## CÁCH ĐẶT SL / TP

- **SL**: neo sau đáy/đỉnh của nến/cụm nến tạo POI (M5) hoặc swing M1 gần nhất, + đệm tối thiểu **0.5 × atr_m1_current** [phải trích \`[STATE: atr_m1_current = ...]\`]. Không đặt sát khít swing.
- **TP**: mục tiêu thanh khoản gần nhất đúng hướng — equal highs/lows M5, swing M5 gần nhất, hoặc FVG M15 đối diện nếu gần hơn — tất cả phải trích từ FACTS. Chốt tại mục tiêu ĐẦU TIÊN.
  ### ⛔ GATE S3 — TP KHÔNG NẰM TRONG VÙNG NGHỊCH
  - TP rơi vào/ngay trước OB hoặc FVG nghịch hướng trên M5/M15 (theo FACTS) → lùi TP về trước vùng đó, tính lại RR.
  ### ⛔ GATE S4 — TỰ KIỂM RR + BUFFER SPREAD (HARD GATE)
  - \`RR_thực = (khoảng cách TP − 0.3) / (khoảng cách SL + 0.3)\` (buffer 0.3 USD mỗi bên).
  - Tối thiểu: **RR_thực ≥ 1:1.3**. Dưới ngưỡng → NO TRADE, không ngoại lệ.
  - PHẢI trình bày phép tính đầy đủ trong output: khoảng cách TP, khoảng cách SL, phép chia, kết quả.
  ### ⛔ GATE S5 — BỘ LỌC BIẾN ĐỘNG (HARD GATE, ĐÃ SỬA)
  - **Chế độ chuẩn (có \`atr_m5_avg20\`)**: yêu cầu \`atr_m5_current ≥ 0.8 × atr_m5_avg20\`. Dưới ngưỡng → WATCHLIST, lý do "biến động thấp so với trung bình, chờ ATR cải thiện". So sánh TƯƠNG ĐỐI này thay cho ngưỡng tuyệt đối cố định, vì ngưỡng USD cứng sẽ lỗi thời khi mặt bằng giá vàng thay đổi.
  - **Chế độ fallback (thiếu \`atr_m5_avg20\`)**: dùng ngưỡng tuyệt đối tạm \`atr_m5_current ≥ 1.5 USD\`, NHƯNG bắt buộc ghi "⚠️ dùng ngưỡng tuyệt đối tạm — kém tin cậy" và confidence tối đa Medium (theo Gate S0).
  - **Tin tức (NGOÀI GATE — trách nhiệm người dùng)**: hệ thống không có dữ liệu lịch tin, nên model KHÔNG kiểm và KHÔNG ghi PASS/FAIL cho mục này. Thay vào đó, mọi ORDER bắt buộc kèm cảnh báo trong khối nhắc thực thi: người dùng tự đối chiếu lịch kinh tế, và KHÔNG vào lệnh trong ±15 phút quanh tin mạnh (NFP, CPI, FOMC, v.v.) bất kể setup đẹp — spread giãn đột biến phá vỡ toàn bộ tính toán RR sát của scalp.

4. **Quản lý sau khi vào lệnh — QUY TẮC THỰC THI PHÍA NGƯỜI DÙNG (thay Gate S6)**:
   - Hệ thống này là công cụ PHÂN TÍCH — không theo dõi được lệnh đang mở. Do đó kỷ luật "một lệnh tại một thời điểm" và time-stop KHÔNG phải gate model tự kiểm, mà là quy tắc người dùng tự thực thi.
   - MỌI output dạng ORDER bắt buộc kết thúc bằng khối nhắc cố định (xem ĐỊNH DẠNG OUTPUT), gồm: (1) chỉ vào lệnh nếu KHÔNG có lệnh scalp nào đang mở; (2) time-stop 6 nến M5 với ngoại lệ định lượng duy nhất theo QUY ƯỚC.
   - Model KHÔNG ghi "Gate S6: PASS" trong bất kỳ trường hợp nào — không kiểm chứng được thì không được xác nhận.

## ĐỊNH NGHĨA SETUP HỢP LỆ (đủ TẤT CẢ)
- Qua **Gate S0** (dữ liệu trạng thái đủ hoặc đã xử lý fallback đúng quy tắc).
- Qua **Gate S1** (đủ cả S1a, S1b, S1c).
- Reversal: qua **Gate S2**. Continuation: N/A.
- POI đã chạm + M1 confirmation đủ C1–C4.
- TP sau **Gate S3** vẫn đạt RR_thực ≥ 1:1.3 (**Gate S4**, có phép tính trình bày).
- Biến động đủ + không trong khung tin (**Gate S5**).
- Mọi mức giá đều có trích dẫn \`[FACTS: ...]\`.
- ORDER có kèm khối "⚠️ NGƯỜI DÙNG TỰ KIỂM TRƯỚC KHI VÀO LỆNH" (thay Gate S6 cũ).
Thiếu bất kỳ điều nào → KHÔNG xuất ORDER.

## TIÊU CHÍ CONFIDENCE
- **High**: continuation thuận trend M5 rõ + RR_thực ≥ 1:2 + Gate S5 chạy chế độ chuẩn và vượt ngưỡng rõ + trong kill zone + đủ toàn bộ trường [STATE].
- **Medium**: hợp lệ nhưng RR_thực 1:1.3–1:2, HOẶC ngoài kill zone, HOẶC reversal, HOẶC Gate S5 chạy fallback, HOẶC có trường [STATE] ở trạng thái UNVERIFIED.
- **Low**: không đạt → NO TRADE.

## ĐỊNH DẠNG OUTPUT

### Trường hợp 1 — Đang hình thành, chưa đủ điều kiện:
#### WATCHLIST (CHƯA VÀO LỆNH)
- Hướng dự kiến: BUY / SELL
- Loại setup: Continuation / Reversal
- POI cần chờ: [vùng giá] [FACTS: ...]
- Điều kiện còn thiếu: [chờ chạm POI / chờ M1 confirm C1–C4 / chờ sweep Gate S2 / chờ ATR cải thiện Gate S5]

### Trường hợp 2 — Không có cơ hội:
- Best opportunity: NO TRADE
- Lý do: [1 câu — gate nào chặn, mục nào, ví dụ "Gate S1b FAIL: range 20 nến = 3.1 × ATR < 4 × ATR"]

### Trường hợp 3 — Setup hợp lệ, đã confirm:
#### [BUY ORDER / SELL ORDER — SCALP]
- Loại setup: Continuation / Reversal (sweep xác nhận [FACTS: ...])
- Entry zone: [giá] [FACTS: ...]
- Điều kiện kích hoạt (đã thỏa): [POI + nến M1 xác nhận với OHLC cụ thể + C1–C4 từng mục PASS]
- SL: [giá] — neo [swing] [FACTS: <khung> <nhãn> = ...] + đệm 0.5 × ATR M1 [STATE: atr_m1_current = ...] — cách [X] USD
- TP: [giá] — mục tiêu [FACTS: <khung> <nhãn> = ...] — cách [Y] USD
- Gate S4: RR lý thuyết [Y/X] — RR_thực = ([Y] − 0.3)/([X] + 0.3) = **[Z]** → PASS/FAIL
- Gate S5: atr_m5_current [STATE] vs 0.8 × atr_m5_avg20 [STATE] → PASS / fallback ⚠️
- Trong kill zone: Có/Không (theo server_time_vn)
- Confidence: High / Medium / Low
- Hủy lệnh nếu: [invalidation cụ thể bằng body close M5, mức giá trích FACTS]
> ⚠️ **NGƯỜI DÙNG TỰ KIỂM TRƯỚC KHI VÀO LỆNH** (hệ thống phân tích không theo dõi được lệnh của bạn):
> 1. CHỈ vào lệnh nếu KHÔNG có lệnh scalp nào đang mở.
> 2. Time-stop: thoát thủ công sau 6 nến M5 nếu chưa chạm TP/SL; gia hạn 1 lần +3 nến CHỈ khi giá đã đi ≥ 50% quãng Entry→TP và nến M5 hiện tại đóng thuận hướng.
> 3. TỰ ĐỐI CHIẾU lịch kinh tế: KHÔNG vào lệnh trong ±15 phút quanh tin mạnh (NFP, CPI, FOMC, phát biểu Fed, v.v.) — hệ thống không có dữ liệu lịch tin nên không kiểm hộ được.

---

### SUMMARY
- [STATE] đầy đủ: Có/Thiếu trường nào — **Gate S0: PASS/FAIL/FALLBACK**
- Bias M5: BULLISH / BEARISH / SIDEWAYS — S1a/S1b/S1c từng mục — **Gate S1: PASS/FAIL**
- Loại setup: Continuation / Reversal — sweep: Có [FACTS]/Chưa — **Gate S2: PASS/FAIL/N/A**
- POI: [vùng giá] [FACTS] — đã chạm: Có/Chưa
- M1 confirmation: C1/C2/C3/C4 từng mục — Có/Chưa
- RR lý thuyết: [X:1] — RR_thực sau buffer: [Y:1] — **Gate S4: PASS/FAIL**
- ATR: [current] vs [0.8 × avg20] — **Gate S5: PASS/FAIL/FALLBACK⚠️** — tin tức: người dùng tự kiểm
- Trong kill zone: Có/Không
- Best opportunity: BUY / SELL / WATCHLIST / NO TRADE
- Lý do ngắn gọn 1–2 câu

---

## GIỚI HẠN PHẠM VI
- Prompt ưu tiên tần suất — CHẤP NHẬN winrate/lệnh và RR/lệnh thấp hơn hệ thống đa khung v3.2. Đây là đánh đổi thiết kế.
- KHÔNG quản lý risk cấp tài khoản. Người dùng BẮT BUỘC (không chỉ khuyến nghị) tự áp lớp ngoài: % rủi ro/lệnh, số lệnh tối đa/ngày, dừng sau N lệnh thua liên tiếp. Không có lớp này thì không nên chạy hệ thống tần suất cao.
- Buffer 0.3 USD không đủ trong điều kiện cực đoan (news sốc, gap cuối tuần).
- FACTS đầu vào không được kiểm chứng lại — Gate S0 chỉ bắt mâu thuẫn thô, không thay được chất lượng code tính toán.
- Hệ thống chưa qua backtest thống kê — các gate giảm lệnh xấu nhưng KHÔNG tự tạo ra edge. Kết quả phụ thuộc chất lượng FACTS và kỷ luật thực thi.`;
  }
}
