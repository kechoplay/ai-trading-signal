import { config } from '../../../config/trading';
import { LlmTransport, LlmCompletionParams, LlmCompletionResult } from './LlmTransport';

/**
 * Đường xác thực bằng SUBSCRIPTION Claude (Pro/Max) qua Claude Agent SDK
 * (`@anthropic-ai/claude-agent-sdk`), xác thực bằng CLAUDE_CODE_OAUTH_TOKEN sinh từ
 * lệnh `claude setup-token`. KHÔNG dùng CLAUDE_API_KEY, không tính phí theo token —
 * tiêu quota subscription (giới hạn cửa sổ 5h + trần tuần).
 *
 * Agent SDK vốn là agent harness (có tool Read/Write/Bash…). Ở đây ta chỉ cần MỘT
 * completion văn bản duy nhất, nên tắt hết tool + maxTurns=1 + system prompt custom
 * để nó hành xử như single-shot — giữ nguyên prompt & parser của ClaudeAnalystService.
 *
 * Import ĐỘNG qua biến specifier để:
 *  - tsc không hard-fail khi package chưa cài (chỉ cần khi chạy AI_AUTH_MODE=subscription);
 *  - đường API key vẫn build/chạy bình thường nếu không dùng subscription.
 */
const AGENT_SDK = '@anthropic-ai/claude-agent-sdk';

// Built-in tool của Claude Code — chặn hết để chắc chắn không có side effect (đọc/ghi
// file, chạy bash…). Ta chỉ cần văn bản phân tích.
const BLOCKED_TOOLS = [
  'Bash', 'Read', 'Write', 'Edit', 'MultiEdit', 'Glob', 'Grep',
  'WebFetch', 'WebSearch', 'Task', 'TodoWrite', 'NotebookEdit',
];

export class ClaudeSubscriptionTransport implements LlmTransport {
  readonly name = 'claude-subscription';

  async complete(params: LlmCompletionParams): Promise<LlmCompletionResult> {
    const token = config.claude.oauthToken || process.env.CLAUDE_CODE_OAUTH_TOKEN;
    if (!token) {
      throw new Error(
        'CLAUDE_CODE_OAUTH_TOKEN chưa được cấu hình. Chạy `claude setup-token` để sinh token subscription.',
      );
    }

    // Biến specifier → TypeScript không kiểm tra module tồn tại lúc compile.
    let sdk: any;
    try {
      sdk = await import(AGENT_SDK);
    } catch {
      throw new Error(
        `Chưa cài '${AGENT_SDK}'. Chạy: npm install ${AGENT_SDK} (bắt buộc cho AI_AUTH_MODE=subscription).`,
      );
    }
    const query = sdk.query as (arg: { prompt: string; options: Record<string, unknown> }) => AsyncIterable<any>;

    const chunks: string[] = [];
    let resultText = '';
    let subtype: string | undefined;
    // Result message của Agent SDK có kèm usage/latency — bóc ra để log (subscription
    // không trả message.usage như Messages API, phải lấy từ đây).
    let usage: unknown;
    let durationMs: number | undefined;
    let numTurns: number | undefined;

    const iterator = query({
      prompt: params.userPrompt,
      options: {
        model:           params.model,
        systemPrompt:    params.system,   // string → THAY THẾ system prompt mặc định của Claude Code
        maxTurns:        1,               // single-shot, không vòng lặp agent
        allowedTools:    [],              // không auto-approve tool nào
        disallowedTools: BLOCKED_TOOLS,
        // Ghìm độ sâu suy luận cho khớp đường API key → kiểm soát latency. Agent SDK
        // hỗ trợ đúng 2 lever như Messages API: thinking adaptive + effort (low..max).
        // KHÔNG dùng maxThinkingTokens (deprecated; trên Sonnet/Opus 4.6+ chỉ còn on/off).
        thinking:        { type: 'adaptive' },
        effort:          params.effort,
        // Chốt chặn cuối: từ chối mọi lời gọi tool dù model có thử.
        canUseTool:      async () => ({ behavior: 'deny', message: 'tools disabled' }),
        // Agent SDK spawn subprocess với env THAY THẾ (không merge) → phải kèm ...process.env
        // để giữ PATH và các biến kế thừa.
        env: { ...process.env, CLAUDE_CODE_OAUTH_TOKEN: token },
      },
    });

    for await (const message of iterator) {
      if (message?.type === 'assistant') {
        // Tùy version SDK: content nằm ở message.message.content hoặc message.content.
        const content = message.message?.content ?? message.content ?? [];
        for (const block of content) {
          if (block?.type === 'text' && typeof block.text === 'string') chunks.push(block.text);
        }
      } else if (message?.type === 'result') {
        subtype = message.subtype;
        if (typeof message.result === 'string') resultText = message.result;
        // duration_ms = tổng thời gian; usage.output_tokens = độ dài (thinking+text)
        // → hai số này giải thích vì sao cùng effort mà latency khác nhau giữa các model.
        usage      = message.usage;
        durationMs = message.duration_ms;
        numTurns   = message.num_turns;
      }
    }

    // Ưu tiên text tích lũy từ assistant (giống pipeline cũ: lọc text block, bỏ thinking).
    // Fallback về result string nếu assistant rỗng.
    const text = chunks.join('') || resultText;
    return { text, meta: { transport: this.name, subtype, durationMs, numTurns, usage } };
  }
}
