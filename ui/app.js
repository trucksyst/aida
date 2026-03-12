/**
 * AIDA v0.1 — SidePanel UI
 * Главный контроллер интерфейса диспетчера.
 *
 * UI не использует chrome.storage. Все данные — только через Core API (sendMessage).
 * Обновления в реальном времени — push от Core (onMessage, type DATA_UPDATED).
 */

/** Локальная дата YYYY-MM-DD (не UTC — toISOString даёт +1 день вечером в CST/EST). */
function localDateStr(d) {
    const dt = d || new Date();
    return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
}

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
    searchPresets: [],   // max 8 saved search presets
    columns: null,       // ordered column keys (loaded from storage)
    colWidths: {},       // column key → width in px (persisted)
};

/** Форматирование телефона: +1(XXX)XXX-XXXX ext.123 для US/CA */
function formatPhone(raw, ext) {
    if (!raw) return '—';
    let phone = raw;
    // Извлекаем добавочный из строки если он встроен (x123, ext 123, #123)
    if (!ext) {
        const extMatch = phone.match(/(?:x|ext\.?|#)\s*(\d+)$/i);
        if (extMatch) {
            ext = extMatch[1];
            phone = phone.slice(0, extMatch.index);
        }
    }
    const digits = phone.replace(/\D/g, '');
    let formatted = raw;
    // 10 цифр — US без кода страны
    if (digits.length === 10) {
        formatted = `+1(${digits.slice(0, 3)})${digits.slice(3, 6)}-${digits.slice(6)}`;
    }
    // 11 цифр начинающихся с 1 — US/CA с кодом страны
    else if (digits.length === 11 && digits[0] === '1') {
        formatted = `+1(${digits.slice(1, 4)})${digits.slice(4, 7)}-${digits.slice(7)}`;
    }
    // 12 цифр начинающихся с 52 — Мексика
    else if (digits.length === 12 && digits.startsWith('52')) {
        formatted = `+52(${digits.slice(2, 5)})${digits.slice(5, 8)}-${digits.slice(8)}`;
    }
    // Другой формат — возвращаем как есть
    else {
        formatted = raw;
    }

    if (ext) formatted += ` ext.${ext}`;
    return formatted;
}

/** Реестр всех столбцов таблицы грузов. key → { label, sortKey, cls, render } */
const ALL_COLUMNS = {
    rate: { label: 'Rate', sortKey: 'rate', cls: 'td-rate', render: l => l.rate ? `$${l.rate.toLocaleString()}` : '—' },
    rpm: { label: '$/mi', sortKey: 'rpm', cls: 'td-rpm', render: l => l.rpm ? `$${l.rpm}` : '—' },
    equipment: { label: 'Type', sortKey: 'equipment', cls: '', render: l => esc(l.equipment || '—') },
    route: {
        label: 'Route', sortKey: 'origin', cls: 'td-route', render: l => {
            const o = `${l.origin?.city || ''}, ${l.origin?.state || ''}`;
            const d = `${l.destination?.city || ''}, ${l.destination?.state || ''}`;
            return `<strong>${esc(o)}</strong> <span class="route-arrow">→</span> <strong>${esc(d)}</strong>`;
        }
    },
    miles: { label: 'Miles', sortKey: 'miles', cls: '', render: l => l.miles ? `${l.miles.toLocaleString()}` : '—' },
    weight: { label: 'Weight', sortKey: 'weight', cls: '', render: l => l.weight ? `${(l.weight / 1000).toFixed(0)}k lbs` : '—' },
    length: { label: 'Length', sortKey: 'length', cls: '', render: l => l.length ? `${l.length} ft` : '—' },
    fullPartial: { label: 'F/P', sortKey: 'fullPartial', cls: '', render: l => l.fullPartial || '—' },
    deadhead: { label: 'DH mi', sortKey: 'deadhead', cls: '', render: l => l.deadhead ? `${l.deadhead}` : '—' },
    broker: { label: 'Broker', sortKey: 'broker', cls: '', render: l => esc(l.broker?.company || '—') },
    phone: { label: 'Phone', sortKey: 'phone', cls: '', render: l => l.broker?.phone ? formatPhone(l.broker.phone, l.broker?.phoneExt) : '—' },
    email: { label: 'Email', sortKey: 'email', cls: '', render: l => l.broker?.email ? esc(l.broker.email) : '—' },
    mc: { label: 'MC#', sortKey: 'mc', cls: '', render: l => l.broker?.mc || '—' },
    rating: { label: 'Rating', sortKey: 'rating', cls: '', render: l => l.broker?.rating != null ? String(l.broker.rating) : '—' },
    daysToPay: { label: 'DTP', sortKey: 'daysToPay', cls: '', render: l => l.broker?.daysToPay != null ? `${l.broker.daysToPay}d` : '—' },
    board: { label: 'Board', sortKey: 'board', cls: 'td-board', render: l => { const b = (l.board || '').toLowerCase(); const iconMap = { dat: 'icons/dat.png', truckstop: 'icons/truckstop.jpg', ts: 'icons/truckstop.jpg', tp: 'icons/tp.webp' }; const src = iconMap[b]; return src ? `<img class="board-icon board-icon--${b}" src="${src}" alt="${esc(l.board || '')}" title="${esc(l.board || '')}">` : `<span class="board-badge ${esc(b)}">${(l.board || '').toUpperCase()}</span>`; } },
    posted: { label: 'Posted', sortKey: 'postedAt', cls: 'td-posted', render: l => formatPostedAgo(l.postedAt) },
    pickupDate: { label: 'Pickup', sortKey: 'pickupDate', cls: '', render: l => formatPickupWindow(l.pickupDate, l.pickupDateEnd) },
    status: { label: 'Status', sortKey: 'status', cls: '', render: l => renderStatusBadge(l.status) },
    notes: { label: 'Notes', sortKey: 'notes', cls: 'td-notes', render: l => l.notes ? esc(l.notes.substring(0, 35)) : '' },
    bookNow: { label: 'Book', sortKey: 'bookNow', cls: '', render: l => l.bookNow ? '<span class="book-badge">✓</span>' : '' },
};

/** Полный порядок всех столбцов для config panel */
const FULL_COLUMN_ORDER = ['rate', 'rpm', 'equipment', 'route', 'miles', 'weight', 'length', 'fullPartial', 'deadhead', 'broker', 'phone', 'email', 'mc', 'rating', 'daysToPay', 'board', 'posted', 'pickupDate', 'status', 'notes', 'bookNow'];

/** Столбцы видимые по умолчанию */
const DEFAULT_COLUMNS = ['rate', 'rpm', 'equipment', 'route', 'miles', 'weight', 'broker', 'board', 'posted', 'status'];

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

    if (resp?.settings) {
        state.settings = resp.settings;
        applySettings(resp.settings);
    }

    // Очищаем старые грузы при открытии — каждый раз чистый старт
    await sendToCore('CLEAR_LOADS');
    state.loads = [];
    // Даты по умолчанию — окно 3 дня (LOCAL, не UTC)
    document.getElementById('date-from').value = localDateStr();
    const _initEnd = new Date(); _initEnd.setDate(_initEnd.getDate() + 3);
    document.getElementById('date-to').value = localDateStr(_initEnd);

    // Подставить последний поиск (память формы) — Core сохраняет lastSearch при каждом Search
    if (resp?.settings?.lastSearch) {
        applyLastSearch(resp.settings.lastSearch);

    }

    // Статус бордов и тема уже в resp.settings (boardStatus, theme) — применены в applySettings
    await loadColumnsOrder(); // Load column order before first render
    renderTable();
    updateStatusBar();

    // Load search presets from storage
    await loadSearchPresets();

    bindEvents();

    // Единственная подписка на обновления — push от Core (контракт API)
    chrome.runtime.onMessage.addListener(onDataUpdated);
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
    if (lastSearch.destRadius != null) setVal('dest-radius', lastSearch.destRadius);
    if (lastSearch.equipment) {
        const eqArr = Array.isArray(lastSearch.equipment) ? lastSearch.equipment : [lastSearch.equipment];
        setEquipmentChecked(eqArr);
    }
    if (lastSearch.maxWeight > 0) setVal('max-weight', lastSearch.maxWeight);
    // Даты: окно 3 дня LOCAL (не UTC — иначе вечером в CST/EST дата +1)
    const now = new Date();
    const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
    const end = new Date(now); end.setDate(end.getDate() + 3);
    const endStr = `${end.getFullYear()}-${String(end.getMonth() + 1).padStart(2, '0')}-${String(end.getDate()).padStart(2, '0')}`;
    setVal('date-from', today);
    setVal('date-to', endStr);
}

// ============================================================
// Push от Core (DATA_UPDATED) — единственный канал обновлений
// ============================================================

function onDataUpdated(message) {

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

/** Create a preset object from current form values (including date window). */
function buildPresetFromForm() {
    // Вычисляем относительное окно дат (количество дней между FROM и TO)
    const fromStr = document.getElementById('date-from').value;
    const toStr = document.getElementById('date-to').value;
    let dateWindow = 3; // дефолт
    if (fromStr && toStr) {
        const diff = Math.round((new Date(toStr) - new Date(fromStr)) / 86400000);
        if (diff >= 0) dateWindow = diff;
    }
    return {
        id: String(Date.now()),
        origin: document.getElementById('origin-city').value.trim(),
        radius: parseInt(document.getElementById('search-radius').value) || 50,
        dest: document.getElementById('dest-city').value.trim(),
        equipment: getSelectedEquipment(),
        dateWindow,
        maxWeight: parseInt(document.getElementById('max-weight').value) || 0
    };
}

/** Check if a preset with same params already exists. */
function presetExists(p) {
    return state.searchPresets.some(x =>
        x.origin === p.origin &&
        x.dest === p.dest &&
        x.radius === p.radius &&
        (x.dateWindow ?? 3) === (p.dateWindow ?? 3) &&
        (x.maxWeight || 0) === (p.maxWeight || 0) &&
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

    // Вариант B: save + search
    doSearch();
}

/** Apply a preset to the form, restore date window, then search. */
function applyPreset(presetId) {
    const p = state.searchPresets.find(x => x.id === presetId);
    if (!p) return;
    setVal('origin-city', p.origin || '');
    setVal('search-radius', p.radius != null ? p.radius : 50);
    setVal('dest-city', p.dest || '');
    if (p.equipment) setEquipmentChecked(p.equipment);
    setVal('max-weight', p.maxWeight || '');

    // Даты: today → today + dateWindow (относительное окно)
    const window = p.dateWindow ?? 3;
    const today = new Date();
    const endDate = new Date(today);
    endDate.setDate(endDate.getDate() + window);
    setVal('date-from', localDateStr(today));
    setVal('date-to', localDateStr(endDate));

    // Закрыть dropdown
    document.getElementById('preset-dropdown').classList.remove('open');
    // Apply + auto-search
    doSearch();
}

/** Delete a preset by id. */
async function deletePreset(presetId) {
    state.searchPresets = state.searchPresets.filter(x => x.id !== presetId);
    await savePresetsToStorage();
    renderPresetDropdown();
    showToast('Preset deleted');

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
            <button class="preset-item-delete" data-action="delete" data-id="${p.id}" title="Delete">✕</button>
        </div>`;
    }).join('');

    // Bind clicks
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

    // Column reorder + sort via Pointer Events (dynamic headers)
    initColumnReorder();
    // Column resize (drag right edge of header)
    initColumnResize();
    // Column config panel (⚙️ gear button)
    initColConfig();
    // JS-managed frozen header (CSS sticky не работает при overflow-x+y на одном контейнере)
    initFrozenHeader();

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

    // Infinite scroll: подгрузка следующей пачки грузов при прокрутке
    const tableWrap = document.getElementById('load-table-wrap');
    tableWrap.addEventListener('scroll', () => {
        if (_loadingMore || !_hasMoreLoads) return;
        const { scrollTop, scrollHeight, clientHeight } = tableWrap;
        if (scrollTop + clientHeight >= scrollHeight - 200) {
            loadMore();
        }
    });
}

// Infinite scroll state
let _loadingMore = false;
let _hasMoreLoads = true;

async function loadMore() {
    if (_loadingMore || !_hasMoreLoads) return;
    _loadingMore = true;

    const spinner = document.getElementById('load-more-spinner');
    if (spinner) spinner.style.display = 'flex';

    try {
        const resp = await sendToCore('LOAD_MORE');
        if (resp?.added > 0) {
            showToast(`+${resp.added} loads`);
        }
        if (resp?.hasMore === false) {
            _hasMoreLoads = false;

        }
    } catch (e) {
        console.warn('[AIDA/UI] loadMore error:', e);
    } finally {
        _loadingMore = false;
        if (spinner) spinner.style.display = 'none';
    }
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

    // Даты: сегодня (LOCAL)
    setVal('date-from', localDateStr());
    setVal('date-to', localDateStr());

    // Equipment: Van
    setEquipmentChecked(['VAN']);

    setTimeout(() => doSearch(), 300);
}
async function doSearch() {
    const params = getSearchParams();

    if (!params.origin.city && !params.origin.state) {
        showToast('Enter origin city or state', 'error');
        return;
    }

    const btn = document.getElementById('btn-search');
    btn.textContent = 'Searching...';
    btn.disabled = true;

    showTableEmpty(false);
    showTableLoading(true);
    _hasMoreLoads = true; // сброс пагинации


    try {

        const resp = await sendToCore('SEARCH_LOADS', { params });

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
        dateTo: document.getElementById('date-to').value,
        maxWeight: parseInt(document.getElementById('max-weight').value) || 0
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
    const theadRow = document.getElementById('thead-row');
    const tbody = document.getElementById('loads-tbody');
    const empty = document.getElementById('table-empty');

    // Ensure columns initialized
    if (!state.columns || !state.columns.length) state.columns = [...DEFAULT_COLUMNS];

    // ── Dynamic thead (в #load-table-header, frozen) ──
    theadRow.innerHTML = state.columns.map(key => {
        const col = ALL_COLUMNS[key];
        if (!col) return '';
        const isSorted = state.sortColumn === col.sortKey;
        const sortCls = isSorted ? ` sorted${state.sortAsc ? ' asc' : ''}` : '';
        const w = state.colWidths?.[key];
        const wStyle = w ? ` style="width:${w}px"` : '';
        return `<th data-col-key="${key}" data-sort="${col.sortKey}" class="${sortCls}"${wStyle}>${col.label}<div class="col-resize-handle"></div></th>`;
    }).join('');

    // ── Синхронизируем ширины колонок в body-таблице через colgroup ──
    const headerTable = document.getElementById('load-table-header');
    const bodyTable = document.getElementById('load-table');
    const colgroup = document.getElementById('load-colgroup');

    if (colgroup) {
        colgroup.innerHTML = state.columns.map(key => {
            const w = state.colWidths?.[key];
            // При table-layout:fixed столбцы без ширины получают дефолт
            return `<col style="width:${w || 100}px">`;
        }).join('');
    }

    // table-layout: fixed на обоих — гарантирует одинаковые ширины
    if (Object.keys(state.colWidths || {}).length > 0) {
        if (headerTable) headerTable.style.tableLayout = 'fixed';
        bodyTable.style.tableLayout = 'fixed';
    }

    // ── Rows ──
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
            case 'length': va = a.length || 0; vb = b.length || 0; break;
            case 'deadhead': va = a.deadhead || 0; vb = b.deadhead || 0; break;
            case 'rating': va = a.broker?.rating || 0; vb = b.broker?.rating || 0; break;
            case 'daysToPay': va = a.broker?.daysToPay || 0; vb = b.broker?.daysToPay || 0; break;
            case 'equipment': va = a.equipment || ''; vb = b.equipment || ''; break;
            case 'fullPartial': va = a.fullPartial || ''; vb = b.fullPartial || ''; break;
            case 'origin': va = a.origin?.city || ''; vb = b.origin?.city || ''; break;
            case 'destination': va = a.destination?.city || ''; vb = b.destination?.city || ''; break;
            case 'broker': va = a.broker?.company || ''; vb = b.broker?.company || ''; break;
            case 'phone': va = a.broker?.phone || ''; vb = b.broker?.phone || ''; break;
            case 'mc': va = a.broker?.mc || ''; vb = b.broker?.mc || ''; break;
            case 'board': va = a.board || ''; vb = b.board || ''; break;
            case 'pickupDate': va = a.pickupDate || ''; vb = b.pickupDate || ''; break;
            case 'postedAt': va = a.postedAt || ''; vb = b.postedAt || ''; break;
            case 'status': va = a.status || ''; vb = b.status || ''; break;
            case 'notes': va = a.notes || ''; vb = b.notes || ''; break;
            case 'bookNow': va = a.bookNow ? 1 : 0; vb = b.bookNow ? 1 : 0; break;
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

/**
 * Формат окна пикапа для таблицы: MM/DD–MM/DD или MM/DD.
 */
function formatPickupWindow(start, end) {
    if (!start) return '—';
    const s = start.slice(0, 10);
    const sStr = `${s.slice(5, 7)}/${s.slice(8, 10)}`;
    if (!end || end.slice(0, 10) === s) return sStr;
    const e = end.slice(0, 10);
    return `${sStr}–${e.slice(5, 7)}/${e.slice(8, 10)}`;
}

/**
 * Длинный формат окна пикапа для детаил-панели.
 * Одна дата → "Mar 05", диапазон → "Mar 05 – Mar 09".
 */
function formatPickupWindowLong(start, end) {
    if (!start) return '—';
    const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    function fmt(dateStr) {
        const d = dateStr.slice(0, 10);
        const month = MONTHS[parseInt(d.slice(5, 7), 10) - 1] || '';
        const day = d.slice(8, 10);
        return `${month} ${day}`;
    }
    const s = start.slice(0, 10);
    if (!end || end.slice(0, 10) === s) return fmt(s);
    return `${fmt(s)} – ${fmt(end.slice(0, 10))}`;
}


function renderRow(load) {
    const rowClass = `status-${load.status || 'active'}`;

    const cells = state.columns.map(key => {
        const col = ALL_COLUMNS[key];
        if (!col) return '';
        const cls = col.cls ? ` class="${col.cls}"` : '';
        return `<td data-col-key="${key}"${cls}>${col.render(load)}</td>`;
    }).join('');

    return `<tr data-id="${esc(load.id)}" class="${rowClass}">${cells}</tr>`;
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
// Column Reorder — Google Sheets style (Pointer Events)
// ============================================================

let _colDrag = null;

function initColumnReorder() {
    const table = document.getElementById('load-table-header');
    if (!table) return;
    table.addEventListener('pointerdown', onColDragStart);
    document.addEventListener('pointermove', onColDragMove);
    document.addEventListener('pointerup', onColDragEnd);
}

function onColDragStart(e) {
    // Don't start reorder when clicking resize handle
    if (e.target.closest('.col-resize-handle')) return;
    const th = e.target.closest('#load-table-header thead th[data-col-key]');
    if (!th) return;

    e.preventDefault();
    th.setPointerCapture(e.pointerId);

    const allThs = [...document.querySelectorAll('#load-table-header thead th[data-col-key]')];
    const colIndex = allThs.indexOf(th);

    // Cells for drag animation: header th + body td
    const cellsByCol = {};
    state.columns.forEach(key => {
        cellsByCol[key] = [
            ...document.querySelectorAll(`#load-table-header [data-col-key="${key}"]`),
            ...document.querySelectorAll(`#load-table [data-col-key="${key}"]`)
        ];
    });

    _colDrag = {
        colKey: th.dataset.colKey,
        colIndex,
        startX: e.clientX,
        rects: allThs.map(t => t.getBoundingClientRect()),
        cellsByCol,
        moved: false,
        targetIndex: colIndex,
    };
}

