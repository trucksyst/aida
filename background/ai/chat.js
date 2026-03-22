import { getAiSettings } from '../auth/auth-ai.js';
import { CHAT_INSTRUCTION } from './prompts.js';
import { callAiModel } from './provider.js';

function ensureArray(value) {
  return Array.isArray(value) ? value : [];
}

/** Конвертирует историю чата в формат Vertex API contents[] */
function buildHistoryContents(history = []) {
  if (!Array.isArray(history) || history.length === 0) return [];
  return history.map(msg => ({
    role: msg.role === 'user' ? 'user' : 'model',
    parts: [{ text: msg.text }]
  }));
}

export async function chat(message, context = {}) {
  const ai = await getAiSettings();
  if (!ai.enabled) {
    return { ok: true, skipped: true, reason: 'AI_DISABLED', reply: 'AI отключен в настройках.', actions: [] };
  }

  const historyContents = buildHistoryContents(context.history || []);

  const response = await callAiModel({
    ai,
    timeoutMs: ai.timeoutMs || 45000,
    instruction: CHAT_INSTRUCTION,
    payload: {
      message: String(message || ''),
      context: { lastSearch: context.lastSearch, loads: context.loads || [] }
    },
    historyContents
  });

  if (!response.ok) {
    return { ok: false, error: response.error, reply: 'AI сейчас недоступен.', actions: [] };
  }

  try {
    const cleaned = stripMarkdownJson(response.text);
    const parsed = JSON.parse(cleaned);
    return {
      ok: true,
      reply: String(parsed.reply || ''),
      actions: ensureArray(parsed.actions)
    };
  } catch {
    // Если JSON.parse не удался — пробуем найти JSON внутри текста
    const jsonMatch = response.text.match(/\{[\s\S]*"reply"[\s\S]*\}/);
    if (jsonMatch) {
      try {
        const parsed = JSON.parse(jsonMatch[0]);
        return { ok: true, reply: String(parsed.reply || ''), actions: ensureArray(parsed.actions) };
      } catch { /* ignore */ }
    }
    return { ok: true, reply: response.text, actions: [] };
  }
}

/** Убрать markdown code fence если Gemini обернул ответ в ```json ... ``` */
function stripMarkdownJson(text) {
  if (!text) return text;
  let t = text.trim();
  // ```json\n{...}\n``` → {...}
  const fenceMatch = t.match(/^```(?:json)?\s*\n?([\s\S]*?)\n?\s*```$/);
  if (fenceMatch) return fenceMatch[1].trim();
  return t;
}
