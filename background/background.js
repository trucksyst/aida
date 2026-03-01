/**
 * AIDA v0.1 — Core (Service Worker)
 *
 * Центральная точка расширения. Маршрутизирует команды от UI и харвестеров,
 * агрегирует данные с бордов, управляет бизнес-логикой.
 *
 * Публичный API (через chrome.runtime.sendMessage):
 *   SEARCH_LOADS     { params }           → loads[]
 *   CLEAR_ACTIVE     {}                   → { ok }
 *   SAVE_BOOKMARK    { loadId }           → { ok }
 *   REMOVE_BOOKMARK  { loadId }           → { ok }
 *   CALL_BROKER      { loadId }           → { ok, action, callId? }
 *   GET_HISTORY      { filters? }         → { history[] }
 *   GET_SETTINGS     {}                   → { settings }
 *   SAVE_SETTINGS    { data }             → { ok }
 *   TOGGLE_AGENT     { enabled }          → { ok }
 *   GET_LOADS        {}                   → { loads[] }
 *   GET_BOOKMARKS    {}                   → { bookmarks[] }
 *   UPDATE_LOAD_STATUS { loadId, status } → { ok }
 */

import Storage from './storage.js';
import Retell from './retell.js';
import DatAdapter, { normalizeDatResults } from './adapters/dat-adapter.js';
import TruckstopAdapter from './adapters/truckstop-adapter.js';

// ============================================================
// Открытие UI в полноэкранной вкладке (не Side Panel)
// ============================================================

const AIDA_UI_URL = chrome.runtime.getURL('ui/sidepanel.html');

/** Собрать настройки для UI: user, openclaw, lastSearch, theme, boardStatus (по токенам). */
async function getSettingsForUI() {
    const settings = await Storage.getSettings();
    const datToken = await Storage.getToken('dat');
    const tsToken = await Storage.getToken('truckstop');
    return {
        ...settings,
        boardStatus: { dat: !!datToken, truckstop: !!tsToken }
    };
}

/** Отправить обновление данных во вкладку UI (push по контракту API). Payload: { loads?, bookmarks?, history?, settings? }. */
async function pushToUI(payload) {
    if (!payload || typeof payload !== 'object') return;
    try {
        const tabs = await chrome.tabs.query({ url: AIDA_UI_URL + '*' });
        for (const tab of tabs) {
            chrome.tabs.sendMessage(tab.id, { type: 'DATA_UPDATED', payload }).catch(() => {});
        }
        const keys = Object.keys(payload).filter(k => payload[k] !== undefined);
        if (keys.length) console.log('[AIDA/Core] Step: pushToUI →', keys.join(', '), 'tabs:', tabs.length);
    } catch (e) {
        console.warn('[AIDA/Core] pushToUI failed:', e.message);
    }
}

async function openAidaInTab(windowId) {
    console.log('[AIDA/Core] Step: openAidaInTab', windowId);
    try {
        const existing = await chrome.tabs.query({ windowId, url: AIDA_UI_URL + '*' });
        if (existing.length > 0) {
            await chrome.tabs.update(existing[0].id, { active: true });
            console.log('[AIDA/Core] Step: AIDA tab focused');
            return;
        }
        await chrome.tabs.create({ url: AIDA_UI_URL, windowId });
        console.log('[AIDA/Core] Step: AIDA tab created');
    } catch (e) {
        console.warn('[AIDA/Core] openAidaInTab failed:', e.message);
    }
}

chrome.action.onClicked.addListener(async (tab) => {
    let windowId = tab && tab.windowId;
    if (!windowId) {
        try {
            const win = await chrome.windows.getCurrent();
            windowId = win && win.id;
        } catch (e) {
            console.warn('[AIDA/Core] getCurrent window failed:', e.message);
        }
    }
    if (windowId) {
        await openAidaInTab(windowId);
    } else {
        await chrome.tabs.create({ url: AIDA_UI_URL });
        console.log('[AIDA/Core] Step: AIDA tab created (no windowId)');
    }
});

