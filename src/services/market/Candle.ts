export class Candle {
  constructor(
    public readonly time: string,
    public readonly open: number,
    public readonly high: number,
    public readonly low: number,
    public readonly close: number,
    /** Khối lượng giao dịch — null khi provider không có volume (vàng/forex không có volume tập trung). */
    public readonly volume: number | null = null,
  ) {}

  toArray() {
    return {
      t: this.time, o: this.open, h: this.high, l: this.low, c: this.close,
      ...(this.volume != null ? { v: this.volume } : {}),
    };
  }
}
