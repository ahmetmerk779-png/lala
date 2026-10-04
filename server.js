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
    if (bot.logs.length > 100) bot.logs.shift();
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
    if (bot.afkTimer) clearTimeout(bot.afkTimer);

    bot.status = 'Connecting';
    bot.onlineTimeSeconds = 0;
    bot.pos = { x: 0, y: 0, z: 0 };
    bot.scoreboard = { title: 'Skor Tablosu', items: {} };
    bot.tabPlayers = {};
    bot.tabList = [];
    bot.entities = {}; 
    bot.radarEntities = [];
    bot.afkState = { tries: 0, inAfkGui: false };

    addLog(bot, `${bot.username} sunucuya bağlanıyor (${bot.config.host}:${bot.config.port})`, 'system');
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
            bot.loginTimestamp = Date.now();
            addLog(bot, 'Giriş başarılı! Sunucu paketleri işleniyor...', 'system');
            
            // Otomatik Login Şifresi
            if (bot.config.password) {
                setTimeout(() => {
                    if (bot.client && bot.status === 'Online') {
                        sendCommand(bot, `/login ${bot.config.password}`);
                        addLog(bot, `Şifre otomatik gönderildi (/login).`, 'system');
                    }
                }, 2000);
            }

            // ASMP ve AFK Rutin Başlatma
            setTimeout(() => {
                startAsmpAfkRoutine(bot);
            }, 4500);
        });

        // GUİ / AFK Penceresi Açıldığında Slot Tıklama
        bot.client.on('open_window', (packet) => {
            const slotToClick = Number(bot.config.afkSlot) || 12;
            addLog(bot, `[GUI] AFK Menüsü Açıldı (ID: ${packet.windowId}). ${slotToClick}. slota tıklanıyor...`, 'system');
            bot.afkState.inAfkGui = true;
            bot.afkState.tries = 0;

            setTimeout(() => {
                if (bot.client && bot.status === 'Online') {
                    try {
                        bot.client.write('window_click', {
                            windowId: packet.windowId,
                            slot: slotToClick,
                            mouseButton: 0,
                            actionNumber: 1,
                            mode: 0,
                            item: { blockId: -1 }
                        });
                        addLog(bot, `[GUI] ${slotToClick}. Slota tıklandı! AFK moduna geçildi.`, 'system');
                    } catch (err) {
                        addLog(bot, `[Tıklama Hatası] ${err.message}`, 'error');
                    }
                }
            }, 800);
        });

        // Pozisyon ve Radar Verisi
        bot.client.on('position', (packet) => { 
            bot.pos = { x: Math.round(packet.x), y: Math.round(packet.y), z: Math.round(packet.z) }; 
        });

        // TAB LISTESİ OYUNCULARI
        bot.client.on('player_info_update', (packet) => {
            if(packet.data) {
                packet.data.forEach(p => {
                    if (!bot.tabPlayers[p.UUID]) bot.tabPlayers[p.UUID] = { name: 'Oyuncu', ping: 0 };
                    if (p.player && p.player.name) bot.tabPlayers[p.UUID].name = p.player.name;
                    if (p.latency !== undefined) bot.tabPlayers[p.UUID].ping = p.latency;
                });
                bot.tabList = Object.values(bot.tabPlayers).filter(x => x.name !== 'Oyuncu');
            }
        });

        bot.client.on('player_info', (packet) => {
            if (packet.action === 0 && packet.data) {
                packet.data.forEach(p => {
                    bot.tabPlayers[p.UUID] = { name: p.name || 'Oyuncu', ping: p.ping || 0 };
                });
            } else if (packet.action === 4 && packet.data) {
                packet.data.forEach(p => { delete bot.tabPlayers[p.UUID]; });
            }
            bot.tabList = Object.values(bot.tabPlayers).filter(x => x.name !== 'Oyuncu');
        });

        // SCOREBOARD (SKOR TABLOSU)
        bot.client.on('scoreboard_objective', (packet) => {
            if (packet.action === 0 || packet.action === 2) {
                bot.scoreboard.title = parseChat(packet.displayText) || packet.name;
            }
        });
        
        bot.client.on('scoreboard_score', (packet) => {
            const cleanName = parseChat(packet.itemName).replace(/([>])/g, '');
            if (packet.action === 0) {
                bot.scoreboard.items[cleanName] = packet.value;
            } else if (packet.action === 1) {
                delete bot.scoreboard.items[cleanName];
            }
        });

        // SOHBET & DUYURU MESAJLARI (TÜM SÜRÜMLER İÇİN DÜZELTİLDİ)
        bot.client.on('chat', (packet) => {
            const text = parseChat(packet.message);
            if(text) addLog(bot, `[Sohbet] ${text}`, 'chat');
        });

        bot.client.on('systemChat', (packet) => {
            const text = parseChat(packet.content);
            if(text) addLog(bot, `[Sistem] ${text}`, 'system');
        });

        bot.client.on('playerChat', (packet) => {
            const sender = packet.senderName ? parseChat(packet.senderName) : 'Oyuncu';
            const msg = parseChat(packet.formattedMessage || packet.unsignedContent || packet.plainMessage);
            addLog(bot, `<${sender}> ${msg}`, 'chat');
        });

        // RADAR / ETRAFTAKİ YARATIK - OYUNCULAR
        bot.client.on('named_entity_spawn', (packet) => {
            bot.entities[packet.entityId] = { x: packet.x / 32, z: packet.z / 32, type: 'player' };
        });
        bot.client.on('spawn_entity', (packet) => {
            bot.entities[packet.entityId] = { x: packet.x, z: packet.z, type: 'mob' };
        });
        bot.client.on('entity_destroy', (packet) => {
            if (packet.entityIds) packet.entityIds.forEach(id => delete bot.entities[id]);
        });

        // BAĞLANTI KOPMA & HATALAR
        bot.client.on('end', (reason) => {
            bot.status = 'Offline';
            if (bot.updateInterval) clearInterval(bot.updateInterval);
            if (bot.afkTimer) clearTimeout(bot.afkTimer);
            addLog(bot, `Bağlantı kesildi: ${reason}. 10 sn sonra oto-bağlanılacak...`, 'error');
            io.emit('bot-updated', bot);

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

        // DÖNGÜ (SÜRE VE ARAYÜZ GÜNCELLEME)
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

function startAsmpAfkRoutine(bot) {
    if (!bot.client || bot.status !== 'Online') return;

    const subCmd = bot.config.autoSubServerCmd || '/gir asmp';
    const afkCmd = bot.config.afkCmd || '/afk';

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
            addLog(bot, `[Otomasyon] ${afkCmd} deneniyor (${bot.afkState.tries}/3)...`, 'system');
            sendCommand(bot, afkCmd);

            bot.afkTimer = setTimeout(() => {
                if (!bot.afkState.inAfkGui) {
                    runAfkLoop();
                }
            }, 3500);
        } else {
            addLog(bot, `[Otomasyon] 3 kez ${afkCmd} denendi ancak menü açılmadı. Tekrar ${subCmd} atılıyor...`, 'error');
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
            onlineTimeSeconds: 0,
            pos: { x: 0, y: 0, z: 0 },
            scoreboard: { title: 'Skor Tablosu', items: {} },
            tabList: [],
            radarEntities: [],
            logs: [],
            config: {
                host: data.host || 'oyna.aesirmc.com',
                port: data.port || 25565,
                version: data.version || 'auto',
                password: data.password || '',
                autoSubServerCmd: data.autoSubServerCmd || '/gir asmp',
                afkCmd: data.afkCmd || '/afk',
                afkSlot: data.afkSlot || 12
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
            addLog(bot, 'Bot ayarları güncellendi.', 'system');
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
