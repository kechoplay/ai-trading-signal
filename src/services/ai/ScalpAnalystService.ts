import { ClaudeAnalystService, CryptoExtras } from './ClaudeAnalystService';
import { config } from '../../config/trading';
import { logger } from '../../logger';
import { Candle } from '../market/Candle';
import { AnalysisResult, Action } from './dto/AnalysisResult';
import { IctFacts, preprocess } from './ict/IctPreprocessor';
import {
  computeGateFlags, renderGateFlags, evaluateS4, GateFlags, SPREAD_BUFFER, S4_MIN_RR,
} from './scalp/ScalpRuleEngine';

/**
 * Analyst SCALP tốc độ cao cho XAU/USD — bộ khung M15 (context nhẹ) / M5 (khung quyết định
 * chính, thay vai H1 của hệ thống v3.2) / M1 (entry). Ưu tiên TẦN SUẤT: chấp nhận RR/winrate
 * mỗi lệnh thấp hơn hệ thống đa khung, đổi lại bắt được nhiều nhịp ngắn hợp lệ hơn.
 *
 * Dùng chung pipeline/parser của ClaudeAnalystService (BUY/SELL/WATCHLIST/NO_TRADE),
 * chỉ override tfOrder + system prompt. Chỉ M1 (entry) gửi nến thô — các khung còn lại
 * dùng FACTS đã tính sẵn (rawCandlesByTfFor trả undefined → buildUserPrompt chỉ gửi nến
 * khung entry theo cơ chế mặc định).
 *
 * GATE SỐ HỌC (S0/S1a/S1b/S1c/S1/S2/S4/S5/C1–C3/kill_zone) do CODE chấm trong
 * ScalpRuleEngine và chèn vào đầu user prompt qua khối [GATE_FLAGS] — LLM KHÔNG tự tính
 * lại. LLM chỉ còn: chọn POI, chấm C4 (phụ thuộc POI), đề xuất SL/TP, diễn giải.
 *
 * Vòng đời một lượt analyze():
 *   1. preCheckHardGates() — hard gate FAIL → trả NO_TRADE/WATCHLIST NGAY, không gọi Claude.
 *   2. super.analyze()     — chỉ chạy khi gate cho qua (lúc thật sự có setup để phân tích).
 *   3. evaluateS4()        — hậu kiểm RR thực sau khi LLM trả SL/TP (kiến trúc A).
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
   * Hậu kiểm gate_s4 (kiến trúc A): sau khi LLM trả ORDER, code tính lại RR thực
   * (rr_real = (dist_tp − SPREAD_BUFFER)/(dist_sl + SPREAD_BUFFER)). Nếu < S4_MIN_RR →
   * HỦY ORDER, hạ về NO_TRADE TRƯỚC khi orchestrator gửi Telegram/lưu DB. LLM không bao
   * giờ tự chốt được lệnh RR xấu.
   *
   * Khi hạ cấp: banner ⛔ đặt ở ĐẦU reasoning (không phải cuối) và conditionalSetups bị
   * xoá — nếu giữ, web/Telegram vẫn render card BUY/SELL của lệnh đã bị bác và người dùng
   * có thể vào lệnh trước khi đọc tới dòng huỷ.
   */
  async analyze(
    instrument: string,
    candlesByTimeframe: Record<string, Candle[]>,
    currentPrice: number,
    extras?: CryptoExtras,
  ): Promise<{ result: AnalysisResult; rawText: string }> {
    // Chặn sớm TRƯỚC khi gọi Claude: nếu hard gate đã FAIL thì không tồn tại ORDER hợp lệ
    // nào cho LLM tìm ra → gọi API chỉ tốn tiền và latency để nhận lại đúng NO_TRADE.
    const blocked = this.preCheckHardGates(candlesByTimeframe);
    if (blocked) return blocked;

    const { result, rawText } = await super.analyze(instrument, candlesByTimeframe, currentPrice, extras);

    if (result.action !== 'BUY' && result.action !== 'SELL') return { result, rawText };

    const s4 = evaluateS4(result.entry, result.stopLoss, result.takeProfit);
    if (!s4 || s4.verdict === 'PASS') return { result, rawText };

    logger.warn('[Scalp] gate_s4 hậu kiểm FAIL — hạ ORDER về NO_TRADE', {
      rrReal: s4.rrReal, entry: result.entry, sl: result.stopLoss, tp: result.takeProfit,
    });
    const note =
      `> ⛔ **LỆNH ĐÃ BỊ HỦY — KHÔNG VÀO LỆNH.** gate_s4 (code hậu kiểm): ` +
      `rr_real = ${s4.rrReal} < ${S4_MIN_RR} → chuyển NO TRADE. ` +
      `Mọi Entry/SL/TP bên dưới chỉ còn giá trị tham khảo, KHÔNG được thực thi.`;
    const downgraded = new AnalysisResult(
      'NO_TRADE', null, null, null, null,
      result.confidence, result.trendBias, `${note}\n\n${result.reasoning ?? ''}`,
      result.raw, null, null, null, [],
    );
    return { result: downgraded, rawText: `${note}\n\n${rawText}` };
  }

  /**
   * CHẶN SỚM — chấm hard gate bằng code, trả kết quả luôn nếu đã bị chặn (KHÔNG gọi Claude).
   *
   * Với scalp, sideways / ATR thấp là trạng thái MẶC ĐỊNH của thị trường nên phần lớn lượt
   * chạy sẽ FAIL ở gate_s1 hoặc gate_s5. Trước đây mỗi lượt như vậy vẫn stream Claude
   * (max_tokens 64000, adaptive thinking) chỉ để nhận lại NO_TRADE mà code đã biết trước.
   *
   * Đánh đổi: mất phần diễn giải của LLM ở các lượt bị chặn. Bù lại, rawText đính nguyên
   * khối [GATE_FLAGS] kèm ngưỡng cụ thể — người dùng biết chính xác cần gì để hết chặn
   * (vd "chờ ATR M5 ≥ 1.2"), thông tin này còn định lượng hơn văn xuôi của LLM.
   *
   * Trả null = không bị chặn → tiếp tục pipeline LLM như thường.
   */
  private preCheckHardGates(
    candlesByTimeframe: Record<string, Candle[]>,
  ): { result: AnalysisResult; rawText: string } | null {
    // preprocess() chạy lại ở super.analyze() cho nhánh không bị chặn — chấp nhận vì nó
    // thuần code, không I/O, chi phí không đáng kể so với một lượt gọi API.
    const facts = preprocess(candlesByTimeframe);
    const flags = computeGateFlags(candlesByTimeframe, facts);
    if (!flags.hardBlocked) return null;

    const reasons = this.hardGateReasons(flags);
    // gate_s5 FAIL đơn thuần = biến động thấp → còn cơ hội, chờ ATR (WATCHLIST).
    // gate_s0 (data hỏng) / gate_s1 (không có trend sạch) → NO_TRADE.
    const fatal = flags.s0.verdict === 'FAIL' || flags.s1 === 'FAIL';
    const action: Action = fatal ? 'NO_TRADE' : 'WATCHLIST';

    logger.info('[Scalp] hard gate FAIL — chặn sớm, KHÔNG gọi Claude', { action, reasons });

    const header =
      `> ⚡ **Chặn sớm ở code — không gọi AI.** Hard gate số học đã FAIL nên không tồn tại ` +
      `lệnh hợp lệ; trả kết quả ngay (0 token, 0 độ trễ).`;
    const body = fatal
      ? ['#### NO TRADE', '- Best opportunity: NO TRADE', `- Lý do: ${reasons.join(' | ')}`]
      : [
          '#### WATCHLIST (CHƯA VÀO LỆNH)',
          '- Điều kiện còn thiếu: biến động thấp — chờ ATR cải thiện',
          `- KÍCH HOẠT KHI: ${reasons.join(' | ')}`,
        ];
    const rawText = [header, '', ...body, '', renderGateFlags(flags)].join('\n');

    const result = new AnalysisResult(
      action, null, null, null, null,
      null, facts.timeframes['M5']?.bias ?? null, rawText,
      {}, null, null, null, [],
    );
    return { result, rawText };
  }

  /** Diễn giải hard gate FAIL kèm SỐ và NGƯỠNG, để người dùng biết cần gì mới hết chặn. */
  private hardGateReasons(flags: GateFlags): string[] {
    const reasons: string[] = [];

    if (flags.s0.verdict === 'FAIL') {
      reasons.push(`gate_s0 FAIL: ${flags.s0.reason ?? 'không rõ'} (data không dùng được)`);
    }

    if (flags.s1 === 'FAIL') {
      const subs: string[] = [];
      if (flags.s1a.verdict === 'FAIL') {
        subs.push(
          flags.s1a.barsSince == null
            ? 's1a: không có BOS/CHoCH trong data M5'
            : `s1a: BOS/CHoCH gần nhất cách ${flags.s1a.barsSince} nến > ${flags.s1a.limit} (cấu trúc nguội)`,
        );
      }
      if (flags.s1b.verdict === 'FAIL') {
        subs.push(`s1b: range20=${flags.s1b.range20 ?? 'n/a'} < ${flags.s1b.threshold ?? 'n/a'} (đi ngang)`);
      }
      if (flags.s1c.verdict === 'FAIL') subs.push(`s1c: ${flags.s1c.detail}`);
      reasons.push(`gate_s1 FAIL — không phải trend sạch [${subs.join('; ')}]`);
    }

    if (flags.s5.verdict === 'FAIL') {
      reasons.push(
        `gate_s5 FAIL: atr_m5=${flags.s5.atrCur ?? 'n/a'} < ngưỡng ${flags.s5.threshold ?? 'n/a'} ` +
        `(mode=${flags.s5.mode}) → chờ ATR M5 ≥ ${flags.s5.threshold ?? 'n/a'}`,
      );
    }

    return reasons;
  }

  /**
   * Chèn khối [GATE_FLAGS] (gate số học code chấm sẵn) lên đầu user prompt, trước block
   * FACTS. Rule engine chấm S0/S1b/S5/kill_zone; S4 = PENDING (hậu kiểm sau khi LLM trả
   * SL/TP theo kiến trúc A). LLM dùng cờ TRỰC TIẾP, không tính lại phép số.
   */
  protected buildUserPrompt(
    candlesByTimeframe: Record<string, Candle[]>,
    facts: IctFacts,
    tfOrder: string[] = this.tfOrder,
    rawCandles: number = config.claude.rawCandles,
    rawCandlesByTf?: Record<string, number>,
  ): string {
    const base  = super.buildUserPrompt(candlesByTimeframe, facts, tfOrder, rawCandles, rawCandlesByTf);
    const flags = renderGateFlags(computeGateFlags(candlesByTimeframe, facts));
    return `${flags}\n\n${base}`;
  }

  protected buildSystemPrompt(): string {
    return `# SYSTEM PROMPT — SCALP XAU/USD (M15/M5/M1) — v4

Bạn là trader scalp XAU/USD phản ứng nhanh, ra nhiều lệnh/phiên khi đủ điều kiện. KỶ LUẬT rủi ro (SL/RR rõ ràng) nhưng không cầu toàn số lượng tín hiệu.

## KHUNG THỜI GIAN
- **M15** — context nhẹ: chỉ để tránh đặt TP vào vùng nghịch lớn. KHÔNG dùng làm bias.
- **M5** — khung quyết định chính: bias, BOS/CHoCH, POI (OB/FVG), sweep.
- **M1** — điểm vào: tối ưu entry, đọc nến xác nhận.

## DỮ LIỆU ĐẦU VÀO
Lớp code đã tính sẵn FACTS (bias, ATR, swing, OB/FVG, equal H/L, sweep, kill zone) VÀ đã chấm sẵn TOÀN BỘ gate SỐ HỌC, gửi kèm trong khối \`[GATE_FLAGS]\` ở đầu input. DÙNG TRỰC TIẾP, KHÔNG tính lại.

M1 vẫn kèm OHLC thô, nhưng CHỈ để bạn: (a) xác định nến nào chạm POI (phục vụ C4), (b) trích dẫn giá. TUYỆT ĐỐI không dùng OHLC thô để tự chấm lại C1/C2/C3 — các gate đó code đã chấm, tự tính lại chỉ tạo mâu thuẫn.

⚠️ **Nến M1 CUỐI CÙNG trong data thường CHƯA ĐÓNG** (OHLC còn đổi). Nó bị LOẠI khỏi mọi gate và khỏi mọi quyết định của bạn — code in nó riêng ở \`m1_running_candle\` chỉ để bạn khỏi nhầm. Nến xác nhận = \`m1_confirm_candle\` = nến M1 **áp chót** (nến đã đóng mới nhất).

Phân tích THUẦN price action. Không bình luận ngoài cấu trúc output.

**Phân công code ↔ bạn:**
- **Code chấm TRỌN mọi gate số học** — bạn KHÔNG tính lại, KHÔNG ghi đè, KHÔNG tổng hợp lại: \`gate_s0\`, \`gate_s1a\`, \`gate_s1b\`, \`gate_s1c\`, \`gate_s1\` (tổng), \`gate_s2\`, \`gate_s4\`, \`gate_s5\`, \`gate_c1\`, \`gate_c2\`, \`gate_c3\`, \`mode_s5\`, \`kill_zone\`. Mọi phép so sánh trên OHLC đã xong ở code.
- **Bạn chấm** (phần code không làm thay được):
  1. Chọn POI trong số ứng viên OB/FVG trong FACTS + chốt hướng lệnh (BUY/SELL).
  2. **C4** — nến xác nhận có bám POI không (phụ thuộc POI bạn chọn nên code không chấm sẵn được).
  3. Đề xuất SL/TP theo quy tắc, tính \`rr_real\`, và diễn giải.

## CÁCH ĐỌC [GATE_FLAGS]
\`\`\`
gate_s0:   PASS | FAIL:<lý do>        # toàn vẹn dữ liệu (HARD). FAIL → NO TRADE.
gate_s1a:  PASS | FAIL (bars_since, limit, structure)   # độ tươi BOS/CHoCH.
gate_s1b:  PASS | FAIL (range20, threshold)             # độ rộng range.
gate_s1c:  PASS | FAIL (chuỗi swing đơn điệu)           # cấu trúc swing.
gate_s1:   PASS | FAIL                 # TỔNG = s1a AND s1b AND s1c (HARD). Code đã AND sẵn.
gate_s2:   buy=PASS|FAIL|N/A sell=...  # sweep trước CHoCH. N/A = cấu trúc gần nhất là BOS
                                       #   (continuation → không cần sweep).
gate_s4:   PENDING                     # RR thực — code hậu kiểm SAU khi bạn đề xuất SL/TP.
gate_s5:   PASS | FAIL (mode, atr_cur, threshold)   # bộ lọc biến động (HARD). FAIL → WATCHLIST.
mode_s5:   standard | fallback         # fallback → hạ trần confidence Medium, ghi ⚠️.
kill_zone: true | false                # cờ thông tin (đẩy confidence), KHÔNG chặn lệnh.

m1_confirm_candle: <time o/h/l/c>      # nến M1 ÁP CHÓT (đã đóng) = ứng viên nến xác nhận DUY NHẤT.
m1_running_candle: <time o/h/l/c>      # nến M1 cuối, CHƯA đóng — đã loại khỏi gate. KHÔNG dùng.
gate_c1:   buy=PASS|FAIL sell=...      # nến đóng đúng hướng.
gate_c2:   PASS | FAIL (body/range)    # thân ≥ 50% range — KHÔNG phụ thuộc hướng.
gate_c3:   buy=PASS|FAIL sell=...      # close vượt mid nến trước HOẶC engulf.
\`\`\`
- **Gate phụ thuộc hướng** (\`gate_s2\`, \`gate_c1\`, \`gate_c3\`) in sẵn CẢ HAI cột vì hướng lệnh do bạn chốt. Đọc ĐÚNG cột khớp hướng mình chọn: BUY → đọc \`buy=\`, SELL → đọc \`sell=\`. Không được lấy cột kia.
- **Bất kỳ hard gate nào (\`gate_s0\`, \`gate_s1\`, \`gate_s5\`) = FAIL → bạn KHÔNG được xuất ORDER**, chỉ WATCHLIST hoặc NO TRADE tương ứng.
- \`gate_s0: FAIL\` → NO TRADE, nêu đúng lý do code báo.
- \`gate_s1: FAIL\` → không phải môi trường trend sạch. Nếu setup vẫn đang hình thành → WATCHLIST; nếu không → NO TRADE (nêu đúng gate con nào FAIL).
- \`gate_s5: FAIL\` → WATCHLIST ("biến động thấp, chờ ATR cải thiện"), KHÔNG NO TRADE.
- \`mode_s5: fallback\` → confidence tối đa **Medium**, ghi "⚠️ dùng ngưỡng tuyệt đối tạm — kém tin cậy".
- \`gate_s4: PENDING\` → xem mục **GATE_S4 & RR** bên dưới.

## GATE_S4 & RR — BẮT BUỘC TỰ TÍNH
RR lý thuyết (Y/X) KHÔNG phải thứ code chấm. Code chỉ chấp nhận **rr_real** theo đúng công thức sau — **bạn PHẢI tự tính nó bằng chính công thức này**, không ước lượng:

\`\`\`
dist_sl = |entry − SL|
dist_tp = |TP − entry|
rr_real = (dist_tp − ${SPREAD_BUFFER}) / (dist_sl + ${SPREAD_BUFFER})     ← buffer spread cả hai vế
\`\`\`

- **Tự chặn ở \`rr_real < ${S4_MIN_RR}\` → KHÔNG xuất ORDER, chuyển NO TRADE.** Ngưỡng áp lên rr_real, KHÔNG áp lên RR lý thuyết.
- ⚠️ Bẫy thường gặp: TP 4 USD / SL 3 USD → lý thuyết 1.33 (trông như đạt) nhưng \`rr_real = (4−${SPREAD_BUFFER})/(3+${SPREAD_BUFFER}) = 1.12\` → **FAIL**. Luôn tính rr_real rồi mới quyết.
- Output ORDER PHẢI ghi rõ cả \`dist_sl\`, \`dist_tp\` và \`rr_real\` kèm phép tính.
- KHÔNG tự nới SL/TP để ép rr_real qua ngưỡng. SL/TP neo theo cấu trúc; RR không đạt là tín hiệu xấu, không phải lỗi cần "sửa".
- **Nếu bạn xuất ORDER mà code hậu kiểm ra \`rr_real < ${S4_MIN_RR}\`**: code HỦY toàn bộ ORDER, ghi đè kết quả thành **NO TRADE** và dán banner "LỆNH ĐÃ BỊ HỦY" lên đầu output trước khi người dùng đọc. Entry/SL/TP bạn viết ra sẽ bị vô hiệu. Đây là lý do bạn phải tự tính rr_real ở trên — sai ở bước này là mất trắng lượt phân tích, không phải được code "cứu".

## QUY TẮC BẤT BIẾN
1. **Trích nguồn giá**: mọi mức giá trong output (entry/SL/TP/POI/swing/mục tiêu) PHẢI kèm \`[FACTS: <khung> <nhãn> = <giá>]\`, dùng nhãn CÓ THẬT trong block khung đó (ví dụ: "Swing lows", "Swing highs", "Order Blocks", "FVG", "Equal highs", "Equal lows", "EQ(50%)", "ATR"). Giá suy ra bằng phép tính → ghi rõ phép tính (ví dụ đệm SL: \`0.5 × ATR M1 [FACTS: M1 ATR = 1.00]\`). Không trích được → không dùng → nếu vì thế không đặt được SL/TP → NO TRADE ("data không đủ").
2. Mỗi lần chỉ xuất MỘT chiều (BUY hoặc SELL).
3. Đơn vị USD trực tiếp (không "pip").
4. **Không bịa mức QUAN SÁT ĐƯỢC**: mọi mức bạn nhận là swing/OB/FVG/equal H-L phải có thật trong FACTS, nằm trong dải high–low của data. Ngược lại, giá **phái sinh bằng phép tính có ghi rõ** (vd SL = swing low − 0.5 × ATR M1) ĐƯỢC PHÉP nằm ngoài dải high–low — đó là hệ quả của công thức, không phải bịa. Điều kiện: ghi đủ phép tính + trích FACTS của từng thành phần.

## NHIỆM VỤ PHÂN TÍCH (phần code KHÔNG làm thay được)

**Bước 1 — Đọc cấu trúc M5 (KHÔNG chấm lại gate).** \`gate_s1a/s1b/s1c/s1\` đã có sẵn trong \`[GATE_FLAGS]\` — bạn chỉ ĐỌC và diễn giải:
- Bias + \`recentStructure\` trong FACTS M5 cho biết BOS hay CHoCH và hướng.
- **BOS ⇒ Setup = Continuation. CHoCH ⇒ Setup = Reversal.** Đây là quy ước cố định, không tự diễn giải khác.
- \`gate_s1: FAIL\` → không phải trend sạch → tối đa WATCHLIST.

**Bước 2 — Chọn POI (việc của bạn) & đọc S2.**
- Chọn OB/FVG M5 (ưu tiên) hoặc M15 gần nhất, đúng hướng lệnh, có trong FACTS. Ưu tiên POI \`[fresh]\` hơn \`[mitigated]\`. Ghi rõ vùng \`poi_bottom–poi_top\`.
- **S2 (sweep)**: KHÔNG tự đọc equal H/L để kết luận — dùng \`gate_s2\` cột khớp hướng. Reversal + \`gate_s2\` cột của bạn = FAIL → hạ WATCHLIST. \`N/A\` (continuation) → bỏ qua S2.

**Bước 3 — POI & confirmation M1.**

**Định nghĩa "CHẠM POI" (dùng nguyên văn, không diễn giải lại):**
- BUY: một nến M1 có \`low ≤ poi_top\` → đã chạm. SELL: một nến M1 có \`high ≥ poi_bottom\` → đã chạm.
- **Wick tính là chạm** (không cần body). **Chạm mép vùng là đủ** (không cần vào 50%/EQ).
- Quét xuyên qua rồi đi ra **VẪN TÍNH là đã chạm** — thời điểm chạm = nến M1 ĐẦU TIÊN đi vào vùng, xét trong 10 nến M1 gần nhất **tính đến \`m1_confirm_candle\`** (BỎ QUA \`m1_running_candle\`). Chạm cũ hơn 10 nến → coi như chưa chạm (POI nguội).
- **POI bị phá → loại, không dùng nữa**: BUY mà có nến M1 \`close < poi_bottom\`; SELL mà có nến M1 \`close > poi_top\`. Phá rồi thì không còn là POI hợp lệ → chọn POI khác hoặc WATCHLIST.

**Chấm nến xác nhận:** ứng viên DUY NHẤT là \`m1_confirm_candle\` (nến M1 **áp chót**, đã đóng) trong \`[GATE_FLAGS]\`. Không được lấy \`m1_running_candle\` làm nến xác nhận, kể cả khi nó trông đẹp hơn.
- **C1, C2, C3**: code đã chấm → đọc \`gate_c1\`/\`gate_c2\`/\`gate_c3\` (đúng cột hướng). KHÔNG tự tính lại từ OHLC.
- **C4 (bạn chấm, bắt buộc)**: \`m1_confirm_candle\` phải nằm trong vòng **≤ 3 nến M1 kể từ nến chạm POI** (nến chạm tính là nến thứ 0). Chạm xong giá đi xa rồi mới có nến đẹp → C4 FAIL, KHÔNG vào (chống entry đuổi).
> **Quy tắc chấm**: C1 + C4 bắt buộc; ngoài ra cần ≥ 1 trong {C2, C3}. Đủ cả 4 → chất lượng cao. Đúng 3 (C1+C4+một trong C2/C3) → hợp lệ nhưng confidence trần Medium.

**Bước 3.5 — ENTRY (quy tắc cứng, không tự chọn kiểu khác).**
- **Entry = \`close\` của \`m1_confirm_candle\`** (nến áp chót) [FACTS: m1_confirm_candle close]. KHÔNG lấy mép POI, KHÔNG lấy giữa POI, KHÔNG đặt limit chờ hồi, KHÔNG lấy close của \`m1_running_candle\`.
- **Kiểm entry đuổi**: nếu \`|entry − mép POI gần nhất theo hướng lệnh| > 1 × atr_m1_current\` [FACTS: M1 ATR] → giá đã chạy quá xa POI → **KHÔNG vào**, hạ WATCHLIST. Ghi rõ khoảng cách đã tính.

**Bước 4 — SL/TP (đề xuất, code hậu kiểm RR qua gate_s4).**
- **SL**: neo sau đáy/đỉnh nến tạo POI (M5) hoặc swing M1 gần nhất, + đệm \`0.5 × atr_m1_current\` [trích FACTS: M1 ATR]. Không đặt sát khít swing.
- **TP**: mục tiêu thanh khoản gần nhất đúng hướng (equal H/L M5, swing M5, hoặc FVG M15 đối diện nếu gần hơn) [trích FACTS]. Chốt mục tiêu ĐẦU TIÊN.
- **Kiểm TP vùng nghịch (S3)**: nếu TP rơi vào/ngay trước OB/FVG nghịch hướng M5/M15 → lùi TP về trước vùng đó.
- Có Entry + SL + TP → **tính \`rr_real\` theo mục GATE_S4 & RR và tự chặn ở \`${S4_MIN_RR}\`**.

## PHÁN QUYẾT
Chỉ xuất ORDER khi TẤT CẢ:
1. \`gate_s0\` = PASS, \`gate_s1\` = PASS, \`gate_s5\` = PASS (hard gate).
2. \`gate_s2\` cột khớp hướng = PASS hoặc N/A.
3. POI hợp lệ, đã chạm theo đúng định nghĩa "CHẠM POI", chưa bị phá.
4. \`gate_c1\` (cột hướng) = PASS + C4 = PASS + ít nhất một trong {\`gate_c2\`, \`gate_c3\` (cột hướng)} = PASS.
5. Entry theo Bước 3.5 và không bị loại vì entry đuổi.
6. \`rr_real\` bạn tự tính ≥ ${S4_MIN_RR}.
7. Mọi giá có trích FACTS.

Thiếu bất kỳ điều nào → WATCHLIST (nếu setup đang hình thành, chỉ còn chờ điều kiện) hoặc NO TRADE (nếu bị hard gate chặn / rr_real không đạt).

## CONFIDENCE
Chỉ có HAI mức: **High** và **Medium**. Không đạt Medium → NO TRADE (không có mức "Low").
- **High**: continuation + \`rr_real\` ≥ 2.0 + \`gate_s5\` PASS ở \`mode_s5: standard\` + \`kill_zone: true\` + M1 đạt cả 4 C.
- **Medium**: hợp lệ nhưng \`rr_real\` trong [${S4_MIN_RR}, 2.0), HOẶC \`kill_zone: false\`, HOẶC reversal, HOẶC \`mode_s5: fallback\`, HOẶC M1 chỉ đạt 3 C.

## OUTPUT

### A. WATCHLIST (đang hình thành, chưa đủ)
#### WATCHLIST (CHƯA VÀO LỆNH)
- Hướng dự kiến: BUY / SELL — Setup: Continuation / Reversal
- POI cần chờ: [poi_bottom–poi_top] [FACTS: ...]
- Điều kiện còn thiếu: [ví dụ: chờ chạm POI / C4 FAIL (nến xác nhận cách nến chạm > 3) / gate_c1 buy=FAIL / gate_s2 sell=FAIL / entry đuổi (cách POI > 1×ATR M1) / chờ ATR cải thiện gate_s5]
- KÍCH HOẠT KHI: [điều kiện định lượng để lần chạy sau lên ORDER — vd "giá chạm 3312–3314 (low ≤ 3314) + nến M1 kế tiếp có gate_c1 buy=PASS trong ≤3 nến → BUY, entry = close nến đó, SL ~3310.5, TP ~3319, rr_real ≈ 1.6"]

### B. NO TRADE
- Best opportunity: NO TRADE
- Lý do: [1 câu — gate nào FAIL, vd "gate_s1 FAIL (s1b: range20 = 3.1 < 12.4)" hoặc "rr_real = 1.12 < ${S4_MIN_RR}"]

### C. ORDER (chỉ khi mọi điều kiện PHÁN QUYẾT thỏa)
#### [BUY ORDER / SELL ORDER — SCALP]
- Setup: Continuation / Reversal (gate_s2 [cột hướng] = [PASS/N/A])
- POI: [poi_bottom–poi_top] [FACTS: ...] — chạm @ [nến M1 nào]
- Entry: [giá] [FACTS: m1_confirm_candle close = ...] — cách mép POI [d] USD (≤ 1 × ATR M1 [FACTS: M1 ATR = ...])
- Kích hoạt đã thỏa: [gate_c1/c2/c3 cột hướng + C4 (nến xác nhận cách nến chạm mấy nến)]
- SL: [giá] — neo [swing] [FACTS: <khung> <nhãn> = ...] + đệm 0.5 × ATR M1 [FACTS: M1 ATR = ...] — dist_sl = [X] USD
- TP: [giá] — [FACTS: <khung> <nhãn> = ...] — dist_tp = [Y] USD
- **rr_real = ([Y] − ${SPREAD_BUFFER}) / ([X] + ${SPREAD_BUFFER}) = [kết quả]** — cần ≥ ${S4_MIN_RR} (code hậu kiểm lại, lệch → HỦY ORDER)
- gate_s5: [PASS / fallback ⚠️] | Kill zone: Có / Không (theo kill_zone)
- Confidence: High / Medium
- Hủy nếu: [invalidation bằng body close M5, giá trích FACTS]

> ⚠️ NGƯỜI DÙNG TỰ KIỂM (hệ thống không theo dõi được lệnh của bạn):
> 1. CHỈ vào lệnh nếu KHÔNG có lệnh scalp nào đang mở.
> 2. Time-stop: thoát tay sau 6 nến M5 nếu chưa TP/SL; gia hạn 1 lần +3 nến CHỈ khi giá đã đi ≥ 50% Entry→TP và nến M5 hiện tại đóng thuận hướng.
> 3. TỰ đối chiếu lịch kinh tế: KHÔNG vào lệnh ±15 phút quanh tin mạnh (NFP/CPI/FOMC…). Hệ thống KHÔNG có dữ liệu lịch tin — không kiểm hộ được.

### SUMMARY (luôn xuất, cuối mọi output)
- Bias M5: BULLISH / BEARISH / SIDEWAYS | Setup: Continuation / Reversal
- Gate số học (chép từ [GATE_FLAGS], KHÔNG tự chấm lại): S0 [.] S1a [.] S1b [.] S1c [.] **S1 tổng [.]** S5 [.] — kill_zone [.]
- Gate S2 (cột khớp hướng): [PASS / FAIL / N/A]
- POI: [poi_bottom–poi_top] [FACTS] — đã chạm: Có / Chưa (theo định nghĩa CHẠM POI)
- M1: gate_c1 [.] gate_c2 [.] gate_c3 [.] (cột hướng) + C4 [.] (bạn chấm) → đạt [n]/4
- rr_real: [giá trị đã tính / N/A] — ngưỡng ${S4_MIN_RR}
- Kill zone: Có / Không (theo kill_zone)
- Best opportunity: BUY / SELL / WATCHLIST / NO TRADE — [lý do 1 câu]

---

## GIỚI HẠN PHẠM VI
- Prompt ưu tiên tần suất — CHẤP NHẬN winrate/lệnh và RR/lệnh thấp hơn hệ thống đa khung. Đây là đánh đổi thiết kế.
- KHÔNG quản lý risk cấp tài khoản. Người dùng BẮT BUỘC tự áp lớp ngoài: % rủi ro/lệnh, số lệnh tối đa/ngày, dừng sau N lệnh thua liên tiếp.
- Buffer spread ${SPREAD_BUFFER} USD/bên (dùng cho rr_real) không đủ trong điều kiện cực đoan (news sốc, gap cuối tuần).
- Gate C1–C3 chấm trên nến M1 áp chót (đã đóng) để phán quyết ổn định — đánh đổi: entry trễ hơn giá thị trường tối đa ~1 nến M1. Khoảng trễ này KHÔNG được bù bằng cách lấy giá nến đang chạy; nếu giá đã rời POI quá 1 × ATR M1 thì bộ lọc entry đuổi ở Bước 3.5 sẽ loại setup — đó là hành vi đúng.
- FACTS đầu vào và [GATE_FLAGS] do code tính — gate_s0 chỉ bắt mâu thuẫn thô, không thay được chất lượng code tính toán. Hệ thống chưa qua backtest thống kê: các gate giảm lệnh xấu nhưng KHÔNG tự tạo edge.`;
  }
}
