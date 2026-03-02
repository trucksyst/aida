/**
 * AIDA v0.1 — TruckerPath Adapter
 * Работает только через данные, перехваченные harvester-ом на вкладке TruckerPath.
 * Запросов к API TruckerPath из background не делаем: сервер отдаёт HTML (логин/редирект), не JSON.
 *
 * Поля сырой карточки: в консоли лог "[AIDA/Core] TruckerPath raw load card" — развернуть объект и подставить ключи (RAW_FIELD_*).
 */
const BOARD = 'tp';

/** Ключ описания груза (COMMENTS) в сырой карточке — взять из консоли, не угадывать. */
const RAW_FIELD_COMMENTS = 'comments';
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

/** Строка похожа на плейсхолдер/ключ API (axde_mcleod_origin и т.п.) — не показываем в UI. */
function looksLikePlaceholder(s) {
    if (!s || typeof s !== 'string') return true;
    const t = s.trim();
    if (!t) return true;
    if (/^[a-z][a-z0-9_]*$/i.test(t) && t.indexOf('_') !== -1 && t.length > 6) return true;
    return false;
}

function parseCityState(value) {
    const s = String(value || '').trim();
    if (!s || looksLikePlaceholder(s)) return { city: '', state: '', zip: '' };
    const parts = s.split(',').map(v => v.trim()).filter(Boolean);
    if (parts.length >= 2) return { city: parts[0] || '', state: (parts[1] || '').toUpperCase().slice(0, 2), zip: '' };
    return { city: s, state: '', zip: '' };
}

/** Достать строку локации из объекта: city+state, или вложенные origin/pickup/dropoff. */
function getLocationString(row, pickKeys, dropKeys) {
    const pick = pickKeys || ['pickupLocation', 'origin', 'pickup', 'originCityState', 'origin_city'];
    const drop = dropKeys || ['dropoffLocation', 'destination', 'dropoff', 'destinationCityState', 'destination_city'];
    for (const key of pick) {
        const v = row[key];
        if (v != null && typeof v === 'object') {
            const city = v.city || v.name || v.originCity || v.destinationCity || v.destCity || '';
            const state = (v.state || v.originState || v.destinationState || v.destState || '').toString().toUpperCase().slice(0, 2);
            const str = [city, state].filter(Boolean).join(', ');
            if (str && !looksLikePlaceholder(str)) return str;
        }
        if (typeof v === 'string' && v.trim() && !looksLikePlaceholder(v)) return v.trim();
    }
    const fallback = row.pickupLocation || row.origin || row.originCityState ||
        (row.originCity && row.originState ? [row.originCity, row.originState].join(', ') : '');
    if (fallback && !looksLikePlaceholder(String(fallback))) return String(fallback).trim();
    return '';
}

/** Origin: pickup_locations[0] | pickup.address | trip_details (type P) | остальное */
function getOriginString(row) {
    const pick = row.pickup_locations;
    if (Array.isArray(pick) && pick.length > 0 && pick[0] && typeof pick[0] === 'object') {
        const c = pick[0];
        const city = c.city || c.name || '';
        const state = (c.state || '').toString().toUpperCase().slice(0, 2);
        const str = [city, state].filter(Boolean).join(', ');
        if (str) return str;
    }
    const addr = row.pickup && row.pickup.address && typeof row.pickup.address === 'object';
    if (addr) {
        const a = row.pickup.address;
        const city = a.city || a.name || '';
        const state = (a.state || '').toString().toUpperCase().slice(0, 2);
        const str = [city, state].filter(Boolean).join(', ');
        if (str) return str;
    }
    const trip = row.trip_details;
    if (Array.isArray(trip) && trip.length > 0) {
        const pickLeg = trip.find(t => t && (t.type === 'P' || t.type === 'pickup'));
        if (pickLeg && (pickLeg.city || pickLeg.state)) {
            const str = [pickLeg.city, pickLeg.state].filter(Boolean).join(', ');
            if (str) return str;
        }
        if (trip[0] && (trip[0].city || trip[0].state)) {
            const str = [trip[0].city, trip[0].state].filter(Boolean).join(', ');
            if (str) return str;
        }
    }
    return getLocationString(row, ['pickupLocation', 'origin', 'pickup', 'originCityState', 'origin_city'], null);
}

