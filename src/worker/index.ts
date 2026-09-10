import { ChatRoom } from './chat-room';
import { SignalingServer } from './signaling';

export { ChatRoom, SignalingServer };

interface Env {
  CHAT_ROOM: DurableObjectNamespace;
  SIGNALING: DurableObjectNamespace;
  CHAT_FILES: R2Bucket;
  SUPABASE_URL: string;
  SUPABASE_ANON_KEY: string;
  SUPABASE_SERVICE_KEY: string;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // === WebSocket 路由 ===
    if (url.pathname.startsWith('/chat/')) {
      const roomId = url.pathname.split('/')[2];
      const id = env.CHAT_ROOM.idFromName(roomId);
      return env.CHAT_ROOM.get(id).fetch(request);
    }

    if (url.pathname.startsWith('/signal/')) {
      const roomId = url.pathname.split('/')[2];
      const id = env.SIGNALING.idFromName(roomId);
      return env.SIGNALING.get(id).fetch(request);
    }

    // === REST API 路由 ===
    if (url.pathname === '/api/upload-url' && request.method === 'POST') {
      return handleUploadUrl(request, env);
    }

    if (url.pathname === '/api/messages' && request.method === 'GET') {
      return handleGetMessages(request, env);
    }

    if (url.pathname === '/api/messages' && request.method === 'POST') {
      return handleSendMessage(request, env);
    }

    return new Response('Not Found', { status: 404 });
  }
};

async function handleUploadUrl(request: Request, env: Env): Promise<Response> {
  const { filename, userId } = await request.json() as { filename: string; userId: string };
  const key = `uploads/${userId}/${Date.now()}-${filename}`;

  const uploadUrl = await env.CHAT_FILES.createUploadUrl({
    key,
    expiresIn: 300
  });

  return Response.json({ uploadUrl, key });
}

async function handleGetMessages(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const roomId = url.searchParams.get('roomId');
  const limit = parseInt(url.searchParams.get('limit') || '50');
  const before = url.searchParams.get('before');

  const supabaseUrl = `${env.SUPABASE_URL}/rest/v1/messages`;
  let query = `room_id=eq.${roomId}&order=created_at.desc&limit=${limit}`;
  if (before) query += `&created_at=lt.${before}`;

  const response = await fetch(`${supabaseUrl}?${query}`, {
    headers: {
      'apikey': env.SUPABASE_ANON_KEY,
      'Authorization': request.headers.get('Authorization') || ''
    }
  });

  const messages = await response.json() as any[];
  return Response.json(messages);
}

async function handleSendMessage(request: Request, env: Env): Promise<Response> {
  const body = await request.json() as {
    room_id: string;
    sender_id: string;
    content: string;
    type?: string;
    attachment_url?: string;
  };

  const response = await fetch(`${env.SUPABASE_URL}/rest/v1/messages`, {
    method: 'POST',
    headers: {
      'apikey': env.SUPABASE_SERVICE_KEY,
      'Authorization': `Bearer ${env.SUPABASE_SERVICE_KEY}`,
      'Content-Type': 'application/json',
      'Prefer': 'return=representation'
    },
    body: JSON.stringify(body)
  });

  const message = await response.json() as any;
  return Response.json(message);
}
