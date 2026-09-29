const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { randomUUID } = require('node:crypto');

const root = path.join(__dirname, '..');

class FakeChannel {
  constructor() {
    this.readyState = 'open';
    this.listeners = new Map();
  }
  addEventListener(type, fn) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(fn);
  }
  removeEventListener(type, fn) {
    this.listeners.set(type, (this.listeners.get(type) || []).filter((item) => item !== fn));
  }
  sendEvent(type, data) {
    for (const fn of this.listeners.get(type) || []) fn({ data });
  }
  close() {
    this.readyState = 'closed';
    this.sendEvent('close');
  }
}

async function testRealtimeCaption() {
  const messages = [];
  const calls = [];
  const channel = new FakeChannel();
  const track = { addEventListener() {}, stop() {} };
  const mediaStream = { getAudioTracks: () => [track], getTracks: () => [track] };
  class FakePeer {
    constructor() { this.connectionState = 'connected'; }
    addTrack() {}
    addEventListener() {}
    createDataChannel() { return channel; }
    async createOffer() { return { type: 'offer', sdp: 'offer-sdp' }; }
    async setLocalDescription() {}
    async setRemoteDescription(answer) { assert.equal(answer.sdp, 'answer-sdp'); }
    close() {}
  }
  class FakeAudioContext {
    constructor() { this.destination = {}; }
    createMediaStreamSource() { return { connect() {} }; }
    async resume() {}
    async close() {}
  }
  const context = vm.createContext({
    AbortController, setTimeout, clearTimeout,
    RTCPeerConnection: FakePeer,
    AudioContext: FakeAudioContext,
    navigator: { mediaDevices: { getUserMedia: async () => mediaStream } },
    fetch: async (url, options) => {
      calls.push({ url, options });
      return { ok: true, status: 200, text: async () => 'answer-sdp' };
    },
    chrome: {
      runtime: {
        onMessage: { addListener() {} },
        sendMessage: async (message) => { messages.push(message); }
      }
    }
  });
  vm.runInContext(fs.readFileSync(path.join(root, 'realtime.js'), 'utf8'), context);
  const result = await vm.runInContext("startCapture({ sessionId: 'test', streamId: 'tab', clientSecret: 'ek-test' })", context);
  assert.equal(result.ok, true);
  assert.equal(calls[0].url, 'https://api.openai.com/v1/realtime/translations/calls');
  assert.equal(calls[0].options.headers.Authorization, 'Bearer ek-test');
  assert.equal(calls[0].options.body, 'offer-sdp');
  channel.sendEvent('message', JSON.stringify({ type: 'session.output_transcript.delta', delta: '你好' }));
  await new Promise((resolve) => setTimeout(resolve, 160));
  assert.equal(messages.at(-1).chinese, '你好');
  await vm.runInContext('stopCapture()', context);
}

async function testClientSecret() {
  const calls = [];
  const context = vm.createContext({
    URL, AbortController, setTimeout, clearTimeout,
    fetch: async (url, options) => {
      calls.push({ url, options });
      return { ok: true, status: 200, json: async () => ({ value: 'ek-test' }) };
    },
    chrome: {
      runtime: { onMessage: { addListener() {} } },
      tabs: { onRemoved: { addListener() {} }, onUpdated: { addListener() {} } }
    }
  });
  vm.runInContext(fs.readFileSync(path.join(root, 'background.js'), 'utf8'), context);
  const secret = await vm.runInContext("createTranslationSecret('sk-test')", context);
  assert.equal(secret, 'ek-test');
  assert.equal(calls[0].url, 'https://api.openai.com/v1/realtime/translations/client_secrets');
  assert.equal(calls[0].options.headers.Authorization, 'Bearer sk-test');
  const body = JSON.parse(calls[0].options.body);
  assert.equal(body.session.model, 'gpt-realtime-translate');
  assert.equal(body.session.audio.output.language, 'zh');
}

async function testMultiSiteStart() {
  const injected = [];
  const captured = [];
  let currentUrl = 'https://video.example/watch';
  let sessionState;
  let offscreenOpen = false;
  const context = vm.createContext({
    URL, AbortController, setTimeout, clearTimeout, crypto: { randomUUID },
    fetch: async () => ({ ok: true, status: 200, json: async () => ({ value: 'ek-test' }) }),
    chrome: {
      tabs: {
        query: async () => [{ id: 7, url: currentUrl }],
        sendMessage: async () => {},
        onRemoved: { addListener() {} },
        onUpdated: { addListener() {} }
      },
      scripting: {
        executeScript: async ({ target, files }) => {
          assert.equal(target.tabId, 7);
          assert.equal(files[0], 'content.js');
          injected.push(currentUrl);
        }
      },
      tabCapture: { getMediaStreamId: async () => { captured.push(currentUrl); return 'tab'; } },
      offscreen: {
        createDocument: async () => { offscreenOpen = true; },
        closeDocument: async () => { offscreenOpen = false; }
      },
      storage: {
        session: {
          get: async () => ({ sessionState }),
          set: async ({ sessionState: state }) => { sessionState = state; }
        },
        local: {
          setAccessLevel: async () => {},
          get: async () => ({ openaiApiKey: 'sk-test' })
        }
      },
      runtime: {
        getURL: (file) => `chrome-extension://test/${file}`,
        getContexts: async () => offscreenOpen ? [{}] : [],
        sendMessage: async (message) => ({ ok: message.type === 'OFFSCREEN_START' }),
        onMessage: { addListener() {} }
      }
    }
  });
  vm.runInContext(fs.readFileSync(path.join(root, 'background.js'), 'utf8'), context);

  for (const url of ['https://video.example/watch', 'http://another.example/movie']) {
    currentUrl = url;
    assert.equal((await vm.runInContext('start()', context)).ok, true);
    assert.equal(sessionState.phase, 'active');
    await vm.runInContext('stop()', context);
  }
  assert.deepEqual(injected, ['https://video.example/watch', 'http://another.example/movie']);
  assert.deepEqual(captured, injected);

  currentUrl = 'chrome://extensions';
  await assert.rejects(vm.runInContext('start()', context), /普通网站/);
  assert.equal(injected.length, 2);
}

Promise.all([testRealtimeCaption(), testClientSecret(), testMultiSiteStart()])
  .then(() => console.log('Realtime translation smoke test OK'))
  .catch((error) => { console.error(error); process.exitCode = 1; });
