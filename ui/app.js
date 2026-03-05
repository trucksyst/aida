/**
 * AIDA v0.1 — SidePanel UI
 * Главный контроллер интерфейса диспетчера.
 *
 * UI не использует chrome.storage. Все данные — только через Core API (sendMessage).
 * Обновления в реальном времени — push от Core (onMessage, type DATA_UPDATED).
 */

// ============================================================
// State
// ============================================================

const state = {
    currentSection: 'search',
    loads: [],
    bookmarks: [],
    history: [],
    settings: {},
    selectedLoad: null,
    sortColumn: 'postedAt',
    sortAsc: false,
    agentEnabled: false,
    boardStatus: { dat: false, truckstop: false },
    lastRefreshTime: null,
    searchPresets: []   // max 8 saved search presets
};

const MAX_PRESETS = 8;

// ============================================================
// Core Communication
// ============================================================

function sendToCore(type, payload = {}) {
    return new Promise((resolve) => {
        chrome.runtime.sendMessage({ type, ...payload }, (response) => {
            if (chrome.runtime.lastError) {
                const msg = chrome.runtime.lastError.message || '';
                if (msg.indexOf('Extension context invalidated') === -1) {
                    console.warn('[AIDA/UI] Message error:', msg);
                }
                resolve(null);
            } else {
                resolve(response);
            }
        });
    });
}

// ============================================================
// Init
// ============================================================

async function init() {
    const buildVersion = chrome.runtime.getManifest().version;
    console.log(`%c[AIDA/UI] build ${buildVersion}`, 'color:#0f0;font-weight:bold;font-size:13px');
    const buildEl = document.getElementById('status-build');
    if (buildEl) buildEl.textContent = `v${buildVersion}`;
    const resp = await sendToCore('GET_SETTINGS');
    console.log('[AIDA/UI] Step: GET_SETTINGS', resp?.settings ? 'ok' : 'empty');
    if (resp?.settings) {
        state.settings = resp.settings;
        applySettings(resp.settings);
    }

    // Очищаем старые грузы при открытии — каждый раз чистый старт
    await sendToCore('CLEAR_LOADS');
    state.loads = [];
    console.log('[AIDA/UI] Step: cleared old loads');

    // Даты по умолчанию — сегодня
    const today = new Date().toISOString().split('T')[0];
    document.getElementById('date-from').value = today;
    document.getElementById('date-to').value = today;

    // Подставить последний поиск (память формы) — Core сохраняет lastSearch при каждом Search
    if (resp?.settings?.lastSearch) {
        applyLastSearch(resp.settings.lastSearch);
        // Даты всегда перебиваем на сегодня
        document.getElementById('date-from').value = today;
        document.getElementById('date-to').value = today;
        console.log('[AIDA/UI] Step: applied last search (origin, destination, equipment)');
    }

    // Статус бордов и тема уже в resp.settings (boardStatus, theme) — применены в applySettings
    renderTable();
    updateStatusBar();

    // Load search presets from storage
    await loadSearchPresets();

    bindEvents();

    // Единственная подписка на обновления — push от Core (контракт API)
    chrome.runtime.onMessage.addListener(onDataUpdated);
    console.log('[AIDA/UI] Step: init done. Listening for DATA_UPDATED from Core.');

    // ---- AUTO-SEARCH при открытии ----
    ensureSearchParamsAndSearch();
}

function applySettings(settings) {
    const u = settings.user || {};
    const oc = settings.openclaw || {};

    setVal('set-name', u.name || '');
    setVal('set-company', u.companyName || u.company || '');
    setVal('set-phone', u.phone || '');
    setVal('set-email', u.email || '');
    setVal('set-retell-key', u.retellApiKey || '');
    setVal('set-retell-from', u.retellFromNumber || '');
    setVal('set-retell-agent', u.retellAgentId || '');

    setVal('openclaw-url', oc.url || 'http://localhost:3000');
    setVal('openclaw-key', oc.api_key || '');
    setVal('openclaw-interval', oc.interval || 5000);

    state.agentEnabled = oc.enabled || false;
    document.getElementById('agent-toggle').checked = state.agentEnabled;
    updateAgentStatus();

    // Статус бордов: объект { connected, hasToken, tabOpen, disabled } для каждого борда
    state.boardStatus = settings.boardStatus || {};
    if (settings.theme) document.documentElement.dataset.theme = settings.theme;
    updateBoardDots();
}

function setVal(id, val) {
    const el = document.getElementById(id);
    if (el) el.value = val;
}

/** Parse "Chicago, IL" → { city: "Chicago", state: "IL" }. Also handles zones: "Z1" → { city: "Z1", state: "" } */
function parseCityState(raw) {
    if (!raw) return { city: '', state: '' };
    var s = raw.trim();
    // Zone: Z0–Z9
    if (/^Z\d+$/i.test(s)) return { city: s.toUpperCase(), state: '' };
    var parts = s.split(/\s*,\s*/);
    var city = (parts[0] || '').trim();
    var state = (parts[1] || '').trim().toUpperCase().slice(0, 2);
    return { city: city, state: state };
}

/** Format city+state for display in a single field. */
function formatCityState(city, state) {
    if (!city && !state) return '';
    if (!state) return city;
    return city + ', ' + state;
}

/** Заполнить форму поиска из сохранённого lastSearch (память по умолчанию). */
function applyLastSearch(lastSearch) {
    if (!lastSearch || typeof lastSearch !== 'object') return;
    var o = lastSearch.origin || {};
    var d = lastSearch.destination || {};
    setVal('origin-city', formatCityState(o.city || '', (o.state || '').toUpperCase().slice(0, 2)));
    setVal('dest-city', formatCityState(d.city || '', (d.state || '').toUpperCase().slice(0, 2)));
    setVal('search-radius', lastSearch.radius != null ? lastSearch.radius : 50);
    if (lastSearch.equipment) {
        const eqArr = Array.isArray(lastSearch.equipment) ? lastSearch.equipment : [lastSearch.equipment];
        setEquipmentChecked(eqArr);
    }
    if (lastSearch.dateFrom) setVal('date-from', lastSearch.dateFrom);
    if (lastSearch.dateTo) setVal('date-to', lastSearch.dateTo);
}

// ============================================================
// Push от Core (DATA_UPDATED) — единственный канал обновлений
// ============================================================

