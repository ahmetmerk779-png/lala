const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const mc = require('minecraft-protocol');
const mcData = require('minecraft-data');
const path = require('path');
const fs = require('fs');
const { SocksClient } = require('socks');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

process.on('uncaughtException', (err) => console.error('[Hata Engellendi]:', err.message));
process.on('unhandledRejection', (reason) => console.error('[Söz Rejeksiyonu Engellendi]:', reason));

const DATA_FILE = path.join(__dirname, 'bots.json');
const botPool = new Map();

// -------------------------------------------------------------
// SOCKS5 PROXY HAVUZU (Farklı IP/Ülke adreslerinizi ekleyin)
// -------------------------------------------------------------
const proxyPoolList = [
    'socks5://user:pass@185.220.101.1:1080',
    'socks5://user:pass@193.106.191.2:1080',
    'socks5://user:pass@45.142.214.3:1080',
    'socks5://user:pass@103.152.112.4:1080'
];

let globalConfig = {
    host: '141.95.82.164',
    port: 25565,
    version: '1.20.1',
    autoPassword: 'deliyizpassword',
    autoSubServerCmd: '/gir asmp',
    autoSubServerDelay: 4,
    autoReconnect: true,
    proxy: ''
};

const defaultBotConfigs = [
    { id: 'bot_1', username: 'Efe_Pro99', host: '141.95.82.164', port: 25565, autoPassword: 'deliyizpassword', proxy: '' },
    { id: 'bot_2', username: 'Ahmet_K23', host: '141.95.82.164', port: 25565, autoPassword: 'deliyizpassword', proxy: '' },
    { id: 'bot_3', username: 'Mehmet_X1', host: '141.95.82.164', port: 25565, autoPassword: 'deliyizpassword', proxy: '' }
];

const mcDataCache = {};

