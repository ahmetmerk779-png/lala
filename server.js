const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const mc = require('minecraft-protocol');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 10000;

// STATİK DOSYALAR (public klasörünü sunar)
app.use(express.static(path.join(__dirname, 'public')));

// GENEL SUNUCU AYARLARI
let globalConfig = {
    host: 'play.donutsmp.net',
    port: 25565,
    version: '1.20.4',
    autoPassword: 'mysecretpassword123',
    autoSubServerCmd: '/gir boxpvp'
};

// BOT LİSTESİ METADATA
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
        onlineSince: null, // Arayüzdeki canlı süre sayacı için zaman damgası
        pos: { x: 0, y: 64, z: 0 },
        logs: [],
        tabList: [],
        scoreboard: { title: '', lines: [] },
        client: null
    }
];

// Socket.io ile gönderilirken dairesel yapı (client nesnesi) temizlenir
function getSanitizedBotList() {
    return bots.map(b => {
        const { client, ...cleanBot } = b;
        return cleanBot;
    });
}

function addLog(bot, text, type = 'info') {
    if (!text || typeof text !== 'string') return;
    const timestamp = new Date().toLocaleTimeString('tr-TR');
    const logEntry = { botId: bot.id, text, type, timestamp };
    bot.logs.push(logEntry);
    if (bot.logs.length > 100) bot.logs.shift();
    io.emit('bot-log', logEntry);
}

function sendChat(client, message) {
    if (!client || client.state !== mc.states.PLAY) return;
    try {
        if (typeof client.chat === 'function') {
            client.chat(message);
        } else {
            client.write('chat', { message: message });
        }
    } catch (err) {
        console.error('Mesaj gönderme hatası:', err.message);
    }
}

