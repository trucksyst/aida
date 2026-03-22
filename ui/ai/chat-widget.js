import { renderChatLoadCards } from './load-card-renderer.js';

let chatHistory = [];

function saveChatHistory() {
  try {
    chrome.storage.local.set({ 'ai:chatHistory': chatHistory.slice(-30) });
  } catch (e) { /* ignore */ }
}

const CHAT_PANEL_MIN_SIZE = {
  width: 300,
  height: 320
};

function isChatFloatingModeEnabled() {
  return window.innerWidth > 640;
}

function clampChatPanelRect(left, top, width, height) {
  const maxWidth = Math.max(CHAT_PANEL_MIN_SIZE.width, window.innerWidth - 16);
  const maxHeight = Math.max(CHAT_PANEL_MIN_SIZE.height, window.innerHeight - 16);
  const nextWidth = Math.min(Math.max(width, CHAT_PANEL_MIN_SIZE.width), maxWidth);
  const nextHeight = Math.min(Math.max(height, CHAT_PANEL_MIN_SIZE.height), maxHeight);
  const nextLeft = Math.min(Math.max(left, 8), Math.max(8, window.innerWidth - nextWidth - 8));
  const nextTop = Math.min(Math.max(top, 8), Math.max(8, window.innerHeight - nextHeight - 8));

  return {
    left: nextLeft,
    top: nextTop,
    width: nextWidth,
    height: nextHeight
  };
}

function resetChatPanelLayout(panel) {
  if (!panel) return;
  panel.style.left = '';
  panel.style.top = '';
  panel.style.width = '';
  panel.style.height = '';
}

function applyChatPanelRect(panel, rect) {
  if (!panel || !rect) return;
  panel.style.left = `${rect.left}px`;
  panel.style.top = `${rect.top}px`;
  panel.style.width = `${rect.width}px`;
  panel.style.height = `${rect.height}px`;
}

function moveChatPanelToDefault(panel) {
  if (!panel || !panel.classList.contains('open') || !isChatFloatingModeEnabled()) return;

  resetChatPanelLayout(panel);
  const rect = panel.getBoundingClientRect();
  panel.classList.add('floating');
  applyChatPanelRect(panel, clampChatPanelRect(rect.left, rect.top, rect.width, rect.height));
}

function setupChatPanelInteractions(panel, header, resizeHandle) {
  if (!panel || !header || !resizeHandle) return;

  const beginPointerSession = (event, onMove) => {
    if (!isChatFloatingModeEnabled()) return;
    const pointerId = event.pointerId;

    const handlePointerMove = (moveEvent) => {
      if (moveEvent.pointerId !== pointerId) return;
      onMove(moveEvent);
    };

    const finishPointerSession = (finishEvent) => {
      if (finishEvent.pointerId !== pointerId) return;
      window.removeEventListener('pointermove', handlePointerMove);
      window.removeEventListener('pointerup', finishPointerSession);
      window.removeEventListener('pointercancel', finishPointerSession);
      document.body.classList.remove('chat-panel-dragging', 'chat-panel-resizing');
    };

    window.addEventListener('pointermove', handlePointerMove);
    window.addEventListener('pointerup', finishPointerSession);
    window.addEventListener('pointercancel', finishPointerSession);
  };

  header.addEventListener('pointerdown', (event) => {
    if (event.button !== 0 || !panel.classList.contains('open') || !isChatFloatingModeEnabled()) return;
    if (event.target instanceof Element && event.target.closest('button')) return;

    const rect = panel.getBoundingClientRect();
    const shiftX = event.clientX - rect.left;
    const shiftY = event.clientY - rect.top;
    document.body.classList.add('chat-panel-dragging');
    event.preventDefault();

    beginPointerSession(event, (moveEvent) => {
      applyChatPanelRect(panel, clampChatPanelRect(
        moveEvent.clientX - shiftX,
        moveEvent.clientY - shiftY,
        panel.offsetWidth,
        panel.offsetHeight
      ));
    });
  });

  resizeHandle.addEventListener('pointerdown', (event) => {
    if (event.button !== 0 || !panel.classList.contains('open') || !isChatFloatingModeEnabled()) return;

    const rect = panel.getBoundingClientRect();
    const startWidth = rect.width;
    const startHeight = rect.height;
    const startLeft = rect.left;
    const startTop = rect.top;
    const startX = event.clientX;
    const startY = event.clientY;

    document.body.classList.add('chat-panel-resizing');
    event.preventDefault();

    beginPointerSession(event, (moveEvent) => {
      applyChatPanelRect(panel, clampChatPanelRect(
        startLeft,
        startTop,
        startWidth + (moveEvent.clientX - startX),
        startHeight + (moveEvent.clientY - startY)
      ));
    });
  });

  window.addEventListener('resize', () => {
    if (!panel.classList.contains('open')) return;
    if (!isChatFloatingModeEnabled()) {
      panel.classList.remove('floating');
      resetChatPanelLayout(panel);
      return;
    }

    if (!panel.classList.contains('floating')) {
      moveChatPanelToDefault(panel);
      return;
    }

    const rect = panel.getBoundingClientRect();
    applyChatPanelRect(panel, clampChatPanelRect(rect.left, rect.top, rect.width, rect.height));
  });
}

