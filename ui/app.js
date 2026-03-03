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
    sortColumn: 'rate',
    sortAsc: false,
    agentEnabled: false,
    boardStatus: { dat: false, truckstop: false },
    lastRefreshTime: null
};

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
    console.log('[AIDA/UI] Step: init start');
    const resp = await sendToCore('GET_SETTINGS');
    console.log('[AIDA/UI] Step: GET_SETTINGS', resp?.settings ? 'ok' : 'empty');
    if (resp?.settings) {
        state.settings = resp.settings;
        applySettings(resp.settings);
    }

    const loadsResp = await sendToCore('GET_LOADS');
    const loadCount = Array.isArray(loadsResp?.loads) ? loadsResp.loads.length : 0;
    console.log('[AIDA/UI] Step: GET_LOADS →', loadCount, 'loads');
    state.loads = Array.isArray(loadsResp?.loads) ? loadsResp.loads : [];

    // Даты по умолчанию, если нет сохранённого поиска
    const today = new Date().toISOString().split('T')[0];
    const in3days = new Date(Date.now() + 3 * 86400000).toISOString().split('T')[0];
    document.getElementById('date-from').value = today;
    document.getElementById('date-to').value = in3days;

    // Подставить последний поиск (память формы) — Core сохраняет lastSearch при каждом Search
    if (resp?.settings?.lastSearch) {
        applyLastSearch(resp.settings.lastSearch);
        console.log('[AIDA/UI] Step: applied last search (origin, destination, dates, etc.)');
    }

    // Статус бордов и тема уже в resp.settings (boardStatus, theme) — применены в applySettings
    renderTable();
    updateStatusBar();

    bindEvents();

    // Единственная подписка на обновления — push от Core (контракт API)
    chrome.runtime.onMessage.addListener(onDataUpdated);
    console.log('[AIDA/UI] Step: init done. Listening for DATA_UPDATED from Core.');
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