function onDataUpdated(message) {
    console.log('[AIDA/UI] onMessage received:', message?.type, message?.payload ? Object.keys(message.payload).join(',') : 'no payload');
    if (message.type !== 'DATA_UPDATED' || !message.payload) return;
    const p = message.payload;
    let updated = [];
    if (p.loads !== undefined) {
        state.loads = p.loads;
        updated.push('loads');
        renderTable();
        updateStatusBar();
    }
    if (p.bookmarks !== undefined) {
        state.bookmarks = p.bookmarks;
        updated.push('bookmarks');
        if (state.currentSection === 'bookmarks') renderBookmarks();
    }
    if (p.history !== undefined) {
        state.history = p.history;
        updated.push('history');
        if (state.currentSection === 'history') renderHistory();
    }
    if (p.settings !== undefined) {
        state.settings = p.settings;
        applySettings(p.settings);
        updated.push('settings');
    }
    if (p.newLoadsCount !== undefined) {
        updateNewLoadsIndicator(p.newLoadsCount);
        updated.push('newLoadsCount=' + p.newLoadsCount);
    }
    if (p.lastRefreshTime !== undefined) {
        state.lastRefreshTime = p.lastRefreshTime;
        updateRefreshTimer();
    }
    if (updated.length) console.log('[AIDA/UI] Step: DATA_UPDATED →', updated.join(', '));
}

// ============================================================
// Location autocomplete (City, ST and zones Z0–Z9)
// ============================================================

