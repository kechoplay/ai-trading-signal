import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { makeMarketDataProvider } from './services/market/MarketDataProviderFactory';
import { AnalysisBusyError, runAnalysis } from './services/AnalysisRunner';
import { config } from './config/trading';
import { prisma } from './db';

// Phải trùng tên khung mà provider hiểu (TIMEFRAME_MAP: khung ngày là 'D', không phải 'D1').
const MCP_TIMEFRAMES = ['M5', 'M15', 'H1', 'H4', 'D'] as const;
type McpTimeframe = typeof MCP_TIMEFRAMES[number];

export function createMcpServer(): McpServer {
  const server = new McpServer({
    name: 'ai-trading-signal',
    version: '1.0.0',
  });

  // ── Tool: get_market_data ───────────────────────────────────────────────────
  server.tool(
    'get_market_data',
    'Lấy dữ liệu nến OHLCV cho cặp tiền tệ theo nhiều khung thời gian. Dùng tool này để lấy dữ liệu thô rồi tự phân tích mà không cần API key.',
    {
      symbol:     z.string().optional().describe('Cặp tiền tệ, vd: "XAU/USD". Mặc định theo cấu hình server.'),
      timeframes: z.array(z.enum(MCP_TIMEFRAMES)).optional()
                    .describe('Danh sách khung thời gian. Mặc định: ["M5","M15","H1"].'),
      count:      z.number().int().min(10).max(500).optional()
                    .describe('Số nến mỗi khung. Mặc định: 100.'),
    },
    async ({ symbol, timeframes, count }) => {
      const instrument  = symbol     ?? config.instrument;
      const tfs         = timeframes ?? (config.timeframes as McpTimeframe[]);
      const candleCount = count      ?? 100;

      const provider = makeMarketDataProvider();
      const result: Record<string, unknown[]> = {};

      for (const tf of tfs) {
        const candles = await provider.fetchCandles(instrument, tf, candleCount);
        result[tf] = candles.map(c => c.toArray());
      }

      const currentPrice = await provider.fetchCurrentPrice(instrument);

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            instrument,
            current_price: currentPrice,
            candles_by_timeframe: result,
            fetched_at: new Date().toISOString(),
          }, null, 2),
        }],
      };
    },
  );

  // ── Tool: get_current_price ─────────────────────────────────────────────────
  server.tool(
    'get_current_price',
    'Lấy giá hiện tại của một cặp tiền tệ.',
    {
      symbol: z.string().optional().describe('Cặp tiền tệ. Mặc định: XAU/USD.'),
    },
    async ({ symbol }) => {
      const instrument = symbol ?? config.instrument;
      const provider   = makeMarketDataProvider();
      const price      = await provider.fetchCurrentPrice(instrument);

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({ instrument, price, fetched_at: new Date().toISOString() }),
        }],
      };
    },
  );

  // ── Tool: get_signals_today ─────────────────────────────────────────────────
  server.tool(
    'get_signals_today',
    'Lấy danh sách tín hiệu giao dịch đã lưu trong ngày hôm nay (giờ Việt Nam).',
    {
      symbol: z.string().optional().describe('Lọc theo cặp tiền tệ. Để trống = tất cả.'),
      limit:  z.number().int().min(1).max(50).optional().describe('Số bản ghi tối đa. Mặc định: 10.'),
    },
    async ({ symbol, limit }) => {
      const now     = new Date();
      const offset  = 7 * 60 * 60 * 1000;
      const todayVn = new Date(Math.floor((now.getTime() + offset) / 86400000) * 86400000 - offset);

      const signals = await prisma.tradingSignal.findMany({
        where: {
          created_at: { gte: todayVn },
          ...(symbol ? { instrument: symbol } : {}),
        },
        orderBy: { created_at: 'desc' },
        take: limit ?? 10,
        select: {
          id: true, instrument: true, action: true, timeframe: true,
          entry: true, stop_loss: true, take_profit: true, risk_reward: true,
          confidence: true, current_price: true, trend_bias: true,
          reasoning: true, created_at: true,
        },
      });

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({ date: todayVn.toISOString().slice(0, 10), signals }, null, 2),
        }],
      };
    },
  );

  // ── Tool: run_full_analysis ─────────────────────────────────────────────────
  server.tool(
    'run_full_analysis',
    'Chạy phân tích kỹ thuật đầy đủ bằng AI server (~3 phút). Kết quả được lưu DB và gửi Telegram. '
      + 'Chỉ chạy một lượt mỗi lúc — đang có lượt khác (scheduler/watcher/bấm tay) thì trả lỗi, thử lại sau.',
    {
      symbol:     z.string().optional().describe('Cặp tiền tệ. Mặc định: XAU/USD.'),
      timeframes: z.array(z.enum(MCP_TIMEFRAMES)).optional()
                    .describe('Khung thời gian phân tích. Mặc định theo cấu hình server.'),
    },
    async ({ symbol, timeframes }) => {
      // Qua runAnalysis() như mọi đường trigger khác: lưu DB (carry-forward + dashboard)
      // và single-flight. Thiếu credential (API key hay subscription tùy AI_AUTH_MODE)
      // thì transport tự ném lỗi rõ ràng — không tự kiểm tra ở đây.
      let run;
      try {
        run = await runAnalysis({ symbol, timeframes: timeframes as string[] | undefined, trigger: 'mcp' });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify(err instanceof AnalysisBusyError
              ? { error: message, busy: true }
              : { error: message, hint: 'Có thể dùng get_market_data để lấy dữ liệu và tự phân tích.' }),
          }],
          isError: true,
        };
      }
      const { result, rawText, symbol: sym, currentPrice } = run;

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            instrument: sym, current_price: currentPrice,
            action: result.action, entry: result.entry,
            stop_loss: result.stopLoss, take_profit: result.takeProfit,
            risk_reward: result.riskReward, confidence: result.confidence,
            trend_bias: result.trendBias, reasoning: result.reasoning,
            raw_analysis: rawText,
          }, null, 2),
        }],
      };
    },
  );

  return server;
}
