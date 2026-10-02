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

const DATA_FILE = path.join(__dirname, 'bots.json');
const botPool = new Map();

let globalConfig = {
    host: '141.95.82.164',
    port: 25565,
    version: '1.20.1',
    autoPassword: 'deliyizpassword',
    autoSubServerCmd: '/gir asmp',
    autoSubServerDelay: 4,
    autoReconnect: true
};

const defaultBotConfigs = [
    { id: 'bot_1', username: 'Deliyiz_1', host: '141.95.82.164', port: 25565, autoPassword: 'deliyizpassword' },
    { id: 'bot_2', username: 'Deliyiz_2', host: '141.95.82.164', port: 25565, autoPassword: 'deliyizpassword' },
    { id: 'bot_3', username: 'Deliyiz_3', host: '141.95.82.164', port: 25565, autoPassword: 'deliyizpassword' }
];

function loadSavedData() {
    if (!fs.existsSync(DATA_FILE)) {
        defaultBotConfigs.forEach(cfg => {
            botPool.set(cfg.id, { 
                ...cfg, 
                status: 'Offline', 
                instance: null, 
                logs: [],
                isManualStop: false
            });
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
                botPool.set(b.id, { 
                    ...b, 
                    status: 'Offline', 
                    instance: null, 
                    logs: [],
                    isManualStop: false
                });
            });
        }
    } catch (err) {
        console.error('[Hafıza Hatası] Kayıtlı veriler okunamadı:', err);
    }
}

function saveDataToFile() {
    try {
        const botList = Array.from(botPool.values()).map(b => ({
            id: b.id,
            username: b.username,
            host: b.host,
            port: b.port,
            version: b.version,
            autoPassword: b.autoPassword,
            autoSubServerCmd: b.autoSubServerCmd,
            autoSubServerDelay: b.autoSubServerDelay
        }));

        fs.writeFileSync(DATA_FILE, JSON.stringify({ globalConfig, bots: botList }, null, 2));
    } catch (err) {
        console.error('[Hafıza Hatası] Veri kaydedilemedi:', err);
    }
}

loadSavedData();

const lastEmitTimes = new Map();

function broadcastLog(botId, text, type = 'info') {
    if (!text || typeof text !== 'string' || !text.trim()) return;

    const now = Date.now();
    const lastTime = lastEmitTimes.get(botId) || 0;

    if (type === 'chat' && (now - lastTime < 300)) return;
    if (type === 'chat') lastEmitTimes.set(botId, now);

    const timestamp = new Date().toLocaleTimeString('tr-TR');
    const logEntry = { botId, text, timestamp, type };

    if (botPool.has(botId)) {
        const botData = botPool.get(botId);
        botData.logs.push(logEntry);
        // RAM Sızıntısını Önlemek İçin Maksimum Log Sayısı
        if (botData.logs.length > 15) botData.logs.shift();
    }

    io.emit('bot-log', logEntry);
}

// Hafif Anti-AFK (Sadece Görüş Açısı Değişimi - Sıfır Fizik Yükü)
function startOptimizedAntiAfk(botId) {
    const botData = botPool.get(botId);
    if (!botData || !botData.instance || botData.status !== 'Online') return;

    if (botData.antiAfkTimer) clearTimeout(botData.antiAfkTimer);

    const loop = () => {
        if (!botData.instance || botData.status !== 'Online') return;

        try {
            const bot = botData.instance;
            if (bot._client && bot._client.socket && !bot._client.socket.destroyed) {
                // Rastgele küçük kafa hareketi
                const yaw = (Math.random() * 360) * (Math.PI / 180);
                const pitch = (Math.random() * 40 - 20) * (Math.PI / 180);
                bot.look(yaw, pitch, true);
            }
        } catch (e) {}

        const randomDelay = Math.floor(Math.random() * 4000) + 4000;
        botData.antiAfkTimer = setTimeout(loop, randomDelay);
    };

    loop();
}

function triggerAutoReconnect(botId) {
    const botData = botPool.get(botId);
    if (!botData || botData.isManualStop) return;

    if (globalConfig.autoReconnect) {
        broadcastLog(botId, `⏳ 5 saniye içinde otomatik yeniden bağlanılıyor...`, 'warn');
        botData.reconnectTimer = setTimeout(() => {
            if (botPool.has(botId) && !botData.isManualStop && botData.status === 'Offline') {
                startBotInstance(botId);
            }
        }, 5000);
    }
}

