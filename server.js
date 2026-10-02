const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const mc = require('minecraft-protocol');
const path = require('path');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// Global Çökme ve RAM Taşması Korumaları
process.on('uncaughtException', (err) => console.error('[Hata Engellendi]:', err.message));
process.on('unhandledRejection', (reason) => console.error('[Söz Rejeksiyonu Engellendi]:', reason));

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
            botPool.set(cfg.id, { ...cfg, status: 'Offline', client: null, logs: [], isManualStop: false });
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
                botPool.set(b.id, { ...b, status: 'Offline', client: null, logs: [], isManualStop: false });
            });
        }
    } catch (err) {
        console.error('[Hafıza Okuma Hatası]', err.message);
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
        console.error('[Hafıza Kayıt Hatası]', err.message);
    }
}

loadSavedData();

function broadcastLog(botId, text, type = 'info') {
    if (!text || typeof text !== 'string' || !text.trim()) return;
    const timestamp = new Date().toLocaleTimeString('tr-TR');
    const logEntry = { botId, text, timestamp, type };

    if (botPool.has(botId)) {
        const botData = botPool.get(botId);
        botData.logs.push(logEntry);
        if (botData.logs.length > 15) botData.logs.shift();
    }
    io.emit('bot-log', logEntry);
}

// 1.20.1 PROTOKOL UYUMLU SOHBET VE KOMUT SÜRÜCÜSÜ
function sendChat(client, message) {
    if (!client) return;
    try {
        if (message.startsWith('/')) {
            // 1.20.1 Komut Paketi (Baştaki / işareti olmadan gönderilir)
            client.write('chat_command', {
                command: message.slice(1),
                timestamp: BigInt(Date.now()),
                salt: BigInt(0),
                argumentSignatures: [],
                messageCount: 0,
                acknowledged: Buffer.alloc(3)
            });
        } else {
            // 1.20.1 Normal Sohbet Paketi
            client.write('chat_message', {
                message: message,
                timestamp: BigInt(Date.now()),
                salt: BigInt(0),
                signature: Buffer.alloc(0),
                offset: 0,
                acknowledged: Buffer.alloc(3)
            });
        }
    } catch (e) {
        console.error('[Sohbet Hatası]:', e.message);
    }
}

// ÖZEL PAKET DİNLEYİCİSİ VE TEKRARLI OTO-LOGIN MEKANİZMASI
function setupCustomPacketHandler(client, botId) {
    let isSubServerJoined = false;
    const botData = botPool.get(botId);

    if (botData.authInterval) clearInterval(botData.authInterval);

    client.on('packet', (data, meta) => {
        if (meta.state !== 'play') return;

        switch (meta.name) {
            // 1. IŞINLANMA ONAYI & BAŞARILI GİRİŞ (Login Başarılı Olduğunda Tekrarlı Login'i Durdur)
            case 'position':
                try {
                    if (data.teleportId !== undefined) {
                        client.write('teleport_confirm', { teleportId: data.teleportId });
                    }
                    client.write('position', {
                        x: data.x,
                        y: data.y,
                        z: data.z,
                        onGround: true
                    });
                } catch (e) {}

                // Giriş yapıldı/ışınlanıldı: Tekrarlı login döngüsünü kapat
                if (botData.authInterval) {
                    clearInterval(botData.authInterval);
                    botData.authInterval = null;
                }

                // Alt sunucu komutunu çalıştır
                const subCmd = botData.autoSubServerCmd !== undefined ? botData.autoSubServerCmd : globalConfig.autoSubServerCmd;
                const subDelay = Number(botData.autoSubServerDelay !== undefined ? botData.autoSubServerDelay : globalConfig.autoSubServerDelay) || 4;

                if (!isSubServerJoined && subCmd && subCmd.trim() !== '') {
                    isSubServerJoined = true;
                    botData.subCmdTimer = setTimeout(() => {
                        if (botData.client && botData.status === 'Online') {
                            sendChat(client, subCmd);
                            broadcastLog(botId, `🚀 Alt sunucu komutu gönderildi: ${subCmd}`, 'success');
                        }
                    }, subDelay * 1000);
                }
                break;

            // 2. SUNUCU CANLILIK VE PING/PONG
            case 'keep_alive':
                try {
                    client.write('keep_alive', { keepAliveId: data.keepAliveId });
                } catch (e) {}
                break;

            case 'ping':
                try {
                    client.write('pong', { id: data.id });
                } catch (e) {}
                break;

            // 3. DOKU PAKETİ ONAYI
            case 'resource_pack_send':
            case 'resource_pack_push':
                try {
                    client.write('resource_pack_receive', { result: 0 });
                } catch (e) {}
                break;

            // 4. SOHBET DINLEME VE TEKRARLI LOGIN BAŞLATMA
            case 'player_chat':
            case 'system_chat':
            case 'chat':
                handleIncomingChat(data, botId, (msg) => {
                    broadcastLog(botId, msg, 'chat');
                    const lowerMsg = msg.toLowerCase();
                    const pwd = botData.autoPassword !== undefined ? botData.autoPassword : globalConfig.autoPassword;

                    if (!pwd || pwd.trim() === '') return;

                    // Eğer kilit/login mesajı algılanırsa ve halihazırda çalışan bir döngü yoksa döngüyü başlat
                    if (!botData.authInterval) {
                        if (lowerMsg.includes('/register') || lowerMsg.includes('kayıt ol') || lowerMsg.includes('kayitol')) {
                            broadcastLog(botId, `🔑 Otomatik /register döngüsü başlatıldı (3sn aralıkla)...`, 'info');
                            
                            sendChat(client, `/register ${pwd} ${pwd}`);
                            
                            botData.authInterval = setInterval(() => {
                                if (botData.client && botData.status === 'Online') {
                                    sendChat(client, `/register ${pwd} ${pwd}`);
                                } else {
                                    clearInterval(botData.authInterval);
                                    botData.authInterval = null;
                                }
                            }, 3000);

                        } else if (lowerMsg.includes('/login') || lowerMsg.includes('giriş yap') || lowerMsg.includes('giris yap')) {
                            broadcastLog(botId, `🔑 Otomatik /login döngüsü başlatıldı (3sn aralıkla)...`, 'info');
                            
                            sendChat(client, `/login ${pwd}`);
                            
                            botData.authInterval = setInterval(() => {
                                if (botData.client && botData.status === 'Online') {
                                    sendChat(client, `/login ${pwd}`);
                                } else {
                                    clearInterval(botData.authInterval);
                                    botData.authInterval = null;
                                }
                            }, 3000);
                        }
                    }
                });
                break;

            default:
                break;
        }
    });
}

