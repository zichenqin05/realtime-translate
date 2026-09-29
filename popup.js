const startButton = document.getElementById('start');
const stopButton = document.getElementById('stop');
const statusNode = document.getElementById('status');
const statusText = document.getElementById('statusText');
const apiKeyInput = document.getElementById('apiKey');
const keyState = document.getElementById('keyState');
const forgetKeyButton = document.getElementById('forgetKey');

function showState(state = { phase: 'idle' }) {
  const active = ['starting', 'active', 'processing'].includes(state.phase);
  startButton.hidden = active;
  stopButton.hidden = !active;
  const labels = {
    idle: '尚未开始',
    starting: '正在连接标签页音频…',
    active: '正在监听当前标签页',
    processing: '正在实时翻译…',
    error: state.detail || '发生错误，录制已停止'
  };
  statusText.textContent = labels[state.phase] || state.detail || state.phase;
  statusNode.dataset.phase = state.phase;
}

async function refresh() {
  try {
    showState(await chrome.runtime.sendMessage({ type: 'GET_STATE' }));
    const { openaiApiKey } = await chrome.storage.local.get('openaiApiKey');
    apiKeyInput.placeholder = openaiApiKey ? '已保存；更换时在这里粘贴新 Key' : '在这里粘贴 OpenAI API Key';
    keyState.textContent = openaiApiKey ? '已保存' : '未保存';
    keyState.dataset.saved = String(Boolean(openaiApiKey));
  } catch (error) {
    showState({ phase: 'error', detail: error.message });
  }
}

startButton.addEventListener('click', async () => {
  startButton.disabled = true;
  showState({ phase: 'starting' });
  try {
    const enteredKey = apiKeyInput.value.trim();
    if (enteredKey) {
      await chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
      await chrome.storage.local.set({ openaiApiKey: enteredKey });
      apiKeyInput.value = '';
    }
    const result = await chrome.runtime.sendMessage({ type: 'START' });
    if (!result?.ok) throw new Error(result?.error || '无法开始采集');
    await refresh();
  } catch (error) {
    showState({ phase: 'error', detail: error.message });
  } finally {
    startButton.disabled = false;
  }
});

forgetKeyButton.addEventListener('click', async () => {
  forgetKeyButton.disabled = true;
  try {
    await chrome.runtime.sendMessage({ type: 'STOP' });
    await chrome.storage.local.remove('openaiApiKey');
    apiKeyInput.value = '';
    await refresh();
    statusText.textContent = '已删除保存的 API Key';
  } catch (error) {
    showState({ phase: 'error', detail: error.message });
  } finally {
    forgetKeyButton.disabled = false;
  }
});

stopButton.addEventListener('click', async () => {
  stopButton.disabled = true;
  try {
    await chrome.runtime.sendMessage({ type: 'STOP' });
    await refresh();
  } catch (error) {
    showState({ phase: 'error', detail: error.message });
  } finally {
    stopButton.disabled = false;
  }
});

chrome.runtime.onMessage.addListener((message) => {
  if (message.type === 'UI_STATE') showState(message.state);
});

refresh();
