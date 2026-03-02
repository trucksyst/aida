/**
 * AIDA v0.1 — Truckstop Adapter
 * Нормализация перехваченных с страницы Truckstop данных в единый формат AIDA.
 * Поиск: через сохранённый шаблон (TS_SEARCH_REQUEST_CAPTURED) + fetch из background.
 *
 * Поля сырой карточки: открыть в консоли лог "[AIDA/Core] Truckstop raw load card",
 * развернуть объект и подставить нужные имена ключей ниже (RAW_FIELD_*).
 */
const BOARD = 'truckstop';

/** Ключ описания груза (COMMENTS) в сырой карточке — взять из консоли, не угадывать. */
const RAW_FIELD_COMMENTS = 'comments';

/** Геокодировка origin (city, state) → lat, lon через Nominatim. */
async function geocodeOrigin(origin) {
    if (!origin || (!origin.city && !origin.state)) return null;
    const q = [origin.city, origin.state].filter(Boolean).join(', ') + ', USA';
    const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(q)}&format=json&limit=1`;
    console.log('[AIDA/Truckstop] Step: geocodeOrigin', q);
    try {
        const resp = await fetch(url, {
            headers: { 'Accept': 'application/json', 'User-Agent': 'AIDA/1.0 (Chrome Extension)' }
        });
        if (!resp.ok) {
            console.warn('[AIDA/Truckstop] Step: geocodeOrigin failed', resp.status);
            return null;
        }
        const data = await resp.json();
        const first = Array.isArray(data) && data[0];
        if (!first || first.lat == null || first.lon == null) {
            console.warn('[AIDA/Truckstop] Step: geocodeOrigin — no result for', q);
            return null;
        }
        const coords = { lat: parseFloat(first.lat), lon: parseFloat(first.lon) };
        console.log('[AIDA/Truckstop] Step: geocodeOrigin ok', coords);
        return coords;
    } catch (e) {
        console.warn('[AIDA/Truckstop] Step: geocodeOrigin error:', e?.message);
        return null;
    }
}

/** Ищем массив грузов в GraphQL-ответе Truckstop. Поддерживает data.loadSearch.items и data.*. */
function findLoadsArray(obj, logKey) {
    if (!obj || typeof obj !== 'object') return null;
    const d = obj.data || obj.Data;
    if (d && typeof d === 'object') {
        // loadSearch.items (новый API)
        const loadSearch = d.loadSearch || d.LoadSearch;
        if (loadSearch && loadSearch.items && Array.isArray(loadSearch.items)) {
            if (logKey) console.log('[AIDA/Truckstop] Step: findLoadsArray → data.loadSearch.items, len=', loadSearch.items.length);
            return loadSearch.items;
        }
        for (const k in d) {
            if (!Object.prototype.hasOwnProperty.call(d, k)) continue;
            const arr = d[k];
            if (Array.isArray(arr) && arr.length > 0) {
                if (logKey) console.log('[AIDA/Truckstop] Step: findLoadsArray → data.' + k + ', len=', arr.length);
                return arr;
            }
        }
    }
    if (logKey) console.log('[AIDA/Truckstop] Step: findLoadsArray — no array, data keys:', d ? Object.keys(d).slice(0, 12).join(', ') : 'none');
    return null;
}

/** Привести к строке. */
function str(val) {
    if (val == null) return '';
    if (typeof val === 'string') return val.trim();
    if (typeof val === 'number') return String(val);
    return '';
}

/**
 * Один объект — в единый формат Load (ТЗ §5, background/load-format.js).
 */
function normalizeTruckstopRaw(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const originCity = str(raw.originCity ?? raw.origin?.city ?? raw.Origin?.City ?? '');
    const originState = str(raw.originState ?? raw.origin?.state ?? raw.Origin?.State ?? '');
    const originZip = str(raw.originZipCode ?? raw.origin?.zip ?? raw.originZip ?? raw.Origin?.postalCode ?? '');
    const destCity = str(raw.destinationCity ?? raw.destination?.city ?? raw.Destination?.City ?? '');
    const destState = str(raw.destinationState ?? raw.destination?.state ?? raw.Destination?.State ?? '');
    const destZip = str(raw.destinationZipCode ?? raw.destination?.zip ?? raw.destinationZip ?? raw.Destination?.postalCode ?? '');
    const r = raw.postedRate ?? raw.rate ?? raw.Rate ?? raw.allInRate ?? raw.rateAmount;
    const m = raw.tripDistance ?? raw.miles ?? raw.Miles ?? raw.tripLength;
    const eq = str(raw.equipmentCode ?? raw.equipmentType ?? raw.equipment ?? raw.Equipment ?? '');
    const w = raw.dimensionsWeight ?? raw.weight ?? raw.Weight ?? raw.maxWeight;
    const phone = str(raw.phone ?? raw.Phone ?? raw.broker?.phone ?? raw.contact?.number ?? '');
    const name = str(raw.accountName ?? raw.brokerName ?? raw.broker?.name ?? raw.contact?.companyName ?? '');
    const email = str(raw.email ?? raw.broker?.email ?? raw.contact?.email ?? '');

    const loadId = raw.id ?? raw.loadId ?? raw.LoadId ?? raw.legacyLoadId ?? raw.postingId ?? '';
    if (!loadId && !originCity && !destCity && r == null) return null;

    const rateNum = typeof r === 'number' ? r : (typeof r === 'string' ? parseFloat(r) : null);
    const milesNum = typeof m === 'number' ? m : (typeof m === 'string' ? parseFloat(m) : null);
    const rpm = milesNum && rateNum ? Math.round((rateNum / milesNum) * 100) / 100 : null;

    const originEarly = str(raw.originEarlyTime ?? raw.pickupDate ?? raw.availableDate ?? raw.earliestPickup ?? '');
    const pickupDate = originEarly ? originEarly.split('T')[0] : '';
    const postedAt = str(raw.createdOn ?? raw.updatedOn ?? raw.postedAt ?? raw.PostedAt ?? '');
    const comments = str(raw[RAW_FIELD_COMMENTS] ?? '');

    return {
        id: `ts_${loadId || Math.random().toString(36).slice(2, 10)}`,
        board: BOARD,
        origin: { city: originCity, state: originState, zip: originZip },
        destination: { city: destCity, state: destState, zip: destZip },
        equipment: eq || 'Unknown',
        equipmentCode: eq,
        weight: typeof w === 'number' ? w : (typeof w === 'string' ? parseFloat(w) : null),
        miles: milesNum,
        rate: rateNum,
        rpm,
        broker: { name: str(name), phone: str(phone), email: str(email) },
        comments,
        pickupDate,
        postedAt,
        status: 'active',
        statusUpdatedAt: new Date().toISOString(),
        receivedAt: new Date().toISOString(),
        raw
    };
}

function normalizeTruckstopResults(rawList) {
    if (!Array.isArray(rawList)) return [];
    const out = rawList.filter(r => r && typeof r === 'object').map(r => normalizeTruckstopRaw(r)).filter(Boolean);
    console.log('[AIDA/Truckstop] Step: normalizeTruckstopResults', rawList.length, 'raw →', out.length, 'loads');
    return out;
}

const TruckstopAdapter = {
    async search(params, ctx = {}) {
        console.log('[AIDA/Truckstop] Step: search called, params=', JSON.stringify(params || {}).slice(0, 120));
        const token = ctx.token;
        const template = ctx.truckstopTemplate;

        if (!token) {
            return {
                ok: false, loads: [], meta: { board: BOARD },
                error: { code: 'AUTH_REQUIRED', message: 'Truckstop token is missing', retriable: true }
            };
        }
        if (!template || !template.url) {
            return {
                ok: false, loads: [], meta: { board: BOARD },
                error: { code: 'NO_TEMPLATE', message: 'Truckstop request template not captured; open truckstop.com and run search there once', retriable: false }
            };
        }
        if (template.url.indexOf('LoadSearchCount') !== -1 || template.url.indexOf('searchCount') !== -1) {
            return {
                ok: false, loads: [], meta: { board: BOARD },
                error: { code: 'WRONG_TEMPLATE', message: 'Saved template is for count, not loads.', retriable: false }
            };
        }

        let body = template.body;
        try {
            const parsed = typeof body === 'string' ? JSON.parse(body) : body;
            if (parsed && typeof parsed === 'object' && parsed.variables) {
                const vars = parsed.variables;
                const hasNestedArgs = vars.args && typeof vars.args === 'object';
                const target = hasNestedArgs ? vars.args : vars;
                let modified = false;
                if (target && typeof target === 'object') {
                    const m = { ...target };
                    if (params?.origin && (params.origin.city || params.origin.state)) {
                        const coords = await geocodeOrigin(params.origin);
                        if (coords) {
                            m.dh_origin_lat = coords.lat;
                            m.dh_origin_lon = coords.lon;
                            modified = true;
                        }
                    }
                    if (params?.radius != null) { m.origin_radius = Number(params.radius) || 125; modified = true; }
                    if (params?.dateFrom) { m.pickup_date_begin = String(params.dateFrom).slice(0, 10); modified = true; }
                    if (params?.dateTo) { m.pickup_date_end = String(params.dateTo).slice(0, 10); modified = true; }
                    if (modified) {
                        if (hasNestedArgs) vars.args = m;
                        else parsed.variables = m;
                    }
                }
                if (modified) body = JSON.stringify(parsed);
            }
        } catch (e) {
            console.warn('[AIDA/Truckstop] Step: body parse/modify failed:', e?.message);
        }

        const headers = { ...(template.headers || {}) };
        if (!headers['Authorization'] && !headers['authorization']) headers['Authorization'] = `Bearer ${token}`;
        if (!headers['Content-Type']) headers['Content-Type'] = 'application/json';
        if (!headers['Origin']) headers['Origin'] = 'https://main.truckstop.com';
        if (!headers['Referer']) headers['Referer'] = 'https://main.truckstop.com/';
        if (Array.isArray(template.cookies) && template.cookies.length > 0) {
            headers['Cookie'] = template.cookies.map(c => c.name + '=' + c.value).join('; ');
        }

        try {
            const resp = await fetch(template.url, {
                method: template.method || 'POST',
                headers,
                credentials: 'include',
                body: typeof body === 'string' ? body : JSON.stringify(body)
            });
            const text = await resp.text();
            if (!resp.ok) {
                return {
                    ok: false, loads: [], meta: { board: BOARD },
                    error: { code: 'FETCH_FAILED', message: `HTTP ${resp.status}: ${text?.slice(0, 100)}`, retriable: resp.status >= 500 }
                };
            }
            if (!text || text.trim().charAt(0) === '<') return { ok: true, loads: [], meta: { board: BOARD } };
            const data = JSON.parse(text);
            const rawResults = findLoadsArray(data, true);
            if (!Array.isArray(rawResults)) return { ok: true, loads: [], meta: { board: BOARD } };
            const loads = normalizeTruckstopResults(rawResults);
            return { ok: true, loads, meta: { board: BOARD } };
        } catch (e) {
            return {
                ok: false, loads: [], meta: { board: BOARD },
                error: { code: 'NETWORK_ERROR', message: e?.message || 'Network error', retriable: true }
            };
        }
    }
};

export default TruckstopAdapter;
export { normalizeTruckstopResults };
