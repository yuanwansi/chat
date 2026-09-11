import { DurableObject } from 'cloudflare:workers';

export class SignalingServer extends DurableObject {
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
      const signal = JSON.parse(event.data as string);

      // 广播给除发送者以外的所有连接
      this.sessions.forEach((ws, id) => {
        if (id !== userId && ws.readyState === WebSocket.READY_STATE_OPEN) {
          ws.send(JSON.stringify({
            ...signal,
            senderId: userId
          }));
        }
      });
    });

    server.addEventListener('close', () => {
      this.sessions.delete(userId);
    });

    return new Response(null, { status: 101, webSocket: client });
  }
}
