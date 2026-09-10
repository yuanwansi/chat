import { DurableObject } from 'cloudflare:workers';

export class ChatRoom extends DurableObject {
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

    this.broadcast({
      type: 'presence',
      userId,
      status: 'online'
    }, userId);

    server.addEventListener('message', (event) => {
      const data = JSON.parse(event.data as string);

      switch (data.type) {
        case 'message':
          this.broadcast({
            type: 'message',
            senderId: userId,
            content: data.content,
            timestamp: Date.now()
          }, userId);
          break;

        case 'typing':
          this.broadcast({
            type: 'typing',
            userId,
            isTyping: data.isTyping
          }, userId);
          break;
      }
    });

    server.addEventListener('close', () => {
      this.sessions.delete(userId);
      this.broadcast({
        type: 'presence',
        userId,
        status: 'offline'
      }, userId);
    });

    return new Response(null, { status: 101, webSocket: client });
  }

  private broadcast(message: object, excludeUserId?: string): void {
    const data = JSON.stringify(message);
    this.sessions.forEach((ws, id) => {
      if (id !== excludeUserId && ws.readyState === WebSocket.READY_STATE_OPEN) {
        ws.send(data);
      }
    });
  }
}