function attachLocationAutocomplete(cityId, dropdownId) {
    var cityEl = document.getElementById(cityId);
    var listEl = document.getElementById(dropdownId);
    if (!cityEl || !listEl || typeof window.AIDALocations === 'undefined') return;

    var debounceTimer = null;
    var DEBOUNCE_MS = 150;

    function hide() {
        listEl.innerHTML = '';
        listEl.classList.remove('open');
        listEl.setAttribute('aria-hidden', 'true');
    }

    function positionList() {
        var rect = cityEl.getBoundingClientRect();
        listEl.style.top = (rect.bottom + 2) + 'px';
        listEl.style.left = rect.left + 'px';
        listEl.style.width = rect.width + 'px';
    }

    function show(items, isLoading) {
        function escapeAttr(s) {
            return String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/'/g, '&#39;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        }
        if (isLoading) {
            listEl.innerHTML = '<div class="location-autocomplete-item location-autocomplete-loading">Searching online…</div>';
            positionList();
            listEl.classList.add('open');
            listEl.setAttribute('aria-hidden', 'false');
            return;
        }
        if (!items.length) { hide(); return; }
        listEl.innerHTML = items.map(function (item) {
            var label = item.label || (item.type === 'zone' ? item.value + ' (zone)' : item.value);
            return '<div class="location-autocomplete-item" data-value="' + escapeAttr(item.value) + '" data-type="' + item.type + '" role="option">' + escapeHtml(label) + '</div>';
        }).join('');
        positionList();
        listEl.classList.add('open');
        listEl.setAttribute('aria-hidden', 'false');
        listEl.querySelectorAll('.location-autocomplete-item').forEach(function (node) {
            node.addEventListener('click', function () {
                var val = node.getAttribute('data-value');
                var typ = node.getAttribute('data-type');
                // Value is already in "City, ST" or "Z1" format — set as-is
                cityEl.value = val;
                hide();
                cityEl.focus();
                if (typeof updatePresetDisplay === 'function') updatePresetDisplay();
            });
        });
    }

    function escapeHtml(s) {
        var div = document.createElement('div');
        div.textContent = s;
        return div.innerHTML;
    }

    cityEl.addEventListener('input', function () {
        window.clearTimeout(debounceTimer);
        var q = cityEl.value.trim();
        debounceTimer = window.setTimeout(function () {
            if (!q) { hide(); return; }
            var items = window.AIDALocations.getSuggestions(q, 18);
            if (items.length > 0) {
                show(items, false);
            } else if (q.length >= 2) {
                show([], true);
                window.AIDALocations.fetchOnlineSuggestions(q, 10, function (online) {
                    if (listEl.classList.contains('open') && listEl.querySelector('.location-autocomplete-loading')) {
                        show(online, false);
                    }
                });
            } else {
                hide();
            }
        }, DEBOUNCE_MS);
    });

    cityEl.addEventListener('focus', function () {
        var q = cityEl.value.trim();
        if (q) {
            var items = window.AIDALocations.getSuggestions(q, 18);
            if (items.length > 0) {
                show(items, false);
            } else if (q.length >= 2) {
                show([], true);
                window.AIDALocations.fetchOnlineSuggestions(q, 10, function (online) {
                    if (listEl.classList.contains('open') && listEl.querySelector('.location-autocomplete-loading')) {
                        show(online, false);
                    }
                });
            }
        }
    });

    cityEl.addEventListener('blur', function () {
        window.setTimeout(hide, 200);
    });

    document.addEventListener('keydown', function (e) {
        if (e.target !== cityEl) return;
        if (e.key === 'Escape') hide();
    });
}

// ============================================================
// Equipment Multi-Select
// ============================================================

const EQUIP_SHORT = {
    'VAN': 'V', 'REEFER': 'R', 'FLATBED': 'F', 'STEPDECK': 'SD',
    'DOUBLEDROP': 'DD', 'LOWBOY': 'LB', 'RGN': 'RG', 'HOPPER': 'HB',
    'TANKER': 'T', 'POWERONLY': 'PO', 'CONTAINER': 'C', 'DUMP': 'DT',
    'AUTOCARRIER': 'AC', 'LANDOLL': 'LA', 'MAXI': 'MX'
};

function getSelectedEquipment() {
    const checks = document.querySelectorAll('#equip-dropdown input[type="checkbox"]:checked');
    const arr = Array.from(checks).map(cb => cb.value);
    return arr.length > 0 ? arr : ['VAN'];
}

function setEquipmentChecked(values) {
    const all = document.querySelectorAll('#equip-dropdown input[type="checkbox"]');
    all.forEach(cb => { cb.checked = values.includes(cb.value); });
    updateEquipDisplay();
}

function updateEquipDisplay() {
    const selected = getSelectedEquipment();
    const codes = selected.map(v => '(' + (EQUIP_SHORT[v] || v) + ')');
    document.getElementById('equip-display').textContent = codes.join(',');
}

function initEquipMultiSelect() {
    const display = document.getElementById('equip-display');
    const dropdown = document.getElementById('equip-dropdown');

    // Move dropdown to body so it escapes all overflow:hidden containers
    document.body.appendChild(dropdown);

    display.addEventListener('click', (e) => {
        e.stopPropagation();
        const isOpen = dropdown.classList.toggle('open');
        if (isOpen) {
            const rect = display.getBoundingClientRect();
            dropdown.style.top = (rect.bottom + 2) + 'px';
            dropdown.style.left = rect.left + 'px';
        }
    });

    // При каждом чекбоксе — обновить display
    dropdown.querySelectorAll('input[type="checkbox"]').forEach(cb => {
        cb.addEventListener('change', () => updateEquipDisplay());
    });

    // Закрыть при клике вне
    document.addEventListener('click', (e) => {
        if (!e.target.closest('#equip-multi') && !e.target.closest('#equip-dropdown')) {
            dropdown.classList.remove('open');
        }
    });

    updateEquipDisplay();
}

// ============================================================
// Search Presets — save / load / delete / apply
// ============================================================

/** Build a human-readable label: "Chicago, IL → Dallas, TX  50  (V)(R)" */
function presetLabel(p) {
    let lbl = '';
    if (p.origin) lbl += p.origin;  // already "Chicago, IL" format
    if (p.dest) {
        lbl += ' → ' + p.dest;
    } else {
        lbl += ' → Anywhere';
    }
    if (p.radius != null) lbl += '  ' + p.radius;
    if (p.equipment && p.equipment.length > 0) {
        const codes = p.equipment.map(v => '(' + (EQUIP_SHORT[v] || v) + ')');
        lbl += '  ' + codes.join('');
    }
    return lbl.trim() || 'Unnamed preset';
}

/** Load presets from chrome.storage.local into state. */
async function loadSearchPresets() {
    try {
        const data = await new Promise(resolve =>
            chrome.storage.local.get('searchPresets', r => resolve(r))
        );
        state.searchPresets = Array.isArray(data.searchPresets) ? data.searchPresets : [];
    } catch (e) {
        console.warn('[AIDA/UI] Failed to load search presets:', e);
        state.searchPresets = [];
    }
    renderPresetDropdown();
    console.log('[AIDA/UI] Step: loaded search presets, count:', state.searchPresets.length);
}

/** Persist current presets array to chrome.storage.local. */
async function savePresetsToStorage() {
    try {
        await new Promise(resolve =>
            chrome.storage.local.set({ searchPresets: state.searchPresets }, resolve)
        );
    } catch (e) {
        console.warn('[AIDA/UI] Failed to save search presets:', e);
    }
}

/** Create a preset object from current form values (no dates). */
function buildPresetFromForm() {
    return {
        id: String(Date.now()),
        origin: document.getElementById('origin-city').value.trim(),  // "Chicago, IL" combined
        radius: parseInt(document.getElementById('search-radius').value) || 50,
        dest: document.getElementById('dest-city').value.trim(),      // "Dallas, TX" combined
        equipment: getSelectedEquipment()
    };
}

/** Check if a preset with same params already exists. */
function presetExists(p) {
    return state.searchPresets.some(x =>
        x.origin === p.origin &&
        x.dest === p.dest &&
        x.radius === p.radius &&
        JSON.stringify(x.equipment.slice().sort()) === JSON.stringify(p.equipment.slice().sort())
    );
}

/** Handle Save preset button click. */
async function handlePresetSave() {
    const p = buildPresetFromForm();
    if (!p.origin) {
        showToast('Fill in at least origin to save', 'error');
        return;
    }
    if (state.searchPresets.length >= MAX_PRESETS) {
        showToast(`Maximum ${MAX_PRESETS} presets. Delete one first.`, 'error');
        return;
    }
    if (presetExists(p)) {
        showToast('This preset already exists', 'error');
        return;
    }
    state.searchPresets.push(p);
    await savePresetsToStorage();
    renderPresetDropdown();
    showToast('Preset saved ✓');
    console.log('[AIDA/UI] Step: preset saved:', presetLabel(p));
    // Вариант B: save + search
    doSearch();
}

/** Apply a preset to the form, set dates to today/today+1, then search. */
function applyPreset(presetId) {
    const p = state.searchPresets.find(x => x.id === presetId);
    if (!p) return;
    setVal('origin-city', p.origin || '');
    setVal('search-radius', p.radius != null ? p.radius : 50);
    setVal('dest-city', p.dest || '');
    if (p.equipment) setEquipmentChecked(p.equipment);

    // Даты: today и today+1
    const today = new Date();
    const tomorrow = new Date(today);
    tomorrow.setDate(tomorrow.getDate() + 1);
    setVal('date-from', today.toISOString().split('T')[0]);
    setVal('date-to', tomorrow.toISOString().split('T')[0]);

    // Закрыть dropdown
    document.getElementById('preset-dropdown').classList.remove('open');

    console.log('[AIDA/UI] Step: preset applied:', presetLabel(p));
    // Вариант B: apply + auto-search
    doSearch();
}

/** Delete a preset by id. */
async function deletePreset(presetId) {
    state.searchPresets = state.searchPresets.filter(x => x.id !== presetId);
    await savePresetsToStorage();
    renderPresetDropdown();
    showToast('Preset deleted');
    console.log('[AIDA/UI] Step: preset deleted, remaining:', state.searchPresets.length);
}

/** Render the presets dropdown items. */
function renderPresetDropdown() {
    const listEl = document.getElementById('preset-list');
    const emptyEl = document.getElementById('preset-empty');
    const triggerEl = document.getElementById('preset-trigger');

    if (!listEl || !emptyEl || !triggerEl) return;

    const presets = state.searchPresets;

    // Toggle has-presets class on trigger
    triggerEl.classList.toggle('has-presets', presets.length > 0);

    if (presets.length === 0) {
        listEl.innerHTML = '';
        emptyEl.classList.add('visible');
        return;
    }

    emptyEl.classList.remove('visible');
    listEl.innerHTML = presets.map(p => {
        const lbl = esc(presetLabel(p));
        return `<div class="preset-item" data-id="${p.id}">
            <span class="preset-item-label" title="${lbl}">${lbl}</span>
            <button class="preset-item-apply" data-action="apply" data-id="${p.id}" title="Apply">✔</button>
            <button class="preset-item-delete" data-action="delete" data-id="${p.id}" title="Delete">✕</button>
        </div>`;
    }).join('');

    // Bind clicks
    listEl.querySelectorAll('.preset-item-apply').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            applyPreset(btn.dataset.id);
        });
    });
    listEl.querySelectorAll('.preset-item-delete').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            deletePreset(btn.dataset.id);
        });
    });
    // Click on the row itself = apply
    listEl.querySelectorAll('.preset-item').forEach(item => {
        item.addEventListener('click', () => {
            applyPreset(item.dataset.id);
        });
    });
}

/** Update the live preview display from current form values. */
function updatePresetDisplay() {
    const textEl = document.getElementById('preset-display-text');
    if (!textEl) return;

    const p = buildPresetFromForm();
    const lbl = presetLabel(p);

    if (!p.origin) {
        textEl.textContent = 'Select or type params…';
        textEl.classList.add('placeholder');
    } else {
        textEl.textContent = lbl;
        textEl.classList.remove('placeholder');
    }

    // Highlight display if matches a saved preset
    const displayEl = document.getElementById('preset-trigger');
    if (displayEl) {
        displayEl.classList.toggle('has-presets', presetExists(p));
    }
}

