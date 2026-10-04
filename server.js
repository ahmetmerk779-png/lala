const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const mc = require('minecraft-protocol');
const mcData = require('minecraft-data');
const path = require('path');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

process.on('uncaughtException', (err) => console.error('[Hata Engellendi]:', err.message));
process.on('unhandledRejection', (reason) => console.error('[Söz Rejeksiyonu Engellendi]:', reason));

const DATA_FILE = path.join(__dirname, 'bots.json');
const botPool = new Map();

let globalConfig = {
    host: '141.95.82.164',
    port: 25565,
    version: '1.20.1',
    autoPassword: 'deliyizpassword',
    autoSubServerCmd: '/gir asmp',
    autoSubServerDelay: 4,
    autoReconnect: true
};

const defaultBotConfigs = [
    { id: 'bot_1', username: 'Deliyiz_1', host: '141.95.82.164', port: 25565, autoPassword: 'deliyizpassword' },
    { id: 'bot_2', username: 'Deliyiz_2', host: '141.95.82.164', port: 25565, autoPassword: 'deliyizpassword' },
    { id: 'bot_3', username: 'Deliyiz_3', host: '141.95.82.164', port: 25565, autoPassword: 'deliyizpassword' }
];

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
    } catch (e) {
        console.warn(`[mcData Warning] '${verStr}' yüklenemedi, 1.20.1 deneniyor...`);
    }

    try {
        if (!mcDataCache['1.20.1']) {
            mcDataCache['1.20.1'] = mcData('1.20.1');
        }
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

function parseMcText(text) {
    if (!text) return '';
    let str = '';
    if (typeof text === 'string') {
        try {
            return parseMcText(JSON.parse(text));
        } catch (e) {
            str = text;
        }
    } else if (typeof text === 'object') {
        if (text.text) str += text.text;
        if (Array.isArray(text.extra)) {
            str += text.extra.map(e => parseMcText(e)).join('');
        }
        if (text.translate) str += text.translate;
    }
    return str.replace(/§[0-9a-fk-or]/gi, '').replace(/&[0-9a-fk-or]/gi, '').trim();
}

function loadSavedData() {
    if (!fs.existsSync(DATA_FILE)) {
        defaultBotConfigs.forEach(cfg => {
            botPool.set(cfg.id, { 
                ...cfg, status: 'Offline', onlineSince: null, client: null, logs: [], inventory: {}, 
                scoreboard: null, isManualStop: false, pos: { x: 0, y: 0, z: 0 }, tabList: {}, entities: {} 
            });
        });
        saveDataToFile();
        return;
    }
    try {
        const rawData = fs.readFileSync(DATA_FILE, 'utf8');
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
        }
    } catch (err) {
        console.error('[Hafıza Okuma Hatası]', err.message);
    }
}

function saveDataToFile() {
    try {
        const botList = Array.from(botPool.values()).map(b => ({
            id: b.id, username: b.username, host: b.host, port: b.port,
            version: b.version, autoPassword: b.autoPassword,
            autoSubServerCmd: b.autoSubServerCmd, autoSubServerDelay: b.autoSubServerDelay
        }));
        fs.writeFileSync(DATA_FILE, JSON.stringify({ globalConfig, bots: botList }, null, 2));
    } catch (err) {
        console.error('[Hafıza Kayıt Hatası]', err.message);
    }
}

loadSavedData();

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
    if (botData) {
        io.emit('bot-inventory', { botId, inventory: botData.inventory || {} });
    }
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

