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
import { SetupWatcher } from './services/setup/SetupWatcher';
import { DailyPlanScheduler } from './services/DailyPlanScheduler';
import { DAILY_PLAN } from './services/SignalOrchestrator';
import { createMcpServer } from './mcp-server';
import { McpOAuthProvider, createAuthCode } from './services/auth/McpOAuthProvider';
import { FailureLimiter, safeEqual } from './services/auth/security';
import { SignalOutcomeTracker } from './services/outcome/SignalOutcomeTracker';
import { confidenceBand, dedupeSetups, groupBy, summarize } from './services/outcome/outcomeStats';

const app = express();
// Khởi tạo sớm để route /api/scheduler tham chiếu được; chỉ .start() sau khi listen.
const scheduler = AnalysisScheduler.fromConfig();
// Kích hoạt phân tích theo sự kiện (sweep → BOS/CHoCH → retest) — xem SetupWatcher.ts.
const setupWatcher = SetupWatcher.fromConfig();
// Kế hoạch ngày (vàng + BTC/ETH) theo mốc giờ (mặc định 7h/11h/15h/19h T2–T6) — xem DailyPlanScheduler.ts.
const dailyPlanScheduler = DailyPlanScheduler.fromConfig();
// Chấm kết quả thật của tín hiệu BUY/SELL (khớp entry? TP1 hay SL trước?) — xem SignalOutcomeTracker.ts.
const outcomeTracker = SignalOutcomeTracker.fromConfig();
// Sau reverse proxy thì req.ip mới là IP client thật (rate-limit /authorize/submit dựa vào đó).
if (config.server.trustProxy !== undefined) app.set('trust proxy', config.server.trustProxy);
const authorizeLimiter = new FailureLimiter(
  config.server.authorizeMaxFailures,
  config.server.authorizeWindowMin * 60_000,
);
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

  const ip = req.ip ?? 'unknown';
  const waitSec = authorizeLimiter.retryAfterSec(ip);
  if (waitSec > 0) {
    logger.warn('/authorize/submit bị chặn — thử sai quá nhiều', { ip, retry_after_sec: waitSec });
    res.set('Retry-After', String(waitSec));
    res.status(429).send(`Thử sai quá nhiều lần. Vui lòng thử lại sau ${Math.ceil(waitSec / 60)} phút.`);
    return;
  }

  if (!client_id || !redirect_uri || !code_challenge) {
    res.status(400).send('Missing required parameters');
    return;
  }

  // Validate password when API_SERVER_KEY is set
  const required = config.server.apiKey;
  if (required && !safeEqual(password, required)) {
    authorizeLimiter.recordFailure(ip);
    const back = new URL(`${config.server.domain}/authorize`);
    back.searchParams.set('error', '1');
    back.searchParams.set('client_id',      client_id);
    back.searchParams.set('redirect_uri',   redirect_uri);
    back.searchParams.set('code_challenge', code_challenge);
    if (state) back.searchParams.set('state', state);
    res.redirect(back.toString());
    return;
  }
  authorizeLimiter.reset(ip);

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
  if (!safeEqual(provided, apiKey)) {
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

// Trạng thái SetupWatcher: chuỗi sweep → BOS/CHoCH → retest của từng symbol đang ở bước nào,
// lần kích hoạt gần nhất, số lần kích hoạt trong ngày.
app.get('/api/setup-watcher', requireApiKey, (_req, res) => {
  res.json(setupWatcher.status());
});

// Lịch sử watcher trong một ngày (giờ VN), mới nhất trước: các lần đổi bước (`events`) +
// mọi lần dò (`ticks`). Query: ?date=YYYY-MM-DD (mặc định hôm nay) &symbol=XAU/USD &limit=N
// (mặc định = trần 5000, tức trả hết cả ngày).
app.get('/api/setup-watcher/history', requireApiKey, async (req, res) => {
  try {
    const symbol = typeof req.query.symbol === 'string' && req.query.symbol ? req.query.symbol.toUpperCase() : undefined;
    const date = typeof req.query.date === 'string' ? req.query.date : undefined;
    const limit = parseInt(String(req.query.limit ?? ''), 10) || undefined;
    res.json(await setupWatcher.history({ symbol, date, limit }));
  } catch (err: any) {
    logger.error('GET /api/setup-watcher/history failed', { error: err?.message ?? String(err) });
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/api/scheduler', requireApiKey, (_req, res) => {
  res.json(scheduler.status());
});

// Kế hoạch ngày vàng (DailyPlanScheduler): mốc giờ, lần chạy kế tiếp, lỗi gần nhất.
app.get('/api/daily-plan', requireApiKey, (_req, res) => {
  res.json(dailyPlanScheduler.status());
});

// Lập kế hoạch ngày ngay (không chờ mốc giờ). Body: { symbol? } — mặc định symbol đầu
// tiên của DAILY_PLAN_SYMBOLS. 409 khi đang có phân tích khác chạy (single-flight).
app.post('/api/daily-plan/run', requireApiKey, async (req, res) => {
  const symbol: string = req.body?.symbol?.trim() || config.dailyPlan.symbols[0] || config.instrument;
  try {
    logger.info('POST /api/daily-plan/run triggered', { symbol });
    const { symbol: sym, durationMs, setup, reasoning, usage } = await runAnalysis({
      symbol, analysisType: DAILY_PLAN, timeframes: config.dailyPlan.timeframes, trigger: 'api',
    });
    res.json({ ok: true, symbol: sym, duration_ms: durationMs, setup, reasoning, usage: usage ? toUsageJson(usage) : null });
  } catch (err: any) {
    if (err instanceof AnalysisBusyError) {
      res.status(409).json({ error: err.message });
      return;
    }
    logger.error('POST /api/daily-plan/run failed', { error: err.message });
    res.status(500).json({ error: err.message ?? 'Daily plan failed' });
  }
});

// Lập kế hoạch ngày cho MỌI symbol của DAILY_PLAN_SYMBOLS, lần lượt, chạy nền (~3 phút/symbol).
// Trả 202 ngay; tiến độ đọc ở GET /api/daily-plan (`running`, `current_symbol`, `last_batch`).
// 409 khi một lượt plan khác (theo mốc hoặc bấm trước đó) chưa xong.
app.post('/api/daily-plan/run-all', requireApiKey, (_req, res) => {
  const symbols = dailyPlanScheduler.runAllNow();
  if (!symbols) {
    res.status(409).json({ error: 'Đang có lượt lập kế hoạch ngày khác chạy' });
    return;
  }
  logger.info('POST /api/daily-plan/run-all triggered', { symbols });
  res.status(202).json({ ok: true, symbols });
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
app.get('/api/usage', requireApiKey, async (_req, res) => {
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
        // Nguồn kích hoạt (scheduler/event/api/mcp) — badge "watcher" trên modal tín hiệu.
        trigger: true,
        // 'daily_plan' → badge "🗺 Plan" (plan cũng chạy theo lịch, cùng trigger 'scheduler').
        analysis_type: true,
      },
    });
    res.json(logs);
  } catch (err: any) {
    logger.error('GET /api/symbols/:symbol/signals failed', { error: err.message });
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ─── Trading signals ──────────────────────────────────────────────────────────

app.get('/api/signals/latest', requireApiKey, async (_req, res) => {
  try {
    // Kế hoạch ngày không phải tín hiệu vào lệnh → không để nó chiếm chỗ "tín hiệu mới nhất".
    const signal = await prisma.tradingSignal.findFirst({
      where:   { analysis_type: { not: DAILY_PLAN } },
      orderBy: { created_at: 'desc' },
    });
    if (!signal) {
      res.status(404).json({ error: 'No signals found' });
      return;
    }
    res.json((await attachOutcomes([parseSignal(signal)]))[0]);
  } catch (err: any) {
    logger.error('GET /api/signals/latest failed', { error: err.message });
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/api/signals', requireApiKey, async (req, res) => {
  try {
    const limit = Math.min(parseInt(String(req.query.limit ?? '20'), 10), 100);
    // ?trigger=event → chỉ tín hiệu do SetupWatcher kích hoạt (scheduler | api | mcp tương tự).
    const trigger = typeof req.query.trigger === 'string' && req.query.trigger ? req.query.trigger : undefined;
    const signals = await prisma.tradingSignal.findMany({
      where:   { created_at: { gte: startOfTodayVN() }, ...(trigger ? { trigger } : {}) },
      orderBy: { created_at: 'desc' },
      take:    limit,
    });
    res.json(await attachOutcomes(signals.map(parseSignal)));
  } catch (err: any) {
    logger.error('GET /api/signals failed', { error: err.message });
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * Gắn `outcome` (kết quả thật, null nếu chưa chấm) vào từng tín hiệu. Fail-soft: bảng
 * signal_outcomes chưa được tạo (chưa `db push`) hoặc lỗi DB thì trả tín hiệu như cũ, để việc
 * triển khai code trước schema không làm hỏng dashboard.
 */
async function attachOutcomes<T extends { id: number }>(signals: T[]): Promise<(T & { outcome: unknown })[]> {
  if (signals.length === 0) return [];
  try {
    const rows = await prisma.signalOutcome.findMany({ where: { signal_id: { in: signals.map((s) => s.id) } } });
    const byId = new Map(rows.map((r) => [r.signal_id, r]));
    return signals.map((s) => ({ ...s, outcome: byId.get(s.id) ?? null }));
  } catch (err: any) {
    logger.warn('Gắn outcome vào tín hiệu thất bại — trả tín hiệu không kèm outcome', { error: err.message });
    return signals.map((s) => ({ ...s, outcome: null }));
  }
}

// ─── Kết quả thật của tín hiệu ────────────────────────────────────────────────

// Thống kê winrate / tổng R / kỳ vọng mỗi lệnh theo nguồn kích hoạt, symbol, hướng, nhóm confidence.
// ?days=30 (1–365) ?symbol=XAU/USD. R tính ở TP1/SL gốc: TP1 = +planned_rr, SL = −1, EXPIRED = theo giá chốt.
app.get('/api/outcomes/stats', requireApiKey, async (req, res) => {
  try {
    const days = Math.min(Math.max(parseInt(String(req.query.days ?? '30'), 10) || 30, 1), 365);
    const symbol = typeof req.query.symbol === 'string' && req.query.symbol ? req.query.symbol : undefined;
    const since = new Date(Date.now() - days * 86_400_000);
    const all = await prisma.signalOutcome.findMany({
      where: { signal_at: { gte: since }, ...(symbol ? { instrument: symbol } : {}) },
    });
    // Mặc định gộp tín hiệu trùng (scheduler lặp lại cùng kế hoạch) — ?raw=1 để xem từng tín hiệu.
    const raw = req.query.raw === '1' || req.query.raw === 'true';
    const rows = raw ? all : dedupeSetups(all, {
      fillWindowMs: config.outcome.fillWindowMin * 60_000,
      entryTolR:    config.outcome.dedupEntryTolR,
    });
    res.json({
      days, since: since.toISOString(), symbol: symbol ?? null,
      deduped:       !raw,
      signals:       all.length,
      setups:        rows.length,
      tracker:       outcomeTracker.status(),
      overall:       summarize(rows),
      by_trigger:    groupBy(rows, (r) => r.trigger ?? 'unknown'),
      by_symbol:     groupBy(rows, (r) => r.instrument),
      by_direction:  groupBy(rows, (r) => r.direction),
      by_confidence: groupBy(rows, (r) => confidenceBand(r.confidence)),
    });
  } catch (err: any) {
    logger.error('GET /api/outcomes/stats failed', { error: err.message });
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Chấm lại các lệnh trong N ngày gần nhất (kể cả đã chốt) theo luật hiện tại + nạp lại confidence
// còn null từ text phân tích. Gọi một lần sau khi đổi luật chấm/parser. Body/query: { days? } (≤ backfill).
app.post('/api/outcomes/rescore', requireApiKey, async (req, res) => {
  try {
    const days = parseInt(String(req.body?.days ?? req.query.days ?? config.outcome.backfillDays), 10);
    const result = await outcomeTracker.rescore(Number.isFinite(days) ? days : config.outcome.backfillDays);
    res.json({ ok: true, ...result });
  } catch (err: any) {
    logger.error('POST /api/outcomes/rescore failed', { error: err.message });
    res.status(500).json({ error: err.message ?? 'Rescore failed' });
  }
});

// Danh sách kết quả gần nhất. ?limit=50 (tối đa 200) ?status=SL ?symbol=BTC/USD
app.get('/api/outcomes', requireApiKey, async (req, res) => {
  try {
    const limit = Math.min(Math.max(parseInt(String(req.query.limit ?? '50'), 10) || 50, 1), 200);
    const status = typeof req.query.status === 'string' && req.query.status ? req.query.status.toUpperCase() : undefined;
    const symbol = typeof req.query.symbol === 'string' && req.query.symbol ? req.query.symbol : undefined;
    const rows = await prisma.signalOutcome.findMany({
      where: { ...(status ? { status } : {}), ...(symbol ? { instrument: symbol } : {}) },
      orderBy: { signal_at: 'desc' },
      take: limit,
    });
    res.json(rows);
  } catch (err: any) {
    logger.error('GET /api/outcomes failed', { error: err.message });
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
      // sessionId chỉ được sinh khi xử lý request `initialize` (trong handleRequest), không phải
      // lúc connect() — phải lưu qua onsessioninitialized, nếu không request sau sẽ bị 404.
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (id) => {
          mcpTransports.set(id, transport);
          logger.info('MCP session created', { sessionId: id });
        },
      });
      const mcpServer = createMcpServer();

      transport.onclose = () => {
        if (transport.sessionId) {
          mcpTransports.delete(transport.sessionId);
          logger.info('MCP session closed', { sessionId: transport.sessionId });
        }
      };

      await mcpServer.connect(transport);
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

  setupWatcher.start();
  dailyPlanScheduler.start();
  outcomeTracker.start();
});
