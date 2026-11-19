// Cloud speech player: fetches speech, caches it, plays it with pitch-preserving speed control.
// Runs in Chrome's offscreen document and in Firefox's background page.
// create({ emit(evt, tabId), usage(provider, chars) }) -> { handle(msg) -> Promise<result> }
'use strict';
globalThis.FRAPlayer = { create({ emit: send, usage }) {

  const MAX_CACHE = 80;
  const cache = new Map(); // key -> { p: Promise<{url,duration,marks}>, url }
  const audio = new Audio();
  audio.preservesPitch = true;

  let cur = null;    // { tabId, token, key } — what's loaded in <audio>
  let latest = null; // { tabId, token } — newest speak request
  let decodeCtx = null;

  function emit(evt, tabId) {
    if (tabId == null) return;
    try { send(evt, tabId); } catch (_) { /* tab gone */ }
  }

  function timing() {
    if (!cur) return;
    emit({ type: 'timing', token: cur.token, t: audio.currentTime, rate: audio.playbackRate, paused: audio.paused }, cur.tabId);
  }
  ['playing', 'pause', 'ratechange', 'seeked'].forEach((e) => audio.addEventListener(e, timing));
  audio.addEventListener('ended', () => { if (cur) emit({ type: 'ended', token: cur.token }, cur.tabId); });
  audio.addEventListener('error', () => {
    if (cur && audio.getAttribute('src')) emit({ type: 'error', token: cur.token, message: 'Audio playback failed.' }, cur.tabId);
  });

  async function analyze(buf) {
    decodeCtx = decodeCtx || new OfflineAudioContext(1, 1, 16000);
    const ab = await decodeCtx.decodeAudioData(buf);
    const { lead, tail } = FRATiming.silenceBounds(ab.getChannelData(0), ab.sampleRate);
    return { duration: ab.duration, lead, tail };
  }

  function probeDuration(url) {
    return new Promise((resolve) => {
      const a = new Audio();
      const done = () => resolve(isFinite(a.duration) ? a.duration : 0);
      a.addEventListener('loadedmetadata', done, { once: true });
      a.addEventListener('error', () => resolve(0), { once: true });
      a.src = url;
    });
  }

  function evict() {
    for (const [k, e] of cache) {
      if (cache.size <= MAX_CACHE) break;
      if (cur && cur.key === k) continue; // never pull audio out from under the player
      cache.delete(k);
      if (e.url) URL.revokeObjectURL(e.url);
      else e.p.then((r) => URL.revokeObjectURL(r.url), () => {});
    }
  }

  function getAudio(cfg, item) {
    const hit = cache.get(item.key);
    if (hit) { cache.delete(item.key); cache.set(item.key, hit); return hit.p; }

    const entry = { url: null };
    entry.p = (async () => {
      let buf;
      let alignment = null;
      if (cfg.provider === 'azure') buf = await FRA.azureSynth(cfg, item.text);
      else if (cfg.provider === 'elevenlabs') ({ buf, alignment } = await FRA.elevenSynth(cfg, item));
      else throw new FRA.TTSError('No cloud voice selected.', 'cfg');

      try { usage(cfg.provider, item.text.length); } catch (_) { /* best effort */ }

      entry.url = URL.createObjectURL(new Blob([buf], { type: 'audio/mpeg' }));
      let info = { duration: 0, lead: 0, tail: 0 };
      try { info = await analyze(buf.slice(0)); } catch (_) { /* fall back below */ }
      if (!info.duration) info.duration = await probeDuration(entry.url);

      const marks =
        (alignment && FRATiming.marksFromAlignment(alignment, item.text, item.words)) ||
        FRATiming.estimateMarks(item.text, item.words, info.lead, Math.max(info.lead + 0.1, info.duration - info.tail));
      return { url: entry.url, duration: info.duration, marks };
    })();
    entry.p.catch(() => { if (cache.get(item.key) === entry) cache.delete(item.key); });
    cache.set(item.key, entry);
    evict();
    return entry.p;
  }

  function waitMeta(timeout = 3000) {
    if (audio.readyState >= 1) return Promise.resolve();
    return new Promise((resolve) => {
      const t = setTimeout(resolve, timeout);
      audio.addEventListener('loadedmetadata', () => { clearTimeout(t); resolve(); }, { once: true });
    });
  }

  async function speak(msg) {
    if (cur && cur.tabId !== msg.tabId) emit({ type: 'stolen' }, cur.tabId);
    latest = { tabId: msg.tabId, token: msg.token };
    cur = null;
    audio.pause();

    const r = await getAudio(msg.cfg, msg.item);
    if (!latest || latest.token !== msg.token || latest.tabId !== msg.tabId) return { ok: false, stale: true };

    cur = { tabId: msg.tabId, token: msg.token, key: msg.item.key };
    const rate = msg.rate || 1;
    audio.src = r.url;
    audio.defaultPlaybackRate = rate;
    audio.playbackRate = rate;
    audio.preservesPitch = true;

    const w = msg.startWord | 0;
    if (w > 0 && r.marks[w] != null) {
      await waitMeta();
      audio.currentTime = Math.max(0, Math.min(r.marks[w] - 0.05, r.duration - 0.05));
    }
    if (msg.paused) return { ok: true, marks: r.marks, duration: r.duration };
    try {
      await audio.play();
    } catch (e) {
      if (!cur || cur.token !== msg.token) return { ok: false, stale: true };
      throw e;
    }
    return { ok: true, marks: r.marks, duration: r.duration };
  }

  const mine = (msg) => cur && cur.tabId === msg.tabId && (msg.token == null || cur.token === msg.token);

  async function handle(msg) {
    switch (msg.op) {
      case 'cloud.speak':
        return speak(msg);
      case 'cloud.prefetch':
        for (const it of msg.items || []) getAudio(msg.cfg, it).catch(() => {});
        return { ok: true };
      case 'cloud.pause':
        if (!mine(msg)) return { ok: false };
        audio.pause();
        return { ok: true };
      case 'cloud.resume':
        if (!mine(msg) || !audio.getAttribute('src')) return { ok: false };
        await audio.play();
        return { ok: true };
      case 'cloud.rate':
        audio.defaultPlaybackRate = msg.rate;
        if (cur && cur.tabId === msg.tabId) audio.playbackRate = msg.rate;
        return { ok: true };
      case 'cloud.stop':
        // A stop that arrives after a newer speak request must not kill it.
        if (latest && latest.tabId === msg.tabId && msg.token != null && latest.token > msg.token) return { ok: true };
        if ((cur && cur.tabId === msg.tabId) || (latest && latest.tabId === msg.tabId)) {
          latest = null;
          cur = null;
          audio.pause();
        }
        return { ok: true };
      default:
        return { ok: false, error: 'unknown op' };
    }
  }

  return { handle };
} };
