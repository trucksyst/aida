/**
 * AIDA v0.1 — Auth Truckstop
 *
 * Модуль авторизации для Truckstop.com через PingOne DaVinci.
 * Полностью автономный блок — по аналогии с auth-dat.js.
 *
 * Flow:
 *   1. login()  → открывает popup auth.truckstop.com/as/authorize
 *   2. Пользователь вводит email, пароль (+ MFA если включён)
 *   3. PingOne DaVinci отправляет form_post → app.truckstop.com/Landing/PingExternalLoginCallback
 *   4. Redirect chain: V5Redirector → main.truckstop.com?id={userId}&event=login
 *   5. Модуль перехватывает URL, извлекает userId
 *   6. GET v5-auth.truckstop.com/auth/token/{userId} → JWT
 *   7. JWT сохраняется в token:truckstop + мета в auth:truckstop:meta
 *
 *   silentRefresh() → POST v5-auth.truckstop.com/auth/renew { token: jwt }
 *   → { accessToken: "новый JWT" }  (без popup, без вкладки!)
 *
 * PingOne параметры:
 *   client_id:      7a99fb37-0cbd-4526-a557-bd283b9e9cf4
 *   redirect_uri:   https://app.truckstop.com/Landing/PingExternalLoginCallback
 *   response_type:  code id_token token
 *   response_mode:  form_post
 */

const TS_AUTH_CONFIG = {
    clientId: '7a99fb37-0cbd-4526-a557-bd283b9e9cf4',
    authorizeUrl: 'https://auth.truckstop.com/as/authorize',
    redirectUri: 'https://app.truckstop.com/Landing/PingExternalLoginCallback',
    responseType: 'code id_token token',
    responseMode: 'form_post',
    authServiceUrl: 'https://v5-auth.truckstop.com/auth',
    mainUrl: 'https://main.truckstop.com',
    // Токен живёт ~1200 сек (20 мин). Обновляем за 3 минуты до истечения.
    tokenLifetimeSec: 1200,
    refreshBeforeExpirySec: 180
};

/** Storage ключи для auth:truckstop */
const STORAGE_KEYS = {
    token: 'token:truckstop',
    tokenMeta: 'auth:truckstop:meta'   // { issuedAt, expiresAt, userId, source }
};

