/**
 * AIDA v0.1 — Core (Service Worker)
 *
 * Тонкий оркестратор: маршрутизация команд, adapter registry, CRUD.
 * Не знает деталей ни одного борда — адаптеры полностью автономны.
 * Добавление нового борда = 1 файл адаптера + 1 строка в ADAPTERS.
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
import DatAdapter from './adapters/dat-adapter.js';
import TruckstopAdapter from './adapters/truckstop-adapter.js';
import TruckerpathAdapter from './adapters/truckerpath-adapter.js';
import AuthManager from './auth/auth-manager.js';

// ============================================================
// Adapter Registry — каждый адаптер — чёрный ящик с единым контрактом
// Добавить новый борд = 1 строка здесь + 1 файл адаптера
// ============================================================

const ADAPTERS = {
    dat: { module: DatAdapter, displayName: 'DAT', hasAuthModule: true },
    truckstop: { module: TruckstopAdapter, displayName: 'Truckstop', hasAuthModule: true },
    tp: { module: TruckerpathAdapter, displayName: 'TruckerPath', hasAuthModule: false },
};

// Регистрируем callback для realtime updates (один раз при старте)
for (const [board, cfg] of Object.entries(ADAPTERS)) {
    if (cfg.module.setRealtimeCallback) {
        cfg.module.setRealtimeCallback(handleRealtimeUpdate);
    }
}

/** Получить список активных (не disabled) адаптеров. */
async function getActiveAdapters() {
    const settings = await Storage.getSettings();
    const disabled = settings.disabledBoards || {};
    return Object.entries(ADAPTERS)
        .filter(([board]) => !disabled[board])
        .map(([board, cfg]) => ({ board, ...cfg }));
}

// ============================================================
// UI Helpers
// ============================================================

const AIDA_UI_URL = chrome.runtime.getURL('ui/app.html');
const BUILD = chrome.runtime.getManifest().version;
console.log(`%c[AIDA] build ${BUILD}`, 'color:#0f0;font-weight:bold;font-size:14px;background:#222;padding:2px 8px;border-radius:4px');

/* Дедупликация отключена — удаляла грузы с одинаковым city+date при пустом phone */

/** Cooldown (мс) после searchLoads — игнорируем harvester intercepts, чтобы не перезаписать результаты AIDA search. */
const SEARCH_COOLDOWN_MS = 10_000;
let _searchCooldownUntil = 0;

/** Проверить, открыта ли вкладка борда. */
async function isBoardTabOpen(board) {
    const patterns = {
        dat: ['https://one.dat.com/*', 'https://power.dat.com/*'],
        truckstop: ['https://*.truckstop.com/*'],
        tp: ['https://loadboard.truckerpath.com/*']
    };
    const urls = patterns[board];
    if (!urls) return false;
    try {
        const tabs = await chrome.tabs.query({ url: urls });
        return tabs.length > 0;
    } catch {
        return false;
    }
}

/** Собрать настройки для UI: user, openclaw, lastSearch, theme, boardStatus (через registry). */
async function getSettingsForUI() {
    const settings = await Storage.getSettings();
    const disabledBoards = settings.disabledBoards || {};

    // Генерируем boardStatus через Adapter Registry — каждый адаптер знает свой статус
    const boardStatus = {};
    const statusPromises = Object.entries(ADAPTERS).map(async ([board, cfg]) => {
        const adapter = cfg.module;
        let statusInfo = { connected: false, status: 'disconnected', hasToken: false, hasAuthModule: cfg.hasAuthModule };

        if (adapter.getStatus) {
            // Адаптер сам знает свой статус (DAT/TS через AuthManager, TP через template)
            statusInfo = await adapter.getStatus();
        } else if (cfg.hasAuthModule) {
            const s = await AuthManager.getStatus(board);
            statusInfo = { connected: s === 'connected', status: s, hasToken: s !== 'disconnected', hasAuthModule: true };
        }

        const tabOpen = await isBoardTabOpen(board);

        boardStatus[board] = {
            ...statusInfo,
            tabOpen,
            disabled: !!disabledBoards[board]
        };
    });

    await Promise.all(statusPromises);

    return { ...settings, boardStatus };
}

/** Отправить обновление данных во вкладку UI (push по контракту API). Payload: { loads?, bookmarks?, history?, settings? }. */
async function pushToUI(payload) {
    if (!payload || typeof payload !== 'object') return;
    try {
        const tabs = await chrome.tabs.query({ url: AIDA_UI_URL + '*' });
        for (const tab of tabs) {
            chrome.tabs.sendMessage(tab.id, { type: 'DATA_UPDATED', payload }).catch(() => { });
        }
    } catch (e) {
        console.warn('[AIDA/Core] pushToUI failed:', e.message);
    }
}

