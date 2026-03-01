/**
 * AIDA — мост из мира страницы (MAIN) в background.
 * Работает в изолированном мире content script, где доступен chrome.runtime.
 * Слушает postMessage от харвестера (MAIN) и пересылает в background.
 */
(function () {
    'use strict';

    window.addEventListener('message', function (event) {
        if (!event.data || event.data.source !== 'aida-harvester') return;
        var payload = event.data.payload;
        if (!payload || !payload.type) return;
        try {
            chrome.runtime.sendMessage(payload, function () {
                if (chrome.runtime.lastError) {
                    console.warn('[AIDA/Bridge] sendMessage error:', chrome.runtime.lastError.message);
                }
            });
        } catch (e) {
            console.warn('[AIDA/Bridge] sendMessage failed:', e.message);
        }
    });

    console.log('[AIDA/Bridge] listening for harvester messages');
})();
