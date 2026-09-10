import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const SUPABASE_URL = 'https://dumptrrjlwhkaepxdkye.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImR1bXB0cnJqbHdoa2FlcHhka3llIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODkwMTUzMjEsImV4cCI6MjEwNDU5MTMyMX0.NbhAFD2S-YP3BgIgyBl_WQSFTIWr3istMn6Z5boPPD0';
const WS_BASE = 'wss://chat.yuanxiangxi.workers.dev';

const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

let currentUser = null;
let currentRoom = null;
let chatSocket = null;
let signalSocket = null;
let peerConnection = null;
let localStream = null;

const $ = (sel) => document.querySelector(sel);
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

$('#login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const { data, error } = await supabase.auth.signInWithPassword({
    email: $('#email').value,
    password: $('#password').value
  });
  if (error) return alert('登录失败：' + error.message);
  currentUser = data.user;
  showPage('chat');
  initChat();
});

$('#register-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const { data, error } = await supabase.auth.signUp({
    email: $('#reg-email').value,
    password: $('#reg-password').value
  });
  if (error) return alert('注册失败：' + error.message);
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
  $('#current-user').textContent = currentUser.email;
  await loadRooms();
}

async function loadRooms() {
  const { data: memberships } = await supabase
    .from('room_members')
    .select('room_id')
    .eq('user_id', currentUser.id);

  if (!memberships?.length) {
    await createRoom('默认聊天室');
    return;
  }

  const roomIds = memberships.map(m => m.room_id);
  const { data: rooms } = await supabase
    .from('rooms')
    .select('*')
    .in('id', roomIds);

  renderRoomList(rooms || []);
}

function renderRoomList(rooms) {
  const list = $('#room-list');
  list.innerHTML = rooms.map(r => `
    <div class="room-item ${currentRoom?.id === r.id ? 'active' : ''}" data-id="${r.id}">
      # ${r.name}
    </div>
  `).join('');

  list.querySelectorAll('.room-item').forEach(el => {
    el.addEventListener('click', () => joinRoom(el.dataset.id));
  });
}

async function createRoom(name) {
  const { data: room } = await supabase
    .from('rooms')
    .insert({ name, created_by: currentUser.id })
    .select()
    .single();

  await supabase.from('room_members').insert({
    room_id: room.id,
    user_id: currentUser.id
  });

  await loadRooms();
  joinRoom(room.id);
}

$('#create-room-btn').addEventListener('click', () => {
  const name = prompt('聊天室名称：');
  if (name) createRoom(name);
});

async function joinRoom(roomId) {
  disconnectChat();

  currentRoom = { id: roomId };
  renderRoomList([]);
  await loadRooms();

  $('#chat-header span').textContent = '聊天中';
  $('#video-call-btn').style.display = 'inline-block';
  $('#message-input').disabled = false;
  $('#send-btn').disabled = false;
  $('#messages').innerHTML = '';

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

function appendMessage(msg) {
  const isMine = msg.sender_id === currentUser.id;
  const time = new Date(msg.created_at).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });

  let content = msg.content;
  if (msg.type === 'image' && msg.attachment_url) {
    content = `<img src="${msg.attachment_url}" alt="图片" onclick="window.open(this.src)">`;
  }

  const div = document.createElement('div');
  div.className = `message ${isMine ? 'mine' : 'other'}`;
  div.innerHTML = `
    ${isMine ? '' : `<div class="sender">${msg.sender_id?.slice(0, 8)}</div>`}
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

  await fetch(`${location.origin}/api/messages`, {
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

  const res = await fetch(`${location.origin}/api/upload-url`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ filename: file.name, userId: currentUser.id })
  });
  const { uploadUrl, key } = await res.json();

  await fetch(uploadUrl, { method: 'PUT', body: file });

  const imageUrl = `${location.origin}/${key}`;
  await fetch(`${location.origin}/api/messages`, {
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
