/**
 * AIDA v0.1 — Harvester DAT
 * Content script (MAIN world) на one.dat.com.
 * Единственная задача: перехватить Bearer токен из исходящих запросов
 * и передать в background через chrome.runtime.sendMessage.
 *
 * Не трогает DOM. Не нажимает кнопки. Только слушает сеть.
 */

(function () {
    'use strict';

    if (window.__aidaHarvesterDat) return;
    window.__aidaHarvesterDat = true;

    let _lastToken = null;

    function sendToken(token) {
        if (!token || token === _lastToken) return;
        _lastToken = token;
        try {
            chrome.runtime.sendMessage({
                type: 'TOKEN_HARVESTED',
                board: 'dat',
                token
            });
        } catch (e) {
            // Extension context may be invalidated on reload
        }
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

        // Перехват ответа поиска грузов — те же данные, что видит страница
        if (url.indexOf(DAT_GRAPHQL_URL) !== -1 && url.indexOf(GRAPHQL_PATH) !== -1 && response.ok) {
            try {
                const clone = response.clone();
                const data = await clone.json();
                const root = data?.data?.freightSearchV4FindLoads || data?.data?.freightSearchFindLoads || data?.data?.findLoads || data?.data?.freightSearch;
                const results = root && (root.results || (Array.isArray(root) ? root : root.data));
                if (Array.isArray(results) && results.length > 0) {
                    chrome.runtime.sendMessage({
                        type: 'DAT_SEARCH_RESPONSE',
                        results: results
                    }).catch(function () {});
                }
            } catch (e) {
                // Не ломаем страницу при ошибке парсинга
            }
        }

        return response;
    };

    // ============================================================
    // Patch XMLHttpRequest — перехват Bearer токена
    // ============================================================
    const origOpen = XMLHttpRequest.prototype.open;
    const origSetRequestHeader = XMLHttpRequest.prototype.setRequestHeader;

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

})();
