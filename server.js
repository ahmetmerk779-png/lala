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

process.on('uncaughtException', (err) => console.error('[Kritik Hata Yakalandı]:', err.message, err.stack));
process.on('unhandledRejection', (reason) => console.error('[Söz Rejeksiyonu Yakalandı]:', reason));

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
    try {
        const verStr = (version || '1.20.1').toString().trim();
        if (mcDataCache[verStr]) return mcDataCache[verStr];
        const data = mcData(verStr);
        if (data && data.items) {
            mcDataCache[verStr] = data;
            return data;
        }
    } catch (e) {}
    try {
        if (!mcDataCache['1.20.1']) mcDataCache['1.20.1'] = mcData('1.20.1');
        return mcDataCache['1.20.1'] || null;
    } catch (e) {
        return null;
    }
}

function getItemDetails(version, itemId) {
    if (itemId === undefined || itemId === null || itemId === -1) return null;
    try {
        const data = getMcData(version);
        if (data && data.items && data.items[itemId]) {
            const item = data.items[itemId];
            const cleanName = item.displayName || item.name.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase());
            return { name: item.name, displayName: cleanName };
        }
    } catch (e) {}
    return { name: 'unknown', displayName: `ID: ${itemId}` };
}

function parseMcText(text) {
    if (!text) return '';
    try {
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
        return String(str).replace(/§[0-9a-fk-or]/gi, '').replace(/&[0-9a-fk-or]/gi, '').trim();
    } catch (e) {
        return '';
    }
}

function loadSavedData() {
    if (!fs.existsSync(DATA_FILE)) {
        defaultBotConfigs.forEach(cfg => {
            botPool.set(cfg.id, { 
                ...cfg, status: 'Offline', onlineSince: null, client: null, logs: [], inventory: {}, 
                scoreboardData: { sidebarObjective: null, objectives: {}, scores: {}, teams: {} }, 
                lastScoreboard: null, isManualStop: false, pos: { x: 0, y: 0, z: 0 }, tabList: {}, entities: {} 
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
                    scoreboardData: { sidebarObjective: null, objectives: {}, scores: {}, teams: {} }, 
                    lastScoreboard: null, isManualStop: false, pos: { x: 0, y: 0, z: 0 }, tabList: {}, entities: {} 
                });
            });
        }
    } catch (err) {}
}

function saveDataToFile() {
    try {
        const botList = Array.from(botPool.values()).map(b => ({
            id: b.id, username: b.username, host: b.host, port: b.port,
            version: b.version, autoPassword: b.autoPassword,
            autoSubServerCmd: b.autoSubServerCmd, autoSubServerDelay: b.autoSubServerDelay
        }));
        fs.writeFileSync(DATA_FILE, JSON.stringify({ globalConfig, bots: botList }, null, 2));
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
        if (botData.logs.length > 40) botData.logs.shift();
    }
    io.emit('bot-log', logEntry);
}

function safeClientWrite(client, packetName, packetData) {
    if (!client) return false;
    try {
        client.write(packetName, packetData);
        return true;
    } catch (e) {
        return false;
    }
}

function sendChat(client, message) {
    if (!client) return;
    try {
        if (typeof client.chat === 'function') {
            client.chat(message);
        }
    } catch (e) {}
}

