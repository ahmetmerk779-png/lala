const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const mc = require('minecraft-protocol');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

let globalConfig = {
    host: 'play.donutsmp.net',
    port: 25565,
    version: '1.20.4',
    autoSubServerCmd: '/gir asmp'
};

let bots = {}; 

io.on('connection', (socket) => {
    const botList = Object.keys(bots).map(id => bots[id].data);
    socket.emit('init-data', { globalConfig, botList });

    socket.on('add-bot', ({ username }) => {
        if (!username) return;
        const id = 'bot_' + Date.now();
        bots[id] = {
            data: {
                id, username, status: 'Offline',
                health: 20, food: 20, pos: {x:0, y:0, z:0},
                autoReconnect: true, antiAfk: false, logs: []
            },
            client: null
        };
        io.emit('bot-added', bots[id].data);
        addLog(id, 'system', `${username} eklendi.`);
    });

    socket.on('start-bot', (botId) => startBot(botId));
    socket.on('stop-bot', (botId) => stopBot(botId));

    socket.on('send-command', ({ targetBotId, command }) => {
        if (targetBotId && bots[targetBotId] && bots[targetBotId].client) {
            bots[targetBotId].client.write('chat', { message: command });
            addLog(targetBotId, 'chat', `> ${command}`);
        }
    });

    socket.on('update-bot-config', ({ botId, config }) => {
        if (bots[botId]) {
            Object.assign(bots[botId].data, config);
            addLog(botId, 'system', `Ayarlar kaydedildi.`);
        }
    });

    socket.on('update-config', (newConfig) => {
        globalConfig = { ...globalConfig, ...newConfig };
        io.emit('init-data', { globalConfig, botList: Object.values(bots).map(b => b.data) });
    });
});

function startBot(botId) {
    const bot = bots[botId];
    if (!bot || bot.data.status === 'Online' || bot.data.status === 'Connecting') return;

    updateBotStatus(botId, 'Connecting');
    addLog(botId, 'system', `${globalConfig.host} bağlanılıyor...`);

    try {
        const client = mc.createClient({
            host: globalConfig.host,
            port: globalConfig.port,
            username: bot.data.username,
            version: globalConfig.version,
            auth: 'offline'
        });

        bot.client = client;

        client.on('success', () => {
            updateBotStatus(botId, 'Online');
            addLog(botId, 'system', `Sunucuya girildi.`);
            if (globalConfig.autoSubServerCmd) {
                setTimeout(() => {
                    if (bot.client) bot.client.write('chat', { message: globalConfig.autoSubServerCmd });
                }, 3000);
            }
        });

        client.on('chat', (packet) => {
            try {
                const msg = JSON.parse(packet.message);
                const text = msg.text || (msg.extra ? msg.extra.map(e => e.text).join('') : '');
                if (text.trim()) addLog(botId, 'chat', text);
            } catch (e) {
                if (packet.message) addLog(botId, 'chat', packet.message);
            }
        });

        client.on('update_health', (packet) => {
            bot.data.health = Math.round(packet.health);
            bot.data.food = Math.round(packet.food);
            io.emit('status-update', { botId, status: bot.data.status, health: bot.data.health, food: bot.data.food });
        });

        // RADAR İÇİN KONUM TAKİBİ
        client.on('position', (packet) => {
            const pos = { x: Math.floor(packet.x), y: Math.floor(packet.y), z: Math.floor(packet.z) };
            bot.data.pos = pos;
            io.emit('bot-map-update', { botId, pos });
        });

        client.on('end', (reason) => {
            updateBotStatus(botId, 'Offline');
            bot.client = null;
            addLog(botId, 'error', `Bağlantı koptu.`);
            
            // OTO YENİDEN BAĞLANMA ÖZELLİĞİ
            if (bot.data.autoReconnect) {
                addLog(botId, 'system', '5 saniye içinde tekrar deneniyor...');
                setTimeout(() => startBot(botId), 5000);
            }
        });

        client.on('error', (err) => addLog(botId, 'error', `Hata: ${err.message}`));
    } catch (err) {
        updateBotStatus(botId, 'Offline');
    }
}

function stopBot(botId) {
    const bot = bots[botId];
    if (bot && bot.client) {
        bot.client.end('Durduruldu');
        bot.client = null;
        updateBotStatus(botId, 'Offline');
    }
}

function updateBotStatus(botId, status) {
    if (bots[botId]) {
        bots[botId].data.status = status;
        io.emit('status-update', { botId, status });
    }
}

function addLog(botId, type, text) {
    if (!bots[botId]) return;
    const log = { type, text, timestamp: new Date().toLocaleTimeString('tr-TR', { hour12: false }) };
    bots[botId].data.logs.push(log);
    if (bots[botId].data.logs.length > 50) bots[botId].data.logs.shift();
    io.emit('bot-log', { botId, ...log });
}

// ANTİ-AFK SİSTEMİ (Her 30 saniyede bir tetiklenir)
setInterval(() => {
    Object.values(bots).forEach(bot => {
        if (bot.client && bot.data.status === 'Online' && bot.data.antiAfk) {
            bot.client.write('arm_animation', { hand: 0 }); // Kol salla
            bot.client.write('look', { yaw: Math.random() * 360, pitch: 0, onGround: true }); 
        }
    });
}, 30000);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Sunucu ${PORT} portunda aktif.`));
