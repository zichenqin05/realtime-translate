const OFFSCREEN_URL = 'offscreen.html';
let creatingOffscreen;

function isCapturablePage(url) {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' || parsed.protocol === 'http:';
  } catch {
    return false;
  }
}

async function getState() {
  const { sessionState } = await chrome.storage.session.get('sessionState');
  return sessionState || { phase: 'idle' };
}

async function setState(state) {
  await chrome.storage.session.set({ sessionState: state });
  if (state.tabId) {
    chrome.tabs.sendMessage(state.tabId, { type: 'UI_STATE', state }).catch(() => {});
  }
  chrome.runtime.sendMessage({ type: 'UI_STATE', state }).catch(() => {});
}

async function hasOffscreen() {
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT'],
    documentUrls: [chrome.runtime.getURL(OFFSCREEN_URL)]
  });
  return contexts.length > 0;
}

async function ensureOffscreen() {
  if (await hasOffscreen()) return;
  if (!creatingOffscreen) {
    creatingOffscreen = chrome.offscreen.createDocument({
      url: OFFSCREEN_URL,
      reasons: ['USER_MEDIA', 'AUDIO_PLAYBACK'],
      justification: 'Capture and replay the selected tab audio while generating Chinese subtitles.'
    });
  }
  try {
    await creatingOffscreen;
  } finally {
    creatingOffscreen = undefined;
  }
}

async function createTranslationSecret(apiKey) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  try {
    const response = await fetch('https://api.openai.com/v1/realtime/translations/client_secrets', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        session: {
          model: 'gpt-realtime-translate',
          audio: { output: { language: 'zh' } }
        }
      }),
      signal: controller.signal
    });
    if (response.status === 401) throw new Error('OpenAI API Key 无效。');
    if (response.status === 403) throw new Error('API 账户没有实时翻译模型的访问权限。');
    if (response.status === 429) throw new Error('API 请求受限或余额不足。');
    if (!response.ok) throw new Error(`OpenAI API 返回 HTTP ${response.status}。`);
    const result = await response.json();
    if (!result.value) throw new Error('API 未返回实时会话凭证。');
    return result.value;
  } catch (error) {
    if (controller.signal.aborted) throw new Error('连接 OpenAI API 超时。');
    if (error instanceof TypeError) throw new Error('连接 OpenAI API 失败，请检查网络。');
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

async function start() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id || !isCapturablePage(tab.url)) {
    throw new Error('请先切换到普通网站的视频标签页。');
  }
  const previous = await getState();
  if (['starting', 'active', 'processing'].includes(previous.phase)) {
    if (previous.tabId === tab.id) return { ok: true };
    throw new Error('已有一个标签页正在翻译，请先停止。');
  }

  const sessionId = crypto.randomUUID();
  const initial = { phase: 'starting', tabId: tab.id, sessionId };
  await setState(initial);
  try {
    try {
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] });
    } catch {
      throw new Error('无法在这个网页显示字幕，请换一个普通视频网站。');
    }
    await chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
    const { openaiApiKey } = await chrome.storage.local.get('openaiApiKey');
    if (!openaiApiKey?.trim()) throw new Error('请先在插件中填写 OpenAI API Key。');
    await ensureOffscreen();
    const clientSecret = await createTranslationSecret(openaiApiKey.trim());
    if ((await getState()).sessionId !== sessionId) throw new Error('翻译已停止。');
    const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tab.id });
    const result = await chrome.runtime.sendMessage({
      type: 'OFFSCREEN_START', streamId, clientSecret, tabId: tab.id, sessionId
    });
    if (!result?.ok) throw new Error(result?.error || '无法连接标签页音频');
    if ((await getState()).sessionId !== sessionId) return { ok: false, error: '翻译已停止。' };
    await setState({ ...initial, phase: 'active' });
    return { ok: true };
  } catch (error) {
    if ((await getState()).sessionId === sessionId) {
      await setState({ ...initial, phase: 'error', detail: error.message });
    }
    throw error;
  }
}

async function stop() {
  const state = await getState();
  if (await hasOffscreen()) {
    try {
      await chrome.runtime.sendMessage({ type: 'OFFSCREEN_STOP' });
    } catch {
      // The document may already have ended with the captured tab.
    }
    await chrome.offscreen.closeDocument().catch(() => {});
  }
  await setState({ phase: 'idle', tabId: state.tabId });
  return { ok: true };
}

async function onOffscreenEvent(message) {
  const state = await getState();
  if (!state.sessionId || state.sessionId !== message.sessionId) return;

  if (message.kind === 'caption') {
    const caption = { chinese: message.chinese || '' };
    const next = { ...state, phase: 'active', lastCaption: caption };
    await setState(next);
    chrome.tabs.sendMessage(state.tabId, { type: 'CAPTION', caption }).catch(() => {});
  } else if (message.kind === 'processing') {
    await setState({ ...state, phase: 'processing' });
  } else if (message.kind === 'active') {
    await setState({ ...state, phase: 'active' });
  } else if (message.kind === 'error') {
    await stop();
    await setState({ phase: 'error', tabId: state.tabId, detail: message.detail || '采集已结束' });
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'GET_STATE') {
    getState().then(sendResponse).catch((error) => sendResponse({ phase: 'error', detail: error.message }));
    return true;
  }
  if (message.type === 'START' && !sender.tab) {
    start().then(sendResponse).catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }
  if (message.type === 'STOP' && !sender.tab) {
    stop().then(sendResponse).catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }
  if (message.type === 'OFFSCREEN_EVENT' && sender.url === chrome.runtime.getURL(OFFSCREEN_URL)) {
    onOffscreenEvent(message).catch(() => {});
  }
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
  if ((await getState()).tabId === tabId) await stop();
});

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo) => {
  if (changeInfo.status !== 'loading') return;
  const state = await getState();
  if (state.tabId === tabId && ['starting', 'active', 'processing'].includes(state.phase)) {
    await stop();
  }
});
