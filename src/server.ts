import 'dotenv/config';
import express, { Request, Response, NextFunction } from 'express';
import path from 'path';
import { randomUUID } from 'crypto';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { mcpAuthRouter } from '@modelcontextprotocol/sdk/server/auth/router.js';
import { requireBearerAuth } from '@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js';
import { prisma } from './db';
import { logger } from './logger';
import { config } from './config/trading';
import { SignalOrchestrator } from './services/SignalOrchestrator';
import { makeMarketDataProvider } from './services/market/MarketDataProviderFactory';
import { LongTermAnalystService } from './services/ai/LongTermAnalystService';
import { TelegramNotifier } from './services/telegram/TelegramNotifier';
import { createMcpServer } from './mcp-server';
import { McpOAuthProvider, createAuthCode } from './services/auth/McpOAuthProvider';

const app = express();
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
    const { result, rawText, instrument: sym, currentPrice } = await SignalOrchestrator.fromConfig().run(symbol, timeframes);
    const durationMs = Date.now() - startedAt;

    const notifier = TelegramNotifier.fromConfig();
    const setup     = notifier.formatSignalCard(result, sym, currentPrice);
    const reasoning = notifier.formatAnalysis(rawText);

    await prisma.$transaction([
      prisma.tradingSignal.create({
        data: {
          instrument:      sym,
          action:          result.action,
          timeframe:       (timeframes ?? config.timeframes)[0] ?? null,
          analysis_type:   'intraday',
          entry:           result.entry,
          stop_loss:       result.stopLoss,
          take_profit:     result.takeProfit,
          risk_reward:     result.riskReward,
          confidence:      result.confidence,
          current_price:   currentPrice,
          reasoning:       result.reasoning,
          trend_bias:      result.trendBias,
          raw_ai_response: JSON.stringify(result.raw ?? {}),
          analyze_at:      new Date(startedAt),
        },
      }),
      prisma.analysisLog.create({
        data: { symbol: sym, duration_ms: durationMs, setup, reasoning },
      }),
    ]);

    res.json({ ok: true, symbol: sym, duration_ms: durationMs, setup, reasoning });
  } catch (err: any) {
    logger.error('POST /api/analyze failed', { error: err.message, duration_ms: Date.now() - startedAt });
    res.status(500).json({ error: err.message ?? 'Analysis failed' });
  }
});

app.post('/api/analyze/longterm', requireApiKey, async (req, res) => {
  const symbol: string | undefined = req.body?.symbol?.trim() || undefined;
  const timeframes: string[] | undefined = Array.isArray(req.body?.timeframes)
    ? req.body.timeframes.map((t: string) => t.trim()).filter(Boolean)
    : typeof req.body?.timeframes === 'string'
      ? req.body.timeframes.split(',').map((t: string) => t.trim()).filter(Boolean)
      : undefined;

  const resolvedTimeframes = (timeframes && timeframes.length > 0)
    ? timeframes
    : config.longtermTimeframes;

  const startedAt = Date.now();
  try {
    logger.info('POST /api/analyze/longterm triggered', { symbol: symbol ?? config.instrument, timeframes: resolvedTimeframes });

    const orchestrator = new SignalOrchestrator(
      makeMarketDataProvider(),
      LongTermAnalystService.fromConfig(),
      TelegramNotifier.fromConfig(),
    );
    const { result, rawText, instrument: sym, currentPrice } = await orchestrator.run(symbol, resolvedTimeframes);
    const durationMs = Date.now() - startedAt;

    const notifier = TelegramNotifier.fromConfig();
    const setup     = notifier.formatSignalCard(result, sym, currentPrice);
    const reasoning = notifier.formatAnalysis(rawText);

    await prisma.tradingSignal.create({
      data: {
        instrument:      sym,
        action:          result.action,
        timeframe:       resolvedTimeframes[0] ?? null,
        analysis_type:   'longterm',
        entry:           result.entry,
        stop_loss:       result.stopLoss,
        take_profit:     result.takeProfit,
        risk_reward:     result.riskReward,
        confidence:      result.confidence,
        current_price:   currentPrice,
        reasoning:       result.reasoning,
        trend_bias:      result.trendBias,
        raw_ai_response: JSON.stringify(result.raw ?? {}),
        analyze_at:      new Date(startedAt),
      },
    });

    await prisma.analysisLog.create({
      data: { symbol: sym, duration_ms: durationMs, setup, reasoning, analysis_type: 'longterm' },
    });

    res.json({ ok: true, symbol: sym, timeframes: resolvedTimeframes, duration_ms: durationMs, setup, reasoning });
  } catch (err: any) {
    logger.error('POST /api/analyze/longterm failed', { error: err.message, duration_ms: Date.now() - startedAt });
    res.status(500).json({ error: err.message ?? 'Long-term analysis failed' });
  }
});

// ─── Symbols ──────────────────────────────────────────────────────────────────

app.get('/api/symbols', requireApiKey, async (_req, res) => {
  try {
    const symbols = await prisma.symbol.findMany({ orderBy: [{ favorite: 'desc' }, { name: 'asc' }] as any });
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
    const created = await prisma.symbol.create({ data: { symbol, name } });
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
      select:  { id: true, symbol: true, analyzed_at: true, duration_ms: true, setup: true, reasoning: true },
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

function parseSignal(signal: any) {
  let structured: Record<string, unknown> = {};
  try {
    const raw = JSON.parse(signal.raw_ai_response ?? '{}');
    structured = {
      market_structure: raw.market_structure ?? null,
      key_levels: raw.key_levels ?? null,
      setups: raw.setups ?? null,
    };
  } catch {}

  return { ...signal, ...structured };
}

// ─── Long-term data endpoints ────────────────────────────────────────────────

app.get('/longterm', (_req, res) =>
  res.sendFile(path.join(__dirname, '..', 'public', 'longterm.html')),
);

app.get('/api/longterm/latest', async (_req, res) => {
  try {
    const signal = await prisma.tradingSignal.findFirst({
      where:   { analysis_type: 'longterm' },
      orderBy: { created_at: 'desc' },
    });
    const log = await prisma.analysisLog.findFirst({
      where:   { analysis_type: 'longterm' },
      orderBy: { analyzed_at: 'desc' },
      select:  { setup: true, reasoning: true, analyzed_at: true, duration_ms: true },
    });
    if (!signal) {
      res.status(404).json({ error: 'No long-term signals found' });
      return;
    }
    res.json({ ...parseSignal(signal), setup: log?.setup ?? null, reasoning_html: log?.reasoning ?? null, analyzed_at: log?.analyzed_at ?? signal.created_at, duration_ms: log?.duration_ms ?? null });
  } catch (err: any) {
    logger.error('GET /api/longterm/latest failed', { error: err.message });
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/api/longterm/history', async (req, res) => {
  try {
    const limit = Math.min(parseInt(String(req.query.limit ?? '20'), 10), 100);
    const signals = await prisma.tradingSignal.findMany({
      where:   { analysis_type: 'longterm' },
      orderBy: { created_at: 'desc' },
      take:    limit,
    });
    res.json(signals.map(parseSignal));
  } catch (err: any) {
    logger.error('GET /api/longterm/history failed', { error: err.message });
    res.status(500).json({ error: 'Internal server error' });
  }
});

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
app.listen(port, () => {
  logger.info(`Dashboard running at http://localhost:${port}`);
  logger.info(`MCP endpoint: http://localhost:${port}/mcp`);
});
