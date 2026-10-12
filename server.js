const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const mc = require('minecraft-protocol');
const mcData = require('minecraft-data');
const { SocksClient } = require('socks');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// Hataları yutma: en azından stack'i yazdır
process.on('uncaughtException', (err) => console.error('[Hata Engellendi]:', err.stack || err.message));
process.on('unhandledRejection', (reason) => console.error('[Söz Rejeksiyonu Engellendi]:', reason));

/* ------------------------------------------------------------------ */
/*  Panel erişim token'ı                                               */
/* ------------------------------------------------------------------ */
const TOKEN_FILE = path.join(__dirname, 'panel_token.txt');
function getPanelToken() {
    if (process.env.PANEL_TOKEN) return process.env.PANEL_TOKEN;
    try {
        const t = fs.readFileSync(TOKEN_FILE, 'utf8').trim();
        if (t) return t;
    } catch (e) {}
    const t = crypto.randomBytes(12).toString('hex');
    try { fs.writeFileSync(TOKEN_FILE, t, 'utf8'); } catch (e) { console.error('Token yazılamadı:', e.message); }
    return t;
}
const PANEL_TOKEN = getPanelToken();

// Kaba kuvvet koruması: 5 hatalı denemeden sonra IP 5 dakika engellenir
const authFails = new Map();
io.use((socket, next) => {
    const ip = socket.handshake.address;
    const rec = authFails.get(ip) || { n: 0, until: 0 };
    if (Date.now() < rec.until) return next(new Error('unauthorized'));
    const t = socket.handshake.auth && socket.handshake.auth.token;
    const ok = typeof t === 'string' && t.length === PANEL_TOKEN.length &&
        crypto.timingSafeEqual(Buffer.from(t), Buffer.from(PANEL_TOKEN));
    if (ok) { authFails.delete(ip); return next(); }
    rec.n++;
    if (rec.n >= 5) { rec.n = 0; rec.until = Date.now() + 5 * 60000; }
    authFails.set(ip, rec);
    next(new Error('unauthorized'));
});

/* ------------------------------------------------------------------ */
/*  Ayarlar ve veri                                                    */
/* ------------------------------------------------------------------ */
const DATA_FILE = path.join(__dirname, 'bots.json');
console.log('📁 Kayıt dosyasının tam yolu:', DATA_FILE);

const botPool = new Map();

let globalConfig = {
    host: '141.95.82.164',
    port: 25565,
    version: '1.20.1',
    autoPassword: 'deliyizpassword',
    autoSubServerCmd: '/gir asmp',
    autoSubServerDelay: 4,
    autoReconnect: true,
    trustedPlayers: [], // !puan ve /tpaccept komutlarını verebilecek oyuncular
    discordWebhook: '',   // atılma / ban / alım bildirimleri
    proxyPool: [],        // proxy'si olmayan botlara sırayla dağıtılır
    afkRecheckSec: 0,     // 0 = kapalı; >0 ise AFK menüsü bu aralıkla (±%25) tekrar tıklanır (min 15)
    closeMenuAfterClick: false
};
const GLOBAL_ALLOWED = ['host', 'port', 'version', 'autoPassword', 'autoSubServerCmd', 'autoSubServerDelay', 'autoReconnect', 'trustedPlayers', 'discordWebhook', 'proxyPool', 'afkRecheckSec', 'closeMenuAfterClick'];

const defaultAutoBuyConfig = {
    enabled: false,
    targetCrystal: 1300,
    categorySlot: 7,
    itemSlot: 3,
    confirmSlot: 22
};

const defaultBotConfigs = [
    { id: 'bot_1', username: 'Deliyiz_1', host: '141.95.82.164', port: 25565, proxy: '', autoPassword: 'deliyizpassword' },
    { id: 'bot_2', username: 'Deliyiz_2', host: '141.95.82.164', port: 25565, proxy: '', autoPassword: 'deliyizpassword' },
    { id: 'bot_3', username: 'Deliyiz_3', host: '141.95.82.164', port: 25565, proxy: '', autoPassword: 'deliyizpassword' }
];

const BOT_ALLOWED = ['host', 'port', 'proxy', 'version', 'autoPassword', 'autoSubServerCmd', 'takeBreaks', 'detectStaff', 'autoBuyConfig'];

// Tek yerde bot kaydı oluşturma (kalıcı alanlar + çalışma zamanı alanları)
function createBotRecord(cfg) {
    return {
        id: cfg.id,
        username: cfg.username,
        host: cfg.host,
        port: cfg.port,
        proxy: cfg.proxy || '',
        version: cfg.version,
        autoPassword: cfg.autoPassword,
        autoSubServerCmd: cfg.autoSubServerCmd,
        autoSubServerDelay: cfg.autoSubServerDelay,
        takeBreaks: cfg.takeBreaks !== undefined ? cfg.takeBreaks : true,
        detectStaff: cfg.detectStaff !== undefined ? cfg.detectStaff : true,
        autoBuyConfig: { ...defaultAutoBuyConfig, ...(cfg.autoBuyConfig || {}) },

        // çalışma zamanı
        status: 'Offline', onlineSince: null, client: null, logs: [],
        inventory: {}, rawInventory: {}, invStateId: 0,
        scoreboardData: null, lastScoreboard: null,
        isManualStop: false, pos: { x: 0, y: 0, z: 0 }, tabList: {}, entities: {},
        isBuying: false, shopStep: 0, buyStartedAt: 0, isTakingBreak: false,
        entityId: null, exact: null, lookTarget: null, humanTimers: null, humanToken: null,
        banned: false, stats: { joins: 0, kicks: 0, onlineMs: 0, lastKick: '' },
        reconnectAttempts: 0, lastSubCmdAt: 0, lastStaffLogAt: 0, lastRespawnReqAt: 0,
        currentWindowId: 0, currentStateId: 0, activeWindowItems: {}, waitingForAfkGui: false
    };
}

// İstemciye yalnızca serileştirilebilir alanları gönder (client / timer yok)
function publicBot(b) {
    return {
        id: b.id,
        username: b.username,
        host: b.host || globalConfig.host,
        port: b.port || globalConfig.port,
        proxy: b.proxy || '',
        version: b.version || globalConfig.version,
        autoPassword: b.autoPassword !== undefined ? b.autoPassword : globalConfig.autoPassword,
        autoSubServerCmd: b.autoSubServerCmd !== undefined ? b.autoSubServerCmd : globalConfig.autoSubServerCmd,
        takeBreaks: b.takeBreaks,
        detectStaff: b.detectStaff,
        autoBuyConfig: b.autoBuyConfig,
        status: b.status,
        onlineSince: b.onlineSince || null,
        pos: b.pos || { x: 0, y: 0, z: 0 },
        logs: b.logs,
        inventory: b.inventory || {},
        stats: b.stats, banned: b.banned,
        tabList: Object.values(b.tabList || {}),
        entities: Object.values(b.entities || {})
    };
}

const mcDataCache = {};

function getMcData(version) {
    const verStr = (version || '1.20.1').toString().trim();
    if (mcDataCache[verStr]) return mcDataCache[verStr];

    try {
        const data = mcData(verStr);
        if (data && data.items) {
            mcDataCache[verStr] = data;
            return data;
        }
    } catch (e) {}

    try {
        if (!mcDataCache['1.20.1']) mcDataCache['1.20.1'] = mcData('1.20.1');
        return mcDataCache['1.20.1'];
    } catch (e) {
        return null;
    }
}

function getItemDetails(version, itemId) {
    if (itemId === undefined || itemId === null || itemId === -1) return null;
    const data = getMcData(version);
    if (data && data.items) {
        const item = data.items[itemId];
        if (item) {
            const cleanName = item.displayName || item.name.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase());
            return { name: item.name, displayName: cleanName };
        }
    }
    return { name: 'unknown', displayName: `ID: ${itemId}` };
}

