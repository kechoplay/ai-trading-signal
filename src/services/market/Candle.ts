export class Candle {
  constructor(
    public readonly time: string,
    public readonly open: number,
    public readonly high: number,
    public readonly low: number,
    public readonly close: number,
    public readonly volume: number,
  ) {}

  toArray() {
    return { t: this.time, o: this.open, h: this.high, l: this.low, c: this.close, v: this.volume };
  }
}