/** Init preset-related event listeners. */
function initSearchPresets() {
    const trigger = document.getElementById('preset-trigger');
    const dropdown = document.getElementById('preset-dropdown');
    const saveBtn = document.getElementById('preset-save-btn');

    // Toggle dropdown
    trigger.addEventListener('click', (e) => {
        e.stopPropagation();
        const isOpen = dropdown.classList.toggle('open');
        if (isOpen) {
            const rect = trigger.getBoundingClientRect();
            dropdown.style.top = (rect.bottom + 4) + 'px';
            dropdown.style.right = (window.innerWidth - rect.right) + 'px';
            dropdown.style.left = 'auto';
        }
        // Close equip dropdown if open
        document.getElementById('equip-dropdown').classList.remove('open');
    });

    // Save button
    saveBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        handlePresetSave();
    });

    // Close preset dropdown on outside click
    document.addEventListener('click', (e) => {
        if (!e.target.closest('#search-presets')) {
            dropdown.classList.remove('open');
        }
    });

    // Live preview: update display on any search field change
    ['origin-city', 'search-radius', 'dest-city', 'dest-radius'].forEach(id => {
        const el = document.getElementById(id);
        if (el) {
            el.addEventListener('input', updatePresetDisplay);
            el.addEventListener('change', updatePresetDisplay);
        }
    });

    // Equipment checkboxes — also update preview
    document.querySelectorAll('#equip-dropdown input[type="checkbox"]').forEach(cb => {
        cb.addEventListener('change', updatePresetDisplay);
    });

    // Initial display
    updatePresetDisplay();
}

// ============================================================
// Events
// ============================================================

function bindEvents() {
    attachLocationAutocomplete('origin-city', 'origin-autocomplete');
    attachLocationAutocomplete('dest-city', 'dest-autocomplete');
    initEquipMultiSelect();
    initSearchPresets();

    // Sidebar navigation
    document.querySelectorAll('.sidebar-icon[data-section]').forEach(btn => {
        btn.addEventListener('click', () => switchSection(btn.dataset.section));
    });

    // Theme toggle
    document.getElementById('btn-theme').addEventListener('click', toggleTheme);

    // Search button
    document.getElementById('btn-search').addEventListener('click', doSearch);

    // State input — Enter
    ['origin-city', 'dest-city', 'search-radius', 'dest-radius',
        'date-from', 'date-to'].forEach(id => {
            const el = document.getElementById(id);
            if (el) el.addEventListener('keydown', e => { if (e.key === 'Enter') doSearch(); });
        });

    // Table sort
    document.querySelectorAll('#load-table thead th[data-sort]').forEach(th => {
        th.addEventListener('click', () => {
            const col = th.dataset.sort;
            if (state.sortColumn === col) {
                state.sortAsc = !state.sortAsc;
            } else {
                state.sortColumn = col;
                state.sortAsc = false;
            }
            renderTable();
            // Update header UI
            document.querySelectorAll('#load-table thead th').forEach(h => {
                h.classList.toggle('sorted', h.dataset.sort === col);
                h.classList.toggle('asc', h.dataset.sort === col && state.sortAsc);
            });
        });
    });

    // Detail panel close
    document.getElementById('btn-detail-close').addEventListener('click', closeDetail);

    // Detail actions
    document.getElementById('detail-btn-call').addEventListener('click', () => {
        if (state.selectedLoad) doCall(state.selectedLoad.id);
    });
    document.getElementById('detail-btn-email').addEventListener('click', () => {
        if (state.selectedLoad) doEmail(state.selectedLoad.id);
    });
    document.getElementById('detail-btn-save').addEventListener('click', () => {
        if (state.selectedLoad) doSave(state.selectedLoad.id);
    });

    // Settings save
    document.getElementById('btn-save-settings').addEventListener('click', saveSettings);

    // OpenClaw save
    document.getElementById('btn-save-openclaw').addEventListener('click', saveOpenClaw);

    // Agent toggle
    document.getElementById('agent-toggle').addEventListener('change', (e) => {
        toggleAgent(e.target.checked);
    });

    // Board toggle buttons — простой ВКЛ/ВЫКЛ.
    // При ВЫКЛЮЧЕНИИ — грузы борда удаляются.
    // При ВКЛЮЧЕНИИ — авто-поиск с лучшими доступными параметрами.
    document.querySelectorAll('.board-toggle[data-board]').forEach(btn => {
        btn.addEventListener('click', async () => {
            const board = btn.dataset.board;
            const bs = state.boardStatus[board] || {};
            const wasDisabled = !!bs.disabled;

            await sendToCore('TOGGLE_BOARD', { board });

            // Если ВКЛЮЧИЛИ (было OFF → стало ON) → авто-поиск
            if (wasDisabled) {
                ensureSearchParamsAndSearch();
            }
        });
    });
}

// ============================================================
// Navigation
// ============================================================

function switchSection(section) {
    // Скрываем все секции
    document.querySelectorAll('.section-content').forEach(el => el.style.display = 'none');

    // Показываем нужную
    const target = document.getElementById(`section-${section}`);
    if (target) target.style.display = 'flex';

    // Обновляем sidebar
    document.querySelectorAll('.sidebar-icon[data-section]').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.section === section);
    });

    state.currentSection = section;

    // Загружаем данные для секции
    if (section === 'bookmarks') loadAndRenderBookmarks();
    if (section === 'history') loadAndRenderHistory();
}

// ============================================================
// Search
// ============================================================

/**
 * Заполнить форму поиска если пустая, затем запустить поиск.
 * Приоритет: lastSearch → company city → Chicago, IL.
 * Даты: сегодня. Equipment: Van.
 */
function ensureSearchParamsAndSearch() {
    const originRaw = (document.getElementById('origin-city')?.value || '').trim();

    // Если форма уже заполнена — просто поиск
    if (originRaw) {
        setTimeout(() => doSearch(), 300);
        return;
    }

    // Пробуем lastSearch
    const ls = state.settings?.lastSearch;
    if (ls?.origin?.city || ls?.origin?.state) {
        applyLastSearch(ls);
        setTimeout(() => doSearch(), 300);
        return;
    }

    // Пробуем company city
    const user = state.settings?.user || {};
    const compCity = user.city || user.companyCity || '';
    const compState = user.state || user.companyState || '';
    if (compCity || compState) {
        setVal('origin-city', formatCityState(compCity, (compState || '').toUpperCase().slice(0, 2)));
    } else {
        // Дефолт: Chicago, IL
        setVal('origin-city', 'Chicago, IL');
    }

    // Даты: сегодня
    const today = new Date().toISOString().split('T')[0];
    setVal('date-from', today);
    setVal('date-to', today);

    // Equipment: Van
    setEquipmentChecked(['VAN']);

    setTimeout(() => doSearch(), 300);
}