const AuthTruckstop = {

    /**
     * Открыть popup-окно для логина в Truckstop.
     *
     * 1. Popup открывает auth.truckstop.com/as/authorize
     * 2. PingOne DaVinci показывает форму логина
     * 3. После успешного логина → redirect chain → main.truckstop.com?id={userId}
     * 4. Извлекаем userId из URL
     * 5. GET v5-auth.truckstop.com/auth/token/{userId} → JWT
     * 6. Сохраняем JWT + закрываем popup
     */
    login() {
        return new Promise((resolve, reject) => {
            // Строим authorize URL
            const params = new URLSearchParams({
                client_id: TS_AUTH_CONFIG.clientId,
                redirect_uri: TS_AUTH_CONFIG.redirectUri,
                response_type: TS_AUTH_CONFIG.responseType,
                response_mode: TS_AUTH_CONFIG.responseMode,
                scope: 'address openid profile email',
                nonce: this._generateNonce()
            });
            const authorizeUrl = `${TS_AUTH_CONFIG.authorizeUrl}?${params.toString()}`;

            console.log('[AIDA/Auth/TS] Step: opening login popup');

            chrome.windows.create({
                url: authorizeUrl,
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
                let userIdCaptured = null;

                // Таймаут 3 минуты (PingOne может быть медленнее Auth0)
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
                }, 180000);

                // Следим за URL-ами в popup — логируем ВСЕ для отладки
                const onUpdated = async (tabId, changeInfo, tab) => {
                    if (resolved) return;
                    if (tab.windowId !== popupWindowId) return;

                    // === DEBUG: логируем ВСЁ что происходит в popup ===
                    if (changeInfo.url) {
                        console.log('[AIDA/Auth/TS] popup URL →', changeInfo.url.slice(0, 250));
                    }
                    if (changeInfo.status) {
                        console.log('[AIDA/Auth/TS] popup status:', changeInfo.status, 'url:', (tab?.url || '').slice(0, 200));
                    }

                    const url = changeInfo.url || '';

                    // === 1. Ловим redirect на main.truckstop.com (с id= или без) ===
                    if (url.includes('main.truckstop.com')) {
                        // Пробуем извлечь userId из URL
                        let userId = this._extractUserIdFromUrl(url);

                        // Иногда id может быть в hash или другом формате
                        if (!userId && url.includes('id=')) {
                            try {
                                const match = url.match(/[?&]id=([^&]+)/);
                                if (match) userId = match[1];
                            } catch (_) { }
                        }

                        if (userId && !userIdCaptured) {
                            userIdCaptured = userId;
                            console.log('[AIDA/Auth/TS] Step: userId captured from redirect:', userId);

                            // Получаем v5 JWT token через API
                            try {
                                const token = await this._fetchV5Token(userId);
                                if (token) {
                                    tokenCaptured = token;
                                    await this._saveToken(token, 'login', userId);
                                    // Также пишем в Storage напрямую для совместимости
                                    await chrome.storage.local.set({ 'token:truckstop': token });
                                    console.log('[AIDA/Auth/TS] Step: v5 token obtained and saved ✓');

                                    // Ждём template — Angular SPA должен загрузиться и сделать search
                                    // Harvester захватит GraphQL запрос как TS_SEARCH_REQUEST_CAPTURED
                                    this._waitForTemplate(popupWindowId, timeout, cleanup, resolved, tokenCaptured, resolve, () => resolved, (v) => { resolved = v; });
                                }
                            } catch (e) {
                                console.warn('[AIDA/Auth/TS] v5 token fetch failed:', e.message);
                            }
                        }
                    }

                    // === 2. Ловим callback URL (app.truckstop.com/Landing) ===
                    if (url.includes('app.truckstop.com/Landing')) {
                        console.log('[AIDA/Auth/TS] Step: PingOne callback detected, waiting for redirect...');
                    }

                    // === 3. Page complete на main.truckstop.com — fallback через harvester ===
                    if (changeInfo.status === 'complete' && tab?.url?.includes('main.truckstop.com')) {
                        if (!tokenCaptured) {
                            console.log('[AIDA/Auth/TS] Step: main.truckstop.com loaded, waiting for harvester token (5s)...');
                            // Ждём 5 сек — харвестер должен поймать токен
                            setTimeout(async () => {
                                if (resolved || tokenCaptured) return;
                                // Проверяем storage — харвестер мог записать токен
                                const stored = await chrome.storage.local.get('token:truckstop');
                                const storedToken = stored['token:truckstop'];
                                if (storedToken) {
                                    tokenCaptured = storedToken;
                                    console.log('[AIDA/Auth/TS] Step: token from storage after page load ✓');
                                    resolved = true;
                                    clearTimeout(timeout);
                                    cleanup();
                                    chrome.windows.remove(popupWindowId).catch(() => { });
                                    resolve({ ok: true, token: tokenCaptured });
                                }
                            }, 5000);
                        }
                    }
                };

                // Слушаем TOKEN_HARVESTED от харвестера (fallback для токена)
                // НЕ закрываем popup здесь — _waitForTemplate управляет закрытием
                const onMessage = (message) => {
                    if (resolved) return;
                    if (message.type === 'TOKEN_HARVESTED' && message.board === 'truckstop') {
                        if (message.token) tokenCaptured = message.token;
                        console.log('[AIDA/Auth/TS] Step: token from harvester (popup stays open for template)');

                        // Если v5 token ещё не получен — сохраняем от харвестера
                        if (!userIdCaptured && tokenCaptured) {
                            this._saveToken(tokenCaptured, 'harvester').catch(console.warn);
                            chrome.storage.local.set({ 'token:truckstop': tokenCaptured }).catch(console.warn);
                            // Запускаем ожидание template
                            this._waitForTemplate(popupWindowId, timeout, cleanup, resolved, tokenCaptured, resolve, () => resolved, (v) => { resolved = v; });
                        }
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
                    chrome.windows.onRemoved.removeListener(onRemoved);
                    chrome.runtime.onMessage.removeListener(onMessage);
                };

                chrome.tabs.onUpdated.addListener(onUpdated);
                chrome.windows.onRemoved.addListener(onRemoved);
                chrome.runtime.onMessage.addListener(onMessage);
            });
        });
    },

    /**
     * Silent refresh — обновить токен БЕЗ участия пользователя.
     *
     * Просто POST к v5-auth.truckstop.com/auth/renew с текущим JWT.
     * Это НАМНОГО проще чем у DAT (не нужен скрытый таб, iframe, prompt=none).
     *
     * Возвращает: { ok: true, token } или { ok: false, reason }
     */
    async silentRefresh() {
        console.log('[AIDA/Auth/TS] Step: attempting silent refresh');

        const data = await chrome.storage.local.get([STORAGE_KEYS.token, STORAGE_KEYS.tokenMeta]);
        const currentToken = data[STORAGE_KEYS.token];

        if (!currentToken) {
            console.warn('[AIDA/Auth/TS] Silent refresh: no token to renew');
            return { ok: false, reason: 'no_token' };
        }

        try {
            const resp = await fetch(`${TS_AUTH_CONFIG.authServiceUrl}/renew`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Origin': TS_AUTH_CONFIG.mainUrl,
                    'Referer': `${TS_AUTH_CONFIG.mainUrl}/`
                },
                body: JSON.stringify({ token: currentToken })
            });

            if (!resp.ok) {
                const text = await resp.text().catch(() => '');
                console.warn(`[AIDA/Auth/TS] Silent refresh failed: HTTP ${resp.status}`, text.slice(0, 200));

                // 401/403 → сессия мертва
                if (resp.status === 401 || resp.status === 403) {
                    return { ok: false, reason: 'session_expired' };
                }
                return { ok: false, reason: `http_${resp.status}` };
            }

            const result = await resp.json();
            const newToken = result.accessToken || result.access_token;

            if (!newToken) {
                console.warn('[AIDA/Auth/TS] Silent refresh: no accessToken in response');
                return { ok: false, reason: 'no_token_in_response' };
            }

            // Сохраняем из мета userId (если был)
            const meta = data[STORAGE_KEYS.tokenMeta];
            await this._saveToken(newToken, 'silent_refresh', meta?.userId);

            console.log('[AIDA/Auth/TS] Step: token refreshed silently ✓');
            return { ok: true, token: newToken };

        } catch (e) {
            console.warn('[AIDA/Auth/TS] Silent refresh error:', e.message);
            return { ok: false, reason: e.message };
        }
    },

    /**
     * Получить актуальный токен.
     * Если токен есть и не истёк — вернуть.
     * Если истекает скоро — silent refresh в фоне.
     * Если истёк — попробовать silent refresh синхронно.
     */
    async getToken() {
        const data = await chrome.storage.local.get([STORAGE_KEYS.token, STORAGE_KEYS.tokenMeta]);
        const token = data[STORAGE_KEYS.token];
        const meta = data[STORAGE_KEYS.tokenMeta];

        if (!token) return null;

        // Определяем expiresAt: из мета или из JWT
        const expiresAt = meta?.expiresAt || this._getJwtExpiry(token);

        if (expiresAt) {
            const now = Date.now();
            const refreshThreshold = TS_AUTH_CONFIG.refreshBeforeExpirySec * 1000;

            if (now >= expiresAt) {
                // Токен истёк — пробуем silent refresh
                console.log('[AIDA/Auth/TS] Token expired, attempting silent refresh');
                const result = await this.silentRefresh();
                if (result.ok) return result.token;
                // Refresh не удался — удаляем мёртвый токен
                await this.disconnect();
                return null;
            }

            if (now >= expiresAt - refreshThreshold) {
                // Токен скоро истечёт — обновляем в фоне (не блокируем)
                console.log('[AIDA/Auth/TS] Token expiring soon, refreshing in background');
                this.silentRefresh().catch(console.warn);
            }

            // Если мета нет — создаём её (миграция старого токена)
            if (!meta) {
                this._saveToken(token, 'migrated').catch(console.warn);
            }
        } else {
            // Не можем определить expiry — токен невалидный, удаляем
            console.warn('[AIDA/Auth/TS] Token without expiry info, removing');
            await this.disconnect();
            return null;
        }

        return token;
    },

    /**
     * Статус подключения.
     * Проверяет expiry из мета И из JWT (для старых токенов без мета).
     */
    async getStatus() {
        const data = await chrome.storage.local.get([STORAGE_KEYS.token, STORAGE_KEYS.tokenMeta]);
        const token = data[STORAGE_KEYS.token];
        const meta = data[STORAGE_KEYS.tokenMeta];

        if (!token) return 'disconnected';

        // Проверяем expiry: из мета или из JWT напрямую
        const expiresAt = meta?.expiresAt || this._getJwtExpiry(token);

        if (expiresAt && Date.now() >= expiresAt) {
            return 'expired';
        }

        // Нет ни мета ни exp в JWT — токен невалиден
        if (!expiresAt) {
            return 'expired';
        }

        return 'connected';
    },

    /**
     * Отключить борд — удалить токен.
     */
    async disconnect() {
        await chrome.storage.local.remove([STORAGE_KEYS.token, STORAGE_KEYS.tokenMeta]);
        console.log('[AIDA/Auth/TS] Disconnected');
    },

    // ============================================================
    // Internal
    // ============================================================

    /**
     * Извлечь userId из URL: main.truckstop.com?id={userId}&...
     */
    _extractUserIdFromUrl(url) {
        try {
            const parsed = new URL(url);
            return parsed.searchParams.get('id') || null;
        } catch (e) {
            console.warn('[AIDA/Auth/TS] _extractUserIdFromUrl error:', e.message);
            return null;
        }
    },

    /**
     * Получить v5 JWT Token через API.
     * GET v5-auth.truckstop.com/auth/token/{userId}
     */
    async _fetchV5Token(userId) {
        if (!userId) throw new Error('No userId');

        const url = `${TS_AUTH_CONFIG.authServiceUrl}/token/${userId}`;
        console.log('[AIDA/Auth/TS] Step: fetching v5 token for userId:', userId);

        const resp = await fetch(url, {
            headers: {
                'Origin': TS_AUTH_CONFIG.mainUrl,
                'Referer': `${TS_AUTH_CONFIG.mainUrl}/`
            }
        });

        if (!resp.ok) {
            throw new Error(`v5 token HTTP ${resp.status}`);
        }

        const data = await resp.json();
        const token = data.accessToken || data.access_token;

        if (!token) {
            throw new Error('No accessToken in v5 response');
        }

        return token;
    },

    /**
     * Сохранить токен + мета-данные в Storage.
     * Пишет в тот же ключ `token:truckstop`, что и харвестер — совместимость 100%.
     */
    async _saveToken(token, source, userId) {
        // Парсим JWT для определения expiry
        let expiresAt = Date.now() + (TS_AUTH_CONFIG.tokenLifetimeSec * 1000);
        try {
            const parts = token.split('.');
            if (parts.length >= 2) {
                const payload = JSON.parse(atob(parts[1]));
                if (payload.exp) {
                    expiresAt = payload.exp * 1000; // exp в секундах → миллисекунды
                }
            }
        } catch (e) {
            console.warn('[AIDA/Auth/TS] JWT parse for expiry failed, using default TTL');
        }

        const meta = {
            issuedAt: Date.now(),
            expiresAt,
            userId: userId || null,
            source  // 'login' | 'silent_refresh' | 'harvester'
        };

        await chrome.storage.local.set({
            [STORAGE_KEYS.token]: token,
            [STORAGE_KEYS.tokenMeta]: meta
        });

        console.log(`[AIDA/Auth/TS] Token saved (source: ${source}, expires in ${Math.round((expiresAt - Date.now()) / 1000)}s)`);
    },

    /**
     * Парсинг JWT для получения expiry (ms).
     * Универсальный fallback для токенов без мета-данных.
     */
    _getJwtExpiry(token) {
        try {
            const parts = token.split('.');
            if (parts.length < 2) return null;
            const payload = JSON.parse(atob(parts[1]));
            if (payload.exp) return payload.exp * 1000;
            // Если в claims есть expires
            if (payload.claims?.expires) {
                return new Date(payload.claims.expires).getTime() || null;
            }
            return null;
        } catch (e) {
            return null;
        }
    },

    /**
     * Ждём template после получения токена.
     * Angular SPA на main.truckstop.com загружается и делает GraphQL запрос →
     * harvester ловит его как TS_SEARCH_REQUEST_CAPTURED → background сохраняет template.
     * Проверяем storage каждые 2 сек, до 20 сек.
     */
    async _waitForTemplate(popupWindowId, timeout, cleanup, resolvedFlag, tokenCaptured, resolve, getResolved, setResolved) {
        // Сначала проверяем — может template уже есть
        const settings = await chrome.storage.local.get('settings');
        const existing = settings?.settings?.truckstopRequestTemplate;
        if (existing && existing.url) {
            console.log('[AIDA/Auth/TS] Step: template already in storage, closing popup');
            if (!getResolved()) {
                setResolved(true);
                clearTimeout(timeout);
                cleanup();
                chrome.windows.remove(popupWindowId).catch(() => { });
                resolve({ ok: true, token: tokenCaptured });
            }
            return;
        }

        console.log('[AIDA/Auth/TS] Step: waiting for template capture (up to 20s)...');
        let checks = 0;
        const maxChecks = 10; // 10 * 2s = 20s

        const checkInterval = setInterval(async () => {
            checks++;
            if (getResolved()) {
                clearInterval(checkInterval);
                return;
            }

            const s = await chrome.storage.local.get('settings');
            const tmpl = s?.settings?.truckstopRequestTemplate;
            if (tmpl && tmpl.url) {
                console.log('[AIDA/Auth/TS] Step: template captured ✓ — closing popup');
                clearInterval(checkInterval);
                if (!getResolved()) {
                    setResolved(true);
                    clearTimeout(timeout);
                    cleanup();
                    chrome.windows.remove(popupWindowId).catch(() => { });
                    resolve({ ok: true, token: tokenCaptured });
                }
                return;
            }

            if (checks >= maxChecks) {
                console.warn('[AIDA/Auth/TS] Step: template NOT captured after 20s — closing popup anyway');
                clearInterval(checkInterval);
                if (!getResolved()) {
                    setResolved(true);
                    clearTimeout(timeout);
                    cleanup();
                    chrome.windows.remove(popupWindowId).catch(() => { });
                    resolve({ ok: true, token: tokenCaptured });
                }
            }
        }, 2000);
    },

    /**
     * Генерация nonce для authorize request.
     */
    _generateNonce() {
        const array = new Uint8Array(32);
        crypto.getRandomValues(array);
        return Array.from(array, b => b.toString(16).padStart(2, '0')).join('');
    }
};

export default AuthTruckstop;
export { TS_AUTH_CONFIG, STORAGE_KEYS as TS_STORAGE_KEYS };
