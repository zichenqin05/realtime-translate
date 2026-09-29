const CALLS_ENDPOINT = 'https://api.openai.com/v1/realtime/translations/calls';
let stream;
let audioContext;
let peer;
let events;
let connectController;
let captionTimer;
let active = false;
let sessionId;
let translatedText = '';
let lastDeltaAt = 0;

function emit(kind, extra = {}) {
  chrome.runtime.sendMessage({ type: 'OFFSCREEN_EVENT', sessionId, kind, ...extra }).catch(() => {});
}

async function stopCapture() {
  active = false;
  clearTimeout(captionTimer);
  captionTimer = undefined;
  connectController?.abort();
  connectController = undefined;
  events?.close();
  events = undefined;
  peer?.close();
  peer = undefined;
  stream?.getTracks().forEach((track) => track.stop());
  stream = undefined;
  if (audioContext) await audioContext.close().catch(() => {});
  audioContext = undefined;
  translatedText = '';
  lastDeltaAt = 0;
  sessionId = undefined;
}

async function fail(message) {
  if (!active) return;
  emit('error', { detail: message });
  await stopCapture();
}

function appendTranslation(delta, capturedSession) {
  if (!active || capturedSession !== sessionId || !delta) return;
  if (Date.now() - lastDeltaAt > 5000) translatedText = '';
  lastDeltaAt = Date.now();
  translatedText += delta;
  if (translatedText.length > 100) {
    const boundary = Math.max(
      translatedText.lastIndexOf('。', translatedText.length - 60),
      translatedText.lastIndexOf('！', translatedText.length - 60),
      translatedText.lastIndexOf('？', translatedText.length - 60),
      translatedText.lastIndexOf('\n', translatedText.length - 60)
    );
    translatedText = translatedText.slice(boundary >= 0 ? boundary + 1 : -100);
  }
  if (captionTimer) return;
  captionTimer = setTimeout(() => {
    captionTimer = undefined;
    if (active && capturedSession === sessionId) {
      emit('caption', { chinese: translatedText.trim() });
    }
  }, 120);
}

function onTranslationEvent(raw, capturedSession) {
  if (!active || capturedSession !== sessionId) return;
  let event;
  try {
    event = JSON.parse(raw);
  } catch {
    return;
  }
  if (event.type === 'session.output_transcript.delta') {
    appendTranslation(event.delta, capturedSession);
  } else if (event.type === 'error') {
    fail('实时翻译服务返回错误，请检查 API 账户和网络。');
  } else if (event.type === 'session.closed') {
    fail('实时翻译会话已结束。');
  }
}

function waitForChannel(channel) {
  return new Promise((resolve, reject) => {
    if (channel.readyState === 'open') return resolve();
    if (channel.readyState === 'closed') return reject(new Error('实时连接已关闭。'));
    const timeout = setTimeout(() => finish(new Error('实时连接超时。')), 15000);
    function finish(error) {
      clearTimeout(timeout);
      channel.removeEventListener('open', opened);
      channel.removeEventListener('close', closed);
      channel.removeEventListener('error', closed);
      if (error) reject(error);
      else resolve();
    }
    function opened() { finish(); }
    function closed() { finish(new Error('实时连接失败。')); }
    channel.addEventListener('open', opened);
    channel.addEventListener('close', closed);
    channel.addEventListener('error', closed);
  });
}

async function startCapture(message) {
  await stopCapture();
  sessionId = message.sessionId;
  const capturedSession = sessionId;
  try {
    if (!message.clientSecret) throw new Error('缺少实时会话凭证。');
    stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        mandatory: {
          chromeMediaSource: 'tab',
          chromeMediaSourceId: message.streamId
        }
      },
      video: false
    });
    if (capturedSession !== sessionId) throw new Error('翻译已停止。');
    const track = stream.getAudioTracks()[0];
    if (!track) throw new Error('当前标签页没有可采集的声音。');

    audioContext = new AudioContext();
    audioContext.createMediaStreamSource(stream).connect(audioContext.destination);
    await audioContext.resume();
    if (capturedSession !== sessionId) throw new Error('翻译已停止。');
    track.addEventListener('ended', () => {
      if (capturedSession === sessionId) fail('标签页音频采集已结束。');
    });

    peer = new RTCPeerConnection();
    peer.addTrack(track, stream);
    peer.addEventListener('connectionstatechange', () => {
      if (capturedSession === sessionId && peer?.connectionState === 'failed') {
        fail('实时连接已中断。');
      }
    });
    events = peer.createDataChannel('oai-events');
    events.addEventListener('message', ({ data }) => onTranslationEvent(data, capturedSession));
    events.addEventListener('close', () => {
      if (capturedSession === sessionId) fail('实时字幕连接已关闭。');
    });

    const offer = await peer.createOffer();
    await peer.setLocalDescription(offer);
    if (capturedSession !== sessionId) throw new Error('翻译已停止。');
    connectController = new AbortController();
    const timeout = setTimeout(() => connectController?.abort(), 15000);
    let response;
    try {
      response = await fetch(CALLS_ENDPOINT, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${message.clientSecret}`,
          'Content-Type': 'application/sdp'
        },
        body: offer.sdp,
        signal: connectController.signal
      });
    } finally {
      clearTimeout(timeout);
      connectController = undefined;
    }
    if (response.status === 401) throw new Error('实时会话凭证无效，请重新开始。');
    if (!response.ok) throw new Error(`实时翻译连接返回 HTTP ${response.status}。`);
    await peer.setRemoteDescription({ type: 'answer', sdp: await response.text() });
    await waitForChannel(events);
    if (capturedSession !== sessionId) throw new Error('翻译已停止。');
    active = true;
    return { ok: true };
  } catch (error) {
    await stopCapture();
    return { ok: false, error: error.name === 'AbortError' ? '实时连接超时。' : error.message };
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (sender.tab) return;
  if (message.type === 'OFFSCREEN_START') {
    startCapture(message).then(sendResponse);
    return true;
  }
  if (message.type === 'OFFSCREEN_STOP') {
    stopCapture().then(() => sendResponse({ ok: true }));
    return true;
  }
});
