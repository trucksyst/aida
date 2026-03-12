/**
 * AIDA v0.1 — TruckerPath Adapter (автономный)
 *
 * Полностью автономный адаптер — чёрный ящик.
 * Сам берёт токен через AuthTruckerpath, сам формирует запрос к TP REST API.
 * Не нужна вкладка TP, не нужен харвестер, не нужен template-capture.
 *
 * Контракт: search(), getStatus(), login(), disconnect(), silentRefresh()
 */
import Storage from '../storage.js';
import AuthTruckerpath from '../auth/auth-truckerpath.js';
import { TP_AUTH_CONFIG } from '../auth/auth-truckerpath.js';

const BOARD = 'tp';
const TP_REFRESH_ALARM = 'aida-tp-refresh';
const TP_REFRESH_INTERVAL_MIN = 1; // 60 сек

// ============================================================
// Equipment mapping: AIDA UI value → TP API key
// TP принимает lowercase строки с пробелами
// ============================================================

const EQUIP_MAP = {
    'VAN': 'van',
    'REEFER': 'reefer',
    'FLATBED': 'flatbed',
    'STEPDECK': 'stepdeck',
    'DOUBLEDROP': 'double drop',
    'LOWBOY': 'lowboy',
    // RGN — нет в TP, пропускаем
    'HOPPER': 'hopper bottom',
    'TANKER': 'tanker',
    'POWERONLY': 'power only',
    'CONTAINER': 'containers',
    'DUMP': 'dump trailer',
    'AUTOCARRIER': 'auto carrier',
    // LANDOLL — нет в TP, пропускаем
    // MAXI — нет в TP, пропускаем
};

/** Маппинг AIDA equipment → TP API keys (массив строк для query). */
function mapEquipment(params) {
    if (!params?.equipment) return [];
    const eqArr = Array.isArray(params.equipment) ? params.equipment : [params.equipment];
    return eqArr
        .map(e => EQUIP_MAP[e?.toUpperCase()])
        .filter(Boolean);
}

// ============================================================
// Helpers
// ============================================================

const RATE_LIMIT_MS = 2000;
let _lastRequestTime = 0;

async function rateLimit() {
    const now = Date.now();
    const elapsed = now - _lastRequestTime;
    if (elapsed < RATE_LIMIT_MS) {
        await new Promise(r => setTimeout(r, RATE_LIMIT_MS - elapsed));
    }
    _lastRequestTime = Date.now();
}

/** Геокодировка city+state → {lat, lng} через Nominatim (бесплатно). */
async function geocodeCity(city, state) {
    if (!city && !state) return null;
    const q = [city, state].filter(Boolean).join(', ') + ', USA';
    try {
        const resp = await fetch(
            `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(q)}&format=json&limit=1`,
            { headers: { 'Accept': 'application/json', 'User-Agent': 'AIDA/1.0' } }
        );
        if (!resp.ok) return null;
        const data = await resp.json();
        const first = Array.isArray(data) && data[0];
        if (!first || first.lat == null) return null;
        return { lat: parseFloat(first.lat), lng: parseFloat(first.lon) };
    } catch {
        return null;
    }
}

function parseMiles(value) {
    if (value == null) return null;
    const s = String(value).replace(/,/g, '');
    const m = s.match(/(\d+(?:\.\d+)?)\s*mi/i) || s.match(/(\d+(?:\.\d+)?)/);
    return m ? Number(m[1]) : null;
}

function parseNumber(value) {
    if (value == null) return null;
    const s = String(value).replace(/[$,\s]/g, '');
    if (!s) return null;
    const n = Number(s);
    return Number.isFinite(n) ? n : null;
}

function parseCityState(value) {
    const s = String(value || '').trim();
    if (!s) return { city: '', state: '', zip: '' };
    const parts = s.split(',').map(v => v.trim()).filter(Boolean);
    if (parts.length >= 2) return { city: parts[0] || '', state: (parts[1] || '').toUpperCase().slice(0, 2), zip: '' };
    return { city: s, state: '', zip: '' };
}

// ============================================================
// Row → Load normalization (unified contract)
// ============================================================