// ============================================================
// Message Router
// ============================================================

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    const { type } = message;
    console.log('[AIDA/Core] Step: message received', type);

    switch (type) {
        // ----- Харвестеры -----
        case 'TOKEN_HARVESTED':
            handleTokenHarvested(message).catch(console.error);
            sendResponse({ ok: true });
            break;

        case 'DAT_SEARCH_RESPONSE':
            console.log('[AIDA/Core] Step: DAT_SEARCH_RESPONSE → handleDatSearchResponse');
            handleDatSearchResponse(message.results, message.searchId, message.token).catch(console.error);
            sendResponse({ ok: true });
            break;

        // ----- Core API -----
        case 'SEARCH_LOADS': {
            const params = message.params;
            if (!params || (typeof params !== 'object')) {
                console.warn('[AIDA/Core] Step: SEARCH_LOADS — params missing or invalid');
                sendResponse({ error: 'Search params missing' });
                return true;
            }
            if (!params.origin?.city && !params.origin?.state) {
                console.warn('[AIDA/Core] Step: SEARCH_LOADS — origin city or state required');
                sendResponse({ error: 'Enter origin city or state' });
                return true;
            }
            console.log('[AIDA/Core] Step: SEARCH_LOADS params', JSON.stringify({
                origin: params.origin,
                destination: params.destination,
                radius: params.radius,
                equipment: params.equipment,
                dateFrom: params.dateFrom,
                dateTo: params.dateTo
            }));
            searchLoads(params).then(sendResponse).catch(err => {
                console.error('[AIDA/Core] searchLoads error:', err);
                sendResponse({ error: err.message });
            });
            return true;
        }

        case 'CLEAR_ACTIVE':
            Storage.clearActive().then(async () => {
                await pushToUI({ loads: await Storage.getLoads() });
                console.log('[AIDA/Core] Step: CLEAR_ACTIVE done → pushToUI(loads)');
                sendResponse({ ok: true });
            });
            return true;

        case 'SAVE_BOOKMARK':
            saveBookmark(message.loadId).then(sendResponse).catch(err => {
                sendResponse({ error: err.message });
            });
            return true;

        case 'REMOVE_BOOKMARK':
            removeBookmark(message.loadId).then(() => sendResponse({ ok: true }));
            return true;

        case 'CALL_BROKER':
            callBroker(message.loadId).then(sendResponse).catch(err => {
                sendResponse({ error: err.message });
            });
            return true;

        case 'GET_HISTORY':
            Storage.getHistory(message.filters || {}).then(history => sendResponse({ history }));
            return true;

        case 'GET_SETTINGS':
            getSettingsForUI().then(settings => {
                console.log('[AIDA/Core] Step: GET_SETTINGS → ok (boardStatus, theme в ответе)');
                sendResponse({ settings });
            });
            return true;

        case 'SAVE_SETTINGS':
            Storage.saveSettings(message.data).then(async () => {
                console.log('[AIDA/Core] Step: SAVE_SETTINGS → ok');
                await pushToUI({ settings: await getSettingsForUI() });
                sendResponse({ ok: true });
            });
            return true;

        case 'TOGGLE_AGENT':
            toggleAgentMode(message.enabled);
            sendResponse({ ok: true });
            break;

        case 'GET_LOADS':
            Storage.getLoads().then(loads => {
                console.log('[AIDA/Core] Step: GET_LOADS → returning', loads?.length ?? 0, 'loads');
                sendResponse({ loads });
            });
            return true;

        case 'GET_BOOKMARKS':
            Storage.getBookmarks().then(bookmarks => sendResponse({ bookmarks }));
            return true;

        case 'UPDATE_LOAD_STATUS':
            Storage.updateLoadStatus(message.loadId, message.status)
                .then(async () => {
                    await pushToUI({ loads: await Storage.getLoads(), bookmarks: await Storage.getBookmarks() });
                    console.log('[AIDA/Core] Step: UPDATE_LOAD_STATUS done → pushToUI');
                    sendResponse({ ok: true });
                });
            return true;

        case 'REFRESH_LOADS':
            Storage.getSettings().then(async (settings) => {
                const lastSearch = settings?.lastSearch;
                if (!lastSearch) {
                    sendResponse({ error: 'No previous search to refresh' });
                    return;
                }
                console.log('[AIDA/Core] Step: REFRESH_LOADS — re-running last search');
                _liveQueryNewCount = 0;
                pushToUI({ newLoadsCount: 0 });
                try {
                    const result = await searchLoads(lastSearch);
                    sendResponse(result);
                } catch (err) {
                    sendResponse({ error: err.message });
                }
            });
            return true;

        default:
            sendResponse({ ok: true });
    }
});

// ============================================================
// Token Harvested
// ============================================================