function setupCustomPacketHandler(client, botId) {
    let isSequenceStarted = false;
    const botData = botPool.get(botId);

    function clearBotTimers() {
        if (botData.subCmdInterval) clearInterval(botData.subCmdInterval);
        if (botData.afkTimer) clearTimeout(botData.afkTimer);
        if (botData.sbUpdateTimer) clearTimeout(botData.sbUpdateTimer);
        if (botData.tabUpdateTimer) clearTimeout(botData.tabUpdateTimer);
        if (botData.mapUpdateTimer) clearTimeout(botData.mapUpdateTimer);
        if (botData.invUpdateTimer) clearTimeout(botData.invUpdateTimer);
        
        botData.subCmdInterval = null;
        botData.afkTimer = null;
        botData.sbUpdateTimer = null;
        botData.tabUpdateTimer = null;
        botData.mapUpdateTimer = null;
        botData.invUpdateTimer = null;
    }

    clearBotTimers();
    botData.currentWindowId = 0;
    botData.currentStateId = 0;
    botData.inventory = {};
    botData.tabList = {};
    botData.entities = {};
    botData.pos = { x: 0, y: 0, z: 0 };
    botData.scoreboardData = { sidebarObjective: null, objectives: {}, scores: {}, teams: {} };
    botData.lastScoreboard = null;

    function resetBotSession(reason = 'Oturum Sıfırlandı') {
        try {
            botData.tabList = {};
            botData.entities = {};
            botData.inventory = {};
            botData.scoreboardData = { sidebarObjective: null, objectives: {}, scores: {}, teams: {} };
            botData.lastScoreboard = null;
            broadcastLog(botId, `🔄 [Sıfırlama] ${reason}`, 'info');
            io.emit('bot-scoreboard', { botId, scoreboard: null });
            io.emit('bot-tablist', { botId, players: [] });
        } catch (e) {}
    }

    function queueInventoryUpdate() {
        if (botData.invUpdateTimer) return;
        botData.invUpdateTimer = setTimeout(() => {
            botData.invUpdateTimer = null;
            io.emit('bot-inventory', { botId, inventory: botData.inventory, currentWindowId: botData.currentWindowId });
        }, 300);
    }

    function queueScoreboardUpdate() {
        if (botData.sbUpdateTimer) return;
        botData.sbUpdateTimer = setTimeout(() => {
            botData.sbUpdateTimer = null;
            try { broadcastDynamicScoreboard(); } catch (e) {}
        }, 200);
    }

    function queueTabListUpdate() {
        if (botData.tabUpdateTimer) return;
        botData.tabUpdateTimer = setTimeout(() => {
            botData.tabUpdateTimer = null;
            try {
                const players = Object.values(botData.tabList);
                io.emit('bot-tablist', { botId, players });
            } catch (e) {}
        }, 300);
    }

    function queueMapUpdate() {
        if (botData.mapUpdateTimer) return;
        botData.mapUpdateTimer = setTimeout(() => {
            botData.mapUpdateTimer = null;
            try {
                const entityArray = Object.values(botData.entities);
                io.emit('bot-map-update', { botId, pos: botData.pos, entities: entityArray });
            } catch (e) {}
        }, 400);
    }

    function broadcastDynamicScoreboard() {
        const sb = botData.scoreboardData;
        const activeObjName = sb.sidebarObjective;

        // SADECE aktif sidebar (position 1) varsa çizim yap.
        if (!activeObjName || !sb.objectives[activeObjName]) {
            botData.lastScoreboard = null;
            io.emit('bot-scoreboard', { botId, scoreboard: null });
            return;
        }

        const objInfo = sb.objectives[activeObjName];
        const rawScores = sb.scores[activeObjName] || {};
        const title = objInfo ? objInfo.title : 'Scoreboard';
        const lines = [];

        Object.keys(rawScores).forEach(entryKey => {
            const scoreItem = rawScores[entryKey];
            let prefix = '';
            let suffix = '';

            // Entry bir takımla eşleşiyor mu?
            for (const team of Object.values(sb.teams)) {
                if (team.players && team.players.includes(entryKey)) {
                    prefix = team.prefix || '';
                    suffix = team.suffix || '';
                    break;
                }
            }

            let baseName = parseMcText(entryKey);
            let fullText = (prefix + baseName + suffix).trim();

            if (!fullText) fullText = parseMcText(scoreItem.realName || entryKey);

            if (fullText.length === 0 && entryKey.length > 0) {
                fullText = " "; 
            }

            if (!fullText && fullText !== " ") return;

            lines.push({ text: fullText, score: scoreItem.val });
        });

        lines.sort((a, b) => b.score - a.score);

        const cleanLines = lines.slice(0, 25);
        const scoreboardObj = { title, lines: cleanLines };

        botData.lastScoreboard = scoreboardObj;
        io.emit('bot-scoreboard', { botId, scoreboard: scoreboardObj });
    }

    client.on('packet', (data, meta) => {
        if (meta.state !== 'play') return;

        try {
            switch (meta.name) {
                case 'update_health':
                    if (data.health <= 0) {
                        safeClientWrite(client, 'client_command', { actionId: 0 });
                    }
                    break;

                case 'respawn':
                case 'login':
                case 'join_game':
                    clearBotTimers();
                    resetBotSession('Sunucu aktarımı veya yeniden doğma nedeniyle veriler sıfırlandı.');
                    break;

                case 'open_window':
                    botData.currentWindowId = data.windowId;
                    botData.inventory = {};
                    queueInventoryUpdate();
                    broadcastLog(botId, '📦 Sunucu penceresi/menüsü açıldı.', 'info');
                    
                    setTimeout(() => {
                        if (botData.client && botData.status === 'Online') {
                            const emptySlot = { present: false }; 
                            
                            safeClientWrite(botData.client, 'window_click', {
                                windowId: botData.currentWindowId,
                                stateId: botData.currentStateId,
                                slot: 12,
                                mouseButton: 1, 
                                mode: 0,
                                changedSlots: [],
                                item: emptySlot,          
                                clickedItem: emptySlot,   
                                cursorItem: emptySlot     
                            });
                            broadcastLog(botId, '🖱️ AFK menüsü 12. slota SAĞ tıklandı.', 'info');
                        }
                    }, 800);
                    break;

                case 'close_window':
                    if (data.windowId === botData.currentWindowId) botData.currentWindowId = 0;
                    break;

                case 'window_items':
                    if (data.stateId !== undefined) botData.currentStateId = data.stateId;

                    if (data.windowId === botData.currentWindowId || data.windowId === 0) {
                        const items = data.items || [];
                        const invMap = {};
                        items.forEach((item, index) => {
                            if (item && item.itemCount > 0 && item.itemId !== undefined && item.itemId !== -1) {
                                const details = getItemDetails(client.version, item.itemId);
                                invMap[index] = {
                                    slot: index, count: item.itemCount, itemId: item.itemId,
                                    name: details ? details.name : 'unknown',
                                    displayName: details ? details.displayName : `ID: ${item.itemId}`
                                };
                            }
                        });
                        botData.inventory = invMap;
                        queueInventoryUpdate();
                    }
                    break;

                case 'set_slot':
                    if (data.stateId !== undefined) botData.currentStateId = data.stateId;

                    if (data.windowId === botData.currentWindowId || data.windowId === 0) {
                        const item = data.item;
                        const slot = data.slot;
                        if (item && item.itemCount > 0 && item.itemId !== undefined && item.itemId !== -1) {
                            const details = getItemDetails(client.version, item.itemId);
                            botData.inventory[slot] = {
                                slot: slot, count: item.itemCount, itemId: item.itemId,
                                name: details ? details.name : 'unknown',
                                displayName: details ? details.displayName : `ID: ${item.itemId}`
                            };
                        } else {
                            delete botData.inventory[slot];
                        }
                        queueInventoryUpdate();
                    }
                    break;

                case 'player_info':
                case 'player_info_update': {
                    const actions = data.actions || {};
                    const playersArray = data.data || data.players || [];
                    
                    playersArray.forEach(p => {
                        const uuid = p.uuid || p.UUID;
                        if (!uuid) return;

                        if ((actions.updateListed === true && p.listed === false) || p.listed === false) {
                            delete botData.tabList[uuid];
                            return;
                        }

                        if (!botData.tabList[uuid]) botData.tabList[uuid] = { uuid, name: 'Bilinmeyen', displayName: '', ping: 0 };

                        if (p.name) botData.tabList[uuid].name = p.name;
                        if (p.player && p.player.name) botData.tabList[uuid].name = p.player.name;
                        
                        const disp = p.displayName || (p.player && p.player.displayName);
                        if (disp) botData.tabList[uuid].displayName = parseMcText(disp);

                        const lat = p.latency !== undefined ? p.latency : p.ping;
                        if (lat !== undefined) botData.tabList[uuid].ping = lat;
                    });
                    queueTabListUpdate();
                    break;
                }

                case 'player_info_remove': {
                    const uids = data.UUIDs || data.players || [data.UUID || data.uuid];
                    if (Array.isArray(uids)) {
                        uids.forEach(item => {
                            const uid = typeof item === 'object' && item !== null ? (item.uuid || item.UUID) : item;
                            if (uid) {
                                const uidStr = String(uid);
                                delete botData.tabList[uidStr];
                                Object.keys(botData.tabList).forEach(k => {
                                    if (k.includes(uidStr) || uidStr.includes(k)) delete botData.tabList[k];
                                });
                            }
                        });
                        queueTabListUpdate();
                    }
                    break;
                }

                case 'position':
                    if (data.teleportId !== undefined) {
                        safeClientWrite(client, 'teleport_confirm', { teleportId: data.teleportId });
                    }
                    safeClientWrite(client, 'position', { x: data.x, y: data.y, z: data.z, onGround: true });

                    botData.pos = { x: Math.round(data.x * 10) / 10, y: Math.round(data.y * 10) / 10, z: Math.round(data.z * 10) / 10 };
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
                                setTimeout(() => {
                                    if (botData.client) {
                                        resetBotSession(`${subCmd} komutu ile alt sunucuya geçiliyor.`);
                                        sendChat(client, subCmd);
                                        broadcastLog(botId, `🔀 ${subCmd} komutu ile sunucuya geçiliyor...`, 'info');
                                        
                                        setTimeout(() => {
                                            if (botData.client) {
                                                sendChat(client, '/afk');
                                                broadcastLog(botId, `💤 /afk komutu gönderildi.`, 'info');
                                            }
                                        }, 4000);
                                    }
                                }, 2500);
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

                case 'keep_alive':
                    safeClientWrite(client, 'keep_alive', { keepAliveId: data.keepAliveId });
                    break;

                case 'teams': {
                    const teamName = data.team;
                    const mode = data.mode;
                    
                    if (!botData.scoreboardData.teams[teamName]) {
                        botData.scoreboardData.teams[teamName] = { prefix: '', suffix: '', players: [] };
                    }
                    
                    const t = botData.scoreboardData.teams[teamName];
                    
                    if (mode === 0 || mode === 2) { 
                        if (data.prefix !== undefined) t.prefix = parseMcText(data.prefix);
                        if (data.suffix !== undefined) t.suffix = parseMcText(data.suffix);
                    }
                    
                    if (mode === 0 || mode === 3) {
                        const players = data.players || [];
                        players.forEach(p => {
                            if (!t.players.includes(p)) t.players.push(p);
                        });
                    }
                    
                    if (mode === 4) {
                        const players = data.players || [];
                        t.players = t.players.filter(p => !players.includes(p));
                    }
                    
                    if (mode === 1) {
                        delete botData.scoreboardData.teams[teamName];
                    }
                    
                    queueScoreboardUpdate();
                    break;
                }

                case 'scoreboard_objective': {
                    const name = data.name || data.objectiveName;
                    const action = data.action !== undefined ? data.action : (data.mode !== undefined ? data.mode : 0);
                    
                    if (action === 0 || action === 2 || data.displayText || data.title) {
                        const titleText = data.displayText || data.title || name;
                        botData.scoreboardData.objectives[name] = {
                            title: parseMcText(titleText),
                            type: data.type || 0,
                            position: data.position
                        };
                    } else if (action === 1) {
                        delete botData.scoreboardData.objectives[name];
                        delete botData.scoreboardData.scores[name];
                        if (botData.scoreboardData.sidebarObjective === name) {
                            botData.scoreboardData.sidebarObjective = null;
                        }
                    }
                    queueScoreboardUpdate();
                    break;
                }

                case 'display_objective':
                case 'scoreboard_display_objective': {
                    const position = data.position !== undefined ? data.position : data.slot;
                    const name = data.name || data.objectiveName;
                    
                    // Position 1: Sidebar (Sağ Menü)
                    if (position === 1) {
                        botData.scoreboardData.sidebarObjective = name;
                    } else if (botData.scoreboardData.sidebarObjective === name) {
                        botData.scoreboardData.sidebarObjective = null;
                    }
                    queueScoreboardUpdate();
                    break;
                }

                case 'scoreboard_score':
                case 'set_score': {
                    const objName = data.scoreName || data.objectiveName || data.name;
                    const scoreItemName = data.itemName || data.scoreName || data.name;
                    const action = data.action !== undefined ? data.action : (data.remove ? 1 : 0);
                    
                    if (!objName) break;

                    if (!botData.scoreboardData.scores[objName]) {
                        botData.scoreboardData.scores[objName] = {};
                    }

                    if (action === 0 || action === undefined) {
                        const val = data.value !== undefined ? data.value : (data.score !== undefined ? data.score : 0);
                        botData.scoreboardData.scores[objName][scoreItemName] = {
                            val: val,
                            customName: data.customName ? parseMcText(data.customName) : null,
                            realName: scoreItemName
                        };
                    } else if (action === 1) {
                        if (scoreItemName && botData.scoreboardData.scores[objName][scoreItemName]) {
                            delete botData.scoreboardData.scores[objName][scoreItemName];
                        }
                    }

                    queueScoreboardUpdate();
                    break;
                }
            }
        } catch (packetErr) {}
    });
}