function setupCustomPacketHandler(client, botId) {
    let isSequenceStarted = false;
    let afkFailCount = 0;
    const botData = botPool.get(botId);

    function clearBotTimers() {
        if (botData.subCmdInterval) clearInterval(botData.subCmdInterval);
        if (botData.afkTimer) clearTimeout(botData.afkTimer);
        if (botData.afkRetryTimer) clearTimeout(botData.afkRetryTimer);
        if (botData.sbUpdateTimer) clearTimeout(botData.sbUpdateTimer);
        if (botData.tabUpdateTimer) clearTimeout(botData.tabUpdateTimer);
        if (botData.mapUpdateTimer) clearTimeout(botData.mapUpdateTimer);
        
        botData.subCmdInterval = null;
        botData.afkTimer = null;
        botData.afkRetryTimer = null;
        botData.sbUpdateTimer = null;
        botData.tabUpdateTimer = null;
        botData.mapUpdateTimer = null;
    }

    clearBotTimers();
    botData.waitingForAfkGui = false;
    botData.currentWindowId = 0;
    botData.currentStateId = 0;
    botData.inventory = {};
    botData.tabList = {};
    botData.entities = {};
    botData.pos = { x: 0, y: 0, z: 0 };

    botData.scoreboardData = {
        sidebarObjective: null,
        objectives: {},
        scores: {},
        teams: {}
    };

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
            const players = Object.values(botData.tabList);
            io.emit('bot-tablist', { botId, players });
        }, 600);
    }

    function queueMapUpdate() {
        if (botData.mapUpdateTimer) return;
        botData.mapUpdateTimer = setTimeout(() => {
            botData.mapUpdateTimer = null;
            const entityArray = Object.values(botData.entities);
            io.emit('bot-map-update', { 
                botId, 
                pos: botData.pos, 
                entities: entityArray 
            });
        }, 300);
    }

    function broadcastDynamicScoreboard() {
        const sb = botData.scoreboardData;
        if (!sb || !sb.sidebarObjective) {
            io.emit('bot-scoreboard', { botId, scoreboard: null });
            return;
        }

        const activeObjName = sb.sidebarObjective;
        const objInfo = sb.objectives[activeObjName];
        const rawScores = sb.scores[activeObjName] || {};

        const title = objInfo ? objInfo.title : 'Scoreboard';
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

            let cleanEntry = scoreItem.customName || parseMcText(entryKey);
            let fullText = (prefix + cleanEntry + suffix).trim();
            if (!fullText) fullText = cleanEntry;

            lines.push({
                text: fullText,
                score: scoreItem.val
            });
        });

        lines.sort((a, b) => b.score - a.score);

        io.emit('bot-scoreboard', {
            botId,
            scoreboard: { title, lines }
        });
    }

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
                    broadcastLog(botId, '☠️ Bot öldü! Otomatik Respawn gönderiliyor...', 'error');
                    try { client.write('client_command', { actionId: 0 }); } catch (e) {}
                }
                break;

            case 'respawn':
                clearBotTimers();
                botData.waitingForAfkGui = false;
                botData.entities = {};
                afkFailCount = 0;
                broadcastLog(botId, '🔄 Sunucu değişimi algılandı. AFK ve Harita verileri yenileniyor...', 'warn');
                botData.afkTimer = setTimeout(() => triggerAfkWithRetry(), 4000);
                break;

            case 'window_items':
                if (data.windowId === 0) {
                    botData.inventory = {};
                    if (Array.isArray(data.items)) {
                        data.items.forEach((item, index) => {
                            if (item && item.present !== false && item.itemId !== undefined && item.itemId !== -1) {
                                const details = getItemDetails(botData.version || globalConfig.version, item.itemId);
                                botData.inventory[index] = {
                                    slot: index,
                                    id: item.itemId,
                                    name: details ? details.name : 'unknown',
                                    displayName: details ? details.displayName : `ID: ${item.itemId}`,
                                    count: item.itemCount || 1
                                };
                            }
                        });
                    }
                    broadcastInventory(botId);
                } else {
                    botData.currentWindowId = data.windowId;
                    botData.currentStateId = data.stateId;

                    if (botData.waitingForAfkGui) {
                        botData.waitingForAfkGui = false;
                        afkFailCount = 0;
                        if (botData.afkRetryTimer) clearTimeout(botData.afkRetryTimer);

                        setTimeout(() => {
                            if (botData.client && botData.status === 'Online') {
                                try {
                                    client.write('window_click', {
                                        windowId: botData.currentWindowId,
                                        stateId: botData.currentStateId,
                                        slot: 12,
                                        mouseButton: 1,
                                        mode: 0,
                                        changedSlots: [],
                                        cursorItem: { present: false }
                                    });
                                    broadcastLog(botId, `🎯 AFK Menüsü Başarıyla Tıklandı! (Slot: 12)`, 'success');
                                } catch (e) {
                                    broadcastLog(botId, `Menü tıklama hatası: ${e.message}`, 'error');
                                    setTimeout(() => triggerAfkWithRetry(), 3000);
                                }
                            }
                        }, 1000);
                    }
                }
                break;

            case 'set_slot':
                if (data.windowId === 0) {
                    const item = data.item;
                    if (!item || item.present === false || item.itemId !== undefined || item.itemId !== -1) {
                        delete botData.inventory[data.slot];
                    } else {
                        const details = getItemDetails(botData.version || globalConfig.version, item.itemId);
                        botData.inventory[data.slot] = {
                            slot: data.slot,
                            id: item.itemId,
                            name: details ? details.name : 'unknown',
                            displayName: details ? details.displayName : `ID: ${item.itemId}`,
                            count: item.itemCount || 1
                        };
                    }
                    broadcastInventory(botId);
                }
                break;

            case 'open_window':
                botData.currentWindowId = data.windowId;
                break;

            case 'position':
                try {
                    if (data.teleportId !== undefined) {
                        client.write('teleport_confirm', { teleportId: data.teleportId });
                    }
                    client.write('position', { x: data.x, y: data.y, z: data.z, onGround: true });
                } catch (e) {}

                botData.pos = {
                    x: Math.round(data.x * 10) / 10,
                    y: Math.round(data.y * 10) / 10,
                    z: Math.round(data.z * 10) / 10
                };
                queueMapUpdate();

                if (!isSequenceStarted) {
                    isSequenceStarted = true;

                    const pwd = botData.autoPassword !== undefined ? botData.autoPassword : globalConfig.autoPassword;
                    const subCmd = botData.autoSubServerCmd !== undefined ? botData.autoSubServerCmd : globalConfig.autoSubServerCmd;

                    setTimeout(() => {
                        if (!botData.client) return;

                        if (pwd && pwd.trim() !== '') {
                            sendChat(client, `/login ${pwd}`);
                            broadcastLog(botId, `🔑 /login gönderildi.`, 'info');
                        }

                        if (subCmd && subCmd.trim() !== '') {
                            let tryCount = 1;
                            const maxTries = 3;

                            sendChat(client, subCmd);
                            broadcastLog(botId, `🚀 Alt sunucu komutu gönderildi (1/${maxTries})`, 'success');

                            botData.subCmdInterval = setInterval(() => {
                                if (botData.client && botData.status === 'Online' && tryCount < maxTries) {
                                    tryCount++;
                                    sendChat(client, subCmd);
                                    broadcastLog(botId, `🚀 Alt sunucu komutu tekrarlandı (${tryCount}/${maxTries})`, 'success');
                                } else {
                                    clearInterval(botData.subCmdInterval);
                                    botData.subCmdInterval = null;
                                }
                            }, 3000);

                            botData.afkTimer = setTimeout(() => triggerAfkWithRetry(), 10000);
                        } else {
                            botData.afkTimer = setTimeout(() => triggerAfkWithRetry(), 4000);
                        }
                    }, 2000);
                }
                break;

            case 'spawn_entity':
            case 'named_entity_spawn':
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

            case 'entity_teleport':
                if (botData.entities[data.entityId]) {
                    botData.entities[data.entityId].x = Math.round(data.x * 10) / 10;
                    botData.entities[data.entityId].y = Math.round(data.y * 10) / 10;
                    botData.entities[data.entityId].z = Math.round(data.z * 10) / 10;
                    queueMapUpdate();
                }
                break;

            case 'rel_entity_move':
            case 'entity_move_look':
                if (botData.entities[data.entityId]) {
                    botData.entities[data.entityId].x += (data.dX || 0) / (32 * 128);
                    botData.entities[data.entityId].z += (data.dZ || 0) / (32 * 128);
                    queueMapUpdate();
                }
                break;

            case 'entity_destroy':
            case 'destroy_entities':
                const eIds = data.entityIds || [data.entityId];
                if (Array.isArray(eIds)) {
                    eIds.forEach(id => delete botData.entities[id]);
                    queueMapUpdate();
                }
                break;

            case 'player_info_update':
                if (Array.isArray(data.data)) {
                    data.data.forEach(p => {
                        const uuid = p.uuid;
                        if (!botData.tabList[uuid]) {
                            botData.tabList[uuid] = { uuid, name: 'Bilinmeyen', displayName: '', ping: 0 };
                        }
                        if (p.player && p.player.name) {
                            botData.tabList[uuid].name = p.player.name;
                        }
                        if (p.displayName) {
                            botData.tabList[uuid].displayName = parseMcText(p.displayName);
                        }
                        if (p.latency !== undefined) {
                            botData.tabList[uuid].ping = p.latency;
                        }
                    });
                    queueTabListUpdate();
                }
                break;

            case 'player_remove':
                if (Array.isArray(data.uuids)) {
                    data.uuids.forEach(uuid => delete botData.tabList[uuid]);
                    queueTabListUpdate();
                }
                break;

            case 'player_info':
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
                        broadcastLog(botId, '📡 TPA isteği algılandı, kabul ediliyor...', 'info');
                        setTimeout(() => {
                            if (botData.client && botData.status === 'Online') {
                                sendChat(client, '/tpaccept');
                            }
                        }, 1000);
                    }
                });
                break;

            case 'display_objective':
            case 'scoreboard_display_objective':
                if (data.position === 1) {
                    botData.scoreboardData.sidebarObjective = data.name;
                    queueScoreboardUpdate();
                }
                break;

            case 'scoreboard_objective':
                const objName = data.name;
                if (data.action === 0 || data.action === 2) {
                    const titleText = parseMcText(data.displayText || data.name);
                    if (!botData.scoreboardData.objectives[objName]) {
                        botData.scoreboardData.objectives[objName] = {};
                    }
                    botData.scoreboardData.objectives[objName].title = titleText;
                } else if (data.action === 1) {
                    delete botData.scoreboardData.objectives[objName];
                    delete botData.scoreboardData.scores[objName];
                }
                queueScoreboardUpdate();
                break;

            case 'scoreboard_score':
            case 'set_score':
                const targetObj = data.scoreName || data.objectiveName;
                const itemName = data.itemName;

                if (!botData.scoreboardData.scores[targetObj]) {
                    botData.scoreboardData.scores[targetObj] = {};
                }

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

            case 'teams':
            case 'scoreboard_team':
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
                if (data.mode === 4) {
                    if (Array.isArray(data.players)) {
                        tObj.players = tObj.players.filter(p => !data.players.includes(p));
                    }
                }
                if (data.mode === 1) {
                    delete botData.scoreboardData.teams[teamName];
                }
                queueScoreboardUpdate();
                break;
        }
    });
}