function onColDragMove(e) {
    if (!_colDrag) return;

    const dx = e.clientX - _colDrag.startX;

    // Minimum threshold before starting drag (5px dead zone)
    if (!_colDrag.moved && Math.abs(dx) < 5) return;

    if (!_colDrag.moved) {
        _colDrag.moved = true;
        document.body.classList.add('col-reordering');
        // Mark dragged column cells
        _colDrag.cellsByCol[_colDrag.colKey].forEach(el => el.classList.add('col-dragging'));
    }

    // Translate dragged column
    const dragKey = _colDrag.colKey;
    for (const el of _colDrag.cellsByCol[dragKey]) {
        el.style.transform = `translateX(${dx}px)`;
    }

    // Compute drag center position
    const origRect = _colDrag.rects[_colDrag.colIndex];
    const dragCenter = origRect.left + origRect.width / 2 + dx;
    const dragWidth = origRect.width;

    // Determine target index based on drag center vs. other column centers
    let targetIndex = _colDrag.colIndex;
    for (let i = 0; i < state.columns.length; i++) {
        if (i === _colDrag.colIndex) continue;
        const center = _colDrag.rects[i].left + _colDrag.rects[i].width / 2;
        if (i < _colDrag.colIndex && dragCenter < center) {
            targetIndex = Math.min(targetIndex, i);
        } else if (i > _colDrag.colIndex && dragCenter > center) {
            targetIndex = Math.max(targetIndex, i);
        }
    }
    _colDrag.targetIndex = targetIndex;

    // Shift neighboring columns to make room (CSS transition handles animation)
    for (let i = 0; i < state.columns.length; i++) {
        if (i === _colDrag.colIndex) continue;
        const key = state.columns[i];
        let shift = 0;

        if (_colDrag.colIndex < targetIndex && i > _colDrag.colIndex && i <= targetIndex) {
            shift = -dragWidth; // Dragging right → push left
        } else if (_colDrag.colIndex > targetIndex && i >= targetIndex && i < _colDrag.colIndex) {
            shift = dragWidth;  // Dragging left → push right
        }

        for (const el of _colDrag.cellsByCol[key]) {
            el.style.transform = shift ? `translateX(${shift}px)` : '';
        }
    }
}