async function doSearch() {
    const params = getSearchParams();
    console.log('[AIDA/UI] Step: doSearch params', JSON.stringify(params));
    if (!params.origin.city && !params.origin.state) {
        showToast('Enter origin city or state', 'error');
        return;
    }

    const btn = document.getElementById('btn-search');
    btn.textContent = 'Searching...';
    btn.disabled = true;

    showTableEmpty(false);
    showTableLoading(true);

    try {
        console.log('[AIDA/UI] Step: sending SEARCH_LOADS to Core');
        const resp = await sendToCore('SEARCH_LOADS', { params });
        console.log('[AIDA/UI] Step: SEARCH_LOADS response', resp?.error ? 'error: ' + resp.error : 'loads: ' + (Array.isArray(resp) ? resp.length : (resp?.loads?.length ?? 0)));
        const result = resp?.loads !== undefined ? resp : (Array.isArray(resp) ? { loads: resp } : resp);
        if (result?.error) {
            showToast('Search error: ' + result.error, 'error');
        } else {
            const loads = Array.isArray(result?.loads) ? result.loads : (Array.isArray(resp) ? resp : []);
            state.loads = loads;
            renderTable();
            updateStatusBar();
            // Показываем warnings от адаптеров
            if (Array.isArray(result?.warnings) && result.warnings.length > 0) {
                showToast('Board issues: ' + result.warnings.join('; '), 'error');
            }
            if (loads.length > 0) {
                showToast(`Found ${loads.length} loads`);
            } else {
                const bs = state.boardStatus || {};
                const anyConnected = Object.values(bs).some(b => typeof b === 'object' ? b.connected : !!b);
                if (!anyConnected) {
                    showToast('No board connected. Click a board button below to log in.', 'error');
                } else {
                    showToast('No loads found for this search.', 'error');
                }
            }
        }
        const fresh = await sendToCore('GET_LOADS');
        if (fresh?.loads?.length > 0 && state.loads.length === 0) {
            state.loads = fresh.loads;
            renderTable();
            updateStatusBar();
        }
    } finally {
        btn.textContent = 'Search';
        btn.disabled = false;
        showTableLoading(false);
    }
}

function getSearchParams() {
    const originParsed = parseCityState(document.getElementById('origin-city').value);
    const destParsed = parseCityState(document.getElementById('dest-city').value);
    return {
        origin: {
            city: originParsed.city,
            state: originParsed.state
        },
        destination: {
            city: destParsed.city,
            state: destParsed.state
        },
        radius: parseInt(document.getElementById('search-radius').value) || 50,
        destRadius: parseInt(document.getElementById('dest-radius').value) || 150,
        equipment: getSelectedEquipment(),
        dateFrom: document.getElementById('date-from').value,
        dateTo: document.getElementById('date-to').value
    };
}

// ============================================================
// Table Rendering
// ============================================================

function getEmptyMessage() {
    const bs = state.boardStatus || {};
    const anyConnected = Object.values(bs).some(b => typeof b === 'object' ? b.connected : !!b);
    if (!anyConnected) {
        return 'Connect a board first: click a board button below (DAT, Truckstop, TruckerPath) to log in.';
    }
    return 'No loads found. Enter search params and click Search, or try different filters.';
}

function renderTable() {
    const tbody = document.getElementById('loads-tbody');
    const empty = document.getElementById('table-empty');

    const loads = getSortedLoads();

    if (loads.length === 0) {
        tbody.innerHTML = '';
        empty.style.display = 'flex';
        const msgEl = empty.querySelector('.msg');
        if (msgEl) msgEl.textContent = getEmptyMessage();
        return;
    }

    empty.style.display = 'none';
    tbody.innerHTML = loads.map(renderRow).join('');

    // Bind row clicks
    tbody.querySelectorAll('tr[data-id]').forEach(tr => {
        tr.addEventListener('click', () => {
            const load = state.loads.find(l => l.id === tr.dataset.id);
            if (load) openDetail(load);
        });
    });
}

function getSortedLoads() {
    const col = state.sortColumn;
    const asc = state.sortAsc;

    return [...state.loads].sort((a, b) => {
        let va, vb;

        switch (col) {
            case 'rate': va = a.rate || 0; vb = b.rate || 0; break;
            case 'rpm': va = a.rpm || 0; vb = b.rpm || 0; break;
            case 'miles': va = a.miles || 0; vb = b.miles || 0; break;
            case 'weight': va = a.weight || 0; vb = b.weight || 0; break;
            case 'equipment': va = a.equipment || ''; vb = b.equipment || ''; break;
            case 'origin': va = a.origin?.city || ''; vb = b.origin?.city || ''; break;
            case 'destination': va = a.destination?.city || ''; vb = b.destination?.city || ''; break;
            case 'broker': va = a.broker?.company || ''; vb = b.broker?.company || ''; break;
            case 'board': va = a.board || ''; vb = b.board || ''; break;
            case 'pickupDate': va = a.pickupDate || ''; vb = b.pickupDate || ''; break;
            case 'postedAt': va = a.postedAt || ''; vb = b.postedAt || ''; break;
            case 'status': va = a.status || ''; vb = b.status || ''; break;
        }

        if (typeof va === 'string') {
            return asc ? va.localeCompare(vb) : vb.localeCompare(va);
        }
        return asc ? va - vb : vb - va;
    });
}

/** Форматирует время с момента публикации: NEW, 0:02, 1:15, 5h, 2d */
function formatPostedAgo(postedAt) {
    if (!postedAt) return '—';
    const ms = Date.now() - new Date(postedAt).getTime();
    if (isNaN(ms) || ms < 0) return '—';
    const mins = Math.floor(ms / 60000);
    if (mins < 1) return '<span class="posted-new">NEW</span>';
    if (mins < 60) return `0:${String(mins).padStart(2, '0')}`;
    const hrs = Math.floor(mins / 60);
    const remMins = mins % 60;
    if (hrs < 24) return `${hrs}:${String(remMins).padStart(2, '0')}`;
    const days = Math.floor(hrs / 24);
    return `${days}d`;
}

