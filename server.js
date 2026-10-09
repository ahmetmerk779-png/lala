const express = require('express');
const http = require('http');
const https = require('https');
const axios = require('axios');
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
console.log('📁 Kayıt dosyasının tam yolu:', DATA_FILE);

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

function initDefaultBots() {
    botPool.clear();
    defaultBotConfigs.forEach(cfg => {
        botPool.set(cfg.id, { 
            ...cfg, status: 'Offline', onlineSince: null, client: null, logs: [], inventory: {}, 
            scoreboard: null, isManualStop: false, pos: { x: 0, y: 0, z: 0 }, tabList: {}, entities: {},
            macroInterval: null, macroTimeout: null
        });
    });
    saveDataToFile();
}

function loadSavedData() {
    if (!fs.existsSync(DATA_FILE)) {
        console.log('[Bilgi] bots.json bulunamadı, varsayılan botlar yükleniyor...');
        initDefaultBots();
        return;
    }
    try {
        const rawData = fs.readFileSync(DATA_FILE, 'utf8').trim();
        if (!rawData) {
            console.log('[Bilgi] bots.json dosyası boş, varsayılan botlar yükleniyor...');
            initDefaultBots();
            return;
        }

        const parsed = JSON.parse(rawData);
        if (parsed.globalConfig) globalConfig = { ...globalConfig, ...parsed.globalConfig };
        
        if (Array.isArray(parsed.bots) && parsed.bots.length > 0) {
            botPool.clear();
            parsed.bots.forEach(b => {
                botPool.set(b.id, { 
                    ...b, status: 'Offline', onlineSince: null, client: null, logs: [], inventory: {}, 
                    scoreboard: null, isManualStop: false, pos: { x: 0, y: 0, z: 0 }, tabList: {}, entities: {},
                    macroInterval: null, macroTimeout: null
                });
            });
            console.log(`[Başarılı] bots.json dosyasından ${parsed.bots.length} bot yüklendi.`);
        } else {
            console.log('[Bilgi] bots.json içinde kayıtlı bot bulunamadı.');
        }
    } catch (err) {
        console.error('[Hafıza Okuma Hatası - Dosya bozuk/geçersiz, sıfırlanıyor]:', err.message);
        initDefaultBots();
    }
}

