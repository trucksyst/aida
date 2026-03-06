/**
 * AIDA v0.1 — Truckstop Adapter (Autonomous Plugin)
 *
 * Полностью автономный адаптер — чёрный ящик.
 * Сам берёт токен через AuthManager, сам управляет auto-refresh и пагинацией.
 * Core не знает деталей — только вызывает единый контракт:
 *   search(params), startRealtime(params, onUpdate), stopRealtime(),
 *   loadMore(), getStatus(), login(), disconnect(), handleAlarm()
 */
import AuthManager from '../auth/auth-manager.js';

const BOARD = 'truckstop';

/** Ключ описания груза (COMMENTS) в сырой карточке — взять из консоли, не угадывать. */
const RAW_FIELD_COMMENTS = 'comments';

/** Built-in GraphQL endpoint (Hasura) — не требует Authorization. */
const BUILTIN_GRAPHQL_URL = 'https://loadsearch-graphql-api-prod.truckstop.com/v1/graphql';

/** Equipment name маппинг (AIDA → Truckstop display names для template-based search). */
const TS_EQUIP_MAP = {
    'VAN': 'Van', 'REEFER': 'Reefer', 'FLATBED': 'Flatbed',
    'STEPDECK': 'Step Deck', 'DOUBLEDROP': 'Double Drop',
    'LOWBOY': 'Lowboy', 'RGN': 'Removable Gooseneck',
    'HOPPER': 'Hopper Bottom', 'TANKER': 'Tanker',
    'POWERONLY': 'Power Only', 'CONTAINER': 'Container',
    'DUMP': 'Dump Trailer', 'AUTOCARRIER': 'Auto Carrier',
    'LANDOLL': 'Landoll', 'MAXI': 'Maxi'
};

/** Маппинг AIDA equipment → Truckstop equipment_ids (из GetMasterEquipment API).
 *  Каждый тип — массив всех childId (подтипов), как передаёт сайт truckstop.com. */
const TS_EQUIP_IDS = {
    'VAN': [17, 41, 43, 44, 45, 46, 48, 49, 50, 51, 53, 54, 56, 57, 58, 60, 61, 62, 63, 64, 65, 67, 68, 69, 70, 71, 76],
    'REEFER': [17, 31, 34, 53, 56, 57, 61, 63, 64, 67, 68, 69, 70, 76],
    'FLATBED': [12, 14, 15, 16, 17, 18, 48, 59, 60, 61, 62, 63, 65, 67, 68, 69, 76, 78],
    'STEPDECK': [16, 37, 38, 39, 62, 66],
    'DOUBLEDROP': [9, 64],
    'LOWBOY': [23],
    'RGN': [9, 15, 23, 24, 32, 33, 39, 66],
    'HOPPER': [19],
    'TANKER': [42],
    'POWERONLY': [25, 30],
    'CONTAINER': [8],
    'DUMP': [10, 79],
    'AUTOCARRIER': [3],
    'LANDOLL': [22],
    'MAXI': [27]
};

/** Получить строку equipment_ids из params.equipment (Hasura _int4 формат). */
function getEquipmentIds(params) {
    if (!params?.equipment) return null;
    const eqArr = Array.isArray(params.equipment) ? params.equipment : [params.equipment];
    const allIds = new Set();
    for (const e of eqArr) {
        const ids = TS_EQUIP_IDS[e];
        if (ids) ids.forEach(id => allIds.add(id));
    }
    return allIds.size > 0 ? `{${[...allIds].sort((a, b) => a - b).join(',')}}` : null;
}