function parseProxy(proxyStr) {
    if (!proxyStr || typeof proxyStr !== 'string' || !proxyStr.trim()) return null;
    try {
        let str = proxyStr.trim();
        let type = 5;

        if (str.startsWith('socks4://')) { type = 4; str = str.replace('socks4://', ''); }
        else if (str.startsWith('socks5://')) { type = 5; str = str.replace('socks5://', ''); }
        else if (str.startsWith('http://') || str.startsWith('https://')) { str = str.replace(/^https?:\/\//, ''); }

        let host, port, userId = '', password = '';

        if (str.includes('@')) {
            const [auth, serverInfo] = str.split('@');
            const [u, p] = auth.split(':');
            const [h, prt] = serverInfo.split(':');
            userId = u || ''; password = p || ''; host = h; port = Number(prt);
        } else {
            const parts = str.split(':');
            if (parts.length === 2) { host = parts[0]; port = Number(parts[1]); }
            else if (parts.length === 4) { host = parts[0]; port = Number(parts[1]); userId = parts[2]; password = parts[3]; }
        }

        if (!host || isNaN(port)) return null;
        return { host, port, type, userId, password };
    } catch (e) { return null; }
}

function getAutoProxyForBot(botId) {
    if (!proxyPoolList || proxyPoolList.length === 0) return '';
    const botKeys = Array.from(botPool.keys());
    const index = botKeys.indexOf(botId);
    const assignedIndex = index >= 0 ? index % proxyPoolList.length : 0;
    return proxyPoolList[assignedIndex];
}

function getMcData(version) {
    const verStr = (version || '1.20.1').toString().trim();
    if (mcDataCache[verStr]) return mcDataCache[verStr];

    try {
        const data = mcData(verStr);
        if (data && data.items) { mcDataCache[verStr] = data; return data; }
    } catch (e) {}

    try {
        if (!mcDataCache['1.20.1']) mcDataCache['1.20.1'] = mcData('1.20.1');
        return mcDataCache['1.20.1'];
    } catch (e) { return null; }
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

function parseMcText(text) {
    if (!text) return '';
    let str = '';
    if (typeof text === 'string') {
        try { return parseMcText(JSON.parse(text)); } catch (e) { str = text; }
    } else if (typeof text === 'object') {
        if (text.text) str += text.text;
        if (Array.isArray(text.extra)) str += text.extra.map(e => parseMcText(e)).join('');
        if (text.translate) str += text.translate;
    }
    return str.replace(/§[0-9a-fk-or]/gi, '').replace(/&[0-9a-fk-or]/gi, '').trim();
}

function initDefaultBots() {
    botPool.clear();
    defaultBotConfigs.forEach(cfg => {
        botPool.set(cfg.id, { 
            ...cfg, status: 'Offline', onlineSince: null, client: null, logs: [], inventory: {}, 
            scoreboard: null, isManualStop: false, pos: { x: 0, y: 0, z: 0 }, tabList: {}, entities: {} 
        });
    });
    saveDataToFile();
}

function loadSavedData() {
    if (!fs.existsSync(DATA_FILE)) { initDefaultBots(); return; }
    try {
        const rawData = fs.readFileSync(DATA_FILE, 'utf8').trim();
        if (!rawData) { initDefaultBots(); return; }
        const parsed = JSON.parse(rawData);
        if (parsed.globalConfig) globalConfig = { ...globalConfig, ...parsed.globalConfig };
        
        if (Array.isArray(parsed.bots) && parsed.bots.length > 0) {
            botPool.clear();
            parsed.bots.forEach(b => {
                botPool.set(b.id, { 
                    ...b, status: 'Offline', onlineSince: null, client: null, logs: [], inventory: {}, 
                    scoreboard: null, isManualStop: false, pos: { x: 0, y: 0, z: 0 }, tabList: {}, entities: {} 
                });
            });
        } else { initDefaultBots(); }
    } catch (err) { initDefaultBots(); }
}

function saveDataToFile() {
    try {
        const botList = Array.from(botPool.values()).map(b => ({
            id: b.id, username: b.username, host: b.host, port: b.port,
            version: b.version, autoPassword: b.autoPassword,
            autoSubServerCmd: b.autoSubServerCmd, autoSubServerDelay: b.autoSubServerDelay,
            proxy: b.proxy || ''
        }));
        fs.writeFileSync(DATA_FILE, JSON.stringify({ globalConfig, bots: botList }, null, 2), 'utf8');
    } catch (err) {}
}

loadSavedData();

function broadcastLog(botId, text, type = 'info') {
    if (!text || typeof text !== 'string' || !text.trim()) return;
    const timestamp = new Date().toLocaleTimeString('tr-TR');
    const logEntry = { botId, text, timestamp, type };

    if (botPool.has(botId)) {
        const botData = botPool.get(botId);
        botData.logs.push(logEntry);
        if (botData.logs.length > 25) botData.logs.shift();
    }
    io.emit('bot-log', logEntry);
}

function sendChat(client, message) {
    if (!client) return;
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
    } catch (e) {}
}

// ANTİ-BAN HAREKET DÖNGÜSÜ
function startHumanBehaviorLoop(botId) {
    const botData = botPool.get(botId);
    if (!botData || !botData.client) return;

    if (botData.antiBanLoopTimer) clearTimeout(botData.antiBanLoopTimer);

    function nextAction() {
        if (!botData.client || botData.status !== 'Online') return;

        try {
            const yaw = Math.floor(Math.random() * 360) - 180;
            const pitch = Math.floor(Math.random() * 20) - 10;
            botData.client.write('look', { yaw, pitch, onGround: true });

            const randomAction = Math.floor(Math.random() * 4);
            if (randomAction === 0) {
                botData.client.write('arm_animation', { hand: 0 });
            } else if (randomAction === 1) {
                const randomSlot = Math.floor(Math.random() * 9);
                botData.client.write('held_item_slot', { slotId: randomSlot });
            } else if (randomAction === 2) {
                botData.client.write('entity_action', { entityId: 0, actionId: 0, jumpBoost: 0 });
                setTimeout(() => {
                    if (botData.client) {
                        try { botData.client.write('entity_action', { entityId: 0, actionId: 1, jumpBoost: 0 }); } catch (e) {}
                    }
                }, 350);
            }
        } catch (e) {}

        const randomDelay = Math.floor(Math.random() * 3500) + 2500;
        botData.antiBanLoopTimer = setTimeout(nextAction, randomDelay);
    }

    nextAction();
}

function setupCustomPacketHandler(client, botId) {
    let isSequenceStarted = false;
    let afkFailCount = 0;
    const botData = botPool.get(botId);

    function clearBotTimers() {
        if (botData.subCmdInterval) clearInterval(botData.subCmdInterval);
        if (botData.afkTimer) clearTimeout(botData.afkTimer);
        if (botData.afkRetryTimer) clearTimeout(botData.afkRetryTimer);
        if (botData.antiBanLoopTimer) clearTimeout(botData.antiBanLoopTimer);
        
        botData.subCmdInterval = null;
        botData.afkTimer = null;
        botData.afkRetryTimer = null;
        botData.antiBanLoopTimer = null;
    }

    clearBotTimers();
    botData.waitingForAfkGui = false;
    botData.inventory = {};
    botData.tabList = {};
    botData.entities = {};
    botData.pos = { x: 0, y: 0, z: 0 };

    function triggerAfkWithRetry() {
        if (!botData.client || botData.status !== 'Online') return;

        botData.waitingForAfkGui = true;
        sendChat(client, '/afk');
        broadcastLog(botId, '🚶 /afk yazıldı, menü bekleniyor...', 'info');

        if (botData.afkRetryTimer) clearTimeout(botData.afkRetryTimer);

        botData.afkRetryTimer = setTimeout(() => {
            if (botData.waitingForAfkGui && botData.client && botData.status === 'Online') {
                afkFailCount++;
                if (afkFailCount >= 3) {
                    broadcastLog(botId, '⚠️ Lobiye düşülmüş olabilir. Tekrar alt sunucuya giriliyor...', 'error');
                    afkFailCount = 0;
                    isSequenceStarted = false;
                    const subCmd = botData.autoSubServerCmd !== undefined ? botData.autoSubServerCmd : globalConfig.autoSubServerCmd;
                    if (subCmd) sendChat(client, subCmd);
                } else {
                    broadcastLog(botId, `⚠ Menü açılmadı, /afk tekrar deneniyor... (${afkFailCount}/3)`, 'warn');
                    triggerAfkWithRetry();
                }
            }
        }, 6000);
    }

    client.on('packet', (data, meta) => {
        if (meta.state !== 'play') return;

        switch (meta.name) {
            case 'update_health':
                if (data.health <= 0) {
                    broadcastLog(botId, '☠️ Bot öldü! Respawn gönderiliyor...', 'error');
                    try { client.write('client_command', { actionId: 0 }); } catch (e) {}
                }
                break;

            case 'respawn':
                clearBotTimers();
                botData.waitingForAfkGui = false;
                afkFailCount = 0;
                
                setTimeout(() => {
                    if (!botData.client || botData.status !== 'Online') return;
                    const subCmd = botData.autoSubServerCmd !== undefined ? botData.autoSubServerCmd : globalConfig.autoSubServerCmd;
                    if (subCmd && subCmd.trim() !== '') sendChat(client, subCmd);
                    botData.afkTimer = setTimeout(() => triggerAfkWithRetry(), 5000);
                }, Math.floor(Math.random() * 1500) + 1500);
                break;

            case 'window_items':
                if (data.items && Array.isArray(data.items)) {
                    const botVer = botData.version || globalConfig.version || '1.20.1';
                    data.items.forEach((item, idx) => {
                        if (item && item.present !== false && item.itemId !== undefined && item.itemId !== -1) {
                            const details = getItemDetails(botVer, item.itemId);
                            botData.inventory[idx] = { slot: idx, count: item.itemCount || 1, ...details };
                        } else {
                            delete botData.inventory[idx];
                        }
                    });
                    io.emit('bot-inventory-update', { botId, inventory: botData.inventory });
                }

                if (data.windowId !== 0 && botData.waitingForAfkGui) {
                    botData.waitingForAfkGui = false;
                    afkFailCount = 0;
                    if (botData.afkRetryTimer) clearTimeout(botData.afkRetryTimer);

                    setTimeout(() => {
                        if (botData.client && botData.status === 'Online') {
                            try {
                                client.write('window_click', {
                                    windowId: data.windowId,
                                    stateId: data.stateId || 0,
                                    slot: 12,
                                    mouseButton: 1,
                                    mode: 0,
                                    changedSlots: [],
                                    cursorItem: { present: false }
                                });
                                broadcastLog(botId, `🎯 AFK Menüsü Sağ Tıklandı! (Slot: 12)`, 'success');
                            } catch (e) {
                                setTimeout(() => triggerAfkWithRetry(), 3000);
                            }
                        }
                    }, Math.floor(Math.random() * 600) + 800);
                }
                break;

            case 'set_slot':
                if (data.slot !== undefined) {
                    const botVer = botData.version || globalConfig.version || '1.20.1';
                    const item = data.item;
                    if (item && item.present !== false && item.itemId !== undefined && item.itemId !== -1) {
                        const details = getItemDetails(botVer, item.itemId);
                        botData.inventory[data.slot] = { slot: data.slot, count: item.itemCount || 1, ...details };
                    } else {
                        delete botData.inventory[data.slot];
                    }
                    io.emit('bot-inventory-update', { botId, inventory: botData.inventory });
                }
                break;

            case 'position':
                try {
                    if (data.teleportId !== undefined) client.write('teleport_confirm', { teleportId: data.teleportId });
                    client.write('position', { x: data.x, y: data.y, z: data.z, onGround: true });
                } catch (e) {}

                botData.pos = { x: Math.round(data.x * 10) / 10, y: Math.round(data.y * 10) / 10, z: Math.round(data.z * 10) / 10 };
                io.emit('bot-pos-update', { botId, pos: botData.pos });

                if (!isSequenceStarted) {
                    isSequenceStarted = true;
                    const pwd = botData.autoPassword !== undefined ? botData.autoPassword : globalConfig.autoPassword;
                    const subCmd = botData.autoSubServerCmd !== undefined ? botData.autoSubServerCmd : globalConfig.autoSubServerCmd;

                    const randomInitialDelay = Math.floor(Math.random() * 1700) + 1800;

                    setTimeout(() => {
                        if (!botData.client) return;

                        if (pwd && pwd.trim() !== '') {
                            sendChat(client, `/login ${pwd}`);
                            broadcastLog(botId, `🔑 /login gönderildi.`, 'info');
                        }

                        if (subCmd && subCmd.trim() !== '') {
                            setTimeout(() => {
                                if (!botData.client) return;
                                sendChat(client, subCmd);
                                broadcastLog(botId, `🚀 Alt sunucu komutu gönderildi: ${subCmd}`, 'success');
                                botData.afkTimer = setTimeout(() => triggerAfkWithRetry(), 9000);
                            }, 2000);
                        } else {
                            botData.afkTimer = setTimeout(() => triggerAfkWithRetry(), 4000);
                        }
                    }, randomInitialDelay);
                }
                break;

            case 'keep_alive':
                try { client.write('keep_alive', { keepAliveId: data.keepAliveId }); } catch (e) {}
                break;

            case 'ping':
                try { client.write('pong', { id: data.id }); } catch (e) {}
                break;

            case 'player_chat':
            case 'system_chat':
            case 'chat':
                handleIncomingChat(data, botId, (msg) => {
                    broadcastLog(botId, msg, 'chat');
                    const msgLower = msg.toLowerCase();
                    if (msgLower.includes('ışınlanma isteği') || msgLower.includes('teleport request') || msgLower.includes('tpaccept')) {
                        setTimeout(() => {
                            if (botData.client && botData.status === 'Online') sendChat(client, '/tpaccept');
                        }, Math.floor(Math.random() * 1000) + 1000);
                    }
                });
                break;
        }
    });
}

function handleIncomingChat(data, botId, callback) {
    let text = '';
    try {
        if (data.plainMessage) text = data.plainMessage;
        else if (data.content) text = parseMcText(data.content);
        else if (data.message) text = parseMcText(data.message);
    } catch (e) {}
    if (text && text.trim()) callback(text);
}

function cleanupBot(botId, reason) {
    const botData = botPool.get(botId);
    if (!botData) return;

    if (botData.antiBanLoopTimer) clearTimeout(botData.antiBanLoopTimer);
    if (botData.subCmdInterval) clearInterval(botData.subCmdInterval);
    if (botData.afkTimer) clearTimeout(botData.afkTimer);
    if (botData.afkRetryTimer) clearTimeout(botData.afkRetryTimer);
    if (botData.reconnectTimer) clearTimeout(botData.reconnectTimer);

    if (botData.client) {
        try {
            botData.client.removeAllListeners();
            botData.client.end();
        } catch (e) {}
        botData.client = null;
    }

    botData.status = 'Offline';
    botData.onlineSince = null;
    botData.inventory = {};

    broadcastLog(botId, `🔴 ${reason}`, 'error');
    io.emit('status-update', { botId, status: 'Offline', onlineSince: null });

    if (!botData.isManualStop && globalConfig.autoReconnect) {
        const reconnectDelay = Math.floor(Math.random() * 15000) + 10000;
        broadcastLog(botId, `⏳ Otomatik yeniden bağlanma ${Math.round(reconnectDelay/1000)}s sonra deneniyor...`, 'warn');
        botData.reconnectTimer = setTimeout(() => {
            if (botPool.has(botId) && !botData.isManualStop && botData.status === 'Offline') {
                startBotInstance(botId);
            }
        }, reconnectDelay);
    }
}

function startBotInstance(botId) {
    const botData = botPool.get(botId);
    if (!botData || botData.client) return;

    botData.isManualStop = false;
    const host = botData.host || globalConfig.host;
    const port = Number(botData.port || globalConfig.port);
    const version = botData.version || globalConfig.version;
    
    const proxyString = botData.proxy || globalConfig.proxy || getAutoProxyForBot(botId);

    broadcastLog(botId, `${botData.username} bağlanıyor (${host}:${port})...`, 'info');
    botData.status = 'Connecting';
    io.emit('status-update', { botId, status: 'Connecting', onlineSince: null });

    const clientOptions = {
        host: host,
        port: port,
        username: botData.username,
        version: version || '1.20.1',
        checkTimeoutInterval: 60000,
        keepAlive: true
    };

    const parsedProxy = parseProxy(proxyString);
    if (parsedProxy) {
        broadcastLog(botId, `🌐 Proxy IP Kullanılıyor: ${parsedProxy.host}:${parsedProxy.port}`, 'info');
        clientOptions.connect = (client) => {
            SocksClient.createConnection({
                proxy: {
                    host: parsedProxy.host,
                    port: parsedProxy.port,
                    type: parsedProxy.type,
                    userId: parsedProxy.userId,
                    password: parsedProxy.password
                },
                command: 'connect',
                destination: { host: host, port: port }
            }, (err, info) => {
                if (err) {
                    cleanupBot(botId, `Proxy Bağlantı Hatası: ${err.message}`);
                    return;
                }
                client.setSocket(info.socket);
                client.emit('connect');
            });
        };
    }

    try {
        const client = mc.createClient(clientOptions);
        botData.client = client;
        setupCustomPacketHandler(client, botId);

        client.on('success', () => {
            botData.status = 'Online';
            botData.onlineSince = Date.now();
            broadcastLog(botId, `⚡ ${botData.username} oyuna girdi!`, 'success');
            io.emit('status-update', { botId, status: 'Online', onlineSince: botData.onlineSince });

            try {
                client.write('settings', {
                    locale: 'tr_TR',
                    viewDistance: 8,
                    chatFlags: 0,
                    chatColors: true,
                    skinParts: 127,
                    mainHand: 1,
                    enableTextFiltering: false,
                    allowServerListings: true
                });
            } catch (e) {}

            startHumanBehaviorLoop(botId);
        });

        client.on('kick_disconnect', (packet) => cleanupBot(botId, `Atıldı: ${packet.reason}`));
        client.on('disconnect', (packet) => cleanupBot(botId, `Bağlantı Kesildi: ${packet.reason}`));
        client.on('error', (err) => cleanupBot(botId, `Hata: ${err.message}`));
        client.on('end', () => cleanupBot(botId, `Bağlantı sonlandı.`));

    } catch (err) {
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
            delay += Math.floor(Math.random() * 3500) + 3500;
        }
    }
}

io.on('connection', (socket) => {
    const botList = Array.from(botPool.values()).map(b => ({
        id: b.id, username: b.username, host: b.host || globalConfig.host,
        port: b.port || globalConfig.port, version: b.version || globalConfig.version,
        autoPassword: b.autoPassword !== undefined ? b.autoPassword : globalConfig.autoPassword,
        autoSubServerCmd: b.autoSubServerCmd !== undefined ? b.autoSubServerCmd : globalConfig.autoSubServerCmd,
        proxy: b.proxy || '', status: b.status, onlineSince: b.onlineSince || null, pos: b.pos || { x: 0, y: 0, z: 0 },
        logs: b.logs, inventory: b.inventory || {}
    }));

    socket.emit('init-data', { botList, globalConfig });

    socket.on('update-config', (newConfig) => { globalConfig = { ...globalConfig, ...newConfig }; saveDataToFile(); io.emit('config-updated', globalConfig); });
    socket.on('update-bot-config', ({ botId, config }) => { if (!botPool.has(botId)) return; Object.assign(botPool.get(botId), config); saveDataToFile(); io.emit('bot-updated', { botId, config: botPool.get(botId) }); });
    socket.on('start-bot', (botId) => startBotInstance(botId));
    socket.on('stop-bot', (botId) => stopBotInstance(botId));
    socket.on('start-all', () => startAllBots());
    socket.on('stop-all', () => { for (const id of botPool.keys()) stopBotInstance(id); });

    socket.on('add-bot', (data) => {
        const username = typeof data === 'string' ? data : data.username;
        if (!username) return;
        const id = 'bot_' + Date.now();
        const newBot = {
            id, username,
            host: typeof data === 'object' && data.host ? data.host : globalConfig.host,
            port: typeof data === 'object' && data.port ? data.port : globalConfig.port,
            version: typeof data === 'object' && data.version ? data.version : globalConfig.version,
            autoPassword: typeof data === 'object' && data.autoPassword !== undefined ? data.autoPassword : globalConfig.autoPassword,
            autoSubServerCmd: typeof data === 'object' && data.autoSubServerCmd !== undefined ? data.autoSubServerCmd : globalConfig.autoSubServerCmd,
            proxy: typeof data === 'object' && data.proxy ? data.proxy : globalConfig.proxy,
            status: 'Offline', onlineSince: null, pos: { x: 0, y: 0, z: 0 },
            client: null, logs: [], inventory: {}, isManualStop: false
        };
        botPool.set(id, newBot);
        saveDataToFile();
        io.emit('bot-added', newBot);
    });

    socket.on('delete-bot', (botId) => { stopBotInstance(botId); botPool.delete(botId); saveDataToFile(); io.emit('bot-deleted', botId); });
    socket.on('send-command', ({ targetBotId, command }) => {
        if (!command) return;
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
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Panel http://localhost:${PORT} adresinde aktif.`));
