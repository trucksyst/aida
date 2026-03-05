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
import TruckstopAdapter, { normalizeTruckstopResults } from './adapters/truckstop-adapter.js';
import TruckerpathAdapter, { normalizeTruckerpathResults } from './adapters/truckerpath-adapter.js';
import AuthManager from './auth/auth-manager.js';

// ============================================================
// Открытие UI в полноэкранной вкладке (не Side Panel)
// ============================================================

const AIDA_UI_URL = chrome.runtime.getURL('ui/app.html');
const BUILD = chrome.runtime.getManifest().version;
console.log(`%c[AIDA] build ${BUILD}`, 'color:#0f0;font-weight:bold;font-size:14px;background:#222;padding:2px 8px;border-radius:4px');

/* Дедупликация отключена — удаляла грузы с одинаковым city+date при пустом phone */

/** Cooldown (мс) после searchLoads — игнорируем harvester intercepts, чтобы не перезаписать результаты AIDA search. */
const SEARCH_COOLDOWN_MS = 10_000;
let _searchCooldownUntil = 0;

/** Мерж: заменяем только грузы конкретного борда, остальные сохраняем. */
function mergeLoadsByBoard(existing, newLoads, board) {
    const other = (existing || []).filter(l => l.board !== board);
    return [...(other || []), ...((newLoads || []))];
}

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

