import { getAiSettings } from '../auth/auth-ai.js';
import { CHAT_INSTRUCTION } from './prompts.js';
import { callAiModel } from './provider.js';

function ensureArray(value) {
  return Array.isArray(value) ? value : [];
}

export async function chat(message, context = {}) {
  const ai = await getAiSettings();
  if (!ai.enabled) {
    return { ok: true, skipped: true, reason: 'AI_DISABLED', reply: 'AI отключен в настройках.', actions: [] };
  }

  const response = await callAiModel({
    ai,
    timeoutMs: ai.timeoutMs || 12000,
    instruction: CHAT_INSTRUCTION,
    payload: {
      message: String(message || ''),
      context
    }
  });

  if (!response.ok) {
    return { ok: false, error: response.error, reply: 'AI сейчас недоступен.', actions: [] };
  }

  try {
    const parsed = JSON.parse(response.text);
    return {
      ok: true,
      reply: String(parsed.reply || ''),
      actions: ensureArray(parsed.actions)
    };
  } catch {
    return { ok: true, reply: response.text, actions: [] };
  }
}