function onColDragEnd() {
    if (!_colDrag) return;

    const from = _colDrag.colIndex;
    const to = _colDrag.targetIndex;

    // Clear all transforms and classes
    for (const cells of Object.values(_colDrag.cellsByCol)) {
        for (const el of cells) {
            el.style.transform = '';
            el.classList.remove('col-dragging');
        }
    }
    document.body.classList.remove('col-reordering');

    if (_colDrag.moved) {
        // Drag completed — reorder columns
        if (from !== to) {
            const [moved] = state.columns.splice(from, 1);
            state.columns.splice(to, 0, moved);
            saveColumnsConfig();
        }
        renderTable();
    } else {
        // Click (no drag) — toggle sort
        const col = ALL_COLUMNS[_colDrag.colKey];
        if (col?.sortKey) {
            if (state.sortColumn === col.sortKey) {
                state.sortAsc = !state.sortAsc;
            } else {
                state.sortColumn = col.sortKey;
                state.sortAsc = false;
            }
            renderTable();
        }
    }

    _colDrag = null;
}

/** Save column config (order + widths) to chrome.storage.local */
function saveColumnsConfig() {
    try {
        chrome.storage.local.set({
            'aida:columnsOrder': state.columns,
            'aida:colWidths': state.colWidths,
        });
    } catch (e) {
        console.warn('[AIDA/UI] Failed to save columns config:', e);
    }
}