/** Destination: drop_offs_locations[0] | drop_off.address | trip_details (type D) | остальное */
function getDestinationString(row) {
    const drop = row.drop_offs_locations;
    if (Array.isArray(drop) && drop.length > 0 && drop[0] && typeof drop[0] === 'object') {
        const c = drop[0];
        const city = c.city || c.name || '';
        const state = (c.state || '').toString().toUpperCase().slice(0, 2);
        const str = [city, state].filter(Boolean).join(', ');
        if (str) return str;
    }
    const addr = row.drop_off && row.drop_off.address && typeof row.drop_off.address === 'object';
    if (addr) {
        const a = row.drop_off.address;
        const city = a.city || a.name || '';
        const state = (a.state || '').toString().toUpperCase().slice(0, 2);
        const str = [city, state].filter(Boolean).join(', ');
        if (str) return str;
    }
    const trip = row.trip_details;
    if (Array.isArray(trip) && trip.length > 1) {
        const dropLeg = trip.find(t => t && (t.type === 'D' || t.type === 'drop'));
        if (dropLeg && (dropLeg.city || dropLeg.state)) {
            const str = [dropLeg.city, dropLeg.state].filter(Boolean).join(', ');
            if (str) return str;
        }
        if (trip[trip.length - 1] && (trip[trip.length - 1].city || trip[trip.length - 1].state)) {
            const last = trip[trip.length - 1];
            const str = [last.city, last.state].filter(Boolean).join(', ');
            if (str) return str;
        }
    }
    const dropKeys = ['dropoffLocation', 'destination', 'dropoff', 'destinationCityState', 'destination_city'];
    return getLocationString(row, dropKeys, null);
}

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
    const dateRaw = row.created_at || row.date || row.pickupDate || row.pickup_at || row.availableDate || row.posted_at || params?.dateFrom || '';
    const s = String(dateRaw).trim().slice(0, 10);
    return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : s || '';
}

