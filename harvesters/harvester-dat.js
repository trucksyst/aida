/**
 * AIDA v0.1 — Harvester DAT
 * Content script (MAIN world) на one.dat.com.
 * Перехватывает: (1) Bearer токен из заголовков запросов; (2) ответ поиска грузов (GraphQL).
 *
 * Запрос с сайта: POST freight.api.dat.com/one-web-bff/graphql, operationName "FindLoads",
 * variables.criteria (lane.origin.place, destination, equipment.classes, availability.earliestWhen/latestWhen и т.д.).
 * Ответ: data.freightSearchV4.findLoads.results[] — тот же путь, что и для freightSearchV4FindLoads.
 * Ниже мы парсим оба варианта (freightSearchV4.findLoads и freightSearchV4FindLoads).
 *
 * Не трогает DOM. Только слушает сеть. Передача в background — через postMessage → bridge.
 */

(function () {
    'use strict';

    if (window.__aidaHarvesterDat) return;
    window.__aidaHarvesterDat = true;
    console.log('[AIDA/Harvester] DAT harvester loaded (one.dat.com page)');

    let _lastToken = null;

    function findLoadsArray(obj) {
        if (!obj || typeof obj !== 'object') return null;
        if (Array.isArray(obj) && obj.length > 0) {
            var first = obj[0];
            if (first && typeof first === 'object' && (first.assetInfo || first.resultId || first.postingId || first.origin)) return obj;
        }
        for (var key in obj) {
            if (!Object.prototype.hasOwnProperty.call(obj, key)) continue;
            var found = findLoadsArray(obj[key]);
            if (found) return found;
        }
        return null;
    }

    function sendToBridge(payload) {
        console.log('[AIDA/Harvester] Step: postMessage to bridge', payload.type);
        try {
            window.postMessage({ source: 'aida-harvester', payload: payload }, '*');
        } catch (e) {
            console.warn('[AIDA/Harvester] postMessage failed:', e.message);
        }
    }

    function sendToken(token) {
        if (!token || token === _lastToken) return;
        _lastToken = token;
        sendToBridge({ type: 'TOKEN_HARVESTED', board: 'dat', token: token });
    }

    // ============================================================
    // Patch fetch — перехват токена и ответа поиска грузов
    // ============================================================
    const origFetch = window.fetch;
    const DAT_GRAPHQL_URL = 'freight.api.dat.com';
    const GRAPHQL_PATH = 'graphql';

    window.fetch = async function (...args) {
        const url = typeof args[0] === 'string' ? args[0] : (args[0] && args[0].url) || '';
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

        const response = await origFetch.apply(this, args);

        var isSearchResponse = response.ok && (
            (url.indexOf('freight.api.dat.com') !== -1 && url.indexOf('graphql') !== -1) ||
            (url.indexOf('one.dat.com/graphql') !== -1) ||
            (url.indexOf('api.dat.com') !== -1 && (url.indexOf('loads') !== -1 || url.indexOf('search') !== -1))
        );
        if (isSearchResponse) {
            console.log('[AIDA/Harvester] Step: fetch search response detected, url=', url.slice(0, 80));
            try {
                var clone = response.clone();
                var data = await clone.json();
                var results = null;
                if (data && typeof data === 'object') {
                    var d = data.data || data;
                    // Ответ с сайта: data.freightSearchV4.findLoads (операция FindLoads); ответ старого API: freightSearchV4FindLoads
                    var root = d && (d.freightSearchV4FindLoads || (d.freightSearchV4 && d.freightSearchV4.findLoads) || d.freightSearchFindLoads || d.findLoads || d.freightSearch);
                    if (root) {
                        results = root.results || (Array.isArray(root) ? root : root.data);
                    }
                    if (!results && Array.isArray(data.loads)) results = data.loads;
                    if (!results && Array.isArray(data.results)) results = data.results;
                    if (!results && d && Array.isArray(d)) results = d;
                    if (!results) results = findLoadsArray(data);
                }
                if (Array.isArray(results) && results.length > 0) {
                    var searchId = root && root.searchId || null;
                    console.log('[AIDA/Harvester] Step: parsed', results.length, 'results, searchId:', searchId, 'sending DAT_SEARCH_RESPONSE');
                    sendToBridge({ type: 'DAT_SEARCH_RESPONSE', results: results, searchId: searchId, token: _lastToken });
                } else {
                    console.log('[AIDA/Harvester] Step: no results array in response (results=', results ? results.length : null, ')');
                }
            } catch (e) {
                console.warn('[AIDA/Harvester] Step: parse error', e && e.message);
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
        this._aidaHeaders = {};
        return origOpen.call(this, method, url, ...rest);
    };

    XMLHttpRequest.prototype.setRequestHeader = function (name, value) {
        if (name && (name.toLowerCase() === 'authorization')) {
            if (value && value.startsWith('Bearer ')) {
                sendToken(value.slice(7));
            }
        }
        if (this._aidaHeaders) {
            this._aidaHeaders[name] = value;
        }
        return origSetRequestHeader.call(this, name, value);
    };

    XMLHttpRequest.prototype.send = function (body) {
        var xhr = this;
        var url = (xhr._aidaUrl || '').toString();
        var isSearch = url.indexOf('freight.api.dat.com') !== -1 && url.indexOf('graphql') !== -1 ||
            url.indexOf('one.dat.com/graphql') !== -1 ||
            (url.indexOf('api.dat.com') !== -1 && (url.indexOf('loads') !== -1 || url.indexOf('search') !== -1));
        function onLoad() {
            if (!isSearch || xhr.readyState !== 4 || xhr.status < 200 || xhr.status >= 300) return;
            try {
                var text = xhr.responseText;
                if (!text) return;
                console.log('[AIDA/Harvester] Step: XHR search response, url=', url.slice(0, 80));
                var data = JSON.parse(text);
                var results = null;
                if (data && typeof data === 'object') {
                    var d = data.data || data;
                    var root = d && (d.freightSearchV4FindLoads || (d.freightSearchV4 && d.freightSearchV4.findLoads) || d.freightSearchFindLoads || d.findLoads || d.freightSearch);
                    if (root) results = root.results || (Array.isArray(root) ? root : root.data);
                    // XHR: тот же путь, что и в fetch (FindLoads → data.freightSearchV4.findLoads.results)
                    if (!results && Array.isArray(data.loads)) results = data.loads;
                    if (!results && Array.isArray(data.results)) results = data.results;
                    if (!results && d && Array.isArray(d)) results = d;
                    if (!results) results = findLoadsArray(data);
                }
                if (Array.isArray(results) && results.length > 0) {
                    var searchId = root && root.searchId || null;
                    console.log('[AIDA/Harvester] Step: XHR parsed', results.length, 'results, searchId:', searchId, 'sending DAT_SEARCH_RESPONSE');
                    sendToBridge({ type: 'DAT_SEARCH_RESPONSE', results: results, searchId: searchId, token: _lastToken });
                } else {
                    console.log('[AIDA/Harvester] Step: XHR no results array (results=', results ? results.length : null, ')');
                }
            } catch (e) {
                console.warn('[AIDA/Harvester] Step: XHR parse error', e && e.message);
            }
        }
        if (isSearch) {
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
