const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const mineflayer = require('mineflayer');
const path = require('path');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

const DATA_FILE = path.join(__dirname, 'bots.json');

// Bot Yönetim Havuzu
const botPool = new Map();

// Varsayılan Sunucu ve Otomasyon Ayarları
let globalConfig = {
    host: '141.95.82.164',
    port: 25565,
    version: '1.20.1',
    autoPassword: 'deliyizpassword',    // Otomatik Giriş/Kayıt Şifresi
    autoSubServerCmd: '/server boxpvp', // Otomatik Geçilecek Alt Sunucu Komutu
    autoSubServerDelay: 3               // Saniye cinsinden gecikme
};

// Varsayılan Bot Listesi (İlk çalıştırmada dosya yoksa kullanılır)
const defaultBotConfigs = [
    { id: 'bot_1', username: 'Deliyiz_1' },
    { id: 'bot_2', username: 'Deliyiz_2' },
    { id: 'bot_3', username: 'Deliyiz_3' }
];

// ==========================================
// HAFIZA (DOSYA KAYIT & YÜKLEME) FONKSİYONLARI
// ==========================================

function loadSavedData() {
    if (!fs.existsSync(DATA_FILE)) {
        defaultBotConfigs.forEach(cfg => {
            botPool.set(cfg.id, {
                id: cfg.id,
                username: cfg.username,
                status: 'Offline',
                instance: null,
                logs: []
            });
        });
        saveDataToFile();
        return;
    }

    try {
        const rawData = fs.readFileSync(DATA_FILE, 'utf8');
        const parsed = JSON.parse(rawData);

        if (parsed.globalConfig) {
            globalConfig = { ...globalConfig, ...parsed.globalConfig };
        }

        if (Array.isArray(parsed.bots) && parsed.bots.length > 0) {
            botPool.clear();
            parsed.bots.forEach(b => {
                botPool.set(b.id, {
                    id: b.id,
                    username: b.username,
                    status: 'Offline',
                    instance: null,
                    logs: []
                });
            });
        } else {
            defaultBotConfigs.forEach(cfg => {
                botPool.set(cfg.id, {
                    id: cfg.id,
                    username: cfg.username,
                    status: 'Offline',
                    instance: null,
                    logs: []
                });
            });
        }
    } catch (err) {
        console.error('[Hafıza Hatası] Kayıtlı veriler okunamadı:', err);
    }
}

function saveDataToFile() {
    try {
        const botList = Array.from(botPool.values()).map(b => ({
            id: b.id,
            username: b.username
        }));

        const dataToSave = {
            globalConfig,
            bots: botList
        };

        fs.writeFileSync(DATA_FILE, JSON.stringify(dataToSave, null, 2));
    } catch (err) {
        console.error('[Hafıza Hatası] Veri kaydedilemedi:', err);
    }
}

// Sunucu başlarken hafızadaki botları ve ayarları yükle
loadSavedData();

// ==========================================
// BOT LOG VE MINEFLAYER MANTIĞI
// ==========================================

function broadcastLog(botId, text, type = 'info') {
    const timestamp = new Date().toLocaleTimeString('tr-TR');
    const logEntry = { botId, text, timestamp, type };

    if (botPool.has(botId)) {
        const botData = botPool.get(botId);
        botData.logs.push(logEntry);
        if (botData.logs.length > 200) botData.logs.shift();
    }

    io.emit('bot-log', logEntry);
}

