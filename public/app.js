import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const SUPABASE_URL = location.pathname.startsWith('/letter')
  ? location.origin + '/letter/supabase'
  : 'https://dumptrrjlwhkaepxdkye.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImR1bXB0cnJqbHdoa2FlcHhka3llIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODkwMTUzMjEsImV4cCI6MjEwNDU5MTMyMX0.NbhAFD2S-YP3BgIgyBl_WQSFTIWr3istMn6Z5boPPD0';
const WS_BASE = location.pathname.startsWith('/letter')
  ? 'ws://' + location.host + '/letter'
  : 'wss://letter.yuanxiangxi039.workers.dev';
const API_BASE = location.pathname.startsWith('/letter')
  ? location.origin + '/letter'
  : 'https://letter.yuanxiangxi039.workers.dev';

const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

function uiDialog({ title, text, input = false, inputValue = '', cancelable = false }) {
  return new Promise(resolve => {
    const modal = $('#ui-modal');
    const titleEl = $('#ui-dialog-title');
    const textEl = $('#ui-dialog-text');
    const inputEl = $('#ui-dialog-input');
    const okBtn = $('#ui-dialog-ok');
    const cancelBtn = $('#ui-dialog-cancel');

    titleEl.textContent = title || '';
    textEl.textContent = text || '';
    textEl.style.display = text ? '' : 'none';
    inputEl.style.display = input ? '' : 'none';
    inputEl.value = inputValue;
    cancelBtn.style.display = cancelable ? '' : 'none';
    modal.style.display = 'flex';
    if (input) inputEl.focus();

    const close = result => {
      modal.style.display = 'none';
      okBtn.onclick = null;
      cancelBtn.onclick = null;
      inputEl.onkeydown = null;
      resolve(result);
    };

    okBtn.onclick = () => close(input ? inputEl.value : true);
    cancelBtn.onclick = () => close(input ? null : false);
    inputEl.onkeydown = e => { if (e.key === 'Enter') close(inputEl.value); };
  });
}

const uiAlert = text => uiDialog({ title: '提示', text });
const uiPrompt = (text, value = '') => uiDialog({ title: '请输入', text, input: true, inputValue: value, cancelable: true });
const uiConfirm = text => uiDialog({ title: '确认操作', text, cancelable: true });

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
  const mail = await uiPrompt('请输入注册时使用的邮箱，我们将发送重置密码邮件：');
  if (!mail) return;
  const { error } = await supabase.auth.resetPasswordForEmail(mail.trim(), {
    redirectTo: window.location.origin
  });
  if (error) return await uiAlert('发送失败：' + error.message);
  await uiAlert('重置密码邮件已发送，请到邮箱查收');
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
    if (!prof?.email) return await uiAlert('未找到该用户名对应的账号');
    loginEmail = prof.email;
  }
  const { data, error } = await supabase.auth.signInWithPassword({
    email: loginEmail,
    password: $('#password').value
  });
  if (error) return await uiAlert('登录失败：' + error.message);
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
  if (pwd1 !== pwd2) return await uiAlert('两次输入的密码不一致，请重新输入');
  if (pwd1.length < 6) return await uiAlert('密码至少需要 6 位');
  const { data: existName } = await supabase
    .from('profiles')
    .select('id')
    .eq('username', username)
    .maybeSingle();
  if (existName) return await uiAlert('该用户名已被占用，请换一个');
  const { data, error } = await supabase.auth.signUp({
    email: emailVal,
    password: pwd1,
    options: { data: { username } }
  });
  if (error) return await uiAlert('注册失败：' + error.message);
  if (data?.user) {
    const { error: profErr } = await supabase.from('profiles').upsert({
      id: data.user.id,
      username,
      email: emailVal,
      avatar_url: null,
      created_at: new Date().toISOString()
    });
    if (profErr) await uiAlert('账号已创建，但资料保存失败：' + profErr.message);
  }
  await uiAlert('注册成功！请登录');
  showPage('login');
});

