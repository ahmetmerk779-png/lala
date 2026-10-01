const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const mineflayer = require('mineflayer');
const fs = require('fs');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Konfigürasyon Yükleme / Oluşturma
const CONFIG_PATH = path.join(__dirname, 'config.json');

let defaultConfig = {
  host: 'play.sunucuip.com',
  port: 25565,
  username: 'BotKullanici',
  password: 'Sifreniz123',
  autoLogin: true,
  subServerCommand: '/boxpvp',
  delayMs: 2000,
  useGuiSelect: false,
  guiSlotToClick: 11,
  autoReconnect: true,
  reconnectDelayMs: 5000,
  antiAfk: true,
  antiAfkIntervalMs: 15000
};

let config = defaultConfig;
if (fs.existsSync(CONFIG_PATH)) {
  try {
    config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  } catch (err) {
    console.error('Config okunurken hata oluştu, varsayılan yüklendi:', err);
  }
} else {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(defaultConfig, null, 2));
}

let bot = null;
let antiAfkTimer = null;
let isExplicitDisconnect = false;

// Panelle Log Paylaşımı
function logToPanel(text, type = 'info') {
  const time = new Date().toLocaleTimeString('tr-TR');
  console.log(`[${time}] [${type.toUpperCase()}] ${text}`);
  io.emit('bot_log', { text, type, time });
}

// Bot Başlatma Fonksiyonu
function createBotInstance() {
  if (bot) return;

  isExplicitDisconnect = false;
  logToPanel(`🔌 ${config.host}:${config.port} adresine bağlanılıyor...`, 'warn');

  bot = mineflayer.createBot({
    host: config.host,
    port: parseInt(config.port) || 25565,
    username: config.username,
    version: false
  });

  let hasLoggedIn = false;

  bot.on('spawn', () => {
    logToPanel(`✅ Bot sunucuya doğdu! Kullanıcı: ${bot.username}`, 'success');
    hasLoggedIn = false;

    // Anti-AFK Başlatma
    if (config.antiAfk) {
      if (antiAfkTimer) clearInterval(antiAfkTimer);
      antiAfkTimer = setInterval(() => {
        if (!bot) return;
        bot.setControlState('jump', true);
        setTimeout(() => {
          if (bot) bot.setControlState('jump', false);
        }, 500);

        const yaw = (Math.random() - 0.5) * Math.PI;
        const pitch = (Math.random() - 0.5) * (Math.PI / 2);
        bot.look(yaw, pitch, false);
      }, config.antiAfkIntervalMs || 15000);
    }
  });

  // GUI Menü Açıldığında Tıklama
  bot.on('windowOpen', (window) => {
    if (config.useGuiSelect && window) {
      logToPanel(`🔲 Menü açıldı (${window.title}). ${config.guiSlotToClick}. slota tıklanıyor...`, 'action');
      setTimeout(() => {
        if (bot) {
          bot.clickWindow(config.guiSlotToClick, 0, 0);
        }
      }, 1000);
    }
  });

  // Chat Dinleme ve Oto Giriş
  bot.on('message', (jsonMsg) => {
    const rawMsg = jsonMsg.toString();
    const lowerMsg = rawMsg.toLowerCase();
    logToPanel(rawMsg, 'chat');

    if (!hasLoggedIn && config.autoLogin) {
      // Login Algılama
      if (lowerMsg.includes('/login') || lowerMsg.includes('giriş yap') || lowerMsg.includes('giriniz')) {
        logToPanel('🔑 Giriş mesajı algılandı, şifre gönderiliyor...', 'action');
        bot.chat(`/login ${config.password}`);
        hasLoggedIn = true;
        executeSubServerPass();
      }
      // Register Algılama
      else if (lowerMsg.includes('/register') || lowerMsg.includes('kayıt ol')) {
        logToPanel('📝 Kayıt mesajı algılandı, kayıt olunuyor...', 'action');
        bot.chat(`/register ${config.password} ${config.password}`);
        hasLoggedIn = true;
        executeSubServerPass();
      }
    }
  });

  // Alt Sunucuya Geçiş İşlemi
  function executeSubServerPass() {
    setTimeout(() => {
      if (!bot) return;
      if (!config.useGuiSelect && config.subServerCommand && config.subServerCommand.trim() !== '') {
        logToPanel(`🎮 Alt sunucu komutu gönderiliyor: ${config.subServerCommand}`, 'action');
        bot.chat(config.subServerCommand);
      }
    }, config.delayMs || 2000);
  }

  bot.on('kicked', (reason) => {
    logToPanel(`❌ Sunucudan atıldı: ${reason}`, 'error');
  });

  bot.on('end', () => {
    logToPanel('🔌 Sunucu bağlantısı kesildi.', 'warn');
    if (antiAfkTimer) clearInterval(antiAfkTimer);
    bot = null;

    if (config.autoReconnect && !isExplicitDisconnect) {
      logToPanel(`🔄 ${config.reconnectDelayMs / 1000} saniye sonra tekrar bağlanılacak...`, 'warn');
      setTimeout(() => {
        if (!bot && !isExplicitDisconnect) {
          createBotInstance();
        }
      }, config.reconnectDelayMs || 5000);
    }
  });

  bot.on('error', (err) => {
    logToPanel(`⚠️ Hata: ${err.message}`, 'error');
  });
}

// Socket.io Canlı İletişim
io.on('connection', (socket) => {
  // Mevcut konfigürasyonu istemciye yolla
  socket.emit('init_config', config);

  // Manuel Komut Gönderme
  socket.on('send_command', (cmd) => {
    if (bot) {
      bot.chat(cmd);
      logToPanel(`> ${cmd}`, 'action');
    } else {
      socket.emit('bot_log', {
        text: '⚠️ Bot aktif değil! Komut gönderilemedi.',
        type: 'error',
        time: new Date().toLocaleTimeString('tr-TR')
      });
    }
  });

  // Bot Başlat/Durdur
  socket.on('toggle_bot', (action) => {
    if (action === 'start') {
      if (!bot) createBotInstance();
    } else if (action === 'stop') {
      if (bot) {
        isExplicitDisconnect = true;
        bot.quit();
        bot = null;
        logToPanel('⏹️ Bot panel üzerinden durduruldu.', 'warn');
      }
    }
  });
});

// REST API - Ayar Güncelleme
app.get('/api/settings', (req, res) => {
  res.json(config);
});

app.post('/api/settings', (req, res) => {
  config = { ...config, ...req.body };
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
  logToPanel('💾 Ayarlar başarıyla kaydedildi!', 'success');
  res.json({ success: true, config });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🚀 Bot kontrol paneli http://localhost:${PORT} adresinde aktif!`);
});