function parseSlotItem(version, slotIdx, item) {
    if (!item || item.present === false || item.itemId === undefined || item.itemId === -1) return null;
    const d = getItemDetails(version, item.itemId);
    return {
        slot: slotIdx,
        id: item.itemId,
        name: d ? d.name : 'unknown',
        displayName: d ? d.displayName : `ID: ${item.itemId}`,
        count: item.itemCount || 1
    };
}

function parseMcText(text) {
    if (!text) return '';
    let str = '';
    if (typeof text === 'string') {
        try { return parseMcText(JSON.parse(text)); } catch (e) { str = text; }
    } else if (typeof text === 'object') {
        if (text.text) str += text.text;
        if (Array.isArray(text.extra)) {
            str += text.extra.map(e => parseMcText(e)).join('');
        }
        if (text.translate) str += text.translate;
    }
    return str.replace(/§[0-9a-fk-or]/gi, '').replace(/&[0-9a-fk-or]/gi, '').trim();
}

function initDefaultBots() {
    botPool.clear();
    defaultBotConfigs.forEach(cfg => botPool.set(cfg.id, createBotRecord(cfg)));
    saveDataToFile();
}

function loadSavedData() {
    if (!fs.existsSync(DATA_FILE)) {
        initDefaultBots();
        return;
    }
    try {
        const rawData = fs.readFileSync(DATA_FILE, 'utf8').trim();
        if (!rawData) {
            initDefaultBots();
            return;
        }

        const parsed = JSON.parse(rawData);
        if (parsed.globalConfig) globalConfig = { ...globalConfig, ...parsed.globalConfig };
        if (!Array.isArray(globalConfig.trustedPlayers)) globalConfig.trustedPlayers = [];
        if (!Array.isArray(globalConfig.proxyPool)) globalConfig.proxyPool = [];

        if (Array.isArray(parsed.bots) && parsed.bots.length > 0) {
            botPool.clear();
            parsed.bots.forEach(b => botPool.set(b.id, createBotRecord(b)));
        } else {
            initDefaultBots();
        }
    } catch (err) {
        // Bozuk dosya varsa üzerine yazmadan önce yedekle
        console.error('bots.json okunamadı, yedekleniyor:', err.message);
        try { fs.copyFileSync(DATA_FILE, DATA_FILE + '.bak'); } catch (e) {}
        initDefaultBots();
    }
}

function saveDataToFile() {
    try {
        const botList = Array.from(botPool.values()).map(b => ({
            id: b.id, username: b.username, host: b.host, port: b.port,
            proxy: b.proxy || '',
            version: b.version, autoPassword: b.autoPassword,
            autoSubServerCmd: b.autoSubServerCmd, autoSubServerDelay: b.autoSubServerDelay,
            takeBreaks: b.takeBreaks, detectStaff: b.detectStaff,
            autoBuyConfig: b.autoBuyConfig
        }));
        const tmp = DATA_FILE + '.tmp';
        fs.writeFileSync(tmp, JSON.stringify({ globalConfig, bots: botList }, null, 2), 'utf8');
        fs.renameSync(tmp, DATA_FILE);
    } catch (err) {
        console.error('Kayıt hatası:', err.message);
    }
}

loadSavedData();

/* ------------------------------------------------------------------ */
/*  Yardımcılar                                                        */
/* ------------------------------------------------------------------ */
function broadcastLog(botId, text, type = 'info') {
    if (!text || typeof text !== 'string' || !text.trim()) return;
    const timestamp = new Date().toLocaleTimeString('tr-TR');
    const logEntry = { botId, text, timestamp, type };

    if (botPool.has(botId)) {
        const botData = botPool.get(botId);
        botData.logs.push(logEntry);
        if (botData.logs.length > 20) botData.logs.shift();
    }
    io.emit('bot-log', logEntry);
}

function broadcastInventory(botId) {
    const botData = botPool.get(botId);
    if (botData) io.emit('bot-inventory', { botId, inventory: botData.inventory || {} });
}

// Komutlar kuyruğa girer: en az ~1.1-2 sn aralık + rastgele gecikme (komut spam'ini önler)
const chatState = new WeakMap();

function sendChat(client, message) {
    if (!client || typeof message !== 'string' || !message) return;
    let st = chatState.get(client);
    if (!st) { st = { queue: [], timer: null, last: 0 }; chatState.set(client, st); }
    st.queue.push(message);
    if (st.queue.length > 10) st.queue.shift();
    drainChat(client, st);
}

function drainChat(client, st) {
    if (st.timer || !st.queue.length) return;
    const wait = Math.max(0, st.last + 1100 + Math.random() * 900 - Date.now());
    st.timer = setTimeout(() => {
        st.timer = null;
        const msg = st.queue.shift();
        if (msg) { rawSendChat(client, msg); st.last = Date.now(); }
        drainChat(client, st);
    }, wait + Math.random() * 150);
}

function rawSendChat(client, message) {
    if (!client || typeof message !== 'string' || !message) return;
    try {
        if (message.startsWith('/')) {
            client.write('chat_command', {
                command: message.slice(1),
                timestamp: BigInt(Date.now()),
                salt: BigInt(0),
                argumentSignatures: [],
                messageCount: 0,
                acknowledged: Buffer.alloc(3)
            });
        } else {
            client.write('chat_message', {
                message: message,
                timestamp: BigInt(Date.now()),
                salt: BigInt(0),
                signature: Buffer.alloc(0),
                offset: 0,
                acknowledged: Buffer.alloc(3)
            });
        }
    } catch (e) {
        console.error('sendChat hatası:', e.message);
    }
}

const EMPTY_SLOT = { present: false };

function writeWindowClick(client, { windowId, stateId, slot, mouseButton = 0, mode = 0, changedSlots = [], cursorItem = EMPTY_SLOT }) {
    client.write('window_click', {
        windowId: Number(windowId),
        stateId: stateId || 0,
        slot: Number(slot),
        mouseButton,
        mode,
        changedSlots,
        cursorItem
    });
}

const INTERVAL_KEYS = ['subCmdInterval', 'keepAliveInterval', 'marketCheckInterval'];
const TIMEOUT_KEYS = ['afkTimer', 'afkRetryTimer', 'sbUpdateTimer', 'tabUpdateTimer', 'mapUpdateTimer',
    'breakTimeout', 'breakEndTimeout', 'respawnTimer', 'loginTimer', 'reconnectTimer'];

function clearAllTimers(botData) {
    INTERVAL_KEYS.forEach(k => { if (botData[k]) clearInterval(botData[k]); botData[k] = null; });
    TIMEOUT_KEYS.forEach(k => { if (botData[k]) clearTimeout(botData[k]); botData[k] = null; });
}

/* ------------------------------------------------------------------ */
/*  İnsan benzeri istemci davranışı                                    */
/* ------------------------------------------------------------------ */
function rand(min, max) { return min + Math.random() * (max - min); }
function wrapDeg(d) { return ((d + 180) % 360 + 360) % 360 - 180; }

const BAN_REGEX = /(\bban(ned)?\b|yasakl|blacklist|permanently)/i;
const ANTICHEAT_REGEX = /cheat|hile|unfair|anti-?bot|\bbot\b|suspicious|şüpheli|illegal/i;

const notifyLast = {};
function notify(botId, event, text) {
    const url = globalConfig.discordWebhook;
    if (!url || typeof fetch !== 'function') return;
    const key = botId + event;
    if (Date.now() - (notifyLast[key] || 0) < 30000) return;
    notifyLast[key] = Date.now();
    const bot = botPool.get(botId);
    fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            content: `**${bot ? bot.username : botId}** — ${event}: ${text}`.slice(0, 1900),
            allowed_mentions: { parse: [] }
        })
    }).catch(e => console.error('Webhook hatası:', e.message));
}

function emitStats(botId) {
    const b = botPool.get(botId);
    if (b) io.emit('bot-stats', { botId, stats: b.stats, banned: b.banned });
}

