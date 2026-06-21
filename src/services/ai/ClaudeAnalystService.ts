import Anthropic from '@anthropic-ai/sdk';
import { Agent } from 'undici';
import { Candle } from '../market/Candle';
import { AnalysisResult, ConditionalSetup } from './dto/AnalysisResult';
import { config } from '../../config/trading';
import { logger } from '../../logger';
import { preprocess, IctFacts, TimeframeAnalysis } from './ict/IctPreprocessor';
import { FuturesSentiment } from '../market/BinanceFuturesService';

/**
 * Dữ liệu bổ trợ chỉ dùng cho phân tích crypto futures:
 *  - futures: funding rate + open interest (Binance perpetual).
 *  - btcCandles: nến BTC theo khung để làm "BTC context" cho altcoin (BTC tự nó → bỏ trống).
 */
export interface CryptoExtras {
  futures?: FuturesSentiment | null;
  btcCandles?: Record<string, Candle[]> | null;
}

export class ClaudeAnalystService {
  private readonly client: Anthropic;
  protected readonly tfOrder: string[] = ['H4', 'H1', 'M15', 'M5'];

  constructor(private readonly model: string) {
    // Stream phân tích có thể chạy nhiều phút (adaptive thinking).
    // undici (engine của fetch) mặc định cắt kết nối nếu không nhận chunk nào
    // trong ~300s (bodyTimeout) hoặc chờ headers >300s (headersTimeout) →
    // ném "terminated". Đặt 0 = VÔ HẠN ở tầng undici để stream dài không bị
    // ngắt sớm; chặn an toàn bằng timeout của SDK bên dưới.
    const dispatcher = new Agent({
      headersTimeout: 0,   // 0 = không giới hạn (hợp lệ với undici)
      bodyTimeout:    0,
    });

    // ⚠️ SDK timeout KHÁC undici: 0 ở đây nghĩa là ~0ms (timeout tức thì), KHÔNG
    // phải vô hạn. Phải đặt số dương — đây là trần cứng tổng thể của request.
    const SDK_TIMEOUT = 10 * 60 * 1000; // 10 phút

    this.client = new Anthropic({
      apiKey:     config.claude.apiKey,
      maxRetries: 4,
      timeout:    SDK_TIMEOUT,
      fetchOptions: { dispatcher },
    });
  }

  static fromConfig(): ClaudeAnalystService {
    if (!config.claude.apiKey) throw new Error('CLAUDE_API_KEY is not configured.');
    return new ClaudeAnalystService(config.claude.model);
  }

