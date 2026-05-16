process.on('uncaughtException', e => { console.error('UNCAUGHT:', e); });
process.on('unhandledRejection', e => { console.error('UNHANDLED:', e); });

console.log('[boot] starting Telegaforce server...');

const http = require('http');
const fs = require('fs');
const path = require('path');
let WebSocketServer;
try {
  WebSocketServer = require('ws').WebSocketServer;
  console.log('[boot] ws module loaded');
} catch (e) {
  console.error('[boot] CRITICAL: failed to load ws module:', e.message);
  process.exit(1);
}

const PORT = process.env.PORT || 3000;
const DATA_FILE = process.env.DATA_FILE || './data.json';

let db = { users: {}, messages: {}, groups: {} };
try {
  const raw = fs.readFileSync(DATA_FILE, 'utf8');
  db = { ...db, ...JSON.parse(raw) };
  console.log('[boot] db loaded from ' + DATA_FILE);
} catch (e) {
  console.log('[boot] starting with empty db (' + e.code + ')');
}
if (!db.users) db.users = {};
if (!db.messages) db.messages = {};
if (!db.groups) db.groups = {};

const IRIS_USERNAME = 'iris_bot';
if (!db.users[IRIS_USERNAME]) {
  db.users[IRIS_USERNAME] = {
    username: IRIS_USERNAME,
    password: '**BOT_NO_LOGIN**' + Math.random().toString(36),
    firstName: 'Ирис',
    lastName: '',
    middleName: '',
    display: 'Ирис',
    avatar: null,
    isBot: true,
    createdAt: Date.now(),
    lastSeen: Date.now()
  };
  console.log('[boot] iris_bot user created');
}
let saveTimer = null;
function save() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    try { fs.writeFileSync(DATA_FILE, JSON.stringify(db)); } catch (e) { console.error('save error', e); }
    saveTimer = null;
  }, 500);
}

const server = http.createServer((req, res) => {
  const cors = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type'
  };
  if (req.method === 'OPTIONS') { res.writeHead(204, cors); res.end(); return; }

  if (req.url === '/' || req.url === '/index.html') {
    try {
      const html = fs.readFileSync(path.join(__dirname, 'index.html'));
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html);
    } catch (e) {
      res.writeHead(404); res.end('index.html not found');
    }
    return;
  }

  if (req.url === '/api/register' && req.method === 'POST') {
    return readJSON(req, body => {
      const { username, password, firstName, lastName, middleName, avatar, display } = body;
      if (!username || !password || !firstName || !lastName) {
        return json(res, 400, { error: 'Missing fields' }, cors);
      }
      if (username === IRIS_USERNAME || username.toLowerCase().includes('iris_bot')) return json(res, 409, { error: 'Reserved username' }, cors);
      if (db.users[username]) return json(res, 409, { error: 'Username taken' }, cors);
      db.users[username] = {
        username, password, firstName, lastName,
        middleName: middleName || '',
        display: display || (firstName + ' ' + lastName),
        avatar: avatar || null,
        createdAt: Date.now(),
        lastSeen: Date.now()
      };
      save();
      broadcastUserlist();
      json(res, 200, { ok: true, user: publicUser(db.users[username]) }, cors);
    });
  }

  if (req.url === '/api/login' && req.method === 'POST') {
    return readJSON(req, body => {
      const { username, password } = body;
      const u = db.users[username];
      if (!u || u.password !== password) return json(res, 401, { error: 'Wrong credentials' }, cors);
      u.lastSeen = Date.now();
      save();
      json(res, 200, { ok: true, user: publicUser(u) }, cors);
    });
  }

  if (req.url === '/api/users' && req.method === 'GET') {
    const list = Object.values(db.users).map(publicUser);
    return json(res, 200, list, cors);
  }

  if (req.url.startsWith('/api/user/') && req.method === 'GET') {
    const uname = decodeURIComponent(req.url.replace('/api/user/', '')).toLowerCase().trim();
    const u = db.users[uname];
    if (!u) return json(res, 404, { error: 'Not found' }, cors);
    return json(res, 200, publicUser(u), cors);
  }

  if (req.url.startsWith('/api/messages/') && req.method === 'GET') {
    const key = decodeURIComponent(req.url.replace('/api/messages/', ''));
    return json(res, 200, db.messages[key] || [], cors);
  }

  if (req.url === '/api/delete-account' && req.method === 'POST') {
    return readJSON(req, body => {
      const { username, password } = body;
      const u = db.users[username];
      if (!u || u.password !== password) return json(res, 401, { error: 'Auth' }, cors);
      delete db.users[username];
      for (const k of Object.keys(db.messages)) {
        if (k.includes(username)) delete db.messages[k];
      }
      save();
      broadcastUserlist();
      json(res, 200, { ok: true }, cors);
    });
  }

  res.writeHead(404, cors); res.end('Not found');
});

