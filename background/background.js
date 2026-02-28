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
// Message Router
// ============================================================

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    const { type } = message;

    switch (type) {
        // ----- Харвестеры -----
        case 'TOKEN_HARVESTED':
            handleTokenHarvested(message).catch(console.error);
            sendResponse({ ok: true });
            break;

        case 'DAT_SEARCH_RESPONSE':
            handleDatSearchResponse(message.results).catch(console.error);
            sendResponse({ ok: true });
            break;

        // ----- Core API -----
        case 'SEARCH_LOADS':
            searchLoads(message.params).then(sendResponse).catch(err => {
                console.error('[AIDA/Core] searchLoads error:', err);
                sendResponse({ error: err.message });
            });
            return true;

        case 'CLEAR_ACTIVE':
            Storage.clearActive().then(() => sendResponse({ ok: true }));
            return true;

        case 'SAVE_BOOKMARK':
            saveBookmark(message.loadId).then(sendResponse).catch(err => {
                sendResponse({ error: err.message });
            });
            return true;

        case 'REMOVE_BOOKMARK':
            Storage.removeBookmark(message.loadId).then(() => sendResponse({ ok: true }));
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
            Storage.getSettings().then(settings => sendResponse({ settings }));
            return true;

        case 'SAVE_SETTINGS':
            Storage.saveSettings(message.data).then(() => sendResponse({ ok: true }));
            return true;

        case 'TOGGLE_AGENT':
            toggleAgentMode(message.enabled);
            sendResponse({ ok: true });
            break;

        case 'GET_LOADS':
            Storage.getLoads().then(loads => sendResponse({ loads }));
            return true;

        case 'GET_BOOKMARKS':
            Storage.getBookmarks().then(bookmarks => sendResponse({ bookmarks }));
            return true;

        case 'UPDATE_LOAD_STATUS':
            Storage.updateLoadStatus(message.loadId, message.status)
                .then(() => sendResponse({ ok: true }));
            return true;

        default:
            sendResponse({ ok: true });
    }
});

// ============================================================
// Token Harvested
// ============================================================

async function handleTokenHarvested({ board, token }) {
    if (!token) return;
    const existing = await Storage.getToken(board);
    if (existing === token) return; // токен не изменился

    await Storage.setToken(board, token);
    console.log(`[AIDA/Core] Token updated: ${board}`);

    if (board === 'dat') {
        fetchDatProfile(token).catch(console.warn);
    }
}

// Результаты поиска, перехваченные со страницы one.dat.com — показываем в UI
async function handleDatSearchResponse(rawResults) {
    if (!Array.isArray(rawResults) || rawResults.length === 0) return;
    const loads = normalizeDatResults(rawResults);
    if (loads.length === 0) return;
    await Storage.clearActive();
    await Storage.setLoads(loads);
    console.log(`[AIDA/Core] Loads from page: ${loads.length}`);
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

    console.log('[AIDA/Core] DAT profile loaded:', profile?.account?.companyName);
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

    console.log('[AIDA/Core] searchLoads:', JSON.stringify(params));

    // Запускаем все адаптеры параллельно
    const [datResult, tsResult] = await Promise.allSettled([
        DatAdapter.search(params),
        TruckstopAdapter.search(params)
    ]);

    const allLoads = [
        ...(datResult.status === 'fulfilled' ? datResult.value : []),
        ...(tsResult.status === 'fulfilled' ? tsResult.value : [])
    ];

    if (datResult.status === 'rejected') {
        console.warn('[AIDA/Core] DAT adapter error:', datResult.reason);
    }
    if (tsResult.status === 'rejected') {
        console.warn('[AIDA/Core] Truckstop adapter error:', tsResult.reason);
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

    // Сохраняем в Storage
    await Storage.clearActive();
    await Storage.setLoads(loads);

    // Сохраняем параметры последнего поиска для автозапуска
    const settings = await Storage.getSettings();
    await Storage.saveSettings({ ...settings, lastSearch: params });

    console.log(`[AIDA/Core] Found ${loads.length} loads (${allLoads.length} total, ${allLoads.length - loads.length} deduped)`);
    return loads;
}

// ============================================================
// saveBookmark
// ============================================================

async function saveBookmark(loadId) {
    const loads = await Storage.getLoads();
    const load = loads.find(l => l.id === loadId);
    if (!load) return { error: 'Load not found' };

    await Storage.updateLoadStatus(loadId, 'saved');
    // addBookmark вызывается автоматически из updateLoadStatus
    return { ok: true };
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
// Auto-open SidePanel при открытии борда (one.dat.com, truckstop)
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

    try {
        await chrome.sidePanel.open({ windowId: tab.windowId });
    } catch (e) {
        console.warn('[AIDA/Core] Auto-open side panel failed:', e.message);
    }

    // Автопоиск с последними параметрами после загрузки страницы
    const settings = await Storage.getSettings();
    if (settings?.lastSearch) {
        setTimeout(() => {
            searchLoads(settings.lastSearch).catch(console.warn);
        }, 2000);
    }
});

// ============================================================
// Cleanup Scheduler — через chrome.alarms
// ============================================================

// Создаём alarm при старте SW
chrome.alarms.create('aida-cleanup', { periodInMinutes: 60 });

chrome.alarms.onAlarm.addListener(alarm => {
    if (alarm.name === 'aida-cleanup') {
        Storage.pruneHistory().catch(console.warn);
    }
});

// ============================================================
// Init — восстанавливаем состояние при старте SW
// ============================================================

async function init() {
    console.log('[AIDA/Core] Service Worker started');

    // Клик по иконке расширения открывает side panel (дублируем на случай старых Chrome)
    if (chrome.sidePanel?.setPanelBehavior) {
        try {
            await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
        } catch (e) {
            console.warn('[AIDA/Core] setPanelBehavior failed:', e.message);
        }
    }

    const settings = await Storage.getSettings();
    if (settings.openclaw?.enabled) {
        startPolling();
    }
}

init().catch(console.error);
