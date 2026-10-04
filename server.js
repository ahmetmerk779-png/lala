const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const mc = require('minecraft-protocol');
const path = require('path');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;

// STATİK DOSYA SUNUCUSU
app.use(express.static(path.join(__dirname, 'public')));

// GENEL YAPILANDIRMA VE VERİ DEPOLAMA
let globalConfig = {
    host: 'play.donutsmp.net',
    port: 25565,
    version: '1.20.4',
    autoPassword: 'mysecretpassword123',
    autoSubServerCmd: '/gir boxpvp'
};

// YÜKLENEN BOT LİSTESİ
let bots = [
    {
        id: 'bot_1',
        username: 'ProBot_01',
        host: '',
        port: 25565,
        version: '',
        autoPassword: '',
        autoSubServerCmd: '',
        status: 'Offline',
        onlineSince: null,
        pos: { x: 0, y: 64, z: 0 },
        logs: [],
        tabList: [],
        nearbyPlayers: [],
        scoreboard: { title: '', lines: [] },
        client: null
    }
];

// DİŞARI AKTARILABİLİR YARDIMCI VERİ TEMİZLEME (CLIENT NESNESİNİ SOCKET'TEN GİZLEME)
function getSanitizedBotList() {
    return bots.map(b => {
        const { client, ...cleanBot } = b;
        return cleanBot;
    });
}

// LOG EKLEME VE ÖN YÜZE YANSITMA
function addLog(bot, text, type = 'info') {
    const timestamp = new Date().toLocaleTimeString('tr-TR');
    const logEntry = { botId: bot.id, text, type, timestamp };
    bot.logs.push(logEntry);
    if (bot.logs.length > 40) bot.logs.shift();
    io.emit('bot-log', logEntry);
}

// MESAJ / KOMUT GÖNDERME YARDIMCISI (PROTOKOL SÜRÜM UYUMLU)
function sendChat(client, message) {
    if (!client || client.state !== mc.states.PLAY) return;
    try {
        if (message.startsWith('/')) {
            client.write('chat_command', {
                command: message.slice(1),
                timestamp: BigInt(Date.now()),
                salt: BigInt(0),
                argumentSignatures: [],
                signedPreview: false,
                messageCount: 0,
                acknowledged: Buffer.alloc(3)
            });
        } else {
            client.write('chat_message', {
                message: message,
                timestamp: BigInt(Date.now()),
                salt: BigInt(0),
                signedPreview: false
            });
        }
    } catch (e) {
        try {
            client.write('chat', { message: message });
        } catch (err) {}
    }
}