function handleIncomingChat(data, botId, callback) {
    let text = '';
    try {
        if (data.plainMessage) {
            text = data.plainMessage;
        } else if (data.content) {
            text = parseMcText(data.content);
        } else if (data.message) {
            text = parseMcText(data.message);
        }
    } catch (e) {}

    if (text && text.trim()) callback(text);
}

function cleanupBot(botId, reason) {
    const botData = botPool.get(botId);
    if (!botData) return;

    if (botData.keepAliveInterval) clearInterval(botData.keepAliveInterval);
    if (botData.subCmdInterval) clearInterval(botData.subCmdInterval);
    if (botData.afkTimer) clearTimeout(botData.afkTimer);
    if (botData.afkRetryTimer) clearTimeout(botData.afkRetryTimer);
    if (botData.sbUpdateTimer) clearTimeout(botData.sbUpdateTimer);
    if (botData.tabUpdateTimer) clearTimeout(botData.tabUpdateTimer);
    if (botData.mapUpdateTimer) clearTimeout(botData.mapUpdateTimer);
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
    botData.scoreboard = null;
    botData.tabList = {};
    botData.entities = {};
    botData.pos = { x: 0, y: 0, z: 0 };

    broadcastLog(botId, `🔴 ${reason}`, 'error');
    io.emit('status-update', { botId, status: 'Offline', onlineSince: null });
    io.emit('bot-scoreboard', { botId, scoreboard: null });
    io.emit('bot-tablist', { botId, players: [] });
    io.emit('bot-map-update', { botId, pos: { x: 0, y: 0, z: 0 }, entities: [] });

    if (!botData.isManualStop && globalConfig.autoReconnect) {
        botData.reconnectTimer = setTimeout(() => {
            if (botPool.has(botId) && !botData.isManualStop && botData.status === 'Offline') {
                startBotInstance(botId);
            }
        }, 5000);
    }
}

