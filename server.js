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
    if (bot.logs.length > 80) bot.logs.shift();
    io.emit('bot-log', { botId: bot.id, timestamp, text, type });
}

function parseChat(chat) {
    if (!chat) return '';
    if (typeof chat === 'string') {
        try { chat = JSON.parse(chat); } catch (e) { return chat; }
    }
    let text = chat.text || chat.translate || '';
    if (chat.extra) chat.extra.forEach(ex => text += parseChat(ex));
    return text.replace(/§[0-9a-fk-or]/ig, '').trim();
}

// 1.20+ Komut ve Sohbet Destekli Güvenli Gönderici
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
    if (bot.afkTimer) clearTimeout(bot.afkTimer);

    bot.status = 'Connecting';
    bot.pos = { x: 0, y: 0, z: 0 };
    bot.scoreboard = { title: 'Yükleniyor...', items: {} };
    bot.tabPlayers = {};
    bot.tabList = [];
    bot.entities = {}; 
    bot.radarEntities = [];
    bot.afkState = { tries: 0, inAfkGui: false };

    addLog(bot, `${bot.username} sunucuya bağlanıyor (${bot.config.host}:${bot.config.port} - Ver: ${bot.config.version || 'Auto'})`, 'system');
    io.emit('bot-updated', bot);

    try {
        const clientOptions = {
            host: bot.config.host,
            port: Number(bot.config.port) || 25565,
            username: bot.username,
            skipValidation: true
        };

        if (bot.config.version && bot.config.version !== 'auto') {
            clientOptions.version = bot.config.version;
        }

        bot.client = mc.createClient(clientOptions);

        bot.client.once('login', () => {
            bot.status = 'Online';
            addLog(bot, 'Giriş başarılı! Sunucu paketleri işleniyor...', 'system');
            
            // 1. Şifre Girişi
            if (bot.config.password) {
                setTimeout(() => {
                    if (bot.client && bot.status === 'Online') {
                        sendCommand(bot, `/login ${bot.config.password}`);
                        addLog(bot, `Şifre gönderildi (/login).`, 'system');
                    }
                }, 2000);
            }

            // 2. ASMP ve AFK Otomasyonunu Başlat
            setTimeout(() => {
                startAsmpAfkRoutine(bot);
            }, 4500);
        });

        // AFK Menüsü (GUI Window) Açıldığında 12. Slota Tıkla
        bot.client.on('open_window', (packet) => {
            addLog(bot, `[GUI] AFK Menüsü Açıldı (ID: ${packet.windowId}). Ortadaki 12. slota tıklanıyor...`, 'system');
            bot.afkState.inAfkGui = true;
            bot.afkState.tries = 0; // Başarılı oldu

            setTimeout(() => {
                if (bot.client && bot.status === 'Online') {
                    try {
                        bot.client.write('window_click', {
                            windowId: packet.windowId,
                            slot: 12, // Ortadaki 12. Slot
                            mouseButton: 0,
                            actionNumber: 1,
                            mode: 0,
                            item: { blockId: -1 }
                        });
                        addLog(bot, `[GUI] 12. Slota tıklandı! AFK moduna geçildi.`, 'system');
                    } catch (err) {
                        addLog(bot, `[Tıklama Hatası] ${err.message}`, 'error');
                    }
                }
            }, 800);
        });

        bot.client.on('position', (packet) => { bot.pos = { x: packet.x, y: packet.y, z: packet.z }; });

        bot.client.on('player_info_update', (packet) => {
            if(packet.data) {
                packet.data.forEach(p => {
                    if (!bot.tabPlayers[p.UUID]) bot.tabPlayers[p.UUID] = { name: 'Oyuncu', ping: 0 };
                    if (p.player && p.player.name) bot.tabPlayers[p.UUID].name = p.player.name;
                    if (p.latency !== undefined) bot.tabPlayers[p.UUID].ping = p.latency;
                });
                bot.tabList = Object.values(bot.tabPlayers);
            }
        });

        bot.client.on('scoreboard_objective', (packet) => {
            if (packet.action === 0 || packet.action === 2) bot.scoreboard.title = parseChat(packet.displayText) || packet.name;
        });
        
        bot.client.on('scoreboard_score', (packet) => {
            const cleanName = parseChat(packet.itemName).replace(/([>])/g, '');
            if (packet.action === 0) bot.scoreboard.items[cleanName] = packet.value;
            else if (packet.action === 1) delete bot.scoreboard.items[cleanName];
        });

        bot.client.on('chat', (packet) => {
            const text = parseChat(packet.message);
            if(text) addLog(bot, `[Chat] ${text}`);
        });

        bot.client.on('end', (reason) => {
            bot.status = 'Offline';
            if (bot.updateInterval) clearInterval(bot.updateInterval);
            if (bot.afkTimer) clearTimeout(bot.afkTimer);
            addLog(bot, `Bağlantı kesildi: ${reason}. 10 sn sonra oto-bağlanılacak...`, 'error');
            io.emit('bot-updated', bot);

            // socketClosed durumunda Otomatik Yeniden Bağlanma
            setTimeout(() => {
                if (bot.status === 'Offline') {
                    addLog(bot, 'Otomatik yeniden bağlanılıyor...', 'system');
                    startBotInstance(bot);
                }
            }, 10000);
        });

        bot.client.on('error', (err) => {
            bot.status = 'Error';
            if (bot.updateInterval) clearInterval(bot.updateInterval);
            if (bot.afkTimer) clearTimeout(bot.afkTimer);
            addLog(bot, `Hata: ${err.message}`, 'error');
            io.emit('bot-updated', bot);
        });

        bot.updateInterval = setInterval(() => {
            if (bot.status === 'Online') {
                bot.radarEntities = Object.values(bot.entities).map(e => ({ x: e.x, z: e.z }));
                io.emit('bot-updated', bot);
            }
        }, 1000);

    } catch (err) {
        bot.status = 'Error';
        addLog(bot, `Başlatma Hatası: ${err.message}`, 'error');
        io.emit('bot-updated', bot);
    }
}