async function handleTokenHarvested({ board, token }) {
    console.log('[AIDA/Core] Step: handleTokenHarvested', board, token ? 'token length ' + token.length : 'no token');
    if (!token) return;
    const existing = await Storage.getToken(board);
    if (existing === token) {
        console.log('[AIDA/Core] Step: token unchanged, skip');
        return;
    }
    await Storage.setToken(board, token);
    console.log('[AIDA/Core] Step: Token saved to storage:', board);
    await pushToUI({ settings: await getSettingsForUI() });

    if (board === 'dat') {
        fetchDatProfile(token).catch(console.warn);
    }
}

async function handleDatSearchResponse(rawResults, searchId, token) {
    console.log('[AIDA/Core] Step: handleDatSearchResponse received', Array.isArray(rawResults) ? rawResults.length : 0, 'raw, searchId:', searchId ? 'yes' : 'no');
    if (!Array.isArray(rawResults) || rawResults.length === 0) {
        console.warn('[AIDA/Core] Step: handleDatSearchResponse abort — empty or not array', typeof rawResults);
        return;
    }
    const loads = normalizeDatResults(rawResults);
    console.log('[AIDA/Core] Step: normalized →', loads.length, 'loads');
    if (loads.length === 0) {
        console.warn('[AIDA/Core] Step: no loads after normalize. Sample raw keys:', Object.keys(rawResults[0] || {}).join(', '));
        return;
    }
    await Storage.clearActive();
    await Storage.setLoads(loads);
    await pushToUI({ loads: await Storage.getLoads() });
    console.log('[AIDA/Core] Step: handleDatSearchResponse done → pushToUI(loads)');

    // SSE-подписка по searchId из перехваченного ответа
    const sseToken = token || await Storage.getToken('dat');
    if (searchId && sseToken) {
        const lastSearch = (await Storage.getSettings())?.lastSearch;
        startLiveQuery(searchId, sseToken, lastSearch);
    }
}

// ============================================================
// DAT Profile (автозагрузка при получении токена)
// ============================================================

async function fetchDatProfile(token) {
    const resp = await fetch('https://identity.api.dat.com/account/v1/users', {
        headers: { 'Authorization': `Bearer ${token}` }
    });

    if (!resp.ok) return;

    const profile = await resp.json();
    const settings = await Storage.getSettings();
    await Storage.saveSettings({
        ...settings,
        user: {
            ...settings.user,
            companyName: profile?.account?.companyName,
            firstName: profile?.firstName,
            lastName: profile?.lastName,
            email: profile?.email
        }
    });
    await pushToUI({ settings: await getSettingsForUI() });
    console.log('[AIDA/Core] Step: DAT profile loaded → pushToUI(settings)', profile?.account?.companyName);
}

// ============================================================
// searchLoads — главный метод
// ============================================================

/**
 * Параллельный поиск по всем подключённым бордам.
 * Дедупликация по origin.zip + destination.zip + pickupDate + broker.phone.
 */
async function searchLoads(params) {
    if (!params) throw new Error('No search params');

    const datToken = await Storage.getToken('dat');
    const tsToken = await Storage.getToken('truckstop');
    console.log('[AIDA/Core] Step: searchLoads — tokens DAT=' + (datToken ? 'yes' : 'NO') + ', Truckstop=' + (tsToken ? 'yes' : 'NO'));

    if (!datToken && !tsToken) {
        console.warn('[AIDA/Core] Step: searchLoads — no tokens. Open one.dat.com (or truckstop.com), sign in, run a search there so AIDA can capture the token.');
    }

    console.log('[AIDA/Core] Step: calling adapters (DAT, Truckstop)');
    const [datResult, tsResult] = await Promise.allSettled([
        DatAdapter.search(params),
        TruckstopAdapter.search(params)
    ]);

    // DAT adapter теперь возвращает { loads, searchId, token }
    const datRaw = datResult.status === 'fulfilled' ? datResult.value : {};
    const datLoads = datRaw?.loads || (Array.isArray(datRaw) ? datRaw : []);
    const datSearchId = datRaw?.searchId || null;
    const datSseToken = datRaw?.token || null;
    const tsLoads = tsResult.status === 'fulfilled' ? tsResult.value : [];
    const allLoads = [...(Array.isArray(datLoads) ? datLoads : []), ...(Array.isArray(tsLoads) ? tsLoads : [])];

    console.log('[AIDA/Core] Step: adapters returned DAT=' + datLoads.length + ', Truckstop=' + (Array.isArray(tsLoads) ? tsLoads.length : 0) + ', total=' + allLoads.length);

    if (datResult.status === 'rejected') {
        console.warn('[AIDA/Core] DAT adapter error:', datResult.reason);
    }
    if (tsResult.status === 'rejected') {
        console.warn('[AIDA/Core] Truckstop adapter error:', tsResult.reason);
    }
    if (allLoads.length === 0) {
        console.warn('[AIDA/Core] Step: 0 loads. If no token — open one.dat.com, sign in, run search there once; then try Search here again.');
    }

    // Дедупликация
    const seen = new Set();
    const loads = allLoads.filter(l => {
        const key = [
            l.origin?.zip || l.origin?.city,
            l.destination?.zip || l.destination?.city,
            l.pickupDate,
            l.broker?.phone
        ].join('|');
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    });

    console.log('[AIDA/Core] Step: clearActive + setLoads(' + loads.length + ')');
    await Storage.clearActive();
    await Storage.setLoads(loads);

    const settings = await Storage.getSettings();
    await Storage.saveSettings({ ...settings, lastSearch: params });

    await pushToUI({ loads: await Storage.getLoads(), lastRefreshTime: Date.now() });
    console.log('[AIDA/Core] Step: searchLoads done → pushToUI(loads), total', loads.length);

    // SSE-подписка на новые грузы по searchId
    if (datSearchId && datSseToken) {
        startLiveQuery(datSearchId, datSseToken, params);
    }

    return loads;
}