// Vanilla istemci girişte marka (brand) ve istemci ayarlarını gönderir; ham istemci göndermiyordu
function sendClientHello(client, botData) {
    setTimeout(() => {
        try {
            const brand = Buffer.from('vanilla');
            client.write('custom_payload', {
                channel: 'minecraft:brand',
                data: Buffer.concat([Buffer.from([brand.length]), brand])
            });
            if (!botData.viewDistance) botData.viewDistance = 8 + Math.floor(Math.random() * 5);
            client.write('settings', {
                locale: 'tr_TR',
                viewDistance: botData.viewDistance,
                chatFlags: 0,
                chatColors: true,
                skinParts: 127,
                mainHand: 1,
                enableTextFiltering: false,
                enableServerListing: true
            });
        } catch (e) {
            console.error('Client hello hatası:', e.message);
        }
    }, rand(50, 250));
}

function stopHumanBehavior(botData) {
    if (botData.humanTimers) Object.values(botData.humanTimers).forEach(t => clearTimeout(t));
    botData.humanTimers = null;
    botData.humanToken = null;
    if (botData.keepAliveInterval) clearInterval(botData.keepAliveInterval);
    botData.keepAliveInterval = null;
}

function startHumanBehavior(client, botData) {
    stopHumanBehavior(botData);
    const token = Symbol('human');
    botData.humanToken = token;
    const timers = botData.humanTimers = {};
    const alive = () => botData.client === client && botData.status === 'Online';
    let ticks = 0;

    const loop = (name, fn, min, max) => {
        const run = () => {
            if (botData.humanToken !== token) return;
            timers[name] = setTimeout(() => {
                try { if (alive() && botData.exact && !botData.isTakingBreak) fn(); } catch (e) {}
                run();
            }, rand(min, max));
        };
        run();
    };

    // 20 TPS: değişiklik varsa look/position_look, yoksa saniyede bir konum hatırlatması (vanilla gibi)
    botData.keepAliveInterval = setInterval(() => {
        const s = botData.exact;
        if (!alive() || !s) return;
        ticks++;
        const t = botData.lookTarget || { yaw: s.yaw, pitch: s.pitch };
        const dy = wrapDeg(t.yaw - s.yaw);
        const dp = t.pitch - s.pitch;
        let rotated = false;
        if (Math.abs(dy) > 0.1 || Math.abs(dp) > 0.1) {
            s.yaw = wrapDeg(s.yaw + dy * rand(0.18, 0.35)); // yumuşak dönüş
            s.pitch = s.pitch + dp * rand(0.18, 0.35);
            rotated = true;
        }
        const reminder = ticks % 20 === 0;
        try {
            if (rotated && reminder) client.write('position_look', { x: s.x, y: s.y, z: s.z, yaw: s.yaw, pitch: s.pitch, onGround: true });
            else if (rotated) client.write('look', { yaw: s.yaw, pitch: s.pitch, onGround: true });
            else if (reminder) client.write('position', { x: s.x, y: s.y, z: s.z, onGround: true });
        } catch (e) {}
    }, 50);

    // Bakış: ara sıra yavaşça başka yöne dön
    loop('look', () => {
        const s = botData.exact;
        botData.lookTarget = {
            yaw: wrapDeg(s.yaw + rand(-70, 70)),
            pitch: Math.max(-40, Math.min(40, s.pitch + rand(-15, 15)))
        };
    }, 2500, 11000);

    // Kol sallama: seyrek ve düzensiz
    loop('swing', () => client.write('arm_animation', { hand: 0 }), 15000, 70000);

    // Çok seyrek kısa çömelme
    loop('sneak', () => {
        if (botData.entityId == null) return;
        client.write('entity_action', { entityId: botData.entityId, actionId: 0, jumpBoost: 0 });
        setTimeout(() => {
            try { client.write('entity_action', { entityId: botData.entityId, actionId: 1, jumpBoost: 0 }); } catch (e) {}
        }, rand(300, 1200));
    }, 90000, 300000);
}

const STAFF_REGEX = /\b(admin|mod|moderator|owner|helper|rehber|yonetici|yönetici|kurucu)\b/i;
// "[Rank] Oyuncu » mesaj" gibi sistem mesajına çevrilmiş sohbet biçimleri
const CHAT_FMT = /^(?:\[[^\]]*\]\s*)*<?([A-Za-z0-9_]{3,16})>?\s*(?:»|:|>|›)\s*(.+)$/;
const TPA_REGEX = /ışınlanma isteği|teleport request|tpaccept/i;

function trustedList() {
    return (Array.isArray(globalConfig.trustedPlayers) ? globalConfig.trustedPlayers : [])
        .map(s => String(s).trim().toLowerCase())
        .filter(Boolean);
}

function isTrusted(name) {
    return !!name && trustedList().includes(String(name).toLowerCase());
}

