const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const mc = require('minecraft-protocol');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

// GENEL SUNUCU VE BOT YAPILANDIRMASI
let globalConfig = {
    host: 'play.donutsmp.net',
    port: 25565,
    version: '1.20.4',
    autoSubServerCmd: '/gir asmp'
};

let bots = {}; // { botId: { client, data, logs: [] } }

// SOCKET.IO BAĞLANTILARI
io.on('connection', (socket) => {
    // İlk bağlantıda mevcut verileri gönder
    const botList = Object.keys(bots).map(id => ({
        id: id,
        username: bots[id].data.username,
        status: bots[id].data.status,
        health: bots[id].data.health,
        food: bots[id].data.food,
        autoReconnect: bots[id].data.autoReconnect,
        antiAfk: bots[id].data.antiAfk,
        logs: bots[id].logs
    }));

    socket.emit('init-data', { globalConfig, botList });

    // YENİ BOT EKLEME
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
                autoReconnect: false,
                antiAfk: false
            },
            client: null,
            logs: []
        };

        io.emit('bot-added', bots[id].data);
        addLog(id, 'system', `${username} sisteme eklendi.`);
    });

    // BOT BAŞLATMA
    socket.on('start-bot', (botId) => {
        startBot(botId);
    });

    // BOT DURDURMA
    socket.on('stop-bot', (botId) => {
        stopBot(botId);
    });

    // TÜM BOTLARI BAŞLATMA
    socket.on('start-all', () => {
        Object.keys(bots).forEach(id => startBot(id));
    });

    // TÜM BOTLARI DURDURMA
    socket.on('stop-all', () => {
        Object.keys(bots).forEach(id => stopBot(id));
    });

    // KOMUT GÖNDERME (Sadece Seçili Bota)
    socket.on('send-command', ({ targetBotId, command }) => {
        if (targetBotId && bots[targetBotId] && bots[targetBotId].client) {
            bots[targetBotId].client.write('chat', { message: command });
            addLog(targetBotId, 'chat', `> ${command}`);
        }
    });

    // BOT ÖZEL AYAR GÜNCELLEME (Oto Rejoin / Anti-AFK)
    socket.on('update-bot-config', ({ botId, config }) => {
        if (bots[botId]) {
            Object.assign(bots[botId].data, config);
            addLog(botId, 'system', `Ayarlar güncellendi: ${JSON.stringify(config)}`);
        }
    });

    // GENEL SUNUCU AYARLARINI GÜNCELLEME
    socket.on('update-config', (newConfig) => {
        globalConfig = { ...globalConfig, ...newConfig };
        io.emit('init-data', { globalConfig, botList: Object.values(bots).map(b => b.data) });
    });
});

// BOT OLUŞTURMA VE BAĞLANMA MANTIĞI
function startBot(botId) {
    const bot = bots[botId];
    if (!bot || bot.data.status === 'Online' || bot.data.status === 'Connecting') return;

    updateBotStatus(botId, 'Connecting');
    addLog(botId, 'system', `${globalConfig.host} adresine bağlanılıyor...`);

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
            addLog(botId, 'system', `Sunucuya başarıyla giriş yapıldı!`);

            // Oto-Lobi / Aktarma komutu varsa çalıştır
            if (globalConfig.autoSubServerCmd) {
                setTimeout(() => {
                    if (bot.client) {
                        bot.client.write('chat', { message: globalConfig.autoSubServerCmd });
                        addLog(botId, 'system', `Aktarma komutu gönderildi: ${globalConfig.autoSubServerCmd}`);
                    }
                }, 3000);
            }
        });

        // Sohbet / Mesaj Takibi
        client.on('chat', (packet) => {
            try {
                const msg = JSON.parse(packet.message);
                const text = msg.text || (msg.extra ? msg.extra.map(e => e.text).join('') : '');
                if (text.trim()) addLog(botId, 'chat', text);
            } catch (e) {
                if (packet.message) addLog(botId, 'chat', packet.message);
            }
        });

        // Can ve Açlık Takibi
        client.on('update_health', (packet) => {
            bot.data.health = Math.round(packet.health);
            bot.data.food = Math.round(packet.food);
            io.emit('status-update', {
                botId,
                status: bot.data.status,
                health: bot.data.health,
                food: bot.data.food
            });
        });

        // Konum Takibi (Radar İçin)
        client.on('position', (packet) => {
            io.emit('bot-map-update', {
                botId,
                pos: { x: Math.round(packet.x), y: Math.round(packet.y), z: Math.round(packet.z) }
            });
        });

        // Bağlantı Kopma Durumu
        client.on('end', (reason) => {
            updateBotStatus(botId, 'Offline');
            addLog(botId, 'error', `Bağlantı kesildi: ${reason}`);
            bot.client = null;

            if (bot.data.autoReconnect) {
                addLog(botId, 'system', '5 saniye sonra tekrar bağlanılıyor...');
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
        bot.client.end('Kullanıcı tarafından durduruldu');
        bot.client = null;
        updateBotStatus(botId, 'Offline');
        addLog(botId, 'system', 'Bot durduruldu.');
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
    const log = {
        botId,
        type,
        text,
        timestamp: new Date().toLocaleTimeString('tr-TR', { hour12: false })
    };
    bots[botId].logs.push(log);
    if (bots[botId].logs.length > 100) bots[botId].logs.shift(); // Son 100 logu tut
    io.emit('bot-log', log);
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`[MC-PRO-DASHBOARD] Sunucu ${PORT} portunda aktif!`);
});
