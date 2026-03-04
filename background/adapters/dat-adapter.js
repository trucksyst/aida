/**
 * AIDA v0.1 — DAT Adapter
 * Адаптер для DAT One (one.dat.com).
 * Делает GraphQL запрос к freight.api.dat.com напрямую из background.js
 * с ручными Origin/Referer заголовками (проверено в рабочем коде).
 *
 * Rate limit: 1 запрос / 2 секунды.
 */

import Storage from '../storage.js';

// ============================================================
// Equipment codes — из example/content/dat-interceptor.js
// ============================================================
const EQ_NAMES = {
    'AC': 'Auto Carrier', 'BT': 'B-Train', 'CN': 'Conestoga',
    'C': 'Container', 'CI': 'Container Insulated', 'CR': 'Container Refrigerated',
    'CV': 'Conveyor', 'DD': 'Double Drop', 'LA': 'Drop Deck Landoll',
    'DT': 'Dump Trailer', 'F': 'Flatbed', 'FA': 'Flatbed Air-Ride',
    'FN': 'Flatbed Conestoga', 'F2': 'Flatbed Double', 'FZ': 'Flatbed HazMat',
    'FH': 'Flatbed Hotshot', 'MX': 'Flatbed Maxi', 'FD': 'Flatbed or Step Deck',
    'FC': 'Flatbed w/Chains', 'FS': 'Flatbed w/Sides', 'FT': 'Flatbed w/Tarps',
    'FM': 'Flatbed w/Team', 'FO': 'Flatbed (Over Dim)', 'FR': 'Flatbed/Van/Reefer',
    'HB': 'Hopper Bottom', 'IR': 'Insulated Van/Reefer',
    'LB': 'Lowboy', 'LO': 'Lowboy (Over Dim)', 'LR': 'Lowboy or RGN',
    'MV': 'Moving Van', 'NU': 'Pneumatic',
    'PO': 'Power Only', 'PL': 'Power Only Load Out', 'PT': 'Power Only Towaway',
    'R': 'Reefer', 'RA': 'Reefer Air-Ride', 'R2': 'Reefer Double',
    'RZ': 'Reefer HazMat', 'RN': 'Reefer Intermodal', 'RL': 'Reefer Logistics',
    'RV': 'Reefer/Vented Van', 'RM': 'Reefer w/Team', 'RP': 'Reefer w/Pallet',
    'RG': 'Removable Gooseneck', 'SV': 'Sprinter Van', 'SZ': 'Sprinter HazMat',
    'SM': 'Sprinter Team', 'SC': 'Sprinter Temp-Ctrl',
    'SD': 'Step Deck', 'SR': 'Step Deck or RGN', 'SN': 'Stepdeck Conestoga',
    'SB': 'Straight Box', 'BR': 'Straight Box Reefer', 'BZ': 'Straight Box HazMat',
    'ST': 'Stretch Trailer', 'TA': 'Tanker Aluminum', 'TN': 'Tanker Intermodal',
    'TS': 'Tanker Steel', 'TT': 'Truck and Trailer',
    'V': 'Van', 'VA': 'Van Air-Ride', 'VS': 'Van Conestoga',
    'V2': 'Van Double', 'VZ': 'Van HazMat', 'VH': 'Van Hotshot',
    'VI': 'Van Insulated', 'VN': 'Van Intermodal', 'VG': 'Van Lift-Gate',
    'VL': 'Van Logistics', 'VB': 'Van Roller Bed', 'V3': 'Van Triple',
    'VV': 'Van Vented', 'VW': 'Van w/Blanket Wrap', 'VC': 'Van w/Curtains',
    'VP': 'Van w/Pallet', 'VM': 'Van w/Team', 'OT': 'Van Open-Top',
    'VF': 'Van or Flatbed', 'VT': 'Van/Flatbed w/Tarps', 'VR': 'Van or Reefer'
};