function mapRowToLoad(row, idx, params) {
    if (!row || typeof row !== 'object') return null;
    const age = row.age ?? row.postedAgo ?? '';
    const originStr = getOriginString(row) || (typeof row.pickupLocation === 'string' && !looksLikePlaceholder(row.pickupLocation) ? row.pickupLocation : '') || (typeof row.origin === 'string' && !looksLikePlaceholder(row.origin) ? row.origin : '');
    const destinationStr = getDestinationString(row) || (typeof row.dropoffLocation === 'string' && !looksLikePlaceholder(row.dropoffLocation) ? row.dropoffLocation : '') || (typeof row.destination === 'string' && !looksLikePlaceholder(row.destination) ? row.destination : '');
    const miles = typeof row.distance === 'number' && Number.isFinite(row.distance) ? row.distance : (typeof row.distance_total === 'number' ? row.distance_total : parseMiles(row.miles || row.tripDistance));
    const weight = typeof row.weight === 'number' && Number.isFinite(row.weight) ? row.weight : parseNumber(row.totalWeight);
    const rate = parseNumber(row.price_total || row.price || row.avg_price || row.load_price || row.rate || row.postedRate);
    const rpm = miles && rate ? Math.round((rate / miles) * 100) / 100 : null;
    const equipRaw = row.equipment;
    const equipmentStr = Array.isArray(equipRaw) && equipRaw.length > 0
        ? (typeof equipRaw[0] === 'string' ? equipRaw[0] : (equipRaw[0] && equipRaw[0].name) || '')
        : (row.trailer || row.equipmentType || params?.equipment || 'VAN');
    const equipment = String(equipmentStr || 'VAN').trim().toUpperCase() || 'VAN';
    const origin = parseCityState(originStr);
    const destination = parseCityState(destinationStr);
    const pickupDate = pickupDateFromRow(row, params || {});
    const nowIso = new Date().toISOString();
    const idSeed = (row._id || row.load_id || row.load_card_id || row.shipment_id || '') + [origin.city, origin.state, destination.city, destination.state, pickupDate, idx].join('|');
    const brokerObj = row.broker && typeof row.broker === 'object' ? row.broker : {};
    const brokerName = brokerObj.company || brokerObj.contact_name || brokerObj.contact_person || brokerObj.name || '';
    const phoneVal = brokerObj.phone;
    const brokerPhone = (phoneVal && typeof phoneVal === 'object' && phoneVal.number) ? String(phoneVal.number) : (typeof phoneVal === 'string' ? phoneVal : brokerObj.contact_phone || '');
    const comments = typeof row[RAW_FIELD_COMMENTS] === 'string' ? row[RAW_FIELD_COMMENTS].trim() : '';

    return {
        id: `tp_${btoa(unescape(encodeURIComponent(idSeed))).replace(/[+/=]/g, '').slice(0, 16)}`,
        board: BOARD,
        origin,
        destination,
        equipment,
        equipmentCode: equipment,
        weight,
        miles,
        rate,
        rpm,
        broker: { name: brokerName, phone: brokerPhone, email: brokerObj.email || '' },
        comments: comments || '',
        pickupDate,
        postedAt: (row.pickup && row.pickup.date_local) ? String(row.pickup.date_local).slice(0, 19) : (typeof row.created_at === 'number' ? new Date(row.created_at > 1e12 ? row.created_at : row.created_at * 1000).toISOString() : nowIso),
        status: 'active',
        statusUpdatedAt: nowIso,
        receivedAt: nowIso,
        raw: row
    };
}

function toCandidateRows(raw) {
    if (!raw) return [];
    if (Array.isArray(raw)) return raw;
    if (Array.isArray(raw.loads)) return raw.loads;
    if (Array.isArray(raw.results)) return raw.results;
    if (raw.data && Array.isArray(raw.data.loads)) return raw.data.loads;
    if (raw.data && Array.isArray(raw.data.results)) return raw.data.results;
    return [];
}

function normalizeTruckerpathResults(raw, params) {
    const rows = toCandidateRows(raw);
    if (!rows.length) return [];
    return rows.map((row, i) => mapRowToLoad(row, i, params)).filter(Boolean);
}

const TruckerpathAdapter = {
    async search(params, ctx = {}) {
        const cachedLoads = Array.isArray(ctx.cachedLoads) ? ctx.cachedLoads : [];
        const template = ctx.template || null;
        console.log('[AIDA/TruckerPath] search() called', {
            hasTemplate: !!(template && template.url),
            cachedLoadsCount: cachedLoads.length,
            origin: params?.origin,
            destination: params?.destination
        });
        if (cachedLoads.length > 0) {
            console.log('[AIDA/TruckerPath] Using cached loads from harvester:', cachedLoads.length);
            return { ok: true, loads: cachedLoads, meta: { board: BOARD, source: 'cache' } };
        }
        if (!template || !template.url) {
            console.warn('[AIDA/TruckerPath] No template: run search on TruckerPath tab once to capture request');
            return {
                ok: false, loads: [], meta: { board: BOARD, source: 'template' },
                error: { code: 'NO_TEMPLATE', message: 'TruckerPath request template not captured; run search on TruckerPath tab once', retriable: false }
            };
        }
        await rateLimit();
        console.log('[AIDA/TruckerPath] Template present, no cached loads — results come when user searches on TruckerPath tab');
        return {
            ok: false, loads: [], meta: { board: BOARD, source: 'template' },
            error: { code: 'NEED_PAGE_CONTEXT', message: 'TruckerPath template flow requires page context results', retriable: false }
        };
    }
};

export default TruckerpathAdapter;
export { normalizeTruckerpathResults };