function saveDataToFile() {
    try {
        const botList = Array.from(botPool.values()).map(b => ({
            id: b.id, username: b.username, host: b.host, port: b.port,
            version: b.version, autoPassword: b.autoPassword,
            autoSubServerCmd: b.autoSubServerCmd, autoSubServerDelay: b.autoSubServerDelay
        }));
        const fileContent = JSON.stringify({ globalConfig, bots: botList }, null, 2);
        fs.writeFileSync(DATA_FILE, fileContent, 'utf8');
        console.log('[Kayıt Başarılı] bots.json güncellendi. Toplam bot sayısı:', botList.length);
    } catch (err) {
        console.error('[KRİTİK DOSYA YAZMA HATASI]:', err);
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
        if (botData.macroInterval) clearInterval(botData.macroInterval);
        if (botData.macroTimeout) clearTimeout(botData.macroTimeout);
        
        botData.subCmdInterval = null;
        botData.afkTimer = null;
        botData.afkRetryTimer = null;
        botData.sbUpdateTimer = null;
        botData.tabUpdateTimer = null;
        botData.mapUpdateTimer = null;
        botData.macroInterval = null;
        botData.macroTimeout = null;
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
                    broadcastLog(botId, '⚠️ Lobiye düşülmüş olabilir. Yeniden döngü tetikleniyor...', 'error');
                    afkFailCount = 0;
                    isSequenceStarted = false;
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
                    try { 
                        client.write('client_command', { actionId: 0 }); 
                    } catch (e) {}
                }
                break;

            case 'respawn':
                clearBotTimers();
                botData.waitingForAfkGui = false;
                botData.entities = {};
                afkFailCount = 0;
                broadcastLog(botId, '🔄 Bot yeniden doğdu/sunucu değişti. Makro döngüsü yeniden başlatılıyor...', 'warn');
                
                setTimeout(() => {
                    if (!botData.client || botData.status !== 'Online') return;
                    // Respawn olunca mevcut makro döngüsü tekrar aktif kalacak
                }, 2000);
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

                        // ================= 5 SANİYE GECİKMELİ SAĞ TIK =================
                        setTimeout(() => {
                            if (botData.client && botData.status === 'Online') {
                                try {
                                    client.write('window_click', {
                                        windowId: botData.currentWindowId,
                                        stateId: botData.currentStateId,
                                        slot: 12, // 12. Slot
                                        mouseButton: 1, // Sağ Tık
                                        mode: 0,
                                        changedSlots: [],
                                        cursorItem: { present: false }
                                    });
                                    broadcastLog(botId, `🎯 AFK Menüsü: 12. Slota SAĞ TIKLANDI! (5 Sn Gecikmeli)`, 'success');
                                } catch (e) {
                                    broadcastLog(botId, `Menü tıklama hatası: ${e.message}`, 'error');
                                }
                            }
                        }, 5000); 
                        // =============================================================
                    }
                }
                break;

            case 'set_slot':
                if (data.windowId === 0) {
                    const item = data.item;
                    if (!item || item.present === false || item.itemId === undefined || item.itemId === -1) {
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

                    setTimeout(() => {
                        if (!botData.client) return;

                        if (pwd && pwd.trim() !== '') {
                            sendChat(client, `/login ${pwd}`);
                            broadcastLog(botId, `🔑 /login gönderildi.`, 'info');
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
                        customName: data.customName ? parseMcText(data.customName) : null
                    };
                } else if (data.action === 1) {
                    delete botData.scoreboardData.scores[targetObj][itemName];
                }
                queueScoreboardUpdate();
                break;

            case 'reset_score':
                const rObj = data.objectiveName;
                const rItem = data.itemName;
                if (botData.scoreboardData.scores[rObj]) {
                    delete botData.scoreboardData.scores[rObj][rItem];
                }
                queueScoreboardUpdate();
                break;

            case 'teams':
                const teamName = data.team;
                if (data.mode === 0 || data.mode === 2) {
                    if (!botData.scoreboardData.teams[teamName]) {
                        botData.scoreboardData.teams[teamName] = { players: [] };
                    }
                    botData.scoreboardData.teams[teamName].prefix = parseMcText(data.prefix) || '';
                    botData.scoreboardData.teams[teamName].suffix = parseMcText(data.suffix) || '';
                    
                    if (data.mode === 0 && Array.isArray(data.players)) {
                        botData.scoreboardData.teams[teamName].players = [...data.players];
                    }
                } else if (data.mode === 1) {
                    delete botData.scoreboardData.teams[teamName];
                } else if (data.mode === 3 && Array.isArray(data.players)) {
                    if (!botData.scoreboardData.teams[teamName]) botData.scoreboardData.teams[teamName] = { players: [] };
                    data.players.forEach(p => {
                        if (!botData.scoreboardData.teams[teamName].players.includes(p)) {
                            botData.scoreboardData.teams[teamName].players.push(p);
                        }
                    });
                } else if (data.mode === 4 && Array.isArray(data.players)) {
                    if (botData.scoreboardData.teams[teamName]) {
                        botData.scoreboardData.teams[teamName].players = 
                            botData.scoreboardData.teams[teamName].players.filter(p => !data.players.includes(p));
                    }
                }
                queueScoreboardUpdate();
                break;
        }
    });
}

function handleIncomingChat(data, botId, callback) {
    try {
        let msg = '';
        if (data.message) {
            msg = parseMcText(data.message);
        } else if (data.content) {
            msg = parseMcText(data.content);
        } else if (data.plainMessage) {
            msg = data.plainMessage;
        }
        
        if (msg) callback(msg);
    } catch (e) {}
}

function cleanupBot(botId, isManualStop = false) {
    const botData = botPool.get(botId);
    if (!botData) return;

    botData.isManualStop = isManualStop;

    if (botData.macroInterval) clearInterval(botData.macroInterval);
    if (botData.macroTimeout) clearTimeout(botData.macroTimeout);

    if (botData.client) {
        try {
            botData.client.removeAllListeners();
            botData.client.end();
        } catch (e) {}
    }

    botData.client = null;
    botData.status = 'Offline';
    botData.onlineSince = null;
    botData.inventory = {};
    botData.tabList = {};
    botData.entities = {};
    botData.pos = { x: 0, y: 0, z: 0 };
    botData.scoreboardData = null;

    io.emit('bot-status', { botId, status: botData.status });
    io.emit('bot-inventory', { botId, inventory: {} });
    io.emit('bot-tablist', { botId, players: [] });
    io.emit('bot-map-update', { botId, pos: botData.pos, entities: [] });
    io.emit('bot-scoreboard', { botId, scoreboard: null });
}

