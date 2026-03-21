/**
 * AIDA v0.2 — AI Block (MVP)
 * Изолированный блок ИИ: включение/выключение, анализ грузов, чат-ответы.
 * При недоступности AI возвращает безопасный fallback без падения Core.
 */

import Storage from './storage.js';

const AI_LOG_PREFIX = '[AIDA/AI OAuth]';
const DEFAULT_VERTEX_MODEL = 'gemini-2.5-flash';

function getManifestScopeKey() {
  const scopes = chrome.runtime.getManifest()?.oauth2?.scopes || [];
  return scopes.slice().sort().join(' ');
}

function resolveClientId(ai = {}) {
  const fromSettings = String(ai.clientId || '').trim();
  if (fromSettings) return fromSettings;
  const fromManifest = String(chrome.runtime.getManifest()?.oauth2?.client_id || '').trim();
  return fromManifest;
}

function ensureArray(value) {
  return Array.isArray(value) ? value : [];
}

function normalizeVertexLocation(location) {
  const normalized = String(location || '').trim().toLowerCase();
  return normalized || 'global';
}

function normalizeAiForVertex(ai = {}) {
  if (!ai?.projectId) return ai;
  return {
    ...ai,
    location: 'global',
    model: normalizeVertexModel(ai.model)
  };
}

function normalizeVertexModel(model) {
  const normalized = String(model || '').trim();
  if (!normalized) return DEFAULT_VERTEX_MODEL;
  if (normalized === 'gemini-2.0-flash' || normalized === 'gemini-2.0-flash-001') {
    return DEFAULT_VERTEX_MODEL;
  }
  return normalized;
}

function requestChromeIdentityToken({ interactive }) {
  console.log(`${AI_LOG_PREFIX} getAuthToken:start`, {
    interactive,
    oauthClientId: chrome.runtime.getManifest()?.oauth2?.client_id || ''
  });

  return new Promise((resolve, reject) => {
    chrome.identity.getAuthToken({ interactive }, (token) => {
      if (chrome.runtime.lastError) {
        console.error(`${AI_LOG_PREFIX} getAuthToken:error`, chrome.runtime.lastError.message || 'getAuthToken error');
        reject(new Error(chrome.runtime.lastError.message || 'getAuthToken error'));
        return;
      }
      if (!token) {
        console.error(`${AI_LOG_PREFIX} getAuthToken:no-token`);
        reject(new Error('OAuth token missing'));
        return;
      }

      console.log(`${AI_LOG_PREFIX} getAuthToken:success`, {
        tokenPreview: `${token.slice(0, 12)}...`
      });
      resolve({ accessToken: token, expiresIn: 3600 });
    });
  });
}

