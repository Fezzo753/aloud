// Firefox background page: injection, routing, and audio playback.
// Firefox has no offscreen documents, but its background page has a DOM, so the player lives here.
'use strict';

const player = FRAPlayer.create({
  emit: (evt, tabId) => ext.tabs.sendMessage(tabId, { cmd: 'evt', ...evt }).catch(() => {}),
  usage: (provider, chars) => addUsage(provider, chars),
});

async function inject(tabId) {
  try {
    const r = await ext.tabs.sendMessage(tabId, { cmd: 'ping' });
    if (r && r.pong) return true;
  } catch (_) { /* not injected yet */ }
  try {
    await ext.scripting.insertCSS({ target: { tabId }, files: ['content.css'] });
    await ext.scripting.executeScript({ target: { tabId }, files: ['shared.js', 'content.js'] });
    return true;
  } catch (e) {
    return false;
  }
}

async function flagUnsupported(tabId) {
  try {
    await ext.action.setBadgeBackgroundColor({ tabId, color: '#d93025' });
    await ext.action.setBadgeText({ tabId, text: '✕' });
    await ext.action.setTitle({ tabId, title: "Firefox doesn't let add-ons read this page (about: pages, Reader View, addons.mozilla.org, PDF viewer)." });
    setTimeout(() => {
      ext.action.setBadgeText({ tabId, text: '' }).catch(() => {});
      ext.action.setTitle({ tabId, title: 'Read aloud (Ctrl+Shift+U)' }).catch(() => {});
    }, 4000);
  } catch (_) { /* tab gone */ }
}

async function sendToTab(tab, payload) {
  if (!tab || tab.id == null) return;
  if (!(await inject(tab.id))) return flagUnsupported(tab.id);
  ext.tabs.sendMessage(tab.id, payload).catch(() => {});
}

ext.runtime.onInstalled.addListener(({ reason }) => {
  ext.contextMenus.removeAll().then(() => {
    ext.contextMenus.create({ id: 'fra-page', title: 'Read this page aloud', contexts: ['page'] });
    ext.contextMenus.create({ id: 'fra-from', title: 'Read aloud from here', contexts: ['selection'] });
    ext.contextMenus.create({ id: 'fra-sel', title: 'Read only the selection', contexts: ['selection'] });
  });
  if (reason === 'install') ext.runtime.openOptionsPage();
});

ext.action.onClicked.addListener((tab) => sendToTab(tab, { cmd: 'toggle' }));

ext.contextMenus.onClicked.addListener((info, tab) => {
  const mode = { 'fra-page': 'page', 'fra-from': 'fromSelection', 'fra-sel': 'selection' }[info.menuItemId];
  if (mode) sendToTab(tab, { cmd: 'start', mode });
});

ext.commands.onCommand.addListener((command, tab) => {
  const cmd = { 'play-pause': 'playpause', 'next-paragraph': 'next', 'prev-paragraph': 'prev' }[command];
  if (cmd) sendToTab(tab, { cmd });
});

// Stop audio when a tab that was reading navigates away or closes.
const stopTab = (tabId) => player.handle({ op: 'cloud.stop', tabId }).catch(() => {});
ext.tabs.onRemoved.addListener((tabId) => stopTab(tabId));
ext.tabs.onUpdated.addListener((tabId, info) => { if (info.status === 'loading') stopTab(tabId); });

async function addUsage(provider, chars) {
  const month = new Date().toISOString().slice(0, 7);
  let { usage } = await ext.storage.local.get('usage');
  if (!usage || usage.month !== month) usage = { month };
  usage[provider] = (usage[provider] || 0) + chars;
  await ext.storage.local.set({ usage });
}

const CLOUD_OPS = new Set(['cloud.speak', 'cloud.prefetch', 'cloud.pause', 'cloud.resume', 'cloud.rate', 'cloud.stop']);

ext.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg) return;
  const tabId = sender.tab ? sender.tab.id : null;

  if (CLOUD_OPS.has(msg.cmd)) {
    FRA.getSettings()
      .then((cfg) => player.handle({ ...msg, op: msg.cmd, tabId, cfg }))
      .then(
        (r) => sendResponse(r || { ok: false }),
        (e) => sendResponse({ ok: false, error: String((e && e.message) || e), code: e && e.code })
      );
    return true;
  }
  if (msg.cmd === 'keepalive') { sendResponse({ ok: true }); return; }
  if (msg.cmd === 'openOptions') ext.runtime.openOptionsPage();
});