// Маппинг UI-выбора → DAT equipment CLASSES (FreightSearchEquipmentClassV2 enum).
// API принимает classes (V, R, F, D, B, Z, O, T, S), а НЕ eqTypes (VA, RA, FT и т.д.).
// Каждый class включает все свои подтипы автоматически:
//   V → V,VA,VS,V2,VZ,VH,VI,VN,VG,VL,VB,V3,VV,VW,VC,VP,VM,OT,VF,VT,VR
//   R → R,RA,R2,RZ,RN,RL,RV,RM,RP
//   F → F,FA,FN,F2,FZ,FH,MX,FD,FC,FS,FT,FM,FO,FR,CN,DD,LA,DT,LB,LR,LO,RG,SR,ST,TT
//   D → DD,FD,SD,SR    B → HB,NU    Z → FZ,RZ,VZ
//   O → AC,CV,PO,SB,SV,SZ,SC,SM,BR,BZ,PT,PL    T → TA,TN,TS
//   S → IR,MV,RV,V2,VH,VI,VL,OT,VB,V3,VV,VC,VM
const EQUIPMENT_MAP = {
    'VAN': ['V'],
    'REEFER': ['R'],
    'FLATBED': ['F'],
    'STEPDECK': ['D'],       // SD + SR + SN
    'DOUBLEDROP': ['F'],       // DD входит в Flatbed class
    'LOWBOY': ['F'],       // LB, LO входят в Flatbed class
    'RGN': ['F'],       // RG входит в Flatbed class
    'HOPPER': ['B'],       // HB входит в Bulk class
    'TANKER': ['T'],
    'POWERONLY': ['O'],       // PO входит в Other class
    'CONTAINER': ['O'],       // C входит в Other class
    'DUMP': ['F'],       // DT входит в Flatbed class
    'AUTOCARRIER': ['O'],       // AC входит в Other class
    'LANDOLL': ['F'],       // LA входит в Flatbed class
    'MAXI': ['F']        // MX входит в Flatbed class
};

// ============================================================
// Rate Limiting
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

// ============================================================
// Search
// ============================================================

/**
 * Основной метод поиска грузов.
 * @param {Object} params - { origin: {city, state, zip}, destination: {city, state, zip},
 *                           radius: number, equipment: string, dateFrom: string, dateTo: string }
 * @returns {Promise<Load[]>} Нормализованные карточки грузов
 */
