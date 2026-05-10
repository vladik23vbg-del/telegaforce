// Telegaforce backend server
// Real-time messaging via WebSocket + REST for users/messages
// Run: npm install && node server.js
// Free deploy: Render.com (zero config needed)

const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3000;
const DATA_FILE = process.env.DATA_FILE || './data.json';

// ─── Persistent storage (single JSON file) ───
let db = { users: {}, messages: {}, friends: {}, requests: {}, prefs: {} };
try { db = { ...db, ...JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')) }; } catch (_) {}
let saveTimer = null;
function save() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    fs.writeFileSync(DATA_FILE, JSON.stringify(db));
    saveTimer = null;
  }, 500);
}

// ─── HTTP server (REST + serve static client) ───
const server = http.createServer((req, res) => {
  const cors = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type'
  };
  if (req.method === 'OPTIONS') { res.writeHead(204, cors); res.end(); return; }

  // Serve client HTML
  if (req.url === '/' || req.url === '/index.html') {
    try {
      const html = fs.readFileSync('messenger.html'));
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html);
    } catch (e) {
      res.writeHead(404); res.end('messenger.html not found');
    }
    return;
  }

  // REST API
  if (req.url === '/api/register' && req.method === 'POST') {
    return readJSON(req, body => {
      const { username, password, firstName, lastName, middleName, avatar } = body;
      if (!username || !password || !firstName || !lastName) {
        return json(res, 400, { error: 'Missing fields' }, cors);
      }
      if (db.users[username]) return json(res, 409, { error: 'Username taken' }, cors);
      db.users[username] = {
        username, password, firstName, lastName,
        middleName: middleName || '',
        display: firstName + ' ' + lastName,
        avatar: avatar || null,
        createdAt: Date.now(),
        permanent: true // Метка вечного аккаунта
      };
      save();
      json(res, 200, { ok: true, user: publicUser(db.users[username]) }, cors);
    });
  }

  if (req.url === '/api/login' && req.method === 'POST') {
    return readJSON(req, body => {
      const { username, password } = body;
      const u = db.users[username];
      if (!u || u.password !== password) return json(res, 401, { error: 'Wrong credentials' }, cors);
      json(res, 200, { ok: true, user: publicUser(u) }, cors);
    });
  }

  if (req.url === '/api/users' && req.method === 'GET') {
    const list = Object.values(db.users).map(publicUser);
    return json(res, 200, list, cors);
  }

  if (req.url.startsWith('/api/messages/') && req.method === 'GET') {
    const key = decodeURIComponent(req.url.replace('/api/messages/', ''));
    return json(res, 200, db.messages[key] || [], cors);
  }

  if (req.url === '/api/profile' && req.method === 'PUT') {
    return readJSON(req, body => {
      const { username, password, firstName, lastName, middleName, avatar, newUsername } = body;
      const u = db.users[username];
      if (!u || u.password !== password) return json(res, 401, { error: 'Auth' }, cors);
      
      // Запрещаем любое действие, которое может привести к удалению или обнулению профиля
      if (newUsername && newUsername !== username) {
        if (db.users[newUsername]) return json(res, 409, { error: 'Taken' }, cors);
        db.users[newUsername] = { ...u, username: newUsername };
        // Мы не удаляем старый ключ в вечном режиме, если это критично, но здесь сохраняем перенос
        delete db.users[username];
        
        const newMsgs = {};
        for (const k of Object.keys(db.messages)) {
          const parts = k.split('::');
          const a = parts[0] === username ? newUsername : parts[0];
          const b = parts[1] === username ? newUsername : parts[1];
          const nk = [a, b].sort().join('::');
          newMsgs[nk] = db.messages[k].map(m => ({
            ...m,
            from: m.from === username ? newUsername : m.from,
            to: m.to === username ? newUsername : m.to
          }));
        }
        db.messages = newMsgs;
      }
      
      const target = db.users[newUsername || username];
      if (firstName) target.firstName = firstName;
      if (lastName) target.lastName = lastName;
      if (middleName !== undefined) target.middleName = middleName;
      target.display = target.firstName + ' ' + target.lastName;
      if (avatar !== undefined) target.avatar = avatar;
      
      save();
      json(res, 200, { ok: true, user: publicUser(target) }, cors);
    });
  }

  // --- ТОТАЛЬНАЯ БЛОКИРОВКА УДАЛЕНИЯ ---
  if (req.url === '/api/delete-account' || req.method === 'DELETE') {
    return json(res, 403, { error: 'Telegaforce Policy: Accounts are permanent.' }, cors);
  }

  res.writeHead(404, cors); res.end('Not found');
});