/** Load column config (order + widths) from chrome.storage.local */
function loadColumnsOrder() {
    return new Promise(resolve => {
        try {
            chrome.storage.local.get(['aida:columnsOrder', 'aida:colWidths'], result => {
                const saved = result?.['aida:columnsOrder'];
                if (Array.isArray(saved) && saved.length > 0) {
                    const valid = saved.filter(k => ALL_COLUMNS[k]);
                    for (const k of DEFAULT_COLUMNS) {
                        if (!valid.includes(k)) valid.push(k);
                    }
                    state.columns = valid;
                } else {
                    state.columns = [...DEFAULT_COLUMNS];
                }
                state.colWidths = result?.['aida:colWidths'] || {};
                resolve();
            });
        } catch (e) {
            state.columns = [...DEFAULT_COLUMNS];
            state.colWidths = {};
            resolve();
        }
    });
}

// ============================================================
// Column Resize (drag right edge of header)
// ============================================================

let _colResize = null;

function initColumnResize() {
    const table = document.getElementById('load-table-header');
    if (!table) return;
    table.addEventListener('pointerdown', onColResizeStart);
    document.addEventListener('pointermove', onColResizeMove);
    document.addEventListener('pointerup', onColResizeEnd);
}

function onColResizeStart(e) {
    const handle = e.target.closest('.col-resize-handle');
    if (!handle) return;

    e.preventDefault();
    e.stopPropagation();
    handle.setPointerCapture(e.pointerId);

    const th = handle.closest('th[data-col-key]');
    if (!th) return;

    const headerTable = document.getElementById('load-table-header');
    const bodyTable = document.getElementById('load-table');
    const colgroup = document.getElementById('load-colgroup');
    const allThs = [...headerTable.querySelectorAll('thead th[data-col-key]')];

    // 1) Читаем все ширины ДО любых изменений стилей
    const widths = allThs.map(t => Math.round(t.getBoundingClientRect().width));
    const tableWidth = Math.round(headerTable.getBoundingClientRect().width);
    const colIndex = allThs.indexOf(th);

    // 2) Атомарно замораживаем HEADER
    headerTable.style.tableLayout = 'fixed';
    headerTable.style.width = tableWidth + 'px';
    allThs.forEach((t, i) => {
        const w = widths[i] + 'px';
        t.style.width = w;
        t.style.minWidth = w;
        t.style.maxWidth = w;
        state.colWidths[t.dataset.colKey] = widths[i];
    });
    th.style.maxWidth = '';  // текущий столбец можно тянуть

    // 3) Атомарно замораживаем BODY (colgroup + table width)
    if (bodyTable) {
        bodyTable.style.tableLayout = 'fixed';
        bodyTable.style.width = tableWidth + 'px';
    }
    if (colgroup) {
        // Каждый <col> получает точную px ширину
        const cols = [...colgroup.children];
        cols.forEach((col, i) => {
            col.style.width = widths[i] + 'px';
        });
    }

    _colResize = {
        colKey: th.dataset.colKey,
        th,
        startX: e.clientX,
        startWidth: widths[colIndex],
        headerTable,
        bodyTable,
        colgroup,
        colIndex,
        frozenWidth: tableWidth,
    };

    document.body.classList.add('col-resizing');
}

