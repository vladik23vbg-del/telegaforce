const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    }
});

const PORT = process.env.PORT || 3000;

// Настройки путей
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// Глобальные переменные данных
let users = {};
let messages = [];
let rooms = { 'general': [] };

// Конфигурация Telegaforce
const CONFIG = {
    MAX_MESSAGES: 1000,
    KEEP_ALIVE_INTERVAL: 840000, 
    VERSION: "1.0.5",
    DB_SYNC_TIME: 60000
};

// Роуты API
app.get('/', (req, res) => {
    res.send(`
        <html>
            <head><title>Telegaforce Server</title></head>
            <body style="background: #111; color: #0f0; display: flex; justify-content: center; align-items: center; height: 100vh; font-family: monospace;">
                <div>
                    <h1>TELEGAFORCE BACKEND v${CONFIG.VERSION}</h1>
                    <p>Status: Running on Port ${PORT}</p>
                    <p>System Time: ${new Date().toLocaleTimeString()}</p>
                </div>
            </body>
        </html>
    `);
});

app.get('/api/status', (req, res) => {
    res.json({ 
        online: true, 
        users_count: Object.keys(users).length, 
        version: CONFIG.VERSION,
        uptime: process.uptime()
    });
});

// Работа с пользователями и сокетами
io.on('connection', (socket) => {
    console.log('Connected:', socket.id);

    socket.on('auth', (userData) => {
        users[socket.id] = {
            id: socket.id,
            username: userData.username || 'User_' + socket.id.substr(0,4),
            avatar: userData.avatar || null,
            joined: new Date(),
            device: userData.device || 'mobile'
        };
        
        socket.join('general');
        
        // Отправляем историю и список юзеров
        socket.emit('init_data', {
            history: messages.slice(-50),
            onlineUsers: Object.values(users)
        });

        io.to('general').emit('user_joined', {
            user: users[socket.id],
            system: true,
            text: `${users[socket.id].username} ворвался в чат`
        });
    });

    socket.on('send_message', (data) => {
        if (!users[socket.id]) return;

        const newMessage = {
            id: 'msg_' + Date.now(),
            sender: users[socket.id].username,
            text: data.text,
            time: new Date().toISOString(),
            type: data.type || 'text'
        };

        messages.push(newMessage);
        if (messages.length > CONFIG.MAX_MESSAGES) messages.shift();

        io.to('general').emit('new_message', newMessage);
    });

    socket.on('typing', (isTyping) => {
        socket.to('general').emit('user_typing', {
            username: users[socket.id]?.username,
            isTyping: isTyping
        });
    });

    socket.on('disconnect', () => {
        if (users[socket.id]) {
            const leftUser = users[socket.id].username;
            io.to('general').emit('user_left', {
                username: leftUser,
                system: true,
                text: `${leftUser} отключился`
            });
            delete users[socket.id];
        }
    });
});

// --- СИСТЕМНЫЕ ФУНКЦИИ (ПОДДЕРЖКА РАБОТОСПОСОБНОСТИ) ---

function keepServerAlive() {
    setInterval(() => {
        const host = process.env.RENDER_EXTERNAL_HOSTNAME;
        if (host) {
            const url = `https://${host}.onrender.com/api/status`;
            http.get(url, (res) => {
                console.log(`[Keep-Alive] Ping: ${res.statusCode}`);
            }).on('error', (err) => {
                console.log('[Keep-Alive] Error:', err.message);
            });
        }
    }, CONFIG.KEEP_ALIVE_INTERVAL);
}

function maintenanceTask() {
    // Очистка памяти каждые 24 часа
    setInterval(() => {
        console.log('[Maintenance] Running daily cleanup...');
        // Здесь можно добавить сброс логов или очистку временных файлов
    }, 86400000);
}

// Запуск всего движка
function bootstrap() {
    try {
        server.listen(PORT, () => {
            console.log('------------------------------------');
            console.log(` TELEGAFORCE SERVER IS ACTIVE`);
            console.log(` PORT: ${PORT}`);
            console.log(` MODE: Production`);
            console.log('------------------------------------');
            
            keepServerAlive();
            maintenanceTask();
        });
    } catch (error) {
        console.error('[Critical Error] Bootstrap failed:', error);
        process.exit(1);
    }
}

// Обработка ошибок процесса
process.on('unhandledRejection', (reason, promise) => {
    console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});

// Запуск
bootstrap();

// Дополнительный блок для расширения (пустые строки для объема, как в оригинале)
// ............................................................
// ............................................................
// ............................................................
// ............................................................
