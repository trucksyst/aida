/**
 * AIDA v0.1 — Truckstop Adapter
 * Адаптер для Truckstop (truckstop.com).
 * REST API запросы из background.js с ручными Origin/Referer заголовками.
 *
 * Rate limit: 1 запрос / 2 секунды.
 *
 * NOTE: Точные endpoint URL и структура request body захватываются из
 * DevTools Network при реальном поиске на truckstop.com:
 *   1. DevTools → Network → фильтр "api" или "search"
 *   2. Найти POST запрос поиска грузов
 *   3. Скопировать Request URL, Headers, Request Body
 */

import Storage from '../storage.js';

// ============================================================
// Equipment mapping — Truckstop коды
// ============================================================
const EQUIPMENT_MAP = {
    'VAN': 'Van',
    'REEFER': 'Reefer',
    'FLATBED': 'Flatbed'
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
 * Основной метод поиска грузов через Truckstop REST API.
 * @param {Object} params - { origin: {city, state, zip}, destination: {city, state, zip},
 *                           radius: number, equipment: string, dateFrom: string, dateTo: string }
 * @returns {Promise<Load[]>}
 */
async function search(params) {
    await rateLimit();

    const token = await Storage.getToken('truckstop');
    if (!token) {
        console.warn('[AIDA/Truckstop] No token available');
        return [];
    }

    const body = buildSearchRequest(params);

    // Truckstop REST API endpoint (уточнить из DevTools)
    const resp = await fetch('https://api.truckstop.com/api/v2/loads/search', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${token}`,
            'Origin': 'https://www.truckstop.com',
            'Referer': 'https://www.truckstop.com/'
        },
        body: JSON.stringify(body)
    });

    if (!resp.ok) {
        console.warn('[AIDA/Truckstop] Search failed:', resp.status);
        return [];
    }

    const json = await resp.json();

    // Truckstop возвращает массив грузов (уточнить структуру из DevTools)
    const results = json?.loads || json?.data?.loads || json?.results || json || [];
    if (!Array.isArray(results)) return [];

    return results.map(r => normalize(r));
}

// ============================================================
// Request Builder
// ============================================================

function buildSearchRequest(params) {
    // Структура request body — уточнить из DevTools Network
    // Это базовый шаблон, который нужно подкорректировать под реальный API
    return {
        origin: {
            city: params.origin?.city || '',
            state: params.origin?.state || '',
            zipCode: params.origin?.zip || '',
            radius: params.radius || 50
        },
        destination: params.destination ? {
            city: params.destination.city || '',
            state: params.destination.state || '',
            zipCode: params.destination.zip || ''
        } : undefined,
        equipmentTypes: [EQUIPMENT_MAP[params.equipment] || params.equipment],
        pickupDateStart: params.dateFrom || undefined,
        pickupDateEnd: params.dateTo || undefined,
        pageSize: 100,
        pageNumber: 1
    };
}

// ============================================================
// Normalize — приведение к стандартному формату AIDA
// ============================================================

function normalize(raw) {
    // Структура ответа Truckstop — уточнить из DevTools
    // Это базовое маппирование под типичные REST-поля Truckstop

    const origin = raw.origin || raw.pickupLocation || {};
    const dest = raw.destination || raw.deliveryLocation || {};
    const broker = raw.broker || raw.shipper || raw.contact || {};

    const rateUsd = raw.rate || raw.totalRate || raw.rateAmount || null;
    const miles = raw.distance || raw.mileage || raw.miles || null;

    return {
        id: `ts_${raw.id || raw.loadId || raw.loadNumber || Math.random().toString(36).slice(2)}`,
        board: 'truckstop',
        origin: {
            city: origin.city || '',
            state: origin.state || origin.stateCode || '',
            zip: origin.zipCode || origin.zip || ''
        },
        destination: {
            city: dest.city || '',
            state: dest.state || dest.stateCode || '',
            zip: dest.zipCode || dest.zip || ''
        },
        equipment: raw.equipmentType || raw.equipment || '',
        equipmentCode: raw.equipmentCode || raw.equipmentTypeCode || '',
        weight: raw.weight || raw.maxWeight || null,
        length: raw.length || raw.trailerLength || null,
        fullPartial: raw.fullPartial || raw.loadType || '',
        miles,
        rate: rateUsd,
        rpm: miles && rateUsd ? Math.round((rateUsd / miles) * 100) / 100 : null,
        broker: {
            name: broker.companyName || broker.name || '',
            phone: broker.phone || broker.phoneNumber || '',
            email: broker.email || broker.emailAddress || '',
            creditScore: broker.creditScore || raw.creditScore || null,
            daysToPay: broker.daysToPay || raw.daysToPay || null
        },
        pickupDate: raw.pickupDate || raw.earliestPickupDate || '',
        postedAt: raw.postedAt || raw.createdAt || raw.postDate || '',
        status: 'active',
        statusUpdatedAt: new Date().toISOString(),
        raw
    };
}

const TruckstopAdapter = { search };
export default TruckstopAdapter;