async function openAidaInTab(windowId) {
    try {
        const existing = await chrome.tabs.query({ windowId, url: AIDA_UI_URL + '*' });
        if (existing.length > 0) {
            await chrome.tabs.update(existing[0].id, { active: true });
            return;
        }
        await chrome.tabs.create({ url: AIDA_UI_URL, windowId });
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
    }
});

// При закрытии AIDA таба → очистить грузы
chrome.tabs.onRemoved.addListener(async (tabId) => {
    try {
        // Проверяем остались ли ещё открытые AIDA табы
        const aidaTabs = await chrome.tabs.query({ url: AIDA_UI_URL + '*' });
        if (aidaTabs.length === 0) {
            await Storage.setLoads([]);
            console.log('[AIDA/Core] AIDA tab closed — loads cleared');
        }
    } catch (e) {
        // Tab query может упасть если браузер закрывается
    }
});

// ============================================================
// Message Router
// ============================================================

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    const { type } = message;

    switch (type) {
        // ----- Harvesters -----

        case 'TOKEN_HARVESTED':
            // Auth module (auth-dat.js) слушает через свой onMessage listener.
            sendResponse({ ok: true });
            break;

        case 'TP_SEARCH_RESPONSE':
            TruckerpathAdapter.handleSearchResponse(message.results, message.sourceUrl)
                .then(async (merged) => {
                    if (merged) await pushToUI({ loads: merged, settings: await getSettingsForUI() });
                })
                .catch(console.error);
            sendResponse({ ok: true });
            break;

        case 'TP_SEARCH_REQUEST_CAPTURED':
            TruckerpathAdapter.handleRequestCaptured(message).catch(console.error);
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
            searchLoads(params).then(sendResponse).catch(err => {
                console.error('[AIDA/Core] searchLoads error:', err);
                sendResponse({ error: err.message });
            });
            return true;
        }

        case 'LOAD_MORE':
            loadMoreLoads().then(sendResponse).catch(err => {
                console.error('[AIDA/Core] loadMore error:', err);
                sendResponse({ error: err.message });
            });
            return true;

        case 'CLEAR_ACTIVE':
            Storage.clearActive().then(async () => {
                await pushToUI({ loads: await Storage.getLoads() });
                sendResponse({ ok: true });
            });
            return true;

        case 'SAVE_BOOKMARK':
            saveBookmark(message.loadId).then(sendResponse).catch(err => {
                sendResponse({ error: err.message });
            });
            return true;

        case 'REMOVE_BOOKMARK':
            removeBookmark(message.loadId)
                .then(() => sendResponse({ ok: true }))
                .catch(err => sendResponse({ error: err.message }));
            return true;

        case 'CALL_BROKER':
            callBroker(message.loadId).then(sendResponse).catch(err => {
                sendResponse({ error: err.message });
            });
            return true;

        case 'GET_HISTORY':
            Storage.getHistory(message.filters || {}).then(history => sendResponse({ history }));
            return true;

        case 'CLEAR_LOADS':
            Storage.setLoads([]).then(() => {
                console.log('[AIDA/Core] Loads cleared');
                sendResponse({ ok: true });
            }).catch(err => sendResponse({ error: err.message }));
            return true;

        case 'GET_SETTINGS':
            getSettingsForUI().then(settings => sendResponse({ settings }));
            return true;

        case 'SAVE_SETTINGS':
            Storage.saveSettings(message.data).then(async () => {
                await pushToUI({ settings: await getSettingsForUI() });
                sendResponse({ ok: true });
            });
            return true;

        case 'TOGGLE_AGENT':
            toggleAgentMode(message.enabled);
            sendResponse({ ok: true });
            return true;

        case 'TOGGLE_BOARD': {
            const { board } = message;
            Storage.getSettings().then(async settings => {
                const disabledBoards = settings.disabledBoards || {};
                const wasDisabled = !!disabledBoards[board];
                disabledBoards[board] = !wasDisabled; // flip
                await Storage.saveSettings({ disabledBoards });

                // При ВЫКЛЮЧЕНИИ — удаляем все грузы этого борда
                if (!wasDisabled) {
                    const loads = await Storage.getLoads();
                    const filtered = loads.filter(l => l.board !== board);
                    await Storage.setLoads(filtered);
                    console.log(`[AIDA/Core] Board ${board} disabled — removed ${loads.length - filtered.length} loads`);
                    await pushToUI({ loads: filtered, settings: await getSettingsForUI() });
                } else {
                    console.log(`[AIDA/Core] Board ${board} enabled`);
                    await pushToUI({ settings: await getSettingsForUI() });
                }
                sendResponse({ ok: true });
            }).catch(err => sendResponse({ error: err.message }));
            return true;
        }

        case 'GET_LOADS':
            Storage.getLoads().then(loads => {
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
                pushToUI({ newLoadsCount: 0 });
                try {
                    const result = await searchLoads(lastSearch);
                    sendResponse(result);
                } catch (err) {
                    sendResponse({ error: err.message });
                }
            });
            return true;

        // ----- Auth (новый блок) -----
        case 'LOGIN_BOARD': {
            const { board } = message;
            AuthManager.login(board).then(async (result) => {
                if (result.ok) {
                    await pushToUI({ settings: await getSettingsForUI() });
                }
                sendResponse(result);
            }).catch(err => sendResponse({ ok: false, error: err.message }));
            return true;
        }

        case 'DISCONNECT_BOARD': {
            AuthManager.disconnect(message.board).then(async () => {
                await pushToUI({ settings: await getSettingsForUI() });
                sendResponse({ ok: true });
            }).catch(err => sendResponse({ error: err.message }));
            return true;
        }

        case 'GET_BOARD_AUTH_STATUS': {
            AuthManager.getAllStatuses().then(statuses => {
                sendResponse({ statuses });
            });
            return true;
        }

        default:
            sendResponse({ ok: true });
    }
});