/** Заполнить форму поиска из сохранённого lastSearch (память по умолчанию). */
function applyLastSearch(lastSearch) {
    if (!lastSearch || typeof lastSearch !== 'object') return;
    var o = lastSearch.origin || {};
    var d = lastSearch.destination || {};
    setVal('origin-city', o.city || '');
    setVal('origin-state', (o.state || '').toUpperCase().slice(0, 2));
    setVal('dest-city', d.city || '');
    setVal('dest-state', (d.state || '').toUpperCase().slice(0, 2));
    setVal('search-radius', lastSearch.radius != null ? lastSearch.radius : 50);
    if (lastSearch.equipment) {
        var eqEl = document.getElementById('equipment');
        if (eqEl && ['VAN', 'REEFER', 'FLATBED'].indexOf(lastSearch.equipment) !== -1) eqEl.value = lastSearch.equipment;
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

function attachLocationAutocomplete(cityId, stateId, dropdownId) {
    var cityEl = document.getElementById(cityId);
    var stateEl = document.getElementById(stateId);
    var listEl = document.getElementById(dropdownId);
    if (!cityEl || !stateEl || !listEl || typeof window.AIDALocations === 'undefined') return;

    var debounceTimer = null;
    var DEBOUNCE_MS = 150;

    function hide() {
        listEl.innerHTML = '';
        listEl.classList.remove('open');
        listEl.setAttribute('aria-hidden', 'true');
    }

    function show(items, isLoading) {
        function escapeAttr(s) {
            return String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/'/g, '&#39;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        }
        if (isLoading) {
            listEl.innerHTML = '<div class="location-autocomplete-item location-autocomplete-loading">Searching online…</div>';
            listEl.classList.add('open');
            listEl.setAttribute('aria-hidden', 'false');
            return;
        }
        if (!items.length) { hide(); return; }
        listEl.innerHTML = items.map(function (item) {
            var label = item.label || (item.type === 'zone' ? item.value + ' (zone)' : item.value);
            return '<div class="location-autocomplete-item" data-value="' + escapeAttr(item.value) + '" data-type="' + item.type + '" role="option">' + escapeHtml(label) + '</div>';
        }).join('');
        listEl.classList.add('open');
        listEl.setAttribute('aria-hidden', 'false');
        listEl.querySelectorAll('.location-autocomplete-item').forEach(function (node) {
            node.addEventListener('click', function () {
                var val = node.getAttribute('data-value');
                var typ = node.getAttribute('data-type');
                if (typ === 'zone') {
                    cityEl.value = val;
                    stateEl.value = '';
                } else {
                    var parts = val.split(/\s*,\s*/);
                    cityEl.value = (parts[0] || '').trim();
                    stateEl.value = (parts[1] || '').trim().toUpperCase().slice(0, 2);
                }
                hide();
                cityEl.focus();
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
// Events
// ============================================================

function bindEvents() {
    attachLocationAutocomplete('origin-city', 'origin-state', 'origin-autocomplete');
    attachLocationAutocomplete('dest-city', 'dest-state', 'dest-autocomplete');

    // Sidebar navigation
    document.querySelectorAll('.sidebar-icon[data-section]').forEach(btn => {
        btn.addEventListener('click', () => switchSection(btn.dataset.section));
    });

    // Theme toggle
    document.getElementById('btn-theme').addEventListener('click', toggleTheme);

    // Search button
    document.getElementById('btn-search').addEventListener('click', doSearch);

    // State input — Enter
    ['origin-city', 'origin-state', 'dest-city', 'dest-state', 'search-radius',
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

    // Board toggle buttons
    document.querySelectorAll('.board-toggle[data-board]').forEach(btn => {
        btn.addEventListener('click', () => {
            const board = btn.dataset.board;
            const bs = state.boardStatus[board] || {};
            const currentlyDisabled = !!bs.disabled;
            toggleBoard(board, currentlyDisabled); // toggle: если disabled → enable, и наоборот
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
                    showToast('No board connected. Open one.dat.com in another tab, sign in and search there, then try here again.', 'error');
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
    return {
        origin: {
            city: document.getElementById('origin-city').value.trim(),
            state: document.getElementById('origin-state').value.trim().toUpperCase(),
            zip: ''
        },
        destination: {
            city: document.getElementById('dest-city').value.trim(),
            state: document.getElementById('dest-state').value.trim().toUpperCase(),
            zip: ''
        },
        radius: parseInt(document.getElementById('search-radius').value) || 50,
        equipment: document.getElementById('equipment').value,
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
        return 'Connect a board first: Open one.dat.com in another tab, sign in, and run a search there. AIDA will capture the connection. Then return here and click Search.';
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
            case 'status': va = a.status || ''; vb = b.status || ''; break;
            default: va = 0; vb = 0;
        }

        if (typeof va === 'string') {
            return asc ? va.localeCompare(vb) : vb.localeCompare(va);
        }
        return asc ? va - vb : vb - va;
    });
}

function renderRow(load) {
    const rate = load.rate ? `$${load.rate.toLocaleString()}` : '—';
    const rpm = load.rpm ? `$${load.rpm}` : '—';
    const origin = `${load.origin?.city || ''}, ${load.origin?.state || ''}`;
    const dest = `${load.destination?.city || ''}, ${load.destination?.state || ''}`;
    const miles = load.miles ? `${load.miles.toLocaleString()}` : '—';
    const weight = load.weight ? `${(load.weight / 1000).toFixed(0)}k lbs` : '—';
    const broker = esc(load.broker?.company || '—');
    const dateStr = load.pickupDate ? load.pickupDate.slice(5) : '—'; // MM-DD
    const status = renderStatusBadge(load.status);
    const board = `<span class="board-badge ${esc(load.board || '')}">${(load.board || '').toUpperCase()}</span>`;

    return `
    <tr data-id="${esc(load.id)}" class="status-${load.status || 'active'}">
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
        <td>${dateStr}</td>
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

    const body = document.getElementById('detail-body');
    body.innerHTML = renderDetailContent(load);

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
        load.status === 'saved' ? '🔖 Saved' : '🔖 Save';

    document.getElementById('detail-panel').classList.add('open');
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
    <div class="map-placeholder">🗺 ${esc(origin)} → ${esc(dest)}</div>

    <div class="detail-section">
        <h3>Route</h3>
        <div class="detail-route">${esc(origin)} → ${esc(dest)}</div>
        <div style="margin-top:4px">
            <span class="detail-rate-big">${rate}</span>
            <span class="detail-rate-rpm">${rpm}</span>
        </div>
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
        ${detailRow('Notes', (load.notes && load.notes.trim()) ? esc(load.notes.trim()) : '—')}
    </div>

    <div class="detail-section">
        <h3>Broker</h3>
        ${detailRow('Company', load.broker?.company || '—')}
        ${detailRow('Phone', load.broker?.phone
        ? `<a href="tel:${load.broker.phone}" style="color:var(--accent)">${load.broker.phone}${load.broker.phoneExt ? ' x' + load.broker.phoneExt : ''}</a>`
        : '—')}
        ${detailRow('Email', load.broker?.email
            ? `<a href="mailto:${load.broker.email}" style="color:var(--accent)">${load.broker.email}</a>`
            : '—')}
        ${load.broker?.mc ? detailRow('MC#', load.broker.mc) : ''}
        ${load.broker?.dot ? detailRow('DOT#', load.broker.dot) : ''}
        ${load.broker?.rating != null
            ? detailRow('Credit', `${load.broker.rating}${load.broker.daysToPay ? ' / ' + load.broker.daysToPay + ' days' : ''}`)
            : ''}
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
// Actions
// ============================================================

async function doCall(loadId) {
    document.getElementById('detail-btn-call').disabled = true;
    document.getElementById('detail-btn-call').textContent = '📞 Calling...';

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
    document.getElementById('detail-btn-call').textContent = '📞 Call';
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
        document.getElementById('detail-btn-save').textContent = '🔖 Saved';

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
        body.innerHTML = '<div class="table-empty"><div class="icon">🔖</div><div class="msg">No bookmarks</div></div>';
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
        body.innerHTML = '<div class="table-empty"><div class="icon">📞</div><div class="msg">History empty</div></div>';
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

/** Обновить кнопки-индикаторы бордов по state.boardStatus. */
function updateBoardDots() {
    const boards = ['dat', 'truckstop', 'tp'];
    for (const board of boards) {
        const btn = document.getElementById(`board-btn-${board}`);
        if (!btn) continue;
        const bs = state.boardStatus[board];
        // boardStatus может быть старый формат (boolean) или новый ({connected, hasToken, tabOpen, disabled})
        const isOldFormat = typeof bs === 'boolean' || bs === undefined;
        const connected = isOldFormat ? !!bs : !!bs?.connected;
        const hasToken = isOldFormat ? !!bs : !!bs?.hasToken;
        const disabled = isOldFormat ? false : !!bs?.disabled;

        btn.classList.remove('connected', 'has-token', 'disabled');
        if (disabled) {
            btn.classList.add('disabled');
            btn.title = `${board.toUpperCase()} — отключён (клик для включения)`;
        } else if (connected) {
            btn.classList.add('connected');
            btn.title = `${board.toUpperCase()} — подключён (клик для отключения)`;
        } else if (hasToken) {
            btn.classList.add('has-token');
            btn.title = `${board.toUpperCase()} — токен есть, вкладка закрыта (клик для отключения)`;
        } else {
            btn.title = `${board.toUpperCase()} — не подключён (откройте вкладку борда)`;
        }
    }
}

async function toggleBoard(board, enable) {
    await sendToCore('TOGGLE_BOARD', { board, enabled: enable });
    // Состояние обновится через DATA_UPDATED push
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
