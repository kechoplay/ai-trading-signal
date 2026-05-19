import 'dotenv/config';
import express from 'express';
import path from 'path';
import { prisma } from './db';
import { logger } from './logger';

const PORT = process.env.PORT ?? 3000;
const app = express();

app.use(express.static(path.join(__dirname, '..', 'public')));

app.get('/api/signals', async (req, res) => {
  try {
    const limit = Math.min(parseInt(String(req.query.limit ?? '20'), 10), 100);
    const signals = await prisma.tradingSignal.findMany({
      orderBy: { created_at: 'desc' },
      take: limit,
    });
    res.json(signals.map(parseSignal));
  } catch (err: any) {
    logger.error('GET /api/signals failed', { error: err.message });
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/api/signals/latest', async (_req, res) => {
  try {
    const signal = await prisma.tradingSignal.findFirst({
      orderBy: { created_at: 'desc' },
    });
    if (!signal) return res.status(404).json({ error: 'No signals found' });
    res.json(parseSignal(signal));
  } catch (err: any) {
    logger.error('GET /api/signals/latest failed', { error: err.message });
    res.status(500).json({ error: 'Internal server error' });
  }
});

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

app.listen(PORT, () => {
  logger.info(`Dashboard running at http://localhost:${PORT}`);
});
