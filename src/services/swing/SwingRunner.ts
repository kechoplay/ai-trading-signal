import { AnalysisResult } from '../ai/dto/AnalysisResult';
import { makeMarketDataProvider } from '../market/MarketDataProviderFactory';
import { TelegramNotifier } from '../telegram/TelegramNotifier';
import { analyzeSwings, SwingReport, SwingSignal } from './SwingSignalService';
import { config } from '../../config/trading';
import { logger } from '../../logger';

export interface SwingRunOptions {
  symbol?: string;
  timeframe?: string;
  /** Số nhịp gần nhất đưa vào bảng lịch sử (mặc định 15). */
  limit?: number;
  /** Gửi Telegram như luồng phân tích AI (mặc định false — tránh spam mỗi lần gọi API). */
  notify?: boolean;
}

export interface SwingRunResult {
  symbol: string;
  durationMs: number;
  report: SwingReport;
  /** Tín hiệu mới nhất còn vào được hay không (xem `isActionable`). */
  actionable: boolean;
  /** Signal card HTML — cùng định dạng với phân tích AI hàng ngày. */
  setup: string;
  /** Phân tích chi tiết dạng HTML Telegram. */
  reasoning: string;
  /** Bản markdown thô của phần phân tích (dùng cho log/CLI). */
  markdown: string;
}

/**
 * Tín hiệu chỉ đáng vào khi CHƯA chốt (không phải lịch sử) và còn tươi. Quá
 * `staleBars` nến thì giá đã rời entry quá xa — R:R thực tế không còn như tính toán.
 */
function isActionable(s: SwingSignal | null, staleBars: number): boolean {
  return Boolean(s && s.status === 'RUNNING' && s.barsAgo <= staleBars);
}

/**
 * Chạy dò nhịp nhỏ rồi trả về kết quả ở đúng định dạng của phân tích hàng ngày
 * (signal card + phần phân tích). KHÔNG ghi `trading_signals`: đây là lớp tín hiệu cơ
 * học tính lại được từ nến bất cứ lúc nào, lưu vào đó sẽ trộn lẫn với tín hiệu AI trên
 * dashboard và làm hỏng carry-forward (xem SignalOrchestrator.loadPendingSetup).
 */
export async function runSwingAnalysis(opts: SwingRunOptions = {}): Promise<SwingRunResult> {
  const startedAt = Date.now();
  const symbol = opts.symbol?.trim() || config.instrument;
  const timeframe = opts.timeframe?.trim() || config.swing.timeframe;
  const limit = opts.limit ?? 15;

  const market = makeMarketDataProvider();
  const candles = await market.fetchCandles(symbol, timeframe, config.swing.candles);
  const currentPrice = await market.fetchCurrentPrice(symbol);

  const report = analyzeSwings(candles, timeframe, currentPrice, {
    pivotLookback: config.swing.pivotLookback,
    minLegAtr:     config.swing.minLegAtr,
    slBufferAtr:   config.swing.slBufferAtr,
    tpR:           config.swing.tpR,
    atrPeriod:     config.swing.atrPeriod,
  });

  const actionable = isActionable(report.latest, config.swing.staleBars);
  const markdown = formatSwingMarkdown(symbol, report, actionable, limit);

  const notifier = TelegramNotifier.fromConfig();
  const setup = notifier.formatSignalCard(toAnalysisResult(report, actionable), symbol, report.currentPrice);
  const reasoning = notifier.formatAnalysis(markdown);

  logger.info('Swing analysis finished', {
    symbol, timeframe, bars: report.bars, signals: report.stats.total,
    latest: report.latest ? `${report.latest.direction}@${report.latest.entry}` : null,
    actionable, duration_ms: Date.now() - startedAt,
  });

  if (opts.notify) {
    try {
      const messageId = await notifier.send(setup);
      if (messageId) await notifier.sendComment(reasoning, messageId);
    } catch (err: any) {
      logger.error('Swing analysis: gửi Telegram thất bại', { error: err?.message ?? String(err) });
    }
  }

  return { symbol, durationMs: Date.now() - startedAt, report, actionable, setup, reasoning, markdown };
}

/**
 * Bọc tín hiệu mới nhất vào AnalysisResult để dùng lại formatSignalCard của luồng AI.
 * Không actionable → NO_TRADE (card sẽ ẩn hàng Entry/SL/TP).
 * Confidence lấy từ winrate lịch sử của CHÍNH bộ nến đang xét — con số đo được, không
 * phải điểm tự chấm như phân tích AI.
 */
function toAnalysisResult(report: SwingReport, actionable: boolean): AnalysisResult {
  const s = report.latest;
  if (!actionable || !s) {
    return new AnalysisResult(
      'NO_TRADE', null, null, null, null, report.stats.winRatePct,
      biasFromSignals(report.signals), noTradeReason(report), { swing: report as unknown as Record<string, unknown> },
    );
  }
  return new AnalysisResult(
    s.direction, s.entry, s.stopLoss, s.takeProfits[0] ?? null, config.swing.tpR[0] ?? null,
    report.stats.winRatePct, biasFromSignals(report.signals),
    `Nhịp ${s.direction === 'BUY' ? 'tăng' : 'giảm'} xác nhận tại pivot ${s.pivotPrice} `
      + `(${s.pivotTime}), nhịp trước đó dài ${s.legAtr}× ATR.`,
    { swing: report as unknown as Record<string, unknown> },
  );
}

