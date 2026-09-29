(() => {
  if (window !== window.top) return;
  if (document.getElementById('video-chinese-subtitles-root')) return;

  const host = document.createElement('div');
  host.id = 'video-chinese-subtitles-root';
  host.style.cssText = 'position:fixed;left:0;right:0;bottom:clamp(24px,7vh,72px);z-index:2147483647;pointer-events:none;display:none;';
  const shadow = host.attachShadow({ mode: 'closed' });
  const style = document.createElement('style');
  style.textContent = `
    .wrap { box-sizing:border-box; max-width:min(920px,94vw); margin:auto; padding:0 12px; text-align:center; font-family:system-ui,-apple-system,"Segoe UI",sans-serif; }
    .caption { display:inline-block; max-width:100%; border:1px solid rgba(255,255,255,.16); border-radius:11px; padding:10px 18px; color:#fff; background:rgba(8,15,28,.88); box-shadow:0 5px 25px rgba(0,0,0,.32); overflow-wrap:anywhere; }
    .caption[hidden], .status:empty { display:none; }
    .chinese { font-size:clamp(18px,2.3vw,30px); font-weight:700; line-height:1.42; text-shadow:0 1px 2px rgba(0,0,0,.6); }
    .status { display:table; margin:7px auto 0; padding:5px 10px; border-radius:999px; color:#eef3fa; background:rgba(13,23,41,.78); font-size:12px; }
  `;
  const wrap = document.createElement('div');
  wrap.className = 'wrap';
  const caption = document.createElement('div');
  caption.className = 'caption';
  caption.hidden = true;
  const chinese = document.createElement('div');
  chinese.className = 'chinese';
  const status = document.createElement('div');
  status.className = 'status';
  caption.append(chinese);
  wrap.append(caption, status);
  shadow.append(style, wrap);
  document.documentElement.append(host);

  let clearTimer;
  let currentPhase = 'idle';

  function placeOverlay() {
    const fullscreen = document.fullscreenElement;
    const parent = fullscreen && fullscreen.tagName !== 'VIDEO' ? fullscreen : document.documentElement;
    if (host.parentNode !== parent) parent.append(host);
  }

  function applyCaption(data) {
    if (currentPhase === 'idle' || currentPhase === 'error') return;
    chinese.textContent = data.chinese || '';
    caption.hidden = !chinese.textContent;
    clearTimeout(clearTimer);
    clearTimer = setTimeout(() => {
      chinese.textContent = '';
      caption.hidden = true;
    }, 11000);
  }

  function applyState(state) {
    currentPhase = state?.phase || 'idle';
    host.style.display = currentPhase === 'idle' ? 'none' : 'block';
    if (currentPhase === 'idle' || currentPhase === 'error') {
      chinese.textContent = '';
      caption.hidden = true;
      clearTimeout(clearTimer);
      status.textContent = currentPhase === 'error' ? state.detail || '翻译已停止' : '';
    } else {
      status.textContent = currentPhase === 'starting' ? '正在连接音频…' :
        currentPhase === 'processing' ? '正在实时翻译…' : '';
    }
    if (state?.lastCaption && currentPhase !== 'idle' && currentPhase !== 'error') applyCaption(state.lastCaption);
    placeOverlay();
  }

  chrome.runtime.onMessage.addListener((message) => {
    if (message.type === 'UI_STATE') applyState(message.state);
    if (message.type === 'CAPTION') applyCaption(message.caption);
  });
  document.addEventListener('fullscreenchange', placeOverlay);
  chrome.runtime.sendMessage({ type: 'GET_STATE' }).then(applyState).catch(() => {});
})();