async function search(params) {
    const token = await Storage.getToken('dat');
    if (!token) {
        console.warn('[AIDA/DAT] No token available');
        return {
            ok: false, loads: [], meta: { board: 'dat' },
            error: { code: 'AUTH_REQUIRED', message: 'DAT token is missing', retriable: true }
        };
    }

    const origin = params.origin || {};
    const dest = params.destination || {};
    const originCity = str(origin.city || origin.address?.city);
    const originState = str(origin.state || origin.stateProv || origin.address?.state);
    const destCity = str(dest.city || dest.address?.city);
    const destState = str(dest.state || dest.stateProv || dest.address?.state);

    const originLookup = [originCity, originState].filter(Boolean).join(', ');
    const destLookup = [destCity, destState].filter(Boolean).join(', ');

    let originPlace = null;
    let destPlace = null;
    if (originLookup) {
        originPlace = await getLocationSuggestion(token, originLookup);
        if (originPlace === 'AUTH_FAILED') {
            return {
                ok: false, loads: [], meta: { board: 'dat' },
                error: { code: 'AUTH_REQUIRED', message: 'DAT token expired (location API 401)', retriable: true }
            };
        }
        if (!originPlace) {
            console.warn('[AIDA/DAT] No location suggestion for origin:', originLookup);
            return [];
        }
    } else {
        console.warn('[AIDA/DAT] Origin city/state required for search');
        return [];
    }
    if (destLookup) {
        destPlace = await getLocationSuggestion(token, destLookup);
        if (!destPlace) {
            console.warn('[AIDA/DAT] No location suggestion for destination:', destLookup);
        }
    }

    await rateLimit();
    const body = buildGraphQLRequest(params, originPlace, destPlace);
    console.log('[AIDA/DAT] FindLoads criteria:', JSON.stringify(body.variables.criteria, null, 2));

    const resp = await fetch(GRAPHQL_URL, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${token}`,
            'Origin': 'https://one.dat.com',
            'Referer': 'https://one.dat.com/'
        },
        body: JSON.stringify(body)
    });

    if (!resp.ok) {
        const text = await resp.text();
        console.warn('[AIDA/DAT] Search failed:', resp.status, text.slice(0, 500));
        if (resp.status === 401 || resp.status === 403) {
            return {
                ok: false, loads: [], meta: { board: 'dat' },
                error: { code: 'AUTH_REQUIRED', message: `DAT auth error (${resp.status})`, retriable: true }
            };
        }
        if (resp.status === 400) {
            try {
                const errJson = JSON.parse(text);
                const msg = errJson?.errors?.[0]?.message || errJson?.message || text.slice(0, 200);
                console.warn('[AIDA/DAT] 400 detail:', msg);
            } catch (_) { }
        }
        return { ok: false, loads: [], meta: { board: 'dat' }, error: { code: 'FETCH_FAILED', message: `HTTP ${resp.status}` } };
    }

    let json;
    try {
        json = await resp.json();
    } catch (e) {
        console.warn('[AIDA/DAT] Response not JSON:', e.message);
        return [];
    }

    if (json?.errors?.length) {
        console.warn('[AIDA/DAT] GraphQL errors:', json.errors);
    }

    const data = json?.data || json;
    const root =
        data?.freightSearchV4FindLoads ||
        (data?.freightSearchV4 && data.freightSearchV4.findLoads) ||
        data?.freightSearchFindLoads ||
        data?.findLoads ||
        data?.freightSearch ||
        data;
    let rawList = Array.isArray(root) ? root : (root?.results || root?.data || root?.edges?.map(e => e.node) || []);
    if (!Array.isArray(rawList)) rawList = [];

    const searchId = root?.searchId || null;
    if (searchId) {
        console.log('[AIDA/DAT] searchId for SSE:', searchId);
    }

    const results = rawList.filter(r => r && typeof r === 'object').map(r => normalize(r)).filter(Boolean);
    if (rawList.length > 0 && results.length === 0) {
        console.warn('[AIDA/DAT] No items normalized, sample raw:', JSON.stringify(rawList[0]).slice(0, 300));
    }

    return { loads: results, searchId, token };
}

// ============================================================
// GraphQL Query Builder
// ============================================================

/** Привести значение к строке для полей API (DAT ждёт String, не undefined/object). */
function str(val) {
    if (val == null) return '';
    if (typeof val === 'string') return val.trim();
    if (typeof val === 'number') return String(val);
    return '';
}

const GRAPHQL_URL = 'https://freight.api.dat.com/one-web-bff/graphql';

/**
 * Запрос подсказок локации (город → placeId, latitude, longitude). Обязателен для FindLoads.
 * @param {string} token
 * @param {string} lookupTerm — например "Chicago, IL"
 * @returns {Promise<{id: number, city: string, state: string, latitude: number, longitude: number, postalCode: string}|null>}
 */
async function getLocationSuggestion(token, lookupTerm) {
    const term = typeof lookupTerm === 'string' ? lookupTerm.trim() : '';
    if (!term) return null;
    const body = {
        operationName: 'GetLocationSuggestions',
        variables: { lookupTerm: term },
        query: 'query GetLocationSuggestions($lookupTerm: String!) { locationSuggestions(term: $lookupTerm) { id name city state latitude longitude postalCode __typename } }'
    };
    const resp = await fetch(GRAPHQL_URL, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${token}`,
            'Origin': 'https://one.dat.com',
            'Referer': 'https://one.dat.com/'
        },
        body: JSON.stringify(body)
    });
    if (!resp.ok) {
        console.warn('[AIDA/DAT] GetLocationSuggestions HTTP', resp.status, 'for:', term);
        try { console.warn('[AIDA/DAT] GetLocationSuggestions body:', (await resp.text()).slice(0, 300)); } catch (_) { }
        if (resp.status === 401 || resp.status === 403) return 'AUTH_FAILED';
        return null;
    }
    let json;
    try {
        json = await resp.json();
    } catch (_) {
        return null;
    }
    const list = json?.data?.locationSuggestions;
    if (!Array.isArray(list) || list.length === 0) {
        console.warn('[AIDA/DAT] GetLocationSuggestions empty for:', term, 'response:', JSON.stringify(json).slice(0, 200));
        return null;
    }
    const first = list[0];
    const placeId = typeof first.id === 'number' ? first.id : null;
    const lat = typeof first.latitude === 'number' ? first.latitude : null;
    const lng = typeof first.longitude === 'number' ? first.longitude : null;
    if (placeId == null || lat == null || lng == null) {
        console.warn('[AIDA/DAT] GetLocationSuggestions missing fields:', JSON.stringify(first).slice(0, 200));
        return null;
    }
    console.log('[AIDA/DAT] GetLocationSuggestions resolved:', term, '→', first.name, 'placeId:', placeId, 'lat:', lat, 'lng:', lng);
    return { id: placeId, city: str(first.city), state: str(first.state), latitude: lat, longitude: lng, postalCode: str(first.postalCode) };
}