/* ------------------------------------------------------------------ */
/*  Paket işleyici                                                     */
/* ------------------------------------------------------------------ */
function setupCustomPacketHandler(client, botId) {
    let isSequenceStarted = false;
    let afkFailCount = 0;
    const botData = botPool.get(botId);
    const MAX_SUBCMD_RETRY = 6;

    // Oturum sıfırlama
    [
        'subCmdInterval', 'marketCheckInterval', 'afkTimer', 'afkRetryTimer', 'sbUpdateTimer',
        'tabUpdateTimer', 'mapUpdateTimer', 'breakTimeout', 'breakEndTimeout', 'respawnTimer', 'loginTimer'
    ].forEach(k => {
        if (botData[k]) { clearInterval(botData[k]); clearTimeout(botData[k]); botData[k] = null; }
    });
    botData.waitingForAfkGui = false;
    botData.currentWindowId = 0;
    botData.currentStateId = 0;
    botData.invStateId = 0;
    botData.exact = null;
    botData.lookTarget = null;
    botData.entityId = null;
    botData.inventory = {};
    botData.rawInventory = {};
    botData.tabList = {};
    botData.entities = {};
    botData.pos = { x: 0, y: 0, z: 0 };
    botData.activeWindowItems = {};
    botData.isBuying = false;
    botData.shopStep = 0;
    botData.isTakingBreak = false;
    botData.lastSubCmdAt = 0;
    botData.scoreboardData = { sidebarObjective: null, objectives: {}, scores: {}, teams: {} };

    const isActive = () => botData.client === client && botData.status === 'Online';
    const getSubCmd = () => botData.autoSubServerCmd !== undefined ? botData.autoSubServerCmd : globalConfig.autoSubServerCmd;
    const getPwd = () => botData.autoPassword !== undefined ? botData.autoPassword : globalConfig.autoPassword;
    const getVersion = () => botData.version || globalConfig.version;

    /* ---------- Alt sunucu komutu ---------- */
    function sendSubCmd(reason) {
        const subCmd = getSubCmd();
        if (!subCmd || !subCmd.trim()) return false;
        sendChat(client, subCmd);
        botData.lastSubCmdAt = Date.now();
        broadcastLog(botId, `🚀 Alt sunucu komutu gönderildi (${reason}): ${subCmd}`, 'success');
        return true;
    }

    function stopSubCmdRetry() {
        if (botData.subCmdInterval) clearInterval(botData.subCmdInterval);
        botData.subCmdInterval = null;
    }

    function startSubCmdRetry() {
        stopSubCmdRetry();
        let attempts = 0;
        botData.subCmdInterval = setInterval(() => {
            if (!isActive()) { stopSubCmdRetry(); return; }
            attempts++;
            if (attempts > MAX_SUBCMD_RETRY) {
                stopSubCmdRetry();
                broadcastLog(botId, '⚠️ Alt sunucu komutu için deneme limiti doldu, tekrar denenmeyecek.', 'warn');
                return;
            }
            sendSubCmd(`tekrar ${attempts}/${MAX_SUBCMD_RETRY}`);
        }, 6000);
    }

    /* ---------- Yetkili koruması ---------- */
    function checkStaffInTabList() {
        if (!botData.detectStaff) return false;
        const ownNames = new Set(Array.from(botPool.values()).map(b => b.username.toLowerCase()));
        for (const p of Object.values(botData.tabList)) {
            if (p.name && ownNames.has(p.name.toLowerCase())) continue;
            const label = `${p.displayName || ''} ${p.name || ''}`;
            if (STAFF_REGEX.test(label)) {
                if (Date.now() - botData.lastStaffLogAt > 60000) {
                    botData.lastStaffLogAt = Date.now();
                    broadcastLog(botId, `🛡️ Yetkili Koruma: yetkili algılandı (${p.name}), bot güvenli modda bekliyor.`, 'warn');
                }
                return true;
            }
        }
        return false;
    }

    /* ---------- Scoreboard ---------- */
    function buildScoreboardLines() {
        const sb = botData.scoreboardData;
        if (!sb || !sb.sidebarObjective) return null;
        const rawScores = sb.scores[sb.sidebarObjective] || {};
        const lines = [];

        Object.keys(rawScores).forEach(entryKey => {
            const scoreItem = rawScores[entryKey];
            let prefix = '';
            let suffix = '';
            Object.values(sb.teams).forEach(t => {
                if (t.players && t.players.includes(entryKey)) {
                    prefix = t.prefix || '';
                    suffix = t.suffix || '';
                }
            });
            const cleanEntry = scoreItem.customName || parseMcText(entryKey);
            const fullText = (prefix + cleanEntry + suffix).trim() || cleanEntry;
            lines.push({ text: fullText, score: scoreItem.val });
        });

        lines.sort((a, b) => b.score - a.score);
        return lines;
    }

    function broadcastDynamicScoreboard() {
        const sb = botData.scoreboardData;
        const lines = buildScoreboardLines();
        if (!lines) {
            botData.lastScoreboard = null;
            io.emit('bot-scoreboard', { botId, scoreboard: null });
            return;
        }
        const objInfo = sb.objectives[sb.sidebarObjective];
        const payload = { title: objInfo && objInfo.title ? objInfo.title : 'Scoreboard', lines };
        botData.lastScoreboard = payload;
        io.emit('bot-scoreboard', { botId, scoreboard: payload });
    }

    function queueScoreboardUpdate() {
        if (botData.sbUpdateTimer) return;
        botData.sbUpdateTimer = setTimeout(() => {
            botData.sbUpdateTimer = null;
            broadcastDynamicScoreboard();
        }, 500);
    }

    function queueTabListUpdate() {
        if (botData.tabUpdateTimer) return;
        botData.tabUpdateTimer = setTimeout(() => {
            botData.tabUpdateTimer = null;
            io.emit('bot-tablist', { botId, players: Object.values(botData.tabList) });
        }, 600);
    }

    function queueMapUpdate() {
        if (botData.mapUpdateTimer) return;
        botData.mapUpdateTimer = setTimeout(() => {
            botData.mapUpdateTimer = null;
            io.emit('bot-map-update', { botId, pos: botData.pos, entities: Object.values(botData.entities) });
        }, 300);
    }

    /* ---------- Otomatik market ---------- */
    function checkAndBuyItem() {
        if (botData.status !== 'Online' || botData.isTakingBreak) return;

        // Takılı kalmış alım işlemini sıfırla
        if (botData.isBuying) {
            if (Date.now() - botData.buyStartedAt > 30000) {
                broadcastLog(botId, '⚠️ Otomatik market zaman aşımına uğradı, sıfırlandı.', 'warn');
                botData.isBuying = false;
                botData.shopStep = 0;
            }
            return;
        }

        const buyCfg = botData.autoBuyConfig || defaultAutoBuyConfig;
        if (!buyCfg.enabled) return;
        if (checkStaffInTabList()) return;

        const lines = buildScoreboardLines();
        if (!lines) return;

        let crystalVal = 0;
        lines.forEach(line => {
            if (line.text.toLowerCase().includes('kristal')) {
                // Önce metindeki sayıyı dene ("Kristal: 1.250"), yoksa skor değerini kullan
                const m = line.text.match(/\d[\d.,]*/);
                crystalVal = m ? Number(m[0].replace(/[.,]/g, '')) : (line.score || 0);
            }
        });

        if (crystalVal >= Number(buyCfg.targetCrystal)) {
            botData.isBuying = true;
            botData.shopStep = 1;
            botData.buyStartedAt = Date.now();
            broadcastLog(botId, `💎 Kristal hedefine ulaşıldı (${crystalVal}/${buyCfg.targetCrystal}), /shop açılıyor...`, 'success');
            notify(botId, 'Otomatik alım', `Kristal hedefi aşıldı (${crystalVal}/${buyCfg.targetCrystal}).`);
            sendChat(client, '/shop');
        }
    }

    function startMarketCheck() {
        if (botData.marketCheckInterval) clearInterval(botData.marketCheckInterval);
        botData.marketCheckInterval = setInterval(checkAndBuyItem, 10000);
    }

    function runBuyStep() {
        const buyCfg = botData.autoBuyConfig || defaultAutoBuyConfig;
        const steps = {
            1: ['categorySlot', '🛒 Kategoriye tıklandı'],
            2: ['itemSlot', '🔥 Ürün seçildi'],
            3: ['confirmSlot', '✅ Onay slotuna tıklandı']
        };
        const step = steps[botData.shopStep];
        if (!step) return;

        setTimeout(() => {
            if (!isActive() || !botData.isBuying) return;
            try {
                const slot = Number(buyCfg[step[0]]);
                writeWindowClick(client, { windowId: botData.currentWindowId, stateId: botData.currentStateId, slot });
                broadcastLog(botId, `${step[1]} (Slot: ${slot})`, 'info');
                if (botData.shopStep === 3) {
                    botData.isBuying = false;
                    botData.shopStep = 0;
                } else {
                    botData.shopStep++;
                }
            } catch (e) {
                broadcastLog(botId, `Otomatik market hatası: ${e.message}`, 'error');
                botData.isBuying = false;
                botData.shopStep = 0;
            }
        }, Math.round(rand(600, 1400)));
    }

    /* ---------- AFK akışı ---------- */
    function triggerAfkWithRetry() {
        if (!isActive() || botData.isTakingBreak) return;
        if (checkStaffInTabList()) return;

        botData.waitingForAfkGui = true;
        sendChat(client, '/afk');
        broadcastLog(botId, '🚶 /afk yazıldı, menü bekleniyor...', 'info');

        if (botData.afkRetryTimer) clearTimeout(botData.afkRetryTimer);
        botData.afkRetryTimer = setTimeout(() => {
            if (!(botData.waitingForAfkGui && isActive())) return;
            afkFailCount++;

            if (afkFailCount >= 3) {
                broadcastLog(botId, '⚠️ Lobiye düşülmüş olabilir. Alt sunucuya tekrar giriliyor...', 'error');
                afkFailCount = 0;
                botData.waitingForAfkGui = false;
                isSequenceStarted = false;
                sendSubCmd('lobiye düşme şüphesi');
            } else {
                broadcastLog(botId, `⚠ Menü açılmadı, /afk tekrar deneniyor... (${afkFailCount}/3)`, 'warn');
                triggerAfkWithRetry();
            }
        }, 6000);
    }

    function afterAfkClick() {
        if (globalConfig.closeMenuAfterClick) {
            setTimeout(() => {
                if (!isActive()) return;
                try { client.write('close_window', { windowId: botData.currentWindowId }); } catch (e) {}
            }, rand(900, 2200));
        }
        const sec = Number(globalConfig.afkRecheckSec) || 0;
        if (sec > 0) {
            if (botData.afkTimer) clearTimeout(botData.afkTimer);
            botData.afkTimer = setTimeout(triggerAfkWithRetry, Math.max(15, sec) * 1000 * rand(0.75, 1.25));
        }
    }

    botData.triggerAfk = triggerAfkWithRetry;

    function runLoginSequence() {
        if (!isActive()) return;
        const pwd = getPwd();
        const hasPwd = pwd && pwd.trim() !== '';

        if (hasPwd) {
            sendChat(client, `/login ${pwd}`);
            broadcastLog(botId, '🔑 /login gönderildi.', 'info');
        }

        botData.loginTimer = setTimeout(() => {
            if (!isActive()) return;
            if (sendSubCmd('ilk giriş')) {
                startSubCmdRetry();
                botData.afkTimer = setTimeout(triggerAfkWithRetry, 10000);
            } else {
                botData.afkTimer = setTimeout(triggerAfkWithRetry, 4000);
            }
        }, hasPwd ? 1500 : 0);
    }

    /* ---------- Gerçekçi mola ---------- */
    function scheduleBreak() {
        if (botData.breakTimeout) clearTimeout(botData.breakTimeout);
        const delay = (30 + Math.random() * 30) * 60000; // 30-60 dk
        botData.breakTimeout = setTimeout(() => {
            if (!isActive() || !botData.takeBreaks) { scheduleBreak(); return; }
            const dur = (3 + Math.random() * 5) * 60000; // 3-8 dk
            botData.isTakingBreak = true;
            broadcastLog(botId, `☕ Mola başladı (~${Math.round(dur / 60000)} dk). Hareket ve otomasyon duraklatıldı.`, 'info');
            botData.breakEndTimeout = setTimeout(() => {
                botData.isTakingBreak = false;
                broadcastLog(botId, '▶️ Mola bitti, bot devam ediyor.', 'info');
                scheduleBreak();
            }, dur);
        }, delay);
    }

    /* ---------- Sohbet ---------- */
    function handleChatMessage(msg, uuidSender) {
        let senderName = uuidSender || null;
        let text = msg;
        if (!senderName) {
            const m = msg.match(CHAT_FMT);
            if (m) { senderName = m[1]; text = m[2]; }
        }

        broadcastLog(botId, uuidSender ? `<${uuidSender}> ${msg}` : msg, 'chat');

        const cmdText = text.trim();
        if (cmdText.toLowerCase().startsWith('!puan ')) {
            if (!isTrusted(senderName)) return;
            const parts = cmdText.slice(6).trim().split(' ');
            const targetArg = parts[0];
            const cmdToExecute = parts.slice(1).join(' ').trim();

            if (targetArg && cmdToExecute) {
                const isForMe = targetArg.toLowerCase() === 'all' || targetArg.toLowerCase() === botData.username.toLowerCase();
                if (isForMe) {
                    broadcastLog(botId, `🤖 Hedefli komut alındı (${senderName}): ${cmdToExecute}`, 'success');
                    setTimeout(() => { if (isActive()) sendChat(client, cmdToExecute); }, 500);
                }
            }
            return;
        }

        // Oyuncu sohbeti değilse (sunucu mesajı) ve güvenilir bir oyuncunun adı geçiyorsa TPA kabul et
        if (!senderName && TPA_REGEX.test(msg)) {
            const lower = msg.toLowerCase();
            if (trustedList().some(n => lower.includes(n))) {
                broadcastLog(botId, '📡 Güvenilir oyuncudan TPA isteği, kabul ediliyor...', 'info');
                setTimeout(() => { if (isActive()) sendChat(client, '/tpaccept'); }, 1000);
            }
        }
    }

    startMarketCheck();
    scheduleBreak();

    /* ---------- Paket dinleyici ---------- */
    client.on('packet', (data, meta) => {
        if (meta.state !== 'play') return;

        switch (meta.name) {
            case 'login': {
                botData.entityId = data.entityId;
                sendClientHello(client, botData);
                break;
            }

            case 'resource_pack_send': {
                // Sunucu paketi isteyebilir: önce "kabul edildi" (3), sonra "yüklendi" (0)
                setTimeout(() => {
                    try { client.write('resource_pack_receive', { result: 3 }); } catch (e) {}
                    setTimeout(() => {
                        try { client.write('resource_pack_receive', { result: 0 }); } catch (e) {}
                    }, rand(1200, 3000));
                }, rand(300, 900));
                break;
            }

            case 'update_health': {
                if (data.health <= 0 && Date.now() - botData.lastRespawnReqAt > 3000) {
                    botData.lastRespawnReqAt = Date.now();
                    broadcastLog(botId, '☠️ Bot öldü! Otomatik Respawn gönderiliyor...', 'error');
                    try { client.write('client_command', { actionId: 0 }); } catch (e) {}
                }
                break;
            }

            case 'respawn': {
                // Not: marketCheck ve mola zamanlayıcılarına dokunmuyoruz
                stopSubCmdRetry();
                if (botData.afkTimer) clearTimeout(botData.afkTimer);
                if (botData.afkRetryTimer) clearTimeout(botData.afkRetryTimer);
                if (botData.respawnTimer) clearTimeout(botData.respawnTimer);
                botData.waitingForAfkGui = false;
                botData.entities = {};
                botData.isBuying = false;
                botData.shopStep = 0;
                afkFailCount = 0;
                broadcastLog(botId, '🔄 Bot yeniden doğdu / sunucu değişti.', 'warn');

                botData.respawnTimer = setTimeout(() => {
                    if (!isActive()) return;
                    // Komut az önce gönderildiyse (bu respawn onun sonucuysa) tekrar gönderme: döngüyü kırar
                    const recentlySent = Date.now() - botData.lastSubCmdAt < 15000;
                    if (!recentlySent) sendSubCmd('respawn sonrası');
                    botData.afkTimer = setTimeout(triggerAfkWithRetry, recentlySent ? 8000 : 5000);
                }, 2000);
                break;
            }

            case 'open_window': {
                stopSubCmdRetry(); // menü açıldı = alt sunucuya geçildi

                botData.currentWindowId = data.windowId;
                botData.windowTitle = parseMcText(data.title || data.windowTitle || 'Sunucu Menüsü');
                botData.activeWindowItems = {};
                io.emit('bot-open-window', {
                    botId,
                    windowId: data.windowId,
                    title: botData.windowTitle,
                    slots: data.slots || 27
                });
                break;
            }

            case 'window_items': {
                const ver = getVersion();
                if (data.windowId === 0) {
                    botData.invStateId = data.stateId || 0;
                    botData.inventory = {};
                    botData.rawInventory = {};
                    if (Array.isArray(data.items)) {
                        data.items.forEach((item, index) => {
                            const parsed = parseSlotItem(ver, index, item);
                            if (parsed) {
                                botData.inventory[index] = parsed;
                                botData.rawInventory[index] = item;
                            }
                        });
                    }
                    broadcastInventory(botId);
                } else {
                    botData.currentWindowId = data.windowId;
                    botData.currentStateId = data.stateId || 0;

                    const windowItems = {};
                    if (Array.isArray(data.items)) {
                        data.items.forEach((item, index) => {
                            const parsed = parseSlotItem(ver, index, item);
                            if (parsed) windowItems[index] = parsed;
                        });
                    }
                    botData.activeWindowItems = windowItems;
                    io.emit('bot-window-items', { botId, windowId: data.windowId, items: windowItems });

                    if (botData.isBuying) runBuyStep();

                    if (botData.waitingForAfkGui) {
                        botData.waitingForAfkGui = false;
                        afkFailCount = 0;
                        if (botData.afkRetryTimer) clearTimeout(botData.afkRetryTimer);

                        setTimeout(() => {
                            if (!isActive()) return;
                            try {
                                writeWindowClick(client, {
                                    windowId: botData.currentWindowId,
                                    stateId: botData.currentStateId,
                                    slot: 12,
                                    mouseButton: 1
                                });
                                broadcastLog(botId, '🎯 AFK Menüsü sağ tıklandı! (Slot: 12)', 'success');
                                afterAfkClick();
                            } catch (e) {
                                broadcastLog(botId, `Menü tıklama hatası: ${e.message}`, 'error');
                                setTimeout(triggerAfkWithRetry, 3000);
                            }
                        }, Math.round(rand(700, 1600)));
                    }
                }
                break;
            }

            case 'set_slot': {
                const ver = getVersion();
                if (data.windowId === 0) {
                    if (data.stateId !== undefined) botData.invStateId = data.stateId;
                    const parsed = parseSlotItem(ver, data.slot, data.item);
                    if (parsed) {
                        botData.inventory[data.slot] = parsed;
                        botData.rawInventory[data.slot] = data.item;
                    } else {
                        delete botData.inventory[data.slot];
                        delete botData.rawInventory[data.slot];
                    }
                    broadcastInventory(botId);
                } else if (data.windowId === botData.currentWindowId) {
                    if (data.stateId !== undefined) botData.currentStateId = data.stateId;
                    const parsed = parseSlotItem(ver, data.slot, data.item);
                    if (parsed) botData.activeWindowItems[data.slot] = parsed;
                    else delete botData.activeWindowItems[data.slot];
                    io.emit('bot-window-items', { botId, windowId: data.windowId, items: botData.activeWindowItems });
                }
                break;
            }

            case 'position': {
                const f = data.flags;
                const rel = (f && typeof f === 'object')
                    ? { x: !!f.x, y: !!f.y, z: !!f.z, yaw: !!f.yaw, pitch: !!f.pitch }
                    : { x: !!(f & 1), y: !!(f & 2), z: !!(f & 4), yaw: !!(f & 8), pitch: !!(f & 16) };
                const prev = botData.exact || { x: 0, y: 0, z: 0, yaw: 0, pitch: 0 };
                const ex = {
                    x: (rel.x ? prev.x : 0) + data.x,
                    y: (rel.y ? prev.y : 0) + data.y,
                    z: (rel.z ? prev.z : 0) + data.z,
                    yaw: (rel.yaw ? prev.yaw : 0) + (data.yaw || 0),
                    pitch: (rel.pitch ? prev.pitch : 0) + (data.pitch || 0)
                };
                botData.exact = ex;
                botData.lookTarget = { yaw: ex.yaw, pitch: ex.pitch };

                // Vanilla: teleport_confirm + yeni konumu position_look ile geri bildir
                try {
                    if (data.teleportId !== undefined) client.write('teleport_confirm', { teleportId: data.teleportId });
                    client.write('position_look', { x: ex.x, y: ex.y, z: ex.z, yaw: ex.yaw, pitch: ex.pitch, onGround: false });
                } catch (e) {}

                botData.pos = {
                    x: Math.round(ex.x * 10) / 10,
                    y: Math.round(ex.y * 10) / 10,
                    z: Math.round(ex.z * 10) / 10
                };
                queueMapUpdate();

                if (!isSequenceStarted) {
                    isSequenceStarted = true;
                    if (botData.loginTimer) clearTimeout(botData.loginTimer);
                    botData.loginTimer = setTimeout(runLoginSequence, rand(1500, 3000));
                }
                break;
            }

            case 'spawn_entity':
            case 'named_entity_spawn': {
                if (data.entityId !== undefined) {
                    botData.entities[data.entityId] = {
                        id: data.entityId,
                        x: Math.round((data.x || 0) * 10) / 10,
                        y: Math.round((data.y || 0) * 10) / 10,
                        z: Math.round((data.z || 0) * 10) / 10
                    };
                    queueMapUpdate();
                }
                break;
            }

            case 'entity_teleport': {
                const ent = botData.entities[data.entityId];
                if (ent) {
                    ent.x = Math.round(data.x * 10) / 10;
                    ent.y = Math.round(data.y * 10) / 10;
                    ent.z = Math.round(data.z * 10) / 10;
                    queueMapUpdate();
                }
                break;
            }

            case 'rel_entity_move':
            case 'entity_move_look': {
                const ent = botData.entities[data.entityId];
                if (ent) {
                    ent.x += (data.dX || 0) / (32 * 128);
                    ent.z += (data.dZ || 0) / (32 * 128);
                    queueMapUpdate();
                }
                break;
            }

            case 'entity_destroy':
            case 'destroy_entities': {
                const eIds = data.entityIds || [data.entityId];
                if (Array.isArray(eIds)) {
                    eIds.forEach(id => delete botData.entities[id]);
                    queueMapUpdate();
                }
                break;
            }

            case 'player_info_update': {
                if (Array.isArray(data.data)) {
                    data.data.forEach(p => {
                        const uuid = p.uuid;
                        if (!botData.tabList[uuid]) {
                            botData.tabList[uuid] = { uuid, name: 'Bilinmeyen', displayName: '', ping: 0 };
                        }
                        if (p.player && p.player.name) botData.tabList[uuid].name = p.player.name;
                        if (p.displayName) botData.tabList[uuid].displayName = parseMcText(p.displayName);
                        if (p.latency !== undefined) botData.tabList[uuid].ping = p.latency;
                    });
                    queueTabListUpdate();
                }
                break;
            }

            case 'player_remove': {
                if (Array.isArray(data.uuids)) {
                    data.uuids.forEach(uuid => delete botData.tabList[uuid]);
                    queueTabListUpdate();
                }
                break;
            }

            case 'player_info': {
                if (Array.isArray(data.data)) {
                    data.data.forEach(p => {
                        if (data.action === 0) {
                            botData.tabList[p.uuid] = {
                                uuid: p.uuid,
                                name: p.name || 'Bilinmeyen',
                                displayName: p.displayName ? parseMcText(p.displayName) : p.name,
                                ping: p.ping || 0
                            };
                        } else if (data.action === 4) {
                            delete botData.tabList[p.uuid];
                        }
                    });
                    queueTabListUpdate();
                }
                break;
            }

            // keep_alive: minecraft-protocol zaten kendisi yanıtlıyor, elle yanıtlamıyoruz (çift yanıt olmasın)
            case 'ping': {
                try { client.write('pong', { id: data.id }); } catch (e) {}
                break;
            }

            case 'player_chat':
            case 'system_chat':
            case 'chat': {
                const uuidSenderName = data.senderUuid && botData.tabList[data.senderUuid]
                    ? botData.tabList[data.senderUuid].name
                    : null;
                handleIncomingChat(data, (msg) => handleChatMessage(msg, uuidSenderName));
                break;
            }

            case 'display_objective':
            case 'scoreboard_display_objective': {
                if (data.position === 1) {
                    botData.scoreboardData.sidebarObjective = data.name;
                    queueScoreboardUpdate();
                }
                break;
            }

            case 'scoreboard_objective': {
                const objName = data.name;
                if (data.action === 0 || data.action === 2) {
                    const titleText = parseMcText(data.displayText || data.name);
                    if (!botData.scoreboardData.objectives[objName]) botData.scoreboardData.objectives[objName] = {};
                    botData.scoreboardData.objectives[objName].title = titleText;
                } else if (data.action === 1) {
                    delete botData.scoreboardData.objectives[objName];
                    delete botData.scoreboardData.scores[objName];
                }
                queueScoreboardUpdate();
                break;
            }

            case 'scoreboard_score':
            case 'set_score': {
                const targetObj = data.scoreName || data.objectiveName;
                const itemName = data.itemName;

                if (!botData.scoreboardData.scores[targetObj]) botData.scoreboardData.scores[targetObj] = {};

                if (data.action === 0) {
                    botData.scoreboardData.scores[targetObj][itemName] = {
                        val: data.value,
                        customName: data.displayName ? parseMcText(data.displayName) : null
                    };
                } else if (data.action === 1) {
                    delete botData.scoreboardData.scores[targetObj][itemName];
                }
                queueScoreboardUpdate();
                break;
            }

            case 'teams':
            case 'scoreboard_team': {
                const teamName = data.team;
                if (!botData.scoreboardData.teams[teamName]) {
                    botData.scoreboardData.teams[teamName] = { prefix: '', suffix: '', players: [] };
                }
                const tObj = botData.scoreboardData.teams[teamName];

                if (data.mode === 0 || data.mode === 2) {
                    if (data.prefix) tObj.prefix = parseMcText(data.prefix);
                    if (data.suffix) tObj.suffix = parseMcText(data.suffix);
                }
                if (data.mode === 0 || data.mode === 3) {
                    if (Array.isArray(data.players)) {
                        data.players.forEach(p => { if (!tObj.players.includes(p)) tObj.players.push(p); });
                    }
                }
                if (data.mode === 4 && Array.isArray(data.players)) {
                    tObj.players = tObj.players.filter(p => !data.players.includes(p));
                }
                if (data.mode === 1) delete botData.scoreboardData.teams[teamName];
                queueScoreboardUpdate();
                break;
            }
        }
    });
}

