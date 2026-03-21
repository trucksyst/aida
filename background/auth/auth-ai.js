import Storage from '../storage.js';

const AI_LOG_PREFIX = '[AIDA/AI OAuth]';

function getManifestScopeKey() {
  const scopes = chrome.runtime.getManifest()?.oauth2?.scopes || [];
  return scopes.slice().sort().join(' ');
}

export function resolveClientId(ai = {}) {
  const fromSettings = String(ai.clientId || '').trim();
  if (fromSettings) return fromSettings;
  return String(chrome.runtime.getManifest()?.oauth2?.client_id || '').trim();
}

export async function getAiSettings() {
  const settings = await Storage.getSettings();
  return settings.ai || {};
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

export async function clearStoredToken(ai) {
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

export async function getValidAccessToken(ai, interactive = false) {
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

export async function getStatus() {
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

export async function connect() {
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

export async function disconnect() {
  const ai = await getAiSettings();
  await clearStoredToken(ai);
  return { ok: true };
}