function addChatMessage(textRole, text) {
  const wrap = document.getElementById('ai-chat-messages');
  if (!wrap) return;
  const node = document.createElement('div');
  node.className = `ai-msg ${textRole}`;
  node.textContent = text;
  wrap.appendChild(node);
  wrap.scrollTop = wrap.scrollHeight;
  // Сохраняем в историю (последние 30 сообщений)
  chatHistory.push({ role: textRole === 'user' ? 'user' : 'assistant', text });
  if (chatHistory.length > 30) chatHistory.splice(0, chatHistory.length - 30);
  saveChatHistory();
}

function appendChatNode(node) {
  const wrap = document.getElementById('ai-chat-messages');
  if (!wrap || !node) return;
  wrap.appendChild(node);
  wrap.scrollTop = wrap.scrollHeight;
}

function showThinking() {
  hideThinking();
  const wrap = document.getElementById('ai-chat-messages');
  if (!wrap) return;
  const el = document.createElement('div');
  el.className = 'ai-msg assistant ai-thinking';
  el.innerHTML = '<span class="thinking-dots"><span>.</span><span>.</span><span>.</span></span> AI думает';
  el.id = 'ai-thinking-indicator';
  wrap.appendChild(el);
  wrap.scrollTop = wrap.scrollHeight;
}

function hideThinking() {
  const el = document.getElementById('ai-thinking-indicator');
  if (el) el.remove();
}

function clearChatMessages() {
  const wrap = document.getElementById('ai-chat-messages');
  if (!wrap) return;
  wrap.innerHTML = '';
  console.log('[AIDA/UI Chat] clearChatMessages');
}

function isOauthDeniedError(error) {
  return /did not approve access/i.test(String(error || ''));
}

async function connectAiOauth({ sendToCore, showToast, state, silent = false }) {
  console.log('[AIDA/UI Chat] connectAiOauth:start', { silent });
  const resp = await sendToCore('AI_AUTH_CONNECT');
  console.log('[AIDA/UI Chat] connectAiOauth:response', resp);
  state.chat.lastAuthError = resp?.error || '';
  if (resp?.ok) {
    if (!silent) showToast('OAuth connected');
  } else if (!silent) {
    showToast(resp?.error || 'OAuth connect failed', 'error');
  }
  await refreshAiStatus({ sendToCore });
  return !!resp?.ok;
}

async function ensureChatOnboarding(deps) {
  console.log('[AIDA/UI Chat] ensureChatOnboarding:start');
  return syncChatAuthUi({ ...deps, autoConnect: true });
}