// ============================================================
// SSE Live Query — подписка на новые грузы
// ============================================================

let _liveQuerySub = null;
let _liveQueryNewCount = 0;
let _liveQueryRefreshTimer = null;
let _liveQueryPushTimer = null;
let _liveQueryParams = null;
const LIVE_QUERY_REFRESH_DELAY = 30_000;
const LIVE_QUERY_PUSH_DELAY = 3_000; // 3 сек — копим пачку перед отправкой в UI

function startLiveQuery(searchId, token, searchParams) {
    stopLiveQuery();
    _liveQueryNewCount = 0;
    _liveQueryParams = searchParams;

    console.log('[AIDA/Core] Step: starting SSE liveQuery for searchId:', searchId);

    _liveQuerySub = DatAdapter.subscribeLiveQuery(searchId, token, (eventType, data) => {
        console.log('[AIDA/Core] SSE event:', eventType);

        if (eventType.includes('CREATED')) {
            _liveQueryNewCount++;
            // Копим пачку событий 3 сек, потом пушим итого
            if (!_liveQueryPushTimer) {
                _liveQueryPushTimer = setTimeout(() => {
                    _liveQueryPushTimer = null;
                    pushToUI({ newLoadsCount: _liveQueryNewCount });
                }, LIVE_QUERY_PUSH_DELAY);
            }
            scheduleLiveRefresh();
        } else if (eventType.includes('DELETED') || eventType.includes('UPDATED')) {
            scheduleLiveRefresh();
        } else if (eventType === 'SEARCH_MAX') {
            console.log('[AIDA/Core] SSE: SEARCH_MAX — search limit reached');
        }
    });
}

function scheduleLiveRefresh() {
    if (_liveQueryRefreshTimer) clearTimeout(_liveQueryRefreshTimer);
    _liveQueryRefreshTimer = setTimeout(async () => {
        _liveQueryRefreshTimer = null;
        if (!_liveQueryParams || _liveQueryNewCount === 0) return;
        console.log('[AIDA/Core] SSE: auto-refreshing after', _liveQueryNewCount, 'new events');
        _liveQueryNewCount = 0;
        if (_liveQueryPushTimer) { clearTimeout(_liveQueryPushTimer); _liveQueryPushTimer = null; }
        pushToUI({ newLoadsCount: 0 });
        try {
            await searchLoads(_liveQueryParams);
        } catch (e) {
            console.warn('[AIDA/Core] SSE auto-refresh failed:', e.message);
        }
    }, LIVE_QUERY_REFRESH_DELAY);
}

function stopLiveQuery() {
    if (_liveQuerySub) {
        _liveQuerySub.stop();
        _liveQuerySub = null;
    }
    if (_liveQueryRefreshTimer) {
        clearTimeout(_liveQueryRefreshTimer);
        _liveQueryRefreshTimer = null;
    }
    if (_liveQueryPushTimer) {
        clearTimeout(_liveQueryPushTimer);
        _liveQueryPushTimer = null;
    }
    _liveQueryNewCount = 0;
    _liveQueryParams = null;
}

// ============================================================
// saveBookmark
// ============================================================

