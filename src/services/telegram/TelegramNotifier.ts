import axios from 'axios';
import { TradingSignal } from '@prisma/client';
import { AnalysisResult } from '../ai/dto/AnalysisResult';
import { Candle } from '../market/Candle';
import { config } from '../../config/trading';
import { logger } from '../../logger';

const MAX_LENGTH = 4000;

export class TelegramNotifier {
  private resolvedDiscussionId: string | null | undefined = undefined;
  private resolvedChannelNumericId: string | null | undefined = undefined;

  constructor(
    private readonly botToken: string,
    private readonly chatId: string,
    private readonly baseUrl: string,
    private readonly discussionId: string = '',
  ) {}

  static fromConfig(): TelegramNotifier {
    if (!config.telegram.botToken || !config.telegram.chatId) {
      throw new Error('TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID is not configured.');
    }
    return new TelegramNotifier(
      config.telegram.botToken,
      config.telegram.chatId,
      config.telegram.baseUrl,
      config.telegram.discussionId,
    );
  }

  /** Send message (auto-split if > 4000 chars). Returns first message_id. */
  async send(message: string): Promise<string | null> {
    const parts = this.splitMessage(message);
    let firstId: string | null = null;

    for (const part of parts) {
      const id = await this.sendPart(part);
      if (firstId === null) firstId = id;
    }

    return firstId;
  }

  /**
   * Post analysis as a comment in the discussion thread of a channel post.
   * Finds the forwarded message ID in the discussion group via getUpdates,
   * then replies to it so the analysis appears under the channel post's Comments.
   */
  async sendComment(message: string, channelMessageId: string): Promise<void> {
    const discussionId = await this.getDiscussionId();
    if (!discussionId) {
      logger.warn('No discussion group linked to channel, skipping analysis comment');
      return;
    }

    const discussionMsgId = await this.findForwardedMessageId(channelMessageId, discussionId);
    if (!discussionMsgId) {
      logger.warn('Could not find forwarded channel post in discussion group', { channelMessageId });
      return;
    }

    logger.info('Replying to discussion thread', { discussionMsgId, channelMessageId });

    const parts = this.splitMessage(message);
    for (const part of parts) {
      await this.sendPart(part, discussionMsgId, discussionId);
    }
  }

  /**
   * Poll getUpdates to find the message_id of the auto-forwarded channel post
   * inside the linked discussion group.
   * Supports both old (forward_from_message_id) and new (forward_origin) Bot API formats.
   * Falls back to forwardMessage if polling finds nothing after 8 attempts.
   */
  private async findForwardedMessageId(
    channelMessageId: string,
    discussionId: string,
  ): Promise<string | null> {
    const channelNumericId = await this.getChannelNumericId();
    const since = Math.floor(Date.now() / 1000) - 60;
    const maxAttempts = 8;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      await new Promise((r) => setTimeout(r, 1500));

      try {
        const url = `${this.baseUrl.replace(/\/$/, '')}/bot${this.botToken}/getUpdates`;
        const { data } = await axios.get(url, {
          params: { limit: 50, allowed_updates: JSON.stringify(['message', 'channel_post']) },
          timeout: 10_000,
        });

        for (const update of (data.result ?? []) as any[]) {
          const msg = update.message ?? update.channel_post;
          if (!msg || msg.date < since) continue;
          if (String(msg.chat?.id) !== discussionId) continue;

          // Bot API ≥ 7.0: forward_origin object
          const originMsgId = msg.forward_origin?.type === 'channel'
            ? String(msg.forward_origin.message_id)
            : undefined;
          const originChatId = msg.forward_origin?.type === 'channel'
            ? String(msg.forward_origin.chat?.id)
            : undefined;

          // Bot API < 7.0: flat fields
          const legacyMsgId = msg.forward_from_message_id !== undefined
            ? String(msg.forward_from_message_id)
            : undefined;
          const legacyChatId = msg.forward_from_chat?.id !== undefined
            ? String(msg.forward_from_chat.id)
            : undefined;

          const fwdMsgId = originMsgId ?? legacyMsgId;
          const fwdChatId = originChatId ?? legacyChatId;

          const chatMatches = fwdChatId === channelNumericId
            || fwdChatId === this.chatId
            || channelNumericId === null;

          if (fwdMsgId === channelMessageId && chatMatches) {
            logger.info('Found forwarded message in discussion group', {
              discussion_msg_id: msg.message_id,
              attempt,
            });
            return String(msg.message_id);
          }
        }
      } catch (err: any) {
        logger.warn('getUpdates attempt failed', { attempt, error: err.message });
      }
    }