function renderRow(load) {
    const rate = load.rate ? `$${load.rate.toLocaleString()}` : '—';
    const rpm = load.rpm ? `$${load.rpm}` : '—';
    const origin = `${load.origin?.city || ''}, ${load.origin?.state || ''}`;
    const dest = `${load.destination?.city || ''}, ${load.destination?.state || ''}`;
    const miles = load.miles ? `${load.miles.toLocaleString()}` : '—';
    const weight = load.weight ? `${(load.weight / 1000).toFixed(0)}k lbs` : '—';
    const broker = esc(load.broker?.company || '—');
    const postedStr = formatPostedAgo(load.postedAt);
    const status = renderStatusBadge(load.status);
    const board = `<span class="board-badge ${esc(load.board || '')}">${(load.board || '').toUpperCase()}</span>`;

    // Если груз создан < 3 мин назад — подсветка row-new
    const NEW_THRESHOLD_MS = 3 * 60 * 1000;
    const postedMs = load.postedAt ? new Date(load.postedAt).getTime() : 0;
    const isNew = postedMs > 0 && (Date.now() - postedMs) < NEW_THRESHOLD_MS;
    const rowClass = `status-${load.status || 'active'}${isNew ? ' row-new' : ''}`;

    return `
    <tr data-id="${esc(load.id)}" class="${rowClass}">
        <td class="td-rate">${rate}</td>
        <td class="td-rpm">${rpm}</td>
        <td>${esc(load.equipment || '—')}</td>
        <td class="td-route"><strong>${esc(origin)}</strong></td>
        <td style="color:var(--text-muted)">→</td>
        <td class="td-route"><strong>${esc(dest)}</strong></td>
        <td>${miles}</td>
        <td>${weight}</td>
        <td>${broker}</td>
        <td>${board}</td>
        <td class="td-posted">${postedStr}</td>
        <td>${status}</td>
    </tr>`;
}

function renderStatusBadge(status) {
    const labels = {
        active: 'Active',
        saved: 'Saved',
        calling: 'Calling...',
        called_pending: 'Pending',
        emailed: 'Email sent',
        replied: 'Replied',
        booked: 'Booked',
        no_response: 'No response'
    };
    const label = labels[status] || status;
    return `<span class="status-badge ${status}">${label}</span>`;
}

// ============================================================
// Detail Panel
// ============================================================

function openDetail(load) {
    state.selectedLoad = load;

    document.getElementById('detail-title').textContent =
        `${load.origin?.city}, ${load.origin?.state} → ${load.destination?.city}, ${load.destination?.state}`;

    // Рендерим контент (карта остаётся как HTML-элемент)
    const body = document.getElementById('detail-body');
    const mapEl = document.getElementById('detail-map');
    // Очищаем всё кроме карты, потом вставляем после неё
    const contentDiv = body.querySelector('.detail-content');
    if (contentDiv) contentDiv.remove();
    const wrapper = document.createElement('div');
    wrapper.className = 'detail-content';
    wrapper.innerHTML = renderDetailContent(load);
    body.appendChild(wrapper);

    // Подсвечиваем строку
    document.querySelectorAll('#loads-tbody tr').forEach(tr => {
        tr.classList.toggle('selected', tr.dataset.id === load.id);
    });

    // Обновляем кнопки
    const hasPh = !!load.broker?.phone;
    const hasEm = !!load.broker?.email;
    document.getElementById('detail-btn-call').disabled = !hasPh;
    document.getElementById('detail-btn-email').disabled = !hasEm;
    document.getElementById('detail-btn-save').textContent =
        load.status === 'saved' ? 'Saved' : 'Save';

    document.getElementById('detail-panel').classList.add('open');

    // Инициализируем карту после открытия (нужно чтобы контейнер был видим)
    setTimeout(() => initDetailMap(load), 250);
}

function closeDetail() {
    document.getElementById('detail-panel').classList.remove('open');
    document.querySelectorAll('#loads-tbody tr').forEach(tr => tr.classList.remove('selected'));
    state.selectedLoad = null;
}

function renderDetailContent(load) {
    const origin = `${load.origin?.city || ''}, ${load.origin?.state || ''}`;
    const dest = `${load.destination?.city || ''}, ${load.destination?.state || ''}`;
    const rate = load.rate ? `$${load.rate.toLocaleString()}` : '—';
    const rpm = load.rpm ? `$${load.rpm}/mi` : '';

    return `
    <div class="detail-section">
        <h3>Route</h3>
        <div class="detail-route">${esc(origin)} → ${esc(dest)}</div>
        ${rate !== '—' ? `<div class="detail-rate-wrap">
            <span class="detail-rate-big">${rate}</span>
            <span class="detail-rate-rpm">${rpm}</span>
        </div>` : ''}
    </div>

    <div class="detail-section">
        <h3>Broker</h3>
        ${detailRow('Company', load.broker?.company || '—')}
        ${detailRow('Phone', load.broker?.phone
        ? `<a href="tel:${load.broker.phone}" class="detail-link">${load.broker.phone}${load.broker.phoneExt ? ' x' + load.broker.phoneExt : ''}</a>`
        : '—')}
        ${detailRow('Email', load.broker?.email
            ? `<a href="mailto:${load.broker.email}" class="detail-link">${load.broker.email}</a>`
            : '—')}
        ${load.broker?.mc ? detailRow('MC#', load.broker.mc) : ''}
        ${load.broker?.dot ? detailRow('DOT#', load.broker.dot) : ''}
        ${load.broker?.rating != null
            ? detailRow('Credit', `${load.broker.rating}${load.broker.daysToPay ? ' / ' + load.broker.daysToPay + ' days' : ''}`)
            : ''}
    </div>

    <div class="detail-section">
        <h3>Shipment</h3>
        ${detailRow('Type', load.equipment || '—')}
        ${detailRow('Miles', load.miles ? `${load.miles.toLocaleString()} mi` : '—')}
        ${detailRow('Weight', load.weight ? `${load.weight.toLocaleString()} lbs` : '—')}
        ${detailRow('Length', load.length ? `${load.length} ft` : '—')}
        ${detailRow('Deadhead', load.deadhead ? `${Math.round(load.deadhead)} mi` : '—')}
        ${detailRow('Full/Partial', load.fullPartial || '—')}
        ${detailRow('Pickup date', load.pickupDate || '—')}
        ${detailRow('Board', (load.board || '').toUpperCase())}
        ${(load.notes && load.notes.trim()) ? detailRow('Notes', esc(load.notes.trim()).replace(/\\n/g, '<br>')) : ''}
    </div>

    <div class="detail-section">
        <h3>Status</h3>
        ${detailRow('Status', renderStatusBadge(load.status))}
        ${detailRow('Posted', load.postedAt ? new Date(load.postedAt).toLocaleString() : '—')}
    </div>`;
}

function detailRow(label, value) {
    return `<div class="detail-row"><span class="label">${label}</span><span class="value">${value}</span></div>`;
}

// ============================================================
// Detail Map (Leaflet + OSRM)
// ============================================================

let detailMap = null;
let routeLayer = null;

