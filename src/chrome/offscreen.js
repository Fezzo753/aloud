// Chrome offscreen document: hosts the audio player and relays its events through the background.
'use strict';
const player = FRAPlayer.create({
  emit: (evt, tabId) => chrome.runtime.sendMessage({ target: 'bg-evt', tabId, evt }).catch(() => {}),
  usage: (provider, chars) => chrome.runtime.sendMessage({ target: 'bg-usage', provider, chars }).catch(() => {}),
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || msg.target !== 'offscreen') return;
  player.handle(msg).then(sendResponse, (err) =>
    sendResponse({ ok: false, error: (err && err.message) || String(err), code: err && err.code })
  );
  return true;
});
