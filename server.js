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

// Varsayılan Sunucu ve Otomasyon Ayarları (Yedek Genel Ayarlar)
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
    { id: 'bot_1', username: 'Deliyiz_1', host: '141.95.82.164', port: 25565, autoPassword: 'deliyizpassword' },
    { id: 'bot_2', username: 'Deliyiz_2', host: '141.95.82.164', port: 25565, autoPassword: 'deliyizpassword' },
    { id: 'bot_3', username: 'Deliyiz_3', host: '141.95.82.164', port: 25565, autoPassword: 'deliyizpassword' }
];

// ==========================================
// HAFIZA (DOSYA KAYIT & YÜKLEME) FONKSİYONLARI
// ==========================================

function loadSavedData() {
    if (!fs.existsSync(DATA_FILE)) {
        defaultBotConfigs.forEach(cfg => {
            botPool.set(cfg.id, {
                ...cfg,
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
                    ...b,
                    status: 'Offline',
                    instance: null,
                    logs: []
                });
            });
        } else {
            defaultBotConfigs.forEach(cfg => {
                botPool.set(cfg.id, {
                    ...cfg,
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
            username: b.username,
            host: b.host,
            port: b.port,
            version: b.version,
            autoPassword: b.autoPassword,
            autoSubServerCmd: b.autoSubServerCmd,
            autoSubServerDelay: b.autoSubServerDelay
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

    // Bota özel ayarlar varsa al, yoksa genel ayarları kullan
    const host = botData.host || globalConfig.host;
    const port = Number(botData.port || globalConfig.port);
    const version = botData.version || globalConfig.version;
    const pwd = botData.autoPassword !== undefined ? botData.autoPassword : globalConfig.autoPassword;
    const subCmd = botData.autoSubServerCmd !== undefined ? botData.autoSubServerCmd : globalConfig.autoSubServerCmd;
    const subDelay = Number(botData.autoSubServerDelay !== undefined ? botData.autoSubServerDelay : globalConfig.autoSubServerDelay) || 3;

    broadcastLog(botId, `${botData.username} sunucuya bağlanıyor (${host}:${port})...`, 'info');
    botData.status = 'Connecting';
    io.emit('status-update', { botId, status: 'Connecting' });

    try {
        const bot = mineflayer.createBot({
            host: host,
            port: port,
            username: botData.username,
            version: version || false
        });

        botData.instance = bot;

        bot.on('spawn', () => {
            botData.status = 'Online';
            broadcastLog(botId, `⚡ ${botData.username} sunucuya girdi!`, 'success');
            io.emit('status-update', { botId, status: 'Online' });

            // Otomatik Alt Sunucuya Geçiş (Gecikmeli)
            if (subCmd && subCmd.trim() !== '') {
                const delayMs = subDelay * 1000;
                broadcastLog(botId, `⏳ ${subDelay}sn sonra alt sunucuya geçilecek: ${subCmd}`, 'info');
                
                setTimeout(() => {
                    if (botData.instance && botData.status === 'Online') {
                        botData.instance.chat(subCmd);
                        broadcastLog(botId, `🚀 Alt sunucu komutu gönderildi: ${subCmd}`, 'success');
                    }
                }, delayMs);
            }
        });

        // OTOMATİK LOGIN / REGISTER DİNLEYİCİSİ (Çift Gönderim Korumalı)
        let lastAuthTime = 0;

        bot.on('messagestr', (msg) => {
            if (!msg.trim()) return;
            broadcastLog(botId, msg, 'chat');

            const lowerMsg = msg.toLowerCase();
            const now = Date.now();

            // Aynı komutun 5 saniye içinde tekrar tetiklenmesini engeller (TR/EN Çift Mesaj Koruması)
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
        host: b.host || globalConfig.host,
        port: b.port || globalConfig.port,
        version: b.version || globalConfig.version,
        autoPassword: b.autoPassword !== undefined ? b.autoPassword : globalConfig.autoPassword,
        autoSubServerCmd: b.autoSubServerCmd !== undefined ? b.autoSubServerCmd : globalConfig.autoSubServerCmd,
        autoSubServerDelay: b.autoSubServerDelay !== undefined ? b.autoSubServerDelay : globalConfig.autoSubServerDelay,
        status: b.status,
        logs: b.logs
    }));

    // Başlangıç Verilerini Gönder
    socket.emit('init-data', { botList, globalConfig });

    // Genel Ayarları Güncelleme
    socket.on('update-config', (newConfig) => {
        globalConfig = { ...globalConfig, ...newConfig };
        saveDataToFile();
        io.emit('config-updated', globalConfig);
    });

    // TEK BİR BOTUN ÖZEL AYARLARINI GÜNCELLEME
    socket.on('update-bot-config', ({ botId, config }) => {
        if (!botPool.has(botId)) return;
        const botData = botPool.get(botId);
        
        Object.assign(botData, config);
        saveDataToFile();

        io.emit('bot-updated', { botId, config: botData });
    });

    socket.on('start-bot', (botId) => startBotInstance(botId));
    socket.on('stop-bot', (botId) => stopBotInstance(botId));

    socket.on('delete-bot', (botId) => {
        stopBotInstance(botId);
        if (botPool.has(botId)) {
            botPool.delete(botId);
            saveDataToFile();
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

    socket.on('add-bot', (data) => {
        const username = typeof data === 'string' ? data : data.username;
        if (!username) return;

        const id = 'bot_' + Date.now();
        const newBot = {
            id,
            username,
            host: typeof data === 'object' && data.host ? data.host : globalConfig.host,
            port: typeof data === 'object' && data.port ? data.port : globalConfig.port,
            version: typeof data === 'object' && data.version ? data.version : globalConfig.version,
            autoPassword: typeof data === 'object' && data.autoPassword !== undefined ? data.autoPassword : globalConfig.autoPassword,
            autoSubServerCmd: typeof data === 'object' && data.autoSubServerCmd !== undefined ? data.autoSubServerCmd : globalConfig.autoSubServerCmd,
            autoSubServerDelay: typeof data === 'object' && data.autoSubServerDelay !== undefined ? data.autoSubServerDelay : globalConfig.autoSubServerDelay,
            status: 'Offline',
            instance: null,
            logs: []
        };

        botPool.set(id, newBot);
        saveDataToFile();
        io.emit('bot-added', newBot);
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
    
    startAllBots();
});