/**
 * Сборка запроса в формате FindLoads (FreightSearchV4SearchCriteriaInput).
 * originPlace/destPlace — результат getLocationSuggestion (с latitude, longitude, placeId); без них API возвращает 400.
 */
function buildGraphQLRequest(params, originPlace, destPlace) {
    const eqCodes = EQUIPMENT_MAP[params.equipment] || ['V'];
    const maxOriginMiles = Math.min(Number(params.radius) || 50, 500);
    const maxDestMiles = 150;

    const originPlaceObj = originPlace
        ? {
            placeId: originPlace.id,
            city: originPlace.city,
            stateProv: originPlace.state,
            longitude: originPlace.longitude,
            latitude: originPlace.latitude,
            postalCode: originPlace.postalCode || undefined
        }
        : null;

    const destPlaceObj = destPlace
        ? {
            placeId: destPlace.id,
            city: destPlace.city,
            stateProv: destPlace.state,
            longitude: destPlace.longitude,
            latitude: destPlace.latitude,
            postalCode: destPlace.postalCode || undefined
        }
        : null;

    const criteria = {
        audience: { includeLoadBoard: true, includePrivateNetwork: true },
        lane: {
            origin: {
                place: originPlaceObj || { city: '', stateProv: '', postalCode: undefined }
            },
            destination: destPlaceObj ? { place: destPlaceObj } : { open: true }
        },
        equipment: { classes: eqCodes },
        filters: {
            excludePostingIds: [],
            includeOnlyBookable: false,
            preferredBlockedFilter: 'PREFERRED_AND_NORMAL',
            tracking: 'ALL'
        },
        maxAgeMinutes: 1440,
        maxOriginDeadheadMiles: maxOriginMiles,
        maxDestinationDeadheadMiles: maxDestMiles,
        availability: (params.dateFrom || params.dateTo)
            ? {
                earliestWhen: str(params.dateFrom) || undefined,
                latestWhen: str(params.dateTo || params.dateFrom) || undefined
            }
            : undefined,
        capacity: { fullPartial: 'BOTH' },
        orderBy: 'AGE_ASC',
        limit: 150,
        countsOnly: false,
        delivery: { notify: true, includeSimilarResults: true }
    };

    if (criteria.availability && !criteria.availability.earliestWhen && !criteria.availability.latestWhen) {
        delete criteria.availability;
    }
    const op = criteria.lane.origin.place;
    if (op && op.postalCode === '') delete op.postalCode;
    const dp = criteria.lane.destination?.place;
    if (dp && dp.postalCode === '') delete dp.postalCode;

    return {
        operationName: 'FindLoads',
        variables: { criteria },
        query: FIND_LOADS_QUERY
    };
}