function handleIncomingChat(data, callback) {
    let text = '';
    try {
        if (data.plainMessage) text = data.plainMessage;
        else if (data.content) text = parseMcText(data.content);
        else if (data.message) text = parseMcText(data.message);
    } catch (e) {}

    if (text && text.trim()) callback(text);
}

/* ------------------------------------------------------------------ */
/*  Bot yaşam döngüsü                                                  */
/* ------------------------------------------------------------------ */
function cleanupBot(botId, reason) {
    const botData = botPool.get(botId);
    if (!botData) return;

    stopHumanBehavior(botData);
    clearAllTimers(botData);
    if (botData.onlineSince) botData.stats.onlineMs += Date.now() - botData.onlineSince;
    botData.exact = null;
    botData.lookTarget = null;

    if (botData.client) {
        try {
            botData.client.removeAllListeners();
            botData.client.on('error', () => {}); // removeAllListeners sonrası gelen error'lar uygulamayı düşürmesin
            botData.client.end();
        } catch (e) {}
        botData.client = null;
    }

    // 60 sn'den uzun süre bağlı kaldıysa geri bağlanma sayacını sıfırla
    if (botData.onlineSince && Date.now() - botData.onlineSince > 60000) botData.reconnectAttempts = 0;

    botData.status = 'Offline';
    botData.onlineSince = null;
    botData.inventory = {};
    botData.rawInventory = {};
    botData.scoreboardData = null;
    botData.lastScoreboard = null;
    botData.tabList = {};
    botData.entities = {};
    botData.pos = { x: 0, y: 0, z: 0 };
    botData.isBuying = false;
    botData.shopStep = 0;
    botData.isTakingBreak = false;
    botData.waitingForAfkGui = false;

    broadcastLog(botId, `🔴 ${reason}`, 'error');
    emitStats(botId);
    io.emit('status-update', { botId, status: 'Offline', onlineSince: null });
    io.emit('bot-scoreboard', { botId, scoreboard: null });
    io.emit('bot-tablist', { botId, players: [] });
    io.emit('bot-map-update', { botId, pos: { x: 0, y: 0, z: 0 }, entities: [] });

    if (!botData.isManualStop && globalConfig.autoReconnect) {
        botData.reconnectAttempts = (botData.reconnectAttempts || 0) + 1;
        // Üstel bekleme + rastgele gecikme (Connection throttled hatasını önler)
        const base = Math.min(5000 * Math.pow(2, botData.reconnectAttempts - 1), 120000);
        const delay = base + Math.floor(Math.random() * 5000);
        broadcastLog(botId, `⏳ ${Math.round(delay / 1000)} sn sonra tekrar bağlanılacak (deneme ${botData.reconnectAttempts}).`, 'info');

        botData.reconnectTimer = setTimeout(() => {
            botData.reconnectTimer = null;
            if (botPool.has(botId) && !botData.isManualStop && botData.status === 'Offline') {
                startBotInstance(botId);
            }
        }, delay);
    }
}