async function saveBookmark(loadId) {
    const loads = await Storage.getLoads();
    const load = loads.find(l => l.id === loadId);
    if (!load) return { error: 'Load not found' };

    // Синхронизация с бордом DAT (My Loads — SAVED)
    if (load.board === 'dat') {
        try {
            if (load.worklistItemId) {
                await DatAdapter.updateWorklistStatus(load.worklistItemId, 'SAVED');
            } else {
                const result = await DatAdapter.addToWorklist(load, 'SAVED');
                if (result?.worklistItemId) {
                    await Storage.setLoadWorklistId(loadId, result.worklistItemId);
                }
            }
        } catch (e) {
            console.warn('[AIDA/Core] DAT worklist SAVED sync failed:', e.message);
        }
    }

    await Storage.updateLoadStatus(loadId, 'saved');
    await pushToUI({ loads: await Storage.getLoads(), bookmarks: await Storage.getBookmarks() });
    console.log('[AIDA/Core] Step: saveBookmark done → pushToUI(loads, bookmarks)');
    return { ok: true };
}

// ============================================================
// removeBookmark (снять с закладки + при необходимости с My Loads на DAT)
// ============================================================

async function removeBookmark(loadId) {
    const bookmarks = await Storage.getBookmarks();
    const load = bookmarks.find(b => b.id === loadId);
    if (load?.board === 'dat' && load.worklistItemId) {
        try {
            await DatAdapter.removeFromWorklist(load.worklistItemId);
        } catch (e) {
            console.warn('[AIDA/Core] DAT worklist remove failed:', e.message);
        }
    }
    await Storage.removeBookmark(loadId);
    await pushToUI({ loads: await Storage.getLoads(), bookmarks: await Storage.getBookmarks() });
    console.log('[AIDA/Core] Step: removeBookmark done → pushToUI(loads, bookmarks)');
}

// ============================================================
// callBroker
// ============================================================

async function callBroker(loadId) {
    const loads = await Storage.getLoads();

    // Ищем сначала в активных, потом в закладках
    let load = loads.find(l => l.id === loadId);
    if (!load) {
        const bookmarks = await Storage.getBookmarks();
        load = bookmarks.find(b => b.id === loadId);
    }

    if (!load) return { error: 'Load not found' };

    const settings = await Storage.getSettings();
    const dispatcher = settings.user || {};

    if (load.broker?.phone) {
        // Синхронизация с бордом DAT (My Loads — CALLED): только если ещё не в worklist
        if (load.board === 'dat' && !load.worklistItemId) {
            try {
                const wlResult = await DatAdapter.addToWorklist(load, 'CALLED');
                if (wlResult?.worklistItemId) {
                    await Storage.setLoadWorklistId(loadId, wlResult.worklistItemId);
                }
            } catch (e) {
                console.warn('[AIDA/Core] DAT worklist CALLED sync failed:', e.message);
            }
        }

        // Есть телефон → звоним через Retell
        await Storage.updateLoadStatus(loadId, 'calling');

        const result = await Retell.initiateCall(load.broker.phone, load);

        await Storage.addHistoryEntry({
            loadId,
            board: load.board,
            broker: load.broker,
            phone: load.broker.phone,
            callTime: new Date().toISOString(),
            status: 'calling',
            retellCallId: result.callId || null,
            route: `${load.origin?.city}, ${load.origin?.state} → ${load.destination?.city}, ${load.destination?.state}`,
            rate: load.rate,
            miles: load.miles
        });
        await pushToUI({ loads: await Storage.getLoads(), history: await Storage.getHistory({}) });
        console.log('[AIDA/Core] Step: callBroker (call) done → pushToUI(loads, history)');
        return { ok: result.ok, action: 'call', callId: result.callId, error: result.error };

    } else if (load.broker?.email) {
        // Нет телефона → генерируем email
        const email = Retell.generateEmail(load, dispatcher);
        await Storage.updateLoadStatus(loadId, 'emailed');

        await Storage.addHistoryEntry({
            loadId,
            board: load.board,
            broker: load.broker,
            email: load.broker.email,
            emailTime: new Date().toISOString(),
            status: 'emailed',
            route: `${load.origin?.city}, ${load.origin?.state} → ${load.destination?.city}, ${load.destination?.state}`,
            rate: load.rate,
            miles: load.miles
        });
        await pushToUI({ loads: await Storage.getLoads(), history: await Storage.getHistory({}) });
        console.log('[AIDA/Core] Step: callBroker (email) done → pushToUI(loads, history)');
        return { ok: true, action: 'email', email };
    }

    return { error: 'No contact info for broker' };
}

// ============================================================
// OpenClaw Polling
// ============================================================

