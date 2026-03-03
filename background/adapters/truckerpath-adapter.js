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

/** Геокодировка city+state → {lat, lon} через Nominatim (бесплатно, без ключа). */
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
        return { lat: parseFloat(first.lat), lon: parseFloat(first.lon) };
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

    // === Origin / Destination ===
    const originStr = getOriginString(row) || (typeof row.pickupLocation === 'string' && !looksLikePlaceholder(row.pickupLocation) ? row.pickupLocation : '') || (typeof row.origin === 'string' && !looksLikePlaceholder(row.origin) ? row.origin : '');
    const destinationStr = getDestinationString(row) || (typeof row.dropoffLocation === 'string' && !looksLikePlaceholder(row.dropoffLocation) ? row.dropoffLocation : '') || (typeof row.destination === 'string' && !looksLikePlaceholder(row.destination) ? row.destination : '');
    const origin = parseCityState(originStr);
    const destination = parseCityState(destinationStr);

    // Координаты
    const pickupLoc = row.pickup && row.pickup.location || {};
    const dropLoc = row.drop_off && row.drop_off.location || {};
    origin.lat = pickupLoc.lat ?? null;
    origin.lng = pickupLoc.lng ?? null;
    destination.lat = dropLoc.lat ?? null;
    destination.lng = dropLoc.lng ?? null;

    // === Груз ===
    const miles = typeof row.distance === 'number' && Number.isFinite(row.distance) ? row.distance : (typeof row.distance_total === 'number' ? row.distance_total : parseMiles(row.miles || row.tripDistance));
    const weight = typeof row.weight === 'number' && Number.isFinite(row.weight) ? row.weight : parseNumber(row.totalWeight);
    const rate = parseNumber(row.price_total || row.price || row.load_price || row.rate || row.postedRate);
    const rpm = miles && rate ? Math.round((rate / miles) * 100) / 100 : null;
    const equipRaw = row.equipment;
    const equipmentAll = Array.isArray(equipRaw) ? equipRaw.map(e => typeof e === 'string' ? e.toUpperCase() : (e && e.name || '')).filter(Boolean) : [];
    const equipment = equipmentAll[0] || (row.trailer || row.equipmentType || params?.equipment || 'VAN');
    const deadhead = row.pickup && typeof row.pickup.deadhead === 'number' ? row.pickup.deadhead : null;

    // === Broker ===
    const brokerObj = row.broker && typeof row.broker === 'object' ? row.broker : {};
    const brokerCompany = brokerObj.company || brokerObj.contact_name || brokerObj.contact_person || brokerObj.name || '';
    const phoneVal = brokerObj.phone;
    const brokerPhone = (phoneVal && typeof phoneVal === 'object' && phoneVal.number) ? String(phoneVal.number) : (typeof phoneVal === 'string' ? phoneVal : brokerObj.contact_phone || '');
    const brokerPhoneExt = (phoneVal && typeof phoneVal === 'object') ? (phoneVal.ext || '') : '';
    const tcRating = brokerObj.transcredit_rating || {};

    // === Notes: W×H + description ===
    const descParts = [];
    if (row.width && row.width > 0) descParts.push(row.width + 'W');
    if (row.height && row.height > 0) descParts.push(row.height + 'H');
    const descText = (typeof row.description === 'string' && row.description.trim()) || (typeof row[RAW_FIELD_COMMENTS] === 'string' && row[RAW_FIELD_COMMENTS].trim()) || '';
    if (descText) descParts.push(descText);
    const notes = descParts.join(' x ').replace(' x ', ' | ') || '';

    // === Даты ===
    const pickupDate = pickupDateFromRow(row, params || {});
    const postedAt = typeof row.created_at === 'number' ? new Date(row.created_at > 1e12 ? row.created_at : row.created_at * 1000).toISOString() : '';

    // === ID ===
    const idSeed = (row.shipment_id || row._id || row.load_id || row.load_card_id || '') + [origin.city, origin.state, destination.city, destination.state, pickupDate, idx].join('|');

    return {
        id: `tp_${btoa(unescape(encodeURIComponent(idSeed))).replace(/[+/=]/g, '').slice(0, 16)}`,
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

        // 1) Если есть template — делаем реальный запрос с подставленными параметрами
        if (template && template.url) {
            await rateLimit();

            // Геокодируем origin/destination → координаты для TP API
            const enrichedParams = { ...params };
            if (params.origin && (params.origin.city || params.origin.state)) {
                const geo = await geocodeCity(params.origin.city, params.origin.state);
                if (geo) {
                    enrichedParams._originGeo = geo;
                    console.log('[AIDA/TruckerPath] Geocoded origin:', params.origin.city, params.origin.state, '→', geo.lat, geo.lon);
                } else {
                    console.warn('[AIDA/TruckerPath] Failed to geocode origin:', params.origin.city, params.origin.state);
                }
            }
            if (params.destination && (params.destination.city || params.destination.state)) {
                const geo = await geocodeCity(params.destination.city, params.destination.state);
                if (geo) {
                    enrichedParams._destGeo = geo;
                    console.log('[AIDA/TruckerPath] Geocoded dest:', params.destination.city, params.destination.state, '→', geo.lat, geo.lon);
                }
            }

            let body = template.body;
            try {
                body = modifyTemplateBody(body, enrichedParams);
            } catch (e) {
                console.warn('[AIDA/TruckerPath] Step: body modify failed, using original:', e?.message);
            }

            const headers = { ...(template.headers || {}) };
            if (!headers['Content-Type'] && !headers['content-type']) headers['Content-Type'] = 'application/json';
            if (!headers['Origin']) headers['Origin'] = 'https://loadboard.truckerpath.com';
            if (!headers['Referer']) headers['Referer'] = 'https://loadboard.truckerpath.com/';
            if (Array.isArray(template.cookies) && template.cookies.length > 0) {
                headers['Cookie'] = template.cookies.map(c => c.name + '=' + c.value).join('; ');
            }

            try {
                console.log('[AIDA/TruckerPath] Step: fetch', template.url, 'method:', template.method || 'POST');
                const bodyStr = typeof body === 'string' ? body : JSON.stringify(body);
                console.log('[AIDA/TruckerPath] Step: request body preview:', bodyStr?.slice(0, 500));
                const resp = await fetch(template.url, {
                    method: template.method || 'POST',
                    headers,
                    credentials: 'include',
                    body: typeof body === 'string' ? body : JSON.stringify(body)
                });
                const text = await resp.text();
                if (!resp.ok) {
                    console.warn('[AIDA/TruckerPath] Step: HTTP', resp.status, text?.slice(0, 200));
                    // Fallback на кэш при ошибке
                    if (cachedLoads.length > 0) {
                        console.log('[AIDA/TruckerPath] Falling back to cached loads:', cachedLoads.length);
                        return { ok: true, loads: cachedLoads, meta: { board: BOARD, source: 'cache-fallback' } };
                    }
                    return {
                        ok: false, loads: [], meta: { board: BOARD },
                        error: { code: 'FETCH_FAILED', message: `HTTP ${resp.status}: ${text?.slice(0, 100)}`, retriable: resp.status >= 500 }
                    };
                }
                if (!text || text.trim().charAt(0) === '<') {
                    console.warn('[AIDA/TruckerPath] Step: got HTML instead of JSON (auth issue?)');
                    if (cachedLoads.length > 0) {
                        return { ok: true, loads: cachedLoads, meta: { board: BOARD, source: 'cache-fallback' } };
                    }
                    return {
                        ok: false, loads: [], meta: { board: BOARD },
                        error: { code: 'HTML_RESPONSE', message: 'TruckerPath returned HTML (login redirect?). Re-login on the tab.', retriable: false }
                    };
                }
                const data = JSON.parse(text);
                const rawResults = findLoadsInResponse(data);
                if (!Array.isArray(rawResults) || rawResults.length === 0) {
                    const topKeys = data ? Object.keys(data).slice(0, 10).join(', ') : 'null';
                    console.log(`[AIDA/TruckerPath] Step: 0 loads in response. Keys: [${topKeys}], text preview:`, text.slice(0, 300));
                    return { ok: true, loads: [], meta: { board: BOARD, source: 'api' } };
                }
                console.log('[AIDA/TruckerPath] Step: parsed', rawResults.length, 'loads from API');
                const loads = normalizeTruckerpathResults(rawResults, params);
                return { ok: true, loads, meta: { board: BOARD, source: 'api' } };
            } catch (e) {
                console.warn('[AIDA/TruckerPath] Step: fetch error:', e?.message);
                // Fallback на кэш
                if (cachedLoads.length > 0) {
                    return { ok: true, loads: cachedLoads, meta: { board: BOARD, source: 'cache-fallback' } };
                }
                return {
                    ok: false, loads: [], meta: { board: BOARD },
                    error: { code: 'NETWORK_ERROR', message: e?.message || 'Network error', retriable: true }
                };
            }
        }

        // 2) Нет template — если есть кэш, вернём его (грузы от харвестера)
        if (cachedLoads.length > 0) {
            console.log('[AIDA/TruckerPath] No template, using cached loads:', cachedLoads.length);
            return { ok: true, loads: cachedLoads, meta: { board: BOARD, source: 'cache' } };
        }

        // 3) Совсем ничего
        console.warn('[AIDA/TruckerPath] No template and no cached loads');
        return {
            ok: false, loads: [], meta: { board: BOARD },
            error: { code: 'NO_TEMPLATE', message: 'Open TruckerPath tab and run a search there to capture request template', retriable: false }
        };
    }
};