// Полный GraphQL-запрос FindLoads из HAR (one.dat.com). Тип: FreightSearchV4SearchCriteriaInput.
const FIND_LOADS_QUERY = `
query FindLoads($criteria: FreightSearchV4SearchCriteriaInput!) {
  freightSearchV4 {
    __typename
    findLoads(criteria: $criteria) {
      __typename
      ... on FreightSearchV4FindLoadsSuccess {
        searchId
        metadata {
          matchAlertsLink
          __typename
          origin { __typename ...LocationSpecifierV4Fields }
          destination { __typename ...LocationSpecifierV4Fields }
        }
        results { __typename ...FindLoadResultV4Fields }
        similarResults { __typename ...FindLoadResultV4Fields }
        cursors { __typename next }
        searcher { __typename userId searcherMcNumber searcherDotNumber }
        resultCounts { __typename total loadBoard similar preferred blocked }
        __typename
      }
      ... on RequestError { error { __typename ...ErrorFields } __typename }
      ... on ServerError { error { __typename ...ErrorFields } __typename }
    }
  }
}
fragment LocationSpecifierV4Fields on FreightSearchV4LocationSpecifier {
  __typename place { __typename placeId city stateProv latitude longitude postalCode } coordinates { __typename latitude longitude }
}
fragment ErrorFields on ErrorEnvelope {
  __typename statusCode errors { __typename statusCode message appName dateTime }
}
fragment QualificationSettingsV4Fields on FreightSearchV4QualificationSettings {
  isDatOwnerVerified isActiveInterstateAuth isBrokerCarrierAuthExcluded isConditionalSafetyExcluded isUnsatisfactorySafetyExcluded minimumAuthorityAge minimumGeneralLiabilityInsurance minimumCargoInsurance isEldIntegrated __typename
}
fragment FindLoadResultV4Fields on FreightSearchV4FindLoadsResult {
  __typename isObfuscated redactionReasons unmetPreferences qualificationSettings { __typename ...QualificationSettingsV4Fields } isActive resultId
  assetInfo {
    __typename postingId equipmentType
    origin { __typename ...PointV4Fields }
    destination { __typename ...PointV4Fields }
    capacity { __typename fullPartial maximumLengthFeet maximumWeightPounds }
  }
  availability { __typename earliestWhen latestWhen }
  comments
  originDeadheadMiles { __typename ...MileageV4Fields }
  destinationDeadheadMiles { __typename ...MileageV4Fields }
  tripLength { __typename ...MileageV4Fields }
  isFromPrivateNetwork isFactorable isAssurable isNegotiable postersReferenceId posterDotIds { __typename ...DotIdsV4Fields }
  servicedWhen
  rateInfo {
    __typename
    bookable { __typename rate { __typename ...RateV4Fields } bookingMethod bookingUrl }
    nonBookable { __typename ...RateV4Fields }
  }
  posterInfo {
    __typename companyName city state
    contact { __typename email phone { __typename countryCode extension number } }
    contactMethods { method value { ... on EmailInfo { emailAddress __typename } ... on PhoneInfo { countryCode extension number __typename } __typename } __typename }
    preferredContactMethod hasTiaMembership credit { __typename creditScore daysToPay asOf } preferredBlockedStatus headquartersId
  }
  postingExpiresWhen combinedOfficeId estimatedRatePerMile
  workListItem { id shipmentId status userStatus computedStatus shipment { routeSegments { postingId bids { id __typename } __typename } __typename } __typename }
  bids { id postingId rateUsd brokerOfficeId carrierOfficeId carrierUserId status type __typename }
  status
}
fragment DotIdsV4Fields on FreightSearchV4DotIds {
  __typename dotNumber brokerMcNumber carrierMcNumber freightForwarderMcNumber
}
fragment MileageV4Fields on FreightSearchV4Mileage { __typename miles method }
fragment PointV4Fields on FreightSearchV4Point { __typename latitude longitude city stateProv }
fragment RateV4Fields on FreightSearchV4Rate { __typename rateUsd basis }
`.trim();

// ============================================================
// Normalize — приведение к стандартному формату AIDA
// Поля сырой карточки: в консоли лог "[AIDA/Core] DAT raw load card" — по нему сверять ключи.
// ============================================================

/** Ключ описания груза в сырой карточке DAT (GraphQL FindLoadResultV4Fields). Проверить в консоли. */
const RAW_FIELD_COMMENTS = 'comments';

