const http = require('http');
const WebSocket = require('ws');

const server = http.createServer();
const wss = new WebSocket.Server({ server });

const clients = new Map();

wss.on('connection', (ws) => {
    let username = null;

    ws.on('message', (data) => {
        const msg = JSON.parse(data);
        if (msg.type === 'login') {
            username = msg.username;
            clients.set(username, ws);
            broadcast({ type: 'status', online: Array.from(clients.keys()) });
        } else if (msg.type === 'message') {
            const target = clients.get(msg.to);
            if (target && target.readyState === WebSocket.OPEN) {
                target.send(JSON.stringify({
                    type: 'message',
                    from: username,
                    to: msg.to,
                    text: msg.text,
                    timestamp: Date.now()
                }));
            }
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
    wss.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) client.send(JSON.stringify(data));
    });
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`WebSocket server on port ${PORT}`));
