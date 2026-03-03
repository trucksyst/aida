/**
 * AIDA v0.1 — Harvester TruckerPath
 * Content script (MAIN world) на loadboard.truckerpath.com.
 * Только перехват запросов/ответов (fetch, XHR). DOM не трогаем (ТЗ п.4).
 */

(function () {
    'use strict';

    if (window.__aidaHarvesterTruckerpath) {
        console.log('[AIDA/Harvester] TruckerPath harvester already loaded, re-patching fetch/XHR');
    }
    window.__aidaHarvesterTruckerpath = true;
    var _build = '0.1.28';
    console.log('[AIDA/Harvester] TruckerPath harvester loaded — build ' + _build);

    function sendToBridge(payload) {
        try {
            window.postMessage({ source: 'aida-harvester', payload: payload }, '*');
        } catch (e) {
            console.warn('[AIDA/Harvester] TruckerPath postMessage failed:', e && e.message);
        }
    }

    /** Основной endpoint поиска TP — /tl/search/filter/web/v2 */
    var PRIMARY_SEARCH_PATH = '/tl/search/filter/';

    /** URL исключений — рекомендации, не поиск */
    var EXCLUDED_PATHS = ['truckloads-similar', '/exposure/', '/similar/'];

    /** Проверка: это основной поисковый endpoint? */
    function isPrimarySearchUrl(url) {
        if (!url) return false;
        var u = String(url).toLowerCase();
        return u.indexOf('api.truckerpath.com') !== -1 && u.indexOf(PRIMARY_SEARCH_PATH) !== -1;
    }

    /** Проверка: это fallback поисковый URL (шире, но без рекомендаций)? */
    function isFallbackSearchUrl(url) {
        if (!url) return false;
        var u = String(url).toLowerCase();
        var isTpDomain = u.indexOf('loadboard.truckerpath.com') !== -1 || u.indexOf('api.truckerpath.com') !== -1;
        if (!isTpDomain) return false;
        // Исключаем рекомендации
        for (var i = 0; i < EXCLUDED_PATHS.length; i++) {
            if (u.indexOf(EXCLUDED_PATHS[i]) !== -1) return false;
        }
        return u.indexOf('/search') !== -1 || u.indexOf('/loads') !== -1 || u.indexOf('graphql') !== -1;
    }

    /** Любой TP поисковый URL (primary или fallback) */
    function isSearchUrl(url) {
        return isPrimarySearchUrl(url) || isFallbackSearchUrl(url);
    }

    function isLikelyLoadObject(obj) {
        if (!obj || typeof obj !== 'object') return false;
        return !!(
            obj.origin || obj.destination ||
            obj.originCity || obj.destinationCity ||
            obj.pickupLocation || obj.dropoffLocation ||
            obj.tripDistance || obj.miles || obj.distance
        );
    }

    /** Безопасно проверить один элемент — не обращаемся к числовым ключам типа '9' по несуществующему объекту. */
    function safeFirstElement(arr) {
        if (!Array.isArray(arr) || arr.length === 0) return null;
        return arr[0] != null && typeof arr[0] === 'object' ? arr[0] : null;
    }

    /** Объект с числовыми ключами 0,1,2,... в массив (ответы TP иногда приходят так). */
    function objectToArray(obj) {
        if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;
        var keys = Object.keys(obj).filter(function (k) { return /^\d+$/.test(k); });
        if (keys.length === 0) return null;
        keys.sort(function (a, b) { return Number(a) - Number(b); });
        var out = [];
        for (var i = 0; i < keys.length; i++) {
            var el = obj[keys[i]];
            if (el != null && typeof el === 'object') out.push(el);
        }
        return out.length > 0 ? out : null;
    }

    /** Извлекаем массив грузов из ответа; поддерживаем GraphQL, edges[].node, объекты с ключами 0,1,2. */
    function findLoadsArray(data) {
        if (!data || typeof data !== 'object') return null;
        if (Array.isArray(data) && data.length > 0) {
            var first = safeFirstElement(data);
            if (first && isLikelyLoadObject(first)) return data;
            if (first && first.node != null && isLikelyLoadObject(first.node)) {
                return data.map(function (e) { return e && e.node; }).filter(Boolean);
            }
        }
        var asArr = objectToArray(data);
        if (asArr && asArr.length > 0 && safeFirstElement(asArr) && isLikelyLoadObject(asArr[0])) return asArr;
        var candidates = ['loads', 'results', 'items', 'records', 'edges', 'nodes', 'data'];
        for (var i = 0; i < candidates.length; i++) {
            var key = candidates[i];
            var val = data[key];
            if (Array.isArray(val) && val.length > 0) {
                var firstEl = safeFirstElement(val);
                if (firstEl && isLikelyLoadObject(firstEl)) return val;
                if (firstEl && firstEl.node != null && isLikelyLoadObject(firstEl.node)) {
                    return val.map(function (e) { return e && e.node; }).filter(Boolean);
                }
            }
            if (val != null && typeof val === 'object' && !Array.isArray(val)) {
                var fromNested = findLoadsArray(val);
                if (fromNested) return fromNested;
            }
        }
        if (data.data && typeof data.data === 'object') {
            var inner = data.data.loadboardLoadsByRadiusAndLocation || data.data.loadboardLoads || data.data;
            if (inner && typeof inner === 'object') {
                var fromInner = findLoadsArray(inner);
                if (fromInner) return fromInner;
            }
        }
        for (var k in data) {
            if (!Object.prototype.hasOwnProperty.call(data, k)) continue;
            var nested = data[k];
            if (nested != null && typeof nested === 'object') {
                var found = findLoadsArray(nested);
                if (found) return found;
            }
        }
        return null;
    }

    function captureRequest(url, method, headers, body) {
        // Захватываем template только от основного поискового endpoint
        if (!isPrimarySearchUrl(url)) return;
        sendToBridge({
            type: 'TP_SEARCH_REQUEST_CAPTURED',
            url: url,
            method: method || 'GET',
            headers: headers && typeof headers === 'object' ? headers : {},
            body: typeof body === 'string' ? body : (body ? JSON.stringify(body) : null)
        });
    }

    /** _primaryCaptured — был ли уже перехват с основного endpoint в этой сессии */
    var _primaryCaptured = false;

    function captureJsonResponse(rawText, url) {
        try {
            var text = typeof rawText === 'string' ? rawText.trim() : '';
            if (!text || text.charAt(0) === '<') {
                if (text && text.charAt(0) === '<') {
                    console.warn('[AIDA/Harvester] TruckerPath API returned HTML instead of JSON (login/redirect/error page). Ensure you are logged in on the tab.');
                }
                return false;
            }

            var isPrimary = isPrimarySearchUrl(url);
            var isFallback = !isPrimary && isFallbackSearchUrl(url);

            // Если primary уже перехвачен — fallback не нужен
            if (isFallback && _primaryCaptured) {
                return false;
            }

            var data = JSON.parse(text);
            if (!data || typeof data !== 'object') return false;
            if (data.errors && Array.isArray(data.errors) && data.errors.length > 0) return false;
            var rows = findLoadsArray(data);
            if (Array.isArray(rows) && rows.length > 0) {
                var source = isPrimary ? 'PRIMARY' : 'FALLBACK';
                console.log('[AIDA/Harvester] TP INTERCEPT [' + source + ']:', rows.length, 'loads from URL:', url);
                console.log('[AIDA/Harvester] TP card keys:', Object.keys(rows[0]).join(', '));
                console.log('[AIDA/Harvester] TP sample card:', rows[0]);
                sendToBridge({ type: 'TP_SEARCH_RESPONSE', results: rows, sourceUrl: url });
                if (isPrimary) _primaryCaptured = true;
                return true;
            }
        } catch (e) {
            if (e && typeof e.message === 'string' && e.message.indexOf('undefined') === -1) {
                console.warn('[AIDA/Harvester] TruckerPath parse error:', e.message);
            }
        }
        return false;
    }

    var origFetch = window.fetch;
    if (!origFetch) return;
    window.fetch = async function () {
        var args = Array.prototype.slice.call(arguments);
        var req = args[0];
        var opts = args[1] || {};
        var url = typeof req === 'string' ? req : (req && typeof req === 'object' && typeof req.url === 'string' ? req.url : '');
        var method = (opts && opts.method) || (req && req.method) || 'GET';
        var headersObj = {};
        try {
            var hs = (opts && opts.headers) || (req && req.headers);
            if (hs) {
                if (typeof Headers !== 'undefined' && hs instanceof Headers) {
                    hs.forEach(function (v, k) { if (k != null) headersObj[k] = v; });
                } else if (hs && typeof hs === 'object') headersObj = hs;
            }
            captureRequest(url, method, headersObj, opts && opts.body);
        } catch (_) { }
        var response = await origFetch.apply(this, args);
        if (response && typeof response.ok === 'boolean' && response.ok && isSearchUrl(url)) {
            try {
                var clone = response.clone();
                var text = await clone.text();
                captureJsonResponse(text, url);
            } catch (e) {
                console.warn('[AIDA/Harvester] TruckerPath fetch parse failed:', e && e.message);
            }
        }
        return response;
    };

    var origOpen = XMLHttpRequest.prototype.open;
    var origSetRequestHeader = XMLHttpRequest.prototype.setRequestHeader;
    var origSend = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.open = function (method, url) {
        this._aidaUrl = url;
        this._aidaMethod = method;
        this._aidaHeaders = {};
        return origOpen.apply(this, arguments);
    };
    XMLHttpRequest.prototype.setRequestHeader = function (name, value) {
        if (this._aidaHeaders) this._aidaHeaders[name] = value;
        return origSetRequestHeader.apply(this, arguments);
    };
    XMLHttpRequest.prototype.send = function () {
        var xhr = this;
        var url = typeof xhr._aidaUrl === 'string' ? xhr._aidaUrl : '';
        var shouldWatch = isSearchUrl(url);
        try {
            captureRequest(url, xhr._aidaMethod || 'GET', (xhr._aidaHeaders && typeof xhr._aidaHeaders === 'object') ? xhr._aidaHeaders : {}, arguments[0]);
        } catch (_) { }
        function onLoad() {
            if (!shouldWatch || xhr.readyState !== 4) return;
            var status = typeof xhr.status === 'number' ? xhr.status : 0;
            if (status < 200 || status >= 300) return;
            try {
                var respText = typeof xhr.responseText === 'string' ? xhr.responseText : '';
                captureJsonResponse(respText, url);
            } catch (e) {
                console.warn('[AIDA/Harvester] TruckerPath XHR parse failed:', e && e.message);
            }
        }
        if (shouldWatch) {
            if (typeof xhr.addEventListener === 'function') xhr.addEventListener('load', onLoad);
            else xhr.onreadystatechange = function () { if (xhr.readyState === 4) onLoad(); };
        }
        return origSend.apply(this, arguments);
    };
})();
