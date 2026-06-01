import 'dotenv/config';
import express, { Request, Response, NextFunction } from 'express';
import path from 'path';
import { prisma } from './db';
import { logger } from './logger';
import { config } from './config/trading';
import { SignalOrchestrator } from './services/SignalOrchestrator';
import { TelegramNotifier } from './services/telegram/TelegramNotifier';

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));

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

    await prisma.analysisLog.create({
      data: { symbol: sym, duration_ms: durationMs, setup, reasoning },
    });

    res.json({ ok: true, symbol: sym, duration_ms: durationMs, setup, reasoning });
  } catch (err: any) {
    logger.error('POST /api/analyze failed', { error: err.message, duration_ms: Date.now() - startedAt });
    res.status(500).json({ error: err.message ?? 'Analysis failed' });
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

// ─── Analysis logs by symbol ───────────────────────────────────────────────────

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
  const now = new Date();
  const vnMidnight = new Date(now.toLocaleDateString('en-CA', { timeZone: 'Asia/Ho_Chi_Minh' }) + 'T00:00:00+07:00');
  return vnMidnight;
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

const { port } = config.server;
app.listen(port, () => {
  logger.info(`Dashboard running at http://localhost:${port}`);
});