function cleanupBot(botId, reason) {
    const botData = botPool.get(botId);
    if (!botData) return;

    if (botData.antiAfkTimer) clearTimeout(botData.antiAfkTimer);
    if (botData.subCmdTimer) clearTimeout(botData.subCmdTimer);

    if (botData.instance) {
        try {
            botData.instance.removeAllListeners();
            if (botData.instance._client) {
                botData.instance._client.removeAllListeners();
                if (botData.instance._client.socket) {
                    botData.instance._client.socket.destroy();
                }
            }
            botData.instance.end();
        } catch (e) {}
        botData.instance = null;
    }

    botData.status = 'Offline';
    broadcastLog(botId, `🔴 ${reason}`, 'error');
    io.emit('status-update', { botId, status: 'Offline' });

    triggerAutoReconnect(botId);
}

function startBotInstance(botId) {
    const botData = botPool.get(botId);
    if (!botData || botData.instance) return;

    botData.isManualStop = false;
    if (botData.reconnectTimer) clearTimeout(botData.reconnectTimer);
    if (botData.antiAfkTimer) clearTimeout(botData.antiAfkTimer);
    if (botData.subCmdTimer) clearTimeout(botData.subCmdTimer);

    const host = botData.host || globalConfig.host;
    const port = Number(botData.port || globalConfig.port);
    const version = botData.version || globalConfig.version;
    const pwd = botData.autoPassword !== undefined ? botData.autoPassword : globalConfig.autoPassword;
    const subCmd = botData.autoSubServerCmd !== undefined ? botData.autoSubServerCmd : globalConfig.autoSubServerCmd;
    const subDelay = Number(botData.autoSubServerDelay !== undefined ? botData.autoSubServerDelay : globalConfig.autoSubServerDelay) || 4;

    broadcastLog(botId, `${botData.username} bağlanıyor (${host}:${port})...`, 'info');
    botData.status = 'Connecting';
    io.emit('status-update', { botId, status: 'Connecting' });

    try {
        const bot = mineflayer.createBot({
            host: host,
            port: port,
            username: botData.username,
            version: version || false,
            checkTimeoutInterval: 90 * 1000, // Timeout süresi yükseltildi
            hideErrors: true,
            physicsEnabled: false // DİKKAT: Fizik motoru kapatıldı (Sıfır CPU yükü)
        });

        // PERFORMANS OPTİMİZASYONLARI
        bot.physicsEnabled = false;
        
        // Chunk ve Dünya Yüklemesini Engelle
        if (bot.world) {
            bot.world.columns = {};
        }

        botData.instance = bot;
        let isSubServerJoined = false;

        bot.on('login', () => {
            botData.status = 'Online';
            broadcastLog(botId, `⚡ ${botData.username} sunucuya girdi!`, 'success');
            io.emit('status-update', { botId, status: 'Online' });
        });

        bot.on('spawn', () => {
            // Fizik motorunu her spawn durumunda kapalı tut
            if (bot.physics) bot.physics.enabled = false;

            broadcastLog(botId, `🌍 Bot haritaya yüklendi.`, 'info');

            startOptimizedAntiAfk(botId);

            // Alt sunucu komutunu gecikmeli gönder
            if (!isSubServerJoined && subCmd && subCmd.trim() !== '') {
                isSubServerJoined = true;
                botData.subCmdTimer = setTimeout(() => {
                    if (botData.instance && botData.status === 'Online') {
                        bot.chat(subCmd);
                        broadcastLog(botId, `🚀 Alt sunucu komutu gönderildi: ${subCmd}`, 'success');
                    }
                }, subDelay * 1000);
            }
        });

        let lastAuthTime = 0;

        bot.on('messagestr', (message) => {
            if (!message || !message.trim()) return;

            broadcastLog(botId, message, 'chat');
            const lowerMsg = message.toLowerCase();
            const now = Date.now();

            // Otomatik Login / Register
            if (pwd && pwd.trim() !== '' && (now - lastAuthTime > 4000)) {
                if (lowerMsg.includes('/register') || lowerMsg.includes('kayıt ol') || lowerMsg.includes('kayitol')) {
                    lastAuthTime = now;
                    setTimeout(() => {
                        if (botData.instance && botData.status === 'Online') {
                            bot.chat(`/register ${pwd} ${pwd}`);
                            broadcastLog(botId, `🔑 Otomatik /register gönderildi.`, 'info');
                        }
                    }, 1000);
                } else if (lowerMsg.includes('/login') || lowerMsg.includes('giriş yap') || lowerMsg.includes('giris yap')) {
                    lastAuthTime = now;
                    setTimeout(() => {
                        if (botData.instance && botData.status === 'Online') {
                            bot.chat(`/login ${pwd}`);
                            broadcastLog(botId, `🔑 Otomatik /login gönderildi.`, 'info');
                        }
                    }, 1000);
                }
            }

            // Otomatik AFK Yanıtı
            if (lowerMsg.includes('afk misin') || lowerMsg.includes('burada misin') || lowerMsg.includes('afk kontrol')) {
                setTimeout(() => {
                    if (botData.instance && botData.status === 'Online') {
                        bot.chat('buradayim');
                        broadcastLog(botId, `💬 Otomatik AFK yanıtı verildi.`, 'info');
                    }
                }, 2000 + Math.random() * 1000);
            }
        });

        bot.on('kicked', (reason) => {
            let parsed = reason;
            try {
                if (typeof reason === 'string' && (reason.startsWith('{') || reason.startsWith('['))) {
                    parsed = JSON.parse(reason);
                }
            } catch (e) {}
            cleanupBot(botId, `Atıldı: ${typeof parsed === 'object' ? JSON.stringify(parsed) : parsed}`);
        });

        bot.on('error', (err) => cleanupBot(botId, `Hata: ${err.message}`));
        bot.on('end', () => cleanupBot(botId, `Bağlantı kesildi.`));

    } catch (err) {
        cleanupBot(botId, `Başlatılamadı: ${err.message}`);
    }
}

