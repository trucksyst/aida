/**
 * AIDA v0.1 — Auth Truckstop
 *
 * Модуль авторизации для Truckstop через PingOne DaVinci.
 * Полностью автономный блок — аналог auth-dat.js.
 *
 * Flow (login):
 *   1. login() → popup окно auth.truckstop.com/as/authorize
 *   2. Юзер вводит email, пароль (+ MFA если требуется)
 *   3. PingOne DaVinci → form_post callback → redirect chain:
 *      app.truckstop.com/Landing/PingExternalLoginCallback
 *      → /Landing/V5Redirector
 *      → main.truckstop.com?id={userId}&event=login
 *   4. Из URL парсим userId
 *   5. GET v5-auth.truckstop.com/auth/token/{userId} → { accessToken: jwt }
 *   6. JWT сохраняется в token:truckstop + мета в auth:truckstop:meta
 *
 * Flow (silent refresh):
 *   POST v5-auth.truckstop.com/auth/renew + { token: currentJWT }
 *   → { accessToken: newJWT }
 *   Не нужен ни popup, ни скрытый таб!
 *
 * PingOne параметры Truckstop:
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
    // Токен живёт ~20 мин (1199 сек). Обновляем за 3 мин до истечения.
    tokenLifetimeSec: 1199,
    refreshBeforeExpirySec: 180
};

/** Storage ключи для auth:truckstop */
const STORAGE_KEYS = {
    token: 'token:truckstop',
    tokenMeta: 'auth:truckstop:meta',   // { issuedAt, expiresAt, userId, source }
    claims: 'auth:truckstop:claims'     // { v5AccountId, accountUserId, v5AccountUserId }
};

