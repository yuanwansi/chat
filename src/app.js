import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const SUPABASE_URL = 'https://dumptrrjlwhkaepxdkye.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImR1bXB0cnJqbHdoa2FlcHhka3llIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODkwMTUzMjEsImV4cCI6MjEwNDU5MTMyMX0.NbhAFD2S-YP3BgIgyBl_WQSFTIWr3istMn6Z5boPPD0';
const WS_BASE = 'wss://chat.yuanxiangxi039.workers.dev';
const API_BASE = 'https://chat.yuanxiangxi039.workers.dev';

const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

let currentUser = null;
let currentRoom = null;
let chatSocket = null;
let signalSocket = null;
let peerConnection = null;
let localStream = null;

const $ = (sel) => document.querySelector(sel);

async function hashPassword(plain) {
  if (!plain) return null;
  const data = new TextEncoder().encode('chat-room-salt:' + plain);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(digest)).map(b => b.toString(16).padStart(2, '0')).join('');
}
const pages = {
  login: $('#login-page'),
  register: $('#register-page'),
  chat: $('#chat-page')
};

function showPage(name) {
  Object.values(pages).forEach(p => p.style.display = 'none');
  pages[name].style.display = 'flex';
}

$('#show-register').addEventListener('click', (e) => { e.preventDefault(); showPage('register'); });
$('#show-login').addEventListener('click', (e) => { e.preventDefault(); showPage('login'); });

$('#show-reset').addEventListener('click', async (e) => {
  e.preventDefault();
  const mail = prompt('请输入注册时使用的邮箱，我们将发送重置密码邮件：');
  if (!mail) return;
  const { error } = await supabase.auth.resetPasswordForEmail(mail.trim(), {
    redirectTo: window.location.origin
  });
  if (error) return alert('发送失败：' + error.message);
  alert('重置密码邮件已发送，请到邮箱查收');
});

$('#login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const account = $('#email').value.trim();
  let loginEmail = account;
  if (!account.includes('@')) {
    const { data: prof } = await supabase
      .from('profiles')
      .select('email')
      .eq('username', account)
      .single();
    if (!prof?.email) return alert('未找到该用户名对应的账号');
    loginEmail = prof.email;
  }
  const { data, error } = await supabase.auth.signInWithPassword({
    email: loginEmail,
    password: $('#password').value
  });
  if (error) return alert('登录失败：' + error.message);
  currentUser = data.user;
  showPage('chat');
  initChat();
});

$('#register-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const username = $('#reg-username').value.trim();
  const emailVal = $('#reg-email').value.trim();
  const pwd1 = $('#reg-password').value;
  const pwd2 = $('#reg-password2').value;
  if (pwd1 !== pwd2) return alert('两次输入的密码不一致，请重新输入');
  if (pwd1.length < 6) return alert('密码至少需要 6 位');
  const { data: existName } = await supabase
    .from('profiles')
    .select('id')
    .eq('username', username)
    .maybeSingle();
  if (existName) return alert('该用户名已被占用，请换一个');
  const { data, error } = await supabase.auth.signUp({
    email: emailVal,
    password: pwd1,
    options: { data: { username } }
  });
  if (error) return alert('注册失败：' + error.message);
  if (data?.user) {
    const { error: profErr } = await supabase.from('profiles').upsert({
      id: data.user.id,
      username,
      email: emailVal,
      avatar_url: null,
      created_at: new Date().toISOString()
    });
    if (profErr) alert('账号已创建，但资料保存失败：' + profErr.message);
  }
  alert('注册成功！请登录');
  showPage('login');
});

$('#logout-btn').addEventListener('click', async () => {
  await supabase.auth.signOut();
  currentUser = null;
  disconnectChat();
  showPage('login');
});

async function initChat() {
  await refreshUserLabel();
  await loadRooms();
}

async function ensureProfile() {
  const { data: prof } = await supabase
    .from('profiles')
    .select('username')
    .eq('id', currentUser.id)
    .maybeSingle();
  if (prof?.username) return prof.username;
  const fallback = (currentUser.email || '').split('@')[0] || '朋友';
  await supabase.from('profiles').upsert({
    id: currentUser.id,
    username: fallback,
    email: currentUser.email
  });
  return fallback;
}

async function refreshUserLabel() {
  const name = await ensureProfile();
  $('#current-user').textContent = name;
}

