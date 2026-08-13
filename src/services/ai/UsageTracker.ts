import { RateLimitSnapshot, TokenUsage } from './transport/LlmTransport';

/**
 * Bộ nhớ tạm (process-level) cho số liệu usage của lượt phân tích GẦN NHẤT.
 *
 * Vì sao không lưu DB: hạn mức `anthropic-ratelimit-*` là ảnh chụp tại thời điểm gọi
 * và tự reset theo cửa sổ của Anthropic — lưu lịch sử không có ý nghĩa, chỉ số hiện
 * tại mới dùng được. Token in/out thì NGƯỢC LẠI: có lưu DB (analysis_logs) để cộng
 * dồn theo ngày. Mất khi restart server là chấp nhận được (lượt sau ghi đè).
 */
export interface LastRunUsage {
  symbol: string;
  at: string;
  durationMs: number;
  usage: TokenUsage | null;
}

let lastRun: LastRunUsage | null = null;
let lastRateLimit: RateLimitSnapshot | null = null;

export function recordUsage(entry: LastRunUsage, rateLimit: RateLimitSnapshot | null): void {
  lastRun = entry;
  // Chỉ ghi đè khi lượt mới thực sự đọc được header (subscription trả null) —
  // giữ lại số cũ còn hơn xoá trắng dashboard.
  if (rateLimit) lastRateLimit = rateLimit;
}

export function lastRunUsage(): LastRunUsage | null {
  return lastRun;
}

export function lastRateLimitSnapshot(): RateLimitSnapshot | null {
  return lastRateLimit;
}
