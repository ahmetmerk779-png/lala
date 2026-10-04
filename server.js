const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const mc = require('minecraft-protocol');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static('public'));

// Tüm botların tutulduğu ana dizi
let bots = [];

function addLog(bot, text, type = 'info') {
    const timestamp = new Date().toLocaleTimeString('tr-TR');
    if (!bot.logs) bot.logs = [];
    bot.logs.push({ timestamp, text, type });
    if (bot.logs.length > 100) bot.logs.shift();
    io.emit('bot-log', { botId: bot.id, timestamp, text, type });
}

// Renk kodlarını temizleme ve JSON chat çevirme
function parseChat(chat) {
    if (!chat) return '';
    if (typeof chat === 'string') {
        try { chat = JSON.parse(chat); } catch (e) { return chat; }
    }
    let text = chat.text || chat.translate || '';
    if (chat.extra) chat.extra.forEach(ex => text += parseChat(ex));
    return text.replace(/§[0-9a-fk-or]/ig, '').trim();
}

function startBotInstance(bot) {
    if (bot.client) {
        try { bot.client.removeAllListeners(); bot.client.end(); } catch (e) {}
    }
    if (bot.updateInterval) clearInterval(bot.updateInterval);

    bot.status = 'Connecting';
    bot.pos = { x: 0, y: 0, z: 0 };
    bot.scoreboard = { title: 'Yükleniyor...', items: {} };
    bot.tabPlayers = {};
    bot.tabList = [];
    bot.entities = {}; 
    bot.radarEntities = [];

    addLog(bot, `${bot.username}, ${bot.config.host}:${bot.config.port} adresine bağlanıyor...`, 'system');
    io.emit('bot-updated', bot);

    try {
        bot.client = mc.createClient({
            host: bot.config.host,
            port: Number(bot.config.port),
            username: bot.username,
            version: bot.config.version || false,
            skipValidation: true
        });

        bot.client.once('login', () => {
            bot.status = 'Online';
            addLog(bot, 'Sunucuya başarıyla giriş yapıldı.', 'system');
            
            if (bot.config.password) {
                setTimeout(() => {
                    if (bot.client && bot.status === 'Online') {
                        bot.client.write('chat', { message: `/login ${bot.config.password}` });
                        addLog(bot, `Giriş şifresi gönderildi.`, 'system');
                    }
                }, 1500);
            }
            if (bot.config.autoSubServerCmd) {
                setTimeout(() => {
                    if (bot.client && bot.status === 'Online') {
                        bot.client.write('chat', { message: bot.config.autoSubServerCmd });
                        addLog(bot, `Yönlendirme yapıldı: ${bot.config.autoSubServerCmd}`, 'system');
                    }
                }, 3000);
            }
        });

        // Pozisyon
        bot.client.on('position', (packet) => {
            bot.pos = { x: packet.x, y: packet.y, z: packet.z };
        });

        // Tab Listesi (Oyuncular ve Ping)
        bot.client.on('player_info_update', (packet) => {
            if(packet.data) {
                packet.data.forEach(p => {
                    if (!bot.tabPlayers[p.UUID]) bot.tabPlayers[p.UUID] = { name: 'Bilinmeyen', ping: 0 };
                    if (p.player && p.player.name) bot.tabPlayers[p.UUID].name = p.player.name;
                    if (p.latency !== undefined) bot.tabPlayers[p.UUID].ping = p.latency;
                });
                bot.tabList = Object.values(bot.tabPlayers);
            }
        });
        
        bot.client.on('player_info_remove', (packet) => {
            if(packet.UUIDs) {
                packet.UUIDs.forEach(uuid => delete bot.tabPlayers[uuid]);
                bot.tabList = Object.values(bot.tabPlayers);
            }
        });

        // Scoreboard Verileri
        bot.client.on('scoreboard_objective', (packet) => {
            if (packet.action === 0 || packet.action === 2) {
                bot.scoreboard.title = parseChat(packet.displayText) || packet.name;
            }
        });
        
        bot.client.on('scoreboard_score', (packet) => {
            const cleanName = parseChat(packet.itemName).replace(/([>])/g, '');
            if (packet.action === 0) bot.scoreboard.items[cleanName] = packet.value;
            else if (packet.action === 1) delete bot.scoreboard.items[cleanName];
        });

        // Radar Varlıkları (Yakındaki varlıkları yakalama)
        bot.client.on('spawn_entity', (packet) => { bot.entities[packet.entityId] = { x: packet.x, z: packet.z }; });
        bot.client.on('entity_teleport', (packet) => {
            if (bot.entities[packet.entityId]) { bot.entities[packet.entityId].x = packet.x; bot.entities[packet.entityId].z = packet.z; }
        });
        bot.client.on('entity_destroy', (packet) => {
            if(packet.entityIds) packet.entityIds.forEach(id => delete bot.entities[id]);
        });

        // Terminal (Chat) Okuma
        bot.client.on('chat', (packet) => {
            const text = parseChat(packet.message);
            if(text) addLog(bot, `[Chat] ${text}`);
        });

        bot.client.on('end', (reason) => {
            bot.status = 'Offline';
            if (bot.updateInterval) clearInterval(bot.updateInterval);
            addLog(bot, `Bağlantı kesildi: ${reason}`, 'error');
            io.emit('bot-updated', bot);
        });

        bot.client.on('error', (err) => {
            bot.status = 'Error';
            if (bot.updateInterval) clearInterval(bot.updateInterval);
            addLog(bot, `Hata: ${err.message}`, 'error');
            io.emit('bot-updated', bot);
        });

        // Arayüze saniyede 1 kez varlık koordinatlarını gönder
        bot.updateInterval = setInterval(() => {
            if (bot.status === 'Online') {
                bot.radarEntities = Object.values(bot.entities).map(e => ({ x: e.x, z: e.z }));
                io.emit('bot-updated', bot);
            }
        }, 1000);

    } catch (err) {
        bot.status = 'Error';
        addLog(bot, `Sistem Hatası: ${err.message}`, 'error');
        io.emit('bot-updated', bot);
    }
}