function onColResizeMove(e) {
    if (!_colResize) return;

    const dx = e.clientX - _colResize.startX;
    const newWidth = Math.max(40, _colResize.startWidth + dx);
    const newTableWidth = (_colResize.frozenWidth + dx) + 'px';

    // Header: только текущий th + общая ширина
    _colResize.th.style.width = newWidth + 'px';
    _colResize.th.style.minWidth = newWidth + 'px';
    _colResize.headerTable.style.width = newTableWidth;

    // Body: только текущий col + общая ширина
    if (_colResize.colgroup) {
        const col = _colResize.colgroup.children[_colResize.colIndex];
        if (col) col.style.width = newWidth + 'px';
    }
    if (_colResize.bodyTable) {
        _colResize.bodyTable.style.width = newTableWidth;
    }
}

function onColResizeEnd() {
    if (!_colResize) return;

    // Сохраняем ВСЕ текущие ширины (не только изменённый столбец)
    const allThs = [..._colResize.headerTable.querySelectorAll('thead th[data-col-key]')];
    allThs.forEach(t => {
        state.colWidths[t.dataset.colKey] = Math.round(t.getBoundingClientRect().width);
        t.style.minWidth = '';
        t.style.maxWidth = '';
    });

    // Считаем точную суммарную ширину всех колонок
    const totalWidth = Object.keys(state.colWidths).reduce((sum, key) => {
        return state.columns.includes(key) ? sum + (state.colWidths[key] || 100) : sum;
    }, 0);

    // Ставим точную ширину на обе таблицы — без скачка
    const tw = totalWidth + 'px';
    _colResize.headerTable.style.width = tw;
    if (_colResize.bodyTable) _colResize.bodyTable.style.width = tw;

    saveColumnsConfig();
    document.body.classList.remove('col-resizing');
    _colResize = null;

    // Обновить colgroup из актуальных ширин
    syncFrozenHeader();
}