function startBotInstance(botId) {
    const botData = botPool.get(botId);
    if (!botData) return;

    if (botData.client) {
        cleanupBot(botId, true);
    }

    botData.status = 'Bağlanıyor...';
    botData.isManualStop = false;
    io.emit('bot-status', { botId, status: botData.status });

    const host = botData.host || globalConfig.host;
    const port = botData.port || globalConfig.port;
    const version = botData.version || globalConfig.version || '1.20.1';

    try {
        const client = mc.createClient({
            host: host,
            port: parseInt(port),
            username: botData.username,
            version: version
        });

        botData.client = client;

        client.on('connect', () => {
            broadcastLog(botId, `Sunucuya (${host}:${port}) bağlantı kuruldu. Giriş yapılıyor...`, 'info');
        });

        client.on('error', (err) => {
            if (botData.isManualStop) return;
            broadcastLog(botId, `Bağlantı Hatası: ${err.message}`, 'error');
            cleanupBot(botId, false);
            triggerAutoReconnect(botId);
        });

        client.on('end', (reason) => {
            if (botData.isManualStop) return;
            broadcastLog(botId, `Bağlantı koptu. Sebep: ${reason || 'Bilinmiyor'}`, 'error');
            cleanupBot(botId, false);
            triggerAutoReconnect(botId);
        });

        client.on('disconnect', (packet) => {
            if (botData.isManualStop) return;
            const msg = parseMcText(packet.reason) || 'Sunucudan atıldın.';
            broadcastLog(botId, `Kicklendi: ${msg}`, 'error');
            cleanupBot(botId, false);
            triggerAutoReconnect(botId);
        });

        client.on('success', (packet) => {
            botData.status = 'Online';
            botData.onlineSince = Date.now();
            io.emit('bot-status', { botId, status: botData.status });
            broadcastLog(botId, `Oyuna başarıyla giriş yapıldı! (${botData.username})`, 'success');
            
            setupCustomPacketHandler(client, botId);

            // =========================================================
            // MAKRO DÖNGÜSÜ (30 Saniyede bir kendini tekrarlar)
            // =========================================================
            if (botData.macroInterval) clearInterval(botData.macroInterval);
            
            const runMacroLoop = () => {
                if (botData.client && botData.status === 'Online') {
                    // 1) /gir asmp komutunu gönder
                    sendChat(botData.client, '/gir asmp');
                    broadcastLog(botId, '🔄 [Makro] /gir asmp komutu gönderildi.', 'info');
                    
                    // 2) 5 saniye bekle ve /afk komutunu gönder
                    botData.macroTimeout = setTimeout(() => {
                        if (botData.client && botData.status === 'Online') {
                            botData.waitingForAfkGui = true;
                            sendChat(botData.client, '/afk');
                            broadcastLog(botId, '🔄 [Makro] 5 sn beklendi, /afk komutu gönderildi.', 'info');
                        }
                    }, 5000); 
                } else {
                    clearInterval(botData.macroInterval);
                }
            };

            // Oyuna girdikten 5 saniye sonra ilk döngüyü başlat
            setTimeout(() => {
                runMacroLoop();
                // Ardından her 30 saniyede bir bu döngüyü tekrarla 
                // (Spam korumasına düşmemek için süreyi uzun tutmak iyidir)
                botData.macroInterval = setInterval(runMacroLoop, 30000);
            }, 5000);
            // =========================================================
        });

    } catch (err) {
        broadcastLog(botId, `Client oluşturulurken hata: ${err.message}`, 'error');
        cleanupBot(botId, false);
        triggerAutoReconnect(botId);
    }
}

function triggerAutoReconnect(botId) {
    if (!globalConfig.autoReconnect) return;
    const botData = botPool.get(botId);
    if (!botData || botData.isManualStop) return;

    botData.status = 'Yeniden bağlanıyor...';
    io.emit('bot-status', { botId, status: botData.status });
    
    setTimeout(() => {
        if (botPool.has(botId)) {
            const data = botPool.get(botId);
            if (!data.isManualStop && !data.client) {
                startBotInstance(botId);
            }
        }
    }, 15000);
}

