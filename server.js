const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const mc = require('minecraft-protocol');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

let bots = {}; // { botId: { data: {...}, client: ... } }

io.on('connection', (socket) => {
    const botList = Object.keys(bots).map(id => bots[id].data);
    socket.emit('init-data', { botList });

    socket.on('add-bot', ({ username }) => {
        if (!username) return;
        const id = 'bot_' + Date.now();
        bots[id] = {
            data: {
                id,
                username,
                status: 'Offline',
                health: 20,
                food: 20,
                pos: { x: 0, y: 0, z: 0 },
                config: {
                    host: 'play.donutsmp.net',
                    port: 25565,
                    version: '1.20.4',
                    autoSubServerCmd: '/gir asmp',
                    autoReconnect: true,
                    autoAntiAfk: false
                },
                inventory: [],
                scoreboard: { title: '', items: [] },
                tabList: [],
                logs: []
            },
            client: null
        };
        io.emit('bot-added', bots[id].data);
        addLog(id, 'system', `${username} sisteme eklendi.`);
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
            bots[botId].data.config = { ...bots[botId].data.config, ...config };
            addLog(botId, 'system', 'Bot yapılandırması güncellendi.');
            io.emit('bot-updated', bots[botId].data);
        }
    });
});

function startBot(botId) {
    const bot = bots[botId];
    if (!bot || bot.data.status === 'Online' || bot.data.status === 'Connecting') return;

    updateBotStatus(botId, 'Connecting');
    addLog(botId, 'system', `${bot.data.config.host} adresine bağlanılıyor...`);

    try {
        const client = mc.createClient({
            host: bot.data.config.host,
            port: bot.data.config.port,
            username: bot.data.username,
            version: bot.data.config.version,
            auth: 'offline'
        });

        bot.client = client;

        client.on('success', () => {
            updateBotStatus(botId, 'Online');
            addLog(botId, 'system', `Sunucuya başarıyla giriş yapıldı!`);
            if (bot.data.config.autoSubServerCmd) {
                setTimeout(() => {
                    if (bot.client) {
                        bot.client.write('chat', { message: bot.data.config.autoSubServerCmd });
                        addLog(botId, 'system', `Oto komut gönderildi: ${bot.data.config.autoSubServerCmd}`);
                    }
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
            io.emit('bot-updated', bot.data);
        });

        client.on('position', (packet) => {
            bot.data.pos = { x: Math.floor(packet.x), y: Math.floor(packet.y), z: Math.floor(packet.z) };
            io.emit('bot-updated', bot.data);
        });

        // Envanter takibi
        client.on('window_items', (packet) => {
            if (packet.items) {
                bot.data.inventory = packet.items.map(item => item && item.itemCount > 0 ? { name: item.nbtData?.name || 'Eşya', count: item.itemCount } : null);
                io.emit('bot-updated', bot.data);
            }
        });

        // Tab list / Oyuncular
        client.on('player_info', (packet) => {
            try {
                if (packet.data) {
                    bot.data.tabList = packet.data.map(p => p.name || p.username).filter(Boolean);
                    io.emit('bot-updated', bot.data);
                }
            } catch(e){}
        });

        client.on('end', (reason) => {
            updateBotStatus(botId, 'Offline');
            bot.client = null;
            addLog(botId, 'error', `Bağlantı koptu: ${reason}`);

            if (bot.data.config.autoReconnect) {
                addLog(botId, 'system', '5 saniye sonra yeniden bağlanılıyor...');
                setTimeout(() => startBot(botId), 5000);
            }
        });

        client.on('error', (err) => {
            addLog(botId, 'error', `Hata: ${err.message}`);
        });

    } catch (err) {
        updateBotStatus(botId, 'Offline');
        addLog(botId, 'error', `Başlatma hatası: ${err.message}`);
    }
}

function stopBot(botId) {
    const bot = bots[botId];
    if (bot && bot.client) {
        bot.client.end('Kullanıcı durdurdu');
        bot.client = null;
        updateBotStatus(botId, 'Offline');
        addLog(botId, 'system', 'Bot durduruldu.');
    }
}

function updateBotStatus(botId, status) {
    if (bots[botId]) {
        bots[botId].data.status = status;
        io.emit('bot-updated', bots[botId].data);
    }
}

function addLog(botId, type, text) {
    if (!bots[botId]) return;
    const log = { type, text, timestamp: new Date().toLocaleTimeString('tr-TR', { hour12: false }) };
    bots[botId].data.logs.push(log);
    if (bots[botId].data.logs.length > 50) bots[botId].data.logs.shift();
    io.emit('bot-log', { botId, ...log });
}

// BOTA ÖZEL ANTİ-AFK KONTROLÜ
setInterval(() => {
    Object.values(bots).forEach(bot => {
        if (bot.client && bot.data.status === 'Online' && bot.data.config.autoAntiAfk) {
            bot.client.write('arm_animation', { hand: 0 });
            bot.client.write('look', { yaw: Math.random() * 360, pitch: 0, onGround: true });
        }
    });
}, 30000);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`[PRO-DASHBOARD] ${PORT} portunda aktif!`));