// Все harvester handlerы удалены — адаптеры полностью автономны.
// TP_SEARCH_RESPONSE / TP_SEARCH_REQUEST_CAPTURED → TruckerpathAdapter (router выше).

// ============================================================
// searchLoads — тонкий оркестратор через Adapter Registry
// ============================================================

/**
 * Параллельный поиск по всем подключённым бордам.
 * Core не знает деталей — вызывает adapter.search(params).
 */
async function searchLoads(params) {
    if (!params) throw new Error('No search params');

    const settings = await Storage.getSettings();
    const disabled = settings.disabledBoards || {};

    const boards = Object.keys(ADAPTERS);
    const skipResult = { ok: true, loads: [], meta: { skipped: true } };

    const searchPromises = boards.map(board => {
        if (disabled[board]) return Promise.resolve(skipResult);
        const adapter = ADAPTERS[board].module;
        return adapter.search(params);
    });

    const results = await Promise.allSettled(searchPromises);

    // --- 2. Собираем loads, warnings, auth errors ---
    const adapterWarnings = [];
    const authErrors = [];
    const boardLoads = {}; // { board: loads[] }

    boards.forEach((board, i) => {
        const displayName = ADAPTERS[board].displayName;
        const result = results[i];

        if (result.status === 'rejected') {
            console.warn(`[AIDA/Core] ${displayName} adapter error:`, result.reason?.message);
            adapterWarnings.push(`${displayName}: ${result.reason?.message || 'error'}`);
            boardLoads[board] = [];
            return;
        }

        const raw = result.value || {};
        if (raw?.error) {
            console.warn(`[AIDA/Core] ${displayName} adapter returned error:`, raw.error);
            adapterWarnings.push(`${displayName}: ${raw.error.message || raw.error}`);
            const authCodes = ['AUTH_REQUIRED', 'NO_CLAIMS', 'NO_TEMPLATE', 'WRONG_TEMPLATE'];
            if (authCodes.includes(raw.error.code)) {
                authErrors.push({ board, error: raw.error });
            }
        }
        boardLoads[board] = raw?.loads || (Array.isArray(raw) ? raw : []);
    });

    // --- 3. Auto-resolve auth errors → retry ---
    const activeAuthErrors = authErrors.filter(e => !disabled[e.board]);
    if (activeAuthErrors.length > 0) {
        console.log(`[AIDA/Core] Auth errors from ${activeAuthErrors.length} board(s):`, activeAuthErrors.map(e => e.board));
        const { resolved } = await AuthManager.autoResolveAuthErrors(activeAuthErrors);

        if (resolved.length > 0) {
            console.log('[AIDA/Core] Re-trying boards after auth resolve:', resolved);
            for (const board of resolved) {
                if (disabled[board]) continue;
                try {
                    const adapter = ADAPTERS[board].module;
                    const displayName = ADAPTERS[board].displayName;
                    const retryResult = await adapter.search(params);
                    boardLoads[board] = retryResult?.loads || [];
                    const idx = adapterWarnings.findIndex(w => w.startsWith(`${displayName}:`));
                    if (idx !== -1) adapterWarnings.splice(idx, 1);
                } catch (e) {
                    console.warn(`[AIDA/Core] Retry ${board} after auth failed:`, e.message);
                }
            }
            await pushToUI({ settings: await getSettingsForUI() });
        }
    }

    // --- 4. Мерж всех грузов ---
    const loads = boards.flatMap(board => {
        const arr = boardLoads[board];
        return Array.isArray(arr) ? arr : [];
    });

    await Storage.clearActive();
    await Storage.setLoads(loads);
    _searchCooldownUntil = Date.now() + SEARCH_COOLDOWN_MS;

    await Storage.saveSettings({ ...settings, lastSearch: params });
    await pushToUI({ loads: await Storage.getLoads(), lastRefreshTime: Date.now() });

    return { loads, warnings: adapterWarnings.length > 0 ? adapterWarnings : undefined };
}

