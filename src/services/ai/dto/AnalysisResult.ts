export const ACTIONS = ['BUY', 'SELL', 'NO_TRADE'] as const;

export interface ConditionalSetup {
  direction: 'BUY' | 'SELL';
  rawText: string;
}
export type Action = (typeof ACTIONS)[number];

export interface MarketStructure {
  current_price?: string;
  trend_m5?: string;
  trend_m5_detail?: string;
  trend_m15?: string;
  trend_m15_detail?: string;
  structure?: string;
  ma_position?: string;
  rsi_m5?: string;
  atr_note?: string;
}

export interface KeyLevel {
  label: string;
  value: string;
  type?: 'resistance' | 'support' | 'neutral';
}

export interface TpLevel {
  value: number | string;
  rr: string;
  note?: string;
}

export interface TradeSetup {
  direction: 'BUY' | 'SELL';
  id: string;
  label: string;
  description: string;
  confidence_label: string;
  entry_zone: string;
  trigger: string;
  stop_loss: number;
  stop_loss_note?: string;
  tp1: TpLevel;
  tp2: TpLevel;
  tp3: TpLevel;
  cancel_condition: string;
}

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
    public readonly marketStructure: MarketStructure | null = null,
    public readonly keyLevels: KeyLevel[] | null = null,
    public readonly setups: TradeSetup[] | null = null,
    public readonly conditionalSetups: ConditionalSetup[] = [],
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
      isObject(data.market_structure) ? (data.market_structure as MarketStructure) : null,
      Array.isArray(data.key_levels) ? (data.key_levels as KeyLevel[]) : null,
      Array.isArray(data.setups) ? (data.setups as TradeSetup[]) : null,
    );
  }

  isTradable(): boolean {
    return this.action === 'BUY' || this.action === 'SELL';
  }
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