$('#current-user').addEventListener('click', async () => {
  const newName = prompt('输入新的昵称：');
  if (!newName) return;
  const { data: existName } = await supabase
    .from('profiles')
    .select('id')
    .eq('username', newName.trim())
    .single();
  if (existName && existName.id !== currentUser.id) return alert('该昵称已被占用');
  await supabase.from('profiles').upsert({
    id: currentUser.id,
    username: newName.trim(),
    email: currentUser.email
  });
  await refreshUserLabel();
  alert('昵称已更新');
});

async function loadRooms() {
  const { data: rooms } = await supabase
    .from('rooms')
    .select('*')
    .order('created_at', { ascending: true });

  renderRoomList(rooms || []);
}

function renderRoomList(rooms) {
  const list = $('#room-list');
  list.innerHTML = rooms.map(r => `
    <div class="room-item ${currentRoom?.id === r.id ? 'active' : ''}" data-id="${r.id}">
      # ${r.name} ${r.password ? '🔒' : ''}
    </div>
  `).join('');

  list.querySelectorAll('.room-item').forEach(el => {
    el.addEventListener('click', () => joinRoom(el.dataset.id));
  });
}

async function createRoom(name) {
  const { data: existing } = await supabase
    .from('rooms')
    .select('id')
    .eq('name', name);

  if (existing && existing.length > 0) {
    alert('聊天室名称已存在，请换一个名称');
    return;
  }

  const password = prompt('请为该聊天室设置密码（直接留空则不设密码，任何人可进入）：');
  if (password === null) return;

  const pwdHash = await hashPassword(password || '');

  const { data: room, error: roomErr } = await supabase
    .from('rooms')
    .insert({ name, created_by: currentUser.id, password: pwdHash })
    .select()
    .single();

  if (roomErr || !room?.id) return alert('创建房间失败：' + (roomErr?.message || '未能获取新房间信息'));

  const { error: memErr } = await supabase.from('room_members').insert({
    room_id: room.id,
    user_id: currentUser.id
  });
  if (memErr) alert('房间已创建，但加入成员失败：' + memErr.message);

  await loadRooms();
  joinRoom(room.id);
}

$('#manage-room-btn').addEventListener('click', async () => {
  if (!currentRoom?.isCreator) return;

  const action = prompt('输入 1 = 修改密码，2 = 解散聊天室：');
  if (action === '1') {
    const newPwd = prompt('输入新密码（留空表示取消密码）：');
    if (newPwd === null) return;
    const newHash = await hashPassword(newPwd || '');
    await supabase
      .from('rooms')
      .update({ password: newHash })
      .eq('id', currentRoom.id);
    alert('密码已更新');
    await loadRooms();
  } else if (action === '2') {
    const confirmText = prompt('解散后该聊天室及消息将不可恢复，请输入聊天室名称以确认：');
    if (confirmText === null) return;
    const { data: roomRow } = await supabase
      .from('rooms')
      .select('name')
      .eq('id', currentRoom.id)
      .single();
    if (confirmText !== roomRow?.name) {
      alert('名称不匹配，已取消解散');
      return;
    }
    await supabase.from('messages').delete().eq('room_id', currentRoom.id);
    await supabase.from('room_members').delete().eq('room_id', currentRoom.id);
    await supabase.from('rooms').delete().eq('id', currentRoom.id);
    disconnectChat();
    currentRoom = null;
    $('#messages').innerHTML = '';
    $('#manage-room-btn').style.display = 'none';
    $('#message-input').disabled = true;
    $('#send-btn').disabled = true;
    await loadRooms();
    alert('聊天室已解散');
  }
});

$('#create-room-btn').addEventListener('click', () => {
  const name = prompt('聊天室名称：');
  if (name) createRoom(name);
});