// BOT BAŞLATMA MANTIĞI
function startBot(bot) {
    if (bot.client) {
        try { bot.client.end(); } catch (e) {}
        bot.client = null;
    }

    bot.status = 'Connecting';
    bot.onlineSince = null;
    io.emit('status-update', { botId: bot.id, status: bot.status, onlineSince: null });
    addLog(bot, 'Sunucuya bağlanılıyor...', 'warn');

    const targetHost = bot.host || globalConfig.host;
    const targetPort = Number(bot.port || globalConfig.port || 25565);
    const targetVersion = bot.version || globalConfig.version || false;

    try {
        bot.client = mc.createClient({
            host: targetHost,
            port: targetPort,
            username: bot.username,
            version: targetVersion || undefined,
            auth: 'offline'
        });
    } catch (err) {
        bot.status = 'Offline';
        io.emit('status-update', { botId: bot.id, status: bot.status, onlineSince: null });
        addLog(bot, `Bağlantı oluşturulamadı: ${err.message}`, 'error');
        return;
    }

    const client = bot.client;
    let playersMap = new Map();

    // SAKLI SCOREBOARD VERİSİ
    let sbData = { title: 'Scoreboard', linesMap: new Map() };

    // BAŞARILI GİRİŞ
    client.on('login', () => {
        bot.status = 'Online';
        bot.onlineSince = Date.now();
        io.emit('status-update', { botId: bot.id, status: bot.status, onlineSince: bot.onlineSince });
        addLog(bot, 'Sunucuya katılım sağlandı!', 'success');

        // Otomatik Şifre Girişi (/login veya /register)
        const password = bot.autoPassword !== undefined && bot.autoPassword !== '' ? bot.autoPassword : globalConfig.autoPassword;
        if (password) {
            setTimeout(() => {
                sendChat(client, `/login ${password}`);
                sendChat(client, `/register ${password} ${password}`);
                addLog(bot, 'Otomatik giriş şifresi gönderildi.', 'info');
            }, 1500);
        }

        // Otomatik Alt Sunucu Girişi (/gir)
        const subCmd = bot.autoSubServerCmd !== undefined && bot.autoSubServerCmd !== '' ? bot.autoSubServerCmd : globalConfig.autoSubServerCmd;
        if (subCmd) {
            setTimeout(() => {
                sendChat(client, subCmd);
                addLog(bot, `Komut çalıştırıldı: ${subCmd}`, 'info');
            }, 3500);
        }
    });

    // POZİSYON TESPİTİ VE RADAR GÜNCELLEMESİ
    client.on('position', (packet) => {
        bot.pos = { x: packet.x, y: packet.y, z: packet.z };
        io.emit('bot-map-update', {
            botId: bot.id,
            pos: bot.pos,
            nearbyPlayers: bot.nearbyPlayers || Array.from(playersMap.values())
        });
    });

    // TABLIST DINLEYICISI
    client.on('player_info', (packet) => {
        try {
            if (packet.action === 0) { // Add Player
                packet.data.forEach(p => {
                    playersMap.set(p.uuid, {
                        name: p.name,
                        displayName: p.displayName ? JSON.stringify(p.displayName) : p.name,
                        ping: p.ping || 0,
                        x: bot.pos.x + (Math.random() * 20 - 10),
                        z: bot.pos.z + (Math.random() * 20 - 10)
                    });
                });
            } else if (packet.action === 4) { // Remove Player
                packet.data.forEach(p => playersMap.delete(p.uuid));
            }
            bot.tabList = Array.from(playersMap.values());
            io.emit('bot-tablist', { botId: bot.id, players: bot.tabList });
        } catch (e) {}
    });

    // CHAT VE SISTEM MESAJLARI
    const parseChatMsg = (packetData) => {
        try {
            if (!packetData) return '';
            if (typeof packetData === 'string') return packetData;
            const parsed = typeof packetData === 'object' ? packetData : JSON.parse(packetData);
            if (parsed.text) return parsed.text;
            if (parsed.extra) return parsed.extra.map(e => e.text || '').join('');
            if (parsed.translate) return parsed.translate;
        } catch (e) { return ''; }
        return '';
    };

    client.on('chat', (packet) => {
        const text = parseChatMsg(packet.message);
        if (text) addLog(bot, text, 'info');
    });

    client.on('systemChat', (packet) => {
        const text = parseChatMsg(packet.content);
        if (text) addLog(bot, text, 'info');
    });

    // SCOREBOARD PAKET YÖNETİMİ
    client.on('scoreboard_objective', (packet) => {
        if (packet.action === 0 || packet.action === 2) {
            sbData.title = packet.displayText || packet.name;
        }
    });

    client.on('scoreboard_score', (packet) => {
        if (packet.action === 0) { // Create or Update
            sbData.linesMap.set(packet.itemName, packet.value);
        } else if (packet.action === 1) { // Remove
            sbData.linesMap.delete(packet.itemName);
        }
        
        const lines = Array.from(sbData.linesMap.entries()).map(([text, score]) => ({ text, score }));
        bot.scoreboard = { title: sbData.title, lines };
        io.emit('bot-scoreboard', { botId: bot.id, scoreboard: bot.scoreboard });
    });

    // BAGLANTI KOPMA VE HATA YÖNETİMİ
    client.on('end', (reason) => {
        bot.status = 'Offline';
        bot.onlineSince = null;
        bot.client = null;
        io.emit('status-update', { botId: bot.id, status: bot.status, onlineSince: null });
        addLog(bot, `Bağlantı kesildi: ${reason || 'Sunucu kapattı'}`, 'warn');
    });

    client.on('error', (err) => {
        addLog(bot, `Hata: ${err.message}`, 'error');
    });
}