function pickupDateFromRow(row, params) {
    const pick = row.pickup;
    if (pick && pick.date_local && typeof pick.date_local === 'string') {
        const s = String(pick.date_local).trim().slice(0, 10);
        if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
    }
    const allInOne = row.all_in_one_date;
    if (allInOne && allInOne.pickup_day && typeof allInOne.pickup_day === 'string') {
        const dayStr = String(allInOne.pickup_day).trim();
        const m = dayStr.match(/^(\d{1,2})\/(\d{1,2})$/);
        if (m) {
            const year = new Date().getFullYear();
            return `${year}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`;
        }
    }
    const created = row.created_at;
    if (typeof created === 'number' && created > 1e12) return new Date(created).toISOString().slice(0, 10);
    if (typeof created === 'number' && created > 1e9) return new Date(created * 1000).toISOString().slice(0, 10);
    const dateRaw = row.created_at || row.date || row.pickupDate || params?.dateFrom || '';
    const s = String(dateRaw).trim().slice(0, 10);
    return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : s || '';
}

function mapRowToLoad(row, idx, params) {
    if (!row || typeof row !== 'object') return null;

    // === Origin / Destination ===
    const pickAddr = row.pickup?.address || {};
    const dropAddr = row.drop_off?.address || {};
    const pickupLoc = row.pickup?.location || {};
    const dropLoc = row.drop_off?.location || {};

    const origin = {
        city: pickAddr.city || '',
        state: (pickAddr.state || '').toUpperCase().slice(0, 2),
        lat: pickupLoc.lat ?? null,
        lng: pickupLoc.lng ?? null,
    };
    const destination = {
        city: dropAddr.city || '',
        state: (dropAddr.state || '').toUpperCase().slice(0, 2),
        lat: dropLoc.lat ?? null,
        lng: dropLoc.lng ?? null,
    };

    // Fallback: trip_details
    if (!origin.city && Array.isArray(row.trip_details)) {
        const pickLeg = row.trip_details.find(t => t?.type === 'P') || row.trip_details[0];
        if (pickLeg) {
            origin.city = pickLeg.city || origin.city;
            origin.state = (pickLeg.state || origin.state).toUpperCase().slice(0, 2);
        }
    }
    if (!destination.city && Array.isArray(row.trip_details)) {
        const dropLeg = row.trip_details.find(t => t?.type === 'D') || row.trip_details[row.trip_details.length - 1];
        if (dropLeg) {
            destination.city = dropLeg.city || destination.city;
            destination.state = (dropLeg.state || destination.state).toUpperCase().slice(0, 2);
        }
    }

    // === Груз ===
    const miles = typeof row.distance_total === 'number' ? row.distance_total
        : (typeof row.distance === 'number' && Number.isFinite(row.distance) ? row.distance : parseMiles(row.miles));
    const weight = typeof row.weight === 'number' && Number.isFinite(row.weight) ? row.weight : parseNumber(row.totalWeight);
    const rate = parseNumber(row.price_total || row.price || row.rate);
    const rpm = miles && rate ? Math.round((rate / miles) * 100) / 100 : null;
    const equipRaw = row.equipment;
    const equipmentAll = Array.isArray(equipRaw) ? equipRaw.map(e => typeof e === 'string' ? e.toUpperCase() : '').filter(Boolean) : [];
    const equipment = equipmentAll[0] || (params?.equipment?.[0]) || 'VAN';
    const deadhead = row.pickup && typeof row.pickup.deadhead === 'number' ? row.pickup.deadhead : null;

    // === Broker ===
    const brokerObj = row.broker && typeof row.broker === 'object' ? row.broker : {};
    const brokerCompany = brokerObj.company || brokerObj.contact_name || '';
    const phoneVal = brokerObj.phone;
    const brokerPhone = (phoneVal && typeof phoneVal === 'object' && phoneVal.number) ? String(phoneVal.number) : (typeof phoneVal === 'string' ? phoneVal : '');
    const brokerPhoneExt = (phoneVal && typeof phoneVal === 'object') ? (phoneVal.ext || '') : '';
    const tcRating = brokerObj.transcredit_rating || {};

    // === Notes: W×H + description ===
    const descParts = [];
    if (row.width && row.width > 0) descParts.push(row.width + 'W');
    if (row.height && row.height > 0) descParts.push(row.height + 'H');
    const descText = (typeof row.description === 'string' && row.description.trim()) || (typeof row.comments === 'string' && row.comments.trim()) || '';
    if (descText) descParts.push(descText);
    const notes = descParts.join(' x ').replace(' x ', ' | ') || '';

    // === Даты ===
    const pickupDate = pickupDateFromRow(row, params || {});
    const postedAt = typeof row.created_at === 'number' ? new Date(row.created_at > 1e12 ? row.created_at : row.created_at * 1000).toISOString() : '';

    // === ID ===
    // ID — оригинальный с сервера TP
    const loadId = row.shipment_id || row._id || row.external_id || '';

    return {
        id: `tp_${loadId || Math.random().toString(36).slice(2, 10)}`,
        board: BOARD,
        externalId: String(row.external_id || row.shipment_id || ''),
        origin,
        destination,
        equipment: String(equipment || 'VAN').trim().toUpperCase(),
        equipmentName: '',
        equipmentAll,
        weight,
        length: typeof row.length === 'number' && row.length > 0 ? row.length : null,
        fullPartial: (row.load_size || '').toUpperCase(),
        miles,
        deadhead,
        rate,
        rpm,
        broker: {
            company: brokerCompany,
            phone: brokerPhone,
            phoneExt: brokerPhoneExt,
            email: brokerObj.email || '',
            mc: brokerObj.mc ? String(brokerObj.mc) : '',
            dot: brokerObj.dot ? String(brokerObj.dot) : '',
            address: '',
            rating: tcRating.score ?? null,
            daysToPay: tcRating.days_to_pay ?? null,
        },
        notes,
        pickupDate,
        postedAt,
        status: row.expired ? 'expired' : 'active',
        bookNow: !!(row.book_now),
        factorable: false,
        raw: row
    };
}