// ============================================================
// Header Scroll Sync — синхронизирует X-скролл header и body
// ============================================================

function initFrozenHeader() {
    const wrap = document.getElementById('load-table-wrap');
    const headerWrap = document.getElementById('table-header-wrap');
    if (!wrap || !headerWrap) return;

    // Когда body скроллится горизонтально — двигаем header синхронно
    wrap.addEventListener('scroll', () => {
        headerWrap.scrollLeft = wrap.scrollLeft;
    });
}

/** syncFrozenHeader — обновить ширины colgroup в body при resize */
function syncFrozenHeader() {
    const colgroup = document.getElementById('load-colgroup');
    if (!colgroup) return;
    const ths = [...document.querySelectorAll('#load-table-header thead th[data-col-key]')];
    colgroup.innerHTML = ths.map(th => {
        const w = th.getBoundingClientRect().width || (state.colWidths?.[th.dataset.colKey] || 80);
        return `<col style="width:${Math.round(w)}px">`;
    }).join('');
}

// ============================================================
// Column Config Panel (⚙️ dropdown with checkboxes)
// ============================================================

function initColConfig() {
    const btn = document.getElementById('col-config-btn');
    const panel = document.getElementById('col-config-panel');
    if (!btn || !panel) return;

    btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const isOpen = panel.classList.toggle('open');
        if (isOpen) {
            const rect = btn.getBoundingClientRect();
            panel.style.top = (rect.bottom + 4) + 'px';
            panel.style.right = (window.innerWidth - rect.right) + 'px';
            panel.style.left = 'auto';
            renderColConfigPanel();
        }
    });

    // Close on outside click
    document.addEventListener('click', (e) => {
        if (!e.target.closest('#col-config-panel') && !e.target.closest('#col-config-btn')) {
            panel.classList.remove('open');
        }
    });
}

