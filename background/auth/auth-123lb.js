/**
 * AIDA v0.1 — Auth 123LoadBoard
 *
 * Модуль авторизации для 123LoadBoard (Cookie-based сессия).
 * Полностью автономный блок — аналог auth-truckstop.js.
 *
 * Flow (login):
 *   1. login() → popup login.123loadboard.com
 *   2. Юзер вводит email+password (или Google/FB/Apple)
 *   3. Redirect на members.123loadboard.com → cookies установлены
 *   4. Popup закрывается, resolve({ ok: true })
 *
 * Flow (silent refresh):
 *   POST /refreshToken?rnd={random} → { secondsToExpire: 1799 }
 *   Cookie TTL ~30 мин, автообновление каждые ~25 мин.
 *
 * Особенность: нет Bearer token — авторизация через HttpOnly cookies.
 * fetch() из service worker подхватывает cookies автоматически если
 * домен в host_permissions manifest.json.
 *
 * Custom headers (обязательные на каждый API запрос):
 *   123LB-Api-Version: 1.3
 *   123LB-BID: {session_id}
 *   123LB-Correlation-Id: {random}
 *   123LB-MEM-User-Version: 3.116.1
 */

const LB_AUTH_CONFIG = {
    apiBase: 'https://members.123loadboard.com/api',
    membersUrl: 'https://members.123loadboard.com',
    loginUrl: 'https://login.123loadboard.com',
    apiVersion: '1.3',
    appVersion: '3.116.1',
    refreshIntervalSec: 25 * 60,  // refresh каждые 25 мин (TTL 30 мин)
};

const STORAGE_KEYS = {
    meta: 'auth:123lb:meta',        // { issuedAt, expiresAt, source, bid }
    search: 'auth:123lb:search',    // { namedSearchId, nextToken, lastRefreshTime }
};

/** Генерация случайного ID для 123LB-BID и correlation headers. */
function generateBID() {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    let result = 'B';
    for (let i = 0; i < 12; i++) result += chars.charAt(Math.floor(Math.random() * chars.length));
    return result;
}

function generateCorrelationId() {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    let result = 'C';
    for (let i = 0; i < 6; i++) result += chars.charAt(Math.floor(Math.random() * chars.length));
    return result;
}

/** Собрать стандартные API headers для 123LB. */
async function getApiHeaders() {
    const data = await chrome.storage.local.get(STORAGE_KEYS.meta);
    const meta = data[STORAGE_KEYS.meta] || {};
    const bid = meta.bid || generateBID();

    return {
        '123LB-Api-Version': LB_AUTH_CONFIG.apiVersion,
        '123LB-BID': bid,
        '123LB-Correlation-Id': generateCorrelationId(),
        '123LB-MEM-User-Version': LB_AUTH_CONFIG.appVersion,
        'Content-Type': 'application/json',
        'Accept': 'application/json',
    };
}

