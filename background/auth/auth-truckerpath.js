/**
 * AIDA v0.1 — Auth TruckerPath
 *
 * Модуль авторизации для TruckerPath (REST API + MD5 подпись).
 * Полностью автономный блок — аналог auth-truckstop.js.
 *
 * Flow (login):
 *   1. login() → popup loadboard.truckerpath.com
 *   2. Юзер логинится на сайте TP
 *   3. webRequest listener ловит x-auth-token из любого запроса к api.truckerpath.com
 *   4. Токен сохраняется в token:truckerpath + мета в auth:truckerpath:meta
 *   5. Popup закрывается
 *
 * Flow (silent refresh):
 *   Токен живёт ~351 день — refresh практически не нужен.
 *   Проверка валидности: GET /tl/users/me → 200 = жив.
 *   При ошибке → статус expired.
 *
 * Формат токена: r:{hex32} (передаётся как x-auth-token, НЕ Bearer!)
 * Доп. заголовки: client: WebCarriers/0.0.0, installation-id: {uuid}
 */

const TP_AUTH_CONFIG = {
    apiBase: 'https://api.truckerpath.com',
    loadboardUrl: 'https://loadboard.truckerpath.com',
    clientHeader: 'WebCarriers/0.0.0',
    // Токен живёт ~351 день (30306379 сек). Проверяем раз в сутки.
    tokenLifetimeSec: 30306379,
    // Секрет для MD5 подписи (захардкожен в common.js сайта TP)
    loginSecret: 'eyFsGFeZ@Sajb$ZW',
};

/** Storage ключи для auth:truckerpath */
const STORAGE_KEYS = {
    token: 'token:truckerpath',
    tokenMeta: 'auth:truckerpath:meta',          // { issuedAt, expiresAt, source, installationId }
    installationId: 'auth:truckerpath:installationId',
};

/** Генерация UUID v4 */
function generateUUID() {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
        const r = Math.random() * 16 | 0;
        return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
    });
}

/** Получить или создать installationId (один раз, хранится в Storage). */
async function getInstallationId() {
    const data = await chrome.storage.local.get(STORAGE_KEYS.installationId);
    let id = data[STORAGE_KEYS.installationId];
    if (!id) {
        id = generateUUID();
        await chrome.storage.local.set({ [STORAGE_KEYS.installationId]: id });
    }
    return id;
}

/**
 * MD5 хеш (pure JS, реализация RFC1321).
 * Используется ТОЛЬКО для signature при логине.
 */
