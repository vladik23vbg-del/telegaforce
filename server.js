// Telegaforce server
// Run: npm install && node server.js
// Deploy free: Render.com

process.on(‘uncaughtException’, e => { console.error(‘UNCAUGHT:’, e); });
process.on(‘unhandledRejection’, e => { console.error(‘UNHANDLED:’, e); });

const http = require(‘http’);
const fs = require(‘fs’);
const path = require(‘path’);
const { WebSocketServer } = require(‘ws’);

const PORT = process.env.PORT || 3000;
const DATA_FILE = process.env.DATA_FILE || ‘./data.json’;

// ─── Persistent storage ───
let db = { users: {}, messages: {} };
try { db = { …db, …JSON.parse(fs.readFileSync(DATA_FILE, ‘utf8’)) }; } catch (_) {}
let saveTimer = null;
function save() {
if (saveTimer) return;
saveTimer = setTimeout(() => {
try { fs.writeFileSync(DATA_FILE, JSON.stringify(db)); } catch (e) { console.error(‘save error’, e); }
saveTimer = null;
}, 500);
}

// ─── HTTP server ───
const server = http.createServer((req, res) => {
const cors = {
‘Access-Control-Allow-Origin’: ‘*’,
‘Access-Control-Allow-Methods’: ‘GET, POST, PUT, DELETE, OPTIONS’,
‘Access-Control-Allow-Headers’: ‘Content-Type’
};
if (req.method === ‘OPTIONS’) { res.writeHead(204, cors); res.end(); return; }

// Serve client
if (req.url === ‘/’ || req.url === ‘/index.html’) {
try {
const html = fs.readFileSync(path.join(__dirname, ‘index.html’));
res.writeHead(200, { ‘Content-Type’: ‘text/html; charset=utf-8’ });
res.end(html);
} catch (e) {
res.writeHead(404); res.end(‘index.html not found’);
}
return;
}

// REST API
if (req.url === ‘/api/register’ && req.method === ‘POST’) {
return readJSON(req, body => {
const { username, password, firstName, lastName, middleName, avatar, display } = body;
if (!username || !password || !firstName || !lastName) {
return json(res, 400, { error: ‘Missing fields’ }, cors);
}
if (db.users[username]) return json(res, 409, { error: ‘Username taken’ }, cors);
db.users[username] = {
username, password, firstName, lastName,
middleName: middleName || ‘’,
display: display || (firstName + ’ ’ + lastName),
avatar: avatar || null,
createdAt: Date.now(),
lastSeen: Date.now()
};
save();
json(res, 200, { ok: true, user: publicUser(db.users[username]) }, cors);
});
}

if (req.url === ‘/api/login’ && req.method === ‘POST’) {
return readJSON(req, body => {
const { username, password } = body;
const u = db.users[username];
if (!u || u.password !== password) return json(res, 401, { error: ‘Wrong credentials’ }, cors);
u.lastSeen = Date.now();
save();
json(res, 200, { ok: true, user: publicUser(u) }, cors);
});
}

if (req.url === ‘/api/users’ && req.method === ‘GET’) {
const list = Object.values(db.users).map(publicUser);
return json(res, 200, list, cors);
}

if (req.url.startsWith(’/api/messages/’) && req.method === ‘GET’) {
const key = decodeURIComponent(req.url.replace(’/api/messages/’, ‘’));
return json(res, 200, db.messages[key] || [], cors);
}

// ⚠️ Account deletion - ONLY via explicit user request from Security page
if (req.url === ‘/api/delete-account’ && req.method === ‘POST’) {
return readJSON(req, body => {
const { username, password } = body;
const u = db.users[username];
if (!u || u.password !== password) return json(res, 401, { error: ‘Auth’ }, cors);
delete db.users[username];
for (const k of Object.keys(db.messages)) {
if (k.includes(username)) delete db.messages[k];
}
save();
json(res, 200, { ok: true }, cors);
});
}

res.writeHead(404, cors); res.end(‘Not found’);
});

function readJSON(req, cb) {
let data = ‘’;
req.on(‘data’, c => data += c);
req.on(‘end’, () => { try { cb(JSON.parse(data)); } catch (e) { cb({}); } });
}
function json(res, code, body, cors) {
res.writeHead(code, { …cors, ‘Content-Type’: ‘application/json’ });
res.end(JSON.stringify(body));
}
function publicUser(u) {
if (!u) return null;
const { password, …rest } = u;
return rest;
}

