import { config } from '../config/trading';

export class MarketHoursService {
  constructor(
    private readonly openHour: number,
    private readonly closeHour: number,
    private readonly timezone: string,
  ) {}

  static fromConfig(): MarketHoursService {
    return new MarketHoursService(
      config.marketHours.open,
      config.marketHours.close,
      config.marketHours.timezone,
    );
  }

  isOpen(at?: Date): boolean {
    const now = at ?? new Date();
    const hour = parseInt(
      new Intl.DateTimeFormat('en', {
        hour: 'numeric',
        hour12: false,
        timeZone: this.timezone,
      }).format(now),
      10,
    );
    return hour >= this.openHour && hour < this.closeHour;
  }

  status(at?: Date): string {
    const now = at ?? new Date();
    const time = new Intl.DateTimeFormat('en-GB', {
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
      timeZone: this.timezone,
    }).format(now);

    if (this.isOpen(now)) {
      return `OPEN (${time} VN)`;
    }

    return `CLOSED (${time} VN — market opens at ${String(this.openHour).padStart(2, '0')}:00)`;
  }
}
