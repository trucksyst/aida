/**
 * AIDA v0.1 — Auth DAT
 *
 * Модуль авторизации для DAT.com через Auth0.
 * Полностью автономный блок — не модифицирует существующий код.
 *
 * Flow:
 *   1. login()  → открывает popup окно login.dat.com
 *   2. Пользователь вводит email, пароль, SMS-код
 *   3. Auth0 делает redirect → one.dat.com/callback#access_token=...
 *   4. Модуль перехватывает URL, парсит токен, сохраняет в Storage
 *   5. silentRefresh() → обновляет токен без участия пользователя
 *
 * Auth0 параметры DAT:
 *   client_id:     e9lzMXbnWNJ0D50C2haado7DiW1akwaC
 *   redirect_uri:  https://one.dat.com/callback
 *   response_type: token id_token
 *   scope:         openid profile
 */

const DAT_AUTH_CONFIG = {
    clientId: 'e9lzMXbnWNJ0D50C2haado7DiW1akwaC',
    authorizeUrl: 'https://login.dat.com/authorize',
    callbackUrl: 'https://one.dat.com/callback',
    loginUrl: 'https://one.dat.com',
    responseType: 'token id_token',
    scope: 'openid profile',
    // Токен живёт 3600 сек (1 час). Обновляем за 5 минут до истечения.
    tokenLifetimeSec: 3600,
    refreshBeforeExpirySec: 300
};

/** Storage ключи для auth:dat */
const STORAGE_KEYS = {
    token: 'token:dat',
    tokenMeta: 'auth:dat:meta'    // { issuedAt, expiresAt, source }
};

