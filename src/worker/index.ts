import { ChatRoom } from './chat-room';
import { SignalingServer } from './signaling';
import { MediaRelay } from './media-relay';

export { ChatRoom, SignalingServer, MediaRelay };

interface Env {
  CHAT_ROOM: DurableObjectNamespace;
  SIGNALING: DurableObjectNamespace;
  MEDIA_RELAY: DurableObjectNamespace;
  CHAT_FILES: R2Bucket;
  SUPABASE_URL: string;
  SUPABASE_ANON_KEY: string;
  SUPABASE_SERVICE_KEY: string;
}

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type,Authorization',
};

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }

    // === WebSocket 路由 ===
    if (url.pathname.startsWith('/chat/')) {
      const roomId = url.pathname.split('/')[2];
      const id = env.CHAT_ROOM.idFromName(roomId);
      // 将 Supabase 凭据通过自定义头传递给 DurableObject
      const headers = new Headers(request.headers);
      headers.set('X-Supabase-Url', env.SUPABASE_URL);
      headers.set('X-Supabase-Service-Key', env.SUPABASE_SERVICE_KEY);
      const doRequest = new Request(request, { headers });
      return env.CHAT_ROOM.get(id).fetch(doRequest);
    }

    if (url.pathname.startsWith('/signal/')) {
      const roomId = url.pathname.split('/')[2];
      const id = env.SIGNALING.idFromName(roomId);
      return env.SIGNALING.get(id).fetch(request);
    }

    if (url.pathname.startsWith('/media/')) {
      const roomId = url.pathname.split('/')[2];
      const id = env.MEDIA_RELAY.idFromName(roomId);
      return env.MEDIA_RELAY.get(id).fetch(request);
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
    if (url.pathname === '/api/delete-account' && request.method === 'POST') {
      return handleDeleteAccount(request, env);
    }

    return new Response('Not Found', { status: 404 });
  }
};


async function handleUploadUrl(request: Request, env: Env): Promise<Response> {
  const { filename, userId, contentType } = await request.json() as { filename: string; userId: string; contentType?: string };

  // 后端 MIME 类型校验
  const ALLOWED_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/svg+xml'];
  if (contentType && !ALLOWED_TYPES.includes(contentType)) {
    return Response.json({ error: '不支持的文件类型' }, { status: 400, headers: corsHeaders });
  }

  const key = `uploads/${userId}/${Date.now()}-${filename}`;

  const uploadUrl = await env.CHAT_FILES.createUploadUrl({
    key,
    expiresIn: 300,
    customMetadata: { contentType: contentType || 'application/octet-stream' }
  });

  return Response.json({ uploadUrl, key }, { headers: corsHeaders });
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
  return Response.json(messages, { headers: corsHeaders });
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
  return Response.json(message, { headers: corsHeaders });
}

async function handleDeleteAccount(request: Request, env: Env): Promise<Response> {
  const authHeader = request.headers.get('Authorization');
  if (!authHeader?.startsWith('Bearer ')) {
    return Response.json({ error: '未提供认证令牌' }, { status: 401, headers: corsHeaders });
  }
  const token = authHeader.replace('Bearer ', '');

  // 验证用户身份
  const userRes = await fetch(`${env.SUPABASE_URL}/auth/v1/user`, {
    headers: { 'apikey': env.SUPABASE_ANON_KEY, 'Authorization': `Bearer ${token}` }
  });
  if (!userRes.ok) {
    return Response.json({ error: '认证失败' }, { status: 401, headers: corsHeaders });
  }
  const user = await userRes.json() as any;
  const userId = user.id;

  // 用 service key 删除用户数据
  const sk = env.SUPABASE_SERVICE_KEY;
  const headers = { 'apikey': sk, 'Authorization': `Bearer ${sk}`, 'Content-Type': 'application/json' };

  // 删除 room_members
  await fetch(`${env.SUPABASE_URL}/rest/v1/room_members?user_id=eq.${userId}`, { method: 'DELETE', headers });
  // 删除 profiles
  await fetch(`${env.SUPABASE_URL}/rest/v1/profiles?id=eq.${userId}`, { method: 'DELETE', headers });
  // 删除认证账号
  const delRes = await fetch(`${env.SUPABASE_URL}/auth/v1/admin/users/${userId}`, {
    method: 'DELETE',
    headers: { 'apikey': sk, 'Authorization': `Bearer ${sk}` }
  });
  if (!delRes.ok) {
    return Response.json({ error: '删除认证账号失败' }, { status: 500, headers: corsHeaders });
  }
  return Response.json({ success: true }, { headers: corsHeaders });
}