io.on('connection', (socket) => {
    socket.emit('init-data', { botList: bots });

    // Yeni Bot Ekleme (Her botun bağımsız ayarlarıyla eklenir)
    socket.on('add-bot', (data) => {
        const newBot = {
            id: 'bot_' + Date.now(),
            username: data.username,
            status: 'Offline',
            pos: { x: 0, y: 0, z: 0 },
            scoreboard: { title: 'Yükleniyor...', items: {} },
            tabList: [],
            radarEntities: [],
            logs: [],
            config: {
                host: data.host || 'oyna.aesirmc.com',
                port: data.port || 25565,
                version: data.version || '1.20.6',
                password: data.password || '',
                autoSubServerCmd: data.autoSubServerCmd || ''
            },
            client: null
        };
        bots.push(newBot);
        io.emit('bot-added', newBot);
    });

    // Bota Özel Ayarları Güncelleme
    socket.on('update-bot-config', (data) => {
        const bot = bots.find(b => b.id === data.botId);
        if (bot) {
            bot.config = { ...bot.config, ...data.config };
            addLog(bot, 'Botun özel ayarları başarıyla güncellendi.', 'system');
            io.emit('bot-updated', bot);
        }
    });

    socket.on('start-bot', (botId) => { const bot = bots.find(b => b.id === botId); if (bot) startBotInstance(bot); });
    socket.on('stop-bot', (botId) => {
        const bot = bots.find(b => b.id === botId);
        if (bot && bot.client) {
            try { bot.client.end(); } catch (e) {}
            bot.status = 'Offline';
            addLog(bot, 'Bot durduruldu.', 'system');
            io.emit('bot-updated', bot);
        }
    });

    socket.on('delete-bot', (botId) => {
        const index = bots.findIndex(b => b.id === botId);
        if (index !== -1) {
            if (bots[index].client) { try { bots[index].client.end(); } catch (e) {} }
            if (bots[index].updateInterval) clearInterval(bots[index].updateInterval);
            bots.splice(index, 1);
            io.emit('init-data', { botList: bots });
        }
    });

    socket.on('bot-command', (data) => {
        const { botId, command } = data;
        const bot = bots.find(b => b.id === botId);
        if (bot && bot.client && bot.status === 'Online') {
            bot.client.write('chat', { message: command });
            addLog(bot, `> ${command}`, 'system');
        }
    });
});

const PORT = 3000;
server.listen(PORT, () => console.log(`Sunucu aktif: http://localhost:${PORT}`));