// ASMP & 3x /AFK Otomasyon Fonksiyonu
function startAsmpAfkRoutine(bot) {
    if (!bot.client || bot.status !== 'Online') return;

    const subCmd = bot.config.autoSubServerCmd || '/gir asmp';
    addLog(bot, `[Otomasyon] Sunucuya geçiliyor: ${subCmd}`, 'system');
    sendCommand(bot, subCmd);

    bot.afkState = { tries: 0, inAfkGui: false };

    function runAfkLoop() {
        if (!bot.client || bot.status !== 'Online') return;

        if (bot.afkState.inAfkGui) {
            addLog(bot, '[Otomasyon] AFK Menüsü zaten açık.', 'system');
            return;
        }

        if (bot.afkState.tries < 3) {
            bot.afkState.tries++;
            addLog(bot, `[Otomasyon] /afk deneniyor (${bot.afkState.tries}/3)...`, 'system');
            sendCommand(bot, '/afk');

            bot.afkTimer = setTimeout(() => {
                if (!bot.afkState.inAfkGui) {
                    runAfkLoop();
                }
            }, 3500);
        } else {
            addLog(bot, '[Otomasyon] 3 kez /afk denendi fakat yanıt alınamadı. Tekrar ASMP sunucusuna aktarılıyor...', 'error');
            bot.afkState.tries = 0;
            sendCommand(bot, subCmd);

            bot.afkTimer = setTimeout(() => {
                runAfkLoop();
            }, 5000);
        }
    }

    bot.afkTimer = setTimeout(() => {
        runAfkLoop();
    }, 4000);
}

io.on('connection', (socket) => {
    socket.emit('init-data', { botList: bots });

    socket.on('add-bot', (data) => {
        const newBot = {
            id: 'bot_' + Date.now(),
            username: data.username || 'Bot_' + Math.floor(Math.random() * 1000),
            status: 'Offline',
            pos: { x: 0, y: 0, z: 0 },
            scoreboard: { title: 'Yükleniyor...', items: {} },
            tabList: [],
            radarEntities: [],
            logs: [],
            config: {
                host: data.host || 'oyna.aesirmc.com',
                port: data.port || 25565,
                version: data.version || 'auto',
                password: data.password || '',
                autoSubServerCmd: data.autoSubServerCmd || '/gir asmp'
            },
            client: null
        };
        bots.push(newBot);
        io.emit('bot-added', newBot);
    });

    socket.on('update-bot-config', (data) => {
        const bot = bots.find(b => b.id === data.botId);
        if (bot) {
            bot.config = { ...bot.config, ...data.config };
            addLog(bot, 'Bot konfigürasyonu güncellendi.', 'system');
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
            if (bots[index].afkTimer) clearTimeout(bots[index].afkTimer);
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