// ─── WebSocket: real-time delivery ───
const wss = new WebSocketServer({ server });
const clients = new Map(); // username -> Set of WebSocket

wss.on(‘connection’, ws => {
let username = null;

ws.on(‘message’, raw => {
let msg;
try { msg = JSON.parse(raw); } catch (_) { return; }

```
if (msg.type === 'auth') {
  const u = db.users[msg.username];
  if (!u || u.password !== msg.password) { ws.send(JSON.stringify({ type: 'auth-fail' })); return; }
  username = msg.username;
  if (!clients.has(username)) clients.set(username, new Set());
  clients.get(username).add(ws);
  u.lastSeen = Date.now();
  save();
  ws.send(JSON.stringify({ type: 'auth-ok' }));
  // send user list
  const list = Object.values(db.users).map(publicUser);
  ws.send(JSON.stringify({ type: 'userlist', users: list }));
  broadcastPresence(username, true);
  return;
}

if (!username) return;

if (msg.type === 'send') {
  const { to, text, medias, replyTo } = msg;
  if (!to) return;
  const isFav = to === '__fav__';
  const key = isFav ? '__fav__::' + username : [username, to].sort().join('::');
  const newMsg = {
    from: username,
    to: isFav ? username : to,
    text: (text || '').slice(0, 2000),
    ts: Date.now(),
    read: isFav,
    ...(medias && medias.length ? { medias } : {}),
    ...(replyTo ? { replyTo } : {})
  };
  db.messages[key] = db.messages[key] || [];
  db.messages[key].push(newMsg);
  save();
  sendTo(username, { type: 'msg', message: newMsg, key });
  if (!isFav && to !== username) sendTo(to, { type: 'msg', message: newMsg, key });
}

if (msg.type === 'edit') {
  const { key, ts, text } = msg;
  const arr = db.messages[key]; if (!arr) return;
  const m = arr.find(x => x.ts === ts && x.from === username);
  if (m) { m.text = text; m.edited = true; save(); broadcastChat(key, { type: 'edit', key, ts, text }); }
}

if (msg.type === 'delMsg') {
  const { key, ts } = msg;
  if (!db.messages[key]) return;
  db.messages[key] = db.messages[key].filter(m => !(m.ts === ts && m.from === username));
  save();
  broadcastChat(key, { type: 'delMsg', key, ts });
}

if (msg.type === 'react') {
  const { key, ts, emoji } = msg;
  const arr = db.messages[key]; if (!arr) return;
  const m = arr.find(x => x.ts === ts);
  if (!m) return;
  m.reactions = m.reactions || {};
  const had = (m.reactions[emoji] || []).includes(username);
  Object.keys(m.reactions).forEach(e => {
    m.reactions[e] = (m.reactions[e] || []).filter(u => u !== username);
    if (m.reactions[e].length === 0) delete m.reactions[e];
  });
  if (!had) {
    m.reactions[emoji] = m.reactions[emoji] || [];
    m.reactions[emoji].push(username);
  }
  save();
  broadcastChat(key, { type: 'react', key, ts, reactions: m.reactions });
}

if (msg.type === 'read') {
  const { key } = msg;
  if (db.messages[key]) {
    db.messages[key].forEach(m => { if (m.to === username) m.read = true; });
    save();
  }
}

if (msg.type === 'ping') {
  const u = db.users[username]; if (u) { u.lastSeen = Date.now(); }
}
```

});

ws.on(‘close’, () => {
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
for (const ws of set) { try { ws.send(data); } catch (*) {} }
}
function broadcastChat(key, payload) {
const parts = key.split(’::’);
for (const p of parts) if (p && p !== ‘**fav**’) sendTo(p, payload);
}
function broadcastPresence(uname, online) {
const data = JSON.stringify({ type: ‘presence’, username: uname, online, ts: Date.now() });
for (const set of clients.values()) for (const ws of set) { try { ws.send(data); } catch (*) {} }
}

server.listen(PORT, () => {
console.log(’Telegaforce server running on port ’ + PORT);
});