function md5(string) {
    function md5cycle(x, k) {
        let a = x[0], b = x[1], c = x[2], d = x[3];
        a = ff(a, b, c, d, k[0], 7, -680876936); d = ff(d, a, b, c, k[1], 12, -389564586);
        c = ff(c, d, a, b, k[2], 17, 606105819); b = ff(b, c, d, a, k[3], 22, -1044525330);
        a = ff(a, b, c, d, k[4], 7, -176418897); d = ff(d, a, b, c, k[5], 12, 1200080426);
        c = ff(c, d, a, b, k[6], 17, -1473231341); b = ff(b, c, d, a, k[7], 22, -45705983);
        a = ff(a, b, c, d, k[8], 7, 1770035416); d = ff(d, a, b, c, k[9], 12, -1958414417);
        c = ff(c, d, a, b, k[10], 17, -42063); b = ff(b, c, d, a, k[11], 22, -1990404162);
        a = ff(a, b, c, d, k[12], 7, 1804603682); d = ff(d, a, b, c, k[13], 12, -40341101);
        c = ff(c, d, a, b, k[14], 17, -1502002290); b = ff(b, c, d, a, k[15], 22, 1236535329);
        a = gg(a, b, c, d, k[1], 5, -165796510); d = gg(d, a, b, c, k[6], 9, -1069501632);
        c = gg(c, d, a, b, k[11], 14, 643717713); b = gg(b, c, d, a, k[0], 20, -373897302);
        a = gg(a, b, c, d, k[5], 5, -701558691); d = gg(d, a, b, c, k[10], 9, 38016083);
        c = gg(c, d, a, b, k[15], 14, -660478335); b = gg(b, c, d, a, k[4], 20, -405537848);
        a = gg(a, b, c, d, k[9], 5, 568446438); d = gg(d, a, b, c, k[14], 9, -1019803690);
        c = gg(c, d, a, b, k[3], 14, -187363961); b = gg(b, c, d, a, k[8], 20, 1163531501);
        a = gg(a, b, c, d, k[13], 5, -1444681467); d = gg(d, a, b, c, k[2], 9, -51403784);
        c = gg(c, d, a, b, k[7], 14, 1735328473); b = gg(b, c, d, a, k[12], 20, -1926607734);
        a = hh(a, b, c, d, k[5], 4, -378558); d = hh(d, a, b, c, k[8], 11, -2022574463);
        c = hh(c, d, a, b, k[11], 16, 1839030562); b = hh(b, c, d, a, k[14], 23, -35309556);
        a = hh(a, b, c, d, k[1], 4, -1530992060); d = hh(d, a, b, c, k[4], 11, 1272893353);
        c = hh(c, d, a, b, k[7], 16, -155497632); b = hh(b, c, d, a, k[10], 23, -1094730640);
        a = hh(a, b, c, d, k[13], 4, 681279174); d = hh(d, a, b, c, k[0], 11, -358537222);
        c = hh(c, d, a, b, k[3], 16, -722521979); b = hh(b, c, d, a, k[6], 23, 76029189);
        a = hh(a, b, c, d, k[9], 4, -640364487); d = hh(d, a, b, c, k[12], 11, -421815835);
        c = hh(c, d, a, b, k[15], 16, 530742520); b = hh(b, c, d, a, k[2], 23, -995338651);
        a = ii(a, b, c, d, k[0], 6, -198630844); d = ii(d, a, b, c, k[7], 10, 1126891415);
        c = ii(c, d, a, b, k[14], 15, -1416354905); b = ii(b, c, d, a, k[5], 21, -57434055);
        a = ii(a, b, c, d, k[12], 6, 1700485571); d = ii(d, a, b, c, k[3], 10, -1894986606);
        c = ii(c, d, a, b, k[10], 15, -1051523); b = ii(b, c, d, a, k[1], 21, -2054922799);
        a = ii(a, b, c, d, k[8], 6, 1873313359); d = ii(d, a, b, c, k[15], 10, -30611744);
        c = ii(c, d, a, b, k[6], 15, -1560198380); b = ii(b, c, d, a, k[13], 21, 1309151649);
        a = ii(a, b, c, d, k[4], 6, -145523070); d = ii(d, a, b, c, k[11], 10, -1120210379);
        c = ii(c, d, a, b, k[2], 15, 718787259); b = ii(b, c, d, a, k[9], 21, -343485551);
        x[0] = add32(a, x[0]); x[1] = add32(b, x[1]); x[2] = add32(c, x[2]); x[3] = add32(d, x[3]);
    }
    function cmn(q, a, b, x, s, t) { a = add32(add32(a, q), add32(x, t)); return add32((a << s) | (a >>> (32 - s)), b); }
    function ff(a, b, c, d, x, s, t) { return cmn((b & c) | ((~b) & d), a, b, x, s, t); }
    function gg(a, b, c, d, x, s, t) { return cmn((b & d) | (c & (~d)), a, b, x, s, t); }
    function hh(a, b, c, d, x, s, t) { return cmn(b ^ c ^ d, a, b, x, s, t); }
    function ii(a, b, c, d, x, s, t) { return cmn(c ^ (b | (~d)), a, b, x, s, t); }
    function md5blk(s) {
        const md5blks = [];
        for (let i = 0; i < 64; i += 4)
            md5blks[i >> 2] = s.charCodeAt(i) + (s.charCodeAt(i + 1) << 8) + (s.charCodeAt(i + 2) << 16) + (s.charCodeAt(i + 3) << 24);
        return md5blks;
    }
    function rhex(n) {
        const hc = '0123456789abcdef';
        let s = '';
        for (let j = 0; j < 4; j++) s += hc.charAt((n >> (j * 8 + 4)) & 0x0F) + hc.charAt((n >> (j * 8)) & 0x0F);
        return s;
    }
    function add32(a, b) { return (a + b) & 0xFFFFFFFF; }

    const n = string.length;
    let state = [1732584193, -271733879, -1732584194, 271733878];
    let i;
    for (i = 64; i <= n; i += 64) md5cycle(state, md5blk(string.substring(i - 64, i)));
    string = string.substring(i - 64);
    const tail = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
    for (i = 0; i < string.length; i++) tail[i >> 2] |= string.charCodeAt(i) << ((i % 4) << 3);
    tail[i >> 2] |= 0x80 << ((i % 4) << 3);
    if (i > 55) { md5cycle(state, tail); for (i = 0; i < 16; i++) tail[i] = 0; }
    tail[14] = n * 8;
    md5cycle(state, tail);
    return rhex(state[0]) + rhex(state[1]) + rhex(state[2]) + rhex(state[3]);
}