function initDetailMap(load) {
    const mapEl = document.getElementById('detail-map');
    if (!mapEl) return;

    const oLat = load.origin?.lat;
    const oLng = load.origin?.lng;
    const dLat = load.destination?.lat;
    const dLng = load.destination?.lng;

    // Нет координат — скрываем карту
    if (!oLat || !oLng || !dLat || !dLng) {
        mapEl.style.display = 'none';
        return;
    }
    mapEl.style.display = '';

    // Уничтожаем предыдущую карту
    if (detailMap) {
        detailMap.remove();
        detailMap = null;
        routeLayer = null;
    }

    // Создаём карту
    detailMap = L.map(mapEl, {
        zoomControl: false,
        attributionControl: false,
        dragging: false,
        scrollWheelZoom: false,
        doubleClickZoom: false,
        boxZoom: false,
        keyboard: false,
        touchZoom: false,
    });

    // OSM тайлы
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
        maxZoom: 18,
    }).addTo(detailMap);

    const markerStyle = {
        radius: 5, color: '#1f6feb', fillColor: '#1f6feb', fillOpacity: 1, weight: 2,
    };
    L.circleMarker([oLat, oLng], markerStyle).addTo(detailMap);
    L.circleMarker([dLat, dLng], markerStyle).addTo(detailMap);

    // Fit bounds с padding
    const bounds = L.latLngBounds([oLat, oLng], [dLat, dLng]);
    detailMap.fitBounds(bounds, { padding: [20, 20] });

    // Загружаем маршрут через OSRM
    fetchOSRMRoute(oLng, oLat, dLng, dLat).then(coords => {
        if (coords && detailMap) {
            routeLayer = L.polyline(coords, {
                color: '#1f6feb',
                weight: 3,
                opacity: 0.8,
            }).addTo(detailMap);
            detailMap.fitBounds(routeLayer.getBounds(), { padding: [20, 20] });
        }
    }).catch(err => {
        console.warn('[AIDA] OSRM route fetch failed:', err);
    });
}

async function fetchOSRMRoute(lng1, lat1, lng2, lat2) {
    const url = `https://router.project-osrm.org/route/v1/driving/${lng1},${lat1};${lng2},${lat2}?overview=full&geometries=geojson`;
    const resp = await fetch(url);
    if (!resp.ok) return null;
    const data = await resp.json();
    if (data.code !== 'Ok' || !data.routes?.[0]) return null;
    // GeoJSON coordinates [lng, lat] → Leaflet [lat, lng]
    return data.routes[0].geometry.coordinates.map(c => [c[1], c[0]]);
}

// ============================================================
// Actions
// ============================================================

async function doCall(loadId) {
    document.getElementById('detail-btn-call').disabled = true;
    document.getElementById('detail-btn-call').textContent = 'Calling...';

    const resp = await sendToCore('CALL_BROKER', { loadId });

    if (resp?.ok) {
        showToast('Call initiated');
        // Обновляем статус в UI
        const load = state.loads.find(l => l.id === loadId);
        if (load) {
            load.status = 'calling';
            renderTable();
            if (state.selectedLoad?.id === loadId) {
                state.selectedLoad.status = 'calling';
                openDetail(state.selectedLoad);
            }
        }
    } else if (resp?.action === 'email') {
        showToast('Email generated (no phone)');
    } else {
        showToast(resp?.error || 'Call error', 'error');
    }

    document.getElementById('detail-btn-call').disabled = false;
    document.getElementById('detail-btn-call').textContent = 'Call';
}

async function doEmail(loadId) {
    const resp = await sendToCore('CALL_BROKER', { loadId });
    if (resp?.action === 'email' && resp.email) {
        // Открываем mailto
        window.open(
            `mailto:${resp.email.to}?subject=${encodeURIComponent(resp.email.subject)}&body=${encodeURIComponent(resp.email.body)}`
        );
        showToast('Email opened');
    } else if (resp?.ok) {
        showToast('Call initiated');
    } else {
        showToast(resp?.error || 'Error', 'error');
    }
}

async function doSave(loadId) {
    const resp = await sendToCore('SAVE_BOOKMARK', { loadId });
    if (resp?.ok) {
        showToast('Load saved to bookmarks');
        document.getElementById('detail-btn-save').textContent = 'Saved';

        // Обновляем статус в таблице
        const load = state.loads.find(l => l.id === loadId);
        if (load) { load.status = 'saved'; renderTable(); }
    }
}

// ============================================================
// Bookmarks
// ============================================================

async function loadAndRenderBookmarks() {
    const resp = await sendToCore('GET_BOOKMARKS');
    state.bookmarks = Array.isArray(resp?.bookmarks) ? resp.bookmarks : [];
    renderBookmarks();
}

function renderBookmarks() {
    const body = document.getElementById('bookmarks-body');
    if (state.bookmarks.length === 0) {
        body.innerHTML = '<div class="table-empty"><div class="icon"><svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="m19 21-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/></svg></div><div class="msg">No bookmarks</div></div>';
        return;
    }
    body.innerHTML = state.bookmarks.map(load => renderCallCard(load, 'bookmarks')).join('');
    body.querySelectorAll('.call-card').forEach(card => {
        card.addEventListener('click', () => {
            switchSection('search');
            const load = state.bookmarks.find(b => b.id === card.dataset.id);
            if (load) openDetail(load);
        });
    });
}

// ============================================================
// History
// ============================================================

async function loadAndRenderHistory() {
    const resp = await sendToCore('GET_HISTORY', { filters: {} });
    state.history = resp?.history || [];
    renderHistory();
}

function renderHistory() {
    const body = document.getElementById('history-body');
    if (state.history.length === 0) {
        body.innerHTML = '<div class="table-empty"><div class="icon"><svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/></svg></div><div class="msg">History empty</div></div>';
        return;
    }
    body.innerHTML = state.history.map(entry => renderHistoryCard(entry)).join('');
}

function renderHistoryCard(entry) {
    const time = entry.callTime || entry.emailTime || '';
    const timeStr = time ? new Date(time).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—';
    const board = (entry.board || '').toUpperCase();
    const rate = entry.rate ? `$${entry.rate.toLocaleString()}` : '';

    return `
    <div class="call-card">
        <div class="call-card-header">
            <div class="call-card-route">${esc(entry.route || '—')}</div>
            <div class="call-card-time">${timeStr}</div>
        </div>
        <div class="call-card-broker">${esc(entry.broker?.company || entry.broker?.name || '—')}</div>
        <div class="call-card-meta">
            <span>${esc(entry.broker?.phone || entry.broker?.email || '')}</span>
            ${rate ? `<span>${rate}</span>` : ''}
            ${board ? `<span class="board-badge ${entry.board}">${board}</span>` : ''}
            <span class="status-badge ${entry.status}">${entry.status || '—'}</span>
        </div>
    </div>`;
}

