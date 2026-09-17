import 'dotenv/config';
import express, { Request, Response, NextFunction } from 'express';
import axios from 'axios';
import path from 'path';
import { randomUUID } from 'crypto';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { mcpAuthRouter } from '@modelcontextprotocol/sdk/server/auth/router.js';
import { requireBearerAuth } from '@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js';
import { prisma } from './db';
import { logger } from './logger';
import { config } from './config/trading';
import { AnalysisBusyError, runAnalysis } from './services/AnalysisRunner';
import { runSwingAnalysis } from './services/swing/SwingRunner';
import { EXIT_RULES, EXIT_RULE_LABEL, ExitRuleName } from './services/swing/SwingSignalService';
import { TokenUsage } from './services/ai/transport/LlmTransport';
import { lastRateLimitSnapshot, lastRunUsage } from './services/ai/UsageTracker';
import { AnalysisScheduler } from './services/AnalysisScheduler';
import { createMcpServer } from './mcp-server';
import { McpOAuthProvider, createAuthCode } from './services/auth/McpOAuthProvider';

const app = express();
// Khởi tạo sớm để route /api/scheduler tham chiếu được; chỉ .start() sau khi listen.
const scheduler = AnalysisScheduler.fromConfig();
app.use(express.json());
app.use(express.urlencoded({ extended: false }));
app.use(express.static(path.join(__dirname, '..', 'public')));

// ─── MCP OAuth ────────────────────────────────────────────────────────────────
const mcpOAuth = new McpOAuthProvider();
const issuerUrl = new URL(config.server.domain);

app.use(mcpAuthRouter({
  provider:  mcpOAuth,
  issuerUrl,
  resourceName: 'AI Trading Signal MCP',
}));

// Form submission from the login page rendered by provider.authorize()
app.post('/authorize/submit', (req: Request, res: Response) => {
  const { client_id, redirect_uri, code_challenge, state, scopes, password } = req.body ?? {};

  if (!client_id || !redirect_uri || !code_challenge) {
    res.status(400).send('Missing required parameters');
    return;
  }

  // Validate password when API_SERVER_KEY is set
  const required = config.server.apiKey;
  if (required && password !== required) {
    const back = new URL(`${config.server.domain}/authorize`);
    back.searchParams.set('error', '1');
    back.searchParams.set('client_id',      client_id);
    back.searchParams.set('redirect_uri',   redirect_uri);
    back.searchParams.set('code_challenge', code_challenge);
    if (state) back.searchParams.set('state', state);
    res.redirect(back.toString());
    return;
  }

  const code = createAuthCode(
    client_id,
    code_challenge,
    redirect_uri,
    scopes ? String(scopes).split(' ').filter(Boolean) : [],
  );

  const redirectUrl = new URL(redirect_uri);
  redirectUrl.searchParams.set('code', code);
  if (state) redirectUrl.searchParams.set('state', state);
  res.redirect(redirectUrl.toString());
});

function requireApiKey(req: Request, res: Response, next: NextFunction): void {
  const { apiKey } = config.server;
  if (!apiKey) {
    next();
    return;
  }
  const provided =
    req.headers['x-api-key'] ??
    (req.headers['authorization'] ?? '').toString().replace(/^Bearer\s+/i, '');
  if (provided !== apiKey) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }
  next();
}

app.get('/docs', (_req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'docs.html')));

app.get('/chart', (_req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'chart.html')));

