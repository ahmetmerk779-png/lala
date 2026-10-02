const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const mineflayer = require('mineflayer');
const path = require('path');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// Global Çökme Engelleyiciler
process.on('uncaughtException', (err) => {
    console.error('[Hata Engellendi]:', err.message);
});

process.on('unhandledRejection', (reason) => {
    console.error('[Söz Rejeksiyonu Engellendi]:', reason);
});

// Periyodik Bellek Temizliği (Her 1 dakikada bir)
setInterval(() => {
    if (global.gc) global.gc();
}, 60000);

const DATA_FILE = path.join(__dirname, 'bots.json');
const botPool = new Map();

let globalConfig = {
    host: '141.95.82.164',
    port: 25565,
    version: '1.20.1',
    autoPassword: 'deliyizpassword',
    autoSubServerCmd: '/server boxpvp',
    autoSubServerDelay: 3
};

const defaultBotConfigs = [
    { id: 'bot_1', username: 'Deliyiz_1', host: '141.95.82.164', port: 25565, autoPassword: 'deliyizpassword' },
    { id: 'bot_2', username: 'Deliyiz_2', host: '141.95.82.164', port: 25565, autoPassword: 'deliyizpassword' },
    { id: 'bot_3', username: 'Deliyiz_3', host: '141.95.82.164', port: 25565, autoPassword: 'deliyizpassword' }
];

function loadSavedData() {
    if (!fs.existsSync(DATA_FILE)) {
        defaultBotConfigs.forEach(cfg => {
            botPool.set(cfg.id, { ...cfg, status: 'Offline', instance: null, logs: [] });
        });
        saveDataToFile();
        return;
    }

    try {
        const rawData = fs.readFileSync(DATA_FILE, 'utf8');
        const parsed = JSON.parse(rawData);

        if (parsed.globalConfig) globalConfig = { ...globalConfig, ...parsed.globalConfig };

        if (Array.isArray(parsed.bots) && parsed.bots.length > 0) {
            botPool.clear();
            parsed.bots.forEach(b => {
                botPool.set(b.id, { ...b, status: 'Offline', instance: null, logs: [] });
            });
        }
    } catch (err) {
        console.error('[Hafıza Hatası] Kayıtlı veriler okunamadı:', err);
    }
}

function saveDataToFile() {
    try {
        const botList = Array.from(botPool.values()).map(b => ({
            id: b.id, username: b.username, host: b.host, port: b.port,
            version: b.version, autoPassword: b.autoPassword,
            autoSubServerCmd: b.autoSubServerCmd, autoSubServerDelay: b.autoSubServerDelay
        }));

        fs.writeFileSync(DATA_FILE, JSON.stringify({ globalConfig, bots: botList }, null, 2));
    } catch (err) {
        console.error('[Hafıza Hatası] Veri kaydedilemedi:', err);
    }
}

loadSavedData();

// Sohbet Spam Filtresi (Saniyede en fazla 2 sohbet mesajı gönderir)
const lastEmitTimes = new Map();

function broadcastLog(botId, text, type = 'info') {
    const now = Date.now();
    const lastTime = lastEmitTimes.get(botId) || 0;

    if (type === 'chat' && (now - lastTime < 500)) return;
    if (type === 'chat') lastEmitTimes.set(botId, now);

    const timestamp = new Date().toLocaleTimeString('tr-TR');
    const logEntry = { botId, text, timestamp, type };

    if (botPool.has(botId)) {
        const botData = botPool.get(botId);
        botData.logs.push(logEntry);
        if (botData.logs.length > 15) botData.logs.shift();
    }

    io.emit('bot-log', logEntry);
}

