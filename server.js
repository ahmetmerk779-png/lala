const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const mc = require('minecraft-protocol');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 10000;

app.use(express.static(path.join(__dirname, 'public')));

let globalConfig = {
    host: 'play.donutsmp.net',
    port: 25565,
    version: '1.20.4',
    autoSubServerCmd: '/gir asmp'
};

let bots = [];

function getSanitizedBotList() {
    return bots.map(b => {
        const { client, timeouts, afkInterval, ...cleanBot } = b;
        return cleanBot;
    });
}

function addLog(bot, text, type = 'chat') {
    if (!text || typeof text !== 'string') return;
    const timestamp = new Date().toLocaleTimeString('tr-TR');
    const logEntry = { botId: bot.id, text, type, timestamp };
    bot.logs.push(logEntry);
    if (bot.logs.length > 150) bot.logs.shift();
    io.emit('bot-log', logEntry);
}

function clearBotTimeouts(bot) {
    if (bot.timeouts) {
        bot.timeouts.forEach(t => clearTimeout(t));
        bot.timeouts = [];
    }
    if (bot.afkInterval) {
        clearInterval(bot.afkInterval);
        bot.afkInterval = null;
    }
}

function parseChatMessage(packetData) {
    try {
        if (!packetData) return '';
        if (typeof packetData === 'string') return packetData;
        
        let parsed = packetData;
        if (typeof packetData === 'object') {
            if (packetData.jsonText) parsed = JSON.parse(packetData.jsonText);
            else if (packetData.translate) return packetData.translate;
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
        return String(packetData);
    }
}

function startBot(bot) {
    stopBot(bot);

    bot.status = 'Connecting';
    io.emit('status-update', { botId: bot.id, status: bot.status });
    addLog(bot, 'Sunucuya bağlanılıyor...', 'system');

    const targetHost = bot.host || globalConfig.host;
    const targetPort = Number(bot.port || globalConfig.port || 25565);
    const targetVersion = bot.version || globalConfig.version || '1.20.4';

    try {
        bot.client = mc.createClient({
            host: targetHost,
            port: targetPort,
            username: bot.username,
            version: targetVersion,
            auth: 'offline',
            checkTimeoutInterval: 30000,
            hideErrors: true
        });
    } catch (err) {
        bot.status = 'Offline';
        io.emit('status-update', { botId: bot.id, status: bot.status });
        addLog(bot, `Bağlantı Başarısız: ${err.message}`, 'error');
        return;
    }

    const client = bot.client;

    client.on('login', () => {
        bot.status = 'Online';
        io.emit('status-update', { botId: bot.id, status: bot.status });
        addLog(bot, `Sunucuya katıldı! (Sürüm: ${targetVersion})`, 'system');

        const subCmd = bot.autoSubServerCmd || globalConfig.autoSubServerCmd;
        if (subCmd) {
            const t1 = setTimeout(() => {
                if (bot.status === 'Online' && client.state === mc.states.PLAY) {
                    client.write('chat', { message: subCmd });
                    addLog(bot, `Komut çalıştırıldı: ${subCmd}`, 'system');
                }
            }, 3500);
            bot.timeouts.push(t1);
        }

        if (bot.antiAfk) {
            bot.afkInterval = setInterval(() => {
                if (bot.status === 'Online' && client.state === mc.states.PLAY) {
                    try {
                        client.write('arm_animation', { hand: 0 });
                    } catch (e) {}
                }
            }, 15000);
        }
    });

    client.on('update_health', (packet) => {
        bot.health = Math.round(packet.health);
        bot.food = Math.round(packet.food);
        io.emit('status-update', { botId: bot.id, status: bot.status, health: bot.health, food: bot.food });
    });

    client.on('position', (packet) => {
        bot.pos = { x: Math.round(packet.x), y: Math.round(packet.y), z: Math.round(packet.z) };
        io.emit('bot-map-update', { botId: bot.id, pos: bot.pos, nearbyPlayers: [] });
    });

    client.on('chat', (packet) => {
        const text = parseChatMessage(packet.message);
        if (text) addLog(bot, text, 'chat');
    });

    client.on('systemChat', (packet) => {
        const text = parseChatMessage(packet.content);
        if (text) addLog(bot, text, 'chat');
    });

    client.on('player_info', (packet) => {
        if (!packet.data) return;
        if (!bot.tabPlayers) bot.tabPlayers = new Map();

        if (packet.action === 0) { // ADD_PLAYER
            packet.data.forEach(p => {
                if (p.name) bot.tabPlayers.set(p.uuid, { name: p.name, ping: p.ping || 0 });
            });
        } else if (packet.action === 4) { // REMOVE_PLAYER
            packet.data.forEach(p => bot.tabPlayers.delete(p.uuid));
        }

        const players = Array.from(bot.tabPlayers.values()).slice(0, 30);
        io.emit('bot-tablist', { botId: bot.id, players });
    });

    client.on('end', (reason) => {
        clearBotTimeouts(bot);
        bot.status = 'Offline';
        io.emit('status-update', { botId: bot.id, status: bot.status });
        addLog(bot, `Bağlantı koptu (${reason || 'Sunucu Kapattı'})`, 'error');

        if (bot.autoReconnect) {
            addLog(bot, '5 saniye içinde otomatik tekrar bağlanılacak...', 'system');
            setTimeout(() => {
                if (bot.status === 'Offline') startBot(bot);
            }, 5000);
        }
    });

    client.on('error', (err) => {
        clearBotTimeouts(bot);
        addLog(bot, `Hata: ${err.message}`, 'error');
    });
}

function stopBot(bot) {
    clearBotTimeouts(bot);
    if (bot.client) {
        try { bot.client.end(); } catch (e) {}
        bot.client = null;
    }
    bot.status = 'Offline';
    io.emit('status-update', { botId: bot.id, status: bot.status });
}

io.on('connection', (socket) => {
    socket.emit('init-data', { globalConfig, botList: getSanitizedBotList() });

    socket.on('add-bot', ({ username }) => {
        const newBot = {
            id: 'bot_' + Date.now(),
            username: username || `Bot_${bots.length + 1}`,
            status: 'Offline',
            health: 20,
            food: 20,
            pos: { x: 0, y: 64, z: 0 },
            autoReconnect: false,
            antiAfk: false,
            logs: [],
            timeouts: [],
            client: null
        };
        bots.push(newBot);
        const { client, timeouts, ...cleanBot } = newBot;
        io.emit('bot-added', cleanBot);
    });

    socket.on('start-bot', (id) => { const b = bots.find(x => x.id === id); if (b) startBot(b); });
    socket.on('stop-bot', (id) => { const b = bots.find(x => x.id === id); if (b) stopBot(b); });
    socket.on('start-all', () => bots.forEach(b => startBot(b)));
    socket.on('stop-all', () => bots.forEach(b => stopBot(b)));

    socket.on('update-bot-config', ({ botId, config }) => {
        const bot = bots.find(b => b.id === botId);
        if (bot) {
            Object.assign(bot, config);
            const { client, timeouts, ...cleanBot } = bot;
            io.emit('bot-updated', { botId, config: cleanBot });
        }
    });

    socket.on('update-config', (config) => {
        globalConfig = { ...globalConfig, ...config };
        io.emit('config-updated', globalConfig);
    });

    socket.on('send-command', ({ targetBotId, command }) => {
        if (!command) return;
        const targetBots = targetBotId === 'all' ? bots : bots.filter(b => b.id === targetBotId);
        targetBots.forEach(bot => {
            if (bot.client && bot.status === 'Online') {
                try { bot.client.write('chat', { message: command }); } catch (e) {}
                addLog(bot, `> ${command}`, 'system');
            }
        });
    });
});

server.listen(PORT, () => console.log(`[MC-Panel] Sunucu http://localhost:${PORT} üzerinde aktif!`));
