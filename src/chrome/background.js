// Background service worker: injection, routing, browser-voice playback, usage counting.
importScripts('shared.js');

const OFFSCREEN_URL = 'offscreen.html';
let creatingOffscreen = null;
let ttsTabId = null;

async function hasOffscreen() {
  const ctx = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT'],
    documentUrls: [chrome.runtime.getURL(OFFSCREEN_URL)],
  });
  return ctx.length > 0;
}

async function ensureOffscreen() {
  if (await hasOffscreen()) return;
  if (!creatingOffscreen) {
    creatingOffscreen = chrome.offscreen
      .createDocument({ url: OFFSCREEN_URL, reasons: ['AUDIO_PLAYBACK'], justification: 'Plays the read-aloud speech.' })
      .catch((e) => { if (!/single offscreen/i.test(String(e))) throw e; })
      .finally(() => { creatingOffscreen = null; });
  }
  await creatingOffscreen;
}

async function inject(tabId) {
  try {
    const r = await chrome.tabs.sendMessage(tabId, { cmd: 'ping' });
    if (r && r.pong) return true;
  } catch (_) { /* not injected yet */ }
  try {
    await chrome.scripting.insertCSS({ target: { tabId }, files: ['content.css'] });
    await chrome.scripting.executeScript({ target: { tabId }, files: ['shared.js', 'content.js'] });
    return true;
  } catch (e) {
    return false;
  }
}

async function flagUnsupported(tabId) {
  try {
    await chrome.action.setBadgeBackgroundColor({ tabId, color: '#d93025' });
    await chrome.action.setBadgeText({ tabId, text: '✕' });
    await chrome.action.setTitle({ tabId, title: "Chrome doesn't let extensions read this page (built-in pages, Web Store, PDF viewer)." });
    setTimeout(() => {
      chrome.action.setBadgeText({ tabId, text: '' }).catch(() => {});
      chrome.action.setTitle({ tabId, title: 'Read aloud (Ctrl+Shift+U)' }).catch(() => {});
    }, 4000);
  } catch (_) { /* tab gone */ }
}

async function sendToTab(tab, payload) {
  if (!tab || tab.id == null) return;
  if (!(await inject(tab.id))) return flagUnsupported(tab.id);
  chrome.tabs.sendMessage(tab.id, payload).catch(() => {});
}

chrome.runtime.onInstalled.addListener(({ reason }) => {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({ id: 'fra-page', title: 'Read this page aloud', contexts: ['page'] });
    chrome.contextMenus.create({ id: 'fra-from', title: 'Read aloud from here', contexts: ['selection'] });
    chrome.contextMenus.create({ id: 'fra-sel', title: 'Read only the selection', contexts: ['selection'] });
  });
  if (reason === 'install') chrome.runtime.openOptionsPage();
});

chrome.action.onClicked.addListener((tab) => sendToTab(tab, { cmd: 'toggle' }));

chrome.contextMenus.onClicked.addListener((info, tab) => {
  const mode = { 'fra-page': 'page', 'fra-from': 'fromSelection', 'fra-sel': 'selection' }[info.menuItemId];
  if (mode) sendToTab(tab, { cmd: 'start', mode });
});

chrome.commands.onCommand.addListener((command, tab) => {
  const cmd = { 'play-pause': 'playpause', 'next-paragraph': 'next', 'prev-paragraph': 'prev' }[command];
  if (cmd) sendToTab(tab, { cmd });
});

// Stop audio when a tab that was reading navigates away or closes.
async function stopTab(tabId) {
  if (ttsTabId === tabId) { chrome.tts.stop(); ttsTabId = null; }
  if (await hasOffscreen()) {
    chrome.runtime.sendMessage({ target: 'offscreen', op: 'cloud.stop', tabId }).catch(() => {});
  }
}
chrome.tabs.onRemoved.addListener((tabId) => stopTab(tabId));
chrome.tabs.onUpdated.addListener((tabId, info) => { if (info.status === 'loading') stopTab(tabId); });

async function addUsage(provider, chars) {
  const month = new Date().toISOString().slice(0, 7);
  let { usage } = await chrome.storage.local.get('usage');
  if (!usage || usage.month !== month) usage = { month };
  usage[provider] = (usage[provider] || 0) + chars;
  await chrome.storage.local.set({ usage });
}

function speakBrowser(msg, tabId) {
  ttsTabId = tabId;
  const opts = {
    rate: Math.max(0.1, Math.min(10, msg.rate || 1)),
    enqueue: false,
    onEvent: (e) => {
      chrome.tabs.sendMessage(tabId, {
        cmd: 'evt', type: 'tts', token: msg.token, ev: e.type, charIndex: e.charIndex, error: e.errorMessage,
      }).catch(() => {});
    },
  };
  if (msg.voice) opts.voiceName = msg.voice;
  else if (msg.lang) opts.lang = msg.lang;
  chrome.tts.speak(msg.text, opts);
}

const CLOUD_OPS = new Set(['cloud.speak', 'cloud.prefetch', 'cloud.pause', 'cloud.resume', 'cloud.rate', 'cloud.stop']);

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg) return;
  if (msg.target === 'offscreen') return; // meant for the offscreen document
  if (msg.target === 'bg-evt') {
    chrome.tabs.sendMessage(msg.tabId, { cmd: 'evt', ...msg.evt }).catch(() => {});
    return;
  }
  if (msg.target === 'bg-usage') { addUsage(msg.provider, msg.chars); return; }

  const tabId = sender.tab ? sender.tab.id : null;

  if (CLOUD_OPS.has(msg.cmd)) {
    (async () => {
      await ensureOffscreen();
      const cfg = await FRA.getSettings();
      return chrome.runtime.sendMessage({ ...msg, target: 'offscreen', op: msg.cmd, tabId, cfg });
    })().then(
      (r) => sendResponse(r || { ok: false }),
      (e) => sendResponse({ ok: false, error: String((e && e.message) || e) })
    );
    return true;
  }

  switch (msg.cmd) {
    case 'tts.speak':
      speakBrowser(msg, tabId);
      sendResponse({ ok: true });
      return;
    case 'tts.stop':
      if (ttsTabId === tabId) { chrome.tts.stop(); ttsTabId = null; }
      return;
    case 'tts.voices':
      chrome.tts.getVoices((voices) =>
        sendResponse((voices || []).map((v) => ({ id: v.voiceName, name: v.voiceName, locale: v.lang || '', remote: !!v.remote })))
      );
      return true;
    case 'openOptions':
      chrome.runtime.openOptionsPage();
      return;
  }
});