// BOT DURDURMA MANTIĞI
function stopBot(bot) {
    if (bot.client) {
        try { bot.client.end(); } catch (e) {}
        bot.client = null;
    }
    bot.status = 'Offline';
    bot.onlineSince = null;
    io.emit('status-update', { botId: bot.id, status: bot.status, onlineSince: null });
    addLog(bot, 'Bot manuel olarak durduruldu.', 'warn');
}

// SOCKET.IO BAGLANTILARI
io.on('connection', (socket) => {
    // Ilk Baglantida Verileri Gönder
    socket.emit('init-data', {
        globalConfig,
        botList: getSanitizedBotList()
    });

    // YENI BOT EKLEME
    socket.on('add-bot', ({ username }) => {
        const newBot = {
            id: 'bot_' + Date.now(),
            username: username || `Bot_${bots.length + 1}`,
            host: '',
            port: 25565,
            version: '',
            autoPassword: '',
            autoSubServerCmd: '',
            status: 'Offline',
            onlineSince: null,
            pos: { x: 0, y: 64, z: 0 },
            logs: [],
            tabList: [],
            nearbyPlayers: [],
            scoreboard: { title: '', lines: [] },
            client: null
        };
        bots.push(newBot);
        const { client, ...cleanBot } = newBot;
        io.emit('bot-added', cleanBot);
    });

    // BOT SILME
    socket.on('delete-bot', (botId) => {
        const index = bots.findIndex(b => b.id === botId);
        if (index !== -1) {
            stopBot(bots[index]);
            bots.splice(index, 1);
            io.emit('bot-deleted', botId);
        }
    });

    // BOT BAŞLAT / DURDUR
    socket.on('start-bot', (botId) => {
        const bot = bots.find(b => b.id === botId);
        if (bot) startBot(bot);
    });

    socket.on('stop-bot', (botId) => {
        const bot = bots.find(b => b.id === botId);
        if (bot) stopBot(bot);
    });

    socket.on('start-all', () => {
        bots.forEach(bot => { if (bot.status === 'Offline') startBot(bot); });
    });

    socket.on('stop-all', () => {
        bots.forEach(bot => { stopBot(bot); });
    });

    // YAPILANDIRMA GÜNCELLEMELERI
    socket.on('update-bot-config', ({ botId, config }) => {
        const bot = bots.find(b => b.id === botId);
        if (bot) {
            Object.assign(bot, config);
            const { client, ...cleanBot } = bot;
            io.emit('bot-updated', { botId, config: cleanBot });
        }
    });

    socket.on('update-config', (newConfig) => {
        globalConfig = { ...globalConfig, ...newConfig };
        io.emit('config-updated', globalConfig);
    });

    // KOMUT GÖNDERIMI
    socket.on('send-command', ({ targetBotId, command }) => {
        if (targetBotId === 'all') {
            bots.forEach(bot => {
                if (bot.client && bot.status === 'Online') {
                    sendChat(bot.client, command);
                    addLog(bot, `[Toplu Komut]: ${command}`, 'info');
                }
            });
        } else {
            const bot = bots.find(b => b.id === targetBotId);
            if (bot && bot.client && bot.status === 'Online') {
                sendChat(bot.client, command);
                addLog(bot, `[Komut]: ${command}`, 'info');
            }
        }
    });
});

// SUNUCUYU BAŞLAT
server.listen(PORT, () => {
    console.log(`[MC-Panel] Sunucu http://localhost:${PORT} adresinde aktif!`);
});
