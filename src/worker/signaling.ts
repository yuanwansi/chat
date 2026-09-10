import { DurableObject } from 'cloudflare:workers';

export class SignalingServer extends DurableObject {
  async fetch(request: Request): Promise<Response> {
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);

    const userId = new URL(request.url).searchParams.get('userId');
    if (!userId) {
      return new Response('Missing userId', { status: 400 });
    }

    server.accept();
    server.serializeAttachment({ userId });

    server.addEventListener('message', (event) => {
      const signal = JSON.parse(event.data as string);

      const targets = this.ctx.getWebSockets(signal.targetId);
      targets.forEach(ws => {
        if (ws.readyState === WebSocket.READY_STATE_OPEN) {
          ws.send(JSON.stringify({
            ...signal,
            senderId: userId
          }));
        }
      });
    });

    return new Response(null, { status: 101, webSocket: client });
  }
}