app.post('/api/analyze', requireApiKey, async (req, res) => {
  const symbol: string | undefined = req.body?.symbol?.trim() || undefined;
  const timeframes: string[] | undefined = Array.isArray(req.body?.timeframes)
    ? req.body.timeframes.map((t: string) => t.trim()).filter(Boolean)
    : typeof req.body?.timeframes === 'string'
      ? req.body.timeframes.split(',').map((t: string) => t.trim()).filter(Boolean)
      : undefined;

  const startedAt = Date.now();
  try {
    logger.info('POST /api/analyze triggered', { symbol: symbol ?? config.instrument, timeframes: timeframes ?? 'default' });
    const { symbol: sym, durationMs, setup, reasoning, usage, rateLimit } =
      await runAnalysis({ symbol, timeframes, analysisType: 'intraday', trigger: 'api' });

    res.json({
      ok: true, symbol: sym, duration_ms: durationMs, setup, reasoning,
      usage:      usage ? toUsageJson(usage) : null,
      rate_limit: rateLimit,
    });
  } catch (err: any) {
    // Scheduler đang chạy đúng lúc bấm tay → 409 thay vì chạy song song (mỗi lần tốn
    // ~3 phút + quota subscription dùng chung).
    if (err instanceof AnalysisBusyError) {
      logger.warn('POST /api/analyze bị chặn — đang có phân tích chạy', { error: err.message });
      res.status(409).json({ error: err.message });
      return;
    }
    logger.error('POST /api/analyze failed', { error: err.message, duration_ms: Date.now() - startedAt });
    res.status(500).json({ error: err.message ?? 'Analysis failed' });
  }
});

/**
 * Dò điểm BUY/SELL theo từng nhịp nhỏ (zigzag pivot) — cơ học, không gọi Claude nên
 * chạy trong vài ms và KHÔNG tiêu quota. Không đụng single-flight của runAnalysis vì
 * không có gì để tranh chấp (không gọi AI, không ghi trading_signals).
 */
app.get('/api/swing', requireApiKey, async (req, res) => {
  try {
    // `rule` ghi đè luật thoát dùng cho thống kê chính, chỉ trong lần gọi này — tiện để
    // so nhanh ba luật mà không phải sửa .env.
    const rule = typeof req.query.rule === 'string' ? String(req.query.rule).toUpperCase() : '';

    const result = await runSwingAnalysis({
      symbol:    typeof req.query.symbol === 'string' ? req.query.symbol : undefined,
      timeframe: typeof req.query.timeframe === 'string' ? req.query.timeframe : undefined,
      limit:     req.query.limit ? Math.min(parseInt(String(req.query.limit), 10), 100) : undefined,
      notify:    String(req.query.notify ?? '') === 'true',
      exitRule:  (EXIT_RULES as string[]).includes(rule) ? (rule as ExitRuleName) : undefined,
    });
    res.json({
      ok: true, symbol: result.symbol, duration_ms: result.durationMs,
      timeframe: result.report.timeframe, actionable: result.actionable,
      latest: result.report.latest, stats: result.report.stats,
      exit_rules: EXIT_RULE_LABEL,
      signals: result.report.signals, params: result.report.params,
      setup: result.setup, reasoning: result.reasoning,
    });
  } catch (err: any) {
    logger.error('GET /api/swing failed', { error: err?.message ?? String(err) });
    res.status(500).json({ error: err?.message ?? 'Swing analysis failed' });
  }
});

app.get('/api/scheduler', requireApiKey, (_req, res) => {
  res.json(scheduler.status());
});

const SCHEDULER_ENABLED_KEY = 'scheduler_enabled';

