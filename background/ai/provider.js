import { clearStoredToken, getValidAccessToken } from '../auth/auth-ai.js';

const DEFAULT_VERTEX_MODEL = 'gemini-2.5-flash';

function normalizeVertexLocation(location) {
  const normalized = String(location || '').trim().toLowerCase();
  return normalized || 'global';
}

export function normalizeVertexModel(model) {
  const normalized = String(model || '').trim();
  if (!normalized) return DEFAULT_VERTEX_MODEL;
  if (normalized === 'gemini-2.0-flash' || normalized === 'gemini-2.0-flash-001') {
    return DEFAULT_VERTEX_MODEL;
  }
  return normalized;
}

export function normalizeAiForVertex(ai = {}) {
  if (!ai?.projectId) {
    return {
      ...ai,
      model: normalizeVertexModel(ai?.model)
    };
  }

  return {
    ...ai,
    location: 'global',
    model: normalizeVertexModel(ai.model)
  };
}

function buildVertexUrl(ai) {
  const normalizedAi = normalizeAiForVertex(ai);
  const location = normalizeVertexLocation(normalizedAi.location);
  const projectId = normalizedAi.projectId || '';
  const model = normalizeVertexModel(normalizedAi.model);
  const host = location === 'global'
    ? 'https://aiplatform.googleapis.com'
    : `https://${location}-aiplatform.googleapis.com`;
  return `${host}/v1/projects/${encodeURIComponent(projectId)}/locations/${encodeURIComponent(location)}/publishers/google/models/${encodeURIComponent(model)}:generateContent`;
}

function buildGeminiApiUrl(ai) {
  const model = normalizeVertexModel(ai.model);
  return `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
}

function buildAiUrl(ai) {
  if (ai.projectId) return buildVertexUrl(ai);
  return buildGeminiApiUrl(ai);
}

export async function callAiModel({ ai, timeoutMs, instruction, payload }) {
  const normalizedAi = normalizeAiForVertex(ai);
  const tokenResult = await getValidAccessToken(normalizedAi, false);
  if (!tokenResult.ok || !tokenResult.token) {
    return { ok: false, error: tokenResult.error || 'OAUTH_REQUIRED' };
  }
  const token = tokenResult.token;
  const runtimeAi = normalizeAiForVertex(tokenResult.ai || normalizedAi);
  const url = buildAiUrl(runtimeAi);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs || 12000);

  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`
      },
      body: JSON.stringify({
        systemInstruction: {
          parts: [{ text: instruction }]
        },
        generationConfig: {
          temperature: 0.2,
          topP: 0.9
        },
        contents: [{
          role: 'user',
          parts: [{ text: JSON.stringify(payload) }]
        }]
      }),
      signal: controller.signal
    });

    const json = await resp.json().catch(() => ({}));
    if (!resp.ok) {
      const errorMessage = json?.error?.message || `HTTP ${resp.status}`;
      if (/insufficient authentication scopes/i.test(errorMessage)) {
        await clearStoredToken(runtimeAi);
      }
      return { ok: false, error: errorMessage };
    }

    const text = json?.candidates?.[0]?.content?.parts?.map((part) => part?.text || '').join('\n').trim() || '';
    if (!text) {
      return { ok: false, error: 'Empty response from AI' };
    }

    return { ok: true, text };
  } catch (e) {
    return { ok: false, error: e.message };
  } finally {
    clearTimeout(timeout);
  }
}
