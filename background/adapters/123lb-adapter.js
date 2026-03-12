/**
 * AIDA v0.1 — 123LoadBoard Adapter (автономный)
 *
 * Полностью автономный адаптер — чёрный ящик.
 * Принимает params → возвращает { ok, loads[], meta }.
 * Auth через Auth123LB (cookie-based сессия).
 *
 * API: REST JSON на members.123loadboard.com/api/
 * Поиск: POST /api/loads/search
 * Детали: GET /api/loads/{id}?fields=...&onlineOnly=true
 * Refresh: POST с type:"Refresh" + nextToken
 *
 * §19 ТЗ
 */

import Auth123LB from '../auth/auth-123lb.js';
import { getApiHeaders } from '../auth/auth-123lb.js';

// ============================================================
// Equipment mapping: AIDA UI value → 123LB API string
// §19.4 ТЗ
// ============================================================

const EQUIP_TO_123LB = {
    'VAN': 'Van',
    'REEFER': 'Reefer',
    'FLATBED': 'Flatbed',
    'STEPDECK': 'StepDeck',
    'DOUBLEDROP': 'DoubleDrop',
    'LOWBOY': 'LowBoy',
    'RGN': 'RemovableGooseneck',
    'HOPPER': 'HopperBottom',
    'TANKER': 'Tanker',
    'POWERONLY': 'PowerOnly',
    'CONTAINER': 'Container',
    'DUMP': 'DumpTruck',
    'AUTOCARRIER': 'Auto',
    'LANDOLL': 'Landoll',
    'MAXI': 'Maxi',
};

// Обратный маппинг: 123LB → AIDA
const EQUIP_FROM_123LB = {};
for (const [aida, lb] of Object.entries(EQUIP_TO_123LB)) {
    EQUIP_FROM_123LB[lb] = aida;
}

/** Промежуточные типы, которых нет в AIDA — оставляем как есть. */
const EQUIP_DISPLAY = {
    'VAN': 'Van', 'REEFER': 'Reefer', 'FLATBED': 'Flatbed',
    'STEPDECK': 'Step Deck', 'DOUBLEDROP': 'Double Drop',
    'LOWBOY': 'Lowboy', 'RGN': 'RGN',
    'HOPPER': 'Hopper Bottom', 'TANKER': 'Tanker',
    'POWERONLY': 'Power Only', 'CONTAINER': 'Container',
    'DUMP': 'Dump Trailer', 'AUTOCARRIER': 'Auto Carrier',
    'LANDOLL': 'Landoll', 'MAXI': 'Maxi',
};

// ============================================================
// Helpers
// ============================================================

const API_BASE = 'https://members.123loadboard.com/api';

/** Маппинг equipment из params в 123LB формат. */
function mapEquipment(params) {
    if (!params.equipment || params.equipment.length === 0) {
        return ['Van']; // дефолт
    }
    const types = Array.isArray(params.equipment) ? params.equipment : [params.equipment];
    return types
        .map(t => EQUIP_TO_123LB[t])
        .filter(Boolean);
}

/** Маппинг одного 123LB equipment string → AIDA key. */
function mapEquipFromLB(lbType) {
    return EQUIP_FROM_123LB[lbType] || lbType;
}

/** Parse RFC 2822 date string → ISO date (YYYY-MM-DD). */
function parseRfcDate(rfcStr) {
    if (!rfcStr) return '';
    try {
        const d = new Date(rfcStr);
        if (isNaN(d.getTime())) return '';
        return d.toISOString().split('T')[0];
    } catch { return ''; }
}

/** Parse RFC 2822 date string → ISO datetime. */
function parseRfcDateTime(rfcStr) {
    if (!rfcStr) return '';
    try {
        const d = new Date(rfcStr);
        if (isNaN(d.getTime())) return '';
        return d.toISOString();
    } catch { return ''; }
}

// ============================================================
// Normalize: 123LB raw load → AIDA unified Load contract
// ============================================================

