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
    scope: 'openid profile email',
    audience: 'https://prod-api.dat.com',
    // Реальный lifetime = 1800 сек (30 мин), подтверждено из HAR
    tokenLifetimeSec: 1800,
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
     * Popup открывает one.dat.com/search-loads.
     * Auth0 silent auth через cookies даёт токен автоматически.
     * Если сессия usurped — DAT покажет модал "LOG IN ANYWAY".
     * Юзер кликает → сессия активируется → popup закрывается.
     *
     * Popup НЕ закрывается при получении callback токена —
     * ждёт пока страница search-loads загрузится (= usurp resolved).
     */
    login() {
        return new Promise((resolve, reject) => {
            console.log('[AIDA/Auth/DAT] Step: opening login popup (one.dat.com/search-loads)');

            chrome.windows.create({
                url: 'https://one.dat.com/search-loads',
                type: 'popup',
                width: 1100,
                height: 750,
                focused: true
            }, (win) => {
                if (!win) {
                    reject(new Error('Failed to create login popup'));
                    return;
                }

                const popupWindowId = win.id;
                let resolved = false;
                let tokenCaptured = null;

                // Таймаут 2 минуты
                const timeout = setTimeout(() => {
                    if (!resolved) {
                        resolved = true;
                        cleanup();
                        chrome.windows.remove(popupWindowId).catch(() => { });
                        if (tokenCaptured) {
                            resolve({ ok: true, token: tokenCaptured });
                        } else {
                            reject(new Error('Login popup timeout'));
                        }
                    }
                }, 120000);

                const onUpdated = (tabId, changeInfo, tab) => {
                    if (resolved) return;
                    if (tab.windowId !== popupWindowId) return;
                    if (!changeInfo.url) return;

                    const url = changeInfo.url;

                    // Ловим callback URL — сохраняем токен, но НЕ закрываем popup!
                    if (url.startsWith(DAT_AUTH_CONFIG.callbackUrl)) {
                        const token = this._extractTokenFromUrl(url);
                        if (token) {
                            tokenCaptured = token;
                            this._saveToken(token, 'login').then(() => {
                                console.log('[AIDA/Auth/DAT] Step: token captured from callback. Popup stays open for usurp modal.');
                            });
                        }
                    }
                };

                // Следим за полной загрузкой страницы
                const onCompleted = (tabId, changeInfo, tab) => {
                    if (resolved) return;
                    if (tab.windowId !== popupWindowId) return;
                    if (changeInfo.status !== 'complete') return;

                    const url = tab.url || '';
                    // Если search-loads загрузился и токен уже пойман → ждём 3 сек и закрываем
                    if (url.includes('one.dat.com/search-loads') && tokenCaptured) {
                        console.log('[AIDA/Auth/DAT] Step: search-loads loaded + token captured. Closing in 3s...');
                        setTimeout(() => {
                            if (!resolved) {
                                resolved = true;
                                clearTimeout(timeout);
                                cleanup();
                                chrome.windows.remove(popupWindowId).catch(() => { });
                                resolve({ ok: true, token: tokenCaptured });
                            }
                        }, 3000);
                    }
                };

                // Слушаем TOKEN_HARVESTED от харвестера (как fallback)
                const onMessage = (message) => {
                    if (resolved) return;
                    if (message.type === 'TOKEN_HARVESTED' && message.board === 'dat') {
                        tokenCaptured = message.token || tokenCaptured;
                        console.log('[AIDA/Auth/DAT] Step: token from harvester. Closing in 2s...');
                        setTimeout(() => {
                            if (!resolved) {
                                resolved = true;
                                clearTimeout(timeout);
                                cleanup();
                                chrome.windows.remove(popupWindowId).catch(() => { });
                                resolve({ ok: true, token: tokenCaptured });
                            }
                        }, 2000);
                    }
                };

                // Если popup закрыт юзером
                const onRemoved = (windowId) => {
                    if (windowId !== popupWindowId) return;
                    if (!resolved) {
                        resolved = true;
                        clearTimeout(timeout);
                        cleanup();
                        if (tokenCaptured) {
                            resolve({ ok: true, token: tokenCaptured });
                        } else {
                            reject(new Error('Login popup closed without authentication'));
                        }
                    }
                };

                const cleanup = () => {
                    chrome.tabs.onUpdated.removeListener(onUpdated);
                    chrome.tabs.onUpdated.removeListener(onCompleted);
                    chrome.windows.onRemoved.removeListener(onRemoved);
                    chrome.runtime.onMessage.removeListener(onMessage);
                };

                chrome.tabs.onUpdated.addListener(onUpdated);
                chrome.tabs.onUpdated.addListener(onCompleted);
                chrome.windows.onRemoved.addListener(onRemoved);
                chrome.runtime.onMessage.addListener(onMessage);
            });
        });
    },

    /**
     * Silent refresh — обновить токен без участия пользователя.
     * Auth0 prompt=none + response_mode=web_message:
     * 1. Скрытый таб → login.dat.com/authorize?prompt=none&response_mode=web_message
     * 2. Auth0 проверяет session cookies → HTML с access_token в body
     * 3. chrome.scripting.executeScript → regex token extraction
     * 4. Закрываем таб
     * Без харвестера, без TOKEN_HARVESTED.
     */
    async silentRefresh() {
        console.log('[AIDA/Auth/DAT] Step: attempting silent refresh (prompt=none)');

        const nonce = crypto.randomUUID().replace(/-/g, '');
        const state = crypto.randomUUID().replace(/-/g, '');

        const params = new URLSearchParams({
            client_id: DAT_AUTH_CONFIG.clientId,
            response_type: DAT_AUTH_CONFIG.responseType,
            redirect_uri: DAT_AUTH_CONFIG.callbackUrl,
            scope: DAT_AUTH_CONFIG.scope,
            audience: DAT_AUTH_CONFIG.audience,
            response_mode: 'web_message',
            prompt: 'none',
            nonce,
            state
        });
        const url = `${DAT_AUTH_CONFIG.authorizeUrl}?${params.toString()}`;

        return new Promise((resolve) => {
            chrome.windows.create({ url, type: 'popup', state: 'minimized', focused: false, width: 1, height: 1 }, (win) => {
                if (!win || !win.tabs?.[0]) {
                    resolve({ ok: false, reason: 'Failed to create refresh window' });
                    return;
                }

                const tabId = win.tabs[0].id;
                const winId = win.id;
                let resolved = false;

                const finish = (ok, token, reason) => {
                    if (resolved) return;
                    resolved = true;
                    clearTimeout(timeout);
                    chrome.tabs.onUpdated.removeListener(onUpdated);
                    chrome.windows.remove(winId).catch(() => { });
                    if (ok && token) {
                        this._saveToken(token, 'silent_refresh_prompt_none').then(() => {
                            console.log('[AIDA/Auth/DAT] Step: token refreshed (prompt=none)');
                            resolve({ ok: true, token });
                        });
                    } else {
                        resolve({ ok: false, reason: reason || 'unknown' });
                    }
                };

                const timeout = setTimeout(() => {
                    console.warn('[AIDA/Auth/DAT] Silent refresh timeout (15s)');
                    finish(false, null, 'timeout');
                }, 15000);

                const onUpdated = async (updatedTabId, changeInfo) => {
                    if (resolved || updatedTabId !== tabId) return;

                    const navUrl = changeInfo.url || '';

                    // Auth0 вернул login page → сессия мертва
                    if (navUrl.includes('login.dat.com/u/login')) {
                        console.log('[AIDA/Auth/DAT] Silent refresh: session expired');
                        finish(false, null, 'session_expired');
                        return;
                    }

                    // Страница загрузилась → извлекаем токен из HTML body
                    if (changeInfo.status === 'complete') {
                        try {
                            const results = await chrome.scripting.executeScript({
                                target: { tabId },
                                func: () => document.body?.innerText || document.body?.textContent || ''
                            });
                            const bodyText = results?.[0]?.result || '';

                            const tokenMatch = bodyText.match(/"access_token"\s*:\s*"([^"]+)"/);
                            if (tokenMatch?.[1]) {
                                console.log('[AIDA/Auth/DAT] Silent refresh: token from HTML body');
                                finish(true, tokenMatch[1]);
                                return;
                            }

                            const errorMatch = bodyText.match(/"error"\s*:\s*"([^"]+)"/);
                            if (errorMatch?.[1]) {
                                console.warn('[AIDA/Auth/DAT] Silent refresh Auth0 error:', errorMatch[1]);
                                finish(false, null, `auth0_${errorMatch[1]}`);
                                return;
                            }

                            console.warn('[AIDA/Auth/DAT] Silent refresh: no token in body, len:', bodyText.length);
                        } catch (e) {
                            console.warn('[AIDA/Auth/DAT] Silent refresh executeScript error:', e.message);
                        }
                    }
                };

                chrome.tabs.onUpdated.addListener(onUpdated);
            });
        });
    },

    /**
     * Получить актуальный токен.
     * Стратегия «Refresh at every use» (как в Truckstop):
     * - Токен жив → вернуть + silentRefresh() fire-and-forget (к следующему запросу будет свежий)
     * - Токен протух → блокирующий silentRefresh() → вернуть свежий
     * - Токена нет → null
     */
    async getToken() {
        const data = await chrome.storage.local.get([STORAGE_KEYS.token, STORAGE_KEYS.tokenMeta]);
        const token = data[STORAGE_KEYS.token];
        const meta = data[STORAGE_KEYS.tokenMeta];

        if (!token) return null;

        if (meta?.expiresAt) {
            const now = Date.now();

            if (now >= meta.expiresAt) {
                // Токен протух → блокирующий refresh
                console.log('[AIDA/Auth/DAT] Token expired, attempting silent refresh');
                const result = await this.silentRefresh();
                if (result.ok) return result.token;
                return null;
            }
        }

        // Токен жив → вернуть + refresh в фоне (fire-and-forget)
        // К следующему запросу токен будет гарантированно свежий
        this.silentRefresh().catch(() => { });
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
