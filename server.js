const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const mc = require('minecraft-protocol');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static('public'));

let bots = [];

function addLog(bot, text, type = 'info') {
    const timestamp = new Date().toLocaleTimeString('tr-TR');
    if (!bot.logs) bot.logs = [];
    bot.logs.push({ timestamp, text, type });
    if (bot.logs.length > 150) bot.logs.shift();
    io.emit('bot-log', { botId: bot.id, timestamp, text, type });
}

function parseChat(chat) {
    if (!chat) return '';
    if (typeof chat === 'string') {
        try { chat = JSON.parse(chat); } catch (e) { return chat; }
    }
    let text = chat.text || chat.translate || '';
    if (chat.extra) {
        chat.extra.forEach(ex => text += parseChat(ex));
    }
    if (chat.with) {
        chat.with.forEach(w => text += ' ' + parseChat(w));
    }
    return text.replace(/§[0-9a-fk-or]/ig, '').trim();
}

function sendCommand(bot, commandText) {
    if (!bot.client || bot.status !== 'Online') return;
    const cmd = commandText.trim();
    try {
        if (cmd.startsWith('/')) {
            const rawCmd = cmd.substring(1);
            try {
                bot.client.write('chat_command', {
                    command: rawCmd,
                    timestamp: BigInt(Date.now()),
                    salt: BigInt(0),
                    argumentSignatures: [],
                    signedPreview: false,
                    messageCount: 0,
                    acknowledged: Buffer.alloc(3)
                });
            } catch (e) {
                bot.client.write('chat', { message: cmd });
            }
        } else {
            bot.client.write('chat', { message: cmd });
        }
    } catch (err) {
        addLog(bot, `Komut Hatası: ${err.message}`, 'error');
    }
}