const Auth123LB = {

    /**
     * Открыть popup-окно для логина в 123LoadBoard.
     * Мониторит redirect на members.123loadboard.com → resolve.
     */
    login() {
        return new Promise((resolve, reject) => {
            const loginUrl = `${LB_AUTH_CONFIG.loginUrl}/?rd=${encodeURIComponent(LB_AUTH_CONFIG.membersUrl)}`;
            console.log('[AIDA/Auth/123LB] Step: opening login popup');

            chrome.windows.create({
                url: loginUrl,
                type: 'popup',
                width: 500,
                height: 700,
                focused: true
            }, (win) => {
                if (!win) {
                    reject(new Error('Failed to create login popup'));
                    return;
                }

                const popupWindowId = win.id;
                let resolved = false;

                // Таймаут 3 минуты
                const timeout = setTimeout(() => {
                    if (!resolved) {
                        resolved = true;
                        cleanup();
                        chrome.windows.remove(popupWindowId).catch(() => { });
                        reject(new Error('Login timeout'));
                    }
                }, 180000);

                // Listener: redirect на members.123loadboard.com = успех
                const onUpdated = async (tabId, changeInfo, tab) => {
                    if (resolved) return;
                    if (!tab?.url) return;
                    if (changeInfo.status !== 'complete') return;

                    // Проверяем что это таб в нашем popup-окне
                    try {
                        const tabInfo = await chrome.tabs.get(tabId);
                        if (tabInfo.windowId !== popupWindowId) return;
                    } catch { return; }

                    if (tab.url.startsWith(LB_AUTH_CONFIG.membersUrl)) {
                        console.log('[AIDA/Auth/123LB] Step: redirect to members detected — login success');
                        resolved = true;
                        clearTimeout(timeout);

                        // Генерируем BID для этой сессии и сохраняем meta
                        const bid = generateBID();
                        const now = Date.now();
                        await chrome.storage.local.set({
                            [STORAGE_KEYS.meta]: {
                                issuedAt: now,
                                expiresAt: now + (LB_AUTH_CONFIG.refreshIntervalSec * 1000),
                                source: 'login',
                                bid,
                            }
                        });

                        cleanup();
                        setTimeout(() => {
                            chrome.windows.remove(popupWindowId).catch(() => { });
                        }, 500);

                        resolve({ ok: true });
                    }
                };

                // Если popup закрыт юзером
                const onRemoved = (windowId) => {
                    if (windowId !== popupWindowId) return;
                    if (!resolved) {
                        resolved = true;
                        clearTimeout(timeout);
                        cleanup();
                        reject(new Error('Login popup closed'));
                    }
                };

                const cleanup = () => {
                    chrome.tabs.onUpdated.removeListener(onUpdated);
                    chrome.windows.onRemoved.removeListener(onRemoved);
                };

                chrome.tabs.onUpdated.addListener(onUpdated);
                chrome.windows.onRemoved.addListener(onRemoved);
            });
        });
    },

    /**
     * Silent refresh — продлить сессию без участия юзера.
     * POST /refreshToken?rnd={random} → { secondsToExpire: 1799 }
     *
     * Возвращает: { ok: true } или { ok: false, reason }
     */
    async silentRefresh() {
        try {
            const headers = await getApiHeaders();
            const rnd = Math.random().toString(36).substring(2, 8);

            const resp = await fetch(`${LB_AUTH_CONFIG.membersUrl}/refreshToken?rnd=${rnd}`, {
                method: 'POST',
                headers,
                body: '{}',
                credentials: 'include',
            });

            if (!resp.ok) {
                console.warn(`[AIDA/Auth/123LB] silentRefresh failed: HTTP ${resp.status}`);
                if (resp.status === 401 || resp.status === 403) {
                    return { ok: false, reason: 'session_expired' };
                }
                return { ok: false, reason: `http_${resp.status}` };
            }

            const result = await resp.json();
            const ttl = result.secondsToExpire || 1799;

            // Обновляем meta
            const data = await chrome.storage.local.get(STORAGE_KEYS.meta);
            const meta = data[STORAGE_KEYS.meta] || {};
            const now = Date.now();
            meta.expiresAt = now + (ttl * 1000);
            meta.lastRefreshed = now;
            if (!meta.bid) meta.bid = generateBID();
            await chrome.storage.local.set({ [STORAGE_KEYS.meta]: meta });

            console.log(`[AIDA/Auth/123LB] silentRefresh OK: TTL ${ttl}s`);
            return { ok: true };

        } catch (e) {
            console.warn('[AIDA/Auth/123LB] silentRefresh error:', e.message);
            return { ok: false, reason: e.message };
        }
    },

    /**
     * Получить «токен» (подтверждение что сессия жива).
     * 123LB не имеет Bearer token — возвращаем { ok: true } если cookies валидны.
     *
     * Стратегия:
     * - Мета есть + не протухла → ok + fire-and-forget silentRefresh
     * - Мета протухла → блокирующий silentRefresh
     * - Меты нет → null
     */
    async getToken() {
        const data = await chrome.storage.local.get(STORAGE_KEYS.meta);
        const meta = data[STORAGE_KEYS.meta];

        if (!meta) return null;

        const now = Date.now();
        if (meta.expiresAt && now >= meta.expiresAt) {
            // Протух → блокирующий refresh
            const result = await this.silentRefresh();
            return result.ok ? 'session_active' : null;
        }

        // Живой → fire-and-forget refresh
        this.silentRefresh().catch(() => { });
        return 'session_active';
    },

    /**
     * Статус подключения.
     * Возвращает объект с единым контрактом для UI.
     */
    async getStatus() {
        const data = await chrome.storage.local.get(STORAGE_KEYS.meta);
        const meta = data[STORAGE_KEYS.meta];

        if (!meta) {
            return { connected: false, status: 'disconnected', hasToken: false, hasAuthModule: true };
        }

        const now = Date.now();
        if (meta.expiresAt && now >= meta.expiresAt) {
            return { connected: false, status: 'expired', hasToken: true, hasAuthModule: true };
        }

        return { connected: true, status: 'connected', hasToken: true, hasAuthModule: true };
    },

    /**
     * Отключить борд — удалить meta + cookies.
     */
    async disconnect() {
        await chrome.storage.local.remove([STORAGE_KEYS.meta, STORAGE_KEYS.search]);

        // Удаляем cookies для members.123loadboard.com
        try {
            const cookies = await chrome.cookies.getAll({ domain: '.123loadboard.com' });
            for (const cookie of cookies) {
                const protocol = cookie.secure ? 'https' : 'http';
                const url = `${protocol}://${cookie.domain.replace(/^\./, '')}${cookie.path}`;
                await chrome.cookies.remove({ url, name: cookie.name });
            }
            console.log(`[AIDA/Auth/123LB] Cookies cleared (${cookies.length} removed)`);
        } catch (e) {
            console.warn('[AIDA/Auth/123LB] Cookie cleanup error:', e.message);
        }
    },

    /**
     * Проактивный refresh (вызывается из chrome.alarms).
     * Обновляет сессию ДО истечения, если она вообще была.
     */
    async handleAlarmRefresh() {
        const data = await chrome.storage.local.get(STORAGE_KEYS.meta);
        const meta = data[STORAGE_KEYS.meta];
        if (!meta) return; // нет сессии — не нужен refresh

        const result = await this.silentRefresh();
        if (!result.ok) {
            console.warn('[AIDA/Auth/123LB] Proactive refresh failed:', result.reason);
        }
    },
};

export default Auth123LB;
export { LB_AUTH_CONFIG, STORAGE_KEYS, getApiHeaders, generateCorrelationId };
