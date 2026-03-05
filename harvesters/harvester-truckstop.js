/**
 * AIDA v0.1 — Harvester Truckstop
 * Content script (MAIN world) на truckstop.com.
 * Перехватывает: (1) Bearer токен из исходящих запросов; (2) ответ поиска грузов (REST/JSON).
 * Передача в background — через postMessage → bridge.
 *
 * Не трогает DOM. Только слушает сеть.
 */

(function () {
    'use strict';

    if (window.__aidaHarvesterTruckstop) return;
    window.__aidaHarvesterTruckstop = true;

    console.log('[AIDA/Harvester] Truckstop harvester loaded (truckstop.com page)');

    let _lastToken = null;

    /** Признак объекта «груз» (GraphQL: originCity/postedRate или вложенный origin/rate). */
    function isLoadItem(item) {
        if (!item || typeof item !== 'object') return false;
        return !!(item.originCity || item.origin || item.Origin || item.loadId || item.LoadId || item.id) &&
            (item.postedRate != null || item.rate != null || item.Rate != null || item.originCity != null);
    }

    /** Ищем массив грузов. GraphQL: data.get_loads_..., data.loadSearch.items. */
    function findLoadsArray(obj) {
        if (!obj || typeof obj !== 'object') return null;
        if (Array.isArray(obj) && obj.length > 0 && isLoadItem(obj[0])) return obj;
        var d = obj.data || obj.Data;
        if (d && typeof d === 'object') {
            var ls = d.loadSearch || d.LoadSearch;
            if (ls && Array.isArray(ls.items) && ls.items.length > 0) {
                console.log('[AIDA/Harvester] Step: Truckstop found data.loadSearch.items, len=', ls.items.length);
                return ls.items;
            }
            for (var k in d) {
                if (!Object.prototype.hasOwnProperty.call(d, k)) continue;
                var arr = d[k];
                if (Array.isArray(arr) && arr.length > 0 && isLoadItem(arr[0])) return arr;
            }
        }
        var keys = ['loads', 'Loads', 'results', 'Results', 'items', 'Items'];
        for (var i = 0; i < keys.length; i++) {
            var val = obj[keys[i]];
            if (Array.isArray(val) && val.length > 0 && isLoadItem(val[0])) return val;
        }
        for (var key in obj) {
            if (!Object.prototype.hasOwnProperty.call(obj, key)) continue;
            var found = findLoadsArray(obj[key]);
            if (found) return found;
        }
        return null;
    }

    function sendToBridge(payload) {
        console.log('[AIDA/Harvester] Step: postMessage to bridge (Truckstop)', payload.type);
        try {
            window.postMessage({ source: 'aida-harvester', payload: payload }, '*');
        } catch (e) {
            console.warn('[AIDA/Harvester] Truckstop postMessage failed:', e.message);
        }
    }

    function sendToken(token) {
        if (!token || token === _lastToken) return;
        _lastToken = token;
        console.log('[AIDA/Harvester] Step: Truckstop token captured, sending TOKEN_HARVESTED');
        sendToBridge({ type: 'TOKEN_HARVESTED', board: 'truckstop', token: token });
    }

    // ============================================================
    // Patch fetch — перехват токена и ответа поиска грузов
    // ============================================================
    const origFetch = window.fetch;
    // Load search: GraphQL на loadsearch-graphql-api-prod.truckstop.com (HAR main.truckstop.com)
    function isTruckstopSearchUrl(url) {
        return url.indexOf('loadsearch-graphql-api-prod.truckstop.com') !== -1 && url.indexOf('graphql') !== -1 ||
            (url.indexOf('api.truckstop.com') !== -1 && (url.indexOf('load') !== -1 || url.indexOf('search') !== -1));
    }

    /** Проверка: это URL v5-auth (token или renew) — ловим JWT из response body. */
    function isV5AuthTokenUrl(url) {
        return url.indexOf('v5-auth.truckstop.com/auth/token/') !== -1 ||
            url.indexOf('v5-auth.truckstop.com/auth/renew') !== -1;
    }

    window.fetch = async function (...args) {
        const url = (typeof args[0] === 'string' ? args[0] : (args[0] && args[0].url) || '').toString();
        const opts = args[1] || {};

        let auth = null;
        if (opts?.headers) {
            if (opts.headers instanceof Headers) {
                auth = opts.headers.get('Authorization') || opts.headers.get('authorization');
            } else {
                auth = opts.headers['Authorization'] || opts.headers['authorization'];
            }
        }
        if (auth && auth.startsWith('Bearer ')) {
            sendToken(auth.slice(7));
        }

        // Перехват запроса (до отправки) — для сохранения шаблона в Core
        if (isTruckstopSearchUrl(url) && (opts.method === 'POST' || opts.method === undefined) && opts.body) {
            try {
                var headersObj = {};
                if (opts.headers) {
                    if (opts.headers instanceof Headers) {
                        opts.headers.forEach(function (v, k) { headersObj[k] = v; });
                    } else if (typeof opts.headers === 'object') {
                        headersObj = opts.headers;
                    }
                }
                sendToBridge({
                    type: 'TS_SEARCH_REQUEST_CAPTURED',
                    url: url,
                    method: opts.method || 'POST',
                    headers: headersObj,
                    body: typeof opts.body === 'string' ? opts.body : (opts.body ? JSON.stringify(opts.body) : null)
                });
            } catch (e) {
                console.warn('[AIDA/Harvester] Truckstop request capture failed:', e && e.message);
            }
        }

        const response = await origFetch.apply(this, args);

        // ---- Перехват v5-auth token response (JWT из body) ----
        if (isV5AuthTokenUrl(url) && response.ok) {
            try {
                var tokenClone = response.clone();
                var tokenText = await tokenClone.text();
                if (tokenText && tokenText.trim().charAt(0) === '{') {
                    var tokenData = JSON.parse(tokenText);
                    var jwt = tokenData.accessToken || tokenData.access_token;
                    if (jwt) {
                        console.log('[AIDA/Harvester] Step: Truckstop v5-auth token captured from response');
                        sendToken(jwt);
                    }
                }
            } catch (e) {
                console.warn('[AIDA/Harvester] Step: Truckstop v5-auth parse error', e && e.message);
            }
        }

        var isSearchResponse = response.ok && isTruckstopSearchUrl(url);

        if (isSearchResponse) {
            console.log('[AIDA/Harvester] Step: Truckstop fetch search response detected, url=', url.slice(0, 90));
            try {
                var clone = response.clone();
                var text = await clone.text();
                if (!text || (text.trim().charAt(0) === '<')) {
                    console.warn('[AIDA/Harvester] Step: Truckstop response is HTML, not JSON (possible error page or redirect)');
                    return response;
                }
                var data = JSON.parse(text);
                var results = null;
                if (data && typeof data === 'object') {
                    results = findLoadsArray(data);
                }
                if (Array.isArray(results) && results.length > 0) {
                    console.log('[AIDA/Harvester] Step: Truckstop parsed', results.length, 'results, sending TS_SEARCH_RESPONSE');
                    sendToBridge({ type: 'TS_SEARCH_RESPONSE', results: results, token: _lastToken });
                } else {
                    console.log('[AIDA/Harvester] Step: Truckstop no loads array in response (keys:', data ? Object.keys(data).slice(0, 10).join(', ') : 'none', ')');
                }
            } catch (e) {
                console.warn('[AIDA/Harvester] Step: Truckstop parse error', e && e.message);
            }
        }

        return response;
    };

    // ============================================================
    // Patch XMLHttpRequest — перехват токена и ответа поиска
    // ============================================================
    const origOpen = XMLHttpRequest.prototype.open;
    const origSetRequestHeader = XMLHttpRequest.prototype.setRequestHeader;
    const origSend = XMLHttpRequest.prototype.send;

    XMLHttpRequest.prototype.open = function (method, url, ...rest) {
        this._aidaUrl = url;
        this._aidaMethod = method;
        this._aidaHeaders = {};
        return origOpen.call(this, method, url, ...rest);
    };

    XMLHttpRequest.prototype.setRequestHeader = function (name, value) {
        if (name && name.toLowerCase() === 'authorization') {
            if (value && value.startsWith('Bearer ')) {
                sendToken(value.slice(7));
            }
        }
        if (this._aidaHeaders) this._aidaHeaders[name] = value;
        return origSetRequestHeader.call(this, name, value);
    };

    XMLHttpRequest.prototype.send = function (body) {
        var xhr = this;
        var url = (xhr._aidaUrl || '').toString();
        var isSearch = isTruckstopSearchUrl(url);
        var isV5Auth = isV5AuthTokenUrl(url);

        // Перехват запроса (до отправки) — для сохранения шаблона в Core
        if (isSearch && (xhr._aidaMethod === 'POST' || xhr._aidaMethod === 'post') && body) {
            try {
                sendToBridge({
                    type: 'TS_SEARCH_REQUEST_CAPTURED',
                    url: url,
                    method: xhr._aidaMethod || 'POST',
                    headers: xhr._aidaHeaders || {},
                    body: typeof body === 'string' ? body : (body ? JSON.stringify(body) : null)
                });
            } catch (e) {
                console.warn('[AIDA/Harvester] Truckstop XHR request capture failed:', e && e.message);
            }
        }

        function onLoad() {
            // v5-auth token interception
            if (isV5Auth && xhr.readyState === 4 && xhr.status >= 200 && xhr.status < 300) {
                try {
                    var text = xhr.responseText;
                    if (text && text.trim().charAt(0) === '{') {
                        var data = JSON.parse(text);
                        var jwt = data.accessToken || data.access_token;
                        if (jwt) {
                            console.log('[AIDA/Harvester] Step: Truckstop v5-auth XHR token captured');
                            sendToken(jwt);
                        }
                    }
                } catch (e) {
                    console.warn('[AIDA/Harvester] Step: Truckstop v5-auth XHR parse error', e && e.message);
                }
            }
            if (!isSearch || xhr.readyState !== 4 || xhr.status < 200 || xhr.status >= 300) return;
            try {
                var text = xhr.responseText;
                if (!text) return;
                if (text.trim().charAt(0) === '<') {
                    console.warn('[AIDA/Harvester] Step: Truckstop XHR response is HTML, not JSON (possible error page or redirect)');
                    return;
                }
                console.log('[AIDA/Harvester] Step: Truckstop XHR search response, url=', url.slice(0, 90));
                var data = JSON.parse(text);
                var results = null;
                if (data && typeof data === 'object') {
                    results = findLoadsArray(data);
                }
                if (Array.isArray(results) && results.length > 0) {
                    console.log('[AIDA/Harvester] Step: Truckstop XHR parsed', results.length, 'results, sending TS_SEARCH_RESPONSE');
                    sendToBridge({ type: 'TS_SEARCH_RESPONSE', results: results, token: _lastToken });
                } else {
                    console.log('[AIDA/Harvester] Step: Truckstop XHR no loads array');
                }
            } catch (e) {
                console.warn('[AIDA/Harvester] Step: Truckstop XHR parse error', e && e.message);
            }
        }
        if (isSearch || isV5Auth) {
            if (xhr.addEventListener) {
                xhr.addEventListener('load', onLoad);
            } else {
                xhr.onreadystatechange = function () {
                    if (xhr.readyState === 4) onLoad();
                };
            }
        }
        return origSend.apply(this, arguments);
    };

})();
