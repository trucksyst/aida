/**
 * AIDA v0.1 — Harvester Truckstop
 * Content script (MAIN world) на truckstop.com.
 * Единственная задача: перехватить Bearer токен из исходящих запросов
 * и передать в background через postMessage → bridge (в MAIN мире нет chrome.runtime).
 *
 * Не трогает DOM. Не нажимает кнопки. Только слушает сеть.
 */

(function () {
    'use strict';

    if (window.__aidaHarvesterTruckstop) return;
    window.__aidaHarvesterTruckstop = true;

    let _lastToken = null;

    function sendToBridge(payload) {
        try {
            window.postMessage({ source: 'aida-harvester', payload: payload }, '*');
        } catch (e) {}
    }

    function sendToken(token) {
        if (!token || token === _lastToken) return;
        _lastToken = token;
        sendToBridge({ type: 'TOKEN_HARVESTED', board: 'truckstop', token: token });
    }

    // ============================================================
    // Patch fetch — перехват Bearer токена
    // ============================================================
    const origFetch = window.fetch;
    window.fetch = async function (...args) {
        const [, opts] = args;

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

        return origFetch.apply(this, args);
    };

    // ============================================================
    // Patch XMLHttpRequest — перехват Bearer токена
    // ============================================================
    const origOpen = XMLHttpRequest.prototype.open;
    const origSetRequestHeader = XMLHttpRequest.prototype.setRequestHeader;

    XMLHttpRequest.prototype.open = function (method, url, ...rest) {
        this._aidaUrl = url;
        return origOpen.call(this, method, url, ...rest);
    };

    XMLHttpRequest.prototype.setRequestHeader = function (name, value) {
        if (name && name.toLowerCase() === 'authorization') {
            if (value && value.startsWith('Bearer ')) {
                sendToken(value.slice(7));
            }
        }
        return origSetRequestHeader.call(this, name, value);
    };

})();