function normalizeTruckerpathResults(raw, params) {
    const items = raw?.items || raw?.data?.items || (Array.isArray(raw) ? raw : []);
    if (!items.length) return [];
    return items.map((row, i) => mapRowToLoad(row, i, params)).filter(Boolean);
}

// ============================================================
// Adapter
// ============================================================

/** Получить installationId из Storage */
async function getInstallationId() {
    const data = await chrome.storage.local.get('auth:truckerpath:installationId');
    let id = data['auth:truckerpath:installationId'];
    if (!id) {
        id = 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
            const r = Math.random() * 16 | 0;
            return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
        });
        await chrome.storage.local.set({ 'auth:truckerpath:installationId': id });
    }
    return id;
}

const TruckerpathAdapter = {
    _lastParams: null,
    _onRealtimeUpdate: null,

    /**
     * Поиск грузов по параметрам.
     * Прямой запрос к POST /tl/search/filter/web/v2
     */
    async search(params) {
        const token = await AuthTruckerpath.getToken();
        if (!token) {
            return {
                ok: false, loads: [], meta: { board: BOARD },
                error: { code: 'AUTH_REQUIRED', message: 'TruckerPath not connected — login required', retriable: true }
            };
        }

        this._lastParams = params;

        await rateLimit();

        // Геокодируем origin
        let originGeo = null;
        if (params.origin && (params.origin.city || params.origin.state)) {
            originGeo = await geocodeCity(params.origin.city, params.origin.state);
            if (!originGeo) {
                console.warn('[AIDA/TruckerPath] Failed to geocode origin:', params.origin.city, params.origin.state);
                return {
                    ok: false, loads: [], meta: { board: BOARD },
                    error: { code: 'GEOCODE_FAILED', message: 'Could not geocode origin city', retriable: false }
                };
            }
        }

        // Формируем body запроса (формат из HAR)
        const installationId = await getInstallationId();
        const body = this._buildSearchBody(params, originGeo);
        const headers = {
            'x-auth-token': token,
            'client': TP_AUTH_CONFIG.clientHeader,
            'Installation-ID': installationId,
            'Content-Type': 'application/json',
            'Origin': TP_AUTH_CONFIG.loadboardUrl,
            'Referer': TP_AUTH_CONFIG.loadboardUrl + '/'
        };

        try {
            const resp = await fetch(`${TP_AUTH_CONFIG.apiBase}/tl/search/filter/web/v2`, {
                method: 'POST',
                headers,
                body: JSON.stringify(body)
            });

            const text = await resp.text();

            if (!resp.ok) {
                console.warn('[AIDA/TruckerPath] Step: HTTP', resp.status, text?.slice(0, 200));
                return {
                    ok: false, loads: [], meta: { board: BOARD },
                    error: { code: 'FETCH_FAILED', message: `HTTP ${resp.status}: ${text?.slice(0, 100)}`, retriable: resp.status >= 500 }
                };
            }

            if (!text || text.trim().charAt(0) === '<') {
                return {
                    ok: false, loads: [], meta: { board: BOARD },
                    error: { code: 'HTML_RESPONSE', message: 'TruckerPath returned HTML (auth issue?)', retriable: false }
                };
            }

            const data = JSON.parse(text);

            // TP API wraps results in { items: [...], meta: {...} }
            const items = data.items || [];
            if (items.length === 0) {
                return { ok: true, loads: [], meta: { board: BOARD, source: 'api' } };
            }

            console.log(`[AIDA/TruckerPath] search: API returned ${items.length} loads`);
            const loads = normalizeTruckerpathResults(data, params);

            // Стартуем polling для auto-refresh
            this._startPolling();

            return { ok: true, loads, meta: { board: BOARD, source: 'api' } };

        } catch (e) {
            console.warn('[AIDA/TruckerPath] search error:', e?.message);
            return {
                ok: false, loads: [], meta: { board: BOARD },
                error: { code: 'NETWORK_ERROR', message: e?.message || 'Network error', retriable: true }
            };
        }
    },

    /**
     * Формирование body запроса к /tl/search/filter/web/v2
     * Формат: { sort, offset, options, limit, paging_enable, other, query }
     */
    _buildSearchBody(params, originGeo) {
        const now = new Date();
        const dateFrom = params.dateFrom || now.toISOString().slice(0, 10);
        const dateTo = params.dateTo || (() => {
            const d = new Date(now);
            d.setDate(d.getDate() + 30);
            return d.toISOString().slice(0, 10);
        })();

        const body = {
            sort: [{ smart_sort: 'desc' }],
            offset: 0,
            options: {
                repeat_search: false,
                mark_new_since: now.toISOString(),
                road_miles: true,
                include_auth_required: false
            },
            limit: 100,
            paging_enable: true,
            other: {
                source: 'list',
                pickup_type: 'home location',
                dropoff_type: params.destination?.city ? 'location' : 'anywhere',
                chr_switch: false
            },
            query: {
                weight: { allow_null: true },
                length: { allow_null: true },
                pickup: {
                    geo: {
                        location: {
                            address: originGeo
                                ? `${params.origin.city || ''},${params.origin.state || ''},US`
                                : '',
                            lat: originGeo?.lat || 0,
                            lng: originGeo?.lng || 0
                        },
                        deadhead: {
                            max: Number(params.radius) || 200
                        }
                    },
                    date_local: {
                        from: `${dateFrom}T00:00:00`,
                        to: `${dateTo}T23:59:59`
                    }
                }
            }
        };

        // Destination (если указан)
        if (params.destination?.city) {
            // Destination геокодинг будет добавлен позже если нужен
            body.query.drop_off = {
                geo: {
                    deadhead: { max: Number(params.radius) || 200 }
                }
            };
        }

        // Equipment
        const tpEquipment = mapEquipment(params);
        if (tpEquipment.length > 0) {
            body.query.equipment = tpEquipment;
        }

        return body;
    },

    // ============================================================
    // Realtime
    // ============================================================

    setRealtimeCallback(fn) {
        this._onRealtimeUpdate = fn;
    },

    _startPolling() {
        chrome.alarms.clear(TP_REFRESH_ALARM).catch(() => { });
        chrome.alarms.create(TP_REFRESH_ALARM, { periodInMinutes: TP_REFRESH_INTERVAL_MIN });
    },

    _stopPolling() {
        this._lastParams = null;
        chrome.alarms.clear(TP_REFRESH_ALARM).catch(() => { });
    },

    stopRealtime() {
        this._stopPolling();
    },

    /**
     * Обработчик alarm — повторный поиск с последними params.
     * Новые грузы → callback → Core мержит.
     */
    async handleAlarm() {
        if (!this._lastParams) return;

        let result = await this.search(this._lastParams);

        if (!result?.ok && result?.error?.code === 'AUTH_REQUIRED') {
            const refreshResult = await AuthTruckerpath.silentRefresh();
            if (refreshResult.ok) {
                result = await this.search(this._lastParams);
            }
        }

        if (!result?.ok || !Array.isArray(result.loads) || result.loads.length === 0) return;

        if (this._onRealtimeUpdate) {
            this._onRealtimeUpdate(BOARD, result.loads);
        }
    },

    // ============================================================
    // Status / Login / Disconnect — через AuthTruckerpath
    // ============================================================

    async getStatus() {
        const status = await AuthTruckerpath.getStatus();
        return {
            connected: status === 'connected',
            status,
            hasToken: status !== 'disconnected',
            hasAuthModule: true
        };
    },

    async login() {
        return AuthTruckerpath.login();
    },

    async silentRefresh() {
        return AuthTruckerpath.silentRefresh();
    },

    async disconnect() {
        this.stopRealtime();
        return AuthTruckerpath.disconnect();
    },

    async getToken() {
        return AuthTruckerpath.getToken();
    }
};

export default TruckerpathAdapter;
export { normalizeTruckerpathResults };