function startBotInstance(botId) {
    const botData = botPool.get(botId);
    if (!botData || botData.client) return;

    if (botData.reconnectTimer) { clearTimeout(botData.reconnectTimer); botData.reconnectTimer = null; }

    botData.isManualStop = false;
    botData.banned = false;
    const host = botData.host || globalConfig.host;
    const port = Number(botData.port || globalConfig.port);
    const version = botData.version || globalConfig.version;
    let proxyUrl = botData.proxy;
    if ((!proxyUrl || !proxyUrl.trim()) && Array.isArray(globalConfig.proxyPool) && globalConfig.proxyPool.length) {
        const idx = Array.from(botPool.keys()).indexOf(botId);
        proxyUrl = globalConfig.proxyPool[idx % globalConfig.proxyPool.length];
    }

    broadcastLog(botId, `${botData.username} bağlanıyor (${host}:${port})${proxyUrl ? ' [SOCKS5 Proxy Aktif]' : ''}...`, 'info');
    botData.status = 'Connecting';
    io.emit('status-update', { botId, status: 'Connecting', onlineSince: null });

    try {
        const clientOptions = {
            host,
            port,
            username: botData.username,
            version: version || '1.20.1',
            checkTimeoutInterval: 60000,
            keepAlive: true
        };

        if (proxyUrl && proxyUrl.trim() !== '') {
            const raw = proxyUrl.trim();
            let u;
            try {
                u = new URL(raw.includes('://') ? raw : 'socks5://' + raw);
            } catch (e) {
                throw new Error('Geçersiz proxy adresi');
            }

            clientOptions.connect = (c) => {
                SocksClient.createConnection({
                    proxy: {
                        host: u.hostname,
                        port: Number(u.port),
                        type: 5,
                        userId: u.username ? decodeURIComponent(u.username) : undefined,
                        password: u.password ? decodeURIComponent(u.password) : undefined
                    },
                    destination: { host, port },
                    command: 'connect',
                    timeout: 10000
                }, (err, info) => {
                    if (err) {
                        c.emit('error', new Error('Proxy bağlantı hatası: ' + err.message));
                        return;
                    }
                    c.setSocket(info.socket);
                    c.emit('connect'); // bu olmadan login el sıkışması başlamaz
                });
            };
        }

        const client = mc.createClient(clientOptions);
        botData.client = client;
        setupCustomPacketHandler(client, botId);

        client.on('success', () => {
            if (botData.client !== client) return;
            botData.status = 'Online';
            botData.onlineSince = Date.now();
            broadcastLog(botId, `⚡ ${botData.username} sunucuya girdi!`, 'success');
            io.emit('status-update', { botId, status: 'Online', onlineSince: botData.onlineSince });

            botData.stats.joins++;
            emitStats(botId);
            startHumanBehavior(client, botData);
        });

        // Eski client'tan gelen geç olaylar yeni bağlantıyı bozmasın
        const onEnd = (reason, isKick) => {
            if (botData.client !== client) return;
            if (isKick) {
                botData.stats.kicks++;
                botData.stats.lastKick = reason;
                notify(botId, 'Atıldı', reason);
                if (BAN_REGEX.test(reason)) {
                    botData.isManualStop = true; // banlı hesapla tekrar tekrar bağlanma
                    botData.banned = true;
                    notify(botId, '⛔ BAN', reason);
                    reason += ' — BAN algılandı, otomatik yeniden bağlanma kapatıldı.';
                } else if (ANTICHEAT_REGEX.test(reason)) {
                    botData.reconnectAttempts += 3; // anticheat atmasında daha uzun bekle
                    reason += ' — anticheat şüphesi, yeniden bağlanma daha geç yapılacak.';
                }
            }
            cleanupBot(botId, reason);
        };

        client.on('kick_disconnect', (packet) => onEnd(`Atıldı: ${parseMcText(packet.reason)}`, true));
        client.on('disconnect', (packet) => onEnd(`Bağlantı Kesildi: ${parseMcText(packet.reason)}`, true));
        client.on('error', (err) => onEnd(`Hata: ${err.message}`));
        client.on('end', () => onEnd('Bağlantı sonlandı.'));

    } catch (err) {
        botData.client = null;
        cleanupBot(botId, `Başlatılamadı: ${err.message}`);
    }
}

