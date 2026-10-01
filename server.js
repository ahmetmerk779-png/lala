const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const mineflayer = require('mineflayer');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// Bot Yönetim Havuzu (id -> { instance, config, status, logs })
const botPool = new Map();

// Varsayılan Varsayılan Bot Listesi
const defaultBotConfigs = [
    { id: 'bot_1', username: 'Deliyiz_1' },
    { id: 'bot_2', username: 'Deliyiz_2' },
    { id: 'bot_3', username: 'Deliyiz_3' }
];

// Varsayılan Sunucu Ayarları
let globalConfig = {
    host: '141.95.82.164', // Sunucu IP / Host adresi
    port: 25565,
    version: '1.20.1' // Gerekirse versiyon belirtin
};

// Bot Listesini Hazırla
defaultBotConfigs.forEach(cfg => {
    botPool.set(cfg.id, {
        id: cfg.id,
        username: cfg.username,
        status: 'Offline',
        instance: null,
        logs: []
    });
});

// Log Gönderici
function broadcastLog(botId, text, type = 'info') {
    const timestamp = new Date().toLocaleTimeString('tr-TR');
    const logEntry = { botId, text, timestamp, type };

    if (botPool.has(botId)) {
        const botData = botPool.get(botId);
        botData.logs.push(logEntry);
        if (botData.logs.length > 200) botData.logs.shift(); // Bellek tasarrufu
    }

    io.emit('bot-log', logEntry);
}

// Bot Başlatma Fonksiyonu
function startBotInstance(botId) {
    const botData = botPool.get(botId);
    if (!botData) return;

    if (botData.instance) {
        broadcastLog(botId, 'Bot zaten aktif durumda.', 'warn');
        return;
    }

    broadcastLog(botId, `${botData.username} sunucuya bağlanıyor...`, 'info');
    botData.status = 'Connecting';
    io.emit('status-update', { botId, status: 'Connecting' });

    try {
        const bot = mineflayer.createBot({
            host: globalConfig.host,
            port: globalConfig.port,
            username: botData.username,
            version: globalConfig.version || false
        });

        botData.instance = bot;

        bot.on('spawn', () => {
            botData.status = 'Online';
            broadcastLog(botId, `⚡ ${botData.username} oyuna giriş yaptı!`, 'success');
            io.emit('status-update', { botId, status: 'Online' });
        });

        bot.on('messagestr', (msg) => {
            if (msg.trim()) {
                broadcastLog(botId, msg, 'chat');
            }
        });

        bot.on('error', (err) => {
            broadcastLog(botId, `❌ Hata: ${err.message}`, 'error');
        });

        bot.on('kicked', (reason) => {
            broadcastLog(botId, `⚠️ Atıldı: ${reason}`, 'warn');
        });

        bot.on('end', () => {
            botData.status = 'Offline';
            botData.instance = null;
            broadcastLog(botId, `🔴 ${botData.username} bağlantısı kesildi.`, 'error');
            io.emit('status-update', { botId, status: 'Offline' });
        });

    } catch (err) {
        botData.status = 'Offline';
        botData.instance = null;
        broadcastLog(botId, `Başlatma Hatası: ${err.message}`, 'error');
        io.emit('status-update', { botId, status: 'Offline' });
    }
}

// Bot Durdurma Fonksiyonu
function stopBotInstance(botId) {
    const botData = botPool.get(botId);
    if (botData && botData.instance) {
        botData.instance.quit();
        botData.instance = null;
        botData.status = 'Offline';
        broadcastLog(botId, 'Bot durduruldu.', 'warn');
        io.emit('status-update', { botId, status: 'Offline' });
    }
}

// Socket.io Bağlantı Yöneticisi
io.on('connection', (socket) => {
    // İlk bağlanan istemciye tüm botların listesini gönder
    const botList = Array.from(botPool.values()).map(b => ({
        id: b.id,
        username: b.username,
        status: b.status,
        logs: b.logs
    }));
    socket.emit('init-data', { botList, globalConfig });

    // Tekli Bot Başlat / Durdur
    socket.on('start-bot', (botId) => startBotInstance(botId));
    socket.on('stop-bot', (botId) => stopBotInstance(botId));

    // Tüm Botları Başlat (3 saniye arayla - Anti-Bot Takılmaması İçin)
    socket.on('start-all', () => {
        let delay = 0;
        for (const [id, botData] of botPool.entries()) {
            if (botData.status === 'Offline') {
                setTimeout(() => startBotInstance(id), delay);
                delay += 3500; // Her bot arasında 3.5 saniye bekleme
            }
        }
    });

    // Tüm Botları Durdur
    socket.on('stop-all', () => {
        for (const id of botPool.keys()) {
            stopBotInstance(id);
        }
    });

    // Yeni Bot Ekleme
    socket.on('add-bot', (username) => {
        if (!username) return;
        const id = 'bot_' + Date.now();
        botPool.set(id, {
            id,
            username,
            status: 'Offline',
            instance: null,
            logs: []
        });
        io.emit('bot-added', { id, username, status: 'Offline', logs: [] });
    });

    // Komut / Sohbet Gönderme
    socket.on('send-command', ({ targetBotId, command }) => {
        if (!command) return;

        if (targetBotId === 'all') {
            // Tüm aktif botlara komut gönder
            botPool.forEach((botData) => {
                if (botData.instance && botData.status === 'Online') {
                    botData.instance.chat(command);
                    broadcastLog(botData.id, `> ${command}`, 'command');
                }
            });
        } else {
            // Seçili bota komut gönder
            const botData = botPool.get(targetBotId);
            if (botData && botData.instance && botData.status === 'Online') {
                botData.instance.chat(command);
                broadcastLog(targetBotId, `> ${command}`, 'command');
            }
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Çoklu Bot Paneli http://localhost:${PORT} üzerinde çalışıyor.`);
});
