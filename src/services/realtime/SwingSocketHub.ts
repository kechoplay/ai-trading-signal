import { Server as HttpServer } from 'http';
import { WebSocket, WebSocketServer } from 'ws';
import { logger } from '../../logger';
import { SwingReport } from '../swing/SwingSignalService';

export interface SwingBroadcastPayload {
  symbol: string;
  timeframe: string;
  actionable: boolean;
  latest: SwingReport['latest'];
  stats: SwingReport['stats'];
  signals: SwingReport['signals'];
  params: SwingReport['params'];
  currentPrice: number;
  generatedAt: string;
}

/**
 * WebSocket server phát kết quả nhịp nhỏ realtime cho dashboard (path /ws/swing), thay
 * cho việc client tự poll REST theo chu kỳ. Giữ cache bản mới nhất từng symbol trong RAM
 * (không DB — dữ liệu tính lại được từ nến bất cứ lúc nào) để client vừa kết nối có dữ
 * liệu ngay, không phải chờ tới tick kế tiếp của SwingScheduler.
 *
 * Xác thực bằng API_SERVER_KEY qua query string (`?key=...`) — WebSocket API của trình
 * duyệt không cho set header tùy ý như x-api-key, nên không thể dùng lại `requireApiKey`
 * của Express. Chặn ngay ở bước 'upgrade' (trước khi handshake xong) để request sai key
 * nhận về 401 gọn thay vì bị nâng cấp lên rồi mới đóng.
 */
export class SwingSocketHub {
  private readonly wss: WebSocketServer;
  private readonly cache = new Map<string, SwingBroadcastPayload>();

  constructor(server: HttpServer, private readonly apiKey: string, path = '/ws/swing') {
    this.wss = new WebSocketServer({ noServer: true });

    server.on('upgrade', (req, socket, head) => {
      let url: URL;
      try {
        url = new URL(req.url ?? '', 'http://internal');
      } catch {
        socket.destroy();
        return;
      }
      if (url.pathname !== path) return; // không phải path của mình — bỏ qua, để listener khác xử lý

      if (this.apiKey && url.searchParams.get('key') !== this.apiKey) {
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
        socket.destroy();
        return;
      }

      this.wss.handleUpgrade(req, socket, head, (ws) => {
        this.wss.emit('connection', ws, req);
      });
    });

    this.wss.on('connection', (ws) => {
      const items = Array.from(this.cache.values());
      if (items.length) {
        ws.send(JSON.stringify({ type: 'snapshot', items }));
      }
      ws.on('error', (err: Error) => {
        logger.warn('WS swing client error', { error: err.message });
      });
    });
    this.wss.on('error', (err: Error) => {
      logger.error('WS swing server error', { error: err.message });
    });
  }

  /** Cập nhật cache + đẩy tới mọi client đang mở. */
  publish(payload: SwingBroadcastPayload): void {
    this.cache.set(payload.symbol, payload);
    const message = JSON.stringify({ type: 'swing', ...payload });
    for (const client of this.wss.clients) {
      if (client.readyState === WebSocket.OPEN) client.send(message);
    }
  }

  /** Bỏ symbol khỏi cache khi bị xóa khỏi danh sách theo dõi — tránh gửi rác cho client mới. */
  drop(symbol: string): void {
    this.cache.delete(symbol);
  }

  clientCount(): number {
    return this.wss.clients.size;
  }
}