function handleIncomingChat(data, botId, callback) {
    let text = '';
    try {
        if (data.plainMessage) {
            text = data.plainMessage;
        } else if (data.content) {
            text = parseJsonText(data.content);
        } else if (data.message) {
            text = parseJsonText(data.message);
        }
    } catch (e) {}

    if (text && text.trim()) callback(text);
}

function parseJsonText(json) {
    try {
        const parsed = typeof json === 'string' ? JSON.parse(json) : json;
        let str = parsed.text || '';
        if (parsed.extra && Array.isArray(parsed.extra)) {
            str += parsed.extra.map(e => (typeof e === 'string' ? e : e.text || '')).join('');
        }
        return str;
    } catch (e) {
        return String(json);
    }
}

function cleanupBot(botId, reason) {
    const botData = botPool.get(botId);
    if (!botData) return;

    if (botData.keepAliveInterval) clearInterval(botData.keepAliveInterval);
    if (botData.subCmdTimer) clearTimeout(botData.subCmdTimer);
    if (botData.reconnectTimer) clearTimeout(botData.reconnectTimer);
    if (botData.authInterval) clearInterval(botData.authInterval);

    if (botData.client) {
        try {
            botData.client.removeAllListeners();
            botData.client.end();
        } catch (e) {}
        botData.client = null;
    }

    botData.status = 'Offline';
    broadcastLog(botId, `🔴 ${reason}`, 'error');
    io.emit('status-update', { botId, status: 'Offline' });

    if (!botData.isManualStop && globalConfig.autoReconnect) {
        broadcastLog(botId, `⏳ 5 saniye içinde otomatik yeniden bağlanılıyor...`, 'warn');
        botData.reconnectTimer = setTimeout(() => {
            if (botPool.has(botId) && !botData.isManualStop && botData.status === 'Offline') {
                startBotInstance(botId);
            }
        }, 5000);
    }
}

function startBotInstance(botId) {
    const botData = botPool.get(botId);
    if (!botData || botData.client) return;

    botData.isManualStop = false;
    const host = botData.host || globalConfig.host;
    const port = Number(botData.port || globalConfig.port);
    const version = botData.version || globalConfig.version;

    broadcastLog(botId, `${botData.username} bağlanıyor (${host}:${port})...`, 'info');
    botData.status = 'Connecting';
    io.emit('status-update', { botId, status: 'Connecting' });

    try {
        const client = mc.createClient({
            host: host,
            port: port,
            username: botData.username,
            version: version || '1.20.1',
            checkTimeoutInterval: 60000,
            keepAlive: true
        });

        botData.client = client;

        setupCustomPacketHandler(client, botId);

        client.on('success', () => {
            botData.status = 'Online';
            broadcastLog(botId, `⚡ ${botData.username} sunucuya girdi!`, 'success');
            io.emit('status-update', { botId, status: 'Online' });
        });

        client.on('login', () => {
            if (botData.keepAliveInterval) clearInterval(botData.keepAliveInterval);
            botData.keepAliveInterval = setInterval(() => {
                if (botData.client && botData.status === 'Online') {
                    try {
                        client.write('look', { yaw: (Math.random() * 360) - 180, pitch: 0, onGround: true });
                    } catch (e) {}
                }
            }, 4000);
        });

        client.on('kick_disconnect', (packet) => cleanupBot(botId, `Atıldı: ${packet.reason}`));
        client.on('disconnect', (packet) => cleanupBot(botId, `Bağlantı Kesildi: ${packet.reason}`));
        client.on('error', (err) => cleanupBot(botId, `Hata: ${err.message}`));
        client.on('end', () => cleanupBot(botId, `Bağlantı sonlandı.`));

    } catch (err) {
        cleanupBot(botId, `Başlatılamadı: ${err.message}`);
    }
}

function stopBotInstance(botId) {
    const botData = botPool.get(botId);
    if (botData) {
        botData.isManualStop = true;
        cleanupBot(botId, 'Bot elle durduruldu.');
    }
}

function startAllBots() {
    let delay = 0;
    for (const [id, botData] of botPool.entries()) {
        if (botData.status === 'Offline') {
            setTimeout(() => startBotInstance(id), delay);
            delay += 2500;
        }
    }
}

// SOCKET.IO ARAYÜZ YÖNETİMİ
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
            client: null,
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
                if (botData.client && botData.status === 'Online') {
                    sendChat(botData.client, command);
                    broadcastLog(botData.id, `> ${command}`, 'command');
                }
            });
        } else {
            const botData = botPool.get(targetBotId);
            if (botData && botData.client && botData.status === 'Online') {
                sendChat(botData.client, command);
                broadcastLog(targetBotId, `> ${command}`, 'command');
            }
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Panel http://localhost:${PORT} adresinde aktif.`);
});
