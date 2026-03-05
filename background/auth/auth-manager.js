/**
 * AIDA v0.1 — Auth Manager
 *
 * Единая точка входа для авторизации всех лоадбордов.
 * Core обращается только к этому модулю — не знает деталей авторизации бордов.
 *
 * API:
 *   authManager.login(board)       → открыть popup логина
 *   authManager.getToken(board)    → получить актуальный токен (с авто-refresh)
 *   authManager.getStatus(board)   → 'connected' | 'expired' | 'disconnected'
 *   authManager.getAllStatuses()    → { dat: {...}, truckstop: {...}, tp: {...} }
 *   authManager.disconnect(board)  → удалить токен
 *
 * Совместимость: пишет токены в те же ключи Storage (token:dat, token:truckstop),
 * что и текущие харвестеры. Адаптеры продолжают работать без изменений.
 */

import AuthDat from './auth-dat.js';
import AuthTruckstop from './auth-truckstop.js';

/**
 * Реестр auth-модулей по бордам.
 * При добавлении нового борда — только добавить модуль сюда.
 */
const AUTH_MODULES = {
    dat: AuthDat,
    truckstop: AuthTruckstop,
    // tp: AuthTruckerpath,        // TODO: реализовать
};

/** Список поддерживаемых бордов */
const SUPPORTED_BOARDS = ['dat', 'truckstop', 'tp'];