// Minecraft renk kodlarını ve karmaşık JSON Chat objelerini temizleme
function parseChatMessage(packetData) {
    try {
        if (!packetData) return '';
        if (typeof packetData === 'string') return packetData;
        
        let parsed = packetData;
        if (typeof packetData === 'object' && packetData.jsonText) {
            parsed = JSON.parse(packetData.jsonText);
        }

        let fullText = '';
        if (parsed.text) fullText += parsed.text;
        if (parsed.extra && Array.isArray(parsed.extra)) {
            parsed.extra.forEach(item => {
                if (typeof item === 'string') fullText += item;
                else if (item && item.text) fullText += item.text;
            });
        }
        if (!fullText && parsed.translate) fullText = parsed.translate;
        
        return fullText.replace(/§[0-9a-fk-or]/gi, '').trim();
    } catch (e) {
        return '';
    }
}

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
            auth: 'offline',
            checkTimeoutInterval: 30000,
            hideErrors: true // 1.20.5+ wind_burst / explosion paket hatalarının konsolu doldurmasını engeller
        });
    } catch (err) {
        bot.status = 'Offline';
        io.emit('status-update', { botId: bot.id, status: bot.status, onlineSince: null });
        addLog(bot, `Bağlantı başlatılamadı: ${err.message}`, 'error');
        return;
    }

    const client = bot.client;
    let playersMap = new Map();
    let sbData = { title: 'Scoreboard', linesMap: new Map() };

    client.on('login', () => {
        bot.status = 'Online';
        bot.onlineSince = Date.now(); // Giriş zamanı kaydedilir
        io.emit('status-update', { 
            botId: bot.id, 
            status: bot.status, 
            onlineSince: bot.onlineSince 
        });
        addLog(bot, 'Sunucuya başarıyla katıldı!', 'success');

        // Otomatik Şifre Girişi
        const password = bot.autoPassword !== undefined && bot.autoPassword !== '' ? bot.autoPassword : globalConfig.autoPassword;
        if (password) {
            setTimeout(() => {
                sendChat(client, `/login ${password}`);
                sendChat(client, `/register ${password} ${password}`);
                addLog(bot, 'Otomatik giriş şifresi gönderildi.', 'info');
            }, 2000);
        }

        // Otomatik Alt Sunucuya Geçiş / Komut
        const subCmd = bot.autoSubServerCmd !== undefined && bot.autoSubServerCmd !== '' ? bot.autoSubServerCmd : globalConfig.autoSubServerCmd;
        if (subCmd) {
            setTimeout(() => {
                sendChat(client, subCmd);
                addLog(bot, `Komut çalıştırıldı: ${subCmd}`, 'info');
            }, 4000);
        }
    });

    // KONUM VE RADAR
    client.on('position', (packet) => {
        bot.pos = { x: Math.round(packet.x), y: Math.round(packet.y), z: Math.round(packet.z) };
        io.emit('bot-map-update', {
            botId: bot.id,
            pos: bot.pos,
            nearbyPlayers: Array.from(playersMap.values())
        });
    });

    // SOHBET DİNLEYİCİLERİ
    client.on('chat', (packet) => {
        const text = parseChatMessage(packet.message);
        if (text) addLog(bot, text, 'info');
    });

    client.on('systemChat', (packet) => {
        const text = parseChatMessage(packet.content);
        if (text) addLog(bot, text, 'info');
    });

    client.on('playerChat', (packet) => {
        const text = parseChatMessage(packet.unsignedContent || packet.formattedMessage);
        if (text) addLog(bot, text, 'info');
    });

    // TABLIST YÖNETİMİ
    const handlePlayerInfo = (uuid, name, ping) => {
        if (!name) return;
        playersMap.set(uuid, {
            name: name,
            ping: ping || 0,
            x: bot.pos.x + (Math.floor(Math.random() * 20) - 10),
            z: bot.pos.z + (Math.floor(Math.random() * 20) - 10)
        });
        bot.tabList = Array.from(playersMap.values());
        io.emit('bot-tablist', { botId: bot.id, players: bot.tabList });
    };

    client.on('player_info', (packet) => {
        try {
            if (packet.action === 0) {
                packet.data.forEach(p => handlePlayerInfo(p.uuid, p.name, p.ping));
            } else if (packet.action === 4) {
                packet.data.forEach(p => playersMap.delete(p.uuid));
            }
        } catch (e) {}
    });

    client.on('player_info_update', (packet) => {
        try {
            if (packet.actions && packet.entries) {
                packet.entries.forEach(entry => {
                    if (entry.player && entry.player.name) {
                        handlePlayerInfo(entry.uuid, entry.player.name, entry.latency);
                    }
                });
            }
        } catch (e) {}
    });

    // SCOREBOARD YÖNETİMİ
    client.on('scoreboard_objective', (packet) => {
        try {
            if (packet.action === 0 || packet.action === 2) {
                sbData.title = parseChatMessage(packet.displayText) || packet.name;
            }
        } catch (e) {}
    });

    client.on('scoreboard_score', (packet) => {
        try {
            if (packet.action === 0) {
                sbData.linesMap.set(packet.itemName, packet.value);
            } else if (packet.action === 1) {
                sbData.linesMap.delete(packet.itemName);
            }
            const lines = Array.from(sbData.linesMap.entries()).map(([text, score]) => ({
                text: parseChatMessage(text) || text,
                score
            }));
            bot.scoreboard = { title: sbData.title, lines };
            io.emit('bot-scoreboard', { botId: bot.id, scoreboard: bot.scoreboard });
        } catch (e) {}
    });

    // KOPMA VE HATA YÖNETİMİ
    client.on('kick_disconnect', (packet) => {
        const reason = parseChatMessage(packet.reason);
        addLog(bot, `Sunucudan atıldı: ${reason}`, 'error');
    });

    client.on('disconnect', (packet) => {
        const reason = parseChatMessage(packet.reason);
        addLog(bot, `Bağlantı koptu: ${reason}`, 'warn');
    });

    client.on('end', (reason) => {
        bot.status = 'Offline';
        bot.onlineSince = null;
        bot.client = null;
        io.emit('status-update', { botId: bot.id, status: bot.status, onlineSince: null });
        addLog(bot, `Bağlantı sonlandı (${reason || 'Sunucu Kapattı'})`, 'warn');
    });

    client.on('error', (err) => {
        addLog(bot, `Hata: ${err.message}`, 'error');
    });
}

function stopBot(bot) {
    if (bot.client) {
        try { bot.client.end(); } catch (e) {}
        bot.client = null;
    }
    bot.status = 'Offline';
    bot.onlineSince = null;
    io.emit('status-update', { botId: bot.id, status: bot.status, onlineSince: null });
    addLog(bot, 'Bot durduruldu.', 'warn');
}

// SOCKET.IO ETKİNLİKLERİ
io.on('connection', (socket) => {
    socket.emit('init-data', {
        globalConfig,
        botList: getSanitizedBotList()
    });

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
            scoreboard: { title: '', lines: [] },
            client: null
        };
        bots.push(newBot);
        const { client, ...cleanBot } = newBot;
        io.emit('bot-added', cleanBot);
    });

    socket.on('delete-bot', (botId) => {
        const index = bots.findIndex(b => b.id === botId);
        if (index !== -1) {
            stopBot(bots[index]);
            bots.splice(index, 1);
            io.emit('bot-deleted', botId);
        }
    });

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

    socket.on('send-command', ({ targetBotId, command }) => {
        if (!command) return;
        if (targetBotId === 'all') {
            bots.forEach(bot => {
                if (bot.client && bot.status === 'Online') {
                    sendChat(bot.client, command);
                    addLog(bot, `[Toplu]: ${command}`, 'info');
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

server.listen(PORT, () => {
    console.log(`[MC-Panel] Sunucu http://localhost:${PORT} adresinde aktif!`);
});
