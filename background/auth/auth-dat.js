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
                            this._saveToken(token, 'login');
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
                };

                chrome.tabs.onUpdated.addListener(onUpdated);
                chrome.tabs.onUpdated.addListener(onCompleted);
                chrome.windows.onRemoved.addListener(onRemoved);
            });
        });
    },

    /**
     * Silent refresh — обновить токен без участия пользователя.
     * Прямой fetch к Auth0 с cookies из chrome.cookies API.
     * Без табов, окон, offscreen — один HTTP-запрос.
     */
    async silentRefresh() {
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

        try {
            const cookies = await chrome.cookies.getAll({ domain: 'login.dat.com' });
            if (!cookies.length) return { ok: false, reason: 'no_auth0_cookies' };

            const cookieStr = cookies.map(c => `${c.name}=${c.value}`).join('; ');
            const resp = await fetch(url, {
                headers: { 'Cookie': cookieStr },
                redirect: 'follow'
            });
            const html = await resp.text();

            const tokenMatch = html.match(/"access_token"\s*:\s*"([^"]+)"/);
            if (tokenMatch?.[1]) {
                await this._saveToken(tokenMatch[1], 'direct_fetch');
                return { ok: true, token: tokenMatch[1] };
            }

            const errorMatch = html.match(/"error"\s*:\s*"([^"]+)"/);
            if (errorMatch?.[1]) {
                console.warn('[AIDA/Auth/DAT] Silent refresh Auth0 error:', errorMatch[1]);
                return { ok: false, reason: `auth0_${errorMatch[1]}` };
            }

            return { ok: false, reason: 'no_token_in_response' };
        } catch (e) {
            console.warn('[AIDA/Auth/DAT] Silent refresh error:', e.message);
            return { ok: false, reason: e.message };
        }
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
     */
    async _saveToken(token, source) {
        const now = Date.now();
        const meta = {
            issuedAt: now,
            expiresAt: now + (DAT_AUTH_CONFIG.tokenLifetimeSec * 1000),
            source  // 'login' | 'direct_fetch'
        };
        await chrome.storage.local.set({
            [STORAGE_KEYS.token]: token,
            [STORAGE_KEYS.tokenMeta]: meta
        });
    }
};

export default AuthDat;
export { DAT_AUTH_CONFIG, STORAGE_KEYS };
