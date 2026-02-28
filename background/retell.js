/**
 * AIDA v0.1 — Retell
 * Блок коммуникаций: звонки через Retell AI, генерация email.
 *
 * API:
 *   Retell.initiateCall(phone, context)  → создаёт звонок через Retell AI
 *   Retell.generateEmail(load, dispatcher) → генерирует email брокеру
 *
 * Падение этого блока не влияет на поиск грузов.
 */

import Storage from './storage.js';

const RETELL_API_BASE = 'https://api.retellai.com/v2';

// ============================================================
// Initiate Call
// ============================================================

/**
 * Инициирует звонок брокеру через Retell AI.
 * @param {string} phone - номер телефона брокера (+1xxx)
 * @param {Object} context - контекст груза для голосового агента
 * @returns {Promise<{ok: boolean, callId?: string, error?: string}>}
 */
async function initiateCall(phone, context) {
    const settings = await Storage.getSettings();
    const { retellApiKey, retellFromNumber, retellAgentId } = settings.user || {};

    if (!retellApiKey) {
        return { ok: false, error: 'Retell API key not configured' };
    }
    if (!retellFromNumber) {
        return { ok: false, error: 'Retell from_number not configured' };
    }

    const body = {
        from_number: retellFromNumber,
        to_number: phone,
        metadata: {
            loadId: context.id,
            board: context.board,
            broker: context.broker?.name,
            origin: `${context.origin?.city}, ${context.origin?.state}`,
            destination: `${context.destination?.city}, ${context.destination?.state}`,
            equipment: context.equipment,
            rate: context.rate,
            miles: context.miles,
            pickupDate: context.pickupDate
        }
    };

    // Если указан agent_id — добавляем
    if (retellAgentId) {
        body.agent_id = retellAgentId;
    }

    try {
        const resp = await fetch(`${RETELL_API_BASE}/create-phone-call`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${retellApiKey}`
            },
            body: JSON.stringify(body)
        });

        const json = await resp.json();

        if (resp.ok) {
            console.log('[AIDA/Retell] Call initiated:', json.call_id);
            return { ok: true, callId: json.call_id };
        } else {
            console.warn('[AIDA/Retell] Call failed:', resp.status, json);
            return { ok: false, error: json?.message || `HTTP ${resp.status}` };
        }
    } catch (e) {
        console.error('[AIDA/Retell] Network error:', e);
        return { ok: false, error: e.message };
    }
}

// ============================================================
// Generate Email
// ============================================================

/**
 * Генерирует email брокеру из данных карточки груза.
 * Используется когда у брокера есть email, но нет телефона.
 * @param {Object} load - нормализованная карточка груза
 * @param {Object} dispatcher - настройки диспетчера {name, phone, email, company}
 * @returns {{ to: string, subject: string, body: string }}
 */
function generateEmail(load, dispatcher) {
    const origin = `${load.origin?.city || ''} ${load.origin?.state || ''}`.trim();
    const dest = `${load.destination?.city || ''} ${load.destination?.state || ''}`.trim();
    const pickupFormatted = load.pickupDate
        ? new Date(load.pickupDate).toLocaleDateString('en-US', { month: 'long', day: 'numeric' })
        : 'TBD';

    const subject = [
        'Load inquiry:',
        origin,
        '->',
        dest,
        '|',
        load.equipment || 'TL',
        '|',
        pickupFormatted
    ].join(' ');

    const rateStr = load.rate ? `$${load.rate.toLocaleString()} posted` : 'rate TBD';

    const body = [
        `Hi ${load.broker?.name || 'there'},`,
        '',
        `I'm interested in your load:`,
        `  ${origin} → ${dest}`,
        `  Equipment: ${load.equipment || 'TL'}`,
        `  Pickup: ${pickupFormatted}`,
        `  Rate: ${rateStr}`,
        '',
        `Please contact me at ${dispatcher?.phone || ''} or reply to this email.`,
        '',
        dispatcher?.name || '',
        dispatcher?.company || ''
    ].filter(line => line !== undefined).join('\n');

    return {
        to: load.broker?.email || '',
        subject,
        body: body.trim()
    };
}

// ============================================================
// Handle Webhook — обработка call_ended от Retell
// ============================================================

/**
 * Обрабатывает webhook событие от Retell AI (call_ended и др.).
 * В Chrome Extension нельзя принимать входящие соединения, поэтому
 * webhook идёт через OpenClaw сервер → AIDA забирает статус при polling.
 *
 * @param {Object} event - { event, call_id, duration, transcript, metadata }
 * @returns {Object} Данные для обновления статуса загрузки
 */
function parseWebhookEvent(event) {
    if (!event || event.event !== 'call_ended') return null;

    return {
        callId: event.call_id,
        loadId: event.metadata?.loadId,
        duration: event.duration || 0,
        transcript: event.transcript || '',
        completedAt: new Date().toISOString()
    };
}

const Retell = {
    initiateCall,
    generateEmail,
    parseWebhookEvent
};

export default Retell;