function startBotInstance(bot) {
    if (bot.client) {
        try { bot.client.removeAllListeners(); bot.client.end(); } catch (e) {}
    }
    if (bot.updateInterval) clearInterval(bot.updateInterval);
    if (bot.loginTimeout) clearTimeout(bot.loginTimeout);

    bot.status = 'Connecting';
    bot.onlineTimeSeconds = 0;
    bot.pos = { x: 0, y: 0, z: 0 };
    bot.scoreboard = { title: bot.config.host, items: {} };
    bot.tabPlayers = {};
    bot.tabList = [];
    bot.entities = {}; 
    bot.radarEntities = [];

    addLog(bot, `${bot.username} sunucuya bağlanıyor (${bot.config.host}:${bot.config.port})...`, 'system');
    io.emit('bot-updated', bot);

    try {
        const clientOptions = {
            host: bot.config.host,
            port: Number(bot.config.port) || 25565,
            username: bot.username,
            skipValidation: true,
            checkTimeoutInterval: 60000
        };

        if (bot.config.version && bot.config.version !== 'auto') {
            clientOptions.version = bot.config.version;
        }

        bot.client = mc.createClient(clientOptions);

        bot.client.once('login', () => {
            bot.status = 'Online';
            addLog(bot, 'Sunucuya giriş başarılı!', 'system');
            
            if (bot.config.password) {
                bot.loginTimeout = setTimeout(() => {
                    if (bot.client && bot.status === 'Online') {
                        sendCommand(bot, `/login ${bot.config.password}`);
                        addLog(bot, 'Şifre gönderildi (/login).', 'system');
                    }
                }, 2000);
            }
        });

        bot.client.on('position', (packet) => { 
            bot.pos = { x: Math.round(packet.x), y: Math.round(packet.y), z: Math.round(packet.z) }; 
        });

        bot.client.on('player_info_update', (packet) => {
            if (packet.data) {
                packet.data.forEach(p => {
                    if (!bot.tabPlayers[p.UUID]) bot.tabPlayers[p.UUID] = { name: '', ping: 0 };
                    if (p.player && p.player.name) bot.tabPlayers[p.UUID].name = p.player.name;
                    if (p.latency !== undefined) bot.tabPlayers[p.UUID].ping = p.latency;
                });
                bot.tabList = Object.values(bot.tabPlayers).filter(x => x.name && x.name.length > 0);
            }
        });

        bot.client.on('player_info', (packet) => {
            if (packet.action === 0 && packet.data) {
                packet.data.forEach(p => {
                    bot.tabPlayers[p.UUID] = { name: p.name || '', ping: p.ping || 0 };
                });
            } else if (packet.action === 4 && packet.data) {
                packet.data.forEach(p => { delete bot.tabPlayers[p.UUID]; });
            }
            bot.tabList = Object.values(bot.tabPlayers).filter(x => x.name && x.name.length > 0);
        });

        bot.client.on('scoreboard_objective', (packet) => {
            if (packet.action === 0 || packet.action === 2) {
                bot.scoreboard.title = parseChat(packet.displayText) || packet.name;
            }
        });
        
        bot.client.on('scoreboard_score', (packet) => {
            const cleanName = parseChat(packet.itemName || packet.scoreName || '');
            if (cleanName) {
                if (packet.action === 0) {
                    bot.scoreboard.items[cleanName] = packet.value;
                } else if (packet.action === 1) {
                    delete bot.scoreboard.items[cleanName];
                }
            }
        });

        bot.client.on('chat', (packet) => {
            const text = parseChat(packet.message);
            if (text) addLog(bot, text, 'chat');
        });
        bot.client.on('systemChat', (packet) => {
            const text = parseChat(packet.content);
            if (text) addLog(bot, text, 'system');
        });
        bot.client.on('playerChat', (packet) => {
            const sender = packet.senderName ? parseChat(packet.senderName) : 'Oyuncu';
            const msg = parseChat(packet.formattedMessage || packet.unsignedContent || packet.plainMessage);
            addLog(bot, `<${sender}> ${msg}`, 'chat');
        });

        bot.client.on('named_entity_spawn', (packet) => {
            bot.entities[packet.entityId] = { x: packet.x / 32, z: packet.z / 32, type: 'player' };
        });
        bot.client.on('spawn_entity', (packet) => {
            bot.entities[packet.entityId] = { x: packet.x, z: packet.z, type: 'mob' };
        });
        bot.client.on('entity_destroy', (packet) => {
            if (packet.entityIds) packet.entityIds.forEach(id => delete bot.entities[id]);
        });

        bot.client.on('end', (reason) => {
            bot.status = 'Offline';
            if (bot.updateInterval) clearInterval(bot.updateInterval);
            addLog(bot, `Bağlantı kesildi: ${reason}`, 'error');
            io.emit('bot-updated', bot);
        });

        bot.client.on('error', (err) => {
            bot.status = 'Error';
            addLog(bot, `Hata: ${err.message}`, 'error');
            io.emit('bot-updated', bot);
        });

        bot.updateInterval = setInterval(() => {
            if (bot.status === 'Online') {
                bot.onlineTimeSeconds++;
                bot.radarEntities = Object.values(bot.entities).map(e => ({ x: e.x - bot.pos.x, z: e.z - bot.pos.z, type: e.type }));
                io.emit('bot-updated', bot);
            }
        }, 1000);

    } catch (err) {
        bot.status = 'Error';
        addLog(bot, `Başlatma Hatası: ${err.message}`, 'error');
        io.emit('bot-updated', bot);
    }
}

io.on('connection', (socket) => {
    socket.emit('init-data', { botList: bots });

    socket.on('add-bot', (data) => {
        const newBot = {
            id: 'bot_' + Date.now(),
            username: data.username || 'Bot',
            status: 'Offline',
            onlineTimeSeconds: 0,
            pos: { x: 0, y: 0, z: 0 },
            scoreboard: { title: data.host || 'SUNUCU', items: {} },
            tabList: [],
            radarEntities: [],
            logs: [],
            config: {
                host: data.host || 'oyna.aesirmc.com',
                port: Number(data.port) || 25565,
                version: data.version || 'auto',
                password: data.password || ''
            },
            client: null
        };
        bots.push(newBot);
        io.emit('bot-added', newBot);
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
            bots.splice(index, 1);
            io.emit('init-data', { botList: bots });
        }
    });

    socket.on('bot-command', (data) => {
        const { botId, command } = data;
        const bot = bots.find(b => b.id === botId);
        if (bot && bot.client && bot.status === 'Online') {
            sendCommand(bot, command);
            addLog(bot, `> ${command}`, 'system');
        }
    });
});

const PORT = 3000;
server.listen(PORT, () => console.log(`Sunucu aktif: http://localhost:${PORT}`));