function renderCallCard(load, context) {
    const origin = `${load.origin?.city || ''}, ${load.origin?.state || ''}`;
    const dest = `${load.destination?.city || ''}, ${load.destination?.state || ''}`;
    const rate = load.rate ? `$${load.rate.toLocaleString()}` : '—';
    const savedAt = load.savedAt ? new Date(load.savedAt).toLocaleDateString('en-US') : '';

    return `
    <div class="call-card" data-id="${esc(load.id)}">
        <div class="call-card-header">
            <div class="call-card-route">${esc(origin)} → ${esc(dest)}</div>
            ${savedAt ? `<div class="call-card-time">${savedAt}</div>` : ''}
        </div>
        <div class="call-card-broker">${esc(load.broker?.company || load.broker?.name || '—')}</div>
        <div class="call-card-meta">
            <span>${rate}</span>
            <span>${load.miles ? `${load.miles} mi` : ''}</span>
            <span class="board-badge ${load.board}">${(load.board || '').toUpperCase()}</span>
        </div>
    </div>`;
}

// ============================================================
// Settings
// ============================================================

async function saveSettings() {
    const user = {
        name: getVal('set-name'),
        company: getVal('set-company'),
        companyName: getVal('set-company'),
        phone: getVal('set-phone'),
        email: getVal('set-email'),
        retellApiKey: getVal('set-retell-key'),
        retellFromNumber: getVal('set-retell-from'),
        retellAgentId: getVal('set-retell-agent')
    };

    await sendToCore('SAVE_SETTINGS', { data: { user } });
    showToast('Settings saved');
}

async function saveOpenClaw() {
    const openclaw = {
        url: getVal('openclaw-url') || 'http://localhost:3000',
        api_key: getVal('openclaw-key'),
        interval: parseInt(getVal('openclaw-interval')) || 5000,
        enabled: document.getElementById('agent-toggle').checked
    };

    await sendToCore('SAVE_SETTINGS', { data: { openclaw } });
    showToast('OpenClaw settings saved');
}

function getVal(id) {
    return document.getElementById(id)?.value || '';
}

// ============================================================
// Agent
// ============================================================

async function toggleAgent(enabled) {
    state.agentEnabled = enabled;

    const settings = await sendToCore('GET_SETTINGS');
    const current = settings?.settings || {};
    const openclaw = { ...(current.openclaw || {}), enabled };

    await sendToCore('SAVE_SETTINGS', { data: { ...current, openclaw } });
    await sendToCore('TOGGLE_AGENT', { enabled });

    updateAgentStatus();
    showToast(enabled ? 'Agent started' : 'Agent stopped');
}

function updateAgentStatus() {
    const statusEl = document.getElementById('status-agent');
    const statusText = document.getElementById('agent-status-text');

    if (state.agentEnabled) {
        statusEl.textContent = 'Agent: on';
        statusEl.style.color = 'var(--success)';
        if (statusText) statusText.textContent = 'Active';
    } else {
        statusEl.textContent = 'Agent: off';
        statusEl.style.color = 'var(--text-secondary)';
        if (statusText) statusText.textContent = 'Off';
    }
}

// ============================================================
// Status Bar
// ============================================================

/** Обновить кнопки-индикаторы бордов по state.boardStatus.
 *  🟢 = ВКЛ (enabled), 🔴 = ВЫКЛ (disabled).
 *  Клик = toggle.
 */
function updateBoardDots() {
    const boards = ['dat', 'truckstop', 'tp'];
    for (const board of boards) {
        const btn = document.getElementById(`board-btn-${board}`);
        if (!btn) continue;
        const bs = state.boardStatus[board];
        const disabled = typeof bs === 'object' ? !!bs?.disabled : false;

        btn.classList.remove('connected', 'has-token', 'disabled', 'expired', 'no-token', 'logging-in');

        if (disabled) {
            btn.classList.add('disabled');
            btn.title = `${board.toUpperCase()} — OFF (click to enable)`;
        } else {
            btn.classList.add('connected');
            btn.title = `${board.toUpperCase()} — ON (click to disable)`;
        }
    }
}



// ============================================================
// New Loads Bar — SSE уведомление о новых грузах
// ============================================================

function updateNewLoadsIndicator(count) {
    const el = document.getElementById('status-new');
    if (!el) return;
    if (count <= 0) {
        el.style.display = 'none';
        return;
    }
    el.querySelector('span').textContent = `+${count} new`;
    el.style.display = '';
    el.onclick = refreshLoads;
}

async function refreshLoads() {
    const el = document.getElementById('status-new');
    if (el) { el.querySelector('span').textContent = '...'; el.style.pointerEvents = 'none'; }
    const resp = await sendToCore('REFRESH_LOADS');
    if (el) { el.style.display = 'none'; el.style.pointerEvents = ''; }
    if (resp?.error) {
        showToast(resp.error, 'error');
    }
}

function updateStatusBar() {
    const countEl = document.getElementById('status-count');
    const active = state.loads.filter(l => l.status === 'active').length;
    const total = state.loads.length;

    if (countEl) countEl.querySelector('span').textContent = `${active} loads${total !== active ? ` (${total} total)` : ''}`;

    state.lastRefreshTime = Date.now();
    updateRefreshTimer();
}

function updateRefreshTimer() {
    const updEl = document.getElementById('status-updated');
    if (!updEl || !state.lastRefreshTime) return;
    const sec = Math.floor((Date.now() - state.lastRefreshTime) / 1000);
    let text;
    if (sec < 10) text = 'just now';
    else if (sec < 60) text = `${sec}s ago`;
    else text = `${Math.floor(sec / 60)}m ago`;
    updEl.querySelector('span').textContent = text;
}

// Живой таймер — обновляется каждые 10 секунд
setInterval(updateRefreshTimer, 10_000);

function showTableLoading(show) {
    const btn = document.getElementById('btn-search');
    btn.textContent = show ? 'Searching...' : 'Search';
    btn.disabled = show;
}

function showTableEmpty(show) {
    document.getElementById('table-empty').style.display = show ? 'flex' : 'none';
}

// ============================================================
// Theme
// ============================================================

function toggleTheme() {
    const html = document.documentElement;
    const isDark = html.dataset.theme === 'dark';
    const newTheme = isDark ? 'light' : 'dark';
    html.dataset.theme = newTheme;
    console.log('[AIDA/UI] Step: toggleTheme →', newTheme);
    sendToCore('SAVE_SETTINGS', { data: { theme: newTheme } });
}

// ============================================================
// Toasts
// ============================================================

function showToast(message, type = 'success') {
    const container = document.getElementById('toast-container');
    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    toast.textContent = message;
    container.appendChild(toast);
    setTimeout(() => toast.remove(), 3000);
}

// ============================================================
// Utils
// ============================================================

function esc(str) {
    if (!str) return '';
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

// ============================================================
// Start
// ============================================================

init().catch(err => {
    console.error('[AIDA/UI] init failed:', err);
});
