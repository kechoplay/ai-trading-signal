import Anthropic from '@anthropic-ai/sdk';
import { Agent } from 'undici';
import { LlmTransport, LlmCompletionParams, LlmCompletionResult } from './LlmTransport';

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

    return { text, meta: { blockTypes, usage: message.usage } };
  }
}
