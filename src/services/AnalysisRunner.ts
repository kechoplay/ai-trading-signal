import { SignalOrchestrator } from './SignalOrchestrator';
import { TelegramNotifier } from './telegram/TelegramNotifier';
import { RateLimitSnapshot, TokenUsage } from './ai/transport/LlmTransport';
import { recordUsage } from './ai/UsageTracker';
import { config } from '../config/trading';
import { logger } from '../logger';
import { prisma } from '../db';

export interface AnalysisRunResult {
  symbol: string;
  action: string;
  durationMs: number;
  setup: string;
  reasoning: string;
  usage: TokenUsage | null;
  rateLimit: RateLimitSnapshot | null;
}

export interface AnalysisRunOptions {
  symbol?: string;
  timeframes?: string[];
  analysisType?: string;
  /** Nguồn kích hoạt — chỉ để log phân biệt 'api' (bấm tay) với 'scheduler'. */
  trigger: 'api' | 'scheduler' | 'mcp';
}

/** Ném ra khi đã có một phân tích đang chạy (xem single-flight bên dưới). */
export class AnalysisBusyError extends Error {
  constructor(readonly runningSymbol: string, readonly elapsedSec: number) {
    super(`Đang phân tích ${runningSymbol} (${elapsedSec}s) — chờ xong rồi thử lại.`);
    this.name = 'AnalysisBusyError';
  }
}

// Single-flight: một lần phân tích mất ~3 phút (Opus 5 effort=high) và tiêu quota
// subscription dùng chung với cả session code. Scheduler (mỗi 15 phút) và nút bấm tay
// trên dashboard có thể trùng nhau → chốt lại để không bao giờ có 2 lần chạy song song.
let inFlight: { symbol: string; startedAt: number; trigger: string } | null = null;

/** Thông tin lần chạy đang diễn ra (null nếu rảnh) — dùng cho /api/scheduler. */
export function currentRun(): { symbol: string; startedAt: number; trigger: string } | null {
  return inFlight;
}

/**
 * Chạy pipeline phân tích rồi lưu DB — đường duy nhất được cả REST API và scheduler
 * dùng. Trước đây phần persist nằm trong route handler nên scheduler gọi thẳng
 * SignalOrchestrator sẽ gửi Telegram mà KHÔNG lưu bản ghi → carry-forward
 * (loadPendingSetup đọc từ DB) và dashboard đều mất dữ liệu.
 */
export async function runAnalysis(opts: AnalysisRunOptions): Promise<AnalysisRunResult> {
  const { symbol, timeframes, analysisType = 'intraday', trigger } = opts;
  const requested = symbol ?? config.instrument;

  if (inFlight) {
    throw new AnalysisBusyError(inFlight.symbol, Math.round((Date.now() - inFlight.startedAt) / 1000));
  }

  const startedAt = Date.now();
  inFlight = { symbol: requested, startedAt, trigger };
  try {
    logger.info('Analysis started', { symbol: requested, timeframes: timeframes ?? 'default', analysisType, trigger });

    const { result, rawText, instrument: sym, currentPrice, usage, rateLimit } =
      await SignalOrchestrator.fromConfig().run(symbol, timeframes, analysisType);
    const durationMs = Date.now() - startedAt;

    const notifier  = TelegramNotifier.fromConfig();
    const setup     = notifier.formatSignalCard(result, sym, currentPrice);
    const reasoning = notifier.formatAnalysis(rawText);

    await prisma.$transaction([
      prisma.tradingSignal.create({
        data: {
          instrument:      sym,
          action:          result.action,
          timeframe:       (timeframes ?? config.timeframes)[0] ?? null,
          analysis_type:   analysisType,
          entry:           result.entry,
          stop_loss:       result.stopLoss,
          take_profit:     result.takeProfit,
          risk_reward:     result.riskReward,
          confidence:      result.confidence,
          current_price:   currentPrice,
          reasoning:       result.reasoning,
          trend_bias:      result.trendBias,
          raw_ai_response: JSON.stringify({ ...(result.raw ?? {}), conditional_setups: result.conditionalSetups }),
          analyze_at:      new Date(startedAt),
        },
      }),
      prisma.analysisLog.create({
        data: {
          symbol: sym, duration_ms: durationMs, setup, reasoning,
          input_tokens:       usage?.inputTokens         ?? null,
          output_tokens:      usage?.outputTokens        ?? null,
          cache_read_tokens:  usage?.cacheReadTokens     ?? null,
          cache_write_tokens: usage?.cacheCreationTokens ?? null,
        },
      }),
    ]);

    // Ảnh chụp hạn mức + token lượt gần nhất cho /api/usage (không lưu DB — xem UsageTracker).
    recordUsage({ symbol: sym, at: new Date().toISOString(), durationMs, usage }, rateLimit);

    logger.info('Analysis finished', {
      symbol: sym, action: result.action, duration_ms: durationMs, trigger,
      input_tokens: usage?.inputTokens ?? null, output_tokens: usage?.outputTokens ?? null,
      input_tokens_remaining:  rateLimit?.inputTokensRemaining  ?? null,
      output_tokens_remaining: rateLimit?.outputTokensRemaining ?? null,
    });
    return { symbol: sym, action: result.action, durationMs, setup, reasoning, usage, rateLimit };
  } finally {
    inFlight = null;
  }
}