const AuthDat = {

    /**
     * Открыть popup-окно для логина в DAT.
     * Возвращает Promise, который resolve'ится когда токен получен.
     */
    login() {
        return new Promise((resolve, reject) => {
            console.log('[AIDA/Auth/DAT] Step: opening login popup');

            // Открываем one.dat.com — он сам редиректит на login.dat.com
            chrome.windows.create({
                url: DAT_AUTH_CONFIG.loginUrl,
                type: 'popup',
                width: 520,
                height: 720,
                focused: true
            }, (win) => {
                if (!win) {
                    reject(new Error('Failed to create login popup'));
                    return;
                }

                const popupWindowId = win.id;
                let resolved = false;

                // Слушаем навигацию — ловим callback с токеном
                const onUpdated = (tabId, changeInfo, tab) => {
                    if (resolved) return;
                    if (tab.windowId !== popupWindowId) return;
                    if (!changeInfo.url) return;

                    const url = changeInfo.url;

                    // Ловим callback URL с токеном в хеше
                    if (url.startsWith(DAT_AUTH_CONFIG.callbackUrl)) {
                        const token = this._extractTokenFromUrl(url);
                        if (token) {
                            resolved = true;
                            cleanup();

                            // Сохраняем токен
                            this._saveToken(token, 'login').then(() => {
                                console.log('[AIDA/Auth/DAT] Step: token obtained via login popup');
                                // Закрываем popup
                                chrome.windows.remove(popupWindowId).catch(() => { });
                                resolve({ ok: true, token });
                            });
                        }
                    }
                };

                // Если popup закрыт без логина
                const onRemoved = (windowId) => {
                    if (windowId !== popupWindowId) return;
                    if (!resolved) {
                        resolved = true;
                        cleanup();
                        reject(new Error('Login popup closed without authentication'));
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
     * Silent refresh — обновить токен без участия пользователя.
     * Использует сессию Auth0 (cookies login.dat.com) + prompt=none.
     *
     * Возвращает: { ok: true, token } или { ok: false, reason }
     */
    async silentRefresh() {
        console.log('[AIDA/Auth/DAT] Step: attempting silent refresh');

        const url = `${DAT_AUTH_CONFIG.authorizeUrl}?` + new URLSearchParams({
            client_id: DAT_AUTH_CONFIG.clientId,
            response_type: DAT_AUTH_CONFIG.responseType,
            redirect_uri: DAT_AUTH_CONFIG.callbackUrl,
            scope: DAT_AUTH_CONFIG.scope,
            prompt: 'none'
        }).toString();

        return new Promise((resolve) => {
            chrome.tabs.create({ url, active: false }, (tab) => {
                if (!tab) {
                    resolve({ ok: false, reason: 'Failed to create refresh tab' });
                    return;
                }

                const tabId = tab.id;
                let resolved = false;

                // Таймаут 15 сек
                const timeout = setTimeout(() => {
                    if (!resolved) {
                        resolved = true;
                        cleanup();
                        chrome.tabs.remove(tabId).catch(() => { });
                        console.warn('[AIDA/Auth/DAT] Silent refresh timeout');
                        resolve({ ok: false, reason: 'timeout' });
                    }
                }, 15000);

                const onUpdated = (updatedTabId, changeInfo) => {
                    if (resolved || updatedTabId !== tabId) return;
                    if (!changeInfo.url) return;

                    const navUrl = changeInfo.url;

                    // Успех: callback с токеном
                    if (navUrl.startsWith(DAT_AUTH_CONFIG.callbackUrl)) {
                        const token = this._extractTokenFromUrl(navUrl);
                        resolved = true;
                        clearTimeout(timeout);
                        cleanup();
                        chrome.tabs.remove(tabId).catch(() => { });

                        if (token) {
                            this._saveToken(token, 'silent_refresh').then(() => {
                                console.log('[AIDA/Auth/DAT] Step: token refreshed silently');
                                resolve({ ok: true, token });
                            });
                        } else {
                            console.warn('[AIDA/Auth/DAT] Silent refresh: callback without token');
                            resolve({ ok: false, reason: 'no_token_in_callback' });
                        }
                    }

                    // Неудача: Auth0 вернул страницу логина (сессия мертва)
                    if (navUrl.includes('login.dat.com/u/login')) {
                        resolved = true;
                        clearTimeout(timeout);
                        cleanup();
                        chrome.tabs.remove(tabId).catch(() => { });
                        console.log('[AIDA/Auth/DAT] Silent refresh: session expired, login required');
                        resolve({ ok: false, reason: 'session_expired' });
                    }
                };

                const onRemoved = (removedTabId) => {
                    if (removedTabId !== tabId) return;
                    if (!resolved) {
                        resolved = true;
                        clearTimeout(timeout);
                        cleanup();
                        resolve({ ok: false, reason: 'tab_closed' });
                    }
                };

                const cleanup = () => {
                    chrome.tabs.onUpdated.removeListener(onUpdated);
                    chrome.tabs.onRemoved.removeListener(onRemoved);
                };

                chrome.tabs.onUpdated.addListener(onUpdated);
                chrome.tabs.onRemoved.addListener(onRemoved);
            });
        });
    },

    /**
     * Получить актуальный токен.
     * Если токен есть и не истёк — вернуть его.
     * Если истекает скоро — попробовать silent refresh.
     * Если нет токена — вернуть null (UI покажет «Подключить»).
     */
    async getToken() {
        const data = await chrome.storage.local.get([STORAGE_KEYS.token, STORAGE_KEYS.tokenMeta]);
        const token = data[STORAGE_KEYS.token];
        const meta = data[STORAGE_KEYS.tokenMeta];

        if (!token) return null;

        // Проверяем срок действия
        if (meta?.expiresAt) {
            const now = Date.now();
            const refreshThreshold = (DAT_AUTH_CONFIG.refreshBeforeExpirySec * 1000);

            if (now >= meta.expiresAt) {
                // Токен истёк — пробуем silent refresh
                console.log('[AIDA/Auth/DAT] Token expired, attempting silent refresh');
                const result = await this.silentRefresh();
                if (result.ok) return result.token;
                return null;
            }

            if (now >= meta.expiresAt - refreshThreshold) {
                // Токен скоро истечёт — обновляем в фоне (не блокируем)
                console.log('[AIDA/Auth/DAT] Token expiring soon, refreshing in background');
                this.silentRefresh().catch(console.warn);
            }
        }

        return token;
    },

    /**
     * Статус подключения.
     */
    async getStatus() {
        const data = await chrome.storage.local.get([STORAGE_KEYS.token, STORAGE_KEYS.tokenMeta]);
        const token = data[STORAGE_KEYS.token];
        const meta = data[STORAGE_KEYS.tokenMeta];

        if (!token) return 'disconnected';

        if (meta?.expiresAt && Date.now() >= meta.expiresAt) {
            return 'expired';
        }

        return 'connected';
    },

    /**
     * Отключить борд — удалить токен.
     */
    async disconnect() {
        await chrome.storage.local.remove([STORAGE_KEYS.token, STORAGE_KEYS.tokenMeta]);
        console.log('[AIDA/Auth/DAT] Disconnected');
    },

    // ============================================================
    // Internal
    // ============================================================

    /**
     * Извлечь access_token из URL callback#access_token=...&token_type=Bearer&...
     */
    _extractTokenFromUrl(url) {
        try {
            const hashIndex = url.indexOf('#');
            if (hashIndex === -1) return null;
            const hash = url.substring(hashIndex + 1);
            const params = new URLSearchParams(hash);
            return params.get('access_token') || null;
        } catch (e) {
            console.warn('[AIDA/Auth/DAT] _extractTokenFromUrl error:', e.message);
            return null;
        }
    },

    /**
     * Сохранить токен + мета-данные в Storage.
     * Пишет в тот же ключ `token:dat`, что и харвестер — совместимость 100%.
     */
    async _saveToken(token, source) {
        const now = Date.now();
        const meta = {
            issuedAt: now,
            expiresAt: now + (DAT_AUTH_CONFIG.tokenLifetimeSec * 1000),
            source  // 'login' | 'silent_refresh' | 'harvester'
        };
        await chrome.storage.local.set({
            [STORAGE_KEYS.token]: token,
            [STORAGE_KEYS.tokenMeta]: meta
        });
    }
};

export default AuthDat;
export { DAT_AUTH_CONFIG, STORAGE_KEYS };