  async analyze(
    instrument: string,
    candlesByTimeframe: Record<string, Candle[]>,
    _currentPrice: number,
    extras?: CryptoExtras,
  ): Promise<{ result: AnalysisResult; rawText: string }> {
    const systemPrompt = this.buildSystemPrompt(instrument);

    // Tiền xử lý: code tính sẵn swing/fib/ATR/FVG/OB/liquidity/kill-zone cho mọi khung.
    // Model chỉ còn DIỄN GIẢI thay vì tự "bấm máy" → thinking ngắn lại, nhanh & chính xác hơn.
    const facts = preprocess(candlesByTimeframe);
    let userPrompt = this.buildUserPrompt(candlesByTimeframe, facts);

    // Crypto: nối thêm futures sentiment (funding/OI) + BTC context (cho altcoin) nếu có.
    if (isCryptoInstrument(instrument) && extras) {
      const extraText = buildCryptoExtras(extras);
      if (extraText) userPrompt += `\n\n${extraText}`;
    }

    logger.info('[Claude] User prompt', { prompt: userPrompt });

    // max_tokens phải đủ lớn cho cả thinking + text response
    // thinking: adaptive không có budget_tokens → model tự phân bổ từ max_tokens
    // Nếu max_tokens quá nhỏ, thinking ăn hết token, text block trả về rỗng.
    // output_config.effort: vì code đã gánh phần tính toán, hạ effort để cắt latency.
    const stream = this.client.messages.stream({
      model:      this.model,
      max_tokens: 64000,
      thinking:   { type: 'adaptive' },
      output_config: { effort: config.claude.effort as 'low' | 'medium' | 'high' | 'max' },
      system:     systemPrompt,
      messages:   [{ role: 'user', content: userPrompt }],
    });

    const message = await stream.finalMessage();

    // Log toàn bộ block types để debug nếu có lỗi
    const blockTypes = message.content.map((b) => b.type);
    logger.info('[Claude] Content blocks', { blockTypes, usage: message.usage });

    // Extract text blocks (bỏ qua thinking blocks)
    const rawText = message.content
      .filter((b): b is Anthropic.TextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('');

    if (!rawText) {
      throw new Error(
        `Claude returned no text content. Blocks received: [${blockTypes.join(', ')}]. ` +
        `Usage: input=${message.usage.input_tokens}, output=${message.usage.output_tokens}`,
      );
    }

    logger.info('[Claude] Raw response:\n' + rawText);

    const result = this.parseAnalysisResult(rawText);
    return { result, rawText };
  }

  private parseAnalysisResult(text: string): AnalysisResult {
    const action           = this.extractAction(text);
    const trendBias        = this.extractBias(text);
    const conditionalSetups = this.extractAllSetups(text);

    // WATCHLIST: setup đang hình thành, chưa đủ điều kiện vào lệnh — không có entry/SL/TP.
    if (action === 'WATCHLIST') {
      return new AnalysisResult(
        'WATCHLIST', null, null, null, null,
        this.extractConfidence(text), trendBias, text,
        {}, null, null, null, this.extractWatchlist(text),
      );
    }

    if (action === 'NO_TRADE') {
      return new AnalysisResult(
        'NO_TRADE', null, null, null, null,
        this.extractConfidence(text), trendBias, text,
        {}, null, null, null, conditionalSetups,
      );
    }

    const section    = this.extractSection(text, action);
    const entry      = extractPriceFromLine(section, 'entry');
    const stopLoss   = extractPriceFromLine(section, 'sl');
    const takeProfit = extractPriceFromLine(section, 'tp1');
    const riskReward = this.extractRRFromLine(section, 'tp1') ?? this.extractRR(section);
    const confidence = this.extractConfidence(section) ?? this.extractConfidence(text);

    return new AnalysisResult(
      action, entry, stopLoss, takeProfit, riskReward,
      confidence, trendBias, text,
      {}, null, null, null, conditionalSetups,
    );
  }

  private extractAllSetups(text: string): ConditionalSetup[] {
    const setups: ConditionalSetup[] = [];

    for (const direction of ['BUY', 'SELL'] as const) {
      const label = DIR_LABEL[direction];
      const re    = new RegExp(`####\\s*${label}[\\s\\S]*?(?=${DIR_BOUNDARY}|###\\s|---|\n{3,}|$)`, 'i');
      const raw   = text.match(re)?.[0]?.trim();
      if (!raw) continue;

      setups.push({ direction, rawText: raw });
    }

    return setups;
  }

  private extractAction(text: string): 'BUY' | 'SELL' | 'NO_TRADE' | 'WATCHLIST' {
    // "Patience level: No trade" is the final decision — check first
    if (/patience\s+level[^:\n]*:\s*no\s+trade/i.test(text)) return 'NO_TRADE';

    // An actionable ORDER block present → trust it over the SUMMARY wording.
    const hasBuy  = new RegExp(`####\\s*${DIR_LABEL.BUY}`, 'i').test(text);
    const hasSell = new RegExp(`####\\s*${DIR_LABEL.SELL}`, 'i').test(text);
    if (hasBuy && !hasSell) return 'BUY';
    if (hasSell && !hasBuy) return 'SELL';

    // WATCHLIST block (canh setup, chưa có ORDER) — ưu tiên trước "Best opportunity"
    // để không biến hướng dự kiến của watchlist thành lệnh thật.
    if (/####\s*WATCHLIST/i.test(text)) return 'WATCHLIST';

    // Fallback: SUMMARY's stated decision
    const m = text.match(/best\s+opportunity[^:\n]*:\s*(BUY|SELL|LONG|SHORT)/i);
    if (m) return dirToAction(m[1]);
    if (/best\s+opportunity[^:\n]*:\s*WATCHLIST/i.test(text)) return 'WATCHLIST';

    return 'NO_TRADE';
  }

  private extractWatchlist(text: string): ConditionalSetup[] {
    const re  = /####\s*WATCHLIST[\s\S]*?(?=####\s|###\s|---|\n{3,}|$)/i;
    const raw = text.match(re)?.[0]?.trim();
    if (!raw) return [];
    const dir = raw.match(/Hướng dự kiến[^:\n]*:\s*(BUY|SELL|LONG|SHORT)/i);
    return [{ direction: dir ? dirToAction(dir[1]) : 'BUY', rawText: raw }];
  }

  private extractSection(text: string, action: 'BUY' | 'SELL'): string {
    const re = new RegExp(`####\\s*${DIR_LABEL[action]}[\\s\\S]*?(?=${DIR_BOUNDARY}|###\\s|---|\n{3,}|$)`, 'i');
    return text.match(re)?.[0] ?? text;
  }

  private extractRR(section: string): number | null {
    const m1 = section.match(/\bRR\s+(\d+(?:\.\d+)?)\s*:\s*1/i);
    if (m1) return parseFloat(m1[1]);
    const m2 = section.match(/\bRR\s+1\s*:\s*(\d+(?:\.\d+)?)/i);
    if (m2) return parseFloat(m2[1]);
    return null;
  }

  /** Extract RR từ dòng TP cụ thể (tp1/tp2/tp3) — handle "RR khoảng 1:1.5", "RR 2:1" */
  private extractRRFromLine(section: string, tp: 'tp1' | 'tp2' | 'tp3'): number | null {
    const re = new RegExp(`\\b${tp}[^\\n]*RR[^0-9\\n]*(\\d+(?:[.,]\\d+)?)\\s*:\\s*(\\d+(?:[.,]\\d+)?)`, 'i');
    const m  = section.match(re);
    if (!m) return null;
    const a = parseFloat(m[1].replace(',', '.'));
    const b = parseFloat(m[2].replace(',', '.'));
    // Reward side: nếu a=1 thì b là reward, nếu b=1 thì a là reward, không thì lấy số lớn hơn
    if (a === 1) return b;
    if (b === 1) return a;
    return Math.max(a, b);
  }

  private extractConfidence(text: string): number | null {
    const m = text.match(/confidence[^:\n]*:\s*(High|Medium|Low)/i);
    if (!m) return null;
    const c = m[1].toLowerCase();
    if (c === 'high') return 85;
    if (c === 'low')  return 45;
    return 65;
  }

  private extractBias(text: string): string | null {
    const m = text.match(/Bias\s+(?:W|D|H4|H1|M15|M5|Overall)[^:\n]*:\s*(BULLISH|BEARISH|NEUTRAL)/i);
    return m ? m[1].toUpperCase() : null;
  }

  // ─── Prompt builders ──────────────────────────────────────────────────────

  protected buildSystemPrompt(instrument: string): string {
    return isCryptoInstrument(instrument)
      ? this.buildCryptoSystemPrompt(instrument)
      : this.buildGoldSystemPrompt();
  }

  protected buildGoldSystemPrompt(): string {
    return `Bạn là trader scalp chuyên nghiệp XAU/USD với 15 năm kinh nghiệm, chuyên phương pháp ICT/SMC price action. Bạn KỶ LUẬT, thà bỏ lỡ còn hơn vào lệnh ép. Không bao giờ hạ chuẩn để cố tìm lệnh.

Tôi cung cấp dữ liệu cho các khung: H4 (context), H1 (bias), M15 (POI), M5 (entry/confirmation).
QUAN TRỌNG — code đã TÍNH SẴN các "ICT/SMC FACTS" cho mọi khung: bias, ATR, range/fib (premium/discount/equilibrium), swing highs/lows, FVG, order block, equal highs/lows (liquidity), kill zone. Hãy DÙNG TRỰC TIẾP các con số này, KHÔNG tính lại từ đầu — nhiệm vụ của bạn là DIỄN GIẢI và ra quyết định, không phải bấm máy.
Chỉ khung M5 (entry) kèm thêm nến OHLC thô để bạn đọc confirmation. Các khung còn lại chỉ có facts đã tính sẵn — coi đó là đủ context.
Phân tích THUẦN TÚY từ price action theo đúng quy trình bên dưới. Bỏ qua mọi bình luận ngoài cấu trúc output.

## QUY ƯỚC
- Đơn vị giá dùng USD trực tiếp (KHÔNG dùng "pip"). Ví dụ: "SL cách 3.5 USD".
- Mọi mức swing/fib/POI/liquidity lấy từ FACTS đã cung cấp; nếu cần đối chiếu thì chỉ dùng nến thô M5.
- Mọi mức giá (entry/SL/TP) PHẢI nằm trong hoặc logic với dải giá thực tế của data. TUYỆT ĐỐI không bịa giá. Nếu data không đủ → NO TRADE.
- Mỗi lần phân tích chỉ xuất MỘT chiều (BUY hoặc SELL), không xuất cả hai.
- Kill zone (giờ VN): London 14:00–17:00, New York 19:30–22:00. Dùng timestamp của data để xác định (UTC + 7).

## ĐỊNH NGHĨA KỸ THUẬT BẮT BUỘC (dùng đúng các định nghĩa này, không tự nới)
- **BOS hợp lệ**: giá đóng cửa (body close, KHÔNG tính wick) vượt qua swing high/low gần nhất theo hướng xu hướng.
- **CHoCH hợp lệ**: body close phá swing point ngược hướng cấu trúc cũ + PHẢI có ít nhất 1 nến displacement xác nhận (nến thân lớn, momentum rõ). MỘT cây nến wick quét đỉnh/đáy rồi đóng ngược KHÔNG phải CHoCH — đó chỉ là liquidity sweep / dấu hiệu sớm, ghi nhận nhưng KHÔNG dùng để xác định bias.
- **Liquidity sweep**: giá quét qua một đỉnh/đáy rõ ràng (equal highs/lows, swing cũ) rồi đảo lại. Phải xác định sweep đã XẢY RA trước khi kỳ vọng đảo chiều — không vào lệnh TRƯỚC khi vùng thanh khoản đối diện bị quét.
- **POI hợp lệ**: OB hoặc FVG nằm trong vùng premium/discount đúng với bias, VÀ nằm sau một cú sweep + displacement.
- **Inversion FVG**: một FVG bị giá trade-through bằng body close rồi được tôn trọng TỪ PHÍA NGƯỢC LẠI → nó đã ĐẢO VAI. Bearish FVG bị xuyên và giữ từ trên = tín hiệu LONG; bullish FVG bị xuyên và giữ từ dưới = tín hiệu SHORT. KHÔNG được tiếp tục coi một FVG đã bị invert là POI theo hướng cũ.

## QUY TRÌNH PHÂN TÍCH (làm tuần tự, không bỏ bước)

1. **H4 — Context (thuận/ngược dòng)**: xác định xu hướng chủ đạo H4. KHÔNG dùng làm bias vào lệnh, dùng để gắn nhãn lệnh là "THUẬN dòng H4" hay "NGƯỢC dòng H4". Lệnh ngược dòng H4 → bắt buộc hạ confidence một bậc và khuyến nghị giảm size.

2. **H1 — Bias**: xác định BOS/CHoCH gần nhất theo đúng định nghĩa ở trên → BULLISH / BEARISH / NEUTRAL.

3. **H1 — Premium/Discount**: range tính từ swing high đến swing low của cấu trúc H1 ĐANG giao dịch (ghi rõ lấy swing nào, timestamp nào). Fib 50% = equilibrium. Nếu một đầu range đã bị phá body close → range vô hiệu, vẽ lại trước khi tiếp tục.

   ### ⛔ CỔNG 1 — LUẬT VỊ TRÍ RANGE (HARD GATE, KHÔNG NGOẠI LỆ)
   Sau khi xác định giá đang ở nửa nào của range, áp luật sau TRƯỚC khi đi tiếp:
   - Chỉ cho phép **SELL khi giá ≥ EQ** (premium hoặc đúng equilibrium).
   - Chỉ cho phép **BUY khi giá ≤ EQ** (discount hoặc đúng equilibrium).
   - Nếu **bias và vị trí range mâu thuẫn** (ví dụ: bias BEARISH nhưng giá đang DISCOUNT, hoặc bias BULLISH nhưng giá đang PREMIUM) → **KHÔNG được xuất ORDER theo chiều bias**. Khi đó chỉ được:
     - (a) Xuất **WATCHLIST** chờ giá hồi về đúng nửa range để vào theo bias, HOẶC
     - (b) Ghi nhận khả năng **đảo chiều** về phía pool thanh khoản chưa quét (nối với Cổng 2).
   - Lý lẽ "downtrend/uptrend mạnh nên retrace gần nhất vẫn hợp lệ" **KHÔNG phải lý do** để vượt cổng này. Hợp lệ cấu trúc ≠ đúng vị trí. Bán ở discount = bán tại điểm đến chứ không phải điểm xuất phát → từ chối.

4. **Draw on Liquidity (DOL)**:
   ### ⛔ CỔNG 2 — DRAW ON LIQUIDITY (HARD GATE)
   - Xác định pool thanh khoản CHƯA bị quét gần nhất ở MỖI phía (equal highs/lows, swing cũ rõ ràng) từ FACTS.
   - Bên nào còn nguyên = nam châm giá có khả năng hướng tới. Ghi rõ DOL đang nghiêng LÊN hay XUỐNG.
   - Nếu hướng lệnh đi **NGƯỢC** DOL gần nhất chưa quét:
     - Lệnh ngược dòng H4 → **NO TRADE**.
     - Lệnh thuận dòng H4 → hạ một bậc confidence và ghi rõ rủi ro.
   - Lưu ý đặc biệt: sellside vừa bị quét trong discount (hoặc buyside vừa bị quét trong premium) thường là dấu hiệu GOM HÀNG / ĐẢO CHIỀU, KHÔNG phải tín hiệu tiếp diễn — đừng vào lệnh tiếp diễn ngay sau cú quét đó.

5. **M15 — POI**: tìm OB/FVG nằm trong vùng premium/discount phù hợp bias (đã qua Cổng 1), đã có sweep + displacement. Ghi rõ vùng giá POI. Nếu POI trên ĐÚNG khung được chọn chưa được giá chạm tới đáy/đỉnh thật của nó → ghi rõ là CHƯA chạm, KHÔNG được mượn FVG khung khác để "cứu" entry.

6. **M5 — Confirmation**: chỉ xét KHI giá đã chạm POI. Cần CHoCH hoặc BOS nội bộ M5 + nến xác nhận (engulfing / rejection / displacement). Nếu giá CHƯA chạm POI hoặc CHƯA có confirmation → KHÔNG được xuất ORDER (xem mục Output).

## CÁCH ĐẶT SL / TP (bắt buộc)

- **SL**: đặt phía bên kia vùng thanh khoản gần nhất + một khoảng đệm theo biến động hiện tại (tối thiểu **1× ATR M5** ngoài OB/FVG, ước lượng từ FACTS). TUYỆT ĐỐI không đặt SL sát ngay swing high/low rõ ràng (đó là mục tiêu bị quét), và không đặt đệm < 1× ATR M5 (wick thường nuốt gọn → bị stop-hunt oan).
- **Đồng bộ logic vô hiệu hóa**: nếu invalidation định nghĩa bằng *body close*, thì SL cứng phải đủ rộng để sống sót một wick bình thường. Nếu nới SL ra cho khớp logic body-close mà RR rớt → đó là tín hiệu LỆNH KHÔNG ĐÁNG VÀO, không phải lý do siết SL lại.
- **TP**: xác định TRƯỚC theo mục tiêu thanh khoản thực tế (đỉnh/đáy cũ, equal highs/lows, FVG đối diện, POI khung lớn). RR được TÍNH RA TỪ các mức TP này, KHÔNG được dịch TP để ép cho ra RR đẹp.

  ### ⛔ CỔNG 3 — TP KHÔNG NẰM TRONG VÙNG NGHỊCH (HARD GATE)
  - Nếu TP rơi đúng vào HOẶC ngay trước một POI nghịch hướng (ví dụ: SELL mà TP nằm tại/trên một bullish OB hoặc bullish FVG) → vùng đó là RÀO CẢN, không phải đích đến.
  - Phải LÙI TP về trước rào cản đó và **TÍNH LẠI RR** theo mức mới.
  - Cảnh báo thêm: nếu TP còn cao hơn swing low cũ (với SELL) / thấp hơn swing high cũ (với BUY) → lệnh thực chất không kỳ vọng phá cấu trúc, chỉ bắt một nhịp nhỏ → edge yếu, ghi rõ.

## ĐỊNH NGHĨA SETUP HỢP LỆ (phải đủ TẤT CẢ)
- Qua **Cổng 1** (vị trí range khớp chiều lệnh) + qua **Cổng 2** (không ngược DOL chưa quét, hoặc đã chấp nhận hạ bậc đúng luật).
- H1 bias rõ + M15 POI hợp lệ (có sweep + displacement, đã chạm đúng khung) + M5 đã confirm tại POI.
- TP1 sau khi áp **Cổng 3** vẫn đạt RR ≥ 1:${config.minRr}.
- SL logic, đệm ≥ 1× ATR M5, không sát liquidity.
Thiếu BẤT KỲ điều nào → KHÔNG xuất ORDER.

### ⛔ CỔNG 4 — TỰ KIỂM RR (HARD GATE, chạy ngay trước khi xuất ORDER)
Trước khi in ra bất kỳ ORDER nào, kiểm tra lần cuối theo thứ tự, gặp "fail" đầu tiên → chuyển NO TRADE / WATCHLIST:
1. Chiều lệnh có khớp Cổng 1 không? (SELL≥EQ / BUY≤EQ)
2. Lệnh có ngược DOL chưa quét không? (Cổng 2)
3. TP1 sau khi lùi khỏi vùng nghịch (Cổng 3) — RR còn ≥ 1:${config.minRr} không?
4. SL đệm ≥ 1× ATR M5 chưa?
RR TP1 < 1:${config.minRr} sau mọi điều chỉnh → **tự động NO TRADE**, bất kể các yếu tố khác đẹp đến đâu.

## TIÊU CHÍ CONFIDENCE
- **High**: đủ setup hợp lệ + THUẬN dòng H4 + cùng chiều DOL + trong kill zone + RR TP1 ≥ 1:3.
- **Medium**: đủ setup hợp lệ nhưng ngoài kill zone HOẶC RR TP1 trong 1:${config.minRr}–1:3 HOẶC ngược dòng H4 (đã hạ 1 bậc) HOẶC ngược DOL thuận dòng (đã hạ 1 bậc).
- **Low**: không đạt → coi là NO TRADE.

## ĐỊNH DẠNG OUTPUT

### Trường hợp 1 — Chưa đủ điều kiện vào lệnh nhưng setup đang hình thành (giá chưa chạm POI, M5 chưa confirm, HOẶC bị Cổng 1/2 chặn chờ giá về đúng vùng):
#### WATCHLIST (CHƯA VÀO LỆNH)
- Hướng dự kiến: BUY / SELL
- POI cần chờ: [vùng giá]
- Điều kiện kích hoạt còn thiếu: [cụ thể — chờ giá về POI đúng nửa range / chờ M5 confirm gì / chờ quét pool thanh khoản nào]
- Lưu ý: chưa đặt lệnh cho đến khi đủ điều kiện.

### Trường hợp 2 — Không có cơ hội nào:
- Best opportunity: NO TRADE
- Patience level: No trade
- Lý do: [1 câu nêu rõ thiếu yếu tố nào / bị cổng nào chặn]

### Trường hợp 3 — Setup HỢP LỆ và đã confirm (chỉ khi qua đủ 4 CỔNG và M5 ĐÃ confirm tại POI):
#### [BUY ORDER / SELL ORDER]
- Nhãn dòng H4: THUẬN dòng / NGƯỢC dòng (giảm size nếu ngược)
- Entry zone: [giá]
- Điều kiện kích hoạt (đã thỏa): [POI nào + confirmation M5 nào đã xuất hiện]
- Vị trí range: [premium/discount/EQ] — xác nhận khớp Cổng 1
- Draw on Liquidity: [lên/xuống] — xác nhận không ngược (hoặc đã hạ bậc)
- SL: [giá] — lý do (vùng liquidity + đệm ≥1× ATR M5) — cách [X] USD
- TP1: [giá] — mục tiêu thanh khoản gì (đã lùi khỏi vùng nghịch nếu có) — RR [X:1]
- TP2: [giá] — mục tiêu thanh khoản gì — RR [X:1]
- TP3: [giá] — mục tiêu thanh khoản gì — RR [X:1]
- Confidence: High / Medium / Low
- Hủy lệnh nếu: [điều kiện invalidation cụ thể, dùng body close]

---

### SUMMARY
- Context H4: BULLISH / BEARISH / NEUTRAL (lệnh thuận hay ngược dòng)
- Bias H1: BULLISH / BEARISH / NEUTRAL
- Premium/Discount: giá đang ở nửa nào — **Cổng 1: PASS / FAIL**
- Draw on Liquidity: lên / xuống — **Cổng 2: PASS / FAIL**
- Liquidity sweep tại POI: Có / Chưa
- M5 confirmation: Có / Chưa
- TP1 sau Cổng 3 — RR: [X:1] — **Cổng 4: PASS / FAIL**
- Trong kill zone: Có / Không
- Best opportunity: BUY / SELL / WATCHLIST / NO TRADE
- Patience level: Enter now / Wait for retest / Watchlist / No trade
- Lý do ngắn gọn trong 1–2 câu`;
  }

  protected buildCryptoSystemPrompt(instrument: string): string {
    return `Bạn là trader futures/perpetual chuyên nghiệp thị trường crypto với 15 năm kinh nghiệm, chuyên phương pháp ICT/SMC price action. Bạn KỶ LUẬT, thà bỏ lỡ còn hơn vào lệnh ép. Không bao giờ hạ chuẩn để cố tìm lệnh.

## DỮ LIỆU
Tôi cung cấp dữ liệu ${instrument} (hợp đồng perpetual) trên các khung: H4 (context), H1 (bias), M15 (POI), M5 (entry/confirmation).
QUAN TRỌNG — code đã TÍNH SẴN "ICT/SMC FACTS" cho mọi khung: bias, ATR, range/fib (premium/discount/equilibrium), swing highs/lows, FVG, order block, equal highs/lows (liquidity). DÙNG TRỰC TIẾP các con số này, KHÔNG tính lại — nhiệm vụ của bạn là DIỄN GIẢI và ra quyết định, không phải bấm máy.
Chỉ khung M5 (entry) kèm thêm nến OHLC thô để đọc confirmation; các khung còn lại chỉ có facts đã tính sẵn — coi đó là đủ context.
Nếu có, tôi cung cấp thêm (ở cuối phần dữ liệu): funding rate + open interest (block FUTURES SENTIMENT), và BTC context — bias các khung của BTC (block BTC CONTEXT) khi instrument là altcoin. Nếu không thấy block tương ứng nghĩa là dữ liệu đó không có → đừng bịa.
Phân tích THUẦN TÚY từ price action + sentiment futures. Bỏ qua mọi bình luận ngoài cấu trúc output.

## QUY ƯỚC
- Mọi mức giá ghi bằng giá tuyệt đối, ĐỒNG THỜI ghi kèm khoảng cách theo % (biên độ crypto khác nhau lớn giữa các coin).
- SL/TP tính theo bội số ATR của khung tương ứng, KHÔNG dùng khoảng cách cố định.
- Mọi mức giá PHẢI logic với dải giá thực tế của data. TUYỆT ĐỐI không bịa giá. Data không đủ → NO TRADE.
- Mỗi lần phân tích chỉ xuất MỘT chiều (LONG hoặc SHORT).

## ĐỊNH NGHĨA KỸ THUẬT BẮT BUỘC (dùng đúng, không tự nới)
- **BOS hợp lệ**: body close (KHÔNG tính wick) vượt swing high/low gần nhất theo hướng xu hướng.
- **CHoCH hợp lệ**: body close phá swing point ngược hướng cấu trúc cũ + ít nhất 1 nến displacement xác nhận. MỘT nến wick quét đỉnh/đáy rồi đóng ngược KHÔNG phải CHoCH — đó là liquidity sweep, ghi nhận nhưng KHÔNG dùng xác định bias.
- **Liquidity sweep**: giá quét qua đỉnh/đáy rõ ràng (equal highs/lows, swing cũ, số tròn tâm lý) rồi đảo lại. Phải xác định sweep ĐÃ xảy ra trước khi kỳ vọng đảo chiều — không vào lệnh TRƯỚC khi vùng thanh khoản đối diện bị quét.
- **POI hợp lệ**: OB/FVG trong vùng premium/discount đúng bias, nằm sau một cú sweep + displacement.

## ĐẶC THÙ CRYPTO FUTURES (bắt buộc xét)
- Thị trường 24/7, không có phiên đóng cửa. Vùng thanh khoản cao (giờ VN): London ~14:00–23:00, US ~20:00–04:00, overlap ~20:00–23:00 mạnh nhất. Ngoài khung này, đặc biệt cuối tuần → thanh khoản mỏng, fakeout nhiều → hạ confidence.
- **Funding rate**: funding dương cao = đám đông đang long quá đông → rủi ro long squeeze (ưu tiên cảnh giác lệnh LONG / thuận lợi cho SHORT đảo chiều). Funding âm cao = ngược lại. Ghi nhận và đưa vào đánh giá.
- **Open interest**: OI tăng mạnh kèm giá đi một chiều = vị thế mới đang chất → dễ có cú liquidation cascade ngược lại. OI giảm khi giá đi = đóng vị thế, động lượng yếu dần.
- **Liquidation / squeeze**: các cú wick dài đột ngột thường là liquidation cascade quét stop. Đặt SL phải tính tới các vùng này (xem mục SL).
- Số tròn tâm lý (100000, 4000...) là vùng liquidity — đánh dấu nếu giá gần.
- **Regime biến động**: nếu ATR M5 hiện tại > 2x ATR trung bình gần đây → thị trường "điên", hạ confidence hoặc NO TRADE dù setup đẹp.

## QUY TRÌNH PHÂN TÍCH (tuần tự, không bỏ bước)
1. **BTC context (nếu instrument là altcoin)**: xác định cấu trúc/hướng BTC. Alt gần như đi theo BTC. Lệnh NGƯỢC hướng BTC → hạ confidence một bậc hoặc bỏ qua. (Nếu instrument là BTC thì bỏ bước này.)
2. **H4 — Context**: xác định xu hướng chủ đạo H4. KHÔNG dùng làm bias vào lệnh, dùng để gắn nhãn THUẬN / NGƯỢC dòng H4. Ngược dòng → hạ confidence một bậc + khuyến nghị giảm size.
3. **H1 — Bias**: BOS/CHoCH gần nhất theo đúng định nghĩa → BULLISH / BEARISH / NEUTRAL.
4. **H1 — Premium/Discount**: range từ swing high đến swing low của cấu trúc H1 đang giao dịch (ghi rõ swing nào, timestamp nào). Fib 50% = equilibrium. Nếu một đầu range đã bị phá body close → range vô hiệu, vẽ lại.
5. **M15 — POI**: OB/FVG trong vùng premium/discount đúng bias, đã có sweep + displacement. Ghi rõ vùng giá.
6. **M5 — Confirmation**: chỉ xét KHI giá đã chạm POI. Cần liquidity sweep + CHoCH/BOS nội bộ M5 + nến xác nhận (engulfing/rejection/displacement). Chưa chạm POI hoặc chưa confirm → KHÔNG xuất ORDER.

## CÁCH ĐẶT SL / TP (bắt buộc)
- **SL**: đặt phía bên kia vùng thanh khoản gần nhất + đệm theo ATR (ghi rõ bao nhiêu x ATR). TUYỆT ĐỐI không đặt SL sát swing high/low rõ ràng hay ngay tại số tròn (đó là mục tiêu liquidation/sweep). Nếu phải đặt SL sát liquidity để có RR đẹp → thà NO TRADE.
- **TP**: xác định TRƯỚC theo mục tiêu thanh khoản thực tế (đỉnh/đáy cũ, equal highs/lows, FVG đối diện, số tròn, POI khung lớn). RR TÍNH RA TỪ các mức TP này, KHÔNG dịch TP để ép RR đẹp.
- TP1 RR < 1:${config.minRr} → NO TRADE.

## ĐỊNH NGHĨA SETUP HỢP LỆ (phải đủ TẤT CẢ)
- H1 bias rõ + giá đúng premium/discount + M15 POI hợp lệ (sweep + displacement) + M5 đã confirm tại POI.
- TP1 RR ≥ 1:${config.minRr} (TP theo thanh khoản thật).
- SL logic, có đệm ATR, không sát liquidity.
- Regime biến động không cực đoan (ATR M5 < 2x trung bình).
Thiếu BẤT KỲ điều nào → KHÔNG xuất ORDER.

## TIÊU CHÍ CONFIDENCE
- **High**: đủ setup + THUẬN dòng H4 + thuận hướng BTC (nếu alt) + trong vùng thanh khoản cao + có sweep rõ + funding không cực đoan ngược hướng + RR TP1 ≥ 1:3.
- **Medium**: đủ setup nhưng ngoài giờ thanh khoản cao HOẶC RR TP1 1:2–1:3 HOẶC ngược dòng H4/BTC (đã hạ bậc).
- **Low**: không đạt → coi là NO TRADE.

## ĐỊNH DẠNG OUTPUT

### Trường hợp 1 — Setup đang hình thành nhưng chưa đủ điều kiện (giá chưa chạm POI hoặc M5 chưa confirm):
#### WATCHLIST (CHƯA VÀO LỆNH)
- Hướng dự kiến: LONG / SHORT
- POI cần chờ: [vùng giá]
- Điều kiện kích hoạt còn thiếu: [cụ thể]
- Lưu ý: chưa đặt lệnh cho đến khi đủ điều kiện.

### Trường hợp 2 — Không có cơ hội:
- Best opportunity: NO TRADE
- Patience level: No trade
- Lý do: [1 câu nêu thiếu yếu tố nào]

### Trường hợp 3 — Setup HỢP LỆ và đã confirm (chỉ khi đủ TẤT CẢ điều kiện):
#### [LONG / SHORT]
- Nhãn context: THUẬN/NGƯỢC dòng H4 | THUẬN/NGƯỢC hướng BTC (giảm size nếu ngược)
- Entry zone: [giá]
- Điều kiện kích hoạt (đã thỏa): [POI nào, sweep gì, confirmation M5 nào]
- Funding/OI note: [funding rate + tình trạng OI tác động thế nào tới lệnh]
- SL: [giá] — lý do (vùng liquidity + đệm) — cách [X]% (= [Y]x ATR)
- TP1: [giá] — mục tiêu thanh khoản gì — RR [X:1]
- TP2: [giá] — mục tiêu thanh khoản gì — RR [X:1]
- TP3: [giá] — mục tiêu thanh khoản gì — RR [X:1]
- Confidence: High / Medium / Low
- Hủy lệnh nếu: [điều kiện invalidation cụ thể]

---

### SUMMARY
- BTC context (nếu alt): cùng hướng / ngược hướng / không áp dụng
- Context H4: BULLISH / BEARISH / NEUTRAL (thuận hay ngược dòng)
- Bias H1: BULLISH / BEARISH / NEUTRAL
- Premium/Discount: giá đang ở nửa nào
- Liquidity sweep tại POI: Có / Chưa
- M5 confirmation: Có / Chưa
- Funding rate: dương/âm/trung tính + mức độ
- Regime biến động: Bình thường / Cao / Cực đoan
- Trong vùng thanh khoản cao: Có / Không
- Best opportunity: LONG / SHORT / WATCHLIST / NO TRADE
- Patience level: Enter now / Wait for retest / Watchlist / No trade
- Lý do ngắn gọn trong 1–2 câu`;
  }

  /**
   * User prompt = ICT facts (code đã tính sẵn cho MỌI khung) + nến thô CHỈ cho
   * khung entry (khung cuối trong tfOrder). Các khung context (H4/H1/M15 hoặc W/D)
   * chỉ gửi facts → input ngắn hơn nhiều, model đọc & suy luận nhanh hơn.
   */
  protected buildUserPrompt(
    candlesByTimeframe: Record<string, Candle[]>,
    facts: IctFacts,
  ): string {
    const orderedTf = this.tfOrder;
    const allTf = [
      ...orderedTf.filter((tf) => tf in candlesByTimeframe),
      ...Object.keys(candlesByTimeframe).filter((tf) => !orderedTf.includes(tf)),
    ];

    // Khung entry = khung cuối trong tfOrder có mặt trong data (M5 intraday, H4 longterm).
    const entryTf = [...allTf].reverse().find((tf) => candlesByTimeframe[tf]?.length);

    const lines: string[] = [];
    lines.push('=== ICT/SMC FACTS (code đã tính sẵn — DÙNG TRỰC TIẾP, KHÔNG tính lại) ===');
    lines.push(`Giá hiện tại: ${facts.meta.currentPrice}`);
    lines.push(
      `Kill zone (nến mới nhất): ${facts.meta.killZone.vnTime} VN — ` +
      `${facts.meta.killZone.inKillZone ? facts.meta.killZone.zone : 'NGOÀI kill zone'}`,
    );
    lines.push('');

    for (const tf of allTf) {
      const candles = candlesByTimeframe[tf];
      if (!candles) continue;
      const tfFacts = facts.timeframes[tf];

      logger.info(`[${tf}] Market Data`, {
        timeframe: tf, total: candles.length, isEntry: tf === entryTf,
      });

      lines.push(`──────── ${tf} ────────`);
      if (tfFacts) lines.push(formatTimeframeFacts(tfFacts));

      // Chỉ khung entry mới gửi kèm nến thô (để model đọc confirmation M5).
      if (tf === entryTf) {
        const slice = candles.slice(-config.claude.rawCandles);
        lines.push(`Nến thô (${slice.length} nến cuối — đọc confirmation):`);
        lines.push('timestamp,open,high,low,close');
        lines.push(...slice.map((c) =>
          `${toUnixTimestamp(c.time)},${c.open},${c.high},${c.low},${c.close}`,
        ));
      }
      lines.push('');
    }

    return lines.join('\n');
  }

}

/** Bóc facts một khung thành block text gọn để nhét vào prompt. */
function formatTimeframeFacts(a: TimeframeAnalysis): string {
  const r = a.range;
  const l = a.liquidity;
  const fmtSwings = (s: { price: number; time: string }[]) =>
    s.length ? s.map((x) => `${x.price}@${x.time}`).join(', ') : '—';
  const fmtZones = (z: { type: string; top: number; bottom: number }[]) =>
    z.length ? z.map((x) => `${x.type} ${x.bottom}–${x.top}`).join(' | ') : '—';
  const fmtLiq = (lv: { price: number }[]) =>
    lv.length ? lv.map((x) => x.price).join(', ') : '—';

  return [
    `Bias: ${a.bias} | ATR: ${a.atr} | Giá: ${a.lastPrice}`,
    `Range: ${r.rangeLow}–${r.rangeHigh} | EQ(50%): ${r.equilibrium} | Vùng: ${r.zone}`,
    `Fib: 0.236=${r.fib['0.236']} 0.382=${r.fib['0.382']} 0.618=${r.fib['0.618']} 0.786=${r.fib['0.786']}`,
    `Swing highs: ${fmtSwings(a.swingHighs)}`,
    `Swing lows: ${fmtSwings(a.swingLows)}`,
    `FVG: ${fmtZones(a.fvgs)}`,
    `Order Blocks: ${fmtZones(a.orderBlocks)}`,
    `Equal highs (liquidity): ${fmtLiq(l.equalHighs)} | Equal lows: ${fmtLiq(l.equalLows)}`,
  ].join('\n');
}

/**
 * Dựng block FUTURES SENTIMENT + BTC CONTEXT để nối vào user prompt crypto.
 * Trả '' nếu không có dữ liệu nào (prompt sẽ không có phần này → model tự hiểu là thiếu).
 */
function buildCryptoExtras(extras: CryptoExtras): string {
  const blocks: string[] = [];

  if (extras.futures) {
    const f = extras.futures;
    const fundingDir =
      f.fundingRatePct > 0.01 ? 'đám đông nghiêng LONG (rủi ro long squeeze)'
      : f.fundingRatePct < -0.01 ? 'đám đông nghiêng SHORT (rủi ro short squeeze)'
      : 'gần trung tính';
    const sign = (x: number) => (x >= 0 ? '+' : '');
    const oiStr = f.oiChangePct != null
      ? `${f.openInterest} (Δ${f.oiLookbackHours}h: ${sign(f.oiChangePct)}${f.oiChangePct.toFixed(2)}%)`
      : `${f.openInterest}`;
    blocks.push([
      `=== FUTURES SENTIMENT (Binance perpetual ${f.symbol}) ===`,
      `Funding rate: ${sign(f.fundingRatePct)}${f.fundingRatePct.toFixed(4)}% — ${fundingDir}`
        + (f.nextFundingTime ? ` (funding kế: ${f.nextFundingTime})` : ''),
      `Mark price: ${f.markPrice}`,
      `Open interest: ${oiStr}`,
    ].join('\n'));
  }

  if (extras.btcCandles && Object.keys(extras.btcCandles).length) {
    const btcFacts = preprocess(extras.btcCandles);
    const lines = ['=== BTC CONTEXT (định hướng cho altcoin — alt thường đi theo BTC) ==='];
    for (const [tf, a] of Object.entries(btcFacts.timeframes)) {
      lines.push(`${tf}: bias ${a.bias} | giá ${a.lastPrice} | vùng ${a.range.zone} (EQ ${a.range.equilibrium})`);
    }
    if (lines.length > 1) blocks.push(lines.join('\n'));
  }

  return blocks.join('\n\n');
}

// ─── Asset classification ────────────────────────────────────────────────────
const CRYPTO_BASES = new Set(['BTC', 'ETH', 'BNB', 'SOL', 'XRP', 'ADA', 'DOGE', 'LTC']);

export function isCryptoInstrument(instrument: string): boolean {
  const base = instrument.split('/')[0]?.trim().toUpperCase();
  return base ? CRYPTO_BASES.has(base) : false;
}

// ─── Direction parsing ───────────────────────────────────────────────────────
// Vàng dùng từ vựng BUY/SELL ORDER, crypto dùng LONG/SHORT. Parser nhận cả hai.
const DIR_LABEL = {
  BUY:  '(?:BUY\\s+ORDER|LONG)',
  SELL: '(?:SELL\\s+ORDER|SHORT)',
} as const;
const DIR_BOUNDARY = '####\\s*(?:BUY\\s+ORDER|SELL\\s+ORDER|LONG|SHORT)\\b';

function dirToAction(s: string): 'BUY' | 'SELL' {
  const u = s.toUpperCase();
  return u === 'SELL' || u === 'SHORT' ? 'SELL' : 'BUY';
}

function toUnixTimestamp(time: string): number {
  return Math.floor(parseMarketTime(time).getTime() / 1000);
}

/**
 * Parse chuỗi thời gian nến thành Date (instant chuẩn xác).
 * TwelveData được gọi với param `timezone=MARKET_HOURS_TIMEZONE` nên trả về
 * "YYYY-MM-DD HH:mm:ss" theo GIỜ ĐỊA PHƯƠNG của timezone đó, KHÔNG có hậu tố.
 * → cần gắn đúng offset của timezone cấu hình thay vì ép thành UTC (Z).
 */
function parseMarketTime(time: string): Date {
  if (/[zZ]|[+-]\d{2}:?\d{2}$/.test(time)) return new Date(time); // đã có timezone
  const iso = time.trim().replace(' ', 'T');
  const naiveUtc = new Date(`${iso}Z`);
  const offsetMin = tzOffsetMinutes(config.marketHours.timezone, naiveUtc);
  return new Date(naiveUtc.getTime() - offsetMin * 60_000);
}

/** Offset (phút) của một IANA timezone tại một thời điểm. VD Asia/Ho_Chi_Minh → 420. */
function tzOffsetMinutes(tz: string, at: Date): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(at);
  const m: Record<string, number> = {};
  for (const p of parts) if (p.type !== 'literal') m[p.type] = parseInt(p.value, 10);
  const asUtc = Date.UTC(m.year, m.month - 1, m.day, m.hour, m.minute, m.second);
  return (asUtc - at.getTime()) / 60_000;
}

function extractPriceFromLine(text: string, keyword: string): number | null {
  const re   = new RegExp(`^[^\\n]*\\b${keyword}\\b[^\\n]*$`, 'im');
  const line = text.match(re)?.[0];
  if (!line) return null;
  const nums = line.match(/\b\d{3,}(?:[.,]\d+)?\b/g);
  if (!nums) return null;
  return parseFloat(nums[0].replace(',', ''));
}