const AuthManager = {

    /**
     * Открыть popup логина для борда.
     * @param {string} board — 'dat' | 'truckstop' | 'tp'
     * @returns {Promise<{ok, token?, error?}>}
     */
    async login(board) {
        const module = AUTH_MODULES[board];
        if (!module) {
            // Борды без auth-модуля — открываем сайт борда в popup.
            // Юзер залогинится → харвестер поймает токен/шаблон.
            const url = this._boardUrls[board];
            if (url) {
                console.log(`[AIDA/Auth] Opening fallback login popup for ${board}: ${url}`);
                const success = await this._openFallbackPopup(board, url);
                return { ok: success };
            }
            console.warn(`[AIDA/Auth] No auth module and no URL for board: ${board}`);
            return { ok: false, error: `Auth not implemented for ${board}` };
        }
        try {
            const result = await module.login();
            console.log(`[AIDA/Auth] Step: login(${board}) — ok:${result.ok}`);
            return result;
        } catch (e) {
            console.warn(`[AIDA/Auth] login(${board}) failed:`, e.message);
            return { ok: false, error: e.message };
        }
    },

    /**
     * Получить актуальный токен.
     * Авто-refresh при необходимости (для бордов с auth-модулем).
     * Fallback: для бордов без auth-модуля читает из Storage напрямую.
     *
     * @param {string} board
     * @returns {Promise<string|null>}
     */
    async getToken(board) {
        const module = AUTH_MODULES[board];
        if (module) {
            return module.getToken();
        }
        // Fallback: для бордов без auth-модуля — читаем токен из Storage как раньше
        const key = `token:${board}`;
        const data = await chrome.storage.local.get(key);
        return data[key] || null;
    },

    /**
     * Статус подключения борда.
     * @param {string} board
     * @returns {Promise<'connected'|'expired'|'disconnected'>}
     */
    async getStatus(board) {
        const module = AUTH_MODULES[board];
        if (module) {
            return module.getStatus();
        }
        // Fallback: есть токен → connected, нет → disconnected
        const key = `token:${board}`;
        const data = await chrome.storage.local.get(key);
        return data[key] ? 'connected' : 'disconnected';
    },

    /**
     * Получить статусы всех бордов.
     * Формат совместим с текущим boardStatus в getSettingsForUI().
     */
    async getAllStatuses() {
        const statuses = {};
        for (const board of SUPPORTED_BOARDS) {
            const status = await this.getStatus(board);
            const hasAuthModule = !!AUTH_MODULES[board];
            statuses[board] = {
                connected: status === 'connected',
                status,
                hasAuthModule,
                // Для обратной совместимости с текущим UI
                hasToken: status !== 'disconnected',
                disabled: false  // будет перезаписано из settings.disabledBoards
            };
        }
        return statuses;
    },

    /**
     * Silent refresh токена для борда (если поддерживается).
     */
    async silentRefresh(board) {
        const module = AUTH_MODULES[board];
        if (!module || !module.silentRefresh) {
            return { ok: false, reason: 'not_supported' };
        }
        return module.silentRefresh();
    },

    /**
     * Отключить борд — удалить токен.
     */
    async disconnect(board) {
        const module = AUTH_MODULES[board];
        if (module) {
            await module.disconnect();
        } else {
            await chrome.storage.local.remove(`token:${board}`);
        }
        console.log(`[AIDA/Auth] Disconnected: ${board}`);
    },

    /**
     * Обработка токена от харвестера.
     * Харвестер как и раньше отправляет TOKEN_HARVESTED — совместимость сохранена.
     * Но теперь мы также обновляем мета-данные auth-модуля.
     */
    async handleHarvestedToken(board, token) {
        if (!token) return;
        const module = AUTH_MODULES[board];
        if (module && module._saveToken) {
            // Обновляем через auth-модуль (с мета-данными expiry и т.д.)
            await module._saveToken(token, 'harvester');
        } else {
            // Для бордов без auth-модуля — пишем напрямую как раньше
            await chrome.storage.local.set({ [`token:${board}`]: token });
        }
    },

    /**
     * URL-ы бордов для fallback popup (борды без auth-модуля).
     * Юзер залогинится на сайте → харвестер поймает токен/шаблон → popup закроется.
     */
    _boardUrls: {
        dat: 'https://one.dat.com/search-loads',
        truckstop: 'https://main.truckstop.com/find-loads',
        tp: 'https://fleet.truckerpath.com/loads'
    },

    /**
     * Автоматическое разрешение auth-ошибок от адаптеров.
     * Вызывается из searchLoads() когда адаптеры вернули AUTH_REQUIRED или NO_TEMPLATE.
     *
     * Очередь popup'ов: DAT → Truckstop → TP (один за другим).
     * Для каждого борда:
     *   1. Сначала silent refresh (если есть auth-модуль) — без участия юзера
     *   2. Если не помогло → popup login (auth-модуль или fallback к сайту борда)
     *   3. Для fallback → открыть сайт борда, ждать харвестер
     *
     * @param {Array<{board: string, error: object}>} authErrors — борды с AUTH_REQUIRED/NO_TEMPLATE
     * @returns {Promise<{resolved: string[], failed: string[]}>}
     */
    async autoResolveAuthErrors(authErrors) {
        if (!authErrors || authErrors.length === 0) return { resolved: [], failed: [] };

        // Приоритет: DAT → Truckstop → TP
        const priority = ['dat', 'truckstop', 'tp'];
        const sorted = authErrors.sort((a, b) =>
            priority.indexOf(a.board) - priority.indexOf(b.board)
        );

        const resolved = [];
        const failed = [];

        for (const { board, error } of sorted) {
            console.log(`[AIDA/Auth] Auto-resolving auth for: ${board} (${error?.code})`);
            const module = AUTH_MODULES[board];

            // Борды без auth-модуля (Truckstop, TP) — НЕ открываем popup автоматически.
            // Popup для них только при ручном клике юзера на кнопку.
            if (!module) {
                console.log(`[AIDA/Auth] Skipping ${board} — no auth module (auto-popup disabled)`);
                failed.push(board);
                continue;
            }

            // Шаг 1: silent refresh (если есть auth-модуль)
            if (module && module.silentRefresh) {
                console.log(`[AIDA/Auth] Trying silent refresh for ${board}...`);
                const refreshResult = await module.silentRefresh();
                if (refreshResult.ok) {
                    console.log(`[AIDA/Auth] Silent refresh OK for ${board}`);
                    resolved.push(board);
                    continue;
                }
                console.log(`[AIDA/Auth] Silent refresh failed for ${board}: ${refreshResult.reason}`);
            }

            // Шаг 2: popup login через auth-модуль
            try {
                console.log(`[AIDA/Auth] Opening popup login for ${board}...`);
                const loginResult = await module.login();
                if (loginResult.ok) {
                    console.log(`[AIDA/Auth] Popup login OK for ${board}`);
                    resolved.push(board);
                    continue;
                }
                console.warn(`[AIDA/Auth] Popup login failed for ${board}: ${loginResult.error}`);
            } catch (e) {
                console.warn(`[AIDA/Auth] Popup login error for ${board}:`, e.message);
            }
            failed.push(board);

        }

        return { resolved, failed };
    },

    /**
     * Открыть fallback popup для борда без auth-модуля.
     * Ждёт пока харвестер пришлёт TOKEN_HARVESTED для этого борда,
     * или пока юзер закроет popup вручную.
     * Таймаут: 2 минуты.
     */
    _openFallbackPopup(board, url) {
        return new Promise((resolve) => {
            chrome.windows.create({
                url,
                type: 'popup',
                width: 1100,
                height: 750,
                focused: true
            }, (win) => {
                if (!win) {
                    resolve(false);
                    return;
                }

                const popupWindowId = win.id;
                let done = false;

                const timeout = setTimeout(() => {
                    if (!done) {
                        done = true;
                        cleanup();
                        chrome.windows.remove(popupWindowId).catch(() => { });
                        resolve(false);
                    }
                }, 120000); // 2 минуты

                // Слушаем TOKEN_HARVESTED от харвестера
                const onMessage = (message) => {
                    if (done) return;
                    if (message.type === 'TOKEN_HARVESTED' && message.board === board) {
                        done = true;
                        clearTimeout(timeout);
                        cleanup();
                        // Даём харвестеру 1 сек записать токен, потом закрываем
                        setTimeout(() => {
                            chrome.windows.remove(popupWindowId).catch(() => { });
                        }, 1000);
                        resolve(true);
                    }
                    // Для TruckerPath — слушаем TP_SEARCH_REQUEST_CAPTURED
                    if (board === 'tp' && message.type === 'TP_SEARCH_REQUEST_CAPTURED') {
                        done = true;
                        clearTimeout(timeout);
                        cleanup();
                        setTimeout(() => {
                            chrome.windows.remove(popupWindowId).catch(() => { });
                        }, 1000);
                        resolve(true);
                    }
                    // Для Truckstop — слушаем TS_SEARCH_REQUEST_CAPTURED
                    if (board === 'truckstop' && message.type === 'TS_SEARCH_REQUEST_CAPTURED') {
                        done = true;
                        clearTimeout(timeout);
                        cleanup();
                        setTimeout(() => {
                            chrome.windows.remove(popupWindowId).catch(() => { });
                        }, 1000);
                        resolve(true);
                    }
                };

                // Если popup закрыт юзером
                const onRemoved = (windowId) => {
                    if (windowId !== popupWindowId) return;
                    if (!done) {
                        done = true;
                        clearTimeout(timeout);
                        cleanup();
                        resolve(false);
                    }
                };

                const cleanup = () => {
                    chrome.runtime.onMessage.removeListener(onMessage);
                    chrome.windows.onRemoved.removeListener(onRemoved);
                };

                chrome.runtime.onMessage.addListener(onMessage);
                chrome.windows.onRemoved.addListener(onRemoved);
            });
        });
    }
};

export default AuthManager;
export { SUPPORTED_BOARDS };
