const http = require('http');
const WebSocket = require('ws');

const server = http.createServer((req, res) => {
  // Health-check для Render (отвечает на HTTP-запросы)
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('Telegaforce server is running');
});

const wss = new WebSocket.Server({ server });
const clients = new Map(); // username -> WebSocket

wss.on('connection', (ws) => {
  let username = null;

  ws.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw);
      if (msg.type === 'login') {
        username = msg.username;
        clients.set(username, ws);
        // Оповещаем всех об онлайне
        broadcast({ type: 'status', online: Array.from(clients.keys()) });
      } else if (msg.type === 'message') {
        const target = clients.get(msg.to);
        if (target && target.readyState === WebSocket.OPEN) {
          target.send(JSON.stringify({
            type: 'message',
            from: username,
            to: msg.to,
            text: msg.text || '',
            media: msg.media || null,
            timestamp: Date.now()
          }));
        }
      }
    } catch (e) {
      console.error('Bad message:', e);
    }
  });

  ws.on('close', () => {
    if (username) {
      clients.delete(username);
      broadcast({ type: 'status', online: Array.from(clients.keys()) });
    }
  });
});

function broadcast(data) {
  const str = JSON.stringify(data);
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) client.send(str);
  });
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