/** Bias đọc từ 3 nhịp gần nhất: cùng chiều liên tiếp → theo chiều đó. */
function biasFromSignals(signals: SwingSignal[]): string {
  const last3 = signals.slice(-3);
  if (last3.length < 2) return 'NEUTRAL';
  const buys = last3.filter((s) => s.direction === 'BUY').length;
  if (buys === last3.length) return 'BULLISH';
  if (buys === 0) return 'BEARISH';
  return 'NEUTRAL';
}

function noTradeReason(report: SwingReport): string {
  const s = report.latest;
  if (!s) return 'Chưa có nhịp nào đủ lớn để tạo tín hiệu trên bộ nến hiện tại.';
  if (s.status !== 'RUNNING') return `Nhịp gần nhất đã đóng (${s.status}) — chờ pivot mới.`;
  return `Tín hiệu ${s.direction} đã ra cách đây ${s.barsAgo} nến — giá rời entry quá xa, chờ nhịp mới.`;
}

// ─── Định dạng ───────────────────────────────────────────────────────────────

const ARROW: Record<string, string> = { BUY: '🟢 BUY', SELL: '🔴 SELL' };

/** Bỏ phần ngày cho gọn bảng — mọi nến trong báo cáo đều thuộc vài phiên gần nhất. */
function shortTime(t: string): string {
  const m = t.match(/(\d{2})-(\d{2})[T ](\d{2}:\d{2})/);
  return m ? `${m[3]} ${m[2]}/${m[1]}` : t;
}

function statusLabel(s: SwingSignal): string {
  if (s.status === 'SL') return `❌ SL (${s.resultR}R)`;
  if (s.status === 'RUNNING') return `⏳ đang chạy (${s.resultR >= 0 ? '+' : ''}${s.resultR}R)`;
  return `✅ ${s.status} (+${s.resultR}R)`;
}

export function formatSwingMarkdown(
  symbol: string,
  report: SwingReport,
  actionable: boolean,
  limit: number,
): string {
  const { stats, params } = report;
  const lines: string[] = [];

  lines.push(`## NHỊP NHỎ — ${symbol} · ${report.timeframe}`);
  lines.push('');
  lines.push(
    `Giá hiện tại **${report.currentPrice}** · ATR ${report.atr} · ${report.bars} nến `
    + `(tới ${shortTime(report.lastCandleTime)}) · pivot ${params.pivotLookback} nến, `
    + `lọc nhịp ≥ ${params.minLegAtr}× ATR`,
  );
  lines.push('');

  lines.push('### Tín hiệu mới nhất');
  const s = report.latest;
  if (!s) {
    lines.push('Không có nhịp nào đủ lớn — thị trường đi ngang trong biên nhỏ hơn ngưỡng lọc.');
  } else {
    lines.push(`**${ARROW[s.direction]}** @ **${s.entry}** — xác nhận ${shortTime(s.signalTime)} (${s.barsAgo} nến trước)`);
    lines.push(`- Pivot: ${s.pivotPrice} (${shortTime(s.pivotTime)}), nhịp trước dài ${s.legAtr}× ATR`);
    lines.push(`- SL ${s.stopLoss} — rủi ro 1R = ${s.risk}`);
    lines.push(`- ${s.takeProfits.map((tp, i) => `TP${i + 1} ${tp} (${params.tpR[i]}R)`).join(' · ')}`);
    lines.push(`- Trạng thái: ${statusLabel(s)}`);
    lines.push(actionable
      ? `- ➡️ **CÒN VÀO ĐƯỢC** (trong ${config.swing.staleBars} nến kể từ tín hiệu)`
      : `- ⛔ **KHÔNG VÀO** — ${noTradeReason(report)}`);
    if (s.provisional) {
      lines.push('- ⚠️ Nhịp đảo chiều chưa đủ lớn → pivot còn có thể bị dời (repaint), tín hiệu này có thể biến mất.');
    }
  }
  lines.push('');

  lines.push('### Hiệu năng trên chính bộ nến này');
  lines.push('| Chỉ số | Giá trị |');
  lines.push('|---|---|');
  lines.push(`| Tổng nhịp | ${stats.total} |`);
  lines.push(`| Đã đóng | ${stats.resolved} |`);
  lines.push(`| Chạm TP | ${stats.hitTp1} |`);
  lines.push(`| Dính SL | ${stats.hitSl} |`);
  lines.push(`| Winrate | ${stats.winRatePct == null ? '—' : `${stats.winRatePct}%`} |`);
  lines.push(`| Tổng R | ${stats.totalR >= 0 ? '+' : ''}${stats.totalR} |`);
  lines.push(`| R trung bình/lệnh | ${stats.avgR == null ? '—' : `${stats.avgR >= 0 ? '+' : ''}${stats.avgR}`} |`);
  lines.push('');

  lines.push(`### ${Math.min(limit, stats.total)} nhịp gần nhất`);
  lines.push('| Xác nhận | Chiều | Entry | SL | TP1 | Nhịp | Kết quả |');
  lines.push('|---|---|---|---|---|---|---|');
  for (const x of report.signals.slice(-limit).reverse()) {
    lines.push(
      `| ${shortTime(x.signalTime)} | ${x.direction} | ${x.entry} | ${x.stopLoss} `
      + `| ${x.takeProfits[0]} | ${x.legAtr}× | ${statusLabel(x)} |`,
    );
  }
  lines.push('');
  lines.push(
    '_Tín hiệu cơ học (zigzag pivot + ATR), KHÔNG đọc bối cảnh POI/thanh khoản như phân tích AI. '
    + 'Winrate ở trên đo trên chính đoạn nến đang xét nên là backtest trong mẫu — dùng để so sánh tham số, không phải kỳ vọng tương lai._',
  );

  return lines.join('\n');
}
