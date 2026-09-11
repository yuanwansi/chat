import { DurableObject } from 'cloudflare:workers';

export class MediaRelay extends DurableObject {
  private sessions: Map<string, WebSocket> = new Map();

  async fetch(request: Request): Promise<Response> {
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);

    const userId = new URL(request.url).searchParams.get('userId');
    if (!userId) {
      return new Response('Missing userId', { status: 400 });
    }

    this.sessions.set(userId, server);
    server.accept();

    server.addEventListener('message', (event) => {
      // 将数据转发给除发送者以外的所有连接
      this.sessions.forEach((ws, id) => {
        if (id !== userId && ws.readyState === WebSocket.READY_STATE_OPEN) {
          ws.send(event.data);
        }
      });
    });

    server.addEventListener('close', () => {
      this.sessions.delete(userId);
      // 通知对方自己已离开
      this.sessions.forEach((ws) => {
        if (ws.readyState === WebSocket.READY_STATE_OPEN) {
          ws.send(JSON.stringify({ type: 'peer-left', userId }));
        }
      });
    });

    return new Response(null, { status: 101, webSocket: client });
  }
}
