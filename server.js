const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const mc = require('minecraft-protocol');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static('public'));

// Aktif Bot Listesi ve Varsayılan Ayarlar
let bots = [];
let globalSettings = {
    host: 'oyna.aesirmc.com',
    port: 25565,
    version: '1.20.6',
    password: 'eniyisiben',
    autoSubServerCmd: '/gir asmp'
};

function addLog(bot, text, type = 'info') {
    const timestamp = new Date().toLocaleTimeString('tr-TR');
    if (!bot.logs) bot.logs = [];
    bot.logs.push({ timestamp, text, type });
    if (bot.logs.length > 100) bot.logs.shift();
    io.emit('bot-log', { botId: bot.id, timestamp, text, type });
}

function startBotInstance(bot) {
    if (bot.client) {
        try { bot.client.end(); } catch (e) {}
    }

    bot.status = 'Connecting';
    addLog(bot, `${bot.username} sunucuya bağlanıyor (${bot.config.host}:${bot.config.port})...`, 'system');
    io.emit('bot-updated', bot);

    try {
        bot.client = mc.createClient({
            host: bot.config.host,
            port: Number(bot.config.port),
            username: bot.username,
            version: bot.config.version || false
        });

        bot.client.on('login', () => {
            bot.status = 'Online';
            addLog(bot, 'Sunucuya başarıyla giriş yapıldı!', 'system');
            
            if (bot.config.password) {
                setTimeout(() => {
                    bot.client.write('chat', { message: `/login ${bot.config.password}` });
                    addLog(bot, `Giriş şifresi gönderildi.`, 'system');
                }, 1000);
            }

            if (bot.config.autoSubServerCmd) {
                setTimeout(() => {
                    bot.client.write('chat', { message: bot.config.autoSubServerCmd });
                    addLog(bot, `Yönlendirme komutu gönderildi: ${bot.config.autoSubServerCmd}`, 'system');
                }, 2500);
            }

            io.emit('bot-updated', bot);
        });

        bot.client.on('position', (packet) => {
            bot.pos = {
                x: packet.x.toFixed(1),
                y: packet.y.toFixed(1),
                z: packet.z.toFixed(1)
            };
            io.emit('bot-updated', bot);
        });

        bot.client.on('update_health', (packet) => {
            bot.health = packet.health;
            bot.food = packet.food;
            io.emit('bot-updated', bot);
        });

        bot.client.on('chat', (packet) => {
            try {
                const msg = JSON.parse(packet.message);
                const text = msg.text || JSON.stringify(msg);
                addLog(bot, `[Chat] ${text}`);
            } catch (e) {
                addLog(bot, `[Chat] ${packet.message}`);
            }
        });

        bot.client.on('end', (reason) => {
            bot.status = 'Offline';
            addLog(bot, `Bağlantı kapandı. Sebep: ${reason}`, 'error');
            io.emit('bot-updated', bot);
        });

        bot.client.on('error', (err) => {
            bot.status = 'Error';
            addLog(bot, `Bağlantı Hatası: ${err.message}`, 'error');
            io.emit('bot-updated', bot);
        });

    } catch (err) {
        bot.status = 'Error';
        addLog(bot, `İstemci oluşturulamadı: ${err.message}`, 'error');
        io.emit('bot-updated', bot);
    }
}

io.on('connection', (socket) => {
    socket.emit('init-data', { botList: bots, globalSettings });

    socket.on('add-bot', (data) => {
        const newBot = {
            id: 'bot_' + Date.now(),
            username: data.username,
            status: 'Offline',
            health: 20,
            food: 20,
            pos: { x: 0, y: 0, z: 0 },
            config: { ...globalSettings },
            logs: [],
            client: null
        };
        bots.push(newBot);
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
            bot.status = 'Offline';
            addLog(bot, 'Bot manuel olarak durduruldu.', 'system');
            io.emit('bot-updated', bot);
        }
    });

    socket.on('delete-bot', (botId) => {
        const index = bots.findIndex(b => b.id === botId);
        if (index !== -1) {
            if (bots[index].client) {
                try { bots[index].client.end(); } catch (e) {}
            }
            bots.splice(index, 1);
            io.emit('init-data', { botList: bots, globalSettings });
        }
    });

    // Tümünü Başlat
    socket.on('start-all', () => {
        bots.forEach(bot => {
            if (bot.status !== 'Online' && bot.status !== 'Connecting') {
                startBotInstance(bot);
            }
        });
    });

    // Tümünü Durdur
    socket.on('stop-all', () => {
        bots.forEach(bot => {
            if (bot.client) {
                try { bot.client.end(); } catch (e) {}
                bot.status = 'Offline';
                addLog(bot, 'Bot durduruldu.', 'system');
                io.emit('bot-updated', bot);
            }
        });
    });

    // Global / Konsol Komut Gönderimi
    socket.on('global-command', (data) => {
        const { target, command } = data;
        bots.forEach(bot => {
            if ((target === 'all' || bot.id === target) && bot.client && bot.status === 'Online') {
                bot.client.write('chat', { message: command });
                addLog(bot, `[Komut] ${command}`, 'system');
            }
        });
    });

    // Genel Ayarları Güncelle
    socket.on('update-global-settings', (newSettings) => {
        globalSettings = newSettings;
        bots.forEach(bot => {
            bot.config = { ...bot.config, ...globalSettings };
        });
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Sunucu http://localhost:${PORT} adresinde çalışıyor.`);
});