// ============================================================
// loadMoreLoads — infinite scroll (пагинация через адаптер)
// ============================================================

async function loadMoreLoads() {
    // Адаптер сам управляет offset и берёт токен
    const result = await TruckstopAdapter.loadMore();

    if (!result?.ok || !Array.isArray(result.loads) || result.loads.length === 0) {
        console.log('[AIDA/Core] LOAD_MORE: no more loads');
        return { ok: true, added: 0, hasMore: false };
    }

    // Мерж: добавляем новые грузы к существующим (в конец)
    const existing = await Storage.getLoads();
    const existingIds = new Set(existing.map(l => l.id));
    const newLoads = result.loads.filter(l => !existingIds.has(l.id));

    if (newLoads.length === 0) {
        return { ok: true, added: 0, hasMore: false };
    }

    const merged = [...existing, ...newLoads]; // новые в конец
    await Storage.setLoads(merged);
    await pushToUI({ loads: merged });

    console.log(`[AIDA/Core] LOAD_MORE: +${newLoads.length} loads (total: ${merged.length})`);
    return { ok: true, added: newLoads.length, hasMore: result.hasMore };
}

// ============================================================
// handleRealtimeUpdate — вызывается адаптерами через setRealtimeCallback
// ============================================================

/**
 * Unified callback для realtime updates от адаптеров.
 * DAT: event = { type: 'newCount'|'refresh', newLoadsCount?, params? }
 * Truckstop: event = loads[] (массив новых грузов)
 */
async function handleRealtimeUpdate(board, event) {
    const displayName = ADAPTERS[board]?.displayName || board;

    // DAT-стиль: { type: 'newCount', newLoadsCount } или { type: 'refresh', params }
    if (event?.type === 'newCount') {
        await pushToUI({ newLoadsCount: event.newLoadsCount });
        return;
    }
    if (event?.type === 'refresh') {
        await pushToUI({ newLoadsCount: 0 });
        try {
            await searchLoads(event.params);
        } catch (e) {
            console.warn(`[AIDA/Core] ${displayName} realtime auto-refresh failed:`, e.message);
        }
        return;
    }

    // Truckstop-стиль: event = loads[] (массив новых грузов)
    if (Array.isArray(event) && event.length > 0) {
        const existing = await Storage.getLoads();
        const existingIds = new Set(existing.map(l => l.id));
        const newLoads = event.filter(l => !existingIds.has(l.id));

        if (newLoads.length === 0) return;

        console.log(`[AIDA/Core] ${displayName} auto-refresh: +${newLoads.length} new loads`);
        const merged = [...newLoads, ...existing]; // новые наверх
        await Storage.setLoads(merged);
        const newLoadIds = newLoads.map(l => l.id);
        await pushToUI({ loads: merged, newLoadsCount: newLoads.length, newLoadIds });
    }
}

// ============================================================
// saveBookmark
// ============================================================

async function saveBookmark(loadId) {
    const loads = await Storage.getLoads();
    const load = loads.find(l => l.id === loadId);
    if (!load) return { error: 'Load not found' };

    await Storage.updateLoadStatus(loadId, 'saved');
    await pushToUI({ loads: await Storage.getLoads(), bookmarks: await Storage.getBookmarks() });
    console.log('[AIDA/Core] Step: saveBookmark done → pushToUI(loads, bookmarks)');
    return { ok: true };
}

// ============================================================
// removeBookmark
// ============================================================