function readJSON(req, cb) {
  let data = '';
  req.on('data', c => data += c);
  req.on('end', () => { try { cb(JSON.parse(data)); } catch (e) { cb({}); } });
}
function json(res, code, body, cors) {
  res.writeHead(code, { ...cors, 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}
function publicUser(u) {
  if (!u) return null;
  const { password, ...rest } = u;
  return rest;
}

// ─── WebSocket: real-time delivery ───
const wss = new WebSocketServer({ server });
const clients = new Map(); // username -> Set of WebSocket

wss.on('connection', ws => {
  let username = null;

  ws.on('message', raw => {
    let msg;
    try { msg = JSON.parse(raw); } catch (_) { return; }

    // Auth
    if (msg.type === 'auth') {
      const u = db.users[msg.username];
      if (!u || u.password !== msg.password) { ws.send(JSON.stringify({ type: 'auth-fail' })); return; }
      username = msg.username;
      if (!clients.has(username)) clients.set(username, new Set());
      clients.get(username).add(ws);
      u.lastSeen = Date.now();
      save();
      ws.send(JSON.stringify({ type: 'auth-ok' }));
      broadcastPresence(username, true);
      return;
    }

    if (!username) return;

    // Send message
    if (msg.type === 'send') {
      const { to, text, media, replyTo } = msg;
      if (!to) return;
      const isFav = to === '__fav__';
      const key = isFav ? `__fav__::${username}` : [username, to].sort().join('::');
      const newMsg = {
        from: username, to: isFav ? username : to,
        text: (text || '').slice(0, 2000),
        ts: Date.now(), read: isFav,
        ...(media ? { media } : {}),
        ...(replyTo ? { replyTo } : {})
      };
      db.messages[key] = db.messages[key] || [];
      db.messages[key].push(newMsg);
      save();
      sendTo(username, { type: 'msg', message: newMsg, key });
      if (!isFav && to !== username) sendTo(to, { type: 'msg', message: newMsg, key });
    }

    // Edit
    if (msg.type === 'edit') {
      const { key, ts, text } = msg;
      const arr = db.messages[key]; if (!arr) return;
      const m = arr.find(x => x.ts === ts && x.from === username);
      if (m) { m.text = text; m.edited = true; save(); broadcastChat(key, { type: 'edit', key, ts, text }); }
    }

    // Delete message
    if (msg.type === 'delMsg') {
      const { key, ts } = msg;
      if (!db.messages[key]) return;
      db.messages[key] = db.messages[key].filter(m => !(m.ts === ts && m.from === username));
      save();
      broadcastChat(key, { type: 'delMsg', key, ts });
    }

    // Reaction
    if (msg.type === 'react') {
      const { key, ts, emoji } = msg;
      const arr = db.messages[key]; if (!arr) return;
      const m = arr.find(x => x.ts === ts);
      if (!m) return;
      m.reactions = m.reactions || {};
      m.reactions[emoji] = m.reactions[emoji] || [];
      const i = m.reactions[emoji].indexOf(username);
      if (i >= 0) m.reactions[emoji].splice(i, 1);
      else m.reactions[emoji].push(username);
      if (m.reactions[emoji].length === 0) delete m.reactions[emoji];
      save();
      broadcastChat(key, { type: 'react', key, ts, reactions: m.reactions });
    }

    // ЗАПРЕТ УДАЛЕНИЯ ЧАТА (ВЕЧНОЕ ХРАНЕНИЕ)
    if (msg.type === 'delChat') {
       // Функция просто игнорируется для сохранения "вечности"
       sendTo(username, { type: 'error', text: 'Telegaforce: Chats cannot be deleted.' });
       return;
    }

    // Mark read
    if (msg.type === 'read') {
      const { key } = msg;
      if (db.messages[key]) {
        db.messages[key].forEach(m => { if (m.to === username) m.read = true; });
        save();
      }
    }

    // Typing presence ping
    if (msg.type === 'ping') {
      const u = db.users[username]; if (u) u.lastSeen = Date.now();
    }
    
    // ФУНКЦИЯ ВЕЧНОГО АККАУНТА - БЛОКИРОВКА УДАЛЕНИЯ ЧЕРЕЗ СОКЕТ
    if (msg.type === 'deleteAccount') {
       ws.send(JSON.stringify({ type: 'error', text: 'Action Forbidden' }));
       return;
    }

  });

  ws.on('close', () => {
    if (!username) return;
    const set = clients.get(username);
    if (set) { set.delete(ws); if (set.size === 0) clients.delete(username); }
    broadcastPresence(username, false);
  });
});

function sendTo(uname, payload) {
  const set = clients.get(uname);
  if (!set) return;
  const data = JSON.stringify(payload);
  for (const ws of set) { try { ws.send(data); } catch (e) {} }
}
function broadcastChat(key, payload) {
  const parts = key.split('::');
  for (const p of parts) sendTo(p, payload);
}
function broadcastPresence(uname, online) {
  const data = JSON.stringify({ type: 'presence', username: uname, online, ts: Date.now() });
  for (const set of clients.values()) for (const ws of set) { try { ws.send(data); } catch (e) {} }
}

server.listen(PORT, () => {
  console.log(`Telegaforce server on :${PORT}`);
  console.log(`Protection mode: PERMANENT ACCOUNTS ENABLED`);
});