// API ROUTLARI
app.get('/api/config', (req, res) => res.json(globalConfig));

app.post('/api/config', (req, res) => {
    globalConfig = { ...globalConfig, ...req.body };
    saveDataToFile();
    res.json({ success: true, config: globalConfig });
});

app.get('/api/bots', (req, res) => {
    const list = Array.from(botPool.values()).map(b => ({
        id: b.id,
        username: b.username,
        status: b.status,
        onlineSince: b.onlineSince,
        host: b.host,
        port: b.port
    }));
    res.json(list);
});

app.post('/api/bot/:id/start', (req, res) => {
    const botId = req.params.id;
    if (botPool.has(botId)) {
        startBotInstance(botId);
        res.json({ success: true });
    } else {
        res.status(404).json({ error: 'Bot bulunamadı' });
    }
});

app.post('/api/bot/:id/stop', (req, res) => {
    const botId = req.params.id;
    if (botPool.has(botId)) {
        cleanupBot(botId, true);
        res.json({ success: true });
    } else {
        res.status(404).json({ error: 'Bot bulunamadı' });
    }
});

app.post('/api/bot/:id/chat', (req, res) => {
    const botId = req.params.id;
    const msg = req.body.message;
    if (botPool.has(botId)) {
        const botData = botPool.get(botId);
        if (botData.client && botData.status === 'Online' && msg) {
            sendChat(botData.client, msg);
            res.json({ success: true });
        } else {
            res.status(400).json({ error: 'Bot aktif değil veya mesaj boş.' });
        }
    } else {
        res.status(404).json({ error: 'Bot bulunamadı' });
    }
});

app.post('/api/bot/:id/inventory/click', (req, res) => {
    const botId = req.params.id;
    const { slot, button } = req.body;
    
    if (botPool.has(botId)) {
        const botData = botPool.get(botId);
        if (botData.client && botData.status === 'Online') {
            try {
                const mouseBtn = button === 'right' ? 1 : 0;
                botData.client.write('window_click', {
                    windowId: 0,
                    stateId: 0,
                    slot: parseInt(slot),
                    mouseButton: mouseBtn,
                    mode: 0,
                    changedSlots: [],
                    cursorItem: { present: false }
                });
                broadcastLog(botId, `Envanter: Slot ${slot} tıklandı (${button}).`, 'info');
                res.json({ success: true });
            } catch (e) {
                res.status(500).json({ error: e.message });
            }
        } else {
            res.status(400).json({ error: 'Bot aktif değil' });
        }
    } else {
        res.status(404).json({ error: 'Bot bulunamadı' });
    }
});

app.delete('/api/bot/:id', (req, res) => {
    const botId = req.params.id;
    if (botPool.has(botId)) {
        cleanupBot(botId, true);
        botPool.delete(botId);
        saveDataToFile();
        res.json({ success: true });
    } else {
        res.status(404).json({ error: 'Bot bulunamadı' });
    }
});

app.post('/api/bot/new', (req, res) => {
    const { username, host, port } = req.body;
    if (!username) return res.status(400).json({ error: 'Kullanıcı adı gerekli' });

    const newId = 'bot_' + Date.now();
    botPool.set(newId, {
        id: newId,
        username,
        host: host || globalConfig.host,
        port: port || globalConfig.port,
        autoPassword: globalConfig.autoPassword,
        status: 'Offline',
        onlineSince: null,
        client: null,
        logs: [],
        inventory: {},
        tabList: {},
        entities: {},
        pos: { x: 0, y: 0, z: 0 },
        isManualStop: false,
        scoreboardData: null,
        macroInterval: null,
        macroTimeout: null
    });
    
    saveDataToFile();
    res.json({ success: true, botId: newId });
});

io.on('connection', (socket) => {
    socket.on('request-logs', (botId) => {
        if (botPool.has(botId)) {
            const botData = botPool.get(botId);
            botData.logs.forEach(log => socket.emit('bot-log', log));
            socket.emit('bot-status', { botId, status: botData.status });
            socket.emit('bot-inventory', { botId, inventory: botData.inventory });
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`[🚀] Dashboard çalışıyor: http://localhost:${PORT}`);
});