function startBotInstance(botId) {
    const botData = botPool.get(botId);
    if (!botData) return;

    if (botData.instance) {
        broadcastLog(botId, 'Bot zaten aktif durumda.', 'warn');
        return;
    }

    broadcastLog(botId, `${botData.username} sunucuya bağlanıyor (${globalConfig.host}:${globalConfig.port})...`, 'info');
    botData.status = 'Connecting';
    io.emit('status-update', { botId, status: 'Connecting' });

    try {
        const bot = mineflayer.createBot({
            host: globalConfig.host,
            port: Number(globalConfig.port),
            username: botData.username,
            version: globalConfig.version || false
        });

        botData.instance = bot;

        bot.on('spawn', () => {
            botData.status = 'Online';
            broadcastLog(botId, `⚡ ${botData.username} sunucuya girdi!`, 'success');
            io.emit('status-update', { botId, status: 'Online' });

            // Otomatik Alt Sunucuya Geçiş (Gecikmeli)
            if (globalConfig.autoSubServerCmd && globalConfig.autoSubServerCmd.trim() !== '') {
                const delayMs = (Number(globalConfig.autoSubServerDelay) || 3) * 1000;
                broadcastLog(botId, `⏳ ${globalConfig.autoSubServerDelay}sn sonra alt sunucuya geçilecek: ${globalConfig.autoSubServerCmd}`, 'info');
                
                setTimeout(() => {
                    if (botData.instance && botData.status === 'Online') {
                        botData.instance.chat(globalConfig.autoSubServerCmd);
                        broadcastLog(botId, `🚀 Alt sunucu komutu gönderildi: ${globalConfig.autoSubServerCmd}`, 'success');
                    }
                }, delayMs);
            }
        });

        // OTOMATİK LOGIN / REGISTER DİNLEYİCİSİ (TR/EN Çift Mesaj Korumalı)
        let lastAuthTime = 0;

        bot.on('messagestr', (msg) => {
            if (!msg.trim()) return;
            broadcastLog(botId, msg, 'chat');

            const lowerMsg = msg.toLowerCase();
            const pwd = globalConfig.autoPassword;
            const now = Date.now();

            // Aynı komutun 5 saniye içinde tekrar tetiklenmesini engeller
            if (pwd && pwd.trim() !== '' && (now - lastAuthTime > 5000)) {
                // Register Algılama
                if (lowerMsg.includes('/register') || lowerMsg.includes('kayıt ol') || lowerMsg.includes('kayitol')) {
                    lastAuthTime = now;
                    setTimeout(() => {
                        if (botData.instance) {
                            botData.instance.chat(`/register ${pwd} ${pwd}`);
                            broadcastLog(botId, `🔑 Otomatik /register gönderildi.`, 'info');
                        }
                    }, 1000);
                }
                // Login Algılama
                else if (lowerMsg.includes('/login') || lowerMsg.includes('giriş yap') || lowerMsg.includes('giris yap')) {
                    lastAuthTime = now;
                    setTimeout(() => {
                        if (botData.instance) {
                            botData.instance.chat(`/login ${pwd}`);
                            broadcastLog(botId, `🔑 Otomatik /login gönderildi.`, 'info');
                        }
                    }, 1000);
                }
            }
        });

        bot.on('error', (err) => {
            broadcastLog(botId, `❌ Hata: ${err.message}`, 'error');
        });

        bot.on('kicked', (reason) => {
            broadcastLog(botId, `⚠️ Atıldı: ${reason}`, 'warn');
        });

        bot.on('end', () => {
            botData.status = 'Offline';
            botData.instance = null;
            broadcastLog(botId, `🔴 ${botData.username} bağlantısı kesildi.`, 'error');
            io.emit('status-update', { botId, status: 'Offline' });
        });

    } catch (err) {
        botData.status = 'Offline';
        botData.instance = null;
        broadcastLog(botId, `Başlatma Hatası: ${err.message}`, 'error');
        io.emit('status-update', { botId, status: 'Offline' });
    }
}

function stopBotInstance(botId) {
    const botData = botPool.get(botId);
    if (botData && botData.instance) {
        botData.instance.quit();
        botData.instance = null;
        botData.status = 'Offline';
        broadcastLog(botId, 'Bot durduruldu.', 'warn');
        io.emit('status-update', { botId, status: 'Offline' });
    }
}

function startAllBots() {
    let delay = 0;
    for (const [id, botData] of botPool.entries()) {
        if (botData.status === 'Offline') {
            setTimeout(() => startBotInstance(id), delay);
            delay += 3500; // Anti-bot korumasını aşmak için 3.5 sn ara
        }
    }
}

// ==========================================
// SOCKET.IO ARAYÜZ VE SİSTEM OLAYLARI
// ==========================================

io.on('connection', (socket) => {
    const botList = Array.from(botPool.values()).map(b => ({
        id: b.id,
        username: b.username,
        status: b.status,
        logs: b.logs
    }));

    // Başlangıç Verilerini Gönder
    socket.emit('init-data', { botList, globalConfig });

    // Ayarları Güncelleme
    socket.on('update-config', (newConfig) => {
        globalConfig = { ...globalConfig, ...newConfig };
        saveDataToFile(); // Ayarları dosyaya kaydet
        io.emit('config-updated', globalConfig);
    });

    socket.on('start-bot', (botId) => startBotInstance(botId));
    socket.on('stop-bot', (botId) => stopBotInstance(botId));

    socket.on('delete-bot', (botId) => {
        stopBotInstance(botId);
        if (botPool.has(botId)) {
            botPool.delete(botId);
            saveDataToFile(); // Silme işlemini dosyaya kaydet
            io.emit('bot-deleted', botId);
        }
    });

    socket.on('start-all', () => {
        startAllBots();
    });

    socket.on('stop-all', () => {
        for (const id of botPool.keys()) {
            stopBotInstance(id);
        }
    });

    socket.on('add-bot', (username) => {
        if (!username) return;
        const id = 'bot_' + Date.now();
        botPool.set(id, {
            id,
            username,
            status: 'Offline',
            instance: null,
            logs: []
        });
        saveDataToFile(); // Yeni botu dosyaya kaydet
        io.emit('bot-added', { id, username, status: 'Offline', logs: [] });
    });

    socket.on('send-command', ({ targetBotId, command }) => {
        if (!command) return;

        if (targetBotId === 'all') {
            botPool.forEach((botData) => {
                if (botData.instance && botData.status === 'Online') {
                    botData.instance.chat(command);
                    broadcastLog(botData.id, `> ${command}`, 'command');
                }
            });
        } else {
            const botData = botPool.get(targetBotId);
            if (botData && botData.instance && botData.status === 'Online') {
                botData.instance.chat(command);
                broadcastLog(targetBotId, `> ${command}`, 'command');
            }
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Çoklu Bot Paneli http://localhost:${PORT} üzerinde çalışıyor.`);
    console.log(`[Hafıza] ${botPool.size} adet bot yüklendi. Otomatik başlatılıyor...`);
    
    // Sunucu açıldığında/yeniden başladığında kayıtlı botları otomatik oyuna sokar
    startAllBots();
});
