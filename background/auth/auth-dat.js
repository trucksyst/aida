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
     * Использует сессию Auth0 (cookies login.dat.com) + prompt=none.
     *
     * Ловит токен из 3 источников:
     * 1. Callback URL (#access_token=...)
     * 2. one.dat.com загрузилась (callback мог проскочить, но токен в storage от харвестера)
     * 3. Харвестер TOKEN_HARVESTED через runtime.onMessage
     *
     * Возвращает: { ok: true, token } или { ok: false, reason }
     */
    async silentRefresh() {
        console.log('[AIDA/Auth/DAT] Step: attempting silent refresh');

        // Открываем one.dat.com/search-loads в скрытом табе.
        // Страница сама сделает Auth0 redirect (через iframe или full redirect).
        // Харвестер на one.dat.com поймает токен через TOKEN_HARVESTED.
        // Это надёжнее чем прямой Auth0 URL — Chrome пропускает быстрые fragment-redirects.
        const url = 'https://one.dat.com/search-loads';

        // Сохраняем текущий (возможно протухший) токен для сравнения
        const oldStored = await chrome.storage.local.get('token:dat');
        const oldToken = oldStored['token:dat'] || null;

        return new Promise((resolve) => {
            chrome.tabs.create({ url, active: false }, (tab) => {
                if (!tab) {
                    resolve({ ok: false, reason: 'Failed to create refresh tab' });
                    return;
                }

                const tabId = tab.id;
                let resolved = false;
                let tokenCaptured = null;

                const finish = (ok, token, reason) => {
                    if (resolved) return;
                    resolved = true;
                    clearTimeout(timeout);
                    cleanup();
                    chrome.tabs.remove(tabId).catch(() => { });
                    if (ok && token) {
                        this._saveToken(token, 'silent_refresh').then(() => {
                            console.log('[AIDA/Auth/DAT] Step: token refreshed silently');
                            resolve({ ok: true, token });
                        });
                    } else {
                        resolve({ ok: false, reason: reason || 'unknown' });
                    }
                };

                // Таймаут 30 сек
                const timeout = setTimeout(() => {
                    if (tokenCaptured) {
                        finish(true, tokenCaptured);
                    } else {
                        console.warn('[AIDA/Auth/DAT] Silent refresh timeout');
                        finish(false, null, 'timeout');
                    }
                }, 30000);

                const onUpdated = (updatedTabId, changeInfo, updatedTab) => {
                    if (resolved || updatedTabId !== tabId) return;

                    // === DEBUG: логируем ВСЁ что происходит в скрытом табе ===
                    if (changeInfo.url) {
                        console.log('[AIDA/Auth/DAT] silentRefresh TAB URL →', changeInfo.url.slice(0, 200));
                    }
                    if (changeInfo.status) {
                        console.log('[AIDA/Auth/DAT] silentRefresh TAB status:', changeInfo.status, 'url:', (updatedTab?.url || '').slice(0, 200));
                    }

                    const navUrl = changeInfo.url || '';

                    // 1. Callback URL с токеном
                    if (navUrl.startsWith(DAT_AUTH_CONFIG.callbackUrl)) {
                        const token = this._extractTokenFromUrl(navUrl);
                        if (token) {
                            tokenCaptured = token;
                            console.log('[AIDA/Auth/DAT] Silent refresh: token from callback');
                            finish(true, token);
                            return;
                        }
                    }

                    // 2. Auth0 вернул login page → сессия мертва
                    if (navUrl.includes('login.dat.com/u/login')) {
                        console.log('[AIDA/Auth/DAT] Silent refresh: session expired, login required');
                        finish(false, null, 'session_expired');
                        return;
                    }

                    // 3. one.dat.com загрузилась (callback мог проскочить)
                    if (changeInfo.status === 'complete' && updatedTab?.url?.includes('one.dat.com')) {
                        // Ждём 3 сек чтобы harvester успел перехватить и записать токен
                        setTimeout(async () => {
                            if (resolved) return;
                            if (tokenCaptured) {
                                finish(true, tokenCaptured);
                                return;
                            }
                            // Проверяем storage — но только если токен ИЗМЕНИЛСЯ
                            const stored = await chrome.storage.local.get('token:dat');
                            const storedToken = stored['token:dat'];
                            if (storedToken && storedToken !== oldToken) {
                                console.log('[AIDA/Auth/DAT] Silent refresh: NEW token from storage after page load');
                                finish(true, storedToken);
                            } else {
                                console.warn('[AIDA/Auth/DAT] Silent refresh: token unchanged after page load');
                                finish(false, null, 'token_unchanged');
                            }
                        }, 3000);
                    }
                };

                // 4. Харвестер поймал токен
                const onMessage = (message) => {
                    if (resolved) return;
                    if (message.type === 'TOKEN_HARVESTED' && message.board === 'dat' && message.token) {
                        tokenCaptured = message.token;
                        console.log('[AIDA/Auth/DAT] Silent refresh: token from harvester');
                        finish(true, message.token);
                    }
                };

                const onRemoved = (removedTabId) => {
                    if (removedTabId !== tabId) return;
                    if (!resolved) {
                        if (tokenCaptured) {
                            finish(true, tokenCaptured);
                        } else {
                            finish(false, null, 'tab_closed');
                        }
                    }
                };

                const cleanup = () => {
                    chrome.tabs.onUpdated.removeListener(onUpdated);
                    chrome.tabs.onRemoved.removeListener(onRemoved);
                    chrome.runtime.onMessage.removeListener(onMessage);
                };

                chrome.tabs.onUpdated.addListener(onUpdated);
                chrome.tabs.onRemoved.addListener(onRemoved);
                chrome.runtime.onMessage.addListener(onMessage);
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