function startBotInstance(botId) {
    const botData = botPool.get(botId);
    if (!botData || botData.instance) return;

    const host = botData.host || globalConfig.host;
    const port = Number(botData.port || globalConfig.port);
    const version = botData.version || globalConfig.version;
    const pwd = botData.autoPassword !== undefined ? botData.autoPassword : globalConfig.autoPassword;
    const subCmd = botData.autoSubServerCmd !== undefined ? botData.autoSubServerCmd : globalConfig.autoSubServerCmd;
    const subDelay = Number(botData.autoSubServerDelay !== undefined ? botData.autoSubServerDelay : globalConfig.autoSubServerDelay) || 3;

    broadcastLog(botId, `${botData.username} bağlanıyor...`, 'info');
    botData.status = 'Connecting';
    io.emit('status-update', { botId, status: 'Connecting' });

    try {
        const bot = mineflayer.createBot({
            host: host,
            port: port,
            username: botData.username,
            version: version || false,
            viewDistance: 'tiny',
            physicsEnabled: false,
            checkTimeoutInterval: 60 * 1000,
            hideErrors: true
        });

        botData.instance = bot;

        // ENTITY VE OYUNCU ENGELLERİ (Sadece botun kendisi saklanır, diğer tüm yük silinir)
        bot.on('entitySpawn', (entity) => {
            if (bot._client && entity.id === bot._client.entityId) return;
            delete bot.entities[entity.id];
        });

        // Tab Listesindeki Oyuncu Kayıtlarını Temizler
        bot.on('playerJoined', (player) => {
            if (player.username !== botData.username) {
                delete bot.players[player.username];
            }
        });

        bot.on('spawn', () => {
            botData.status = 'Online';
            broadcastLog(botId, `⚡ ${botData.username} oyuna girdi!`, 'success');
            io.emit('status-update', { botId, status: 'Online' });

            if (subCmd && subCmd.trim() !== '') {
                setTimeout(() => {
                    if (botData.instance && botData.status === 'Online') {
                        botData.instance.chat(subCmd);
                    }
                }, subDelay * 1000);
            }
        });

        let lastAuthTime = 0;
        bot.on('messagestr', (msg) => {
            if (!msg.trim()) return;
            broadcastLog(botId, msg, 'chat');

            const lowerMsg = msg.toLowerCase();
            const now = Date.now();

            if (pwd && pwd.trim() !== '' && (now - lastAuthTime > 5000)) {
                if (lowerMsg.includes('/register') || lowerMsg.includes('kayıt ol')) {
                    lastAuthTime = now;
                    setTimeout(() => botData.instance && botData.instance.chat(`/register ${pwd} ${pwd}`), 1000);
                } else if (lowerMsg.includes('/login') || lowerMsg.includes('giriş yap')) {
                    lastAuthTime = now;
                    setTimeout(() => botData.instance && botData.instance.chat(`/login ${pwd}`), 1000);
                }
            }
        });

        const cleanupBot = (reason) => {
            if (!botData.instance) return;
            bot.removeAllListeners();
            botData.instance = null;
            botData.status = 'Offline';

            broadcastLog(botId, `🔴 ${reason}`, 'error');
            io.emit('status-update', { botId, status: 'Offline' });
            if (global.gc) global.gc();
        };

        bot.on('error', (err) => cleanupBot(`Hata: ${err.message}`));
        bot.on('kicked', (reason) => cleanupBot(`Atıldı: ${reason}`));
        bot.on('end', () => cleanupBot(`Bağlantı kesildi.`));

    } catch (err) {
        botData.status = 'Offline';
        botData.instance = null;
        broadcastLog(botId, `Başlatılamadı: ${err.message}`, 'error');
        io.emit('status-update', { botId, status: 'Offline' });
    }
}

function stopBotInstance(botId) {
    const botData = botPool.get(botId);
    if (botData && botData.instance) {
        botData.instance.quit();
        botData.instance.removeAllListeners();
        botData.instance = null;
        botData.status = 'Offline';
        broadcastLog(botId, 'Bot durduruldu.', 'warn');
        io.emit('status-update', { botId, status: 'Offline' });
        if (global.gc) global.gc();
    }
}

function startAllBots() {
    let delay = 0;
    for (const [id, botData] of botPool.entries()) {
        if (botData.status === 'Offline') {
            setTimeout(() => startBotInstance(id), delay);
            delay += 8000;
        }
    }
}

io.on('connection', (socket) => {
    const botList = Array.from(botPool.values()).map(b => ({
        id: b.id, username: b.username, host: b.host || globalConfig.host,
        port: b.port || globalConfig.port, version: b.version || globalConfig.version,
        autoPassword: b.autoPassword, autoSubServerCmd: b.autoSubServerCmd,
        autoSubServerDelay: b.autoSubServerDelay, status: b.status, logs: b.logs
    }));

    socket.emit('init-data', { botList, globalConfig });

    socket.on('start-bot', (botId) => startBotInstance(botId));
    socket.on('stop-bot', (botId) => stopBotInstance(botId));
    socket.on('start-all', () => startAllBots());
    socket.on('stop-all', () => {
        for (const id of botPool.keys()) stopBotInstance(id);
    });

    socket.on('add-bot', (data) => {
        const username = typeof data === 'string' ? data : data.username;
        if (!username) return;

        const id = 'bot_' + Date.now();
        const newBot = {
            id, username, host: globalConfig.host, port: globalConfig.port,
            version: globalConfig.version, autoPassword: globalConfig.autoPassword,
            autoSubServerCmd: globalConfig.autoSubServerCmd, autoSubServerDelay: globalConfig.autoSubServerDelay,
            status: 'Offline', instance: null, logs: []
        };

        botPool.set(id, newBot);
        saveDataToFile();
        io.emit('bot-added', newBot);
    });

    socket.on('delete-bot', (botId) => {
        stopBotInstance(botId);
        botPool.delete(botId);
        saveDataToFile();
        io.emit('bot-deleted', botId);
    });

    socket.on('send-command', ({ targetBotId, command }) => {
        if (!command) return;
        if (targetBotId === 'all') {
            botPool.forEach((botData) => {
                if (botData.instance && botData.status === 'Online') {
                    botData.instance.chat(command);
                    broadcastLog(botData.id, `> ${command}`, 'command');
                }
            });
        } else {
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
    console.log(`Panel http://localhost:${PORT} üzerinde çalışıyor.`);
});