    // Fallback: use forwardMessage to create an anchor in the discussion group
    logger.warn('getUpdates exhausted, falling back to forwardMessage', { channelMessageId });
    return this.forwardToDiscussion(channelMessageId, discussionId);
  }

  private async forwardToDiscussion(
    channelMessageId: string,
    discussionId: string,
  ): Promise<string | null> {
    try {
      const url = `${this.baseUrl.replace(/\/$/, '')}/bot${this.botToken}/forwardMessage`;
      const { data } = await axios.post(url, {
        chat_id: discussionId,
        from_chat_id: this.chatId,
        message_id: parseInt(channelMessageId, 10),
      }, { timeout: 10_000 });
      const msgId = data?.result?.message_id;
      if (msgId) {
        logger.info('Forwarded channel post to discussion group as anchor', { msgId });
        return String(msgId);
      }
    } catch (err: any) {
      logger.error('forwardMessage fallback failed', { error: err.message });
    }
    return null;
  }

  private async getDiscussionId(): Promise<string | null> {
    if (this.discussionId) return this.discussionId;
    if (this.resolvedDiscussionId !== undefined) return this.resolvedDiscussionId;
    await this.resolveChannelInfo();
    return this.resolvedDiscussionId ?? null;
  }

  private async getChannelNumericId(): Promise<string | null> {
    if (this.resolvedChannelNumericId !== undefined) return this.resolvedChannelNumericId ?? null;
    await this.resolveChannelInfo();
    return this.resolvedChannelNumericId ?? null;
  }

  private async resolveChannelInfo(): Promise<void> {
    try {
      const url = `${this.baseUrl.replace(/\/$/, '')}/bot${this.botToken}/getChat`;
      const { data } = await axios.get(url, {
        params: { chat_id: this.chatId },
        timeout: 10_000,
      });
      const linkedId: number | undefined = data?.result?.linked_chat_id;
      const channelId: number | undefined = data?.result?.id;
      this.resolvedDiscussionId = linkedId ? String(linkedId) : null;
      this.resolvedChannelNumericId = channelId ? String(channelId) : null;
      if (this.resolvedDiscussionId) {
        logger.info('Channel info resolved', {
          discussion_id: this.resolvedDiscussionId,
          channel_numeric_id: this.resolvedChannelNumericId,
        });
      }
    } catch (err: any) {
      logger.warn('resolveChannelInfo failed', { error: err.message });
      this.resolvedDiscussionId = null;
      this.resolvedChannelNumericId = null;
    }
  }

  formatStructured(result: AnalysisResult): string {
    const parts: string[] = [];
    const SEP = '━━━━━━━━━━━━━━━━━━━━━';

    // ── CẤU TRÚC THỊ TRƯỜNG ─────────────────────────────────
    if (result.marketStructure) {
      const ms = result.marketStructure;
      parts.push(`📊 <b>CẤU TRÚC THỊ TRƯỜNG</b>\n${SEP}`);

      const rows: [string, string | undefined][] = [
        ['Giá hiện tại',     ms.current_price],
        ['Xu hướng M5',      ms.trend_m5 ? [ms.trend_m5, ms.trend_m5_detail].filter(Boolean).join('  ') : undefined],
        ['Xu hướng M15',     ms.trend_m15 ? [ms.trend_m15, ms.trend_m15_detail].filter(Boolean).join('  ') : undefined],
        ['Cấu trúc',         ms.structure],
        ['Vị trí so với MA', ms.ma_position],
        ['RSI (M5)',         ms.rsi_m5],
      ];

      for (const [label, val] of rows) {
        if (val) parts.push(`<b>${htmlEscape(label)}:</b>  ${htmlEscape(val)}`);
      }
    }

    // ── CÁC MỨC GIÁ QUAN TRỌNG ──────────────────────────────
    if (result.keyLevels && result.keyLevels.length > 0) {
      if (parts.length) parts.push('');
      parts.push(`📍 <b>CÁC MỨC GIÁ QUAN TRỌNG</b>\n${SEP}`);

      for (const level of result.keyLevels) {
        const emoji = keyLevelEmoji(level.type);
        parts.push(`${emoji} ${htmlEscape(level.label)}\n    <code>${htmlEscape(level.value)}</code>`);
      }
    }

    // ── SETUPS ───────────────────────────────────────────────
    if (result.setups && result.setups.length > 0) {
      const sells = result.setups.filter(s => s.direction === 'SELL');
      const buys  = result.setups.filter(s => s.direction === 'BUY');

      for (const group of [sells, buys]) {
        if (!group.length) continue;
        const dir = group[0].direction;
        if (parts.length) parts.push('');
        const icon = dir === 'SELL' ? '🔴' : '🟢';
        parts.push(`${icon} <b>LỆNH ${dir === 'SELL' ? 'BÁN' : 'MUA'} — ${dir}</b>\n${SEP}`);

        for (const s of group) {
          const confLabel = s.confidence_label === 'Cao' ? '🟢 Cao' : s.confidence_label === 'Thấp' ? '🔴 Thấp' : '🟡 Trung bình';
          parts.push(
            `<b>${htmlEscape(s.label)}</b> — ${htmlEscape(s.description)}  (${confLabel})`,
            `  🎯 Vùng vào:  <code>${htmlEscape(s.entry_zone)}</code>`,
            `  ⚡ Kích hoạt: ${htmlEscape(s.trigger)}`,
            `  🛡 SL:        <code>${s.stop_loss}</code>${s.stop_loss_note ? ` — ${htmlEscape(s.stop_loss_note)}` : ''}`,
            `  💰 TP1:       <code>${s.tp1.value}</code>  (${htmlEscape(s.tp1.rr)})${s.tp1.note ? ` — ${htmlEscape(s.tp1.note)}` : ''}`,
            `  💰 TP2:       <code>${s.tp2.value}</code>  (${htmlEscape(s.tp2.rr)})`,
            `  💰 TP3:       <code>${s.tp3.value}</code>  (${htmlEscape(s.tp3.rr)})`,
            `  ❌ Hủy nếu:   ${htmlEscape(s.cancel_condition)}`,
            '',
          );
        }
      }
    }

    // fallback nếu không có structured data
    if (!parts.length && result.reasoning) {
      return this.formatAnalysis(result.reasoning);
    }

    return parts.join('\n').trim();
  }

  formatAnalysis(reasoning: string): string {
    let text = reasoning
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');

    // Convert markdown tables before other transforms (pipes are unaffected by HTML escaping)
    text = convertMarkdownTables(text);

    // ## / ### headers → bold with arrow prefix
    text = text.replace(/^#{1,3}\s+(.+)$/gm, '\n<b>▸ $1</b>');

    // **bold** → <b>bold</b>
    text = text.replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>');

    // *italic* → <i>italic</i>
    text = text.replace(/(?<!\*)\*([^*\n]+)\*(?!\*)/g, '<i>$1</i>');

    // - / * bullet points → •
    text = text.replace(/^[ \t]*[-*]\s+(.+)$/gm, '  • $1');

    return `📋 <b>PHÂN TÍCH CHI TIẾT</b>\n━━━━━━━━━━━━━━━━━━━━━\n\n${text.trim()}`;
  }

  formatSignal(signal: TradingSignal): string {
    const instrument = htmlEscape(signal.instrument);
    const time = formatDate(signal.created_at);

    const actionLine =
      signal.action === 'BUY' ? '🟢 <b>MUA (BUY)</b>' :
      signal.action === 'SELL' ? '🔴 <b>BÁN (SELL)</b>' :
      '⚪ <b>KHÔNG VÀO LỆNH</b>';

    const SEP = '━━━━━━━━━━━━━━━━━━━━━';

    const lines: string[] = [
      SEP,
      `📊 <b>${instrument}</b>  ${actionLine}`,
      SEP,
      `🕐 ${time} <i>(Giờ VN)</i>`,
    ];

    if (signal.current_price != null) {
      lines.push(`💵 <b>Giá hiện tại:</b>  ${formatPrice(toNum(signal.current_price), 3)}`);
    }

    if (signal.trend_bias != null) {
      const biasLabel =
        signal.trend_bias.toUpperCase() === 'BULLISH' ? '📈 Tăng' :
        signal.trend_bias.toUpperCase() === 'BEARISH' ? '📉 Giảm' :
        '➖ Trung tính';
      lines.push(`📐 <b>Xu hướng:</b>      ${biasLabel}`);
    }

    if (signal.action === 'BUY' || signal.action === 'SELL') {
      lines.push('');
      lines.push('<b>─ Thông số lệnh ──────────────</b>');
      if (signal.entry != null)
        lines.push(`🎯 Entry:       <code>${formatPrice(toNum(signal.entry), 3)}</code>`);
      if (signal.stop_loss != null)
        lines.push(`🛡 Stop Loss:   <code>${formatPrice(toNum(signal.stop_loss), 3)}</code>`);
      if (signal.take_profit != null)
        lines.push(`💰 Take Profit: <code>${formatPrice(toNum(signal.take_profit), 3)}</code>`);
      if (signal.risk_reward != null)
        lines.push(`⚖️ R:R:         <code>1 : ${formatPrice(toNum(signal.risk_reward), 2)}</code>`);
    }

    if (signal.confidence != null) {
      const conf = signal.confidence;
      const filled = Math.round(conf / 10);
      const bar = '█'.repeat(filled) + '░'.repeat(10 - filled);
      lines.push('');
      lines.push('<b>─ Đánh giá AI ─────────────────</b>');
      lines.push(`🔎 Độ tin cậy: <b>${conf}/100</b>`);
      lines.push(`<code>${bar}</code>`);
    }

    lines.push('');
    lines.push(SEP);
    lines.push('<i>⚠️ Tín hiệu tham khảo từ AI, không phải lời khuyên đầu tư.</i>');

    return lines.join('\n');
  }

  formatSignalCard(result: AnalysisResult, instrument: string, currentPrice?: number): string {
    const SEP = '━━━━━━━━━━━━━━━━━━━━━';
    const time = formatDate(new Date());

    const actionLine =
      result.action === 'BUY'  ? '🟢 <b>MUA (BUY)</b>'  :
      result.action === 'SELL' ? '🔴 <b>BÁN (SELL)</b>' :
      '⚪ <b>KHÔNG VÀO LỆNH</b>';

    const lines: string[] = [
      SEP,
      `📊 <b>${htmlEscape(instrument)}</b>  ${actionLine}`,
      SEP,
      `🕐 ${time} <i>(Giờ VN)</i>`,
    ];

    if (currentPrice != null) {
      lines.push(`💵 <b>Giá hiện tại:</b>  ${formatPrice(currentPrice, 2)}`);
    }

    if (result.trendBias) {
      const biasLabel =
        result.trendBias.toUpperCase() === 'BULLISH' ? '📈 Tăng'     :
        result.trendBias.toUpperCase() === 'BEARISH' ? '📉 Giảm'     :
        '➖ Trung tính';
      lines.push(`📐 <b>Xu hướng:</b>      ${biasLabel}`);
    }

    if (result.action === 'BUY' || result.action === 'SELL') {
      lines.push('');
      lines.push('<b>─ Thông số lệnh ──────────────</b>');
      if (result.entry != null) {
        lines.push(`🎯 Entry:       <code>${formatPrice(result.entry, 2)}</code>`);
        if (result.stopLoss != null) {
          const slPct = Math.abs(result.stopLoss - result.entry) / result.entry * 100;
          lines.push(`🛡 Stop Loss:   <code>${formatPrice(result.stopLoss, 2)}</code>  <i>(-${slPct.toFixed(2)}%)</i>`);
        }
        if (result.takeProfit != null) {
          const tpPct = Math.abs(result.takeProfit - result.entry) / result.entry * 100;
          lines.push(`💰 Take Profit: <code>${formatPrice(result.takeProfit, 2)}</code>  <i>(+${tpPct.toFixed(2)}%)</i>`);
        }
      } else {
        if (result.stopLoss   != null) lines.push(`🛡 Stop Loss:   <code>${formatPrice(result.stopLoss, 2)}</code>`);
        if (result.takeProfit != null) lines.push(`💰 Take Profit: <code>${formatPrice(result.takeProfit, 2)}</code>`);
      }
      if (result.riskReward != null) lines.push(`⚖️ R:R:         <code>1 : ${formatPrice(result.riskReward, 2)}</code>`);
    }

    if (result.confidence != null) {
      const conf   = result.confidence;
      const filled = Math.round(conf / 10);
      const bar    = '█'.repeat(filled) + '░'.repeat(10 - filled);
      lines.push('');
      lines.push('<b>─ Đánh giá AI ─────────────────</b>');
      lines.push(`🔎 Độ tin cậy: <b>${conf}/100</b>`);
      lines.push(`<code>${bar}</code>`);
    }

    if (result.conditionalSetups.length > 0) {
      lines.push('');
      lines.push('<b>─ Kịch bản tiềm năng ──────────</b>');
      for (const s of result.conditionalSetups) {
        const icon = s.direction === 'BUY' ? '🟢' : '🔴';
        const dir  = s.direction === 'BUY' ? 'MUA' : 'BÁN';
        lines.push(`${icon} <b>${dir} (${s.direction})</b>`);
        lines.push(markdownToHtml(s.rawText));
      }
    }

    lines.push('');
    lines.push(SEP);
    lines.push('<i>⚠️ Tín hiệu tham khảo từ AI, không phải lời khuyên đầu tư.</i>');

    return lines.join('\n');
  }

  /**
   * Gửi file CSV nến cho từng timeframe vào discussion thread.
   */
  async sendCandleFiles(
    instrument: string,
    candlesByTf: Record<string, Candle[]>,
    channelMessageId: string,
  ): Promise<void> {
    const discussionId = await this.getDiscussionId();
    if (!discussionId) {
      logger.warn('No discussion group linked, skipping candle files');
      return;
    }

    const discussionMsgId = await this.findForwardedMessageId(channelMessageId, discussionId);
    if (!discussionMsgId) {
      logger.warn('Could not find forwarded message, skipping candle files');
      return;
    }

    for (const [tf, candles] of Object.entries(candlesByTf)) {
      try {
        const csv      = this.buildCandleCSV(candles);
        const stamp    = formatDate(new Date()).replace(/[/: ]/g, '');
        const filename = `${instrument.replace('/', '')}_${tf}_${stamp}.csv`;
        const caption  = `📊 <b>${htmlEscape(instrument)} ${htmlEscape(tf)}</b> — ${candles.length} nến`;
        await this.sendDocument(csv, filename, caption, discussionMsgId, discussionId);
        logger.info('Candle file sent', { tf, filename });
      } catch (err: any) {
        logger.error('Failed to send candle file', { tf, error: err.message });
      }
    }
  }

  private buildCandleCSV(candles: Candle[]): string {
    const header = 'time,open,high,low,close';
    const rows   = candles.map(c =>
      `${c.time},${c.open},${c.high},${c.low},${c.close}`,
    );
    return [header, ...rows].join('\n');
  }

  private async sendDocument(
    content: string,
    filename: string,
    caption: string,
    replyToMessageId: string,
    chatId: string,
  ): Promise<void> {
    const url  = `${this.baseUrl.replace(/\/$/, '')}/bot${this.botToken}/sendDocument`;
    const form = new FormData();
    form.append('chat_id', chatId);
    form.append('document', new Blob([content], { type: 'text/csv' }), filename);
    form.append('caption', caption);
    form.append('parse_mode', 'HTML');
    form.append('reply_to_message_id', replyToMessageId);

    try {
      await axios.post(url, form, { timeout: 30_000 });
    } catch (err: any) {
      logger.error('Telegram sendDocument failed', {
        status: err.response?.status,
        body:   err.response?.data,
      });
      throw new Error(`Telegram sendDocument failed: ${err.message}`);
    }
  }

  // ─── private ──────────────────────────────────────────────────────────────

  private async sendPart(text: string, replyToMessageId?: string, chatId?: string): Promise<string | null> {
    const url = `${this.baseUrl.replace(/\/$/, '')}/bot${this.botToken}/sendMessage`;

    const body: Record<string, unknown> = {
      chat_id: chatId ?? this.chatId,
      text,
      parse_mode: 'HTML',
      disable_web_page_preview: true,
    };

    if (replyToMessageId) {
      body.reply_to_message_id = parseInt(replyToMessageId, 10);
    }

    try {
      const { data } = await axios.post(url, body, { timeout: 20_000 });
      const messageId = data?.result?.message_id;
      return messageId !== undefined ? String(messageId) : null;
    } catch (err: any) {
      logger.error('Telegram sendMessage failed', {
        status: err.response?.status,
        body: err.response?.data,
      });
      throw new Error(
        `Telegram sendMessage failed (${err.response?.status}): ${JSON.stringify(err.response?.data)}`,
      );
    }
  }

  private splitMessage(message: string): string[] {
    if (message.length <= MAX_LENGTH) return [message];

    const parts: string[] = [];
    const paragraphs = message.split(/\n{2,}/);
    let current = '';

    for (const paragraph of paragraphs) {
      const candidate = current === '' ? paragraph : current + '\n\n' + paragraph;

      if (candidate.length <= MAX_LENGTH) {
        current = candidate;
      } else {
        if (current !== '') parts.push(current);
        if (paragraph.length > MAX_LENGTH) {
          for (let i = 0; i < paragraph.length; i += MAX_LENGTH) {
            parts.push(paragraph.slice(i, i + MAX_LENGTH));
          }
          current = '';
        } else {
          current = paragraph;
        }
      }
    }

    if (current !== '') parts.push(current);
    return parts;
  }
}