function readJSON(req, cb) {
  let data = '';
  let aborted = false;
  req.on('data', c => {
    if (aborted) return;
    data += c;
    if (data.length > 8 * 1024 * 1024) { aborted = true; cb({ _tooLarge: true }); req.destroy(); }
  });
  req.on('end', () => { if (aborted) return; try { cb(JSON.parse(data)); } catch (e) { cb({}); } });
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

const wss = new WebSocketServer({ server });
const clients = new Map();

wss.on('connection', ws => {
  let username = null;

  ws.on('message', raw => {
    let msg;
    try { msg = JSON.parse(raw); } catch (_) { return; }

    if (msg.type === 'auth') {
      const u = db.users[msg.username];
      if (!u || u.password !== msg.password) { ws.send(JSON.stringify({ type: 'auth-fail' })); return; }
      username = msg.username;
      if (!clients.has(username)) clients.set(username, new Set());
      clients.get(username).add(ws);
      u.lastSeen = Date.now();
      save();
      ws.send(JSON.stringify({ type: 'auth-ok' }));
      const list = Object.values(db.users).map(publicUser);
      ws.send(JSON.stringify({ type: 'userlist', users: list }));
      const myMessages = {};
      const favK = '__fav__::' + username;
      if (db.messages[favK]) myMessages[favK] = db.messages[favK];
      for (const k of Object.keys(db.messages)) {
        if (k.includes('::') && k !== favK && !k.startsWith('group::')) {
          const parts = k.split('::');
          if (parts.includes(username)) myMessages[k] = db.messages[k];
        }
      }
      ws.send(JSON.stringify({ type: 'history', messages: myMessages }));
      const myGroups = Object.values(db.groups).filter(g => g.members.includes(username));
      ws.send(JSON.stringify({ type: 'groups', groups: myGroups }));
      const groupMsgs = {};
      for (const g of myGroups) {
        const k = 'group::' + g.id;
        if (db.messages[k]) groupMsgs[k] = db.messages[k];
      }
      ws.send(JSON.stringify({ type: 'group-history', messages: groupMsgs }));
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

    if (msg.type === 'find') {
      const target = (msg.username || '').toLowerCase().trim();
      const u = db.users[target];
      ws.send(JSON.stringify({ type: 'find-result', username: target, user: u ? publicUser(u) : null }));
    }

    if (msg.type === 'group-create') {
      const id = (msg.id && /^g_[a-z0-9_]+$/.test(msg.id)) ? msg.id : ('g_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7));
      const name = String(msg.name || 'Group').slice(0, 50);
      const members = Array.from(new Set([username, ...(msg.members || []).slice(0, 200)]));
      db.groups[id] = {
        id, name, members,
        admins: { [username]: { tag: '', perms: { edit: true, kick: true, addAdmin: true, delete: true, editMsgs: true } } },
        owner: username,
        avatar: msg.avatar || null,
        requests: {},
        createdAt: Date.now()
      };
      save();
      const payload = { type: 'group-info', group: db.groups[id] };
      for (const m of members) sendTo(m, payload);
    }

    if (msg.type === 'group-add') {
      const g = db.groups[msg.id]; if (!g) return;
      if (!g.members.includes(username)) return;
      const add = String(msg.user || '').toLowerCase();
      if (!db.users[add] || g.members.includes(add)) return;
      const targetUser = db.users[add];
      const requiresReq = targetUser.privacy && targetUser.privacy.friendsOnly;
      if (requiresReq) {
        g.requests = g.requests || {};
        if (g.requests[add]) return;
        g.requests[add] = { by: username, ts: Date.now() };
        save();
        sendTo(add, { type: 'group-request', group: { id: g.id, name: g.name, avatar: g.avatar }, by: username });
        sendTo(username, { type: 'toast', text: 'Запрос отправлен' });
        return;
      }
      g.members.push(add);
      save();
      const payload = { type: 'group-info', group: g };
      for (const m of g.members) sendTo(m, payload);
    }

    if (msg.type === 'group-req-accept') {
      const g = db.groups[msg.id]; if (!g) return;
      if (!g.requests || !g.requests[username]) return;
      delete g.requests[username];
      if (!g.members.includes(username)) g.members.push(username);
      save();
      const payload = { type: 'group-info', group: g };
      for (const m of g.members) sendTo(m, payload);
    }
    if (msg.type === 'group-req-decline') {
      const g = db.groups[msg.id]; if (!g) return;
      if (g.requests && g.requests[username]) { delete g.requests[username]; save(); }
    }

    if (msg.type === 'group-remove') {
      const g = db.groups[msg.id]; if (!g) return;
      const a = g.admins[username];
      if (!a || !(username === g.owner || (a.perms && a.perms.kick))) return;
      const rem = String(msg.user || '').toLowerCase();
      if (rem === g.owner) return;
      g.members = g.members.filter(x => x !== rem);
      delete g.admins[rem];
      save();
      const payload = { type: 'group-info', group: g };
      for (const m of [...g.members, rem]) sendTo(m, payload);
      sendTo(rem, { type: 'group-kicked', id: g.id });
    }

    if (msg.type === 'group-leave') {
      const g = db.groups[msg.id]; if (!g) return;
      if (username === g.owner) return;
      g.members = g.members.filter(x => x !== username);
      delete g.admins[username];
      save();
      const payload = { type: 'group-info', group: g };
      for (const m of g.members) sendTo(m, payload);
      sendTo(username, { type: 'group-kicked', id: g.id });
    }

    if (msg.type === 'group-admin') {
      const g = db.groups[msg.id]; if (!g) return;
      const a = g.admins[username];
      const canAdmin = username === g.owner || (a && a.perms && a.perms.addAdmin);
      if (!canAdmin) return;
      const target = String(msg.user || '').toLowerCase();
      if (!g.members.includes(target)) return;
      if (msg.add) {
        const perms = msg.perms || { edit: false, kick: false, addAdmin: false, delete: false, editMsgs: false };
        g.admins[target] = { tag: String(msg.tag || '').slice(0, 10), perms };
      } else if (target !== g.owner) delete g.admins[target];
      save();
      const payload = { type: 'group-info', group: g };
      for (const m of g.members) sendTo(m, payload);

      if (target === IRIS_USERNAME && msg.add) {
        const p = msg.perms || {};
        const allPerms = p.edit && p.kick && p.addAdmin && p.delete && p.editMsgs;
        if (allPerms) {
          setTimeout(() => {
            const key = 'group::' + g.id;
            const greet = '✨ ПРИВЕТ, ' + g.name.toUpperCase() + '! ✨\n━━━━━━━━━━━━━━\n\n💜 Меня зовут Ирис\n\nЯ очень рада, что вы доверили\nмне модерацию вашей группы.\nТеперь я готова помогать!\n\n📖 Напиши /help чтобы\n   увидеть все команды.\n\nС теплом, Ирис 🌸';
            const botMsg = { from: IRIS_USERNAME, to: g.id, text: greet, ts: Date.now(), read: false };
            db.messages[key] = db.messages[key] || [];
            db.messages[key].push(botMsg);
            save();
            const mp = { type: 'group-msg', groupId: g.id, message: botMsg };
            for (const m of g.members) sendTo(m, mp);
          }, 600);
        }
      }
    }

    if (msg.type === 'group-edit') {
      const g = db.groups[msg.id]; if (!g) return;
      const a = g.admins[username];
      if (!(username === g.owner || (a && a.perms && a.perms.edit))) return;
      if (typeof msg.name === 'string' && msg.name.trim()) g.name = msg.name.slice(0, 50);
      if (typeof msg.avatar !== 'undefined') g.avatar = msg.avatar || null;
      save();
      const payload = { type: 'group-info', group: g };
      for (const m of g.members) sendTo(m, payload);
    }

    if (msg.type === 'group-delete') {
      const g = db.groups[msg.id]; if (!g) return;
      const a = g.admins[username];
      if (!(username === g.owner || (a && a.perms && a.perms.delete))) return;
      const mems = [...g.members];
      delete db.groups[g.id];
      delete db.messages['group::' + g.id];
      save();
      for (const m of mems) sendTo(m, { type: 'group-kicked', id: g.id });
    }

    if (msg.type === 'group-clear') {
      const g = db.groups[msg.id]; if (!g) return;
      const a = g.admins[username];
      if (!(username === g.owner || a)) return;
      db.messages['group::' + g.id] = [];
      save();
      const payload = { type: 'group-clear', id: g.id };
      for (const m of g.members) sendTo(m, payload);
    }

    if (msg.type === 'group-send') {
      const g = db.groups[msg.id]; if (!g) return;
      if (!g.members.includes(username)) return;
      g.mod = g.mod || { rules: '', warns: {}, bans: {}, mutes: {} };
      const myMute = g.mod.mutes[username];
      if (myMute && (myMute.until === -1 || myMute.until > Date.now())) {
        sendTo(username, { type: 'mod-blocked', reason: 'mute', until: myMute.until });
        return;
      }
      const myBan = g.mod.bans[username];
      if (myBan && (myBan.until === -1 || myBan.until > Date.now())) {
        sendTo(username, { type: 'mod-blocked', reason: 'ban', until: myBan.until });
        return;
      }
      const key = 'group::' + g.id;
      const newMsg = {
        from: username,
        to: g.id,
        text: (msg.text || '').slice(0, 2000),
        ts: Date.now(),
        read: false,
        ...(msg.medias && msg.medias.length ? { medias: msg.medias } : {}),
        ...(msg.replyTo ? { replyTo: msg.replyTo } : {})
      };
      db.messages[key] = db.messages[key] || [];
      db.messages[key].push(newMsg);
      save();
      const payload = { type: 'group-msg', groupId: g.id, message: newMsg };
      for (const m of g.members) sendTo(m, payload);

      if (g.members.includes(IRIS_USERNAME) && newMsg.text) {
        const reply = handleIrisCommand(newMsg.text, g, username);
        if (reply) {
          setTimeout(() => {
            const botMsg = { from: IRIS_USERNAME, to: g.id, text: reply, ts: Date.now(), read: false };
            db.messages[key].push(botMsg);
            save();
            const p = { type: 'group-msg', groupId: g.id, message: botMsg };
            for (const m of g.members) sendTo(m, p);
          }, 400);
        }
      }
    }

    if (msg.type === 'ping') {
      const u = db.users[username]; if (u) { u.lastSeen = Date.now(); }
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
  for (const p of parts) if (p && p !== '**fav**') sendTo(p, payload);
}
function broadcastPresence(uname, online) {
  const data = JSON.stringify({ type: 'presence', username: uname, online, ts: Date.now() });
  for (const set of clients.values()) for (const ws of set) { try { ws.send(data); } catch (e) {} }
}
function broadcastUserlist() {
  const list = Object.values(db.users).map(publicUser);
  const data = JSON.stringify({ type: 'userlist', users: list });
  for (const set of clients.values()) for (const ws of set) { try { ws.send(data); } catch (e) {} }
}

function irisHasAllPerms(group) {
  const a = group.admins[IRIS_USERNAME];
  if (!a || !a.perms) return false;
  const p = a.perms;
  return p.edit && p.kick && p.addAdmin && p.delete && p.editMsgs;
}

function parseDuration(s) {
  if (!s) return null;
  const low = s.toLowerCase().trim();
  if (low === 'навсегда' || low === 'forever' || low === 'perm') return -1;
  const m = low.match(/^(\d+)\s*(день|дн|d|day|days|неделя|нед|w|week|weeks|час|ч|h|hour|hours|мин|m|min|месяц|мес|mo|month)?$/);
  if (!m) {
    if (low === 'день' || low === '1 день') return 86400000;
    if (low === 'неделя' || low === '1 неделя') return 7 * 86400000;
    return null;
  }
  const n = parseInt(m[1], 10);
  const unit = m[2] || 'день';
  if (/(день|дн|d|day)/.test(unit)) return n * 86400000;
  if (/(неделя|нед|w|week)/.test(unit)) return n * 7 * 86400000;
  if (/(час|ч|h|hour)/.test(unit)) return n * 3600000;
  if (/(мин|m|min)/.test(unit)) return n * 60000;
  if (/(месяц|мес|mo|month)/.test(unit)) return n * 30 * 86400000;
  return null;
}

function fmtDuration(ms) {
  if (ms === -1) return 'навсегда';
  if (ms >= 30 * 86400000) return Math.floor(ms / (30 * 86400000)) + ' мес';
  if (ms >= 86400000) return Math.floor(ms / 86400000) + ' дн';
  if (ms >= 3600000) return Math.floor(ms / 3600000) + ' ч';
  return Math.floor(ms / 60000) + ' мин';
}

function handleIrisCommand(text, group, fromUser) {
  const t = text.trim();
  const lower = t.toLowerCase();
  const mention = lower.includes('@' + IRIS_USERNAME) || lower.includes('@ирис') || lower.includes('ирис,');
  const firstWord = t.split(/\s+/)[0].toLowerCase().replace('@' + IRIS_USERNAME, '').trim();
  const cmd = firstWord;
  const arg = t.replace(/^\S+\s*/, '').trim();
  const fromName = (db.users[fromUser] && db.users[fromUser].display) || fromUser;
  const key = 'group::' + group.id;
  const allMsgs = db.messages[key] || [];
  const isOwner = fromUser === group.owner;
  const isAdmin = isOwner || !!group.admins[fromUser];
  group.mod = group.mod || { rules: '', warns: {}, bans: {}, mutes: {} };

  if (lower === 'правила' || cmd === '/rules') {
    if (!group.mod.rules) return '📜 ПРАВИЛА\n━━━━━━━━━━━━━━\n\nПравила ещё не установлены.\n\nАдмин может добавить:\n+Правила <текст>';
    return '📜 ПРАВИЛА «' + group.name + '»\n━━━━━━━━━━━━━━\n\n' + group.mod.rules;
  }

  if (/^\+правила\s+/i.test(t)) {
    if (!isAdmin) return null;
    if (!irisHasAllPerms(group)) return '⚠️ ТРЕБУЕТСЯ ДОСТУП\n━━━━━━━━━━━━━━\n\nДайте мне ВСЕ права админа\nчтобы я могла работать.';
    const rules = t.replace(/^\+правила\s+/i, '').slice(0, 1500);
    group.mod.rules = rules;
    save();
    return '✅ ПРАВИЛА СОХРАНЕНЫ\n━━━━━━━━━━━━━━\n\n' + rules;
  }

  if (lower === 'мои варны' || cmd === '/warns') {
    const w = (group.mod.warns[fromUser] || []).filter(x => !x.expires || x.expires > Date.now());
    if (w.length === 0) return '✨ ТВОИ ВАРНЫ\n━━━━━━━━━━━━━━\n\n📊 ◯ ◯ ◯   0 / 3\n\nУ тебя нет варнов, ' + fromName + '!\nПродолжай в том же духе. 💜';
    const dots = ['◯','◯','◯'];
    for (let i = 0; i < w.length; i++) dots[i] = '⬤';
    return '⚠️ ТВОИ ВАРНЫ\n━━━━━━━━━━━━━━\n\n📊 ' + dots.join(' ') + '   ' + w.length + ' / 3\n\n' + w.map((x, i) => (i + 1) + '. ' + (x.reason || 'без причины') + '\n   └ от @' + x.by).join('\n\n') + '\n\n⚡ При 3 варнах — автобан.';
  }

  if (!irisHasAllPerms(group)) {
    if (mention) return '⚠️ ТРЕБУЕТСЯ ДОСТУП\n━━━━━━━━━━━━━━\n\nДайте мне ВСЕ права админа\nчтобы я могла работать.';
    return null;
  }

  if (!isAdmin) {
    if (mention) return '🔒 ДОСТУП ОГРАНИЧЕН\n━━━━━━━━━━━━━━\n\nЯ отвечаю только админам.';
    return null;
  }

  if (cmd === '/start' || cmd === 'старт') return '✨ Привет, ' + fromName + '! ✨\n\n━━━━━━━━━━━━━━\n💜 Меня зовут Ирис\n🏠 Группа: ' + group.name + '\n━━━━━━━━━━━━━━\n\nЯ помогаю админам поддерживать порядок и развлекать участников.\n\n📖 Все команды: /help';

  if (cmd === '/help' || cmd === 'помощь') return '✨ КОМАНДЫ ИРИС ✨\n━━━━━━━━━━━━━━\n\n📊  ИНФОРМАЦИЯ\n• /stats — статистика группы\n• /me — твоя активность\n• /top — рейтинг участников\n\n🛡  МОДЕРАЦИЯ\n•  Варн @юз <причина>\n   └ 3 варна = автобан\n•  Мут @юз <срок>\n•  Бан @юз <срок>\n•  Кик @юз\n•  Размут / Разбан @юз\n\n📜  ПРАВИЛА\n•  правила — показать\n•  +Правила <текст> — задать\n\n👤  ДЛЯ СЕБЯ\n•  мои варны\n\n🎲  РАЗВЛЕЧЕНИЯ\n• /dice • /coin\n• /8ball • /random\n\n━━━━━━━━━━━━━━\n⏱  Сроки: 1 день, 2 часа,\n    неделя, месяц, навсегда';

  if (cmd === '/stats') {
    const total = allMsgs.length;
    const today = allMsgs.filter(m => Date.now() - m.ts < 86400000).length;
    const week = allMsgs.filter(m => Date.now() - m.ts < 7 * 86400000).length;
    return '📊 СТАТИСТИКА ГРУППЫ\n━━━━━━━━━━━━━━\n🏠 ' + group.name + '\n\n👥 Участников ··· ' + group.members.length + '\n💬 Сообщений ····· ' + total + '\n🌅 За сутки ······ ' + today + '\n📅 За неделю ····· ' + week + '\n\n👑 Владелец\n   └ @' + group.owner;
  }
  if (cmd === '/me') {
    const my = allMsgs.filter(m => m.from === fromUser).length;
    const w = (group.mod.warns[fromUser] || []).filter(x => !x.expires || x.expires > Date.now()).length;
    const role = fromUser === group.owner ? '👑 Владелец' : (group.admins[fromUser] ? '⭐ Админ' : '👤 Участник');
    return '👤 ТВОЙ ПРОФИЛЬ\n━━━━━━━━━━━━━━\n' + fromName + '\n@' + fromUser + '\n\n' + role + '\n💬 Сообщений ··· ' + my + '\n⚠️  Варнов ······ ' + w + ' / 3';
  }
  if (cmd === '/top') {
    const counts = {};
    allMsgs.forEach(m => { if (m.from !== IRIS_USERNAME) counts[m.from] = (counts[m.from] || 0) + 1; });
    const sorted = Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 10);
    if (sorted.length === 0) return '📈 ТОП АКТИВНЫХ\n━━━━━━━━━━━━━━\n\nПока что нет активности.\nНапиши первое сообщение!';
    const medals = ['🥇', '🥈', '🥉', '4.', '5.', '6.', '7.', '8.', '9.', '10.'];
    return '📈 ТОП АКТИВНЫХ\n━━━━━━━━━━━━━━\n\n' + sorted.map((s, i) => medals[i] + ' @' + s[0] + ' · ' + s[1] + ' соо.').join('\n');
  }
  if (cmd === '/dice') {
    const n = Math.floor(Math.random() * 6) + 1;
    const dice = ['⚀','⚁','⚂','⚃','⚄','⚅'];
    return '🎲 КУБИК\n━━━━━━━━━━\n\n' + dice[n-1] + '  ' + fromName + ' выбросил ' + n;
  }
  if (cmd === '/coin') {
    const r = Math.random() < 0.5;
    return '🪙 МОНЕТКА\n━━━━━━━━━━\n\n' + (r ? '👑 Орёл' : '🐍 Решка');
  }
  if (cmd === '/8ball') {
    if (!arg) return '🎱 МАГИЧЕСКИЙ ШАР\n━━━━━━━━━━━━━━\n\nЗадай вопрос:\n/8ball <твой вопрос>';
    const answers = ['Да, определённо','Можешь не сомневаться','Безусловно','Скорее всего','Знаки указывают на «да»','Звёзды говорят «да»','Спроси позже','Не сейчас','Туманно, попробуй снова','Я бы не рассчитывал','Очень сомневаюсь','Нет','Категорическое нет','Звёзды против'];
    return '🎱 МАГИЧЕСКИЙ ШАР\n━━━━━━━━━━━━━━\n\n❓ ' + arg + '\n\n💫 ' + answers[Math.floor(Math.random() * answers.length)];
  }
  if (cmd === '/random') {
    const n = parseInt(arg, 10);
    if (!n || n < 1) return '🎲 СЛУЧАЙНОЕ ЧИСЛО\n━━━━━━━━━━━━━━\n\nИспользуй: /random 100';
    return '🎲 СЛУЧАЙНОЕ ЧИСЛО\n━━━━━━━━━━━━━━\n\nДиапазон: 1 — ' + n + '\n✨ Выпало: ' + (Math.floor(Math.random() * n) + 1);
  }

  const modCmd = firstWord;
  if (['варн','warn','муд','мут','mute','бан','ban','кик','kick','разбан','unban','размуд','размут','unmute'].includes(modCmd)) {
    const rest = t.replace(/^\S+\s*/, '').trim();
    const um = rest.match(/^@?(\w+)\s*(.*)$/);
    if (!um) return '⚠️ Формат: ' + modCmd + ' @username <причина или срок>';
    const target = um[1].toLowerCase();
    const tail = (um[2] || '').trim();
    if (target === IRIS_USERNAME) return '😏 Меня нельзя.';
    if (target === group.owner) return '👑 Владельца нельзя.';
    if (!group.members.includes(target) && !['разбан','unban'].includes(modCmd)) return '❓ @' + target + ' не в группе.';
    const targetName = (db.users[target] && db.users[target].display) || target;

    if (['варн','warn'].includes(modCmd)) {
      group.mod.warns[target] = group.mod.warns[target] || [];
      group.mod.warns[target] = group.mod.warns[target].filter(x => !x.expires || x.expires > Date.now());
      group.mod.warns[target].push({ reason: tail || 'без причины', by: fromUser, ts: Date.now(), expires: Date.now() + 30 * 86400000 });
      const cnt = group.mod.warns[target].length;
      if (cnt >= 3) {
        group.mod.bans[target] = { until: -1, by: fromUser, ts: Date.now(), reason: 'Автобан: 3 варна' };
        group.members = group.members.filter(m => m !== target);
        delete group.admins[target];
        save();
        sendTo(target, { type: 'group-kicked', id: group.id });
        const payload = { type: 'group-info', group };
        for (const m of group.members) sendTo(m, payload);
        return '🚫 АВТОБАН\n━━━━━━━━━━━━━━\n\n@' + target + ' накопил 3 варна\nи забанен навсегда.\n\n💔 Прощальное письмо для ' + targetName + ':\n«Ты перешёл черту. Возвращайся,\nкогда подумаешь над поведением.»\n\n— Ирис';
      }
      save();
      const dots = ['◯','◯','◯'];
      for (let i = 0; i < cnt; i++) dots[i] = '⬤';
      return '⚠️ ВЫДАН ВАРН\n━━━━━━━━━━━━━━\n\n👤 @' + target + '\n📊 ' + dots.join(' ') + '   ' + cnt + ' / 3\n\n📝 Причина:\n   ' + (tail || 'не указана') + '\n\n👮 От: @' + fromUser;
    }

    if (['муд','мут','mute'].includes(modCmd)) {
      const dur = parseDuration(tail) || 3600000;
      group.mod.mutes[target] = { until: dur === -1 ? -1 : Date.now() + dur, by: fromUser };
      save();
      return '🔇 МУТ ВЫДАН\n━━━━━━━━━━━━━━\n\n👤 @' + target + '\n⏱ Срок: ' + fmtDuration(dur) + '\n👮 От: @' + fromUser + '\n\nПисать в группу нельзя.';
    }

    if (['размуд','размут','unmute'].includes(modCmd)) {
      delete group.mod.mutes[target];
      save();
      return '🔊 МУТ СНЯТ\n━━━━━━━━━━━━━━\n\n👤 @' + target + ' снова может писать.';
    }

    if (['бан','ban'].includes(modCmd)) {
      const dur = parseDuration(tail) || -1;
      group.mod.bans[target] = { until: dur === -1 ? -1 : Date.now() + dur, by: fromUser, ts: Date.now() };
      group.members = group.members.filter(m => m !== target);
      delete group.admins[target];
      save();
      sendTo(target, { type: 'group-kicked', id: group.id });
      const payload = { type: 'group-info', group };
      for (const m of group.members) sendTo(m, payload);
      return '🚫 БАН ВЫДАН\n━━━━━━━━━━━━━━\n\n👤 @' + target + '\n⏱ Срок: ' + fmtDuration(dur) + '\n👮 От: @' + fromUser;
    }

    if (['разбан','unban'].includes(modCmd)) {
      delete group.mod.bans[target];
      save();
      return '✅ БАН СНЯТ\n━━━━━━━━━━━━━━\n\n👤 @' + target + ' разблокирован.';
    }

    if (['кик','kick'].includes(modCmd)) {
      group.members = group.members.filter(m => m !== target);
      delete group.admins[target];
      save();
      sendTo(target, { type: 'group-kicked', id: group.id });
      const payload = { type: 'group-info', group };
      for (const m of group.members) sendTo(m, payload);
      return '👋 УЧАСТНИК УДАЛЁН\n━━━━━━━━━━━━━━\n\n👤 @' + target + ' выгнан из группы.';
    }
  }

  if (mention) return '✨ Я здесь!\n\nНапиши /help — покажу что умею.';
  return null;
}

server.on('error', (e) => {
  console.error('[server] error:', e.code, e.message);
  process.exit(1);
});

server.listen(PORT, '0.0.0.0', () => {
  console.log('[boot] Telegaforce server running on port ' + PORT);
});