/** Собрать настройки для UI: user, openclaw, lastSearch, theme, boardStatus (по токенам + вкладкам). */
async function getSettingsForUI() {
    const settings = await Storage.getSettings();
    const tpConnected = !!settings?.truckerpathRequestTemplate;

    // Статусы через AuthManager (для DAT — с авто-refresh)
    const [datStatus, tsStatus] = await Promise.all([
        AuthManager.getStatus('dat'),
        AuthManager.getStatus('truckstop')
    ]);

    // Вкладки бордов — опциональная доп. информация (не обязательны для connected)
    const [datTabOpen, tsTabOpen, tpTabOpen] = await Promise.all([
        isBoardTabOpen('dat'),
        isBoardTabOpen('truckstop'),
        isBoardTabOpen('tp')
    ]);

    const disabledBoards = settings.disabledBoards || {};

    return {
        ...settings,
        boardStatus: {
            dat: {
                connected: datStatus === 'connected',
                status: datStatus,
                hasToken: datStatus !== 'disconnected',
                tabOpen: datTabOpen,
                hasAuthModule: true,
                disabled: !!disabledBoards.dat
            },
            truckstop: {
                connected: tsStatus === 'connected',
                status: tsStatus,
                hasToken: tsStatus !== 'disconnected',
                tabOpen: tsTabOpen,
                hasAuthModule: true,
                disabled: !!disabledBoards.truckstop
            },
            tp: {
                connected: tpConnected,
                status: tpConnected ? 'connected' : 'disconnected',
                hasToken: tpConnected,
                tabOpen: tpTabOpen,
                hasAuthModule: false,
                disabled: !!disabledBoards.tp
            }
        }
    };
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
        // ----- Харвестеры -----
        case 'TOKEN_HARVESTED':
            handleTokenHarvested(message).catch(console.error);
            sendResponse({ ok: true });
            break;

        case 'DAT_SEARCH_RESPONSE':
            handleDatSearchResponse(message.results, message.searchId, message.token).catch(console.error);
            sendResponse({ ok: true });
            break;

        // TS_SEARCH_RESPONSE отключён — адаптер работает автономно (built-in GraphQL).
        // Грузы с открытого сайта Truckstop больше не пропихиваются в AIDA.
        // case 'TS_SEARCH_RESPONSE':
        //     handleTruckstopSearchResponse(message.results, message.token).catch(console.error);
        //     sendResponse({ ok: true });
        //     break;

        case 'TS_SEARCH_REQUEST_CAPTURED':
            handleTruckstopRequestCaptured(message).catch(console.error);
            sendResponse({ ok: true });
            break;

        case 'TP_SEARCH_RESPONSE':
            handleTruckerpathSearchResponse(message.results, message.sourceUrl).catch(console.error);
            sendResponse({ ok: true });
            break;

        case 'TP_SEARCH_REQUEST_CAPTURED':
            handleTruckerpathRequestCaptured(message).catch(console.error);
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

// ============================================================
// Token Harvested
// ============================================================

async function handleTokenHarvested({ board, token }) {
    if (!token) return;
    const existing = await Storage.getToken(board);
    if (existing === token) return;

    // Сохраняем токен через AuthManager (с мета-данными expiry)
    // + в Storage напрямую для обратной совместимости с адаптерами
    await Storage.setToken(board, token);
    await AuthManager.handleHarvestedToken(board, token);
    await pushToUI({ settings: await getSettingsForUI() });

    if (board === 'dat') {
        fetchDatProfile(token).catch(console.warn);
    }
}

async function handleDatSearchResponse(rawResults, searchId, token) {
    if (!Array.isArray(rawResults) || rawResults.length === 0) {
        console.warn('[AIDA/Core] handleDatSearchResponse: empty or not array');
        return;
    }
    console.log(`[AIDA/Core] DAT INTERCEPT — ${rawResults.length} loads`);
    if (Date.now() < _searchCooldownUntil) {

        return;
    }
    const loads = normalizeDatResults(rawResults);
    if (loads.length === 0) {
        console.warn('[AIDA/Core] handleDatSearchResponse: no loads after normalize');
        return;
    }
    // Мерж: заменяем только DAT-грузы, сохраняя TS/TP
    const existing = await Storage.getLoads();
    const merged = mergeLoadsByBoard(existing, loads, 'dat');
    await Storage.setLoads(merged);
    await pushToUI({ loads: await Storage.getLoads() });
    const sseToken = token || await Storage.getToken('dat');
    if (searchId && sseToken) {
        const lastSearch = (await Storage.getSettings())?.lastSearch;
        startLiveQuery(searchId, sseToken, lastSearch);
    }
}

// handleTruckstopSearchResponse — отключён (адаптер автономен, built-in GraphQL)
// async function handleTruckstopSearchResponse(rawResults) { ... }

async function handleTruckerpathSearchResponse(rawResults, sourceUrl) {
    if (!Array.isArray(rawResults) || rawResults.length === 0) return;
    console.log(`[AIDA/Core] TP INTERCEPT from: ${sourceUrl || 'unknown'} — ${rawResults.length} loads`);
    if (Date.now() < _searchCooldownUntil) {

        return;
    }
    let loads;
    try {
        loads = normalizeTruckerpathResults(rawResults, {});
    } catch (e) {
        console.warn('[AIDA/Core] handleTruckerpathSearchResponse normalize error:', e?.message);
        return;
    }
    if (!loads || loads.length === 0) return;
    console.log(`[AIDA/Core] TP normalized: ${loads.length} loads`);
    const existing = await Storage.getLoads();
    const merged = mergeLoadsByBoard(existing, loads, 'tp');
    await Storage.setLoads(merged);
    await pushToUI({ loads: await Storage.getLoads(), settings: await getSettingsForUI() });
}

async function handleTruckstopRequestCaptured(msg) {
    if (!msg || !msg.url) return;
    if (msg.url.indexOf('LoadSearchCount') !== -1 || msg.url.indexOf('searchCount') !== -1) return;
    const template = {
        url: msg.url,
        method: msg.method || 'POST',
        headers: msg.headers && typeof msg.headers === 'object' ? msg.headers : {},
        body: typeof msg.body === 'string' ? msg.body : (msg.body ? JSON.stringify(msg.body) : null),
        capturedAt: new Date().toISOString()
    };
    let cookies = [];
    try {
        const tsCookies = await chrome.cookies.getAll({ domain: 'truckstop.com' });
        const mainCookies = await chrome.cookies.getAll({ domain: 'main.truckstop.com' });
        const apiCookies = await chrome.cookies.getAll({ domain: 'loadsearch-graphql-api-prod.truckstop.com' });
        cookies = [...tsCookies, ...mainCookies, ...apiCookies];
    } catch (_) { }
    template.cookies = cookies;
    await Storage.saveSettings({ truckstopRequestTemplate: template });
}

async function handleTruckerpathRequestCaptured(msg) {
    if (!msg || !msg.url) return;
    const template = {
        url: msg.url,
        method: msg.method || 'GET',
        headers: msg.headers && typeof msg.headers === 'object' ? msg.headers : {},
        body: typeof msg.body === 'string' ? msg.body : (msg.body ? JSON.stringify(msg.body) : null),
        capturedAt: new Date().toISOString()
    };
    let cookies = [];
    try {
        const a = await chrome.cookies.getAll({ domain: 'loadboard.truckerpath.com' });
        const b = await chrome.cookies.getAll({ domain: 'truckerpath.com' });
        cookies = [...a, ...b];
    } catch (_) { }
    template.cookies = cookies;
    await Storage.saveSettings({ truckerpathRequestTemplate: template });
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
}

// ============================================================
// searchLoads — главный метод
// ============================================================

/**
 * Параллельный поиск по всем подключённым бордам.
 * Дедупликация по origin.city + destination.city + pickupDate + broker.phone.
 */
async function searchLoads(params) {
    if (!params) throw new Error('No search params');

    const datToken = await Storage.getToken('dat');
    const tsToken = await Storage.getToken('truckstop');
    const settings = await Storage.getSettings();
    const tsTemplate = settings?.truckstopRequestTemplate || null;
    const tpTemplate = settings?.truckerpathRequestTemplate || null;
    const existing = await Storage.getLoads();
    const tpCached = (existing || []).filter(l => l.board === 'tp' && l.status === 'active');
    const disabled = settings.disabledBoards || {};
    // JWT claims для Truckstop built-in GraphQL
    const tsClaims = (await chrome.storage.local.get('auth:truckstop:claims'))['auth:truckstop:claims'] || null;

    // Отключённые борды и борды без настройки не участвуют в поиске.
    // DAT — всегда запускается (у него есть auth-модуль с auto-login).
    // Truckstop — только если есть токен.
    // TruckerPath — только если есть шаблон (template).
    const skipResult = { ok: true, loads: [], meta: { skipped: true } };
    const skipDat = !!disabled.dat;
    const skipTs = !!disabled.truckstop;
    const skipTp = !!disabled.tp;

    const [datResult, tsResult, tpResult] = await Promise.allSettled([
        skipDat ? Promise.resolve(skipResult) : DatAdapter.search(params),
        skipTs ? Promise.resolve(skipResult) : TruckstopAdapter.search(params, { token: tsToken, truckstopTemplate: tsTemplate, claims: tsClaims }),
        skipTp ? Promise.resolve(skipResult) : TruckerpathAdapter.search(params, { cachedLoads: tpCached, template: tpTemplate })
    ]);

    // Логируем ошибки адаптеров (не проглатываем молча)
    const adapterWarnings = [];
    const authErrors = [];    // борды с AUTH_REQUIRED для auto-resolve

    const datRaw = datResult.status === 'fulfilled' ? datResult.value : {};
    if (datResult.status === 'rejected') {
        console.warn('[AIDA/Core] DAT adapter error:', datResult.reason?.message);
        adapterWarnings.push('DAT: ' + (datResult.reason?.message || 'error'));
    } else if (datRaw?.error) {
        console.warn('[AIDA/Core] DAT adapter returned error:', datRaw.error);
        adapterWarnings.push('DAT: ' + (datRaw.error.message || datRaw.error));
        if (datRaw.error.code === 'AUTH_REQUIRED') {
            authErrors.push({ board: 'dat', error: datRaw.error });
        }
    }
    let datLoads = datRaw?.loads || (Array.isArray(datRaw) ? datRaw : []);
    const datSearchId = datRaw?.searchId || null;
    const datSseToken = datRaw?.token || null;

    const tsRaw = tsResult.status === 'fulfilled' ? tsResult.value : {};
    if (tsResult.status === 'rejected') {
        console.warn('[AIDA/Core] Truckstop adapter error:', tsResult.reason?.message);
        adapterWarnings.push('Truckstop: ' + (tsResult.reason?.message || 'error'));
    } else if (tsRaw?.error) {
        console.warn('[AIDA/Core] Truckstop adapter returned error:', tsRaw.error);
        adapterWarnings.push('Truckstop: ' + (tsRaw.error.message || tsRaw.error));
        if (tsRaw.error.code === 'AUTH_REQUIRED' || tsRaw.error.code === 'NO_TEMPLATE' || tsRaw.error.code === 'WRONG_TEMPLATE') {
            authErrors.push({ board: 'truckstop', error: tsRaw.error });
        }
    }
    let tsLoads = tsRaw?.loads || (Array.isArray(tsRaw) ? tsRaw : []);

    const tpRaw = tpResult.status === 'fulfilled' ? tpResult.value : {};
    if (tpResult.status === 'rejected') {
        console.warn('[AIDA/Core] TruckerPath adapter error:', tpResult.reason?.message);
        adapterWarnings.push('TruckerPath: ' + (tpResult.reason?.message || 'error'));
    } else if (tpRaw?.error) {
        console.warn('[AIDA/Core] TruckerPath adapter returned error:', tpRaw.error);
        adapterWarnings.push('TruckerPath: ' + (tpRaw.error.message || tpRaw.error));
        if (tpRaw.error.code === 'AUTH_REQUIRED' || tpRaw.error.code === 'NO_TEMPLATE' || tpRaw.error.code === 'WRONG_TEMPLATE') {
            authErrors.push({ board: 'tp', error: tpRaw.error });
        }
    }
    let tpLoads = tpRaw?.loads || (Array.isArray(tpRaw) ? tpRaw : []);

    // ---- AUTO-RESOLVE AUTH ERRORS ----
    // Фильтруем disabled борды — для них НЕ открываем попы, НЕ делаем запросы
    const activeAuthErrors = authErrors.filter(e => !disabled[e.board]);
    if (activeAuthErrors.length > 0) {
        console.log(`[AIDA/Core] Auth errors from ${activeAuthErrors.length} board(s):`, activeAuthErrors.map(e => e.board));
        const { resolved } = await AuthManager.autoResolveAuthErrors(activeAuthErrors);

        // Retry ТОЛЬКО борды, которые удалось авторизовать
        if (resolved.length > 0) {
            console.log('[AIDA/Core] Re-trying boards after auth resolve:', resolved);

            for (const board of resolved) {
                try {
                    if (board === 'dat' && !disabled.dat) {
                        const retryResult = await DatAdapter.search(params);
                        datLoads = retryResult?.loads || (Array.isArray(retryResult) ? retryResult : []);
                        // Убираем warning DAT из списка (успешно авторизовались)
                        const idx = adapterWarnings.findIndex(w => w.startsWith('DAT:'));
                        if (idx !== -1) adapterWarnings.splice(idx, 1);
                    }
                    if (board === 'truckstop' && !disabled.truckstop) {
                        const freshTsToken = await Storage.getToken('truckstop');
                        const freshClaims = (await chrome.storage.local.get('auth:truckstop:claims'))['auth:truckstop:claims'] || null;
                        const retryResult = await TruckstopAdapter.search(params, { token: freshTsToken, truckstopTemplate: tsTemplate, claims: freshClaims });
                        tsLoads = retryResult?.loads || [];
                        const idx = adapterWarnings.findIndex(w => w.startsWith('Truckstop:'));
                        if (idx !== -1) adapterWarnings.splice(idx, 1);
                    }
                    if (board === 'tp' && !disabled.tp) {
                        const retryResult = await TruckerpathAdapter.search(params, { cachedLoads: [], template: tpTemplate });
                        tpLoads = retryResult?.loads || [];
                        const idx = adapterWarnings.findIndex(w => w.startsWith('TruckerPath:'));
                        if (idx !== -1) adapterWarnings.splice(idx, 1);
                    }
                } catch (e) {
                    console.warn(`[AIDA/Core] Retry ${board} after auth failed:`, e.message);
                }
            }

            // Обновляем статусы UI после авторизации
            await pushToUI({ settings: await getSettingsForUI() });
        }
    }

    const allLoads = [...(Array.isArray(datLoads) ? datLoads : []), ...(Array.isArray(tsLoads) ? tsLoads : []), ...(Array.isArray(tpLoads) ? tpLoads : [])];
    const loads = allLoads;

    await Storage.clearActive();
    await Storage.setLoads(loads);
    _searchCooldownUntil = Date.now() + SEARCH_COOLDOWN_MS;

    await Storage.saveSettings({ ...settings, lastSearch: params });

    await pushToUI({ loads: await Storage.getLoads(), lastRefreshTime: Date.now() });

    // SSE-подписка на новые грузы по searchId
    if (datSearchId && datSseToken) {
        startLiveQuery(datSearchId, datSseToken, params);
    }

    // Truckstop auto-refresh: запуск alarm если TS включён
    if (!skipTs) {
        startTsAutoRefresh(params);
    } else {
        stopTsAutoRefresh();
    }

    // Возвращаем loads и warnings для UI
    return { loads, warnings: adapterWarnings.length > 0 ? adapterWarnings : undefined };
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
    // Активируем keep-alive только при активном SSE
    chrome.alarms.create('aida-keepalive', { periodInMinutes: 0.4 });
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
    // Отключаем keep-alive когда SSE не активен
    chrome.alarms.clear('aida-keepalive').catch(() => { });
}

// ============================================================
// Truckstop Auto-Refresh — polling новых грузов каждые 2 мин
// ============================================================

const TS_REFRESH_ALARM = 'aida-ts-refresh';
const TS_REFRESH_INTERVAL_MIN = 2; // каждые 2 минуты
let _tsRefreshParams = null;

function startTsAutoRefresh(searchParams) {
    _tsRefreshParams = searchParams;
    chrome.alarms.create(TS_REFRESH_ALARM, { periodInMinutes: TS_REFRESH_INTERVAL_MIN });
    console.log('[AIDA/Core] Truckstop auto-refresh started (every 2 min)');
}

function stopTsAutoRefresh() {
    _tsRefreshParams = null;
    chrome.alarms.clear(TS_REFRESH_ALARM).catch(() => { });
}

async function handleTsAutoRefresh() {
    if (!_tsRefreshParams) return;
    const settings = await Storage.getSettings();
    if (settings.disabledBoards?.truckstop) {
        stopTsAutoRefresh();
        return;
    }

    const tsToken = await Storage.getToken('truckstop');
    const claims = await chrome.storage.local.get('auth:truckstop:claims').then(r => r['auth:truckstop:claims']);
    if (!tsToken || !claims) return;

    console.log('[AIDA/Core] Truckstop auto-refresh: fetching new loads...');
    const result = await TruckstopAdapter.refreshNew(_tsRefreshParams, { token: tsToken, claims });
    if (!result?.ok || !Array.isArray(result.loads) || result.loads.length === 0) return;

    // Сравниваем по ID — добавляем только новые
    const existing = await Storage.getLoads();
    const existingIds = new Set(existing.map(l => l.id));
    const newLoads = result.loads.filter(l => !existingIds.has(l.id));

    if (newLoads.length === 0) return;

    console.log(`[AIDA/Core] Truckstop auto-refresh: +${newLoads.length} new loads`);
    const merged = [...newLoads, ...existing]; // новые наверх
    await Storage.setLoads(merged);
    await pushToUI({ loads: merged, newLoadsCount: newLoads.length });
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
// Keep-alive для SSE создаётся динамически в startLiveQuery() / stopLiveQuery()

chrome.alarms.onAlarm.addListener(alarm => {
    if (alarm.name === 'aida-cleanup') {
        Storage.pruneHistory().catch(console.warn);
    }
    if (alarm.name === TS_REFRESH_ALARM) {
        handleTsAutoRefresh().catch(e => console.warn('[AIDA/Core] TS auto-refresh error:', e.message));
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


}

init().catch(console.error);