function renderColConfigPanel() {
    const panel = document.getElementById('col-config-panel');
    if (!panel) return;

    const items = FULL_COLUMN_ORDER.map(key => {
        const col = ALL_COLUMNS[key];
        if (!col) return '';
        const checked = state.columns.includes(key) ? 'checked' : '';
        return `<label class="col-config-item">
            <input type="checkbox" data-col="${key}" ${checked}>
            <span>${col.label}</span>
        </label>`;
    }).join('');

    panel.innerHTML = `<div class="col-config-header">Columns</div><div class="col-config-list">${items}</div>`;

    // Bind checkbox changes
    panel.querySelectorAll('input[type="checkbox"]').forEach(cb => {
        cb.addEventListener('change', () => {
            const key = cb.dataset.col;
            if (cb.checked) {
                if (!state.columns.includes(key)) {
                    // Вставляем перед последним столбцом (status обычно последний видимый)
                    const insertAt = Math.max(0, state.columns.length - 1);
                    state.columns.splice(insertAt, 0, key);
                }
            } else {
                // Remove
                state.columns = state.columns.filter(k => k !== key);
                delete state.colWidths[key];
            }
            saveColumnsConfig();
            renderTable();
        });
    });
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
        ${detailRow('Deadhead', load.deadhead ? `${load.deadhead} mi` : '—')}
        ${detailRow('Full/Partial', load.fullPartial || '—')}
        ${detailRow('Pickup window', formatPickupWindowLong(load.pickupDate, load.pickupDateEnd))}
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

/**
 * Геокодировка «City, ST» → { lat, lng } через Nominatim.
 * Используется когда адаптер не вернул координаты (Truckstop, TruckerPath).
 */
async function geocodeCityState(city, state) {
    if (!city && !state) return null;
    const q = [city, state].filter(Boolean).join(', ') + ', USA';
    try {
        const resp = await fetch(
            `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(q)}&format=json&limit=1`,
            { headers: { 'Accept': 'application/json', 'User-Agent': 'AIDA/1.0 (Chrome Extension)' } }
        );
        if (!resp.ok) return null;
        const data = await resp.json();
        const first = Array.isArray(data) && data[0];
        if (!first) return null;
        return { lat: parseFloat(first.lat), lng: parseFloat(first.lon) };
    } catch (e) {
        console.warn('[AIDA/Map] geocodeCityState failed:', e?.message);
        return null;
    }
}

async function initDetailMap(load) {
    const mapEl = document.getElementById('detail-map');
    if (!mapEl) return;

    let oLat = load.origin?.lat;
    let oLng = load.origin?.lng;
    let dLat = load.destination?.lat;
    let dLng = load.destination?.lng;

    // Если нет координат — геокодируем city+state (работает для всех бордов)
    const needsGeocode = !oLat || !oLng || !dLat || !dLng;
    if (needsGeocode) {
        // Показываем спиннер пока геокодируем
        mapEl.style.display = '';
        // Уничтожаем старую карту если была
        if (detailMap) { detailMap.remove(); detailMap = null; routeLayer = null; }
        mapEl.innerHTML = '<div class="map-geocoding"><span class="map-geocoding-dot"></span><span class="map-geocoding-dot"></span><span class="map-geocoding-dot"></span></div>';

        const [oCoords, dCoords] = await Promise.all([
            (!oLat || !oLng) ? geocodeCityState(load.origin?.city, load.origin?.state) : Promise.resolve({ lat: oLat, lng: oLng }),
            (!dLat || !dLng) ? geocodeCityState(load.destination?.city, load.destination?.state) : Promise.resolve({ lat: dLat, lng: dLng }),
        ]);

        mapEl.innerHTML = '';
        if (oCoords) { oLat = oCoords.lat; oLng = oCoords.lng; }
        if (dCoords) { dLat = dCoords.lat; dLng = dCoords.lng; }
    }

    // Если после геокодинга координат нет — скрываем карту
    if (!oLat || !oLng || !dLat || !dLng) {
        mapEl.style.display = 'none';
        return;
    }
    mapEl.style.display = '';

    // Уничтожаем предыдущую карту (если не было геокодинга)
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
            <span>${load.miles ? `${load.miles.toLocaleString()} mi` : ''}</span>
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
    // Счётчики по бордам
    const boards = { dat: 0, truckstop: 0, tp: 0 };
    let total = 0;
    for (const l of state.loads) {
        total++;
        if (l.board === 'dat') boards.dat++;
        else if (l.board === 'truckstop') boards.truckstop++;
        else if (l.board === 'tp' || l.board === 'truckerpath') boards.tp++;
    }

    // Обновить счётчики в board-toggle кнопках
    const datBtn = document.getElementById('board-btn-dat');
    const tsBtn = document.getElementById('board-btn-truckstop');
    const tpBtn = document.getElementById('board-btn-tp');
    if (datBtn) datBtn.querySelector('.board-label').textContent = `DAT ${boards.dat || ''}`;
    if (tsBtn) tsBtn.querySelector('.board-label').textContent = `Truckstop ${boards.truckstop || ''}`;
    if (tpBtn) tpBtn.querySelector('.board-label').textContent = `TruckerPath ${boards.tp || ''}`;

    // Общий счётчик
    const countEl = document.getElementById('status-count');
    if (countEl) countEl.querySelector('span').textContent = `${total} loads`;

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