$('#profile-btn').addEventListener('click', () => {
  $('#pf-username').value = $('#current-user').textContent || '';
  $('#pf-email').value = currentUser?.email || '';
  $('#profile-modal').style.display = 'flex';
});

$('#pf-close').addEventListener('click', () => {
  $('#profile-modal').style.display = 'none';
});

$('#pf-save-username').addEventListener('click', async () => {
  const newName = $('#pf-username').value.trim();
  if (!newName) return await uiAlert('用户名不能为空');
  const { data: existName } = await supabase
    .from('profiles')
    .select('id')
    .eq('username', newName)
    .maybeSingle();
  if (existName && existName.id !== currentUser.id) return await uiAlert('该用户名已被占用');
  const { error } = await supabase.from('profiles').upsert({
    id: currentUser.id,
    username: newName,
    email: currentUser.email
  });
  if (error) return await uiAlert('保存失败：' + error.message);
  await refreshUserLabel();
  await uiAlert('用户名已更新');
});

$('#pf-save-email').addEventListener('click', async () => {
  const newEmail = $('#pf-email').value.trim();
  if (!newEmail.includes('@')) return await uiAlert('请输入有效邮箱');
  const { error } = await supabase.auth.updateUser({ email: newEmail });
  if (error) return await uiAlert('更新邮箱失败：' + error.message);
  await supabase.from('profiles').upsert({
    id: currentUser.id,
    username: $('#current-user').textContent || newEmail.split('@')[0],
    email: newEmail
  });
  await uiAlert('邮箱已更新，请到新邮箱确认');
});

$('#pf-save-password').addEventListener('click', async () => {
  const newPwd = $('#pf-new-password').value;
  if (newPwd.length < 6) return await uiAlert('密码至少需要 6 位');
  const { error } = await supabase.auth.updateUser({ password: newPwd });
  if (error) return await uiAlert('更新密码失败：' + error.message);
  $('#pf-new-password').value = '';
  await uiAlert('密码已更新');
});

$('#pf-logout').addEventListener('click', async () => {
  await supabase.auth.signOut();
  currentUser = null;
  $('#profile-modal').style.display = 'none';
  disconnectChat();
  showPage('login');
});