async function syncChatAuthUi({ state, sendToCore, applySettings, autoConnect = false }) {
  const authWrap = document.getElementById('ai-chat-auth');
  const authText = document.getElementById('ai-chat-auth-text');
  if (!authWrap || !authText) return false;

  console.log('[AIDA/UI Chat] syncChatAuthUi:start', {
    autoConnect,
    onboardingTried: state.chat.onboardingTried
  });

  if (state.chat.authPending) {
    authWrap.style.display = '';
    authText.textContent = 'Ожидаю завершения входа через Google...';
    return false;
  }

  if (state.chat.authDenied) {
    authWrap.style.display = '';
    authText.textContent = 'Вход через Google отменен. Закройте и снова откройте чат для повтора.';
    return false;
  }

  if (autoConnect && !state.chat.onboardingTried) {
    state.chat.onboardingTried = true;
    state.chat.authPending = true;
    state.chat.lastAuthError = '';
    authWrap.style.display = '';
    authText.textContent = 'Подключаю Google авторизацию...';
    addChatMessage('assistant', 'Открываю вход через Google...');
    console.log('[AIDA/UI Chat] syncChatAuthUi:autoConnect:before-connect');
    const ok = await connectAiOauth({ sendToCore, showToast: () => { }, state, silent: true });
    state.chat.authPending = false;
    console.log('[AIDA/UI Chat] syncChatAuthUi:autoConnect:after-connect', { ok });
    if (ok) {
      state.chat.authDenied = false;
      const fresh = await sendToCore('GET_SETTINGS');
      console.log('[AIDA/UI Chat] syncChatAuthUi:autoConnect:fresh-settings', fresh);
      if (fresh?.settings) {
        state.settings = fresh.settings;
        applySettings(fresh.settings);
      }
      authWrap.style.display = 'none';
      addChatMessage('assistant', 'Вход выполнен. Можно отправлять запросы.');
      return true;
    }

    if (isOauthDeniedError(state.chat.lastAuthError)) {
      state.chat.authDenied = true;
      authText.textContent = 'Вход через Google отменен. Закройте и снова откройте чат для повтора.';
      addChatMessage('assistant', 'Вход через Google отменен. Для новой попытки заново откройте чат.');
    } else {
      const freshStatus = await sendToCore('GET_AI_STATUS');
      if (freshStatus?.status?.reason === 'OAUTH_CLIENT_ID_MISSING') {
        authText.textContent = 'Сервис авторизации временно недоступен.';
      } else {
        authText.textContent = 'Авторизация не завершена. Закройте и снова откройте чат для повтора.';
      }
    }
    return false;
  }

  const statusResp = await sendToCore('GET_AI_STATUS');
  const status = statusResp?.status;
  console.log('[AIDA/UI Chat] syncChatAuthUi:status', statusResp);

  if (!status) {
    authWrap.style.display = '';
    authText.textContent = 'Не удалось получить статус авторизации';
    return false;
  }

  if (status.online) {
    authWrap.style.display = 'none';
    return true;
  }

  authWrap.style.display = '';
  authText.textContent = 'Подключаю Google авторизацию...';
  return false;
}

function normalizeSearchParamsFromAction(actionParams = {}, deps) {
  const current = deps.getSearchParams();
  const params = actionParams || {};
  const originRaw = params.origin || params.from || current.origin;
  const destRaw = params.destination || params.dest || params.to || current.destination;

  const origin = typeof originRaw === 'string'
    ? deps.parseCityState(originRaw)
    : { city: originRaw?.city || current.origin.city, state: originRaw?.state || current.origin.state };

  const destination = typeof destRaw === 'string'
    ? deps.parseCityState(destRaw)
    : { city: destRaw?.city || current.destination.city, state: destRaw?.state || current.destination.state };

  const equipment = Array.isArray(params.equipment)
    ? params.equipment
    : (typeof params.equipment === 'string' && params.equipment ? [params.equipment] : current.equipment);

  return {
    ...current,
    origin,
    destination,
    radius: Number(params.radius || current.radius || 50),
    destRadius: Number(params.destRadius || current.destRadius || 150),
    equipment: equipment.map((item) => String(item).toUpperCase()),
    dateFrom: params.dateFrom || current.dateFrom,
    dateTo: params.dateTo || current.dateTo,
    maxWeight: Number(params.maxWeight || current.maxWeight || 0)
  };
}

function applySearchParamsToForm(params, deps) {
  deps.setVal('origin-city', deps.formatCityState(params.origin?.city || '', params.origin?.state || ''));
  deps.setVal('dest-city', deps.formatCityState(params.destination?.city || '', params.destination?.state || ''));
  deps.setVal('search-radius', params.radius || 50);
  deps.setVal('dest-radius', params.destRadius || 150);
  deps.setVal('date-from', params.dateFrom || deps.localDateStr());
  deps.setVal('date-to', params.dateTo || deps.localDateStr());
  deps.setVal('max-weight', params.maxWeight || '');
  if (Array.isArray(params.equipment) && params.equipment.length) {
    deps.setEquipmentChecked(params.equipment);
  }
  if (typeof deps.updatePresetDisplay === 'function') deps.updatePresetDisplay();
}