function normalize(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const item = raw.assetInfo ? raw : (raw.posting || raw.load || raw);
    const ai = item.assetInfo || item;
    const pi = item.posterInfo || raw.posterInfo || {};
    const ri = item.rateInfo || raw.rateInfo || {};
    const cap = ai.capacity || {};
    const origin = ai.origin || raw.origin || {};
    const dest = ai.destination || raw.destination || {};
    const contact = pi.contact || raw.contact || {};
    const phone = contact?.phone && typeof contact.phone === 'object' ? contact.phone : { number: contact?.phone || '' };
    const credit = pi.credit || {};
    const tripLen = ai.tripLength || raw.tripLength || {};
    const dotIds = raw.posterDotIds || item.posterDotIds || {};
    const deadheadObj = raw.originDeadheadMiles || item.originDeadheadMiles || {};

    const rateObj = ri.bookable?.rate || (ri.bookable?.rateUsd ? ri.bookable : null) || ri.nonBookable || {};
    const rateUsd = rateObj.rateUsd ?? (typeof ri.rateUsd === 'number' ? ri.rateUsd : (typeof raw.rate === 'number' ? raw.rate : null));
    const miles = tripLen.miles ?? (typeof ai.tripLength === 'number' ? ai.tripLength : (typeof raw.miles === 'number' ? raw.miles : null));

    const eqCode = ai.equipmentType || raw.equipmentType || '';
    const originCity = origin.city || (typeof origin === 'string' ? origin : '');
    const destCity = dest.city || (typeof dest === 'string' ? dest : '');
    const postingId = ai.postingId || raw.resultId || raw.postingId || raw.id;

    if (!postingId && !originCity && !destCity && !rateUsd) return null;

    // comments в DAT — массив строк, join через \n
    const rawComments = raw[RAW_FIELD_COMMENTS] || item[RAW_FIELD_COMMENTS];
    const notes = Array.isArray(rawComments) ? rawComments.join('\n').trim()
        : (typeof rawComments === 'string' ? rawComments.trim() : '');

    return {
        id: `dat_${postingId || Math.random().toString(36).slice(2)}`,
        board: 'dat',
        externalId: String(postingId || ''),
        origin: {
            city: originCity,
            state: origin.stateProv || origin.state || '',
            lat: origin.latitude ?? null,
            lng: origin.longitude ?? null,
        },
        destination: {
            city: destCity,
            state: dest.stateProv || dest.state || '',
            lat: dest.latitude ?? null,
            lng: dest.longitude ?? null,
        },
        equipment: EQ_NAMES[eqCode] || eqCode || 'Unknown',
        equipmentName: EQ_NAMES[eqCode] || eqCode || '',
        equipmentAll: eqCode ? [eqCode] : [],
        weight: cap.maximumWeightPounds || null,
        length: cap.maximumLengthFeet || null,
        fullPartial: (cap.fullPartial || '').toUpperCase(),
        miles,
        deadhead: deadheadObj.miles ?? null,
        rate: rateUsd,
        rpm: miles && rateUsd ? Math.round((rateUsd / miles) * 100) / 100 : null,
        broker: {
            company: pi.companyName || '',
            phone: phone.number || '',
            phoneExt: phone.extension || '',
            email: contact.email || '',
            mc: dotIds.brokerMcNumber ? String(dotIds.brokerMcNumber) : '',
            dot: dotIds.dotNumber ? String(dotIds.dotNumber) : '',
            address: [pi.city, pi.state].filter(Boolean).join(', '),
            rating: credit.creditScore ?? null,
            daysToPay: credit.daysToPay ?? null,
        },
        notes,
        pickupDate: (function () {
            const av = raw.availability || item.availability;
            if (!av || !av.earliestWhen) return '';
            return String(av.earliestWhen).split('T')[0] || '';
        })(),
        postedAt: raw.servicedWhen || item.servicedWhen || raw.postedAt || '',
        status: 'active',
        bookNow: !!(ri.bookable),
        factorable: !!(raw.isFactorable || item.isFactorable),
        raw
    };
}

/** Нормализует сырой массив результатов поиска DAT (из перехвата ответа страницы). */
function normalizeDatResults(rawList) {
    return (rawList || []).filter(r => r && typeof r === 'object').map(r => normalize(r)).filter(Boolean);
}

// ============================================================
// Worklist API (My Loads на DAT — CALLED, SAVED, сброс)
// По образцу AiDispatch_v2: freight.api.dat.com/worklist-service/v1/items
// ============================================================

const WORKLIST_BASE = 'https://freight.api.dat.com/worklist-service/v1/items';

/**
 * Извлечь postingId из id карточки AIDA (формат dat_<postingId> или raw).
 * @param {Object} load — карточка в формате AIDA
 * @returns {string|null}
 */
function getDatPostingId(load) {
    if (!load) return null;
    if (load.raw?.assetInfo?.postingId) return String(load.raw.assetInfo.postingId);
    if (load.id && typeof load.id === 'string' && load.id.startsWith('dat_')) {
        return load.id.slice(4);
    }
    return null;
}

