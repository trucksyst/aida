import { getAiSettings } from '../auth/auth-ai.js';
import { ANALYZE_LOADS_INSTRUCTION } from './prompts.js';
import { callAiModel } from './provider.js';

function ensureArray(value) {
  return Array.isArray(value) ? value : [];
}

function stringifyLoad(load) {
  const origin = `${load.origin?.city || ''} ${load.origin?.state || ''}`.trim();
  const destination = `${load.destination?.city || ''} ${load.destination?.state || ''}`.trim();
  const rate = Number(load.rate || 0);
  const miles = Number(load.miles || 0);
  const rpm = miles > 0 ? (rate / miles).toFixed(2) : 'n/a';

  return {
    id: load.id,
    board: load.board,
    equipment: load.equipment,
    origin,
    destination,
    rate,
    miles,
    rpm
  };
}

export async function analyzeLoads(loads = [], preferences = {}) {
  const ai = await getAiSettings();
  if (!ai.enabled) {
    return { ok: true, skipped: true, reason: 'AI_DISABLED', results: [] };
  }

  const payload = {
    preferences,
    loads: ensureArray(loads).slice(0, 50).map(stringifyLoad)
  };

  const response = await callAiModel({
    ai,
    timeoutMs: ai.timeoutMs || 12000,
    instruction: ANALYZE_LOADS_INSTRUCTION,
    payload
  });

  if (!response.ok) {
    return { ok: false, error: response.error, results: [] };
  }

  try {
    const parsed = JSON.parse(response.text);
    const results = ensureArray(parsed).map((item) => ({
      id: item.id,
      score: Number(item.score || 0),
      reason: String(item.reason || ''),
      action: String(item.action || 'skip')
    }));
    return { ok: true, results };
  } catch {
    return { ok: false, error: 'AI returned non-JSON', raw: response.text, results: [] };
  }
}
