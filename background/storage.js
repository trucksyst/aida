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
      'settings:disabledBoards'
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
      disabledBoards: data['settings:disabledBoards'] || {}
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