async function removeBookmark(loadId) {
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
    'https://truckstop.com/',
    'https://loadboard.truckerpath.com/'
];

function isBoardTab(url) {
    if (!url || typeof url !== 'string') return false;
    return BOARD_URL_PREFIXES.some(prefix => url.startsWith(prefix));
}

const TRUCKERPATH_LOADBOARD = 'https://loadboard.truckerpath.com/';

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
    if (changeInfo.status !== 'complete') return;
    if (!tab?.url || !tab.windowId) return;
    if (!isBoardTab(tab.url)) return;



    // Инъекция харвестера TruckerPath в MAIN world после загрузки страницы — иначе перехват не срабатывает.
    if (tab.url.startsWith(TRUCKERPATH_LOADBOARD)) {
        try {
            await chrome.scripting.executeScript({
                target: { tabId },
                files: ['harvesters/harvester-truckerpath.js'],
                world: 'MAIN'
            });
            console.log('[AIDA/Core] TruckerPath harvester injected into tab', tabId);
        } catch (e) {
            console.warn('[AIDA/Core] TruckerPath harvester injection failed:', e?.message);
        }
    }

    // Не запускаем searchLoads автоматически: грузы уже приходят от харвестера (handleDatSearchResponse).
    // Повторный поиск — только по кнопке Search во вкладке AIDA.

    // Обновляем статус бордов для UI (вкладка борда открылась)
    pushToUI({ settings: await getSettingsForUI() }).catch(() => { });
});

// При закрытии любой вкладки — проверяем, не был ли это борд, и обновляем статус
chrome.tabs.onRemoved.addListener(async () => {
    try {
        // Небольшая задержка, чтобы chrome.tabs.query вернул актуальные данные
        await new Promise(r => setTimeout(r, 300));
        await pushToUI({ settings: await getSettingsForUI() });
    } catch { }
});

// ============================================================
// Cleanup Scheduler — через chrome.alarms
// ============================================================

chrome.alarms.create('aida-cleanup', { periodInMinutes: 60 });
// Проактивный refresh JWT Truckstop — каждые 15 мин ДО истечения токена.
// Устраняет необходимость popup-логина (§18 ТЗ).
chrome.alarms.create('aida-ts-proactive-refresh', { periodInMinutes: 15 });
// Keep-alive для SSE создаётся внутри DatAdapter._startSSE() / _stopSSE()

chrome.alarms.onAlarm.addListener(alarm => {
    if (alarm.name === 'aida-cleanup') {
        Storage.pruneHistory().catch(console.warn);
    }
    // Truckstop auto-refresh → адаптер сам обрабатывает
    if (alarm.name === 'aida-ts-refresh') {
        TruckstopAdapter.handleAlarm().catch(e => console.warn('[AIDA/Core] TS auto-refresh error:', e.message));
    }
    if (alarm.name === 'aida-ts-proactive-refresh') {
        // Проактивно обновляем JWT Truckstop пока он ещё валидный
        (async () => {
            try {
                const status = await AuthManager.getStatus('truckstop');
                if (status === 'disconnected') return; // не залогинен — не нужно
                console.log('[AIDA/Core] Proactive TS token refresh...');
                const result = await AuthManager.silentRefresh('truckstop');
                if (result?.ok) {
                    console.log('[AIDA/Core] Proactive TS refresh OK');
                    await pushToUI({ settings: await getSettingsForUI() });
                } else {
                    console.log('[AIDA/Core] Proactive TS refresh skipped:', result?.reason || 'no result');
                }
            } catch (e) {
                console.warn('[AIDA/Core] Proactive TS refresh error:', e.message);
            }
        })();
    }
    // keep-alive: просто пробуждает SW; SSE fetch stream продолжит работу
});

// ============================================================
// Init — восстанавливаем состояние при старте SW
// ============================================================

async function init() {
    console.log('[AIDA/Core] Service Worker started');

    // Проактивный refresh токенов всех connected бордов при старте (§18 ТЗ)
    try {
        const boards = ['truckstop', 'dat'];
        for (const board of boards) {
            const status = await AuthManager.getStatus(board);
            if (status !== 'disconnected') {
                console.log(`[AIDA/Core] Init: refreshing token for ${board}...`);
                AuthManager.getToken(board).catch(() => { });
            }
        }
    } catch (e) {
        console.warn('[AIDA/Core] Init: token refresh error:', e.message);
    }

    const settings = await Storage.getSettings();
    if (settings.openclaw?.enabled) {
        startPolling();
    }
}

init().catch(console.error);
