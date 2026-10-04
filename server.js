const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
mc = require('minecraft-protocol');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static('public'));

// Aktif Bot Listesi
let bots = [];

// Yardımcı Log Ekleme Fonksiyonu
function addLog(bot, text, type = 'info') {
    const timestamp = new Date().toLocaleTimeString('tr-TR');
    if (!bot.logs) bot.logs = [];
    bot.logs.push({ timestamp, text, type });
    if (bot.logs.length > 100) bot.logs.shift();
    
    io.emit('bot-log', { botId: bot.id, timestamp, text, type });
}

// Bot Başlatma Fonksiyonu (node-minecraft-protocol ile)
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
            
            // Şifre varsa gönder
            if (bot.config.password) {
                setTimeout(() => {
                    bot.client.write('chat', { message: `/login ${bot.config.password}` });
                    addLog(bot, `Giriş şifresi gönderildi.`, 'system');
                }, 1000);
            }

            // Sub-server / Lobi Komutu (/gir)
            if (bot.config.autoSubServerCmd) {
                setTimeout(() => {
                    bot.client.write('chat', { message: bot.config.autoSubServerCmd });
                    addLog(bot, `Yönlendirme komutu gönderildi: ${bot.config.autoSubServerCmd}`, 'system');
                }, 2500);
            }

            io.emit('bot-updated', bot);
        });

        // Konum Güncellemeleri
        bot.client.on('position', (packet) => {
            bot.pos = {
                x: packet.x.toFixed(1),
                y: packet.y.toFixed(1),
                z: packet.z.toFixed(1)
            };
            io.emit('bot-updated', bot);
        });

        // Sağlık ve Açlık (Eğer paket gelirse)
        bot.client.on('update_health', (packet) => {
            bot.health = packet.health;
            bot.food = packet.food;
            io.emit('bot-updated', bot);
        });

        // Chat ve Loglar
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

            // Oto-Yeniden Bağlanma
            if (bot.config.autoReconnect) {
                addLog(bot, '5 saniye sonra yeniden bağlanılacak...', 'system');
                setTimeout(() => {
                    if (bot.status === 'Offline') startBotInstance(bot);
                }, 5000);
            }
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

// Socket.io Bağlantı Yönetimi
io.on('connection', (socket) => {
    socket.emit('init-data', { botList: bots });

    socket.on('add-bot', (data) => {
        const newBot = {
            id: 'bot_' + Date.now(),
            username: data.username,
            status: 'Offline',
            health: 20,
            food: 20,
            pos: { x: 0, y: 64, z: 0 },
            config: {
                host: 'oyna.aesirmc.com',
                port: 25565,
                version: '1.20.6',
                password: 'eniyisiben',
                autoSubServerCmd: '/gir asmp',
                autoReconnect: true,
                autoAntiAfk: true
            },
            logs: [],
            inventory: [],
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
            io.emit('init-data', { botList: bots });
        }
    });

    socket.on('send-command', (data) => {
        const bot = bots.find(b => b.id === data.targetBotId);
        if (bot && bot.client && bot.status === 'Online') {
            bot.client.write('chat', { message: data.command });
            addLog(bot, `[Komut] ${data.command}`, 'system');
        }
    });

    socket.on('update-bot-config', (data) => {
        const bot = bots.find(b => b.id === data.botId);
        if (bot) {
            bot.config = { ...bot.config, ...data.config };
            addLog(bot, 'Bot yapılandırma ayarları güncellendi.', 'system');
            io.emit('bot-updated', bot);
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Sunucu http://localhost:${PORT} adresinde çalışıyor.`);
});
