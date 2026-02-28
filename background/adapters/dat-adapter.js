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

// Маппинг типов оборудования из ТЗ → DAT коды
const EQUIPMENT_MAP = {
    'VAN': ['V', 'VA'],
    'REEFER': ['R', 'RA'],
    'FLATBED': ['F', 'FA', 'FT']
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
    await rateLimit();

    const token = await Storage.getToken('dat');
    if (!token) {
        console.warn('[AIDA/DAT] No token available');
        return [];
    }

    const body = buildGraphQLRequest(params);

    const resp = await fetch('https://freight.api.dat.com/one-web-bff/graphql', {
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
        console.warn('[AIDA/DAT] Search failed:', resp.status, text.slice(0, 200));
        return [];
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

    // Разные варианты структуры ответа DAT API
    const data = json?.data || json;
    const root =
        data?.freightSearchV4FindLoads ||
        data?.freightSearchFindLoads ||
        data?.findLoads ||
        data?.freightSearch ||
        data;
    let rawList = Array.isArray(root) ? root : (root?.results || root?.data || root?.edges?.map(e => e.node) || []);
    if (!Array.isArray(rawList)) rawList = [];

    const results = rawList.filter(r => r && typeof r === 'object').map(r => normalize(r)).filter(Boolean);
    if (rawList.length > 0 && results.length === 0) {
        console.warn('[AIDA/DAT] No items normalized, sample raw:', JSON.stringify(rawList[0]).slice(0, 300));
    }
    return results;
}

// ============================================================
// GraphQL Query Builder
// ============================================================

function buildGraphQLRequest(params) {
    const eqCodes = EQUIPMENT_MAP[params.equipment] || ['V'];

    const originInput = {
        city: params.origin?.city,
        stateProv: params.origin?.state,
        postalCode: params.origin?.zip
    };

    // Убираем пустые поля
    Object.keys(originInput).forEach(k => !originInput[k] && delete originInput[k]);

    if (params.radius) {
        originInput.area = { deadheadMiles: params.radius };
    }

    const variables = {
        request: {
            origin: originInput,
            equipmentTypes: eqCodes,
            pickupDates: params.dateFrom ? {
                earliest: params.dateFrom,
                latest: params.dateTo || params.dateFrom
            } : undefined,
            count: 100,
            start: 0
        }
    };

    if (params.destination?.city || params.destination?.state) {
        variables.request.destination = {
            city: params.destination.city,
            stateProv: params.destination.state,
            postalCode: params.destination.zip
        };
        // Убираем пустые поля
        Object.keys(variables.request.destination).forEach(
            k => !variables.request.destination[k] && delete variables.request.destination[k]
        );
    }

    return {
        operationName: 'freightSearchV4FindLoads',
        variables,
        query: DAT_GRAPHQL_QUERY
    };
}

// GraphQL query — структура из анализа network traffic DAT One
// Основные поля нормализованы из example/content/dat-interceptor.js
const DAT_GRAPHQL_QUERY = `
query freightSearchV4FindLoads($request: FreightSearchV4Request!) {
  freightSearchV4FindLoads(request: $request) {
    results {
      resultId
      assetInfo {
        postingId
        origin {
          city
          stateProv
          postalCode
        }
        destination {
          city
          stateProv
          postalCode
        }
        equipmentType
        capacity {
          fullPartial
          maximumWeightPounds
          maximumLengthFeet
        }
        tripLength {
          miles
        }
      }
      posterInfo {
        companyName
        credit {
          creditScore
          daysToPay
        }
        contact {
          phone {
            number
            extension
          }
          email
        }
      }
      rateInfo {
        bookable {
          rateUsd
          basis
        }
        nonBookable {
          rateUsd
          basis
        }
      }
      availability {
        earliestWhen
        latestWhen
      }
      postedAt
    }
    totalCount
  }
}
`.trim();

// ============================================================
// Normalize — приведение к стандартному формату AIDA
// ============================================================

function normalize(raw) {
    if (!raw || typeof raw !== 'object') return null;
    // Некоторые версии API возвращают объект в обёртке
    const item = raw.assetInfo ? raw : (raw.posting || raw.load || raw);
    const ai = item.assetInfo || item;
    const pi = item.posterInfo || raw.posterInfo || {};
    const ri = item.rateInfo || raw.rateInfo || {};
    const cap = ai.capacity || {};
    const origin = ai.origin || {};
    const dest = ai.destination || {};
    const contact = pi.contact || {};
    const phone = contact?.phone && typeof contact.phone === 'object' ? contact.phone : { number: contact?.phone || '' };
    const credit = pi.credit || {};
    const tripLen = ai.tripLength || {};

    const rateObj = ri.bookable?.rateUsd ? ri.bookable : ri.nonBookable || {};
    const rateUsd = rateObj.rateUsd ?? (typeof ri.rateUsd === 'number' ? ri.rateUsd : null);
    const miles = tripLen.miles ?? (typeof ai.tripLength === 'number' ? ai.tripLength : null);

    const eqCode = ai.equipmentType || '';

    return {
        id: `dat_${ai.postingId || raw.resultId || raw.postingId || Math.random().toString(36).slice(2)}`,
        board: 'dat',
        origin: {
            city: origin.city || '',
            state: origin.stateProv || '',
            zip: origin.postalCode || ''
        },
        destination: {
            city: dest.city || '',
            state: dest.stateProv || '',
            zip: dest.postalCode || ''
        },
        equipment: EQ_NAMES[eqCode] || eqCode || 'Unknown',
        equipmentCode: eqCode,
        weight: cap.maximumWeightPounds || null,
        length: cap.maximumLengthFeet || null,
        fullPartial: cap.fullPartial || '',
        miles,
        rate: rateUsd,
        rpm: miles && rateUsd ? Math.round((rateUsd / miles) * 100) / 100 : null,
        broker: {
            name: pi.companyName || '',
            phone: phone.number || '',
            email: contact.email || '',
            creditScore: credit.creditScore || null,
            daysToPay: credit.daysToPay || null
        },
        pickupDate: (raw.availability || item.availability)?.earliestWhen?.split?.('T')?.[0] || '',
        postedAt: raw.postedAt || item.postedAt || '',
        status: 'active',
        statusUpdatedAt: new Date().toISOString(),
        raw
    };
}

/** Нормализует сырой массив результатов поиска DAT (из перехвата ответа страницы). */
function normalizeDatResults(rawList) {
    return (rawList || []).filter(r => r && typeof r === 'object').map(r => normalize(r)).filter(Boolean);
}

const DatAdapter = { search };
export default DatAdapter;
export { normalizeDatResults };
