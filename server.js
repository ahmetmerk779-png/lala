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
    autoSubServerDelay: 5,
    autoReconnect: true
};

const defaultBotConfigs = [
    { id: 'bot_1', username: 'Deliyiz_1', host: '141.95.82.164', port: 25565, autoPassword: 'deliyizpassword' },
    { id: 'bot_2', username: 'Deliyiz_2', host: '141.95.82.164', port: 25565, autoPassword: 'deliyizpassword' },
    { id: 'bot_3', username: 'Deliyiz_3', host: '141.95.82.164', port: 25565, autoPassword: 'deliyizpassword' }
];

// Soket Kapalıyken Paket Yazıp EPIPE Hatasını Engelleyen Güvenli Yazıcı
function safeWrite(client, packetName, packetData) {
    try {
        if (client && client.socket && !client.socket.destroyed && !client.ended) {
            client.write(packetName, packetData);
        }
    } catch (e) {
        // Soket kapalıyken gönderilmek istenen paketleri yutar
    }
}

// Gelen Karmaşık JSON Sohbet Paketlerinden Düz Metni Ayıklayıcı
function extractText(obj) {
    if (!obj) return '';
    
    if (typeof obj === 'string') {
        if (obj.startsWith('{') || obj.startsWith('[')) {
            try {
                return extractText(JSON.parse(obj));
            } catch (e) {
                return obj;
            }
        }
        return obj;
    }
    
    let result = '';
    if (obj.text) result += obj.text;
    
    if (Array.isArray(obj.extra)) {
        for (const child of obj.extra) result += extractText(child);
    }
    
    if (Array.isArray(obj.with)) {
        for (const child of obj.with) result += extractText(child);
    }

    return result;
}

function parseChatMessage(packet) {
    try {
        if (!packet) return '';
        if (packet.content) return extractText(packet.content);
        if (packet.message) return extractText(packet.message);
        if (packet.unsignedContent) return extractText(packet.unsignedContent);
        return extractText(packet);
    } catch (e) {
        return '';
    }
}