function cleanupBot(botId, reason) {
    const botData = botPool.get(botId);
    if (!botData) return;

    if (botData.keepAliveInterval) clearInterval(botData.keepAliveInterval);
    if (botData.subCmdInterval) clearInterval(botData.subCmdInterval);
    if (botData.afkTimer) clearTimeout(botData.afkTimer);
    if (botData.sbUpdateTimer) clearTimeout(botData.sbUpdateTimer);
    if (botData.tabUpdateTimer) clearTimeout(botData.tabUpdateTimer);
    if (botData.mapUpdateTimer) clearTimeout(botData.mapUpdateTimer);
    if (botData.invUpdateTimer) clearTimeout(botData.invUpdateTimer);
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
    botData.tabList = {};
    botData.entities = {};
    botData.pos = { x: 0, y: 0, z: 0 };
    botData.inventory = {};
    botData.scoreboardData = { sidebarObjective: null, objectives: {}, scores: {}, teams: {} };
    botData.lastScoreboard = null;

    broadcastLog(botId, `🔴 ${reason}`, 'error');
    io.emit('status-update', { botId, status: 'Offline', onlineSince: null });
    io.emit('bot-scoreboard', { botId, scoreboard: null });
    io.emit('bot-tablist', { botId, players: [] });
    io.emit('bot-inventory', { botId, inventory: {}, currentWindowId: 0 });

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

    broadcastLog(botId, `${botData.username} bağlanıyor...`, 'info');
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
                        safeClientWrite(client, 'look', { yaw: currentYaw, pitch: pitch, onGround: true });
                        safeClientWrite(client, 'arm_animation', { hand: 0 });
                    } catch (e) {}
                } else {
                    clearInterval(botData.keepAliveInterval);
                    botData.keepAliveInterval = null;
                }
            }, 2000);
        });

        client.on('kick_disconnect', (packet) => cleanupBot(botId, `Atıldı: ${packet.reason || 'Bilinmiyor'}`));
        client.on('disconnect', (packet) => cleanupBot(botId, `Bağlantı Kesildi: ${packet.reason || 'Bilinmiyor'}`));
        client.on('error', (err) => cleanupBot(botId, `Bağlantı Hatası: ${err.message}`));
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
            status: 'Offline', onlineSince: null, pos: { x: 0, y: 0, z: 0 },
            client: null, logs: [], inventory: {}, scoreboardData: { sidebarObjective: null, objectives: {}, scores: {}, teams: {} }, lastScoreboard: null, tabList: {}, entities: {}, isManualStop: false
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
                    if (command.startsWith('/gir') || command.startsWith('/server')) {
                        botData.tabList = {};
                        botData.scoreboardData = { sidebarObjective: null, objectives: {}, scores: {}, teams: {} };
                        botData.lastScoreboard = null;
                        io.emit('bot-scoreboard', { botId: botData.id, scoreboard: null });
                    }
                    sendChat(botData.client, command);
                    broadcastLog(botData.id, `> ${command}`, 'command');
                }
            });
        } else {
            const botData = botPool.get(targetBotId);
            if (botData && botData.client && botData.status === 'Online') {
                if (command.startsWith('/gir') || command.startsWith('/server')) {
                    botData.tabList = {};
                    botData.scoreboardData = { sidebarObjective: null, objectives: {}, scores: {}, teams: {} };
                    botData.lastScoreboard = null;
                    io.emit('bot-scoreboard', { botId: targetBotId, scoreboard: null });
                }
                sendChat(botData.client, command);
                broadcastLog(targetBotId, `> ${command}`, 'command');
            }
        }
    });

    socket.on('window-click', ({ botId, slot, mode, button }) => {
        const botData = botPool.get(botId);
        if (!botData || !botData.client || botData.status !== 'Online') return;
        try {
            const invItem = botData.inventory[slot];
            const slotItem = invItem ? { present: true, itemId: invItem.itemId, itemCount: invItem.count } : { present: false };

            safeClientWrite(botData.client, 'window_click', {
                windowId: botData.currentWindowId,
                stateId: botData.currentStateId,
                slot: slot,
                mouseButton: button !== undefined ? button : 0,
                mode: mode !== undefined ? mode : 0,
                changedSlots: [],
                item: slotItem,          
                clickedItem: slotItem,   
                cursorItem: slotItem     
            });
        } catch (e) {}
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Panel http://localhost:${PORT} adresinde aktif.`));
