const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// Раздаём статические файлы из папки public (не обязательно, если клиент отдельно)
app.use(express.static(path.join(__dirname, 'public')));

const clients = new Map(); // username -> ws

wss.on('connection', (ws) => {
    let username = null;

    ws.on('message', (data) => {
        try {
            const msg = JSON.parse(data);

            // Логин
            if (msg.type === 'login') {
                username = msg.username;
                clients.set(username, ws);
                // Оповещаем всех о новом онлайне
                broadcast({ type: 'status', online: Array.from(clients.keys()) });
                return;
            }

            // Пересылка сообщения
            if (msg.type === 'message') {
                const target = clients.get(msg.to);
                if (target && target.readyState === WebSocket.OPEN) {
                    target.send(JSON.stringify({
                        type: 'message',
                        from: username,
                        to: msg.to,
                        text: msg.text,
                        media: msg.media,
                        timestamp: Date.now()
                    }));
                }
                return;
            }

            // Запрос списка пользователей
            if (msg.type === 'get_users') {
                const users = Array.from(clients.keys()).filter(u => u !== username);
                ws.send(JSON.stringify({ type: 'user_list', users }));
                return;
            }

            // Пересылка refresh/profile и т.д.
            if (msg.type === 'refresh' || msg.type === 'profile') {
                // просто пересылаем всем
                broadcast(msg);
            }

        } catch (e) {
            console.error('Invalid message:', e);
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
    const message = JSON.stringify(data);
    wss.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
            client.send(message);
        }
    });
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
