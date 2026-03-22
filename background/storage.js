/**
 * AIDA v0.1 — Storage
 * Единое хранилище через chrome.storage.local с namespace-префиксами.
 * Читает/пишет только Core (и харвестеры — только токены). UI к Storage не обращается.
 *
 * Namespaces:
 *   token:dat, token:truckstop       — Bearer токены бордов
 *   work:loads                       — активные карточки грузов
 *   settings:user, settings:openclaw, settings:lastSearch, settings:theme
 *   settings:truckstopRequestTemplate, settings:truckerpathRequestTemplate — шаблоны запросов + куки (до следующего перехвата)
 *   saved:bookmarks                  — закладки
 *   history:calls                    — история звонков
 *
 * Токены и шаблоны (с куки) сохраняются до следующего перехвата на вкладке борда или до переустановки расширения; не сбрасываются при закрытии вкладки.
 */

const Storage = {

  DEFAULT_DISABLED_BOARDS: {
    dat: true,
    truckstop: true,
    tp: true,
    '123lb': true
  },

  DEFAULT_AI_SETTINGS: {
    enabled: true,
    provider: 'gemini',
    clientId: '',
    projectId: 'logload',
    location: 'global',
    model: 'gemini-2.5-flash',
    timeoutMs: 12000,
    onboarded: false,
    oauthConnected: false,
    oauthScopeKey: '',
    oauthAccessToken: '',
    oauthExpiresAt: 0
  },

  normalizeAiSettings(ai = {}) {
    const normalized = {
      ...this.DEFAULT_AI_SETTINGS,
      ...(ai || {}),
      enabled: true,
      projectId: ai?.projectId || this.DEFAULT_AI_SETTINGS.projectId
    };

    if (normalized.projectId) {
      normalized.location = 'global';
    }

    if (!normalized.model || normalized.model === 'gemini-2.0-flash' || normalized.model === 'gemini-2.0-flash-001') {
      normalized.model = this.DEFAULT_AI_SETTINGS.model;
    }

    return normalized;
  },

  // ============================================================
  // Tokens
  // ============================================================

  async getToken(board) {
    const key = `token:${board}`;
    const data = await chrome.storage.local.get(key);
    return data[key] || null;
  },

  async setToken(board, token) {
    await chrome.storage.local.set({ [`token:${board}`]: token });
  },

  // ============================================================
  // Loads (work namespace)
  // ============================================================

  async getLoads() {
    const data = await chrome.storage.local.get('work:loads');
    return data['work:loads'] || [];
  },

  async setLoads(loads) {
    await chrome.storage.local.set({ 'work:loads': loads });
  },

  async updateLoadStatus(loadId, status) {
    const loads = await this.getLoads();
    const updated = loads.map(l => l.id === loadId ? { ...l, status } : l);
    await this.setLoads(updated);

    // Если статус saved — дублируем в закладки
    if (status === 'saved') {
      const load = loads.find(l => l.id === loadId);
      if (load) await this.addBookmark({ ...load, status: 'saved' });
    }
  },

  /** Сохранить worklistItemId у карточки (для синхронизации с бордом DAT). */
  async setLoadWorklistId(loadId, worklistItemId) {
    const loads = await this.getLoads();
    const updated = loads.map(l =>
      l.id === loadId ? { ...l, worklistItemId } : l
    );
    await this.setLoads(updated);
  },

  async clearActive() {
    const loads = await this.getLoads();
    const filtered = loads.filter(l => l.status !== 'active');
    await this.setLoads(filtered);
  },

  /** Удалить active грузы только с указанным searchId. Грузы других потоков не трогаются. */
  async clearActiveBySearchId(searchId) {
    if (!searchId) return;
    const loads = await this.getLoads();
    const filtered = loads.filter(l => !(l.status === 'active' && l.searchId === searchId));
    await this.setLoads(filtered);
  },

  /** Отпечаток груза: все значимые поля. Если совпадает — перепост. */
  _fingerprint(l) {
    const parts = [
      l.origin?.city, l.origin?.state,
      l.destination?.city, l.destination?.state,
      l.equipment,
      l.rate, l.rpm, l.miles, l.weight, l.length,
      l.fullPartial,
      l.broker?.mc, l.broker?.company, l.broker?.phone, l.broker?.email,
      l.notes,
      l.pickupDate
    ];
    return parts.map(v => v == null || v === '' ? '' : String(v).toLowerCase().trim()).join('|');
  },

  /** Мерж грузов в work:loads: удалить старые с этим searchId, добавить новые. Дедупликация по id + по контенту. */
  async mergeLoads(newLoads, searchId) {
    const existing = await this.getLoads();
    // Убираем старые грузы с этим searchId
    const withoutOld = existing.filter(l => l.searchId !== searchId);
    // Дедупликация по id
    const existingIds = new Set(withoutOld.map(l => l.id));
    const tagged = newLoads
      .filter(l => !existingIds.has(l.id))
      .map(l => ({ ...l, searchId }));

    const all = [...withoutOld, ...tagged];

    // Дедупликация по контенту: точные копии → оставляем самый свежий
    const fpMap = new Map();
    for (const load of all) {
      const fp = this._fingerprint(load);
      const prev = fpMap.get(fp);
      if (!prev) {
        fpMap.set(fp, load);
      } else {
        const prevTime = prev.postedAt ? new Date(prev.postedAt).getTime() : 0;
        const curTime = load.postedAt ? new Date(load.postedAt).getTime() : 0;
        fpMap.set(fp, curTime > prevTime ? load : prev);
      }
    }
    const merged = [...fpMap.values()];
    await this.setLoads(merged);
    return merged;
  },

  // ============================================================
  // Settings
  // ============================================================

  async getSettings() {
    const data = await chrome.storage.local.get([
      'settings:user',
      'settings:openclaw',
      'settings:lastSearch',
      'settings:theme',
      'settings:truckstopRequestTemplate',
      'settings:truckerpathRequestTemplate',
      'settings:disabledBoards',
      'settings:ai'
    ]);
    return {
      user: data['settings:user'] || {},
      openclaw: data['settings:openclaw'] || {
        url: 'http://localhost:3000',
        api_key: '',
        interval: 5000,
        enabled: false
      },
      lastSearch: data['settings:lastSearch'] || null,
      theme: data['settings:theme'] || 'light',
      truckstopRequestTemplate: data['settings:truckstopRequestTemplate'] || null,
      truckerpathRequestTemplate: data['settings:truckerpathRequestTemplate'] || null,
      disabledBoards: {
        ...this.DEFAULT_DISABLED_BOARDS,
        ...(data['settings:disabledBoards'] || {})
      },
      ai: this.normalizeAiSettings(data['settings:ai'] || {})
    };
  },

  async saveSettings(data) {
    if (!data || typeof data !== 'object') return;
    const updates = {};
    if (data.user !== undefined) updates['settings:user'] = data.user;
    if (data.openclaw !== undefined) updates['settings:openclaw'] = data.openclaw;
    if (data.lastSearch !== undefined) updates['settings:lastSearch'] = data.lastSearch;
    if (data.theme !== undefined) updates['settings:theme'] = data.theme;
    if (data.truckstopRequestTemplate !== undefined) updates['settings:truckstopRequestTemplate'] = data.truckstopRequestTemplate;
    if (data.truckerpathRequestTemplate !== undefined) updates['settings:truckerpathRequestTemplate'] = data.truckerpathRequestTemplate;
    if (data.disabledBoards !== undefined) updates['settings:disabledBoards'] = data.disabledBoards;
    if (data.ai !== undefined) {
      updates['settings:ai'] = this.normalizeAiSettings(data.ai);
    }
    if (Object.keys(updates).length === 0) return;
    await chrome.storage.local.set(updates);
  },

  // ============================================================
  // Bookmarks (saved namespace)
  // ============================================================

  async getBookmarks() {
    const data = await chrome.storage.local.get('saved:bookmarks');
    return data['saved:bookmarks'] || [];
  },

  async addBookmark(load) {
    const bookmarks = await this.getBookmarks();
    const exists = bookmarks.some(b => b.id === load.id);
    if (!exists) {
      bookmarks.push({ ...load, savedAt: new Date().toISOString() });
      await chrome.storage.local.set({ 'saved:bookmarks': bookmarks });
    }
  },

  async removeBookmark(loadId) {
    const bookmarks = await this.getBookmarks();
    await chrome.storage.local.set({
      'saved:bookmarks': bookmarks.filter(b => b.id !== loadId)
    });
  },

  // ============================================================
  // History (history namespace)
  // ============================================================

  async getHistory(filters = {}) {
    const data = await chrome.storage.local.get('history:calls');
    let history = data['history:calls'] || [];

    if (filters.dateFrom) {
      history = history.filter(h => h.callTime >= filters.dateFrom);
    }
    if (filters.dateTo) {
      history = history.filter(h => h.callTime <= filters.dateTo);
    }
    if (filters.board) {
      history = history.filter(h => h.board === filters.board);
    }

    return history;
  },

  async addHistoryEntry(entry) {
    const data = await chrome.storage.local.get('history:calls');
    const history = data['history:calls'] || [];
    history.unshift({ ...entry, id: `h_${Date.now()}_${Math.random().toString(36).slice(2, 7)}` });
    await chrome.storage.local.set({ 'history:calls': history });
  },

  async updateHistoryEntry(entryId, updates) {
    const data = await chrome.storage.local.get('history:calls');
    const history = (data['history:calls'] || []).map(h =>
      h.id === entryId ? { ...h, ...updates } : h
    );
    await chrome.storage.local.set({ 'history:calls': history });
  },

  // ============================================================
  // Cleanup — удаление устаревших записей
  // ============================================================

  async pruneHistory() {
    const now = Date.now();
    const MS_60_DAYS = 60 * 24 * 60 * 60 * 1000;
    const MS_24H = 24 * 60 * 60 * 1000;

    // Одна атомарная операция: getLoads → фильтрация + обновление статусов → setLoads
    const loads = await this.getLoads();
    const cleanLoads = loads
      .filter(l => {
        if (l.status === 'no_response') return false;
        if (l.status === 'booked' && l.bookedAt) {
          return (now - new Date(l.bookedAt).getTime()) < MS_60_DAYS;
        }
        return true;
      })
      .map(l => {
        // emailed / called_pending → no_response если прошло 24 часа
        if (!['emailed', 'called_pending'].includes(l.status)) return l;
        const age = now - new Date(l.statusUpdatedAt || l.postedAt).getTime();
        if (age > MS_24H) return { ...l, status: 'no_response' };
        return l;
      });
    await this.setLoads(cleanLoads);

    // Очищаем закладки: no_response удаляем
    const bookmarks = await this.getBookmarks();
    const cleanBookmarks = bookmarks.filter(b => b.status !== 'no_response');
    await chrome.storage.local.set({ 'saved:bookmarks': cleanBookmarks });

    // История звонков: > 60 дней удаляем
    const data = await chrome.storage.local.get('history:calls');
    const history = (data['history:calls'] || []).filter(h => {
      if (!h.callTime) return false;
      return (now - new Date(h.callTime).getTime()) < MS_60_DAYS;
    });
    await chrome.storage.local.set({ 'history:calls': history });
  }
};

export default Storage;