/**
 * Добавить груз в My Loads на DAT.
 * @param {Object} load — карточка AIDA (board === 'dat')
 * @param {'CALLED'|'SAVED'} userStatus
 * @returns {Promise<{ worklistItemId: string }|null>}
 */
async function addToWorklist(load, userStatus) {
    await rateLimit();

    const token = await Storage.getToken('dat');
    if (!token) {
        console.warn('[AIDA/DAT] No token for worklist');
        return null;
    }

    const postingId = getDatPostingId(load);
    if (!postingId) {
        console.warn('[AIDA/DAT] No postingId for worklist', load?.id);
        return null;
    }

    const resp = await fetch(WORKLIST_BASE, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${token}`,
            'Origin': 'https://one.dat.com',
            'Referer': 'https://one.dat.com/'
        },
        body: JSON.stringify({ postingId, userStatus })
    });

    if (!resp.ok) {
        const text = await resp.text();
        console.warn('[AIDA/DAT] Worklist POST failed:', resp.status, text.slice(0, 150));
        return null;
    }

    let json;
    try {
        json = await resp.json();
    } catch (e) {
        console.warn('[AIDA/DAT] Worklist response not JSON:', e.message);
        return null;
    }

    const worklistItemId = json?.id || null;
    if (worklistItemId) {
        console.log('[AIDA/DAT] Worklist added:', postingId, '→', userStatus, 'id:', worklistItemId);
    }
    return worklistItemId ? { worklistItemId } : null;
}

/**
 * Обновить статус в My Loads (SAVED или сброс).
 * @param {string} worklistItemId — id из addToWorklist
 * @param {string|null} userStatus — 'SAVED' или null для сброса
 * @returns {Promise<boolean>}
 */
async function updateWorklistStatus(worklistItemId, userStatus) {
    await rateLimit();

    const token = await Storage.getToken('dat');
    if (!token) {
        console.warn('[AIDA/DAT] No token for worklist');
        return false;
    }

    if (!worklistItemId) return false;

    const resp = await fetch(`${WORKLIST_BASE}/${worklistItemId}`, {
        method: 'PATCH',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${token}`,
            'Origin': 'https://one.dat.com',
            'Referer': 'https://one.dat.com/'
        },
        body: JSON.stringify({ userStatus })
    });

    if (!resp.ok) {
        console.warn('[AIDA/DAT] Worklist PATCH failed:', resp.status);
        return false;
    }
    console.log('[AIDA/DAT] Worklist updated:', worklistItemId, '→', userStatus || 'reset');
    return true;
}

/**
 * Удалить груз из My Loads на DAT.
 * @param {string} worklistItemId
 * @returns {Promise<boolean>}
 */
async function removeFromWorklist(worklistItemId) {
    await rateLimit();

    const token = await Storage.getToken('dat');
    if (!token || !worklistItemId) return false;

    const resp = await fetch(`${WORKLIST_BASE}/${worklistItemId}`, {
        method: 'DELETE',
        headers: {
            'Authorization': `Bearer ${token}`,
            'Origin': 'https://one.dat.com',
            'Referer': 'https://one.dat.com/'
        }
    });

    if (!resp.ok) {
        console.warn('[AIDA/DAT] Worklist DELETE failed:', resp.status);
        return false;
    }
    console.log('[AIDA/DAT] Worklist removed:', worklistItemId);
    return true;
}

// ============================================================
// SSE — подписка на новые грузы (liveQueryMatches v3)
// DAT пушит события через SSE по searchId из FindLoads.
// MV3 Service Worker не имеет EventSource — используем fetch + ReadableStream.
// ============================================================

const LIVE_QUERY_BASE = 'https://freight.api.prod.dat.com/notification/v3/liveQueryMatches';

// Типы событий SSE (V4 формат, совместим с FindLoads)
// Все известные типы SSE-событий от DAT liveQueryMatches
const SSE_EVENT_TYPES = [
    'DAT_MATCH_CREATED',
    'DAT_MATCH_DELETED',
    'DAT_MATCH_UPDATED',
    'EQUIPMENT_MATCH_CREATED',
    'EQUIPMENT_MATCH_UPDATED',
    'EQUIPMENT_MATCH_CANCELED',
    'MATCH_CREATED',
    'MATCH_UPDATED',
    'MATCH_CANCELLED',
    'LOAD_DATA_CREATED',
    'LOAD_DATA_UPDATED',
    'LOAD_DATA_DELETED',
    'SEARCH_MAX'
];