const AuthTruckerpath = {

    /**
     * Открыть popup-окно для логина в TruckerPath.
     * Ловит x-auth-token из заголовков API-запросов через webRequest.
     */
    login() {
        return new Promise((resolve, reject) => {
            console.log('[AIDA/Auth/TP] Step: opening login popup (loadboard.truckerpath.com)');

            chrome.windows.create({
                url: TP_AUTH_CONFIG.loadboardUrl,
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

                // Таймаут 3 минуты
                const timeout = setTimeout(() => {
                    if (!resolved) {
                        resolved = true;
                        cleanup();
                        chrome.windows.remove(popupWindowId).catch(() => { });
                        reject(new Error('Login popup timeout'));
                    }
                }, 180000);

                // Listener для перехвата x-auth-token из API запросов
                const onHeadersReceived = (details) => {
                    if (resolved) return;

                    // Ищем x-auth-token в request headers
                    // webRequest.onSendHeaders даёт нам заголовки запроса
                };

                const onSendHeaders = async (details) => {
                    if (resolved) return;
                    if (!details.url.includes('api.truckerpath.com')) return;

                    // Ищем x-auth-token в заголовках запроса
                    const authHeader = details.requestHeaders?.find(
                        h => h.name.toLowerCase() === 'x-auth-token'
                    );

                    if (authHeader && authHeader.value && authHeader.value.startsWith('r:')) {
                        const token = authHeader.value;
                        console.log('[AIDA/Auth/TP] Step: x-auth-token captured from API request');

                        try {
                            await this._saveToken(token, 'login');
                            resolved = true;
                            clearTimeout(timeout);
                            cleanup();
                            setTimeout(() => {
                                chrome.windows.remove(popupWindowId).catch(() => { });
                            }, 1000);
                            resolve({ ok: true, token });
                        } catch (e) {
                            console.warn('[AIDA/Auth/TP] Token save failed:', e.message);
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
                        reject(new Error('Login popup closed without authentication'));
                    }
                };

                const cleanup = () => {
                    try {
                        chrome.webRequest.onSendHeaders.removeListener(onSendHeaders);
                    } catch (_) { }
                    chrome.windows.onRemoved.removeListener(onRemoved);
                };

                // Слушаем заголовки запросов к api.truckerpath.com
                chrome.webRequest.onSendHeaders.addListener(
                    onSendHeaders,
                    { urls: ['https://api.truckerpath.com/*'] },
                    ['requestHeaders']
                );
                chrome.windows.onRemoved.addListener(onRemoved);
            });
        });
    },

    /**
     * Silent refresh — проверить что токен ещё жив.
     * Токен TP живёт ~351 день, поэтому refresh = проверка GET /tl/users/me.
     *
     * Возвращает: { ok: true, token } или { ok: false, reason }
     */
    async silentRefresh() {
        const data = await chrome.storage.local.get([STORAGE_KEYS.token, STORAGE_KEYS.tokenMeta]);
        const currentToken = data[STORAGE_KEYS.token];

        if (!currentToken) {
            return { ok: false, reason: 'no_token' };
        }

        const installationId = await getInstallationId();

        try {
            const resp = await fetch(`${TP_AUTH_CONFIG.apiBase}/tl/users/me`, {
                method: 'GET',
                headers: {
                    'x-auth-token': currentToken,
                    'client': TP_AUTH_CONFIG.clientHeader,
                    'Installation-ID': installationId,
                    'Content-Type': 'application/json',
                    'Origin': TP_AUTH_CONFIG.loadboardUrl,
                    'Referer': TP_AUTH_CONFIG.loadboardUrl + '/'
                }
            });

            if (!resp.ok) {
                console.warn(`[AIDA/Auth/TP] silentRefresh failed: HTTP ${resp.status}`);
                if (resp.status === 401 || resp.status === 403) {
                    return { ok: false, reason: 'session_expired' };
                }
                return { ok: false, reason: `http_${resp.status}` };
            }

            const result = await resp.json();
            if (result.code === 200) {
                // Обновляем мета (подтверждение что живой)
                const meta = data[STORAGE_KEYS.tokenMeta] || {};
                meta.lastChecked = Date.now();
                await chrome.storage.local.set({ [STORAGE_KEYS.tokenMeta]: meta });
                return { ok: true, token: currentToken };
            }

            // code != 200 — токен невалидный
            console.warn('[AIDA/Auth/TP] silentRefresh: users/me returned code', result.code);
            return { ok: false, reason: 'invalid_token' };

        } catch (e) {
            console.warn('[AIDA/Auth/TP] silentRefresh error:', e.message);
            return { ok: false, reason: e.message };
        }
    },

    /**
     * Получить актуальный токен.
     * Стратегия «Refresh at every use» (§18 ТЗ):
     * - Токен есть → вернуть + silentRefresh() fire-and-forget
     * - Токена нет → null
     */
    async getToken() {
        const data = await chrome.storage.local.get([STORAGE_KEYS.token, STORAGE_KEYS.tokenMeta]);
        const token = data[STORAGE_KEYS.token];
        const meta = data[STORAGE_KEYS.tokenMeta];

        if (!token) return null;

        // Валидация формата
        if (!this._isValidToken(token)) {
            console.warn('[AIDA/Auth/TP] getToken: stored token invalid format, clearing');
            await chrome.storage.local.remove([STORAGE_KEYS.token, STORAGE_KEYS.tokenMeta]);
            return null;
        }

        if (meta?.expiresAt) {
            const now = Date.now();
            if (now >= meta.expiresAt) {
                // Протух → блокирующий refresh
                const result = await this.silentRefresh();
                if (result.ok) return result.token;
                return null;
            }
        }

        // Токен жив → вернуть + проверка в фоне (fire-and-forget)
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
     * Проверить формат токена TP: r:{hex32}
     */
    _isValidToken(token) {
        if (!token || typeof token !== 'string') return false;
        return /^r:[0-9a-f]{20,40}$/.test(token);
    },

    /**
     * Сохранить токен + мета-данные в Storage.
     */
    async _saveToken(token, source) {
        if (!this._isValidToken(token)) {
            console.warn('[AIDA/Auth/TP] _saveToken REJECTED: invalid format (source:', source, ')');
            return;
        }

        const now = Date.now();
        const installationId = await getInstallationId();
        const meta = {
            issuedAt: now,
            expiresAt: now + (TP_AUTH_CONFIG.tokenLifetimeSec * 1000),
            installationId,
            lastChecked: now,
            source  // 'login' | 'silent_refresh'
        };

        await chrome.storage.local.set({
            [STORAGE_KEYS.token]: token,
            [STORAGE_KEYS.tokenMeta]: meta
        });
        console.log(`[AIDA/Auth/TP] Token saved (source: ${source})`);
    },

    /**
     * Генерация MD5 подписи для login endpoint.
     * signature = MD5("device_token=&email={email}&grant_type=password&password={password}
     *   &installationId={uuid}&secret=eyFsGFeZ@Sajb$ZW&timestamp={ts}&url=/tl/login/web/v2")
     */
    _generateSignature(email, password, timestamp, installationId) {
        const raw = `device_token=&email=${email}&grant_type=password&password=${password}` +
            `&installationId=${installationId}&secret=${TP_AUTH_CONFIG.loginSecret}` +
            `&timestamp=${timestamp}&url=/tl/login/web/v2`;
        return md5(raw);
    },

    /**
     * Прямой API логин (для будущего использования — если знаем email/password).
     * POST /tl/login/web/v2
     */
    async _directLogin(email, password) {
        const installationId = await getInstallationId();
        const timestamp = Date.now();
        const signature = this._generateSignature(email, password, timestamp, installationId);

        const resp = await fetch(`${TP_AUTH_CONFIG.apiBase}/tl/login/web/v2`, {
            method: 'POST',
            headers: {
                'client': TP_AUTH_CONFIG.clientHeader,
                'timestamp': String(timestamp),
                'Installation-ID': installationId,
                'signature': signature,
                'Content-Type': 'application/json;charset=UTF-8',
                'Origin': TP_AUTH_CONFIG.loadboardUrl,
                'Referer': TP_AUTH_CONFIG.loadboardUrl + '/'
            },
            body: JSON.stringify({
                email,
                password,
                is_reactive: 0,
                grant_type: 'password',
                device_token: ''
            })
        });

        if (!resp.ok) {
            throw new Error(`Login failed: HTTP ${resp.status}`);
        }

        const result = await resp.json();

        if (result.code !== 200 || !result.data?.token) {
            throw new Error(`Login failed: ${result.message || 'unknown error'}`);
        }

        const token = result.data.token;
        await this._saveToken(token, 'direct_login');

        return { ok: true, token };
    },
};

export default AuthTruckerpath;
export { TP_AUTH_CONFIG, STORAGE_KEYS };
