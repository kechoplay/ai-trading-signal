export const ACTIONS = ['BUY', 'SELL', 'NO_TRADE'] as const;
export type Action = (typeof ACTIONS)[number];

export class AnalysisResult {
  constructor(
    public readonly action: Action,
    public readonly entry: number | null,
    public readonly stopLoss: number | null,
    public readonly takeProfit: number | null,
    public readonly riskReward: number | null,
    public readonly confidence: number | null,
    public readonly trendBias: string | null,
    public readonly reasoning: string | null,
    public readonly raw: Record<string, unknown> = {},
  ) {}

  static fromAiJson(
    data: Record<string, unknown>,
    rawResponse: Record<string, unknown> = {},
  ): AnalysisResult {
    const rawAction = String(data.action ?? 'NO_TRADE').toUpperCase();
    const action: Action = (ACTIONS as readonly string[]).includes(rawAction)
      ? (rawAction as Action)
      : 'NO_TRADE';

    return new AnalysisResult(
      action,
      data.entry != null ? parseFloat(String(data.entry)) : null,
      data.stop_loss != null ? parseFloat(String(data.stop_loss)) : null,
      data.take_profit != null ? parseFloat(String(data.take_profit)) : null,
      data.risk_reward != null ? parseFloat(String(data.risk_reward)) : null,
      data.confidence != null
        ? Math.max(0, Math.min(100, parseInt(String(data.confidence), 10)))
        : null,
      data.trend_bias != null ? String(data.trend_bias) : null,
      data.reasoning != null ? String(data.reasoning) : null,
      rawResponse,
    );
  }

  isTradable(): boolean {
    return this.action === 'BUY' || this.action === 'SELL';
  }
}