async function executeChatActions(actions = [], deps) {
  if (!Array.isArray(actions) || actions.length === 0) return;

  // --- show_loads: AI хочет показать конкретные грузы карточками ---
  const showAction = actions.find(a => (a?.type || '').toLowerCase() === 'show_loads');
  if (showAction && Array.isArray(showAction.loadIds) && showAction.loadIds.length > 0) {
    const idsSet = new Set(showAction.loadIds);
    const loadsToShow = (deps.state.loads || []).filter(l => idsSet.has(l.id));
    if (loadsToShow.length > 0) {
      renderChatLoadCards(loadsToShow, appendChatNode, loadsToShow.length);
    }
    return;
  }

  // --- search: AI запрос на поиск ---
  const searchAction = actions.find((action) => (action?.type || '').toLowerCase() === 'search');
  if (!searchAction) return;

  const params = normalizeSearchParamsFromAction(searchAction.params || {}, deps);
  if (!params.origin?.city && !params.origin?.state) {
    addChatMessage('assistant', 'Не смог определить origin для поиска. Уточните город отправки.');
    return;
  }

  const searchId = `ai_${Date.now()}`;
  const originLabel = [params.origin?.city, params.origin?.state].filter(Boolean).join(', ');
  const equipLabel = (params.equipment || []).join(', ') || 'VAN';
  addChatMessage('assistant', `🔎 Ищу ${equipLabel} из ${originLabel}...`);

  const resp = await deps.sendToCore('AI_SEARCH_LOADS', { params, searchId });

  if (resp?.error) {
    addChatMessage('assistant', `Ошибка поиска: ${resp.error}`);
    return;
  }

  const loads = Array.isArray(resp?.loads) ? resp.loads : [];

  // Обновить state.loads из Storage (там теперь и UI-грузы, и AI-грузы)
  const freshLoads = await deps.sendToCore('GET_LOADS');
  if (freshLoads?.loads) deps.state.loads = freshLoads.loads;

  addChatMessage('assistant', `Найдено: ${loads.length} грузов.`);
  renderChatLoadCards(loads, appendChatNode, 10);
}

async function sendChatPrompt(deps) {
  const input = document.getElementById('ai-chat-input');
  const sendBtn = document.getElementById('ai-chat-send');
  if (!input || !sendBtn) return;

  const text = input.value.trim();
  if (!text) return;

  console.log('[AIDA/UI Chat] sendChatPrompt:start', { text });

  let statusResp = await deps.sendToCore('GET_AI_STATUS');
  console.log('[AIDA/UI Chat] sendChatPrompt:initial-status', statusResp);
  if (!statusResp?.status?.online) {
    if (deps.state.chat.authPending) {
      addChatMessage('assistant', 'Сначала завершите вход через Google.');
      return;
    }
    if (deps.state.chat.authDenied) {
      addChatMessage('assistant', 'Вход через Google был отменен. Закройте и снова откройте чат для новой попытки.');
      return;
    }
    const ready = await ensureChatOnboarding(deps);
    statusResp = await deps.sendToCore('GET_AI_STATUS');
    console.log('[AIDA/UI Chat] sendChatPrompt:status-after-onboarding', { ready, statusResp });
    if (!ready || !statusResp?.status?.online) {
      addChatMessage('assistant', 'Сначала завершите вход через Google.');
      return;
    }
  }

  input.value = '';
  addChatMessage('user', text);

  sendBtn.disabled = true;
  showThinking();
  try {
    console.log('[AIDA/UI Chat] sendChatPrompt:AI_CHAT:request');
    const allLoads = Array.isArray(deps.state.loads) ? deps.state.loads : [];

    // Сжимаем грузы: только ключевые поля (~150 байт каждый вместо ~500)
    const compressedLoads = allLoads.map(l => ({
      id: l.id,
      o: l.origin ? `${l.origin.city||''},${l.origin.state||''}` : '',
      d: l.destination ? `${l.destination.city||''},${l.destination.state||''}` : '',
      r: l.rate || 0,
      rpm: l.rpm || 0,
      mi: l.miles || 0,
      w: l.weight || 0,
      eq: l.equipment || '',
      br: `${l.broker?.company||''}|${l.broker?.mc||''}`,
      n: (l.notes || '').slice(0, 80),
      dt: l.pickupDate || '',
      len: l.length || 0
    }));
    console.log('[AIDA/UI Chat] sendChatPrompt:context loads=', allLoads.length, 'compressed size=', JSON.stringify(compressedLoads).length);

    const resp = await deps.sendToCore('AI_CHAT', {
      message: `[loadsCount=${allLoads.length}] ${text}`,
      context: {
        lastSearch: deps.state.settings?.lastSearch || null,
        loads: compressedLoads,
        history: chatHistory.slice(-10)
      }
    });

    console.log('[AIDA/UI Chat] sendChatPrompt:AI_CHAT:response', resp);
    hideThinking();

    if (!resp) {
      addChatMessage('assistant', 'Нет ответа от AI. Попробуйте ещё раз.');
      return;
    }

    if (resp.error) {
      addChatMessage('assistant', `Ошибка AI: ${resp.error}`);
      return;
    }


    if (resp.reply) {
      addChatMessage('assistant', resp.reply);
    }

    await executeChatActions(resp.actions || [], deps);
  } catch (err) {
    console.error('[AIDA/UI Chat] sendChatPrompt:error', err);
    hideThinking();
    addChatMessage('assistant', 'AI временно недоступен. Попробуйте через несколько секунд.');
  } finally {
    sendBtn.disabled = false;
  }
}

