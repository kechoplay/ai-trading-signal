import axios from 'axios';
import { TradingSignal } from '@prisma/client';
import { config } from '../../config/trading';
import { logger } from '../../logger';

const MAX_LENGTH = 4000;

export class TelegramNotifier {
  constructor(
    private readonly botToken: string,
    private readonly chatId: string,
    private readonly baseUrl: string,
  ) {}

  static fromConfig(): TelegramNotifier {
    if (!config.telegram.botToken || !config.telegram.chatId) {
      throw new Error('TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID is not configured.');
    }
    return new TelegramNotifier(
      config.telegram.botToken,
      config.telegram.chatId,
      config.telegram.baseUrl,
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

  formatSignal(signal: TradingSignal): string {
    const instrument = htmlEscape(signal.instrument);
    const time = formatDate(signal.created_at) + ' (VN)';

    const actionEmoji =
      signal.action === 'BUY' ? '🟢 BUY' :
      signal.action === 'SELL' ? '🔴 SELL' :
      '⚪ NO TRADE';

    const lines: string[] = [
      `📊 <b>${instrument} — ${actionEmoji}</b>`,
      `🕐 <b>Thời gian:</b> ${time}`,
    ];

    if (signal.current_price != null) {
      lines.push(`💵 <b>Giá hiện tại:</b> ${formatPrice(toNum(signal.current_price), 3)}`);
    }

    if (signal.trend_bias != null) {
      const biasLabel =
        signal.trend_bias.toUpperCase() === 'BULLISH' ? '📈 Tăng' :
        signal.trend_bias.toUpperCase() === 'BEARISH' ? '📉 Giảm' :
        '➖ Trung tính';
      lines.push(`📐 <b>Xu hướng:</b> ${biasLabel}`);
    }

    if (signal.action === 'BUY' || signal.action === 'SELL') {
      lines.push('');
      if (signal.entry != null)
        lines.push(`🎯 <b>Entry:</b> ${formatPrice(toNum(signal.entry), 3)}`);
      if (signal.stop_loss != null)
        lines.push(`🛡 <b>Stop Loss:</b> ${formatPrice(toNum(signal.stop_loss), 3)}`);
      if (signal.take_profit != null)
        lines.push(`💰 <b>Take Profit:</b> ${formatPrice(toNum(signal.take_profit), 3)}`);
      if (signal.risk_reward != null)
        lines.push(`⚖️ <b>R:R</b> = 1:${formatPrice(toNum(signal.risk_reward), 2)}`);
    }

    if (signal.confidence != null) {
      lines.push(`🔎 <b>Độ tin cậy:</b> ${signal.confidence}/100`);
    }

    if (signal.reasoning) {
      lines.push('');
      lines.push('─────────────────────────');
      lines.push(htmlEscape(signal.reasoning));
    }

    lines.push('');
    lines.push('<i>⚠️ Tín hiệu tham khảo từ AI, không phải lời khuyên đầu tư.</i>');

    return lines.join('\n');
  }

  // ─── private ──────────────────────────────────────────────────────────────

  private async sendPart(text: string): Promise<string | null> {
    const url = `${this.baseUrl.replace(/\/$/, '')}/bot${this.botToken}/sendMessage`;

    try {
      const { data } = await axios.post(
        url,
        {
          chat_id: this.chatId,
          text,
          parse_mode: 'HTML',
          disable_web_page_preview: true,
        },
        { timeout: 20_000 },
      );
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

function htmlEscape(str: string): string {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
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