/**
 * Подставить новые параметры поиска в captured body (GraphQL или REST).
 * Структуры TP: { variables: { ... } } или { operationName, query, variables }.
 * Также пробуем плоскую структуру (REST body с ключами origin, destination итд).
 */
function modifyTemplateBody(body, params) {
    if (!body || !params) return body;
    const parsed = typeof body === 'string' ? JSON.parse(body) : body;
    if (!parsed || typeof parsed !== 'object') return body;

    let modified = false;

    // GraphQL-стиль: { variables: { ... } }
    if (parsed.variables && typeof parsed.variables === 'object') {
        const vars = parsed.variables;
        modified = patchSearchParams(vars, params) || modified;
        // Вложенные args/input
        if (vars.args && typeof vars.args === 'object') {
            modified = patchSearchParams(vars.args, params) || modified;
        }
        if (vars.input && typeof vars.input === 'object') {
            modified = patchSearchParams(vars.input, params) || modified;
        }
    }

    // REST-стиль: патчим верхний уровень + все известные вложенные объекты
    if (!parsed.variables) {
        modified = patchSearchParams(parsed, params) || modified;
    }

    // Рекурсивный обход вложенных объектов (filter, data, args, search, query, params, criteria)
    const nestedKeys = ['filter', 'data', 'args', 'input', 'search', 'query', 'params', 'criteria', 'options'];
    for (const k of nestedKeys) {
        if (parsed[k] && typeof parsed[k] === 'object' && !Array.isArray(parsed[k])) {
            modified = patchSearchParams(parsed[k], params) || modified;
        }
    }

    if (modified) {
        console.log('[AIDA/TruckerPath] Step: modified template body with new search params');
        return JSON.stringify(parsed);
    }
    return typeof body === 'string' ? body : JSON.stringify(parsed);
}