async function joinRoom(roomId) {
  const { data: roomInfo } = await supabase
    .from('rooms')
    .select('*')
    .eq('id', roomId)
    .single();

  if (!roomInfo) return;

  const isCreator = roomInfo.created_by === currentUser.id;

  if (roomInfo.password && !isCreator) {
    const input = prompt('该聊天室已加密，请输入密码：');
    if (input === null) return;
    const inputHash = await hashPassword(input);
    if (inputHash !== roomInfo.password) {
      alert('密码错误，无法进入该聊天室');
      return;
    }
  }

  disconnectChat();

  currentRoom = { id: roomId, isCreator };
  renderRoomList([]);
  await loadRooms();

  $('#chat-header span').textContent = '聊天中';
  $('#video-call-btn').style.display = 'inline-block';
  $('#message-input').disabled = false;
  $('#send-btn').disabled = false;
  $('#messages').innerHTML = '';
  $('#manage-room-btn').style.display = isCreator ? 'inline-block' : 'none';

  await loadMessages();
  connectChatSocket(roomId);
}

function disconnectChat() {
  if (chatSocket) { chatSocket.close(); chatSocket = null; }
  if (signalSocket) { signalSocket.close(); signalSocket = null; }
  currentRoom = null;
}

function connectChatSocket(roomId) {
  chatSocket = new WebSocket(`${WS_BASE}/chat/${roomId}?userId=${currentUser.id}`);

  chatSocket.addEventListener('open', () => {
    $('#chat-header span').textContent = '聊天中（已连接）';
  });

  chatSocket.addEventListener('error', (e) => {
    $('#chat-header span').textContent = '聊天中（连接失败）';
  });

  chatSocket.addEventListener('close', () => {
    $('#chat-header span').textContent = '聊天中（连接断开，2秒后重连）';
    setTimeout(() => { if (currentRoom) connectChatSocket(currentRoom.id); }, 2000);
  });

  chatSocket.addEventListener('message', (event) => {
    const data = JSON.parse(event.data);

    switch (data.type) {
      case 'message':
        appendMessage({
          sender_id: data.senderId,
          content: data.content,
          created_at: new Date(data.timestamp).toISOString()
        });
        break;

      case 'presence':
        if (data.status === 'online') {
          appendSystemMessage(`${data.userId} 上线了`);
        } else {
          appendSystemMessage(`${data.userId} 离线了`);
        }
        break;

      case 'typing':
        $('#typing-indicator').textContent = data.isTyping ? '对方正在输入...' : '';
        break;
    }
  });
}

async function appendMessage(msg) {
  const isMine = msg.sender_id === currentUser.id;
  const time = new Date(msg.created_at).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });

  let senderName = '';
  if (!isMine && msg.sender_id) {
    const { data: prof } = await supabase
      .from('profiles')
      .select('username')
      .eq('id', msg.sender_id)
      .maybeSingle();
    senderName = prof?.username || msg.sender_id.slice(0, 8);
  }

  let content = msg.content;
  if (msg.type === 'image' && msg.attachment_url) {
    content = `<img src="${msg.attachment_url}" alt="图片" onclick="window.open(this.src)">`;
  }

  const div = document.createElement('div');
  div.className = `message ${isMine ? 'mine' : 'other'}`;
  div.innerHTML = `
    ${isMine ? '' : `<div class="sender">${senderName}</div>`}
    <div>${content}</div>
    <div class="time">${time}</div>
  `;

  $('#messages').appendChild(div);
  $('#messages').scrollTop = $('#messages').scrollHeight;
}

function appendSystemMessage(text) {
  const div = document.createElement('div');
  div.style.cssText = 'text-align:center;color:#666;font-size:12px;padding:8px;';
  div.textContent = text;
  $('#messages').appendChild(div);
}

async function loadMessages() {
  const { data } = await supabase
    .from('messages')
    .select('*')
    .eq('room_id', currentRoom.id)
    .order('created_at', { ascending: true })
    .limit(50);

  $('#messages').innerHTML = '';
  (data || []).forEach(appendMessage);
  $('#messages').scrollTop = $('#messages').scrollHeight;
}