/** Полный GraphQL query для built-in поиска (из HAR main.truckstop.com). */
const BUILTIN_GRAPHQL_QUERY = `query LoadSearchSortByBinRateDesc($args: get_loads_with_extra_data_sort_by_bin_rate_desc_args! = {}, $isPro: Boolean!) {
  get_loads_with_extra_data_sort_by_bin_rate_desc(args: $args) {
    ...GridLoadSearchFields
    __typename
  }
}

fragment GridLoadSearchFields on loads_grid_ret_type {
  id
  modeId
  modeCode
  originCity
  originState
  originCityState
  originEarlyTime
  originLateTime
  originDeadhead
  originCountry
  originZipCode
  destinationCity
  destinationState
  destinationCityState
  destinationEarlyTime
  destinationLateTime
  destinationDeadhead
  destinationCountry
  destinationZipCode
  tripDistance
  dimensionsLength
  dimensionsWeight
  dimensionsWidth
  dimensionsHeight
  dimensionsCube
  postedRate
  equipmentCode
  equipmentName
  equipmentOptions
  isBookItNow
  loadTrackingRequired
  allInRate
  rpm @include(if: $isPro)
  accountName
  experienceFactor
  daysToPay
  bondTypeId
  bondEnabled
  payEnabled
  dot
  brokerMC
  commodityId
  specialInfo
  createdOn
  additionalLoadStops
  loadStateId
  phone
  legacyLoadId
  updatedOn
  canBookItNow
  daysToPayInteger
  postedAsUserPhone
  bondTypeSortOrder
  diamondCount
  earningsScore
  loadPopularity
  factorabilityStatus
  hasTiers
  isCarrierOnboarded
  isPinnedLoad
  isRepost
  rowType
  isCompanyFactorable
  __typename
}`;

/** GraphQL query для auto-refresh: сортировка по updatedOn (свежие первые). */
const BUILTIN_GRAPHQL_QUERY_UPDATED = `query LoadSearchSortByUpdatedOnDesc($args: get_loads_with_extra_data_sort_by_updated_on_desc_args! = {}, $isPro: Boolean!) {
  get_loads_with_extra_data_sort_by_updated_on_desc(args: $args) {
    ...GridLoadSearchFields
    __typename
  }
}

fragment GridLoadSearchFields on loads_grid_ret_type {
  id
  modeId
  modeCode
  originCity
  originState
  originCityState
  originEarlyTime
  originLateTime
  originDeadhead
  originCountry
  originZipCode
  destinationCity
  destinationState
  destinationCityState
  destinationEarlyTime
  destinationLateTime
  destinationDeadhead
  destinationCountry
  destinationZipCode
  tripDistance
  dimensionsLength
  dimensionsWeight
  dimensionsWidth
  dimensionsHeight
  dimensionsCube
  postedRate
  equipmentCode
  equipmentName
  equipmentOptions
  isBookItNow
  loadTrackingRequired
  allInRate
  rpm @include(if: $isPro)
  accountName
  experienceFactor
  daysToPay
  bondTypeId
  bondEnabled
  payEnabled
  dot
  brokerMC
  commodityId
  specialInfo
  createdOn
  additionalLoadStops
  loadStateId
  phone
  legacyLoadId
  updatedOn
  canBookItNow
  daysToPayInteger
  postedAsUserPhone
  bondTypeSortOrder
  diamondCount
  earningsScore
  loadPopularity
  factorabilityStatus
  hasTiers
  isCarrierOnboarded
  isPinnedLoad
  isRepost
  rowType
  isCompanyFactorable
  __typename
}`;

