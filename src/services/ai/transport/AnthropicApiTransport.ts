import Anthropic from '@anthropic-ai/sdk';
import { Agent } from 'undici';
import {
  LlmTransport, LlmCompletionParams, LlmCompletionResult, RateLimitSnapshot, TokenUsage,
} from './LlmTransport';

/**
 * Đường xác thực gốc: gọi Anthropic Messages API bằng CLAUDE_API_KEY, stream adaptive
 * thinking. Toàn bộ logic undici/SDK/stream trước đây nằm trong ClaudeAnalystService
 * được chuyển nguyên vẹn về đây.
 */
export class AnthropicApiTransport implements LlmTransport {
  readonly name = 'anthropic-apikey';
  private readonly client: Anthropic;

  constructor(apiKey: string) {
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
      apiKey,
      maxRetries: 4,
      timeout:    SDK_TIMEOUT,
      fetchOptions: { dispatcher },
    });
  }

  async complete(params: LlmCompletionParams): Promise<LlmCompletionResult> {
    // max_tokens phải đủ lớn cho cả thinking + text response.
    // thinking: adaptive không có budget_tokens → model tự phân bổ từ max_tokens.
    // output_config.effort: vì code đã gánh phần tính toán, hạ effort để cắt latency.
    const stream = this.client.messages.stream({
      model:      params.model,
      max_tokens: params.maxTokens,
      thinking:   { type: 'adaptive' },
      output_config: { effort: params.effort },
      system:     params.system,
      messages:   [{ role: 'user', content: params.userPrompt }],
    });

    const message = await stream.finalMessage();

    const blockTypes = message.content.map((b) => b.type);
    const text = message.content
      .filter((b): b is Anthropic.TextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('');

    // Hạn mức còn lại nằm ở header HTTP, KHÔNG có trong body message → phải lấy từ
    // Response gốc. `stream.response` là response của lần kết nối cuối (sau retry).
    const rateLimit = parseRateLimit(stream.response ?? null);

    const usage: TokenUsage = {
      inputTokens:         message.usage.input_tokens ?? 0,
      outputTokens:        message.usage.output_tokens ?? 0,
      cacheReadTokens:     message.usage.cache_read_input_tokens ?? 0,
      cacheCreationTokens: message.usage.cache_creation_input_tokens ?? 0,
    };

    return { text, meta: { blockTypes, usage: message.usage, rateLimit }, usage, rateLimit };
  }
}

/** Đọc bộ header `anthropic-ratelimit-*`; trả null nếu không có response/header. */
function parseRateLimit(response: Response | null): RateLimitSnapshot | null {
  const h = response?.headers;
  if (!h) return null;

  const num = (name: string): number | null => {
    const raw = h.get(name);
    if (raw == null || raw === '') return null;
    const v = Number(raw);
    return Number.isFinite(v) ? v : null;
  };
  const str = (name: string): string | null => h.get(name) || null;

  const snapshot: RateLimitSnapshot = {
    requestsLimit:         num('anthropic-ratelimit-requests-limit'),
    requestsRemaining:     num('anthropic-ratelimit-requests-remaining'),
    requestsReset:         str('anthropic-ratelimit-requests-reset'),
    inputTokensLimit:      num('anthropic-ratelimit-input-tokens-limit'),
    inputTokensRemaining:  num('anthropic-ratelimit-input-tokens-remaining'),
    inputTokensReset:      str('anthropic-ratelimit-input-tokens-reset'),
    outputTokensLimit:     num('anthropic-ratelimit-output-tokens-limit'),
    outputTokensRemaining: num('anthropic-ratelimit-output-tokens-remaining'),
    outputTokensReset:     str('anthropic-ratelimit-output-tokens-reset'),
    tokensLimit:           num('anthropic-ratelimit-tokens-limit'),
    tokensRemaining:       num('anthropic-ratelimit-tokens-remaining'),
    tokensReset:           str('anthropic-ratelimit-tokens-reset'),
    retryAfterSec:         num('retry-after'),
    capturedAt:            new Date().toISOString(),
  };

  // Không có header nào → coi như không đo được (tránh hiển thị hàng loạt "—").
  const hasAny = Object.entries(snapshot).some(([k, v]) => k !== 'capturedAt' && v != null);
  return hasAny ? snapshot : null;
}
