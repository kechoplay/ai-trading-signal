/**
 * Lớp trừu tượng "gọi LLM → nhận text". Tách khỏi ClaudeAnalystService để cùng một
 * pipeline (build prompt + parse regex) chạy được trên nhiều cách xác thực:
 *  - AnthropicApiTransport      : dùng CLAUDE_API_KEY (tính phí theo token).
 *  - ClaudeSubscriptionTransport: dùng subscription Pro/Max qua Claude Agent SDK
 *    (CLAUDE_CODE_OAUTH_TOKEN từ `claude setup-token`).
 * Chọn transport nào do config.claude.authMode quyết định (xem resolveTransport()).
 */
export type Effort = 'low' | 'medium' | 'high' | 'max';

export interface LlmCompletionParams {
  model: string;
  system: string;
  userPrompt: string;
  maxTokens: number;
  effort: Effort;
}

/** Token tiêu thụ của MỘT lượt gọi LLM (đã chuẩn hoá giữa API key và subscription). */
export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  /** Token đọc lại từ prompt cache (rẻ ~10%) — 0 nếu không cache. */
  cacheReadTokens: number;
  /** Token ghi vào prompt cache (đắt ~125%) — 0 nếu không cache. */
  cacheCreationTokens: number;
}

/**
 * Hạn mức còn lại đọc từ header `anthropic-ratelimit-*` của Messages API.
 * CHỈ có ở đường API key — subscription (Agent SDK) không trả header này nên là null.
 * `*Reset` là mốc ISO do server trả về; `retryAfterSec` chỉ có khi bị 429.
 */
export interface RateLimitSnapshot {
  requestsLimit:      number | null;
  requestsRemaining:  number | null;
  requestsReset:      string | null;
  inputTokensLimit:      number | null;
  inputTokensRemaining:  number | null;
  inputTokensReset:      string | null;
  outputTokensLimit:     number | null;
  outputTokensRemaining: number | null;
  outputTokensReset:     string | null;
  /** Hạn mức token gộp (một số tier chỉ trả header này thay vì tách in/out). */
  tokensLimit:     number | null;
  tokensRemaining: number | null;
  tokensReset:     string | null;
  retryAfterSec:   number | null;
  /** Thời điểm đọc header (ISO) — để dashboard biết số liệu cũ bao lâu. */
  capturedAt: string;
}

export interface LlmCompletionResult {
  /** Text đầu ra (đã ghép các text block, bỏ thinking). Parser regex xử lý tiếp. */
  text: string;
  /** Thông tin phụ để log/debug (usage, block types, subtype…) — không ảnh hưởng parse. */
  meta: Record<string, unknown>;
  /** Token in/out của lượt gọi — null nếu transport không báo cáo. */
  usage: TokenUsage | null;
  /** Hạn mức còn lại lúc gọi — null nếu transport không có (subscription). */
  rateLimit: RateLimitSnapshot | null;
}

export interface LlmTransport {
  /** Nhãn ngắn để log biết đang chạy đường nào. */
  readonly name: string;
  complete(params: LlmCompletionParams): Promise<LlmCompletionResult>;
}
