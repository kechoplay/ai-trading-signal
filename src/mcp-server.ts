import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { makeMarketDataProvider } from './services/market/MarketDataProviderFactory';
import { SignalOrchestrator } from './services/SignalOrchestrator';
import { config } from './config/trading';
import { prisma } from './db';

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
      timeframes: z.array(z.enum(['M5', 'M15', 'H1', 'H4', 'D1'])).optional()
                    .describe('Danh sách khung thời gian. Mặc định: ["M5","M15","H1"].'),
      count:      z.number().int().min(10).max(500).optional()
                    .describe('Số nến mỗi khung. Mặc định: 100.'),
    },
    async ({ symbol, timeframes, count }) => {
      const instrument  = symbol     ?? config.instrument;
      const tfs         = timeframes ?? (config.timeframes as ('M5' | 'M15' | 'H1' | 'H4' | 'D1')[]);
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
    'Chạy phân tích kỹ thuật đầy đủ bằng AI server (cần CLAUDE_API_KEY). Kết quả được lưu DB và gửi Telegram.',
    {
      symbol:     z.string().optional().describe('Cặp tiền tệ. Mặc định: XAU/USD.'),
      timeframes: z.array(z.enum(['M5', 'M15', 'H1', 'H4', 'D1'])).optional()
                    .describe('Khung thời gian phân tích. Mặc định theo cấu hình server.'),
    },
    async ({ symbol, timeframes }) => {
      if (!config.claude.apiKey) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({ error: 'CLAUDE_API_KEY chưa được cấu hình. Dùng get_market_data để lấy dữ liệu và tự phân tích.' }),
          }],
          isError: true,
        };
      }

      const { result, rawText, instrument: sym, currentPrice } =
        await SignalOrchestrator.fromConfig().run(symbol, timeframes as string[] | undefined);

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
