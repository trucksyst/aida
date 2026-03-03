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

/**
 * Реестр auth-модулей по бордам.
 * При добавлении нового борда — только добавить модуль сюда.
 */
const AUTH_MODULES = {
    dat: AuthDat,
    // truckstop: AuthTruckstop,   // TODO: реализовать
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
            console.warn(`[AIDA/Auth] No auth module for board: ${board}`);
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
    }
};

export default AuthManager;
export { SUPPORTED_BOARDS };
