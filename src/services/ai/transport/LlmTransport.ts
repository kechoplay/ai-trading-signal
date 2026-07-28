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

export interface LlmCompletionResult {
  /** Text đầu ra (đã ghép các text block, bỏ thinking). Parser regex xử lý tiếp. */
  text: string;
  /** Thông tin phụ để log/debug (usage, block types, subtype…) — không ảnh hưởng parse. */
  meta: Record<string, unknown>;
}

export interface LlmTransport {
  /** Nhãn ngắn để log biết đang chạy đường nào. */
  readonly name: string;
  complete(params: LlmCompletionParams): Promise<LlmCompletionResult>;
}