/** Подставить origin/destination/radius/dates/equipment в объект. */
function patchSearchParams(target, params) {
    if (!target || typeof target !== 'object') return false;
    let modified = false;

    // Origin: lat/lon или city/state
    if (params.origin) {
        // Lat/lon ключи — подставляем геокодированные координаты (или сохраняем оригинал)
        const latKeys = ['latitude', 'lat', 'origin_lat', 'dh_origin_lat', 'originLatitude', 'pickup_lat'];
        const lonKeys = ['longitude', 'lon', 'lng', 'origin_lon', 'dh_origin_lon', 'originLongitude', 'pickup_lon'];
        const originGeo = params._originGeo; // { lat, lon } от geocodeCity
        if (originGeo) {
            for (const k of latKeys) { if (target[k] !== undefined) { target[k] = originGeo.lat; modified = true; } }
            for (const k of lonKeys) { if (target[k] !== undefined) { target[k] = originGeo.lon; modified = true; } }
        }
        // Если нет координат — не трогаем lat/lon (оставляем оригинал шаблона)

        // City / state ключи
        const cityKeys = ['city', 'originCity', 'origin_city', 'pickup_city'];
        const stateKeys = ['state', 'originState', 'origin_state', 'pickup_state'];
        for (const k of cityKeys) {
            if (target[k] !== undefined) { target[k] = params.origin.city || ''; modified = true; }
        }
        for (const k of stateKeys) {
            if (target[k] !== undefined) { target[k] = params.origin.state || ''; modified = true; }
        }

        // Вложенный origin объект
        if (target.origin && typeof target.origin === 'object') {
            if (target.origin.city !== undefined) { target.origin.city = params.origin.city || ''; modified = true; }
            if (target.origin.state !== undefined) { target.origin.state = params.origin.state || ''; modified = true; }
        }
        if (target.pickupLocation && typeof target.pickupLocation === 'object') {
            if (target.pickupLocation.city !== undefined) { target.pickupLocation.city = params.origin.city || ''; modified = true; }
            if (target.pickupLocation.state !== undefined) { target.pickupLocation.state = params.origin.state || ''; modified = true; }
        }
    }

    // Destination
    if (params.destination && (params.destination.city || params.destination.state)) {
        // Destination lat/lon — подставляем геокодированные, если есть
        const destGeo = params._destGeo;
        if (destGeo) {
            const destLatKeys = ['dest_lat', 'destinationLatitude', 'dropoff_lat', 'delivery_lat'];
            const destLonKeys = ['dest_lon', 'dest_lng', 'destinationLongitude', 'dropoff_lon', 'delivery_lon'];
            for (const k of destLatKeys) { if (target[k] !== undefined) { target[k] = destGeo.lat; modified = true; } }
            for (const k of destLonKeys) { if (target[k] !== undefined) { target[k] = destGeo.lon; modified = true; } }
        }
        const destCityKeys = ['destCity', 'destinationCity', 'destination_city', 'dropoff_city'];
        const destStateKeys = ['destState', 'destinationState', 'destination_state', 'dropoff_state'];
        for (const k of destCityKeys) {
            if (target[k] !== undefined) { target[k] = params.destination.city || ''; modified = true; }
        }
        for (const k of destStateKeys) {
            if (target[k] !== undefined) { target[k] = params.destination.state || ''; modified = true; }
        }
        if (target.destination && typeof target.destination === 'object') {
            if (target.destination.city !== undefined) { target.destination.city = params.destination.city || ''; modified = true; }
            if (target.destination.state !== undefined) { target.destination.state = params.destination.state || ''; modified = true; }
        }
        if (target.dropoffLocation && typeof target.dropoffLocation === 'object') {
            if (target.dropoffLocation.city !== undefined) { target.dropoffLocation.city = params.destination.city || ''; modified = true; }
            if (target.dropoffLocation.state !== undefined) { target.dropoffLocation.state = params.destination.state || ''; modified = true; }
        }
    }

    // Radius
    const radiusKeys = ['radius', 'origin_radius', 'searchRadius', 'pickup_radius'];
    if (params.radius != null) {
        for (const k of radiusKeys) {
            if (target[k] !== undefined) { target[k] = Number(params.radius) || 100; modified = true; }
        }
    }

    // Dates
    if (params.dateFrom) {
        const dateFromKeys = ['dateFrom', 'pickup_date_begin', 'pickupDateFrom', 'startDate', 'availableFrom'];
        for (const k of dateFromKeys) {
            if (target[k] !== undefined) { target[k] = String(params.dateFrom).slice(0, 10); modified = true; }
        }
    }
    if (params.dateTo) {
        const dateToKeys = ['dateTo', 'pickup_date_end', 'pickupDateTo', 'endDate', 'availableTo'];
        for (const k of dateToKeys) {
            if (target[k] !== undefined) { target[k] = String(params.dateTo).slice(0, 10); modified = true; }
        }
    }

    // Equipment
    if (params.equipment) {
        const equipKeys = ['equipment', 'equipmentType', 'trailer', 'trailerType'];
        for (const k of equipKeys) {
            if (target[k] !== undefined) { target[k] = params.equipment; modified = true; }
        }
    }

    return modified;
}

/** Найти массив грузов в ответе API (GraphQL или REST). */
function findLoadsInResponse(data) {
    if (!data || typeof data !== 'object') return null;
    if (Array.isArray(data) && data.length > 0) return data;
    // Стандартные ключи
    const keys = ['loads', 'results', 'items', 'records', 'data', 'edges', 'nodes'];
    for (const key of keys) {
        const val = data[key];
        if (Array.isArray(val) && val.length > 0) return val;
        if (val && typeof val === 'object' && !Array.isArray(val)) {
            const inner = findLoadsInResponse(val);
            if (inner) return inner;
        }
    }
    // GraphQL: data.data.xxx
    if (data.data && typeof data.data === 'object') {
        for (const k in data.data) {
            const v = data.data[k];
            if (Array.isArray(v) && v.length > 0) return v;
        }
    }
    return null;
}

export default TruckerpathAdapter;
export { normalizeTruckerpathResults };