/** Геокодировка origin (city, state) → lat, lon через Nominatim. */
async function geocodeOrigin(origin) {
    if (!origin || (!origin.city && !origin.state)) return null;
    const q = [origin.city, origin.state].filter(Boolean).join(', ') + ', USA';
    const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(q)}&format=json&limit=1`;

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
        // geocode ok — не логируем (каждые 30с auto-refresh)
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

            return loadSearch.items;
        }
        for (const k in d) {
            if (!Object.prototype.hasOwnProperty.call(d, k)) continue;
            const arr = d[k];
            if (Array.isArray(arr) && arr.length > 0) {

                return arr;
            }
        }
    }

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
    const originCity = str(raw.originCity ?? raw.origin?.city ?? '');
    const originState = str(raw.originState ?? raw.origin?.state ?? '');
    const destCity = str(raw.destinationCity ?? raw.destination?.city ?? '');
    const destState = str(raw.destinationState ?? raw.destination?.state ?? '');
    const r = raw.postedRate ?? raw.rate ?? raw.allInRate ?? raw.rateAmount;
    const m = raw.tripDistance ?? raw.miles ?? raw.tripLength;
    const eq = str(raw.equipmentCode ?? raw.equipmentType ?? raw.equipment ?? '');
    const eqName = str(raw.equipmentName ?? '');
    const w = raw.dimensionsWeight ?? raw.weight ?? raw.maxWeight;
    const phone = str(raw.phone ?? raw.broker?.phone ?? raw.contact?.number ?? '');
    const name = str(raw.accountName ?? raw.brokerName ?? raw.broker?.name ?? raw.contact?.companyName ?? '');
    const email = str(raw.email ?? raw.broker?.email ?? raw.contact?.email ?? '');

    const loadId = raw.id ?? raw.loadId ?? raw.legacyLoadId ?? raw.postingId ?? '';
    if (!loadId && !originCity && !destCity && r == null) return null;

    const rateNum = typeof r === 'number' ? r : (typeof r === 'string' ? parseFloat(r) : null);
    const milesNum = typeof m === 'number' ? m : (typeof m === 'string' ? parseFloat(m) : null);
    const rpm = milesNum && rateNum ? Math.round((rateNum / milesNum) * 100) / 100 : null;

    const originEarly = str(raw.originEarlyTime ?? raw.pickupDate ?? raw.availableDate ?? '');
    const pickupDate = originEarly ? originEarly.split('T')[0] : '';
    // Truckstop timestamps — UTC без 'Z', добавляем для правильного парсинга
    let postedAt = str(raw.updatedOn || raw.createdOn || raw.postedAt || '');
    if (postedAt && !postedAt.endsWith('Z') && !postedAt.includes('+')) {
        postedAt += 'Z';
    }

    // Notes: W×H + specialInfo
    const descParts = [];
    if (raw.dimensionsWidth && raw.dimensionsWidth > 0) descParts.push(raw.dimensionsWidth + 'W');
    if (raw.dimensionsHeight && raw.dimensionsHeight > 0) descParts.push(raw.dimensionsHeight + 'H');
    const specialInfo = str(raw.specialInfo ?? raw[RAW_FIELD_COMMENTS] ?? '');
    if (specialInfo) descParts.push(specialInfo);
    const notes = descParts.join(' x ').replace(' x ', ' | ') || '';

    // Rating: experienceFactor "A"→95, "B"→80, "C"→60, "D"→40, "F"→20
    const expFactor = str(raw.experienceFactor ?? '');
    const ratingMap = { A: 95, B: 80, C: 60, D: 40, F: 20 };
    const rating = ratingMap[expFactor] ?? null;

    return {
        id: `ts_${loadId || Math.random().toString(36).slice(2, 10)}`,
        board: BOARD,
        externalId: raw.legacyLoadId ? String(raw.legacyLoadId) : String(loadId || ''),
        origin: { city: originCity, state: originState, lat: null, lng: null },
        destination: { city: destCity, state: destState, lat: null, lng: null },
        equipment: eq || 'Unknown',
        equipmentName: eqName,
        equipmentAll: eq ? [eq] : [],
        weight: typeof w === 'number' ? w : (typeof w === 'string' ? parseFloat(w) : null),
        length: typeof raw.dimensionsLength === 'number' && raw.dimensionsLength > 0 ? raw.dimensionsLength : null,
        fullPartial: '',
        miles: milesNum,
        deadhead: typeof raw.originDeadhead === 'number' ? raw.originDeadhead : null,
        rate: rateNum,
        rpm,
        broker: {
            company: name,
            phone: phone,
            phoneExt: '',
            email: email,
            mc: raw.brokerMC ? String(raw.brokerMC) : '',
            dot: raw.dot ? String(raw.dot) : '',
            address: '',
            rating,
            daysToPay: raw.daysToPayInteger ?? (typeof raw.daysToPay === 'string' ? parseInt(raw.daysToPay, 10) || null : null),
        },
        notes,
        pickupDate,
        postedAt,
        status: 'active',
        bookNow: !!(raw.isBookItNow || raw.canBookItNow),
        factorable: !!(raw.isCompanyFactorable),
        raw
    };
}

function normalizeTruckstopResults(rawList) {
    if (!Array.isArray(rawList)) return [];
    const out = rawList.filter(r => r && typeof r === 'object').map(r => normalizeTruckstopRaw(r)).filter(Boolean);

    return out;
}

// ============================================================
// Auto-refresh & Pagination state
// ============================================================

const TS_REFRESH_ALARM = 'aida-ts-refresh';
const TS_REFRESH_INTERVAL_MIN = 0.5; // каждые 30 сек — как на сайте Truckstop
const TS_PAGE_SIZE = 100;

const TruckstopAdapter = {
    // Internal state
    _realtimeParams: null,
    _onUpdate: null,
    _lastParams: null,
    _offset: 0,

    // ---- Autonomous Auth helpers ----

    /** Получить JWT claims из storage (v5AccountId etc.) */
    async _getClaims() {
        const data = await chrome.storage.local.get('auth:truckstop:claims');
        return data['auth:truckstop:claims'] || null;
    },

    /** Получить token + claims, вернуть { token, claims } или null если нет. */
    async _getAuth() {
        const token = await AuthManager.getToken(BOARD);
        if (!token) return null;
        const claims = await this._getClaims();
        if (!claims || !claims.v5AccountId) return null;
        return { token, claims };
    },

    // ---- Unified Contract ----

    async search(params) {
        const auth = await this._getAuth();
        if (!auth) {
            return {
                ok: false, loads: [], meta: { board: BOARD },
                error: { code: 'AUTH_REQUIRED', message: 'Truckstop token/claims missing', retriable: true }
            };
        }

        // Сброс пагинации при новом поиске
        this._offset = 0;
        this._lastParams = params;

        const result = await this._searchBuiltIn(params, auth.token, auth.claims);

        // Автоматически стартуем polling на новые грузы
        this._realtimeParams = params;
        this._startPolling();

        return result;
    },

    /**
     * Поиск через захваченный шаблон (template от харвестера).
     * Старая логика — модифицирует body шаблона подставляя параметры.
     */
    async _searchWithTemplate(params, token, template) {
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

                    // Equipment (поддержка массива)
                    if (params?.equipment) {
                        const eqArr = Array.isArray(params.equipment) ? params.equipment : [params.equipment];
                        const tsNames = eqArr.map(e => TS_EQUIP_MAP[e] || e);
                        const eqKeys = ['equipmentType', 'equipment_type', 'equipment', 'equipmentCode', 'trailerType'];
                        for (const k of eqKeys) {
                            if (m[k] !== undefined) {
                                m[k] = Array.isArray(m[k]) ? tsNames : tsNames[0];
                                modified = true;
                            }
                        }
                    }
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

        return this._doFetch(template.url, template.method || 'POST', headers, body);
    },

    /**
     * Built-in поиск через захардкоженный GraphQL query.
     * Не требует captured template — только JWT claims + параметры поиска.
     */
    async _searchBuiltIn(params, token, claims) {
        // built-in GraphQL (единственный путь, не логируем)
        // Геокодируем origin
        let originLat = null, originLon = null;
        if (params?.origin && (params.origin.city || params.origin.state)) {
            const coords = await geocodeOrigin(params.origin);
            if (coords) {
                originLat = coords.lat;
                originLon = coords.lon;
            }
        }
        if (originLat == null || originLon == null) {
            return {
                ok: false, loads: [], meta: { board: BOARD },
                error: { code: 'GEOCODE_FAILED', message: 'Could not geocode origin city', retriable: false }
            };
        }

        const args = {
            dh_origin_lat: originLat,
            dh_origin_lon: originLon,
            origin_radius: Number(params.radius) || 125,
            pickup_date_begin: params.dateFrom ? String(params.dateFrom).slice(0, 10) : new Date().toISOString().slice(0, 10),
            pickup_date_end: params.dateTo ? String(params.dateTo).slice(0, 10) : null,
            carrier_id: claims.v5AccountId,
            gl_carrier_user_id: claims.accountUserId,
            account_user_id: claims.v5AccountUserId,
            enable_pinned_loads: true,
            enable_floating_loads: true,
            show_empty_minimum_authority_days_required: null,
            carrier_factoring_company_id: null,
            offset_num: Number(params.offset) || 0,
            limit_num: 100
        };
        // pickup_date_end fallback: +45 дней от pickup_date_begin
        if (!args.pickup_date_end) {
            const d = new Date(args.pickup_date_begin);
            d.setDate(d.getDate() + 45);
            args.pickup_date_end = d.toISOString().slice(0, 10);
        }
        // Equipment IDs (подтверждено introspection: equipment_ids: _int4)
        const eqIds = getEquipmentIds(params);
        if (eqIds) {
            args.equipment_ids = eqIds;

        }

        const body = JSON.stringify({
            operationName: 'LoadSearchSortByBinRateDesc',
            variables: { args, isPro: false },
            query: BUILTIN_GRAPHQL_QUERY
        });

        const headers = {
            'Content-Type': 'application/json',
            'Accept': 'application/json, text/plain, */*',
            'Authorization': `Bearer ${token}`,
            'Origin': 'https://main.truckstop.com',
            'Referer': 'https://main.truckstop.com/'
        };

        return this._doFetch(BUILTIN_GRAPHQL_URL, 'POST', headers, body);
    },

    /** Общий метод выполнения GraphQL запроса и парсинга результатов. */
    async _doFetch(url, method, headers, body) {
        try {
            const resp = await fetch(url, {
                method,
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

            // JWT expired → вернуть AUTH_REQUIRED для auto-resolve
            if (data.errors && !data.data) {
                const errMsg = data.errors[0]?.message || '';
                const errCode = data.errors[0]?.extensions?.code || '';
                if (errCode === 'invalid-jwt' || errMsg.includes('JWTExpired')) {
                    console.warn('[AIDA/Truckstop] JWT expired — need re-auth');
                    return {
                        ok: false, loads: [], meta: { board: BOARD },
                        error: { code: 'AUTH_REQUIRED', message: 'JWT expired', retriable: true }
                    };
                }
                return {
                    ok: false, loads: [], meta: { board: BOARD },
                    error: { code: 'GRAPHQL_ERROR', message: errMsg, retriable: true }
                };
            }

            const rawResults = findLoadsArray(data, true);
            if (!Array.isArray(rawResults)) return { ok: true, loads: [], meta: { board: BOARD } };
            const loads = normalizeTruckstopResults(rawResults);
            return { ok: true, loads, meta: { board: BOARD } };
        } catch (e) {
            console.error('[AIDA/Truckstop] _doFetch error:', e?.message);
            return {
                ok: false, loads: [], meta: { board: BOARD },
                error: { code: 'NETWORK_ERROR', message: e?.message || 'Network error', retriable: true }
            };
        }
    },

    /**
     * Auto-refresh: получить самые свежие грузы (sorted by updatedOn desc).
     * Возвращает { ok, loads, meta } — только НОВЫЕ грузы (limit=20).
     * Полностью автономный — сам берёт token/claims.
     */
    async refreshNew(params) {
        const auth = await this._getAuth();
        if (!auth) {
            return {
                ok: false, loads: [], meta: { board: BOARD },
                error: { code: 'AUTH_REQUIRED', message: 'Truckstop token/claims missing', retriable: true }
            };
        }

        // Геокодируем origin
        let originLat = null, originLon = null;
        if (params?.origin && (params.origin.city || params.origin.state)) {
            const coords = await geocodeOrigin(params.origin);
            if (coords) { originLat = coords.lat; originLon = coords.lon; }
        }
        if (originLat == null || originLon == null) {
            return { ok: false, loads: [], meta: { board: BOARD } };
        }

        const args = {
            dh_origin_lat: originLat,
            dh_origin_lon: originLon,
            origin_radius: Number(params.radius) || 125,
            pickup_date_begin: params.dateFrom ? String(params.dateFrom).slice(0, 10) : new Date().toISOString().slice(0, 10),
            pickup_date_end: params.dateTo ? String(params.dateTo).slice(0, 10) : null,
            carrier_id: auth.claims.v5AccountId,
            gl_carrier_user_id: auth.claims.accountUserId,
            account_user_id: auth.claims.v5AccountUserId,
            enable_pinned_loads: true,
            enable_floating_loads: true,
            show_empty_minimum_authority_days_required: null,
            carrier_factoring_company_id: null,
            offset_num: 0,
            limit_num: 20   // Маленькая пачка — только свежие
        };
        if (!args.pickup_date_end) {
            const d = new Date(args.pickup_date_begin);
            d.setDate(d.getDate() + 45);
            args.pickup_date_end = d.toISOString().slice(0, 10);
        }
        // Equipment IDs
        const eqIds = getEquipmentIds(params);
        if (eqIds) args.equipment_ids = eqIds;

        const body = JSON.stringify({
            operationName: 'LoadSearchSortByUpdatedOnDesc',
            variables: { args, isPro: false },
            query: BUILTIN_GRAPHQL_QUERY_UPDATED
        });

        const headers = {
            'Content-Type': 'application/json',
            'Accept': 'application/json, text/plain, */*',
            'Authorization': `Bearer ${auth.token}`,
            'Origin': 'https://main.truckstop.com',
            'Referer': 'https://main.truckstop.com/'
        };

        return this._doFetch(BUILTIN_GRAPHQL_URL, 'POST', headers, body);
    },

    /**
     * Зарегистрировать callback для realtime updates.
     * Вызывается один раз при инициализации из Core.
     * @param {function} fn — callback(board, event)
     */
    setRealtimeCallback(fn) {
        this._onRealtimeUpdate = fn;
    },

    // ─── Внутренние методы polling (не публичные) ─────────────

    _startPolling() {
        this._stopPolling();
        chrome.alarms.create(TS_REFRESH_ALARM, { periodInMinutes: TS_REFRESH_INTERVAL_MIN });

    },

    _stopPolling() {
        this._realtimeParams = null;
        chrome.alarms.clear(TS_REFRESH_ALARM).catch(() => { });
    },

    /**
     * Обработчик alarm — вызывается из Core alarm router.
     * Делает refreshNew() и вызывает callback с новыми грузами.
     */
    async handleAlarm() {
        if (!this._realtimeParams) return;

        let result = await this.refreshNew(this._realtimeParams);

        // JWT протух → silent refresh → retry
        if (!result?.ok && (result?.error?.code === 'AUTH_REQUIRED' || result?.error?.code === 'NO_CLAIMS')) {
            console.log('[AIDA/Truckstop] auto-refresh: JWT expired, trying silent refresh...');
            const refreshed = await AuthManager.autoResolveAuthErrors([{ board: BOARD, error: result.error }]);
            if (refreshed.resolved?.includes(BOARD)) {
                result = await this.refreshNew(this._realtimeParams);
            }
        }

        if (!result?.ok || !Array.isArray(result.loads) || result.loads.length === 0) return;

        // Вызываем callback — Core решит что делать с новыми грузами
        if (this._onRealtimeUpdate) {
            this._onRealtimeUpdate(BOARD, result.loads);
        }
    },

    // ============================================================
    // Pagination (loadMore) — полностью внутри адаптера
    // ============================================================

    async loadMore() {
        if (!this._lastParams) {
            return { ok: false, error: 'No active search', loads: [] };
        }

        const auth = await this._getAuth();
        if (!auth) {
            return { ok: false, error: 'Truckstop not connected', loads: [] };
        }

        this._offset += TS_PAGE_SIZE;
        const paramsWithOffset = { ...this._lastParams, offset: this._offset };
        const result = await this._searchBuiltIn(paramsWithOffset, auth.token, auth.claims);

        if (!result?.ok || !Array.isArray(result.loads) || result.loads.length === 0) {
            return { ok: true, loads: [], added: 0, hasMore: false };
        }

        return { ok: true, loads: result.loads, added: result.loads.length, hasMore: result.loads.length >= TS_PAGE_SIZE };
    },

    // ============================================================
    // Status / Login / Disconnect — прокси к AuthManager
    // ============================================================

    async getStatus() {
        const status = await AuthManager.getStatus(BOARD);
        return {
            connected: status === 'connected',
            status,
            hasToken: status !== 'disconnected',
            hasAuthModule: true
        };
    },

    async login() {
        return AuthManager.login(BOARD);
    },

    async disconnect() {
        this.stopRealtime();
        return AuthManager.disconnect(BOARD);
    }
};

export default TruckstopAdapter;
export { normalizeTruckstopResults };