let _sseAbortController = null;
let _sseSearchId = null;

/**
 * Подписаться на SSE-поток новых грузов по searchId.
 * При получении события вызывает onEvent(eventType, data).
 * Предыдущая подписка автоматически отменяется.
 *
 * @param {string} searchId — из ответа FindLoads
 * @param {string} token — Bearer token DAT
 * @param {(eventType: string, data: object) => void} onEvent — колбек
 * @returns {{ stop: () => void }}
 */
function subscribeLiveQuery(searchId, token, onEvent) {
    unsubscribeLiveQuery();

    if (!searchId || !token) {
        console.warn('[AIDA/DAT] SSE: missing searchId or token');
        return { stop: () => { } };
    }

    _sseSearchId = searchId;
    _sseAbortController = new AbortController();
    const signal = _sseAbortController.signal;
    const url = `${LIVE_QUERY_BASE}/${searchId}`;

    console.log('[AIDA/DAT] SSE: subscribing to', url);

    (async () => {
        let lastEventId = '';
        let retries = 0;
        const MAX_RETRIES = 5;
        const BASE_DELAY = 5000;

        while (!signal.aborted && retries < MAX_RETRIES) {
            try {
                const headers = {
                    'Accept': 'text/event-stream',
                    'Authorization': `Bearer ${token}`,
                    'Origin': 'https://one.dat.com',
                    'Cache-Control': 'no-cache'
                };
                if (lastEventId) headers['Last-Event-ID'] = lastEventId;

                const resp = await fetch(url, { headers, signal });

                if (!resp.ok) {
                    console.warn('[AIDA/DAT] SSE: HTTP', resp.status);
                    break;
                }

                retries = 0;
                const reader = resp.body.getReader();
                const decoder = new TextDecoder();
                let buffer = '';

                while (!signal.aborted) {
                    const { done, value } = await reader.read();
                    if (done) break;

                    buffer += decoder.decode(value, { stream: true });
                    const lines = buffer.split('\n');
                    buffer = lines.pop() || '';

                    let eventType = '';
                    let dataStr = '';

                    for (let rawLine of lines) {
                        const line = rawLine.replace(/\r/g, '');
                        if (line.startsWith('event:')) {
                            // Убираем все непечатные символы из имени события
                            eventType = line.slice(6).trim().replace(/[^\x20-\x7E]/g, '');
                        } else if (line.startsWith('data:')) {
                            dataStr += line.slice(5).trim();
                        } else if (line.startsWith('id:')) {
                            lastEventId = line.slice(3).trim();
                        } else if (line === '') {
                            if (eventType && dataStr) {
                                try {
                                    const data = JSON.parse(dataStr);
                                    console.log('[AIDA/DAT] SSE event:', eventType);
                                    onEvent(eventType, data);
                                } catch (e) {
                                    console.warn('[AIDA/DAT] SSE: invalid JSON:', dataStr.slice(0, 200));
                                }
                            }
                            eventType = '';
                            dataStr = '';
                        }
                    }
                }
            } catch (err) {
                if (signal.aborted) break;
                retries++;
                console.warn(`[AIDA/DAT] SSE: error (retry ${retries}/${MAX_RETRIES}):`, err.message);
                await new Promise(r => setTimeout(r, BASE_DELAY * retries));
            }
        }

        if (!signal.aborted) {
            console.log('[AIDA/DAT] SSE: stream ended, searchId:', searchId);
        }
    })();

    return { stop: unsubscribeLiveQuery };
}

function unsubscribeLiveQuery() {
    if (_sseAbortController) {
        console.log('[AIDA/DAT] SSE: unsubscribing from', _sseSearchId);
        _sseAbortController.abort();
        _sseAbortController = null;
        _sseSearchId = null;
    }
}

const DatAdapter = {
    search, addToWorklist, updateWorklistStatus, removeFromWorklist,
    getDatPostingId, subscribeLiveQuery, unsubscribeLiveQuery
};
export default DatAdapter;
export { normalizeDatResults };