function stopBotInstance(botId) {
    const botData = botPool.get(botId);
    if (botData) {
        botData.isManualStop = true;
        if (botData.reconnectTimer) clearTimeout(botData.reconnectTimer);
        if (botData.antiAfkTimer) clearTimeout(botData.antiAfkTimer);
        if (botData.subCmdTimer) clearTimeout(botData.subCmdTimer);

        if (botData.instance) {
            try {
                botData.instance.removeAllListeners();
                if (botData.instance._client) {
                    botData.instance._client.removeAllListeners();
                    if (botData.instance._client.socket) {
                        botData.instance._client.socket.destroy();
                    }
                }
                botData.instance.end();
            } catch (e) {}
            botData.instance = null;
        }

        botData.status = 'Offline';
        broadcastLog(botId, 'Bot elle durduruldu.', 'warn');
        io.emit('status-update', { botId, status: 'Offline' });
    }
}

function startAllBots() {
    let delay = 0;
    for (const [id, botData] of botPool.entries()) {
        if (botData.status === 'Offline') {
            setTimeout(() => startBotInstance(id), delay);
            delay += 3500; // Sunucuyu yormamak için botlar arası gecikme
        }
    }
}

io.on('connection', (socket) => {
    const botList = Array.from(botPool.values()).map(b => ({
        id: b.id,
        username: b.username,
        host: b.host || globalConfig.host,
        port: b.port || globalConfig.port,
        version: b.version || globalConfig.version,
        autoPassword: b.autoPassword !== undefined ? b.autoPassword : globalConfig.autoPassword,
        autoSubServerCmd: b.autoSubServerCmd !== undefined ? b.autoSubServerCmd : globalConfig.autoSubServerCmd,
        autoSubServerDelay: b.autoSubServerDelay !== undefined ? b.autoSubServerDelay : globalConfig.autoSubServerDelay,
        status: b.status,
        logs: b.logs
    }));

    socket.emit('init-data', { botList, globalConfig });

    socket.on('update-config', (newConfig) => {
        globalConfig = { ...globalConfig, ...newConfig };
        saveDataToFile();
        io.emit('config-updated', globalConfig);
    });

    socket.on('update-bot-config', ({ botId, config }) => {
        if (!botPool.has(botId)) return;
        const botData = botPool.get(botId);
        Object.assign(botData, config);
        saveDataToFile();
        io.emit('bot-updated', { botId, config: botData });
    });

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
            id,
            username,
            host: typeof data === 'object' && data.host ? data.host : globalConfig.host,
            port: typeof data === 'object' && data.port ? data.port : globalConfig.port,
            version: typeof data === 'object' && data.version ? data.version : globalConfig.version,
            autoPassword: typeof data === 'object' && data.autoPassword !== undefined ? data.autoPassword : globalConfig.autoPassword,
            autoSubServerCmd: typeof data === 'object' && data.autoSubServerCmd !== undefined ? data.autoSubServerCmd : globalConfig.autoSubServerCmd,
            autoSubServerDelay: typeof data === 'object' && data.autoSubServerDelay !== undefined ? data.autoSubServerDelay : globalConfig.autoSubServerDelay,
            status: 'Offline',
            instance: null,
            logs: [],
            isManualStop: false
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