function normalizeLoad(raw) {
    const equipments = raw.equipments || [];
    const firstEquip = equipments[0]?.equipmentType || '';
    const aidaEquip = mapEquipFromLB(firstEquip);

    const rate = raw.rate?.amount || null;
    const miles = raw.computedMileage || null;
    const rpm = (rate && miles && miles > 0) ? Math.round((rate / miles) * 100) / 100 : null;

    const deadhead = raw.metadata?.userdata?.originDeadhead?.value || null;
    const deadheadRounded = deadhead != null ? Math.round(deadhead) : null;

    // Broker MC: poster.docketNumber.prefix + poster.docketNumber.number
    let mc = '';
    if (raw.poster?.docketNumber) {
        const dn = raw.poster.docketNumber;
        mc = dn.prefix && dn.number ? `${dn.prefix}${dn.number}` : (dn.number ? String(dn.number) : '');
    }

    // Pickup dates
    const pickupDates = raw.pickupDates || [];
    const pickupDate = pickupDates[0] || parseRfcDate(raw.pickupDateTime) || '';
    const pickupDateEnd = pickupDates.length > 1 ? pickupDates[pickupDates.length - 1] : '';

    // loadSize → fullPartial
    const fullPartial = raw.loadSize === 'TL' ? 'FULL' : (raw.loadSize === 'LTL' ? 'PARTIAL' : '');

    return {
        id: '123lb_' + raw.id,
        board: '123lb',
        externalId: raw.postReference || '',

        origin: {
            city: raw.originLocation?.address?.city || '',
            state: raw.originLocation?.address?.state || '',
            lat: raw.originLocation?.geolocation?.latitude || null,
            lng: raw.originLocation?.geolocation?.longitude || null,
        },
        destination: {
            city: raw.destinationLocation?.address?.city || '',
            state: raw.destinationLocation?.address?.state || '',
            lat: raw.destinationLocation?.geolocation?.latitude || null,
            lng: raw.destinationLocation?.geolocation?.longitude || null,
        },

        equipment: aidaEquip,
        equipmentName: EQUIP_DISPLAY[aidaEquip] || firstEquip,
        equipmentAll: equipments.map(e => mapEquipFromLB(e.equipmentType)),
        weight: raw.weight || null,
        length: raw.length || null,
        fullPartial,

        miles: miles ? Math.round(miles) : null,
        deadhead: deadheadRounded,
        rate,
        rpm,

        broker: {
            company: raw.poster?.name || '',
            phone: raw.dispatchPhone?.number || raw.poster?.phone?.number || '',
            phoneExt: '',
            email: raw.dispatchEmail || '',
            mc,
            dot: '',
            address: '',
            rating: null,
            daysToPay: null,
        },

        notes: raw.notes || raw.commodity || '',
        pickupDate,
        pickupDateEnd,
        postedAt: parseRfcDateTime(raw.created) || '',
        status: (raw.status === 'Online') ? 'active' : (raw.status || 'active'),
        bookNow: raw.canBookNow || false,
        factorable: false,
        raw: null,
    };
}

/** Нормализовать массив сырых грузов. */
function normalizeResults(rawLoads) {
    if (!Array.isArray(rawLoads)) return [];
    return rawLoads.map(normalizeLoad);
}

// ============================================================
// Detail fields для enrichment запроса
// ============================================================

const DETAIL_FIELDS = [
    'id', 'guid', 'status', 'computedMileage', 'age', 'created',
    'poster', 'rateCheck', 'metadata', 'postReference',
    'numberOfLoads', 'originLocation', 'destinationLocation',
    'pickupDateTime', 'pickupDateTimes', 'deliveryDateTime',
    'equipments', 'loadSize', 'length', 'weight', 'rate',
    'numberOfStops', 'commodity', 'notes',
    'dispatchPhone', 'dispatchName', 'dispatchEmail',
    'contactName', 'contactPhone', 'contactEmail',
    'pricePerMile', 'teamDriving', 'canBookNow',
    'posterMetadata', 'lastRefreshed', 'isDateRefreshed',
].join(',');

// ============================================================
// Adapter
// ============================================================

const LB_PAGE_SIZE = 50;