function convertMarkdownTables(text: string): string {
  const lines = text.split('\n');
  const result: string[] = [];
  let tableLines: string[] = [];

  const flushTable = () => {
    if (tableLines.length === 0) return;
    result.push(renderTable(tableLines));
    tableLines = [];
  };

  for (const line of lines) {
    if (/^\|.+\|$/.test(line.trim())) {
      tableLines.push(line);
    } else {
      flushTable();
      result.push(line);
    }
  }
  flushTable();

  return result.join('\n');
}

function renderTable(lines: string[]): string {
  const dataLines = lines.filter(l => !/^\|[-:\s|]+\|$/.test(l.trim()));
  if (dataLines.length < 2) return lines.join('\n');

  const rows = dataLines.map(line =>
    line.split('|').slice(1, -1).map(cell => cell.trim())
  );
  const [header, ...dataRows] = rows;
  if (!header || dataRows.length === 0) return lines.join('\n');

  const isPriceLevels =
    (header[0]?.toLowerCase() ?? '').includes('loại') &&
    (header[1]?.toLowerCase() ?? '').includes('giá');

  return isPriceLevels
    ? formatPriceLevelsTable(dataRows)
    : formatGenericTable(header, dataRows);
}

function formatPriceLevelsTable(rows: string[][]): string {
  const rendered = rows.map(cols => {
    const type  = cols[0] ?? '';
    const price = cols[1] ?? '';
    const frame = cols[2] ?? '';
    const note  = cols[3] ?? '';
    if (!type || !price) return '';

    const emoji    = priceLevelEmoji(type);
    const frameStr = frame && frame !== '-' ? ` <i>(${frame})</i>` : '';
    const noteStr  = note ? ` — <i>${note}</i>` : '';
    return `${emoji} <b>${type}:</b> <code>${price}</code>${frameStr}${noteStr}`;
  }).filter(Boolean);

  return rendered.join('\n');
}