const AuthTruckstop = {

    /**
     * Открыть popup-окно для логина в Truckstop.
     * Popup открывает auth.truckstop.com/as/authorize с параметрами OAuth.
     * Юзер вводит логин/пароль (+ MFA) → PingOne DaVinci обрабатывает →
     * redirect chain → main.truckstop.com?id={userId}.
     * Из URL парсим userId → запрашиваем JWT из v5-auth API.
     */
    login() {
        return new Promise((resolve, reject) => {
            console.log('[AIDA/Auth/TS] Step: opening login popup (auth.truckstop.com)');

            // Строим authorize URL
            const params = new URLSearchParams({
                client_id: TS_AUTH_CONFIG.clientId,
                redirect_uri: TS_AUTH_CONFIG.redirectUri,
                response_type: TS_AUTH_CONFIG.responseType,
                response_mode: TS_AUTH_CONFIG.responseMode,
                scope: 'address openid profile email'
            });
            const authorizeUrl = `${TS_AUTH_CONFIG.authorizeUrl}?${params.toString()}`;

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
                let userId = null;

                // Таймаут 3 минуты (MFA может занять время)
                const timeout = setTimeout(() => {
                    if (!resolved) {
                        resolved = true;
                        cleanup();
                        chrome.windows.remove(popupWindowId).catch(() => { });
                        reject(new Error('Login popup timeout'));
                    }
                }, 180000);

                const onUpdated = async (tabId, changeInfo, tab) => {
                    if (resolved) return;
                    if (tab.windowId !== popupWindowId) return;
                    if (!changeInfo.url) return;

                    const url = changeInfo.url;

                    // Ловим redirect на main.truckstop.com?id={userId}
                    if (url.includes('main.truckstop.com') && url.includes('id=')) {
                        const extractedId = this._extractUserIdFromUrl(url);
                        if (extractedId) {
                            userId = extractedId;
                            console.log('[AIDA/Auth/TS] Step: userId captured from redirect:', userId);

                            // Запрашиваем JWT из v5-auth API
                            try {
                                const token = await this._fetchV5Token(userId);
                                if (token) {
                                    await this._saveToken(token, 'login', userId);
                                    console.log('[AIDA/Auth/TS] Step: token obtained and saved. Closing popup.');
                                    resolved = true;
                                    clearTimeout(timeout);
                                    cleanup();
                                    // Даём 1 сек на визуальное завершение
                                    setTimeout(() => {
                                        chrome.windows.remove(popupWindowId).catch(() => { });
                                    }, 1000);
                                    resolve({ ok: true, token });
                                    return;
                                }
                            } catch (e) {
                                console.warn('[AIDA/Auth/TS] v5-auth token fetch failed:', e.message);
                            }
                        }
                    }

                    // Fallback: ловим callback URL (PingExternalLoginCallback)
                    // redirect chain: callback → V5Redirector → main.truckstop.com
                    // Если по какой-то причине мы не поймали main.truckstop.com,
                    // ждём — redirect продолжится автоматически.
                    if (url.includes('PingExternalLoginCallback')) {
                        console.log('[AIDA/Auth/TS] Step: PingExternalLoginCallback detected, waiting for redirect to main...');
                    }
                };

                // Слушаем TOKEN_HARVESTED от харвестера (fallback)
                const onMessage = async (message) => {
                    if (resolved) return;
                    if (message.type === 'TOKEN_HARVESTED' && message.board === 'truckstop' && message.token) {
                        console.log('[AIDA/Auth/TS] Step: token from harvester. Saving...');
                        await this._saveToken(message.token, 'harvester_popup');
                        resolved = true;
                        clearTimeout(timeout);
                        cleanup();
                        setTimeout(() => {
                            chrome.windows.remove(popupWindowId).catch(() => { });
                        }, 1000);
                        resolve({ ok: true, token: message.token });
                    }
                };

                // Если popup закрыт юзером
                const onRemoved = (windowId) => {
                    if (windowId !== popupWindowId) return;
                    if (!resolved) {
                        resolved = true;
                        clearTimeout(timeout);
                        cleanup();
                        reject(new Error('Login popup closed without authentication'));
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
     * Silent refresh — обновить токен без участия пользователя.
     * Простой POST запрос к v5-auth API — НЕ нужен ни popup, ни скрытый таб!
     * Это проще и надёжнее чем DAT (который требует скрытый таб для Auth0 silent auth).
     *
     * Возвращает: { ok: true, token } или { ok: false, reason }
     */
    async silentRefresh() {
        console.log('[AIDA/Auth/TS] Step: attempting silent refresh');

        const data = await chrome.storage.local.get([STORAGE_KEYS.token, STORAGE_KEYS.tokenMeta]);
        const currentToken = data[STORAGE_KEYS.token];

        if (!currentToken) {
            console.log('[AIDA/Auth/TS] silentRefresh: no current token');
            return { ok: false, reason: 'no_token' };
        }

        try {
            const resp = await fetch(`${TS_AUTH_CONFIG.authServiceUrl}/renew`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Origin': TS_AUTH_CONFIG.mainUrl,
                    'Referer': TS_AUTH_CONFIG.mainUrl + '/'
                },
                body: JSON.stringify({ token: currentToken })
            });

            if (!resp.ok) {
                const text = await resp.text().catch(() => '');
                console.warn(`[AIDA/Auth/TS] silentRefresh failed: HTTP ${resp.status}`, text.slice(0, 200));

                if (resp.status === 401 || resp.status === 403) {
                    return { ok: false, reason: 'session_expired' };
                }
                return { ok: false, reason: `http_${resp.status}` };
            }

            const result = await resp.json();
            const newToken = result.accessToken || result.access_token;

            if (!newToken) {
                console.warn('[AIDA/Auth/TS] silentRefresh: no accessToken in response');
                return { ok: false, reason: 'no_token_in_response' };
            }

            // Сохраняем userId из мета (если был)
            const meta = data[STORAGE_KEYS.tokenMeta];
            await this._saveToken(newToken, 'silent_refresh', meta?.userId);
            console.log('[AIDA/Auth/TS] Step: token refreshed silently');
            return { ok: true, token: newToken };

        } catch (e) {
            console.warn('[AIDA/Auth/TS] silentRefresh error:', e.message);
            return { ok: false, reason: e.message };
        }
    },

    /**
     * Получить актуальный токен.
     * Стратегия «Refresh at every use» (§18 ТЗ):
     * - Токен жив → вернуть + silentRefresh() fire-and-forget (к следующему запросу будет свежий)
     * - Токен протух → блокирующий silentRefresh() → вернуть свежий
     * - Токена нет → null
     */
    async getToken() {
        const data = await chrome.storage.local.get([STORAGE_KEYS.token, STORAGE_KEYS.tokenMeta]);
        const token = data[STORAGE_KEYS.token];
        const meta = data[STORAGE_KEYS.tokenMeta];

        if (!token) return null;

        // Валидация: если в Storage лежит не-JWT — удалить и вернуть null
        if (!this._isValidJwt(token)) {
            console.warn('[AIDA/Auth/TS] getToken: stored token is not valid JWT, clearing');
            await chrome.storage.local.remove([STORAGE_KEYS.token, STORAGE_KEYS.tokenMeta]);
            return null;
        }

        if (meta?.expiresAt) {
            const now = Date.now();

            if (now >= meta.expiresAt) {
                // Токен протух → блокирующий refresh
                console.log('[AIDA/Auth/TS] Token expired, attempting silent refresh');
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
            const urlObj = new URL(url);
            return urlObj.searchParams.get('id') || null;
        } catch (e) {
            // Fallback: regex
            const match = url.match(/[?&]id=([^&#]+)/);
            return match ? match[1] : null;
        }
    },

    /**
     * Получить JWT из v5-auth API по userId.
     * GET https://v5-auth.truckstop.com/auth/token/{userId}
     */
    async _fetchV5Token(userId) {
        if (!userId) return null;
        const url = `${TS_AUTH_CONFIG.authServiceUrl}/token/${userId}`;
        console.log('[AIDA/Auth/TS] Step: fetching v5 token for userId:', userId);

        const resp = await fetch(url, {
            headers: {
                'Accept': 'application/json',
                'Origin': TS_AUTH_CONFIG.mainUrl,
                'Referer': TS_AUTH_CONFIG.mainUrl + '/'
            }
        });

        if (!resp.ok) {
            throw new Error(`v5-auth token fetch failed: HTTP ${resp.status}`);
        }

        const data = await resp.json();
        return data.accessToken || data.access_token || null;
    },

    /**
     * Проверить, является ли строка валидным JWT (3 части через точку, payload декодируется).
     */
    _isValidJwt(token) {
        if (!token || typeof token !== 'string') return false;
        const parts = token.split('.');
        if (parts.length !== 3) return false;
        try {
            // Проверяем что payload декодируется
            const payload = JSON.parse(atob(parts[1].replace(/-/g, '+').replace(/_/g, '/')));
            return payload && typeof payload === 'object';
        } catch {
            return false;
        }
    },

    /**
     * Сохранить токен + мета-данные в Storage.
     * Валидирует что токен — реальный JWT (3 части, payload декодируется).
     * Также извлекает claims для GraphQL запросов (JWT decode → introspection fallback).
     */
    async _saveToken(token, source, userId) {
        // Валидация: не сохраняем мусор
        if (!this._isValidJwt(token)) {
            console.warn('[AIDA/Auth/TS] _saveToken REJECTED: not a valid JWT (source:', source, ')');
            return;
        }

        const now = Date.now();
        const meta = {
            issuedAt: now,
            expiresAt: now + (TS_AUTH_CONFIG.tokenLifetimeSec * 1000),
            userId: userId || null,
            source  // 'login' | 'silent_refresh' | 'harvester' | 'harvester_popup'
        };
        const storageData = {
            [STORAGE_KEYS.token]: token,
            [STORAGE_KEYS.tokenMeta]: meta
        };

        // Извлекаем claims из JWT (вложенный объект decoded.claims)
        const claims = this._decodeJwtClaims(token);

        if (claims && claims.v5AccountId) {
            storageData[STORAGE_KEYS.claims] = claims;
            console.log('[AIDA/Auth/TS] Claims saved:', {
                v5AccountId: claims.v5AccountId ? '✓' : '✗',
                accountUserId: claims.accountUserId ? '✓' : '✗',
                v5AccountUserId: claims.v5AccountUserId ? '✓' : '✗'
            });
        }
        // Если claims нет (например, raw Bearer от харвестера) — не перезаписываем ранее сохранённые
        await chrome.storage.local.set(storageData);
    },

    /**
     * Декодировать JWT payload и извлечь claims для GraphQL.
     * JWT Truckstop: { id, hasura-claims, claims: { v5AccountId, accountUserId, ... }, iat, exp }
     */
    _decodeJwtClaims(token) {
        if (!token || typeof token !== 'string') return null;
        try {
            const parts = token.split('.');
            if (parts.length < 2) return null;
            const base64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
            const padded = base64 + '='.repeat((4 - base64.length % 4) % 4);
            const decoded = JSON.parse(atob(padded));

            // Claims вложены в decoded.claims (не на верхнем уровне!)
            const c = decoded.claims || decoded;
            return {
                v5AccountId: c.v5AccountId || c.V5AccountId || c.account_id || null,
                accountUserId: c.accountUserId || c.AccountUserId || null,
                v5AccountUserId: c.v5AccountUserId || c.V5AccountUserId || null,
                contactSfId: c.contactSfId || c.ContactSfId || null
            };
        } catch (e) {
            console.warn('[AIDA/Auth/TS] JWT decode failed:', e.message);
            return null;
        }
    },

};

export default AuthTruckstop;
export { TS_AUTH_CONFIG, STORAGE_KEYS };