app.post('/api/scheduler/toggle', requireApiKey, async (req, res) => {
  const enabled = req.body?.enabled;
  if (typeof enabled !== 'boolean') {
    res.status(400).json({ error: 'enabled (boolean) is required' });
    return;
  }
  try {
    // Ghi DB TRƯỚC — nếu lỗi thì không đổi trạng thái runtime, tránh lệch giữa
    // DB và scheduler đang chạy trong RAM.
    await prisma.setting.upsert({
      where:  { key: SCHEDULER_ENABLED_KEY },
      update: { value: String(enabled) },
      create: { key: SCHEDULER_ENABLED_KEY, value: String(enabled) },
    });
    scheduler.setEnabled(enabled);
    logger.info('Scheduler toggled qua API', { enabled });
    res.json(scheduler.status());
  } catch (err: any) {
    logger.error('POST /api/scheduler/toggle failed', { error: err.message });
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ─── Token usage / hạn mức ────────────────────────────────────────────────────
// Gộp 2 nguồn: tổng token trong ngày (cộng dồn từ analysis_logs) + ảnh chụp hạn mức
// còn lại của lượt gọi gần nhất (header anthropic-ratelimit-*, giữ trong RAM).
app.get('/api/usage', async (_req, res) => {
  try {
    const since = startOfTodayVN();
    const agg = await prisma.analysisLog.aggregate({
      where: { analyzed_at: { gte: since } },
      _sum:  { input_tokens: true, output_tokens: true, cache_read_tokens: true, cache_write_tokens: true },
      _count: { _all: true },
    });

    const last = lastRunUsage();
    res.json({
      today: {
        since:               since.toISOString(),
        runs:                agg._count._all,
        input_tokens:        agg._sum.input_tokens       ?? 0,
        output_tokens:       agg._sum.output_tokens      ?? 0,
        cache_read_tokens:   agg._sum.cache_read_tokens  ?? 0,
        cache_write_tokens:  agg._sum.cache_write_tokens ?? 0,
      },
      last_run: last
        ? { symbol: last.symbol, at: last.at, duration_ms: last.durationMs, usage: last.usage ? toUsageJson(last.usage) : null }
        : null,
      // null khi chạy AI_AUTH_MODE=subscription (Agent SDK không trả header hạn mức).
      rate_limit: lastRateLimitSnapshot(),
      auth_mode:  config.claude.authMode,
    });
  } catch (err: any) {
    logger.error('GET /api/usage failed', { error: err.message });
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ─── Symbols ──────────────────────────────────────────────────────────────────

app.get('/api/symbols', requireApiKey, async (_req, res) => {
  try {
    const symbols = await prisma.symbol.findMany({ orderBy: [{ sort_order: 'asc' }, { favorite: 'desc' }, { name: 'asc' }] as any });
    res.json(symbols);
  } catch (err: any) {
    logger.error('GET /api/symbols failed', { error: err.message });
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/api/symbols', requireApiKey, async (req, res) => {
  const symbol: string = (req.body?.symbol ?? '').trim().toUpperCase();
  const name: string   = (req.body?.name   ?? '').trim();

  if (!symbol || !name) {
    res.status(400).json({ error: 'symbol and name are required' });
    return;
  }

  try {
    // Tự gán sort_order = (max thực tế + 1) để symbol mới nằm cuối danh sách,
    // bỏ qua giá trị mặc định 999 của các bản ghi chưa được sắp.
    let sortOrder: number = Number(req.body?.sort_order);
    if (!Number.isFinite(sortOrder)) {
      const top = await prisma.symbol.aggregate({
        _max:   { sort_order: true },
        where:  { sort_order: { lt: 999 } },
      });
      sortOrder = (top._max.sort_order ?? 0) + 1;
    }

    const created = await prisma.symbol.create({ data: { symbol, name, sort_order: sortOrder } });
    res.status(201).json(created);
  } catch (err: any) {
    if (err.code === 'P2002') {
      res.status(409).json({ error: `Symbol '${symbol}' already exists` });
      return;
    }
    logger.error('POST /api/symbols failed', { error: err.message });
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.delete('/api/symbols/:symbol', requireApiKey, async (req, res) => {
  const symbol = String(req.params.symbol).toUpperCase();
  try {
    await prisma.symbol.delete({ where: { symbol } });
    res.json({ ok: true, deleted: symbol });
  } catch (err: any) {
    if (err.code === 'P2025') {
      res.status(404).json({ error: `Symbol '${symbol}' not found` });
      return;
    }
    logger.error('DELETE /api/symbols failed', { error: err.message });
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.patch('/api/symbols/:symbol/favorite', requireApiKey, async (req, res) => {
  const symbol   = String(req.params.symbol).toUpperCase();
  const favorite = req.body?.favorite !== false;
  try {
    const updated = await prisma.symbol.update({ where: { symbol }, data: { favorite } });
    res.json(updated);
  } catch (err: any) {
    if (err.code === 'P2025') {
      res.status(404).json({ error: `Symbol '${symbol}' not found` });
      return;
    }
    logger.error('PATCH /api/symbols/favorite failed', { error: err.message });
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ─── TradingView symbol search (proxy) ────────────────────────────────────────
// Gõ tên/mã coin → gợi ý từ TradingView. Trả về dạng đã map sang format hệ thống.
app.get('/api/tv/search', requireApiKey, async (req, res) => {
  const q = String(req.query.q ?? '').trim();
  if (!q) { res.json([]); return; }
  try {
    const { data } = await axios.get('https://symbol-search.tradingview.com/symbol_search/', {
      params: { text: q, type: 'crypto', exchange: 'BINANCE', hl: 0, lang: 'en' },
      headers: { Origin: 'https://www.tradingview.com', 'User-Agent': 'Mozilla/5.0' },
      timeout: 8000,
    });

    const strip = (s: string) => String(s ?? '').replace(/<\/?em>/g, '');
    const seen = new Set<string>();
    const out: Array<{ symbol: string; name: string; tvSymbol: string }> = [];

    for (const r of Array.isArray(data) ? data : []) {
      const raw  = strip(r.symbol);                 // vd "SOLUSDT"
      const cur  = strip(r.currency_code);          // vd "USDT"
      if (r.type !== 'spot') continue;
      if (cur !== 'USDT' && cur !== 'USD') continue; // chỉ cặp /USDT hoặc /USD
      const base = raw.replace(/(USDT|USD)$/i, '').toUpperCase();
      if (!base || seen.has(base)) continue;
      seen.add(base);
      out.push({
        symbol:   `${base}/USD`,                    // format nội bộ
        name:     strip(r.description).split(' / ')[0] || base,
        tvSymbol: `${strip(r.prefix) || 'BINANCE'}:${raw}`,
      });
      if (out.length >= 20) break;
    }
    res.json(out);
  } catch (err: any) {
    logger.error('GET /api/tv/search failed', { error: err.message });
    res.status(502).json({ error: 'TradingView search failed' });
  }
});

// ─── Symbol Groups ────────────────────────────────────────────────────────────

app.get('/api/groups', requireApiKey, async (_req, res) => {
  try {
    const groups = await prisma.symbolGroup.findMany({
      orderBy: { name: 'asc' },
      include: { items: { select: { symbol: true } } },
    });
    res.json(groups.map(g => ({ ...g, symbols: g.items.map(i => i.symbol) })));
  } catch (err: any) {
    logger.error('GET /api/groups failed', { error: err.message });
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/api/groups', requireApiKey, async (req, res) => {
  const name: string = (req.body?.name ?? '').trim();
  if (!name) {
    res.status(400).json({ error: 'name is required' });
    return;
  }
  try {
    const created = await prisma.symbolGroup.create({ data: { name } });
    res.status(201).json({ ...created, symbols: [] });
  } catch (err: any) {
    if (err.code === 'P2002') {
      res.status(409).json({ error: `Group '${name}' already exists` });
      return;
    }
    logger.error('POST /api/groups failed', { error: err.message });
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/api/groups/:id', requireApiKey, async (req, res) => {
  const id = parseInt(String(req.params.id), 10);
  if (isNaN(id)) { res.status(400).json({ error: 'Invalid group id' }); return; }
  try {
    const group = await prisma.symbolGroup.findUnique({
      where: { id },
      include: { items: { include: { symbolRef: true } } },
    });
    if (!group) { res.status(404).json({ error: `Group ${id} not found` }); return; }
    res.json({ ...group, symbols: group.items.map(i => i.symbolRef) });
  } catch (err: any) {
    logger.error('GET /api/groups/:id failed', { error: err.message });
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.delete('/api/groups/:id', requireApiKey, async (req, res) => {
  const id = parseInt(String(req.params.id), 10);
  if (isNaN(id)) { res.status(400).json({ error: 'Invalid group id' }); return; }
  try {
    await prisma.symbolGroup.delete({ where: { id } });
    res.json({ ok: true, deleted: id });
  } catch (err: any) {
    if (err.code === 'P2025') { res.status(404).json({ error: `Group ${id} not found` }); return; }
    logger.error('DELETE /api/groups/:id failed', { error: err.message });
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/api/groups/:id/symbols', requireApiKey, async (req, res) => {
  const id     = parseInt(String(req.params.id), 10);
  const symbol = (req.body?.symbol ?? '').trim().toUpperCase();
  if (isNaN(id)) { res.status(400).json({ error: 'Invalid group id' }); return; }
  if (!symbol)   { res.status(400).json({ error: 'symbol is required' }); return; }
  try {
    const item = await prisma.symbolGroupItem.create({ data: { group_id: id, symbol } });
    res.status(201).json(item);
  } catch (err: any) {
    if (err.code === 'P2002') { res.status(409).json({ error: `Symbol '${symbol}' already in group` }); return; }
    if (err.code === 'P2003') { res.status(404).json({ error: `Group ${id} or symbol '${symbol}' not found` }); return; }
    logger.error('POST /api/groups/:id/symbols failed', { error: err.message });
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.delete('/api/groups/:id/symbols/:symbol', requireApiKey, async (req, res) => {
  const id     = parseInt(String(req.params.id), 10);
  const symbol = String(req.params.symbol).toUpperCase();
  if (isNaN(id)) { res.status(400).json({ error: 'Invalid group id' }); return; }
  try {
    await prisma.symbolGroupItem.deleteMany({ where: { group_id: id, symbol } });
    res.json({ ok: true, group_id: id, removed: symbol });
  } catch (err: any) {
    logger.error('DELETE /api/groups/:id/symbols/:symbol failed', { error: err.message });
    res.status(500).json({ error: 'Internal server error' });
  }
});


// ─── Analysis logs by symbol ──────────────────────────────────────────────────

app.get('/api/symbols/:symbol/signals', requireApiKey, async (req, res) => {
  try {
    const symbol = String(req.params.symbol).toUpperCase();
    const limit  = Math.min(parseInt(String(req.query.limit ?? '20'), 10), 100);
    const logs   = await prisma.analysisLog.findMany({
      where:   { symbol, analyzed_at: { gte: startOfTodayVN() } },
      orderBy: { analyzed_at: 'desc' },
      take:    limit,
      select:  {
        id: true, symbol: true, analyzed_at: true, duration_ms: true, setup: true, reasoning: true,
        // Token của lượt phân tích — dashboard hiện ngay trên từng bản ghi tín hiệu.
        input_tokens: true, output_tokens: true, cache_read_tokens: true, cache_write_tokens: true,
      },
    });
    res.json(logs);
  } catch (err: any) {
    logger.error('GET /api/symbols/:symbol/signals failed', { error: err.message });
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ─── Trading signals ──────────────────────────────────────────────────────────

app.get('/api/signals/latest', async (_req, res) => {
  try {
    const signal = await prisma.tradingSignal.findFirst({
      orderBy: { created_at: 'desc' },
    });
    if (!signal) {
      res.status(404).json({ error: 'No signals found' });
      return;
    }
    res.json(parseSignal(signal));
  } catch (err: any) {
    logger.error('GET /api/signals/latest failed', { error: err.message });
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/api/signals', async (req, res) => {
  try {
    const limit = Math.min(parseInt(String(req.query.limit ?? '20'), 10), 100);
    const signals = await prisma.tradingSignal.findMany({
      where:   { created_at: { gte: startOfTodayVN() } },
      orderBy: { created_at: 'desc' },
      take:    limit,
    });
    res.json(signals.map(parseSignal));
  } catch (err: any) {
    logger.error('GET /api/signals failed', { error: err.message });
    res.status(500).json({ error: 'Internal server error' });
  }
});


function startOfTodayVN(): Date {
  const tz = config.marketHours.timezone;
  const now = new Date();
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).formatToParts(now);
  const h = parseInt(parts.find(p => p.type === 'hour')?.value   ?? '0', 10);
  const m = parseInt(parts.find(p => p.type === 'minute')?.value ?? '0', 10);
  const s = parseInt(parts.find(p => p.type === 'second')?.value ?? '0', 10);
  return new Date(now.getTime() - (h * 3600 + m * 60 + s) * 1000 - now.getMilliseconds());
}

/** Đổi TokenUsage (camelCase) sang snake_case cho JSON API, kèm tổng input đã cộng cache. */
function toUsageJson(u: TokenUsage) {
  return {
    input_tokens:       u.inputTokens,
    output_tokens:      u.outputTokens,
    cache_read_tokens:  u.cacheReadTokens,
    cache_write_tokens: u.cacheCreationTokens,
    total_input_tokens: u.inputTokens + u.cacheReadTokens + u.cacheCreationTokens,
  };
}

function parseSignal(signal: any) {
  let structured: Record<string, unknown> = {};
  try {
    const raw = JSON.parse(signal.raw_ai_response ?? '{}');
    structured = {
      market_structure: raw.market_structure ?? null,
      key_levels: raw.key_levels ?? null,
      setups: raw.setups ?? null,
      conditional_setups: raw.conditional_setups ?? null,
    };
  } catch {}

  return { ...signal, ...structured };
}

// ─── MCP (Model Context Protocol) ────────────────────────────────────────────
// Cho phép claude.ai kết nối qua Settings → Integrations → Add custom integration
// URL: https://yourdomain.com/mcp

const mcpTransports = new Map<string, StreamableHTTPServerTransport>();

app.all('/mcp', requireBearerAuth({ verifier: mcpOAuth }), async (req: Request, res: Response) => {
  try {
    const sessionId = req.headers['mcp-session-id'] as string | undefined;

    if (req.method === 'POST' && !sessionId) {
      // Khởi tạo session mới
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
      });
      const mcpServer = createMcpServer();

      transport.onclose = () => {
        if (transport.sessionId) {
          mcpTransports.delete(transport.sessionId);
          logger.info('MCP session closed', { sessionId: transport.sessionId });
        }
      };

      await mcpServer.connect(transport);

      if (transport.sessionId) {
        mcpTransports.set(transport.sessionId, transport);
        logger.info('MCP session created', { sessionId: transport.sessionId });
      }

      await transport.handleRequest(req, res, req.body);
      return;
    }

    if (sessionId) {
      const transport = mcpTransports.get(sessionId);
      if (!transport) {
        res.status(404).json({ jsonrpc: '2.0', error: { code: -32001, message: 'Session not found or expired' } });
        return;
      }
      await transport.handleRequest(req, res, req.body);
      return;
    }

    res.status(400).json({ jsonrpc: '2.0', error: { code: -32600, message: 'Bad request' } });
  } catch (err: any) {
    logger.error('MCP request error', { error: err.message });
    if (!res.headersSent) {
      res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal error' } });
    }
  }
});

// ─── Error handler (cuối cùng) ────────────────────────────────────────────────
// Bắt các lỗi cấp request do client gửi sai, tránh văng stack trace ra log.
app.use((err: any, req: Request, res: Response, next: NextFunction) => {
  // Body JSON sai cú pháp (express.json) → 400
  if (err?.type === 'entity.parse.failed' || err instanceof SyntaxError) {
    logger.warn('Invalid JSON body', { path: req.path, error: err.message });
    if (!res.headersSent) res.status(400).json({ error: 'Invalid JSON body' });
    return;
  }

  // Header Range không hợp lệ khi tải file tĩnh (send) → 416
  if (err?.status === 416 || err?.statusCode === 416 || err?.name === 'RangeNotSatisfiableError') {
    logger.warn('Range not satisfiable', { path: req.path });
    if (!res.headersSent) res.status(416).end();
    return;
  }

  logger.error('Unhandled request error', { path: req.path, error: err?.message });
  if (!res.headersSent) res.status(500).json({ error: 'Internal server error' });
});

const { port } = config.server;
app.listen(port, async () => {
  logger.info(`Dashboard running at http://localhost:${port}`);
  logger.info(`MCP endpoint: http://localhost:${port}/mcp`);

  // DB override SCHEDULER_ENABLED trong .env nếu user đã từng bấm toggle trên dashboard —
  // ưu tiên lựa chọn gần nhất của user hơn giá trị tĩnh trong .env.
  try {
    const saved = await prisma.setting.findUnique({ where: { key: SCHEDULER_ENABLED_KEY } });
    if (saved) scheduler.setEnabled(saved.value === 'true');
    else scheduler.start();
  } catch (err: any) {
    logger.error('Đọc setting scheduler_enabled thất bại — dùng SCHEDULER_ENABLED từ .env', { error: err.message });
    scheduler.start();
  }
});