function priceLevelEmoji(type: string): string {
  const t = type.toLowerCase();
  if (t.includes('kháng cự') && t.includes('mạnh')) return '🔴';
  if (t.includes('kháng cự'))                        return '🟠';
  if (t.includes('giá hiện tại'))                    return '💵';
  if (t.includes('hỗ trợ') && t.includes('mạnh'))   return '🟢';
  if (t.includes('hỗ trợ'))                          return '🟡';
  if (/pwh|pwl|pdh|pdl/.test(t))                    return '📅';
  if (t.includes('số tròn'))                         return '🔢';
  if (t.includes('fvg'))                             return '📐';
  if (t.includes('buy'))                             return '🟢';
  if (t.includes('sell'))                            return '🔴';
  return '◦';
}

function formatGenericTable(header: string[], rows: string[][]): string {
  const headerLine = header.filter(Boolean).length > 0
    ? `<b>${header.filter(Boolean).join(' │ ')}</b>\n`
    : '';
  const dataLines = rows
    .map(cols => '  • ' + cols.filter(Boolean).join(' │ '))
    .join('\n');
  return headerLine + dataLines;
}

function keyLevelEmoji(type?: string): string {
  if (type === 'resistance') return '🔴';
  if (type === 'support')    return '🟢';
  return '◦';
}

function htmlEscape(str: string): string {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function markdownToHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/^#{1,4}\s+(.+)$/gm, '<b>$1</b>')   // ## heading
    .replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>')   // **bold**
    .replace(/\*([^*\n]+)\*/g, '<i>$1</i>')        // *italic*
    .replace(/^[ \t]*[-•*]\s+(.+)$/gm, '  • $1'); // bullet
}

function formatPrice(n: number, decimals: number): string {
  return n.toLocaleString('en-US', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}

function formatDate(d: Date): string {
  const parts = new Intl.DateTimeFormat('en-GB', {
    day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
    hour12: false, timeZone: 'Asia/Ho_Chi_Minh',
  }).formatToParts(d);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  return `${get('day')}/${get('month')}/${get('year')} ${get('hour')}:${get('minute')}`;
}

function toNum(val: unknown): number {
  if (typeof val === 'number') return val;
  if (val && typeof (val as any).toNumber === 'function') return (val as any).toNumber();
  return parseFloat(String(val));
}