async function getValidAccessToken(ai, interactive = false) {
  const clientId = resolveClientId(ai);
  const now = Date.now();
  const scopeKey = getManifestScopeKey();
  const scopeKeyMatches = ai.oauthScopeKey === scopeKey;
  console.log(`${AI_LOG_PREFIX} getValidAccessToken:start`, {
    interactive,
    hasClientId: !!clientId,
    clientIdSource: ai.clientId ? 'settings' : (chrome.runtime.getManifest()?.oauth2?.client_id ? 'manifest' : 'missing'),
    hasCachedToken: !!ai.oauthAccessToken,
    cachedTokenValid: !!(ai.oauthAccessToken && ai.oauthExpiresAt && now < (ai.oauthExpiresAt - 30000) && scopeKeyMatches),
    scopeKeyMatches
  });
  if (ai.oauthAccessToken && !scopeKeyMatches) {
    console.warn(`${AI_LOG_PREFIX} getValidAccessToken:scope-changed-clear-token`);
    ai = await clearStoredToken(ai);
  }
  if (ai.oauthAccessToken && ai.oauthExpiresAt && now < (ai.oauthExpiresAt - 30000) && ai.oauthScopeKey === scopeKey) {
    console.log(`${AI_LOG_PREFIX} getValidAccessToken:cached-token-used`);
    return { ok: true, token: ai.oauthAccessToken, ai };
  }
  if (!clientId) {
    console.error(`${AI_LOG_PREFIX} getValidAccessToken:missing-client-id`);
    return { ok: false, error: 'OAUTH_CLIENT_ID_MISSING' };
  }
  if (!interactive) {
    console.log(`${AI_LOG_PREFIX} getValidAccessToken:interactive-required`);
    return { ok: false, error: 'OAUTH_REQUIRED' };
  }

  try {
    const oauth = await requestChromeIdentityToken({ interactive });
    const expiresAt = Date.now() + Math.max(60, oauth.expiresIn || 3600) * 1000;
    const updatedAi = {
      ...ai,
      oauthAccessToken: oauth.accessToken,
      oauthExpiresAt: expiresAt,
      oauthScopeKey: scopeKey,
      oauthConnected: true,
      onboarded: true
    };
    await Storage.saveSettings({ ai: updatedAi });
    console.log(`${AI_LOG_PREFIX} getValidAccessToken:token-saved`, {
      expiresAt,
      hasToken: !!updatedAi.oauthAccessToken
    });
    return { ok: true, token: oauth.accessToken, ai: updatedAi };
  } catch (e) {
    console.error(`${AI_LOG_PREFIX} getValidAccessToken:failed`, e.message || 'OAUTH_REQUIRED');
    return { ok: false, error: e.message || 'OAUTH_REQUIRED' };
  }
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

async function getAiSettings() {
  const settings = await Storage.getSettings();
  return normalizeAiForVertex(settings.ai || {});
}

async function clearStoredToken(ai) {
  if (ai?.oauthAccessToken) {
    await new Promise((resolve) => {
      chrome.identity.removeCachedAuthToken({ token: ai.oauthAccessToken }, () => resolve());
    });
  }

  const updatedAi = {
    ...(ai || {}),
    oauthConnected: false,
    oauthAccessToken: '',
    oauthExpiresAt: 0
  };
  await Storage.saveSettings({ ai: updatedAi });
  return updatedAi;
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

async function callGemini({ ai, timeoutMs, instruction, payload }) {
  const normalizedAi = normalizeAiForVertex(ai);
  const tokenResult = await getValidAccessToken(normalizedAi, false);
  if (!tokenResult.ok || !tokenResult.token) {
    return { ok: false, error: tokenResult.error || 'OAUTH_REQUIRED' };
  }
  const token = tokenResult.token;

  const url = buildAiUrl(normalizeAiForVertex(tokenResult.ai || normalizedAi));

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs || 12000);

  try {
    console.log(`${AI_LOG_PREFIX} callGemini:request`, {
      url,
      model: normalizeVertexModel((tokenResult.ai || normalizedAi).model),
      location: normalizeVertexLocation((tokenResult.ai || normalizedAi).location),
      hasProjectId: !!(tokenResult.ai || normalizedAi).projectId
    });

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
        console.warn(`${AI_LOG_PREFIX} callGemini:clear-token-insufficient-scopes`);
        await clearStoredToken(normalizeAiForVertex(tokenResult.ai || normalizedAi));
      }
      return { ok: false, error: errorMessage };
    }

    const text = json?.candidates?.[0]?.content?.parts?.map(p => p?.text || '').join('\n').trim() || '';
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

async function getStatus() {
  const ai = await getAiSettings();
  const enabled = !!ai.enabled;
  const clientId = resolveClientId(ai);

  console.log(`${AI_LOG_PREFIX} getStatus:start`, {
    enabled,
    hasClientId: !!clientId,
    hasCachedToken: !!ai.oauthAccessToken,
    oauthExpiresAt: ai.oauthExpiresAt || 0
  });

  if (!enabled) {
    console.log(`${AI_LOG_PREFIX} getStatus:disabled`);
    return { enabled: false, online: false, provider: ai.provider || 'gemini', reason: 'AI_DISABLED' };
  }
  if (!clientId) {
    console.warn(`${AI_LOG_PREFIX} getStatus:missing-client-id`);
    return { enabled: true, online: false, provider: ai.provider || 'gemini', reason: 'OAUTH_CLIENT_ID_MISSING' };
  }

  const tokenResult = await getValidAccessToken(ai, false);
  if (!tokenResult.ok || !tokenResult.token) {
    console.warn(`${AI_LOG_PREFIX} getStatus:offline`, tokenResult.error || 'OAUTH_REQUIRED');
    return { enabled: true, online: false, provider: ai.provider || 'gemini', reason: 'OAUTH_REQUIRED' };
  }

  console.log(`${AI_LOG_PREFIX} getStatus:online`);
  return { enabled: true, online: true, provider: ai.provider || 'gemini', reason: null };
}

async function connect() {
  const ai = await getAiSettings();
  const clientId = resolveClientId(ai);
  console.log(`${AI_LOG_PREFIX} connect:start`, {
    hasClientId: !!clientId,
    aiEnabled: !!ai.enabled
  });
  if (!clientId) {
    console.error(`${AI_LOG_PREFIX} connect:missing-client-id`);
    return { ok: false, error: 'OAUTH_CLIENT_ID_MISSING' };
  }

  const tokenResult = await getValidAccessToken(ai, true);
  console.log(`${AI_LOG_PREFIX} connect:result`, {
    ok: !!tokenResult.ok,
    error: tokenResult.error || null
  });
  if (!tokenResult.ok) return { ok: false, error: tokenResult.error || 'OAUTH_CONNECT_FAILED' };
  return { ok: true };
}

async function disconnect() {
  const ai = await getAiSettings();
  await clearStoredToken(ai);
  return { ok: true };
}

async function analyzeLoads(loads = [], preferences = {}) {
  const ai = await getAiSettings();
  if (!ai.enabled) {
    return { ok: true, skipped: true, reason: 'AI_DISABLED', results: [] };
  }

  const inputLoads = ensureArray(loads).slice(0, 50).map(stringifyLoad);
  const instruction = 'You are a freight dispatch assistant. Return only valid JSON array. Each item: {id, score, reason, action}. score from 0 to 100. action one of: call,email,bookmark,skip.';
  const payload = { preferences, loads: inputLoads };

  const response = await callGemini({
    ai,
    timeoutMs: ai.timeoutMs || 12000,
    instruction,
    payload
  });

  if (!response.ok) {
    return { ok: false, error: response.error, results: [] };
  }

  try {
    const parsed = JSON.parse(response.text);
    const results = ensureArray(parsed).map(item => ({
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

async function chat(message, context = {}) {
  const ai = await getAiSettings();
  if (!ai.enabled) {
    return { ok: true, skipped: true, reason: 'AI_DISABLED', reply: 'AI отключен в настройках.', actions: [] };
  }

  const instruction = 'You are a freight assistant for dispatchers. Reply concise in Russian. If user asks to search/call/email/bookmark, return JSON object: {reply, actions[]} where actions contain {type, params}. Return valid JSON only.';
  const payload = {
    message: String(message || ''),
    context
  };

  const response = await callGemini({
    ai,
    timeoutMs: ai.timeoutMs || 12000,
    instruction,
    payload
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

const AIBlock = {
  connect,
  disconnect,
  getStatus,
  analyzeLoads,
  chat
};

export default AIBlock;