$('#pf-delete').addEventListener('click', async () => {
  const pwd = await uiPrompt('注销账号不可恢复！请输入当前密码以确认注销：');
  if (!pwd) return;
  const email = currentUser?.email;
  const { error: signErr } = await supabase.auth.signInWithPassword({ email, password: pwd });
  if (signErr) return await uiAlert('密码错误，注销已取消');
  const uid = currentUser.id;
  const session = await supabase.auth.getSession();
  const token = session.data.session?.access_token;
  if (!token) return await uiAlert('会话已过期，请重新登录后再试');
  const res = await fetch(`${API_BASE}/api/delete-account`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${token}` }
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    return await uiAlert('注销失败：' + (err.error || '服务器错误'));
  }
  await supabase.auth.signOut();
  currentUser = null;
  $('#profile-modal').style.display = 'none';
  disconnectChat();
  showPage('login');
  await uiAlert('账号已注销');
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
  const fallback = (currentUser.email || '').split('@')[0] || '潮汐信笺';
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
  const newName = await uiPrompt('输入新的昵称：');
  if (!newName) return;
  const { data: existName } = await supabase
    .from('profiles')
    .select('id')
    .eq('username', newName.trim())
    .single();
  if (existName && existName.id !== currentUser.id) return await uiAlert('该昵称已被占用');
  await supabase.from('profiles').upsert({
    id: currentUser.id,
    username: newName.trim(),
    email: currentUser.email
  });
  await refreshUserLabel();
  await uiAlert('昵称已更新');
});

let allRooms = [];
let onlyLocked = false;
let searchKeyword = '';

async function loadRooms() {
  const { data: rooms } = await supabase
    .from('rooms')
    .select('*')
    .order('created_at', { ascending: true });

  allRooms = rooms || [];
  await renderRoomList();
}

function filteredRooms() {
  const kw = searchKeyword.trim().toLowerCase();
  return allRooms.filter(r => {
    const matchLock = onlyLocked ? !!r.password : true;
    const matchKw = kw ? (r.name || '').toLowerCase().includes(kw) : true;
    return matchLock && matchKw;
  });
}

async function renderRoomList() {
  const list = $('#room-list');
  const rooms = filteredRooms();
  if (!rooms.length) {
    list.innerHTML = '<div class="empty-tip">没有符合条件的房间</div>';
    return;
  }

  // 查询用户加入的所有房间的 last_read_at
  const { data: memberships } = await supabase
    .from('room_members')
    .select('room_id, last_read_at')
    .eq('user_id', currentUser.id);
  const readMap = {};
  (memberships || []).forEach(m => { readMap[m.room_id] = m.last_read_at; });

  // 查询每个房间的未读消息数
  const unreadMap = {};
  for (const r of rooms) {
    let query = supabase
      .from('messages')
      .select('id', { count: 'exact', head: true })
      .eq('room_id', r.id);
    if (readMap[r.id]) {
      query = query.gt('created_at', readMap[r.id]);
    }
    const { count } = await query;
    unreadMap[r.id] = count || 0;
  }

  list.innerHTML = rooms.map(r => {
    const unread = unreadMap[r.id] || 0;
    const unreadBadge = unread > 0 ? ` <span class="unread-badge">${unread > 99 ? '99+' : unread}</span>` : '';
    return `
    <div class="room-item ${currentRoom?.id === r.id ? 'active' : ''}" data-id="${r.id}">
      # ${r.name} ${r.password ? '🔒' : ''}${unreadBadge}
    </div>`;
  }).join('');

  list.querySelectorAll('.room-item').forEach(el => {
    el.addEventListener('click', () => joinRoom(el.dataset.id));
  });
}

$('#room-search').addEventListener('input', (e) => {
  searchKeyword = e.target.value || '';
  renderRoomList();
});

$('#only-locked').addEventListener('change', (e) => {
  onlyLocked = e.target.checked;
  renderRoomList();
});

async function createRoom(name) {
  const { data: existing } = await supabase
    .from('rooms')
    .select('id')
    .eq('name', name);

  if (existing && existing.length > 0) {
    await uiAlert('岛屿名称已存在，请换一个名称');
    return;
  }

  const password = await uiPrompt('请为该岛屿设置密码（直接留空则不设密码，任何人可进入）：');
  if (password === null) return;

  const pwdHash = await hashPassword(password || '');

  const { data: room, error: roomErr } = await supabase
    .from('rooms')
    .insert({ name, created_by: currentUser.id, password: pwdHash })
    .select()
    .single();

  if (roomErr || !room?.id) return await uiAlert('创建房间失败：' + (roomErr?.message || '未能获取新房间信息'));

  const { error: memErr } = await supabase.from('room_members').insert({
    room_id: room.id,
    user_id: currentUser.id
  });
  if (memErr) await uiAlert('房间已创建，但加入成员失败：' + memErr.message);

  await loadRooms();
  joinRoom(room.id);
}

$('#manage-room-btn').addEventListener('click', async () => {
  if (!currentRoom?.isCreator) return;

  const action = await uiPrompt('输入 1 = 修改密码，2 = 解散岛屿：');
  if (action === '1') {
    const newPwd = await uiPrompt('输入新密码（留空表示取消密码）：');
    if (newPwd === null) return;
    const newHash = await hashPassword(newPwd || '');
    await supabase
      .from('rooms')
      .update({ password: newHash })
      .eq('id', currentRoom.id);
    await uiAlert('密码已更新');
    await loadRooms();
  } else if (action === '2') {
    const confirmText = await uiPrompt('解散后该岛屿及消息将不可恢复，请输入岛屿名称以确认：');
    if (confirmText === null) return;
    const { data: roomRow } = await supabase
      .from('rooms')
      .select('name')
      .eq('id', currentRoom.id)
      .single();
    if (confirmText !== roomRow?.name) {
      await uiAlert('名称不匹配，已取消解散');
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
    await uiAlert('岛屿已解散');
  }
});

$('#create-room-btn').addEventListener('click', async () => {
  const name = await uiPrompt('岛屿名称：');
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
    const input = await uiPrompt('该岛屿已加密，请输入密码：');
    if (input === null) return;
    const inputHash = await hashPassword(input);
    if (inputHash !== roomInfo.password) {
      await uiAlert('密码错误，无法进入该岛屿');
      return;
    }
  }

  await supabase.from('room_members').upsert({
    room_id: roomId,
    user_id: currentUser.id,
    last_read_at: new Date().toISOString()
  });

  disconnectChat();

  currentRoom = { id: roomId, isCreator };
  document.body.classList.add('in-room');
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

  // 创建信令 WebSocket 保持连接，用于接收视频通话邀请
  if (signalSocket) { signalSocket.close(); signalSocket = null; }
  signalSocket = new WebSocket(`${WS_BASE}/signal/${roomId}?userId=${currentUser.id}`);
  setupSignalHandlers(signalSocket);

  // 滚动到顶部时加载更多历史消息
  $('#messages').addEventListener('scroll', async () => {
    if ($('#messages').scrollTop === 0 && currentRoom && !isLoadingMore) {
      await loadMoreMessages();
    }
  });
}

function disconnectChat() {
  if (currentRoom) {
    supabase.from('room_members').upsert({
      room_id: currentRoom.id,
      user_id: currentUser.id,
      last_read_at: new Date().toISOString()
    });
  }
  if (chatSocket) { chatSocket.close(); chatSocket = null; }
  if (signalSocket) { signalSocket.close(); signalSocket = null; }
  currentRoom = null;
  document.body.classList.remove('in-room');
}

$('#back-btn').addEventListener('click', async () => {
  if (currentRoom) {
    await supabase.from('room_members').upsert({
      room_id: currentRoom.id,
      user_id: currentUser.id,
      last_read_at: new Date().toISOString()
    });
  }
  disconnectChat();
  $('#chat-header span').textContent = '选择一个岛屿';
  $('#video-call-btn').style.display = 'none';
  $('#manage-room-btn').style.display = 'none';
  $('#message-input').disabled = true;
  $('#send-btn').disabled = true;
  $('#messages').innerHTML = '';
  await loadRooms();
});

let wsReconnectDelay = 1000;
const WS_MAX_RECONNECT_DELAY = 30000;

function connectChatSocket(roomId) {
  chatSocket = new WebSocket(`${WS_BASE}/chat/${roomId}?userId=${currentUser.id}`);

  chatSocket.addEventListener('open', () => {
    wsReconnectDelay = 1000;
    $('#chat-header span').textContent = '聊天中（已连接）';
  });

  chatSocket.addEventListener('error', (e) => {
    $('#chat-header span').textContent = '聊天中（连接失败）';
  });

  chatSocket.addEventListener('close', () => {
    $('#chat-header span').textContent = `聊天中（连接断开，${Math.round(wsReconnectDelay / 1000)}秒后重连）`;
    setTimeout(() => {
      if (currentRoom) {
        wsReconnectDelay = Math.min(wsReconnectDelay * 2, WS_MAX_RECONNECT_DELAY);
        connectChatSocket(currentRoom.id);
      }
    }, wsReconnectDelay);
  });

  chatSocket.addEventListener('message', async (event) => {
    const data = JSON.parse(event.data);

    switch (data.type) {
      case 'message':
        // 如果是自己发送的消息广播回来，移除临时消息
        if (data.senderId === currentUser.id) {
          const tempEls = $('#messages').querySelectorAll('[data-message-id^="temp-"]');
          tempEls.forEach(el => el.remove());
        }
        appendMessage({
          id: data.messageId,
          sender_id: data.senderId,
          content: data.content,
          type: data.messageType || 'text',
          attachment_url: data.attachmentUrl || null,
          created_at: new Date(data.timestamp).toISOString()
        });
        break;

      case 'presence': {
        const { data: prof } = await supabase
          .from('profiles')
          .select('username')
          .eq('id', data.userId)
          .maybeSingle();
        const name = prof?.username || data.userId.slice(0, 8);
        if (data.status === 'online') {
          appendSystemMessage(`${name} 上线了`);
        } else {
          appendSystemMessage(`${name} 离线了`);
        }
        break;
      }

      case 'typing':
        $('#typing-indicator').textContent = data.isTyping ? '对方正在输入...' : '';
        break;

      case 'recall':
        markRecalled(data.messageId);
        break;
    }
  });
}

async function createMessageElement(msg) {
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
  div.dataset.messageId = msg.id || '';

  if (msg.deleted) {
    div.innerHTML = `<div class="recalled">该消息已撤回</div><div class="time">${time}</div>`;
    return div;
  }

  const canRecall = isMine && msg.id && (Date.now() - new Date(msg.created_at).getTime() < 2 * 60 * 1000);
  div.innerHTML = `
    ${isMine ? '' : `<div class="sender">${senderName}</div>`}
    <div>${content}</div>
    <div class="time">${time}${canRecall ? ' <span class="recall-btn" data-id="' + msg.id + '">撤回</span>' : ''}</div>
  `;

  const recallBtn = div.querySelector('.recall-btn');
  if (recallBtn) {
    recallBtn.addEventListener('click', async () => {
      const ok = await uiConfirm('确定撤回这条消息吗？');
      if (!ok) return;
      const { error } = await supabase
        .from('messages')
        .update({ deleted: true })
        .eq('id', msg.id);
      if (error) return uiAlert('撤回失败：' + error.message);
      if (chatSocket?.readyState === WebSocket.OPEN) {
        chatSocket.send(JSON.stringify({ type: 'recall', messageId: msg.id }));
      }
      markRecalled(msg.id);
    });
  }
  return div;
}

async function appendMessage(msg) {
  const div = await createMessageElement(msg);
  $('#messages').appendChild(div);
  $('#messages').scrollTop = $('#messages').scrollHeight;

  $('#messages').appendChild(div);
  $('#messages').scrollTop = $('#messages').scrollHeight;
}

function markRecalled(messageId) {
  const el = $('#messages').querySelector(`[data-message-id="${messageId}"]`);
  if (!el) return;
  const time = el.querySelector('.time')?.textContent?.replace('撤回', '').trim() || '';
  el.innerHTML = `<div class="recalled">该消息已撤回</div><div class="time">${time}</div>`;
}

function appendSystemMessage(text) {
  const div = document.createElement('div');
  div.style.cssText = 'text-align:center;color:#666;font-size:12px;padding:8px;';
  div.textContent = text;
  $('#messages').appendChild(div);
}

let oldestTimestamp = null;
let isLoadingMore = false;

async function loadMessages() {
  const token = (await supabase.auth.getSession()).data.session?.access_token;
  const res = await fetch(`${API_BASE}/api/messages?roomId=${currentRoom.id}&limit=50`, {
    headers: { 'Authorization': `Bearer ${token}` }
  });
  const data = await res.json();

  const ordered = (data || []).reverse();
  $('#messages').innerHTML = '';
  for (const msg of ordered) {
    await appendMessage(msg);
  }
  if (ordered.length > 0) {
    oldestTimestamp = ordered[0].created_at;
  }
  $('#messages').scrollTop = $('#messages').scrollHeight;
}

async function loadMoreMessages() {
  if (isLoadingMore || !oldestTimestamp) return;
  isLoadingMore = true;

  const token = (await supabase.auth.getSession()).data.session?.access_token;
  const res = await fetch(`${API_BASE}/api/messages?roomId=${currentRoom.id}&limit=50&before=${oldestTimestamp}`, {
    headers: { 'Authorization': `Bearer ${token}` }
  });
  const data = await res.json();

  const olderMessages = (data || []).reverse();
  if (olderMessages.length === 0) {
    isLoadingMore = false;
    return;
  }

  const prevScrollHeight = $('#messages').scrollHeight;

  // 在顶部插入旧消息
  for (let i = 0; i < olderMessages.length; i++) {
    const msg = olderMessages[i];
    const div = await createMessageElement(msg);
    $('#messages').insertBefore(div, $('#messages').firstChild);
  }

  oldestTimestamp = olderMessages[0].created_at;
  // 保持滚动位置
  $('#messages').scrollTop = $('#messages').scrollHeight - prevScrollHeight;
  isLoadingMore = false;
}

$('#message-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const input = $('#message-input');
  const content = input.value.trim();
  if (!content) return;

  input.value = '';

  // 先在界面显示『发送中』状态的临时消息
  const tempId = 'temp-' + Date.now();
  const tempMsg = {
    id: tempId,
    sender_id: currentUser.id,
    content,
    type: 'text',
    created_at: new Date().toISOString()
  };
  await appendMessage(tempMsg);
  const tempEl = $('#messages').querySelector(`[data-message-id="${tempId}"]`);
  if (tempEl) {
    const timeDiv = tempEl.querySelector('.time');
    if (timeDiv) timeDiv.innerHTML += ' <span class="send-status">发送中...</span>';
  }

  try {
    if (chatSocket?.readyState === WebSocket.OPEN) {
      chatSocket.send(JSON.stringify({ type: 'message', content, roomId: currentRoom.id }));
      // WS 发送后等待广播回来替换临时消息
      // 5秒后如果仍未收到广播，标记为已发送（降级）
      setTimeout(() => {
        const el = $('#messages').querySelector(`[data-message-id="${tempId}"]`);
        if (el) {
          const status = el.querySelector('.send-status');
          if (status) status.textContent = '已发送';
        }
      }, 5000);
    } else {
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
      // REST API 发送成功，更新状态
      const el = $('#messages').querySelector(`[data-message-id="${tempId}"]`);
      if (el) {
        const status = el.querySelector('.send-status');
        if (status) status.textContent = '已发送';
      }
    }
  } catch (err) {
    const el = $('#messages').querySelector(`[data-message-id="${tempId}"]`);
    if (el) {
      const status = el.querySelector('.send-status');
      if (status) {
        status.textContent = '发送失败';
        status.style.color = '#e74c3c';
        status.style.cursor = 'pointer';
        status.onclick = () => {
          el.remove();
          $('#message-input').value = content;
          $('#message-form').dispatchEvent(new Event('submit'));
        };
      }
    }
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

  // 文件大小校验（最大 10MB）
  const MAX_FILE_SIZE = 10 * 1024 * 1024;
  if (file.size > MAX_FILE_SIZE) {
    e.target.value = '';
    return await uiAlert('文件大小不能超过 10MB');
  }

  // 文件类型校验
  const ALLOWED_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/svg+xml'];
  if (!ALLOWED_TYPES.includes(file.type)) {
    e.target.value = '';
    return await uiAlert('仅支持 JPG、PNG、GIF、WebP、SVG 格式的图片');
  }

  const res = await fetch(`${API_BASE}/api/upload-url`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ filename: file.name, userId: currentUser.id, contentType: file.type })
  });
  const { uploadUrl, key } = await res.json();

  await fetch(uploadUrl, { method: 'PUT', body: file });

  const imageUrl = `${API_BASE}/${key}`;

  if (chatSocket?.readyState === WebSocket.OPEN) {
    chatSocket.send(JSON.stringify({ type: 'message', content: '[图片]', roomId: currentRoom.id, messageType: 'image', attachmentUrl: imageUrl }));
  } else {
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
  }
});

$('#video-call-btn').addEventListener('click', startVideoCall);

let callTimeout = null;
let isCallInitiator = false;
let inviteRetry = null;

async function startVideoCall() {
  if (!signalSocket || signalSocket.readyState !== WebSocket.OPEN) {
    return await uiAlert('信令连接未建立，请稍后重试');
  }
  isCallInitiator = true;
  $('#call-invite-modal').style.display = 'flex';
  $('#call-invite-text').textContent = '正在邀请对方视频通话...';
  $('#call-invite-waiting').style.display = '';
  $('#call-invite-incoming').style.display = 'none';

  // 发送邀请（复用 joinRoom 中创建的 signalSocket）
  signalSocket.send(JSON.stringify({ type: 'invite', targetId: 'peer' }));
  console.log('[WebRTC] invite sent');
  inviteRetry = setInterval(() => {
    if (signalSocket?.readyState === WebSocket.OPEN) {
      signalSocket.send(JSON.stringify({ type: 'invite', targetId: 'peer' }));
      console.log('[WebRTC] invite resent');
    }
  }, 3000);
  callTimeout = setTimeout(() => {
    if ($('#call-invite-modal').style.display !== 'none') {
      $('#call-invite-modal').style.display = 'none';
      uiAlert('对方未接听，通话已取消');
      hangupCall();
    }
  }, 30000);
}

let hasRemoteDesc = false;
let pendingCandidates = [];

function setupSignalHandlers(ws) {
  ws.addEventListener('message', async (event) => {
    const data = JSON.parse(event.data);
    if (data.senderId === currentUser.id) return;
    console.log('[WebRTC] received:', data.type, 'from:', data.senderId?.substring(0, 8));

    try {
    if (data.type === 'invite') {
      // 收到视频通话邀请，仅在没有进行中的通话时显示来电弹窗
      if (!peerConnection && !isCallInitiator && $('#call-invite-modal').style.display === 'none' && $('#video-modal').style.display === 'none') {
        isCallInitiator = false;
      const { data: prof } = await supabase.from('profiles').select('username').eq('id', data.senderId).maybeSingle();
      const callerName = prof?.username || data.senderId.substring(0, 8);
      $('#call-invite-modal').style.display = 'flex';
      $('#call-invite-text').textContent = callerName + ' 邀请你视频通话';
      $('#call-invite-waiting').style.display = 'none';
      $('#call-invite-incoming').style.display = '';
      // 30秒超时自动拒绝
      callTimeout = setTimeout(() => {
        if ($('#call-invite-modal').style.display !== 'none') {
          $('#call-invite-modal').style.display = 'none';
          hangupCall();
        }
      }, 30000);
    }

    if (data.type === 'accept') {
      // 对方接受了邀请，发起方作为 caller 发送 offer
      if (isCallInitiator) {
        clearTimeout(callTimeout);
        if (inviteRetry) { clearInterval(inviteRetry); inviteRetry = null; }
        $('#call-invite-modal').style.display = 'none';
        await startVideoStream();
        $('#video-modal').style.display = 'flex';
        console.log('[WebRTC] call accepted, creating offer...');
        const offer = await peerConnection.createOffer();
        await peerConnection.setLocalDescription(offer);
        signalSocket.send(JSON.stringify({ type: 'offer', sdp: offer.sdp, targetId: 'peer' }));
        console.log('[WebRTC] offer sent');
      }
    }

    if (data.type === 'reject') {
      // 对方拒绝了邀请
      if (isCallInitiator) {
        clearTimeout(callTimeout);
        if (inviteRetry) { clearInterval(inviteRetry); inviteRetry = null; }
        $('#call-invite-modal').style.display = 'none';
        hangupCall();
        await uiAlert('对方已拒绝视频通话');
      }
    }

    if (data.type === 'offer') {
      // 收到 offer（接收方），回复 answer
      if (!isCallInitiator) {
        clearTimeout(callTimeout);
        $('#call-invite-modal').style.display = 'none';
        await startVideoStream();
        $('#video-modal').style.display = 'flex';
        console.log('[WebRTC] received offer, setting remote description...');
        await peerConnection.setRemoteDescription(new RTCSessionDescription({ type: 'offer', sdp: data.sdp }));
        hasRemoteDesc = true;
        const answer = await peerConnection.createAnswer();
        await peerConnection.setLocalDescription(answer);
        signalSocket.send(JSON.stringify({ type: 'answer', sdp: answer.sdp, targetId: 'peer' }));
        console.log('[WebRTC] answer sent');
        for (const c of pendingCandidates) {
          signalSocket.send(JSON.stringify({ type: 'ice-candidate', candidate: c, targetId: 'peer' }));
        }
        pendingCandidates = [];
      }
    }

    if (data.type === 'answer') {
      console.log('[WebRTC] received answer, setting remote description...');
      await peerConnection.setRemoteDescription(new RTCSessionDescription({ type: 'answer', sdp: data.sdp }));
      hasRemoteDesc = true;
      for (const c of pendingCandidates) {
        signalSocket.send(JSON.stringify({ type: 'ice-candidate', candidate: c, targetId: 'peer' }));
      }
      pendingCandidates = [];
    }

    if (data.type === 'ice-candidate') {
      if (hasRemoteDesc) {
        await peerConnection.addIceCandidate(new RTCIceCandidate(data.candidate));
      }
    }

    if (data.type === 'hangup') {
      $('#call-invite-modal').style.display = 'none';
      $('#video-modal').style.display = 'none';
      hangupCall();
      await uiAlert('对方已挂断');
    }
    } catch (err) {
      console.error('[WebRTC] error:', err);
    }
  });

  ws.addEventListener('error', (err) => {
    console.error('[WebRTC] signalSocket error:', err);
  });

  ws.addEventListener('close', (code, reason) => {
    console.log('[WebRTC] signalSocket closed:', code, reason);
  });
}

async function startVideoStream() {
  // 创建 PeerConnection
  peerConnection = new RTCPeerConnection({
    iceServers: [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' },
      { urls: 'turn:openrelay.metered.ca:80', username: 'openrelayproject', credential: 'openrelayproject' },
      { urls: 'turn:openrelay.metered.ca:443', username: 'openrelayproject', credential: 'openrelayproject' },
      { urls: 'turn:openrelay.metered.ca:443?transport=tcp', username: 'openrelayproject', credential: 'openrelayproject' }
    ]
  });

  peerConnection.onicecandidate = (event) => {
    if (event.candidate) {
      if (hasRemoteDesc && signalSocket?.readyState === WebSocket.OPEN) {
        signalSocket.send(JSON.stringify({ type: 'ice-candidate', candidate: event.candidate, targetId: 'peer' }));
      } else {
        pendingCandidates.push(event.candidate);
      }
    }
  };

  localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
  $('#local-video').srcObject = localStream;
  localStream.getTracks().forEach(track => peerConnection.addTrack(track, localStream));
  peerConnection.ontrack = (event) => {
    $('#remote-video').srcObject = event.streams[0];
  };
}

function hangupCall() {
  if (callTimeout) { clearTimeout(callTimeout); callTimeout = null; }
  if (inviteRetry) { clearInterval(inviteRetry); inviteRetry = null; }
  if (signalSocket && signalSocket.readyState === WebSocket.OPEN) {
    signalSocket.send(JSON.stringify({ type: 'hangup', targetId: 'peer' }));
  }
  if (peerConnection) { peerConnection.close(); peerConnection = null; }
  if (signalSocket) { signalSocket.close(); signalSocket = null; }
  if (localStream) { localStream.getTracks().forEach(t => t.stop()); localStream = null; }
  isCallInitiator = false;
}

// 接受视频通话
$('#call-accept-btn').addEventListener('click', async () => {
  clearTimeout(callTimeout);
  $('#call-invite-modal').style.display = 'none';
  if (signalSocket?.readyState === WebSocket.OPEN) {
    signalSocket.send(JSON.stringify({ type: 'accept', targetId: 'peer' }));
    console.log('[WebRTC] accept sent');
  }
});

// 拒绝视频通话
$('#call-reject-btn').addEventListener('click', async () => {
  clearTimeout(callTimeout);
  $('#call-invite-modal').style.display = 'none';
  if (signalSocket?.readyState === WebSocket.OPEN) {
    signalSocket.send(JSON.stringify({ type: 'reject', targetId: 'peer' }));
    console.log('[WebRTC] reject sent');
  }
  hangupCall();
});

$('#hangup-btn').addEventListener('click', () => {
  hangupCall();
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