function loadSavedData() {
    if (!fs.existsSync(DATA_FILE)) {
        defaultBotConfigs.forEach(cfg => {
            botPool.set(cfg.id, { 
                ...cfg, 
                status: 'Offline', 
                instance: null, 
                logs: [],
                pos: { x: 0, y: 64, z: 0, yaw: 0, pitch: 0 },
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
                    pos: { x: 0, y: 64, z: 0, yaw: 0, pitch: 0 },
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
        if (botData.logs.length > 20) botData.logs.shift();
    }

    io.emit('bot-log', logEntry);
}

// Dinamik ve İnsan Gibi Davranan Rastgele Zamanlamalı Anti-AFK Döngüsü
function scheduleNextAntiAfk(botId) {
    const botData = botPool.get(botId);
    if (!botData || !botData.instance || botData.status !== 'Online') return;

    // 3.5 ile 7 saniye arasında rastgele zamanlama (Rastgelelik anti-cheat tespitini engeller)
    const randomDelay = Math.floor(Math.random() * 3500) + 3500;

    botData.antiAfkTimer = setTimeout(() => {
        if (!botData.instance || botData.status !== 'Online') return;

        try {
            // Kafayı insan gibi hafif derece kaydır (-1.5 ile +1.5 derece arası)
            botData.pos.yaw = (botData.pos.yaw + (Math.random() * 3 - 1.5)) % 360;
            botData.pos.pitch = Math.max(-85, Math.min(85, botData.pos.pitch + (Math.random() * 2 - 1)));

            safeWrite(botData.instance, 'position_look', {
                x: botData.pos.x,
                y: botData.pos.y,
                z: botData.pos.z,
                yaw: botData.pos.yaw,
                pitch: botData.pos.pitch,
                onGround: true
            });
        } catch (e) {}

        scheduleNextAntiAfk(botId);
    }, randomDelay);
}

// Otomatik Yeniden Bağlanma Mekanizması
function triggerAutoReconnect(botId) {
    const botData = botPool.get(botId);
    if (!botData || botData.isManualStop) return;

    if (globalConfig.autoReconnect) {
        broadcastLog(botId, `⏳ 6 saniye içinde otomatik yeniden bağlanılıyor...`, 'warn');
        botData.reconnectTimer = setTimeout(() => {
            if (botPool.has(botId) && !botData.isManualStop && botData.status === 'Offline') {
                startBotInstance(botId);
            }
        }, 6000);
    }
}

function cleanupBot(botId, reason) {
    const botData = botPool.get(botId);
    if (!botData) return;

    if (botData.antiAfkTimer) clearTimeout(botData.antiAfkTimer);
    
    if (botData.instance) {
        try {
            botData.instance.removeAllListeners();
            if (botData.instance.socket && !botData.instance.socket.destroyed) {
                botData.instance.socket.destroy();
            }
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

    const host = botData.host || globalConfig.host;
    const port = Number(botData.port || globalConfig.port);
    const version = botData.version || globalConfig.version;
    const pwd = botData.autoPassword !== undefined ? botData.autoPassword : globalConfig.autoPassword;
    const subCmd = botData.autoSubServerCmd !== undefined ? botData.autoSubServerCmd : globalConfig.autoSubServerCmd;
    const subDelay = Number(botData.autoSubServerDelay !== undefined ? botData.autoSubServerDelay : globalConfig.autoSubServerDelay) || 5;

    broadcastLog(botId, `${botData.username} bağlanıyor (${host}:${port})...`, 'info');
    botData.status = 'Connecting';
    io.emit('status-update', { botId, status: 'Connecting' });

    try {
        const client = mc.createClient({
            host: host,
            port: port,
            username: botData.username,
            version: version || false,
            checkTimeoutInterval: 60 * 1000,
            hideErrors: true
        });

        botData.instance = client;

        // 1. Sunucu Konum/Işınlanma Paket Yanıtı
        client.on('position', (packet) => {
            try {
                botData.pos.x = packet.x;
                botData.pos.y = packet.y;
                botData.pos.z = packet.z;
                botData.pos.yaw = packet.yaw !== undefined ? packet.yaw : botData.pos.yaw;
                botData.pos.pitch = packet.pitch !== undefined ? packet.pitch : botData.pos.pitch;

                if (packet.teleportId !== undefined) {
                    safeWrite(client, 'teleport_confirm', { teleportId: packet.teleportId });
                }

                safeWrite(client, 'position_look', {
                    x: botData.pos.x,
                    y: botData.pos.y,
                    z: botData.pos.z,
                    yaw: botData.pos.yaw,
                    pitch: botData.pos.pitch,
                    onGround: true
                });
            } catch (e) {}
        });

        // 2. Alt Sunucuya Aktarılma Takibi
        client.on('respawn', () => {
            broadcastLog(botId, `🔄 Alt sunucuya aktarılıyor...`, 'info');
        });

        // 3. Giriş Başarılı Olduğunda
        client.on('login', () => {
            safeWrite(client, 'client_information', {
                locale: 'en_US',
                viewDistance: 8,
                chatFlags: 0,
                chatColors: true,
                skinParts: 127,
                mainHand: 1,
                enableTextFiltering: false,
                allowServerListings: true
            });

            botData.status = 'Online';
            broadcastLog(botId, `⚡ ${botData.username} sunucuya girdi!`, 'success');
            io.emit('status-update', { botId, status: 'Online' });

            // Dinamik Anti-AFK Döngüsünü Başlat
            scheduleNextAntiAfk(botId);

            // Alt Sunucu Komutunu Gönder
            if (subCmd && subCmd.trim() !== '') {
                setTimeout(() => {
                    if (botData.instance && botData.status === 'Online') {
                        client.chat(subCmd);
                        broadcastLog(botId, `🚀 Alt sunucu komutu gönderildi: ${subCmd}`, 'success');
                    }
                }, subDelay * 1000);
            }
        });

        let lastAuthTime = 0;

        const handleChat = (packet) => {
            const msg = parseChatMessage(packet);
            if (!msg || !msg.trim()) return;

            broadcastLog(botId, msg, 'chat');
            const lowerMsg = msg.toLowerCase();
            const now = Date.now();

            // Otomatik Login / Register Kontrolü
            if (pwd && pwd.trim() !== '' && (now - lastAuthTime > 5000)) {
                if (lowerMsg.includes('/register') || lowerMsg.includes('kayıt ol') || lowerMsg.includes('kayitol')) {
                    lastAuthTime = now;
                    setTimeout(() => {
                        if (botData.instance && botData.status === 'Online') {
                            client.chat(`/register ${pwd} ${pwd}`);
                            broadcastLog(botId, `🔑 Otomatik /register gönderildi.`, 'info');
                        }
                    }, 1200);
                } else if (lowerMsg.includes('/login') || lowerMsg.includes('giriş yap') || lowerMsg.includes('giris yap')) {
                    lastAuthTime = now;
                    setTimeout(() => {
                        if (botData.instance && botData.status === 'Online') {
                            client.chat(`/login ${pwd}`);
                            broadcastLog(botId, `🔑 Otomatik /login gönderildi.`, 'info');
                        }
                    }, 1200);
                }
            }

            // Otomatik AFK Kontrol / Chat Yanıtlayıcısı (İnsan Tepki Süresi Simülasyonu)
            if (lowerMsg.includes('afk misin') || lowerMsg.includes('burada misin') || lowerMsg.includes('afk kontrol')) {
                setTimeout(() => {
                    if (botData.instance && botData.status === 'Online') {
                        client.chat('buradayim');
                        broadcastLog(botId, `💬 Otomatik AFK kontrol yanıtı verildi.`, 'info');
                    }
                }, 2000 + Math.random() * 1500);
            }
        };

        client.on('chat', handleChat);
        client.on('system_chat', handleChat);
        client.on('player_chat', handleChat);

        client.on('error', (err) => cleanupBot(botId, `Hata: ${err.message}`));
        client.on('kicked', (reason) => cleanupBot(botId, `Atıldı: ${typeof reason === 'object' ? JSON.stringify(reason) : reason}`));
        client.on('end', () => cleanupBot(botId, `Bağlantı kesildi.`));

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

        if (botData.instance) {
            try {
                botData.instance.end();
                botData.instance.removeAllListeners();
                if (botData.instance.socket && !botData.instance.socket.destroyed) {
                    botData.instance.socket.destroy();
                }
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
            delay += 3000;
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
            pos: { x: 0, y: 64, z: 0, yaw: 0, pitch: 0 },
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