function startBotInstance(botId) {
    const botData = botPool.get(botId);
    if (!botData || botData.client) return;

    botData.isManualStop = false;
    const host = botData.host || globalConfig.host;
    const port = Number(botData.port || globalConfig.port);
    const version = botData.version || globalConfig.version;

    broadcastLog(botId, `${botData.username} bağlanıyor (${host}:${port})...`, 'info');
    botData.status = 'Connecting';
    io.emit('status-update', { botId, status: 'Connecting', onlineSince: null });

    try {
        const client = mc.createClient({
            host: host,
            port: port,
            username: botData.username,
            version: version || '1.20.1',
            checkTimeoutInterval: 60000,
            keepAlive: true
        });

        botData.client = client;
        setupCustomPacketHandler(client, botId);

        client.on('success', () => {
            botData.status = 'Online';
            botData.onlineSince = Date.now();
            broadcastLog(botId, `⚡ ${botData.username} sunucuya girdi!`, 'success');
            io.emit('status-update', { botId, status: 'Online', onlineSince: botData.onlineSince });

            if (botData.keepAliveInterval) clearInterval(botData.keepAliveInterval);
            let currentYaw = 0;

            botData.keepAliveInterval = setInterval(() => {
                if (botData.client && botData.status === 'Online') {
                    try {
                        currentYaw = (currentYaw + (Math.floor(Math.random() * 30) + 15)) % 360;
                        const pitch = Math.floor(Math.random() * 20) - 10;
                        client.write('look', { yaw: currentYaw, pitch: pitch, onGround: true });
                        client.write('arm_animation', { hand: 0 });
                    } catch (e) {}
                } else {
                    clearInterval(botData.keepAliveInterval);
                    botData.keepAliveInterval = null;
                }
            }, 2000);
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
            delay += 2500;
        }
    }
}

io.on('connection', (socket) => {
    const botList = Array.from(botPool.values()).map(b => ({
        id: b.id, username: b.username, host: b.host || globalConfig.host,
        port: b.port || globalConfig.port, version: b.version || globalConfig.version,
        autoPassword: b.autoPassword !== undefined ? b.autoPassword : globalConfig.autoPassword,
        autoSubServerCmd: b.autoSubServerCmd !== undefined ? b.autoSubServerCmd : globalConfig.autoSubServerCmd,
        autoSubServerDelay: b.autoSubServerDelay !== undefined ? b.autoSubServerDelay : globalConfig.autoSubServerDelay,
        status: b.status, onlineSince: b.onlineSince || null, pos: b.pos || { x: 0, y: 0, z: 0 },
        logs: b.logs, inventory: b.inventory || {}
    }));

    socket.emit('init-data', { botList, globalConfig });

    socket.on('update-config', (newConfig) => {
        globalConfig = { ...globalConfig, ...newConfig };
        saveDataToFile();
        io.emit('config-updated', globalConfig);
    });

    socket.on('update-bot-config', ({ botId, config }) => {
        if (!botPool.has(botId)) return;
        const botData = botPool.get(botId);
        Object.assign(botData, config);
        saveDataToFile();
        io.emit('bot-updated', { botId, config: botData });
    });

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
            autoSubServerDelay: typeof data === 'object' && data.autoSubServerDelay !== undefined ? data.autoSubServerDelay : globalConfig.autoSubServerDelay,
            status: 'Offline', onlineSince: null, pos: { x: 0, y: 0, z: 0 },
            client: null, logs: [], inventory: {}, scoreboard: null, tabList: {}, entities: {}, isManualStop: false
        };
        botPool.set(id, newBot);
        saveDataToFile();
        io.emit('bot-added', newBot);
    });

    socket.on('delete-bot', (botId) => {
        stopBotInstance(botId);
        botPool.delete(botId);
        saveDataToFile();
        io.emit('bot-deleted', botId);
    });

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
