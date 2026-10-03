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
    
    // Gelişmiş Scoreboard Veri Yapısı (Yedekli ve Esnek)
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
        }, 300);
    }

    function queueTabListUpdate() {
        if (botData.tabUpdateTimer) return;
        botData.tabUpdateTimer = setTimeout(() => {
            botData.tabUpdateTimer = null;
            const players = Object.values(botData.tabList);
            io.emit('bot-tablist', { botId, players });
        }, 300);
    }

    function queueMapUpdate() {
        if (botData.mapUpdateTimer) return;
        botData.mapUpdateTimer = setTimeout(() => {
            botData.mapUpdateTimer = null;
            const entityArray = Object.values(botData.entities);
            io.emit('bot-map-update', { botId, pos: botData.pos, entities: entityArray });
        }, 300);
    }

    function broadcastDynamicScoreboard() {
        const sb = botData.scoreboardData;
        
        // Eğer sidebar hedefi doğrudan atanmamışsa, mevcut objectives içerisinden ilk sidebar'ı otomatik seç
        if (!sb.sidebarObjective) {
            for (const [objName, objVal] of Object.entries(sb.objectives)) {
                if (objVal.position === 1 || Object.keys(sb.objectives).length === 1) {
                    sb.sidebarObjective = objName;
                    break;
                }
            }
        }

        const activeObjName = sb.sidebarObjective || Object.keys(sb.objectives)[0];
        if (!activeObjName || !sb.objectives[activeObjName]) {
            io.emit('bot-scoreboard', { botId, scoreboard: null });
            return;
        }

        const objInfo = sb.objectives[activeObjName];
        const rawScores = sb.scores[activeObjName] || {};
        const title = objInfo ? objInfo.title : 'Scoreboard';
        const lines = [];

        Object.keys(rawScores).forEach(entryKey => {
            const scoreItem = rawScores[entryKey];
            let prefix = '', suffix = '';
            
            Object.values(sb.teams).forEach(t => {
                if (t.players && t.players.includes(entryKey)) {
                    prefix = t.prefix || '';
                    suffix = t.suffix || '';
                }
            });

            let cleanEntry = scoreItem.customName || parseMcText(entryKey);
            let fullText = (prefix + cleanEntry + suffix).trim();
            if (!fullText) fullText = cleanEntry;
            
            lines.push({ text: fullText, score: scoreItem.val });
        });

        // Skorlara göre büyükten küçüğe sırala
        lines.sort((a, b) => b.score - a.score);
        
        // Eğer hiç satır yoksa ama objective varsa bile başlığı göster
        const finalScoreboard = { title, lines };
        io.emit('bot-scoreboard', { botId, scoreboard: finalScoreboard });
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
                    broadcastLog(botId, '⚠️ /afk menüsü açılamadı, alt sunucuya tekrar komut gönderiliyor...', 'error');
                    afkFailCount = 0;
                    isSequenceStarted = false;
                    const subCmd = botData.autoSubServerCmd !== undefined ? botData.autoSubServerCmd : globalConfig.autoSubServerCmd;
                    if (subCmd) sendChat(client, subCmd);
                    botData.afkTimer = setTimeout(() => triggerAfkWithRetry(), 5000);
                } else {
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
                botData.afkTimer = setTimeout(() => triggerAfkWithRetry(), 4000);
                break;

            // --- GELİŞTİRİLMİŞ SCOREBOARD PAKET YÖNETİCİSİ ---
            case 'scoreboard_objective':
            case 'scoreboard_objective_1_20_3': {
                const name = data.name || data.objectiveName;
                const action = data.action !== undefined ? data.action : (data.mode !== undefined ? data.mode : 0);
                // action 0: create, 1: remove, 2: update
                if (action === 0 || action === 2 || data.displayText || data.title) {
                    const titleText = data.displayText || data.title || name;
                    botData.scoreboardData.objectives[name] = {
                        title: parseMcText(titleText),
                        type: data.type || 0,
                        position: data.position
                    };
                    if (action === 0 && (data.position === 1 || Object.keys(botData.scoreboardData.objectives).length === 1)) {
                        botData.scoreboardData.sidebarObjective = name;
                    }
                } else if (action === 1) {
                    delete botData.scoreboardData.objectives[name];
                    if (botData.scoreboardData.sidebarObjective === name) {
                        botData.scoreboardData.sidebarObjective = null;
                    }
                }
                queueScoreboardUpdate();
                break;
            }

            case 'scoreboard_display_objective': {
                // position 1 = sidebar (sağ menü)
                const position = data.position !== undefined ? data.position : data.slot;
                const name = data.name || data.objectiveName;
                if (position === 1 && name) {
                    botData.scoreboardData.sidebarObjective = name;
                    queueScoreboardUpdate();
                } else if (position === 1 && !name) {
                    botData.scoreboardData.sidebarObjective = null;
                    queueScoreboardUpdate();
                }
                break;
            }

            case 'scoreboard_score': {
                const objName = data.objectiveName || data.itemName || Object.keys(botData.scoreboardData.objectives)[0];
                const scoreName = data.scoreName || data.name || data.itemName;
                const action = data.action !== undefined ? data.action : (data.remove ? 1 : 0);
                
                if (!objName) break;
                if (!botData.scoreboardData.scores[objName]) {
                    botData.scoreboardData.scores[objName] = {};
                }

                if (action === 0 || action === undefined) {
                    const val = data.value !== undefined ? data.value : (data.score !== undefined ? data.score : 0);
                    botData.scoreboardData.scores[objName][scoreName] = {
                        val: val,
                        customName: data.customName ? parseMcText(data.customName) : null
                    };
                } else if (action === 1) {
                    if (scoreName && botData.scoreboardData.scores[objName][scoreName]) {
                        delete botData.scoreboardData.scores[objName][scoreName];
                    } else {
                        // Eğer özel bir isim verilmediyse tüm skorları sıfırla veya temizle
                        botData.scoreboardData.scores[objName] = {};
                    }
                }
                queueScoreboardUpdate();
                break;
            }

            case 'scoreboard_team': {
                const teamName = data.team || data.teamName;
                const action = data.action !== undefined ? data.action : 0;
                if (action === 0 || action === 2) {
                    botData.scoreboardData.teams[teamName] = {
                        prefix: parseMcText(data.prefix || data.teamPrefix || ''),
                        suffix: parseMcText(data.suffix || data.teamSuffix || ''),
                        players: data.players || []
                    };
                } else if (action === 1) {
                    delete botData.scoreboardData.teams[teamName];
                }
                queueScoreboardUpdate();
                break;
            }
            // ------------------------------------------------

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
                                } catch (e) {}
                            }
                        }, 1000);
                    }
                }
                break;

            case 'set_slot':
                if (data.windowId === 0) {
                    if (!data.item || data.item.present === false || data.item.itemId === undefined || data.item.itemId === -1) {
                        delete botData.inventory[data.slot];
                    } else {
                        const details = getItemDetails(botData.version || globalConfig.version, data.item.itemId);
                        botData.inventory[data.slot] = {
                            slot: data.slot,
                            id: data.item.itemId,
                            name: details ? details.name : 'unknown',
                            displayName: details ? details.displayName : `ID: ${data.item.itemId}`,
                            count: data.item.itemCount || 1
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
                        }
                        if (subCmd && subCmd.trim() !== '') {
                            let tryCount = 1;
                            sendChat(client, dialog => subCmd);
                            sendChat(client, subCmd);

                            botData.subCmdInterval = setInterval(() => {
                                if (botData.client && botData.status === 'Online' && tryCount < 3) {
                                    tryCount++;
                                    sendChat(client, subCmd);
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
                    let entityName = meta.name === 'named_entity_spawn' ? (data.username || `Oyuncu #${data.entityId}`) : `Varlık #${data.entityId}`;
                    botData.entities[data.entityId] = {
                        id: data.entityId,
                        name: entityName,
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

            case 'player_info_update':
            case 'player_info':
                if (Array.isArray(data.data)) {
                    data.data.forEach(p => {
                        const uuid = p.uuid;
                        if (!botData.tabList[uuid]) {
                            botData.tabList[uuid] = { uuid, name: 'Bilinmeyen', displayName: '', ping: 0 };
                        }
                        if (p.player && p.player.name) botData.tabList[uuid].name = p.player.name;
                        if (p.name) botData.tabList[uuid].name = p.name;
                        if (p.displayName) botData.tabList[uuid].displayName = parseMcText(p.displayName);
                        if (p.latency !== undefined) botData.tabList[uuid].ping = p.latency;
                    });
                    queueTabListUpdate();
                }
                break;

            case 'keep_alive':
                try { client.write('keep_alive', { keepAliveId: data.keepAliveId }); } catch (e) {}
                break;

            case 'player_chat':
            case 'system_chat':
            case 'chat':
                let text = '';
                try { text = data.plainMessage || parseMcText(data.content || data.message); } catch (e) {}
                if (text && text.trim()) {
                    broadcastLog(botId, text, 'chat');
                }
                break;
        }
    });
}