function stopBotInstance(botId) {
    const botData = botPool.get(botId);
    if (botData) {
        botData.isManualStop = true;
        cleanupBot(botId, 'Bot elle durduruldu.');
    }
}

function startAllBots() {
    let delay = 0;
    for (const [id, botData] of botPool.entries()) {
        if (botData.status === 'Offline') {
            setTimeout(() => startBotInstance(id), delay);
            delay += 2500 + Math.floor(Math.random() * 1500);
        }
    }
}

/* ------------------------------------------------------------------ */
/*  Socket.IO                                                          */
/* ------------------------------------------------------------------ */
io.on('connection', (socket) => {
    socket.emit('init-data', { botList: Array.from(botPool.values()).map(publicBot), globalConfig });

    // Sayfa yenilenince scoreboard boş kalmasın
    botPool.forEach((b) => {
        if (b.lastScoreboard) socket.emit('bot-scoreboard', { botId: b.id, scoreboard: b.lastScoreboard });
    });

    socket.on('update-config', (newConfig) => {
        if (!newConfig || typeof newConfig !== 'object') return;
        GLOBAL_ALLOWED.forEach(k => {
            if (newConfig[k] === undefined) return;
            if (k === 'trustedPlayers' || k === 'proxyPool') {
                globalConfig[k] = Array.isArray(newConfig[k])
                    ? newConfig[k].map(s => String(s).trim()).filter(Boolean)
                    : [];
            } else {
                globalConfig[k] = newConfig[k];
            }
        });
        saveDataToFile();
        io.emit('config-updated', globalConfig);
    });

    socket.on('update-bot-config', ({ botId, config } = {}) => {
        const botData = botPool.get(botId);
        if (!botData || !config || typeof config !== 'object') return;
        BOT_ALLOWED.forEach(k => { if (config[k] !== undefined) botData[k] = config[k]; });
        saveDataToFile();
        io.emit('bot-updated', { botId, config: publicBot(botData) });
    });

    socket.on('start-bot', (botId) => startBotInstance(botId));
    socket.on('stop-bot', (botId) => stopBotInstance(botId));
    socket.on('start-all', () => startAllBots());
    socket.on('stop-all', () => { for (const id of botPool.keys()) stopBotInstance(id); });

    socket.on('test-proxy', (proxy, cb) => {
        if (typeof cb !== 'function') return;
        let u;
        try {
            const raw = String(proxy || '').trim();
            u = new URL(raw.includes('://') ? raw : 'socks5://' + raw);
        } catch (e) {
            return cb({ ok: false, error: 'Geçersiz proxy adresi' });
        }
        const t0 = Date.now();
        SocksClient.createConnection({
            proxy: {
                host: u.hostname, port: Number(u.port), type: 5,
                userId: u.username ? decodeURIComponent(u.username) : undefined,
                password: u.password ? decodeURIComponent(u.password) : undefined
            },
            destination: { host: globalConfig.host, port: Number(globalConfig.port) },
            command: 'connect',
            timeout: 8000
        }).then(info => {
            info.socket.destroy();
            cb({ ok: true, ms: Date.now() - t0 });
        }).catch(err => cb({ ok: false, error: err.message }));
    });

    socket.on('add-bot', (data) => {
        const username = String(typeof data === 'string' ? data : (data && data.username) || '').trim();
        if (!/^[A-Za-z0-9_]{3,16}$/.test(username)) return;
        if (Array.from(botPool.values()).some(b => b.username.toLowerCase() === username.toLowerCase())) return;

        const id = 'bot_' + Date.now();
        const newBot = createBotRecord({
            id, username,
            host: globalConfig.host, port: globalConfig.port, proxy: '', version: globalConfig.version,
            autoPassword: globalConfig.autoPassword, autoSubServerCmd: globalConfig.autoSubServerCmd
        });
        botPool.set(id, newBot);
        saveDataToFile();
        io.emit('bot-added', publicBot(newBot));
    });

    socket.on('delete-bot', (botId) => {
        if (!botPool.has(botId)) return;
        stopBotInstance(botId);
        botPool.delete(botId);
        saveDataToFile();
        io.emit('bot-deleted', botId);
    });

    socket.on('send-command', ({ targetBotId, command } = {}) => {
        if (!command || typeof command !== 'string') return;
        if (targetBotId === 'all') {
            botPool.forEach((botData) => {
                if (botData.client && botData.status === 'Online') {
                    sendChat(botData.client, command);
                    broadcastLog(botData.id, `> ${command}`, 'command');
                }
            });
        } else {
            const botData = botPool.get(targetBotId);
            if (botData && botData.client && botData.status === 'Online') {
                sendChat(botData.client, command);
                broadcastLog(targetBotId, `> ${command}`, 'command');
            }
        }
    });

    socket.on('click-window-slot', ({ botId, windowId, slot } = {}) => {
        const botData = botPool.get(botId);
        if (!botData || !botData.client || botData.status !== 'Online') return;

        try {
            writeWindowClick(botData.client, { windowId, stateId: botData.currentStateId, slot });
            broadcastLog(botId, `👆 Menü slotuna tıklandı: Slot ${slot}`, 'success');
        } catch (e) {
            broadcastLog(botId, `Menü tıklama hatası: ${e.message}`, 'error');
        }
    });

    socket.on('inventory-action', ({ botId, action, slot, targetSlot } = {}) => {
        const botData = botPool.get(botId);
        if (!botData || !botData.client || botData.status !== 'Online') return;

        const client = botData.client;
        const raw = botData.rawInventory || {};
        const click = (s, opts = {}) => writeWindowClick(client, { windowId: 0, stateId: botData.invStateId, slot: s, ...opts });

        try {
            if (action === 'drop') {
                if (!raw[slot]) return;
                // mode 4 + button 1 = tüm yığını at
                click(Number(slot), { mode: 4, mouseButton: 1, changedSlots: [{ location: Number(slot), item: EMPTY_SLOT }] });
                broadcastLog(botId, `🗑️ Slot ${slot} eşyası yere atıldı.`, 'success');
            } else if (action === 'move') {
                const from = Number(slot);
                const to = Number(targetSlot);
                const src = raw[from];
                if (!src || from === to) return;
                const dst = raw[to] || EMPTY_SLOT;

                // 1) kaynağı al
                click(from, { changedSlots: [{ location: from, item: EMPTY_SLOT }], cursorItem: src });
                // 2) hedefe bırak (hedef doluysa takas: hedefteki eşya imlece geçer)
                setTimeout(() => {
                    try {
                        click(to, { changedSlots: [{ location: to, item: src }], cursorItem: dst });
                        // 3) takas olduysa imlecin eşyasını kaynağa koy
                        if (dst.present !== false) {
                            setTimeout(() => {
                                try { click(from, { changedSlots: [{ location: from, item: dst }], cursorItem: EMPTY_SLOT }); } catch (e) {}
                            }, 100);
                        }
                    } catch (e) {
                        broadcastLog(botId, `Envanter işlem hatası: ${e.message}`, 'error');
                    }
                }, 100);
                broadcastLog(botId, `📦 Eşya Slot ${from} -> Slot ${to} taşınıyor.`, 'success');
            }
        } catch (e) {
            broadcastLog(botId, `Envanter işlem hatası: ${e.message}`, 'error');
        }
    });
});

const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || '0.0.0.0'; // uzaktan erişim için HOST=0.0.0.0
server.listen(PORT, HOST, () => {
    console.log(`Panel http://${HOST}:${PORT} adresinde aktif.`);
    console.log(`🔐 Panel token'ı: ${PANEL_TOKEN}  (dosya: ${TOKEN_FILE})`);
    setTimeout(() => startAllBots(), 5000);
});