const LB123Adapter = {
    _lastParams: null,
    _onRealtimeUpdate: null,
    _nextToken: null,

    // ---- Unified Contract ----

    /**
     * Поиск грузов по параметрам.
     * POST /api/loads/search → normalize → enrich (batch details).
     */
    async search(params) {
        const session = await Auth123LB.getToken();
        if (!session) {
            return { error: { code: 'AUTH_REQUIRED', message: '123LB: login required' } };
        }

        this._lastParams = params;

        try {
            const headers = await getApiHeaders();
            const body = this._buildSearchBody(params);

            const resp = await fetch(`${API_BASE}/loads/search`, {
                method: 'POST',
                headers,
                body: JSON.stringify(body),
                credentials: 'include',
            });

            if (!resp.ok) {
                if (resp.status === 401 || resp.status === 403) {
                    return { error: { code: 'AUTH_REQUIRED', message: '123LB: session expired' } };
                }
                return { error: { code: 'API_ERROR', message: `123LB: HTTP ${resp.status}` } };
            }

            const data = await resp.json();
            const rawLoads = data.loads || [];
            this._nextToken = data.metadata?.nextToken || null;

            let loads = normalizeResults(rawLoads);

            // Enrich: batch GET /loads/{id} для phone, email, miles, notes
            if (loads.length > 0) {
                loads = await this._enrichLoads(loads, headers);
            }

            // Запускаем polling для realtime updates
            this._startPolling();

            const meta = {
                total: data.metadata?.totalResultCount || loads.length,
                isLastResult: data.metadata?.isLastResult ?? true,
                queryTime: data.metadata?.queryTime,
            };

            return { ok: true, loads, meta };

        } catch (e) {
            console.error('[AIDA/123LB] search error:', e);
            return { error: { code: 'NETWORK_ERROR', message: e.message } };
        }
    },

    /**
     * Построить тело запроса /loads/search из AIDA params.
     */
    _buildSearchBody(params) {
        const origin = params.origin || {};
        const dest = params.destination || {};
        const radius = params.radius || params.originRadius || 200;
        const destRadius = params.destRadius || params.destinationRadius || 0;

        const equipTypes = mapEquipment(params);

        // Pickup dates
        const pickupDates = [];
        // 123LB принимает массив дат в формате YYYY-MM-DD

        const body = {
            origin: {
                type: 'City',
                city: origin.city || '',
                states: origin.state ? [origin.state] : [],
                radius: parseInt(radius) || 200,
            },
            destination: dest.city ? {
                type: 'City',
                city: dest.city || '',
                states: dest.state ? [dest.state] : [],
                radius: parseInt(destRadius) || 150,
            } : {
                type: 'Anywhere',
                radius: 0,
            },
            equipmentTypes: equipTypes,
            metadata: {
                type: 'Regular',
                limit: LB_PAGE_SIZE,
                fields: 'all',
                sortBy: { field: 'Origin', direction: 'Ascending' },
            },
            pickupDates,
            includeLoadsWithoutLength: true,
            includeLoadsWithoutWeight: true,
            minWeight: 0,
            minLength: 0,
            company: { types: 'All' },
        };

        // Если есть координаты origin — добавляем
        if (origin.lat && origin.lng) {
            body.origin.latitude = origin.lat;
            body.origin.longitude = origin.lng;
        }

        // Если есть координаты destination — добавляем
        if (dest.lat && dest.lng) {
            body.destination.latitude = dest.lat;
            body.destination.longitude = dest.lng;
        }

        return body;
    },

    /**
     * Batch-обогащение: GET /loads/{id}?fields=... для каждого груза.
     * Добавляет: phone, email, miles, notes, address, canBookNow.
     */
    async _enrichLoads(loads, headers) {
        const BATCH_SIZE = 5; // параллельно не более 5
        const enriched = [...loads];

        for (let i = 0; i < enriched.length; i += BATCH_SIZE) {
            const batch = enriched.slice(i, i + BATCH_SIZE);
            const promises = batch.map(async (load) => {
                const rawId = load.id.replace('123lb_', '');
                try {
                    const resp = await fetch(
                        `${API_BASE}/loads/${rawId}?fields=${DETAIL_FIELDS}&onlineOnly=true`,
                        { method: 'GET', headers, credentials: 'include' }
                    );
                    if (!resp.ok) return null;
                    return await resp.json();
                } catch {
                    return null;
                }
            });

            const results = await Promise.all(promises);

            results.forEach((detail, idx) => {
                if (!detail) return;
                const load = enriched[i + idx];

                // Miles
                if (detail.computedMileage) {
                    load.miles = Math.round(detail.computedMileage);
                    if (load.rate && load.miles > 0) {
                        load.rpm = Math.round((load.rate / load.miles) * 100) / 100;
                    }
                }

                // Broker contact
                if (detail.dispatchPhone?.number) {
                    load.broker.phone = detail.dispatchPhone.number;
                }
                if (detail.dispatchEmail) {
                    load.broker.email = detail.dispatchEmail;
                }
                if (detail.contactPhone?.number && !load.broker.phone) {
                    load.broker.phone = detail.contactPhone.number;
                }
                if (detail.contactEmail && !load.broker.email) {
                    load.broker.email = detail.contactEmail;
                }

                // Broker address
                if (detail.poster?.address) {
                    const a = detail.poster.address;
                    load.broker.address = [a.city, a.state].filter(Boolean).join(', ');
                }
                if (detail.poster?.phone?.number && !load.broker.phone) {
                    load.broker.phone = detail.poster.phone.number;
                }

                // Notes (full)
                if (detail.notes) {
                    load.notes = detail.notes;
                } else if (detail.commodity && !load.notes) {
                    load.notes = detail.commodity;
                }

                // BookNow
                if (detail.canBookNow) {
                    load.bookNow = true;
                }
            });
        }

        return enriched;
    },

    // ============================================================
    // Realtime (polling via chrome.alarms)
    // ============================================================

    setRealtimeCallback(fn) {
        this._onRealtimeUpdate = fn;
    },

    _startPolling() {
        chrome.alarms.create('aida-123lb-refresh', { periodInMinutes: 2 });
    },

    _stopPolling() {
        chrome.alarms.clear('aida-123lb-refresh').catch(() => { });
    },

    stopRealtime() {
        this._stopPolling();
    },

    /**
     * Обработчик alarm — refresh поиск с последними params.
     * Использует type:"Refresh" + nextToken.
     */
    async handleAlarm() {
        if (!this._lastParams || !this._nextToken) return;

        const session = await Auth123LB.getToken();
        if (!session) return;

        try {
            const headers = await getApiHeaders();
            const body = {
                type: 'Refresh',
                fields: 'all',
                sortBy: { field: 'Origin', direction: 'Ascending' },
                nextToken: this._nextToken,
            };

            const resp = await fetch(`${API_BASE}/loads/search`, {
                method: 'POST',
                headers,
                body: JSON.stringify(body),
                credentials: 'include',
            });

            if (!resp.ok) return;

            const data = await resp.json();
            this._nextToken = data.metadata?.nextToken || this._nextToken;

            const newLoads = data.loads || [];
            const refreshedLoads = data.refreshedLoads || [];

            if (newLoads.length > 0 || refreshedLoads.length > 0) {
                const allNew = [...newLoads, ...refreshedLoads];
                let loads = normalizeResults(allNew);

                if (loads.length > 0) {
                    loads = await this._enrichLoads(loads, headers);
                }

                if (this._onRealtimeUpdate) {
                    this._onRealtimeUpdate('123lb', loads);
                }
            }
        } catch (e) {
            console.warn('[AIDA/123LB] refresh error:', e.message);
        }
    },

    // ============================================================
    // Status / Login / Disconnect — через Auth123LB
    // ============================================================

    async getStatus() {
        return Auth123LB.getStatus();
    },

    async login() {
        return Auth123LB.login();
    },

    async silentRefresh() {
        return Auth123LB.silentRefresh();
    },

    async disconnect() {
        this._stopPolling();
        this._lastParams = null;
        this._nextToken = null;
        return Auth123LB.disconnect();
    },

    async getToken() {
        return Auth123LB.getToken();
    },
};

export default LB123Adapter;
export { normalizeResults, EQUIP_TO_123LB, EQUIP_FROM_123LB };
