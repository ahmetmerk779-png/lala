const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const mc = require('minecraft-protocol');
const fs = require('fs');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(express.static('public'));
app.use(express.json());

let bots = [];
const BOTS_FILE = path.join(__dirname, 'bots.json');

function loadBots() {
    try {
        if (fs.existsSync(BOTS_FILE)) {
            const raw = fs.readFileSync(BOTS_FILE, 'utf8');
            const parsed = JSON.parse(raw);
            return Array.isArray(parsed) ? parsed : [];
        }
    } catch (err) {
        console.log('Bot verisi yüklenemedi, yeni başlatılıyor.');
    }
    return [];
}

function saveBots() {
    try {
        const data = bots.map(bot => ({
            id: bot.id,
            username: bot.username,
            config: bot.config,
            afkMode: bot.afkMode
        }));
        fs.writeFileSync(BOTS_FILE, JSON.stringify(data, null, 2));
    } catch (err) {
        console.error('Bot dosyası kaydedilemedi:', err);
    }
}

bots = loadBots().map(botData => ({
    ...botData,
    status: 'Offline',
    onlineTimeSeconds: 0,
    pos: { x: 0, y: 0, z: 0 },
    scoreboard: { title: botData.config?.host || 'SUNUCU', items: {} },
    tabPlayers: {},
    tabList: [],
    entities: {},
    radarEntities: [],
    logs: [],
    client: null,
    afkMode: {
        enabled: Boolean(botData.afkMode?.enabled),
        afkTime: 0,
        rotationEnabled: Boolean(botData.afkMode?.rotationEnabled),
        jumpEnabled: Boolean(botData.afkMode?.jumpEnabled),
        messageInterval: Number(botData.afkMode?.messageInterval) || 0
    }
}));

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
    if (!cmd) return;

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

function startAFKMode(bot) {
    if (!bot.afkMode.enabled || bot.status !== 'Online') return;

    bot.afkMode.afkTime += 1;

    if (bot.afkMode.rotationEnabled && bot.client) {
        try {
            const yaw = (Math.random() - 0.5) * Math.PI * 2;
            const pitch = (Math.random() - 0.5) * Math.PI * 0.7;
            bot.client.write('look', { yaw, pitch, onGround: true });
        } catch (e) {
            // Rotation unsupported; ignore.
        }
    }

    if (bot.afkMode.jumpEnabled && bot.client && Math.random() > 0.8) {
        try {
            bot.client.write('entity_action', {
                entityId: bot.client.entityId || 0,
                actionId: 'jump',
                jumpBoost: 0
            });
        } catch (e) {
            // Jump unsupported; ignore.
        }
    }

    if (bot.afkMode.messageInterval > 0 && bot.afkMode.afkTime % bot.afkMode.messageInterval === 0) {
        const messages = ['AFK', 'Buradayım', 'Bot aktif', '...', 'Oynuyorum', 'AFK mod aktif'];
        const msg = messages[Math.floor(Math.random() * messages.length)];
        sendCommand(bot, msg);
    }
}

function startBotInstance(bot) {
    if (bot.client) {
        try { bot.client.removeAllListeners(); bot.client.end(); } catch (e) {}
    }
    if (bot.updateInterval) clearInterval(bot.updateInterval);
    if (bot.afkInterval) clearInterval(bot.afkInterval);
    if (bot.loginTimeout) clearTimeout(bot.loginTimeout);

    bot.status = 'Connecting';
    bot.onlineTimeSeconds = 0;
    bot.pos = { x: 0, y: 0, z: 0 };
    bot.scoreboard = { title: bot.config.host, items: {} };
    bot.tabPlayers = {};
    bot.tabList = [];
    bot.entities = {};
    bot.radarEntities = [];
    bot.afkMode.afkTime = 0;

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

            if (bot.afkMode.enabled) {
                addLog(bot, 'AFK modu etkinleştirildi.', 'system');
                bot.afkInterval = setInterval(() => startAFKMode(bot), 1000);
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
            if (!cleanName) return;
            if (packet.action === 0) {
                bot.scoreboard.items[cleanName] = packet.value;
            } else if (packet.action === 1) {
                delete bot.scoreboard.items[cleanName];
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
            if (bot.afkInterval) clearInterval(bot.afkInterval);
            addLog(bot, `Bağlantı kesildi: ${reason}`, 'error');
            io.emit('bot-updated', bot);
        });

        bot.client.on('error', (err) => {
            bot.status = 'Error';
            if (bot.updateInterval) clearInterval(bot.updateInterval);
            if (bot.afkInterval) clearInterval(bot.afkInterval);
            addLog(bot, `Hata: ${err.message}`, 'error');
            io.emit('bot-updated', bot);
        });

        bot.updateInterval = setInterval(() => {
            if (bot.status === 'Online') {
                bot.onlineTimeSeconds += 1;
                bot.radarEntities = Object.values(bot.entities).map(e => ({
                    x: e.x - bot.pos.x,
                    z: e.z - bot.pos.z,
                    type: e.type
                }));
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
            client: null,
            afkMode: {
                enabled: Boolean(data.afkMode?.enabled),
                afkTime: 0,
                rotationEnabled: Boolean(data.afkMode?.rotationEnabled),
                jumpEnabled: Boolean(data.afkMode?.jumpEnabled),
                messageInterval: Number(data.afkMode?.messageInterval) || 0
            }
        };

        bots.push(newBot);
        saveBots();
        io.emit('bot-added', newBot);
    });

    socket.on('start-bot', (botId) => {
        const bot = bots.find(b => b.id === botId);
        if (bot) startBotInstance(bot);
    });

    socket.on('stop-bot', (botId) => {
        const bot = bots.find(b => b.id === botId);
        if (bot && bot.client) {
            try { bot.client.end(); } catch (e) {}
            if (bot.afkInterval) clearInterval(bot.afkInterval);
            bot.status = 'Offline';
            addLog(bot, 'Bot durduruldu.', 'system');
            io.emit('bot-updated', bot);
        }
    });

    socket.on('delete-bot', (botId) => {
        const index = bots.findIndex(b => b.id === botId);
        if (index !== -1) {
            if (bots[index].client) {
                try { bots[index].client.end(); } catch (e) {}
            }
            if (bots[index].afkInterval) clearInterval(bots[index].afkInterval);
            bots.splice(index, 1);
            saveBots();
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

    socket.on('set-afk-mode', (data) => {
        const { botId, afkSettings } = data;
        const bot = bots.find(b => b.id === botId);
        if (!bot) return;

        bot.afkMode = {
            ...bot.afkMode,
            ...afkSettings,
            enabled: Boolean(afkSettings.enabled),
            rotationEnabled: Boolean(afkSettings.rotationEnabled),
            jumpEnabled: Boolean(afkSettings.jumpEnabled),
            messageInterval: Number(afkSettings.messageInterval) || 0
        };

        if (bot.afkMode.enabled && bot.status === 'Online') {
            if (bot.afkInterval) clearInterval(bot.afkInterval);
            bot.afkInterval = setInterval(() => startAFKMode(bot), 1000);
        } else if (bot.afkInterval) {
            clearInterval(bot.afkInterval);
            bot.afkInterval = null;
        }

        addLog(bot, `AFK Modu: ${bot.afkMode.enabled ? 'Etkin' : 'Devre Dışı'}`, 'system');
        io.emit('bot-updated', bot);
        saveBots();
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Sunucu aktif: http://localhost:${PORT}`));
