import crypto from 'crypto';

/**
 * So sánh hai chuỗi bí mật không rò độ dài/nội dung qua thời gian phản hồi.
 * Băm SHA-256 trước để hai buffer luôn bằng độ dài (timingSafeEqual ném lỗi nếu khác độ dài).
 */
export function safeEqual(a: unknown, b: unknown): boolean {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const ha = crypto.createHash('sha256').update(a).digest();
  const hb = crypto.createHash('sha256').update(b).digest();
  return crypto.timingSafeEqual(ha, hb);
}

/**
 * Giới hạn số lần thử SAI theo khoá (thường là IP) trong cửa sổ trượt cố định.
 * Chỉ đếm lần sai; chạm trần thì chặn cho tới hết cửa sổ. Lưu trong RAM — restart là reset.
 */
export class FailureLimiter {
  private readonly hits = new Map<string, { count: number; resetAt: number }>();

  constructor(private readonly maxFailures: number, private readonly windowMs: number) {}

  /** Số giây phải chờ nếu khoá đang bị chặn, ngược lại 0. */
  retryAfterSec(key: string, now = Date.now()): number {
    const e = this.hits.get(key);
    if (!e) return 0;
    if (e.resetAt <= now) {
      this.hits.delete(key);
      return 0;
    }
    return e.count >= this.maxFailures ? Math.ceil((e.resetAt - now) / 1000) : 0;
  }

  recordFailure(key: string, now = Date.now()): void {
    this.prune(now);
    const e = this.hits.get(key);
    if (!e || e.resetAt <= now) this.hits.set(key, { count: 1, resetAt: now + this.windowMs });
    else e.count++;
  }

  reset(key: string): void {
    this.hits.delete(key);
  }

  // Dọn các khoá đã hết hạn để Map không phình vô hạn khi bị quét từ nhiều IP.
  private prune(now: number): void {
    if (this.hits.size < 1000) return;
    for (const [k, v] of this.hits) if (v.resetAt <= now) this.hits.delete(k);
  }
}