let _pollingTimer = null;

function toggleAgentMode(enabled) {
    if (enabled) {
        startPolling();
    } else {
        stopPolling();
    }
}

async function startPolling() {
    stopPolling();
    const settings = await Storage.getSettings();
    const interval = settings.openclaw?.interval || 5000;

    console.log(`[AIDA/Core] OpenClaw polling started (${interval}ms)`);
    _pollingTimer = setInterval(fetchTask, interval);

    // Первый запрос сразу
    fetchTask();
}

function stopPolling() {
    if (_pollingTimer) {
        clearInterval(_pollingTimer);
        _pollingTimer = null;
        console.log('[AIDA/Core] OpenClaw polling stopped');
    }
}

async function fetchTask() {
    const settings = await Storage.getSettings();
    const { url, api_key, enabled } = settings.openclaw || {};
    if (!enabled || !url) return;

    try {
        const headers = { 'Content-Type': 'application/json' };
        if (api_key) headers['Authorization'] = `Bearer ${api_key}`;

        const resp = await fetch(`${url}/task`, {
            method: 'GET',
            headers,
            signal: AbortSignal.timeout(4000)
        });

        if (!resp.ok) return;

        const task = await resp.json();

        if (task.task === 'search' && task.params) {
            console.log('[AIDA/Core] OpenClaw task received:', task.task);
            const loads = await searchLoads(task.params);
            await pushResults(loads, task.taskId || null);
        }
        // task.task === 'idle' → просто ждём следующего poll

    } catch (e) {
        // Timeout или сервер недоступен — нормально, попробуем в следующий раз
    }
}

async function pushResults(loads, taskId) {
    const settings = await Storage.getSettings();
    const { url, api_key } = settings.openclaw || {};
    if (!url) return;

    try {
        const headers = { 'Content-Type': 'application/json' };
        if (api_key) headers['Authorization'] = `Bearer ${api_key}`;

        await fetch(`${url}/results`, {
            method: 'POST',
            headers,
            body: JSON.stringify({
                taskId: taskId || null,
                timestamp: new Date().toISOString(),
                loads
            }),
            signal: AbortSignal.timeout(10000)
        });
    } catch (e) {
        // Если не получилось отправить — игнорируем
    }
}

// ============================================================
// Автооткрытие вкладки Aida при открытии борда (one.dat.com, truckstop)
// ============================================================

const BOARD_URL_PREFIXES = [
    'https://one.dat.com/',
    'https://www.truckstop.com/',
    'https://truckstop.com/'
];

function isBoardTab(url) {
    if (!url || typeof url !== 'string') return false;
    return BOARD_URL_PREFIXES.some(prefix => url.startsWith(prefix));
}

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
    if (changeInfo.status !== 'complete') return;
    if (!tab?.url || !tab.windowId) return;
    if (!isBoardTab(tab.url)) return;

    await openAidaInTab(tab.windowId);

    // Не запускаем searchLoads автоматически: грузы уже приходят от харвестера (handleDatSearchResponse).
    // Автопоиск через адаптеры часто возвращал 0 и перезаписывал грузы пустым массивом — они исчезали.
    // Повторный поиск — только по кнопке Search во вкладке AIDA.
});

// ============================================================
// Cleanup Scheduler — через chrome.alarms
// ============================================================

chrome.alarms.create('aida-cleanup', { periodInMinutes: 60 });
// Keep-alive для SSE: SW пробуждается каждые 25 сек, пока SSE активен
chrome.alarms.create('aida-keepalive', { periodInMinutes: 0.4 });

chrome.alarms.onAlarm.addListener(alarm => {
    if (alarm.name === 'aida-cleanup') {
        Storage.pruneHistory().catch(console.warn);
    }
    // keep-alive: просто пробуждает SW; SSE fetch stream продолжит работу
});

// ============================================================
// Init — восстанавливаем состояние при старте SW
// ============================================================

async function init() {
    console.log('[AIDA/Core] Service Worker started');

    const settings = await Storage.getSettings();
    if (settings.openclaw?.enabled) {
        startPolling();
    }

    // При перезагрузке расширения — сразу открыть вкладку AIDA в текущем окне
    try {
        const win = await chrome.windows.getCurrent();
        if (win && win.id) {
            await openAidaInTab(win.id);
            console.log('[AIDA/Core] Auto-opened AIDA tab on extension load');
        }
    } catch (e) {
        console.warn('[AIDA/Core] Auto-open on load failed:', e.message);
    }
}

init().catch(console.error);