$('#message-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const input = $('#message-input');
  const content = input.value.trim();
  if (!content) return;

  input.value = '';

  await fetch(`${API_BASE}/api/messages`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${(await supabase.auth.getSession()).data.session?.access_token}`
    },
    body: JSON.stringify({
      room_id: currentRoom.id,
      sender_id: currentUser.id,
      content
    })
  });

  if (chatSocket?.readyState === WebSocket.OPEN) {
    chatSocket.send(JSON.stringify({ type: 'message', content }));
  } else {
    alert('实时连接未建立，消息已保存但不会立即显示');
  }
});

let typingTimer;
$('#message-input').addEventListener('input', () => {
  if (chatSocket?.readyState === WebSocket.OPEN) {
    chatSocket.send(JSON.stringify({ type: 'typing', isTyping: true }));
    clearTimeout(typingTimer);
    typingTimer = setTimeout(() => {
      chatSocket.send(JSON.stringify({ type: 'typing', isTyping: false }));
    }, 2000);
  }
});

$('#attach-btn').addEventListener('click', () => $('#file-input').click());

$('#file-input').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;

  const res = await fetch(`${API_BASE}/api/upload-url`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ filename: file.name, userId: currentUser.id })
  });
  const { uploadUrl, key } = await res.json();

  await fetch(uploadUrl, { method: 'PUT', body: file });

  const imageUrl = `${API_BASE}/${key}`;
  await fetch(`${API_BASE}/api/messages`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${(await supabase.auth.getSession()).data.session?.access_token}`
    },
    body: JSON.stringify({
      room_id: currentRoom.id,
      sender_id: currentUser.id,
      content: '[图片]',
      type: 'image',
      attachment_url: imageUrl
    })
  });

  if (chatSocket?.readyState === WebSocket.OPEN) {
    chatSocket.send(JSON.stringify({ type: 'message', content: '[图片]' }));
  }
});

$('#video-call-btn').addEventListener('click', startVideoCall);

async function startVideoCall() {
  $('#video-modal').style.display = 'flex';

  localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
  $('#local-video').srcObject = localStream;

  signalSocket = new WebSocket(`${WS_BASE}/signal/${currentRoom.id}?userId=${currentUser.id}`);

  peerConnection = new RTCPeerConnection({
    iceServers: [{ urls: 'stun:stun.l.google.com:19302' }]
  });

  localStream.getTracks().forEach(track => peerConnection.addTrack(track, localStream));

  peerConnection.ontrack = (event) => {
    $('#remote-video').srcObject = event.streams[0];
  };

  peerConnection.onicecandidate = (event) => {
    if (event.candidate && signalSocket?.readyState === WebSocket.OPEN) {
      signalSocket.send(JSON.stringify({
        type: 'ice-candidate',
        targetId: 'peer',
        candidate: event.candidate
      }));
    }
  };

  signalSocket.addEventListener('message', async (event) => {
    const data = JSON.parse(event.data);

    if (data.type === 'offer') {
      await peerConnection.setRemoteDescription(new RTCSessionDescription(data));
      const answer = await peerConnection.createAnswer();
      await peerConnection.setLocalDescription(answer);
      signalSocket.send(JSON.stringify({ ...answer.toJSON(), targetId: 'peer' }));
    }

    if (data.type === 'answer') {
      await peerConnection.setRemoteDescription(new RTCSessionDescription(data));
    }

    if (data.type === 'ice-candidate') {
      await peerConnection.addIceCandidate(new RTCIceCandidate(data.candidate));
    }
  });

  signalSocket.addEventListener('open', async () => {
    const offer = await peerConnection.createOffer();
    await peerConnection.setLocalDescription(offer);
    signalSocket.send(JSON.stringify({ ...offer.toJSON(), targetId: 'peer' }));
  });
}

$('#hangup-btn').addEventListener('click', () => {
  if (peerConnection) { peerConnection.close(); peerConnection = null; }
  if (signalSocket) { signalSocket.close(); signalSocket = null; }
  if (localStream) { localStream.getTracks().forEach(t => t.stop()); localStream = null; }
  $('#video-modal').style.display = 'none';
  $('#local-video').srcObject = null;
  $('#remote-video').srcObject = null;
});

$('#toggle-mic-btn').addEventListener('click', function() {
  const track = localStream?.getAudioTracks()[0];
  if (track) {
    track.enabled = !track.enabled;
    this.textContent = track.enabled ? '🎤 静音' : '🎤 取消静音';
  }
});

$('#toggle-camera-btn').addEventListener('click', function() {
  const track = localStream?.getVideoTracks()[0];
  if (track) {
    track.enabled = !track.enabled;
    this.textContent = track.enabled ? '📷 关闭摄像头' : '📷 打开摄像头';
  }
});

(async () => {
  const { data: { session } } = await supabase.auth.getSession();
  if (session) {
    currentUser = session.user;
    showPage('chat');
    await initChat();
  } else {
    showPage('login');
  }
})();