export async function refreshAiStatus({ sendToCore }) {
  const statusEl = document.getElementById('ai-status-text');
  if (!statusEl) return;

  statusEl.textContent = 'Checking...';
  statusEl.style.color = 'var(--text-secondary)';

  const resp = await sendToCore('GET_AI_STATUS');
  const status = resp?.status;
  console.log('[AIDA/UI Chat] refreshAiStatus:response', resp);

  if (!status) {
    statusEl.textContent = 'Unavailable';
    statusEl.style.color = 'var(--danger)';
    return;
  }
  if (!status.enabled) {
    statusEl.textContent = 'Disabled';
    statusEl.style.color = 'var(--text-secondary)';
    return;
  }
  if (status.online) {
    statusEl.textContent = `Online (${status.provider || 'gemini'})`;
    statusEl.style.color = 'var(--success)';
    return;
  }

  statusEl.textContent = `Offline: ${status.reason || 'unknown'}`;
  statusEl.style.color = 'var(--danger)';
}

export function initAiChatWidget(deps) {
  const fab = document.getElementById('ai-chat-fab');
  const panel = document.getElementById('ai-chat-panel');
  const header = document.getElementById('ai-chat-header');
  const resizeHandle = document.getElementById('ai-chat-resize-handle');
  const clearBtn = document.getElementById('ai-chat-clear');
  const closeBtn = document.getElementById('ai-chat-close');
  const sendBtn = document.getElementById('ai-chat-send');
  const input = document.getElementById('ai-chat-input');
  if (!fab || !panel || !header || !resizeHandle || !clearBtn || !closeBtn || !sendBtn || !input) return;

  setupChatPanelInteractions(panel, header, resizeHandle);

  fab.addEventListener('click', async () => {
    console.log('[AIDA/UI Chat] fab:click');
    panel.classList.add('open');
    panel.setAttribute('aria-hidden', 'false');
    moveChatPanelToDefault(panel);
    deps.state.chat.opened = true;
    deps.state.chat.onboardingTried = false;
    deps.state.chat.authPending = false;
    deps.state.chat.authDenied = false;
    deps.state.chat.lastAuthError = '';

    // Всегда чистый старт — при закрытии чат очищается
    if (!document.getElementById('ai-chat-messages')?.children?.length) {
      addChatMessage('assistant', 'Привет. Я AI-помощник AIDA. Напишите запрос на поиск, например: "найди reefer из Chicago в Atlanta".');
    }

    const ready = await ensureChatOnboarding(deps);
    console.log('[AIDA/UI Chat] fab:ensureChatOnboarding:done', { ready });
    input.focus();
  });

  closeBtn.addEventListener('click', () => {
    if (document.activeElement === closeBtn) closeBtn.blur();
    panel.classList.remove('open');
    panel.classList.remove('floating');
    panel.setAttribute('aria-hidden', 'true');
    resetChatPanelLayout(panel);
    // Очищаем чат и AI-данные при закрытии
    clearChatMessages();
    chatHistory.length = 0;
    saveChatHistory();
    // Удаляем AI-грузы из Storage (searchId='ai_*'), UI-грузы не трогаем
    deps.sendToCore('CLEAR_AI_LOADS');
  });

  clearBtn.addEventListener('click', () => {
    clearChatMessages();
    chatHistory.length = 0;
    saveChatHistory();
    input.focus();
  });

  sendBtn.addEventListener('click', () => sendChatPrompt(deps));
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') sendChatPrompt(deps);
  });
}
