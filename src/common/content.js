// Aloud — in-page reader: content extraction, highlighting, toolbar, click-to-jump.
(() => {
  'use strict';
  if (window.__ALOUD__) return;
  window.__ALOUD__ = true;

  // ───────────────────────── settings ─────────────────────────
  let S = { ...FRA.DEFAULTS };
  const ready = FRA.getSettings().then((s) => { S = s; });

  const VOICE_KEYS = new Set(['provider', 'azureKey', 'azureRegion', 'azureVoice', 'elevenKey', 'elevenModel', 'elevenVoice']);
  ext.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    let voiceChanged = false;
    for (const [k, { newValue }] of Object.entries(changes)) {
      if (!(k in FRA.DEFAULTS)) continue;
      const v = newValue === undefined ? FRA.DEFAULTS[k] : newValue;
      if (S[k] === v) continue;
      if (VOICE_KEYS.has(k)) voiceChanged = true;
      S[k] = v;
      if (k === 'rate') applyRate(v, false);
    }
    if (!isOpen) return;
    refreshUI();
    if (voiceChanged && (P.state === 'playing' || P.state === 'loading')) restartCurrent();
  });

  const send = (msg) => ext.runtime.sendMessage(msg).catch((e) => ({ ok: false, error: String(e && e.message || e) }));

  // Basic (built-in) voices. Chrome: chrome.tts via the background. Firefox: Web Speech in the page.
  const Local = FRA.IS_FIREFOX ? (() => {
    const ss = window.speechSynthesis;
    let cur = null;
    const voices = () => new Promise((resolve) => {
      const v = ss.getVoices();
      if (v.length) return resolve(v);
      const t = setTimeout(() => resolve(ss.getVoices()), 1500);
      ss.addEventListener('voiceschanged', () => { clearTimeout(t); resolve(ss.getVoices()); }, { once: true });
    });
    return {
      async speak(m) {
        ss.cancel();
        const u = new SpeechSynthesisUtterance(m.text);
        cur = u;
        u.rate = Math.max(0.1, Math.min(10, m.rate || 1));
        const vs = await voices();
        if (cur !== u) return; // stopped while voices loaded
        const v = m.voice && vs.find((x) => x.name === m.voice);
        if (v) u.voice = v; else u.lang = m.lang;
        const ev = (type, extra) => { if (cur === u) onEvt({ type: 'tts', token: m.token, ev: type, ...extra }); };
        u.onstart = () => ev('start');
        u.onboundary = (e) => { if (!e.name || e.name === 'word') ev('word', { charIndex: e.charIndex }); };
        u.onend = () => ev('end');
        u.onerror = (e) => { if (e.error !== 'interrupted' && e.error !== 'canceled') ev('error', { error: e.error }); };
        ss.speak(u);
      },
      stop() { cur = null; ss.cancel(); },
      async list() {
        return (await voices()).map((v) => ({ id: v.name, name: v.name, locale: v.lang || '', remote: !v.localService }));
      },
    };
  })() : {
    speak(m) { send({ cmd: 'tts.speak', ...m }); },
    stop() { send({ cmd: 'tts.stop' }); },
    list() { return send({ cmd: 'tts.voices' }); },
  };

  // ───────────────────────── language / segmentation ─────────────────────────
  const LANG = (() => {
    const l = (document.documentElement.lang || navigator.language || 'en').replace('_', '-');
    try { new Intl.Segmenter(l); return l; } catch (_) { return 'en'; }
  })();
  const segS = new Intl.Segmenter(LANG, { granularity: 'sentence' });
  const segW = new Intl.Segmenter(LANG, { granularity: 'word' });
  const HAS_TEXT = /[\p{L}\p{N}]/u;

  // ───────────────────────── extraction ─────────────────────────
  const SKIP = new Set([
    'script', 'style', 'noscript', 'template', 'svg', 'math', 'rt', 'rp', 'button', 'select', 'option',
    'textarea', 'input', 'iframe', 'canvas', 'video', 'audio', 'object', 'embed', 'img', 'picture',
    'datalist', 'meter', 'progress', 'head', 'link', 'meta',
  ]);
  const CLUTTER_ROLES = new Set([
    'navigation', 'complementary', 'contentinfo', 'banner', 'menu', 'menubar', 'toolbar', 'search',
    'dialog', 'alertdialog', 'tablist', 'tooltip',
  ]);
  const UNLIKELY = /-ad-|\bads?\b|advert|agegate|breadcrumb|combx|comment|consent|cookie|cover-wrap|disqus|footer|gdpr|legends|masthead|menu|modal|navbar|\bnav\b|newsletter|outbrain|pager|pagination|paywall|popup|promo|related|remark|replies|rss|share|sharing|shoutbox|sidebar|site-header|skyscraper|social|sponsor|subscribe|supplemental|taboola|toolbar|tooltip|widget|yom-remote/i;
  const MAYBE = /article|body|column|content|main|post|entry|story|prose/i;
  const BR = { br: true };

  let styleCache = new WeakMap();
  const styleOf = (el) => {
    let s = styleCache.get(el);
    if (!s) { s = getComputedStyle(el); styleCache.set(el, s); }
    return s;
  };
  const isBlockish = (s) => {
    const d = s.display;
    return !!d && !(d.startsWith('inline') || d === 'contents' || d.startsWith('ruby'));
  };
  const isSrOnly = (s) =>
    s.position === 'absolute' &&
    ((parseFloat(s.width) <= 1 || parseFloat(s.height) <= 1) || s.clip === 'rect(0px, 0px, 0px, 0px)' || s.clipPath === 'inset(50%)');
  const isFootnote = (el) => {
    const t = el.textContent.trim();
    return t.length <= 5 && (!!el.querySelector('a') || /reference|footnote|cite/i.test(el.className));
  };

  function collectFragments(root) {
    styleCache = new WeakMap();
    const out = [];
    const walk = (node, ctx) => {
      for (let c = node.firstChild; c; c = c.nextSibling) {
        if (c.nodeType === 3) {
          const v = c.nodeValue;
          if (!v) continue;
          if (!ctx.frag) {
            if (!/\S/.test(v)) continue;
            ctx.frag = { el: ctx.el, parts: [] };
            out.push(ctx.frag);
          }
          ctx.frag.parts.push(c);
        } else if (c.nodeType === 1) {
          if (c === host) continue;
          const name = c.localName;
          if (SKIP.has(name)) continue;
          if (name === 'br') { if (ctx.frag) ctx.frag.parts.push(BR); continue; }
          if (name === 'sup' && isFootnote(c)) continue;
          if (c.hidden || c.getAttribute('aria-hidden') === 'true') continue;
          const s = styleOf(c);
          if (s.display === 'none' || s.visibility === 'hidden' || s.visibility === 'collapse' || isSrOnly(s)) continue;
          if (name === 'details' && !c.open) {
            const sum = c.querySelector(':scope > summary');
            if (sum) { const sub = { el: sum, frag: null }; walk(sum, sub); ctx.frag = null; }
            continue;
          }
          if (isBlockish(s)) {
            walk(c, { el: c, frag: null });
            ctx.frag = null; // text after a nested block starts a new fragment
          } else {
            walk(c, ctx);
          }
        }
      }
    };
    walk(root, { el: root, frag: null });

    const res = [];
    for (const f of out) {
      buildText(f);
      if (f.text && HAS_TEXT.test(f.text)) res.push(f);
    }
    return res;
  }

  function buildText(f) {
    let text = '';
    const map = [];
    let sp = true;
    let last = null;
    let link = 0;
    for (const p of f.parts) {
      if (p === BR) {
        if (!sp && last) { text += ' '; map.push(last); sp = true; }
        continue;
      }
      const v = p.nodeValue;
      const inLink = !!(p.parentElement && p.parentElement.closest('a[href]'));
      for (let o = 0; o < v.length; o++) {
        const code = v.charCodeAt(o);
        if (code === 0xad) continue; // soft hyphen
        if (code <= 32 || code === 160 || code === 0x3000 || (code >= 0x2000 && code <= 0x200b) || code === 0xfeff) {
          if (!sp) { last = { n: p, o }; text += ' '; map.push(last); sp = true; }
        } else {
          last = { n: p, o };
          text += v[o];
          map.push(last);
          sp = false;
          if (inLink) link++;
        }
      }
    }
    if (text.endsWith(' ')) { text = text.slice(0, -1); map.pop(); }
    f.text = text;
    f.map = map;
    f.linkDensity = text.length ? link / text.length : 0;
    delete f.parts;
  }

  // Readability-style scoring to find the article and drop page furniture.
  let clutterCache = new WeakMap();
  let elLen = new Map();
  let totalLen = 1;

  function selfClutter(el) {
    const n = el.localName;
    if (n === 'nav' || n === 'aside' || n === 'footer' || n === 'dialog' || n === 'menu') return true;
    if (n === 'header' && !el.closest('article, main, [role="main"]')) return true;
    const role = el.getAttribute('role');
    if (role && CLUTTER_ROLES.has(role)) return true;
    const sig = `${el.id || ''} ${el.getAttribute('class') || ''}`;
    if (sig.length > 2 && UNLIKELY.test(sig) && !MAYBE.test(sig) && (elLen.get(el) || 0) < totalLen * 0.4) return true;
    return false;
  }
  function isClutter(el) {
    if (!el || el === document.body || el === document.documentElement) return false;
    if (clutterCache.has(el)) return clutterCache.get(el);
    const v = selfClutter(el) || isClutter(el.parentElement);
    clutterCache.set(el, v);
    return v;
  }

  function pickMain(frags) {
    clutterCache = new WeakMap();
    elLen = new Map();
    totalLen = 1;
    for (const f of frags) {
      totalLen += f.text.length;
      for (let a = f.el; a && a !== document.documentElement; a = a.parentElement) elLen.set(a, (elLen.get(a) || 0) + f.text.length);
    }

    const scores = new Map();
    for (const f of frags) {
      const len = f.text.length;
      if (len < 25 || /^h[1-6]$/.test(f.el.localName) || isClutter(f.el)) continue;
      let s = 1 + (f.text.match(/[,，、]/g) || []).length + Math.min(Math.floor(len / 100), 3);
      s *= 1 - f.linkDensity;
      let a = f.el.parentElement;
      for (let lvl = 0; a && lvl < 5 && a !== document.documentElement; lvl++, a = a.parentElement) {
        scores.set(a, (scores.get(a) || 0) + s / (lvl === 0 ? 1 : lvl === 1 ? 2 : lvl * 3));
      }
    }
    let best = null;
    let bs = -1;
    for (const [el, s] of scores) if (s > bs && !isClutter(el)) { bs = s; best = el; }
    if (!best) return [];

    const roots = [best];
    if (best.parentElement && best !== document.body) {
      for (const sib of best.parentElement.children) {
        if (sib !== best && (scores.get(sib) || 0) >= bs * 0.25 && !isClutter(sib)) roots.push(sib);
      }
    }
    const inRoots = (el) => roots.some((r) => r.contains(el));
    let res = frags.filter((f) => inRoots(f.el) && !isClutter(f.el) && !(f.linkDensity > 0.55 && f.text.length < 200));

    // Pull in the article title if it sits outside the content container.
    const h1 = Array.from(document.querySelectorAll('h1')).find(
      (h) => !h.closest('nav, [role="navigation"], [role="banner"]') && frags.some((f) => h.contains(f.el))
    );
    if (h1 && !inRoots(h1) && roots[0].compareDocumentPosition(h1) & Node.DOCUMENT_POSITION_PRECEDING) {
      res = frags.filter((f) => h1.contains(f.el)).concat(res);
    }

    const chars = res.reduce((n, f) => n + f.text.length, 0);
    return chars < 250 ? [] : res;
  }

  function indexList(list) {
    list.nodeIdx = new Map();
    list.elIdx = new Map();
    list.forEach((f, i) => {
      if (!list.elIdx.has(f.el)) list.elIdx.set(f.el, i);
      for (const m of f.map) if (!list.nodeIdx.has(m.n)) list.nodeIdx.set(m.n, i);
    });
    return list;
  }

  let EX = null;
  function extract() {
    const full = collectFragments(document.body);
    const smart = pickMain(full);
    EX = { full: indexList(full), smart: smart.length ? indexList(smart) : null };
  }
  const defaultList = () => (S.smart && EX.smart) || EX.full;

  // Boundary (node, offset) -> { fi, ci } in a list.
  function locate(list, node, offset, isStart) {
    if (!list || !node) return null;
    let tn = node;
    let off = offset;
    if (tn.nodeType !== 3) {
      const child = tn.childNodes[offset] || null;
      const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      if (isStart) {
        w.currentNode = child || tn;
        if (child && child.nodeType === 3) tn = child; else tn = w.nextNode();
        off = 0;
      } else {
        w.currentNode = child || tn;
        tn = w.previousNode();
        off = tn ? tn.nodeValue.length : 0;
      }
    }
    // Walk to the nearest node that is part of the list.
    if (tn && !list.nodeIdx.has(tn)) {
      const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      w.currentNode = tn;
      let steps = 0;
      do { tn = isStart ? w.nextNode() : w.previousNode(); } while (tn && !list.nodeIdx.has(tn) && ++steps < 3000);
      off = isStart || !tn ? 0 : tn.nodeValue.length;
    }
    if (!tn || !list.nodeIdx.has(tn)) return null;
    const fi = list.nodeIdx.get(tn);
    const map = list[fi].map;
    if (isStart) {
      let lastK = -1;
      for (let k = 0; k < map.length; k++) {
        if (map[k].n === tn) { if (map[k].o >= off) return { fi, ci: k }; lastK = k; } else if (lastK >= 0) break;
      }
      return { fi, ci: lastK + 1 };
    }
    let ci = 0;
    for (let k = 0; k < map.length; k++) if (map[k].n === tn && map[k].o < off) ci = k + 1;
    return { fi, ci };
  }

  // ───────────────────────── utterances ─────────────────────────
  function snapWordStart(text, ci) {
    if (ci <= 0) return 0;
    if (ci >= text.length) return text.length;
    const seg = segW.segment(text).containing(ci);
    return seg && seg.isWordLike ? seg.index : ci;
  }

  function splitLong(text, s, e) {
    const out = [];
    while (e - s > 350) {
      const win = text.slice(s + 120, s + 300);
      let cut = -1;
      const re = /[,;:—–)]\s|\s/g;
      let m;
      let punct = -1;
      while ((m = re.exec(win))) { if (m[0].length === 2) punct = m.index + 1; cut = m.index; }
      const at = punct >= 0 ? punct : cut;
      const pos = at >= 0 ? s + 120 + at : s + 300;
      let a = pos;
      while (a > s && text[a - 1] === ' ') a--;
      out.push([s, a]);
      s = pos;
      while (s < e && text[s] === ' ') s++;
    }
    if (e > s) out.push([s, e]);
    return out;
  }

  function mkU(fi, text, s, e) {
    const t = text.slice(s, e);
    const words = [];
    for (const seg of segW.segment(t)) if (seg.isWordLike) words.push([seg.index, seg.index + seg.segment.length]);
    if (!words.length) words.push([0, t.length]);
    return { fi, s, e, text: t, words };
  }

  function buildUtterances(list, fi, ci, bound) {
    const U = [];
    for (let k = fi; k < list.length; k++) {
      if (bound && k > bound.fi) break;
      const text = list[k].text;
      const from = snapWordStart(text, k === fi ? ci : 0);
      const to = bound && k === bound.fi ? bound.ci : text.length;
      if (to <= from) continue;

      const pieces = [];
      for (const seg of segS.segment(text)) {
        let s = Math.max(seg.index, from);
        let e = Math.min(seg.index + seg.segment.length, to);
        while (s < e && text[s] === ' ') s++;
        while (e > s && text[e - 1] === ' ') e--;
        if (e > s && HAS_TEXT.test(text.slice(s, e))) pieces.push([s, e]);
      }
      const merged = [];
      for (const p of pieces) {
        const last = merged[merged.length - 1];
        if (last && (last[1] - last[0] < 40 || p[1] - p[0] < 12) && p[1] - last[0] <= 320) last[1] = p[1];
        else merged.push([p[0], p[1]]);
      }
      for (const [s, e] of merged) for (const [a, b] of splitLong(text, s, e)) U.push(mkU(k, text, a, b));
    }
    return U;
  }

  // ───────────────────────── player ─────────────────────────
  const P = {
    list: null, bound: null, U: [], i: 0,
    state: 'idle', // idle | loading | playing | paused
    token: 0, engine: null, marks: null, word: -1,
    clock: { t: 0, at: 0, rate: 1, paused: true },
    ttsOffset: 0, needRespeak: false, raf: 0,
  };

  const cloudReady = () =>
    (S.provider === 'azure' && S.azureKey && S.azureRegion && S.azureVoice) ||
    (S.provider === 'elevenlabs' && S.elevenKey && S.elevenVoice);

  const cacheKey = (text) =>
    S.provider === 'azure' ? `az|${S.azureVoice}|${text}` : `el|${S.elevenVoice}|${S.elevenModel}|${text}`;

  function item(i) {
    const u = P.U[i];
    if (!u) return null;
    return {
      key: cacheKey(u.text),
      text: u.text,
      words: u.words,
      prev: P.U[i - 1] ? P.U[i - 1].text : '',
      next: P.U[i + 1] ? P.U[i + 1].text : '',
    };
  }

  function stopEngine() {
    P.token++;
    if (P.engine === 'browser') Local.stop();
    if (P.engine === 'cloud') send({ cmd: 'cloud.stop', token: P.token });
    P.engine = null;
    P.marks = null;
  }

  function startAt(list, fi, ci = 0, bound = null) {
    stopEngine();
    P.list = list;
    P.bound = bound;
    P.U = buildUtterances(list, fi, ci, bound);
    P.i = 0;
    P.needRespeak = false;
    if (!P.U.length) { setState('idle'); setStatus('Nothing readable here.', 3000); return; }
    playCurrent();
  }

  async function playCurrent(fromWord = 0) {
    const u = P.U[P.i];
    if (!u) return finish();
    const prevEngine = P.engine;
    const token = ++P.token;
    P.engine = null;
    P.marks = null;
    P.word = -1;
    P.needRespeak = false;
    P.clock = { t: 0, at: performance.now(), rate: S.rate, paused: true };
    highlightUtterance(u);
    if (fromWord > 0) setWord(fromWord);
    setState('loading');

    if (!cloudReady()) {
      if (S.provider !== 'browser') hintOnce(`${S.provider === 'azure' ? 'Azure' : 'ElevenLabs'} isn't set up yet — using basic voices. Open ⚙ to add your key.`);
      if (prevEngine === 'cloud') send({ cmd: 'cloud.stop', token });
      P.engine = 'browser';
      const w = u.words[fromWord];
      P.ttsOffset = fromWord > 0 && w ? w[0] : 0;
      Local.speak({ token, text: u.text.slice(P.ttsOffset), rate: S.rate, voice: S.browserVoice, lang: LANG });
      // Some systems have no usable voice and never report start or error.
      setTimeout(() => {
        if (token === P.token && P.engine === 'browser' && P.state === 'loading') {
          fail(`The basic voice didn't start. Check ${FRA.IS_FIREFOX ? 'Windows has speech voices installed' : 'your system voices'}, or pick Azure or ElevenLabs in settings.`);
        }
      }, 6000);
      return;
    }

    if (prevEngine === 'browser') Local.stop();
    P.engine = 'cloud';
    const r = await send({ cmd: 'cloud.speak', token, item: item(P.i), rate: S.rate, startWord: fromWord });
    if (token !== P.token) return;
    if (!r || !r.ok) {
      if (r && r.stale) return;
      return fail((r && r.error) || 'Speech service error.', r && r.code);
    }
    P.marks = r.marks;
    if (P.state === 'paused') send({ cmd: 'cloud.pause', token });
    else setState('playing');
    const pre = [item(P.i + 1), item(P.i + 2)].filter(Boolean);
    if (pre.length) send({ cmd: 'cloud.prefetch', items: pre });
  }

  function next() {
    P.i++;
    if (P.i >= P.U.length) return finish();
    playCurrent();
  }

  function finish() {
    stopEngine();
    clearHighlights();
    P.U = [];
    P.i = 0;
    setState('idle');
    setStatus('Finished.', 2500);
  }

  function fail(message, code) {
    stopEngine();
    P.needRespeak = true;
    setState('paused');
    setStatus(message, 0, 'error', code === 'nokey' || /key|region|voice/i.test(message) ? 'Settings' : null);
  }

  function pause() {
    if (P.state !== 'playing' && P.state !== 'loading') return;
    setState('paused');
    if (P.engine === 'cloud') send({ cmd: 'cloud.pause', token: P.token });
    else if (P.engine === 'browser') { stopEngine(); P.needRespeak = true; }
  }

  async function resume() {
    if (P.state !== 'paused') return;
    if (P.engine === 'cloud' && !P.needRespeak) {
      setState('playing');
      const r = await send({ cmd: 'cloud.resume', token: P.token });
      if (r && r.ok) return;
    }
    playCurrent(Math.max(0, P.word));
  }

  function restartCurrent() {
    if (!P.U[P.i]) return;
    playCurrent(Math.max(0, P.word));
  }

  function togglePlay() {
    if (P.state === 'playing' || P.state === 'loading') return pause();
    if (P.state === 'paused' && P.U[P.i]) return resume();
    extract();
    const list = defaultList();
    startAt(list, firstVisible(list));
  }

  function applyRate(r, save = true) {
    r = Math.round(Math.max(0.5, Math.min(3, r)) * 100) / 100;
    S.rate = r;
    if (save) FRA.setSettings({ rate: r });
    if (P.engine === 'cloud') send({ cmd: 'cloud.rate', rate: r });
    else if (P.engine === 'browser' && (P.state === 'playing' || P.state === 'loading')) restartCurrent();
    refreshUI();
  }

  function jumpPara(dir) {
    const u = P.U[P.i];
    const list = P.list || (EX && defaultList());
    if (!list) return;
    if (!u) { startAt(list, firstVisible(list)); return; }
    let target;
    if (dir > 0) target = u.fi + 1;
    else {
      const firstOfPara = P.U.findIndex((x) => x.fi === u.fi);
      target = P.i > firstOfPara || P.word > 3 ? u.fi : u.fi - 1;
    }
    if (target >= list.length || (P.bound && target > P.bound.fi)) return finish();
    startAt(list, Math.max(0, target), 0, P.bound);
  }

  function onEvt(m) {
    if (m.type === 'stolen') {
      if (P.engine === 'cloud' && (P.state === 'playing' || P.state === 'loading')) {
        P.needRespeak = true;
        P.clock.paused = true;
        setState('paused');
      }
      return;
    }
    if (m.token !== P.token) return;
    switch (m.type) {
      case 'timing':
        P.clock = { t: m.t, at: performance.now(), rate: m.rate, paused: m.paused };
        if (!m.paused && P.state === 'paused') send({ cmd: 'cloud.pause', token: P.token });
        else if (!m.paused && P.state === 'loading') setState('playing');
        break;
      case 'ended':
        next();
        break;
      case 'error':
        fail(m.message || 'Playback failed.');
        break;
      case 'tts':
        if (P.engine !== 'browser') return;
        if (m.ev === 'start') { if (P.state === 'loading') setState('playing'); }
        else if (m.ev === 'word') setWord(wordAt(P.ttsOffset + (m.charIndex || 0)));
        else if (m.ev === 'end') next();
        else if (m.ev === 'error') fail(m.error ? `The basic voice failed (${m.error}). Pick another voice in settings.` : "Chrome couldn't use the basic voice. Pick another voice in settings.");
        break;
    }
  }

  function wordAt(ci) {
    const u = P.U[P.i];
    if (!u) return -1;
    let k = -1;
    for (let j = 0; j < u.words.length; j++) { if (u.words[j][0] <= ci) k = j; else break; }
    return k;
  }

  function tick() {
    P.raf = requestAnimationFrame(tick);
    if (P.engine !== 'cloud' || !P.marks || P.state !== 'playing') return;
    const c = P.clock;
    const t = c.paused ? c.t : c.t + ((performance.now() - c.at) / 1000) * c.rate;
    let k = -1;
    for (let j = 0; j < P.marks.length; j++) { if (P.marks[j] <= t + 0.04) k = j; else break; }
    if (k !== P.word) setWord(k);
  }

  // ───────────────────────── highlighting & scrolling ─────────────────────────
  const HL = typeof CSS !== 'undefined' && CSS.highlights && typeof Highlight !== 'undefined';
  let lastUserScroll = 0;

  function rangeFor(fi, s, e) {
    const f = P.list && P.list[fi];
    if (!f || e <= s) return null;
    const a = f.map[s];
    const b = f.map[e - 1];
    if (!a || !b || !a.n.isConnected || !b.n.isConnected) return null;
    const r = document.createRange();
    try {
      r.setStart(a.n, a.o);
      r.setEnd(b.n, Math.min(b.o + 1, b.n.nodeValue.length));
    } catch (_) { return null; }
    return r;
  }

  function clearHighlights() {
    if (!HL) return;
    CSS.highlights.delete('aloud-sentence');
    CSS.highlights.delete('aloud-word');
  }

  function highlightUtterance(u) {
    if (!HL) return;
    CSS.highlights.delete('aloud-word');
    const r = S.highlight === 'none' ? null : rangeFor(u.fi, u.s, u.e);
    if (r) CSS.highlights.set('aloud-sentence', new Highlight(r));
    else CSS.highlights.delete('aloud-sentence');
    if (r && S.highlight !== 'word') maybeScroll(r);
    if (!r && S.highlight === 'none') {
      const rr = rangeFor(u.fi, u.s, Math.min(u.e, u.s + 1));
      if (rr) maybeScroll(rr);
    }
  }

  function setWord(k) {
    P.word = k;
    if (!HL) return;
    const u = P.U[P.i];
    if (k < 0 || !u || !u.words[k] || S.highlight !== 'word') { CSS.highlights.delete('aloud-word'); return; }
    const [ws, we] = u.words[k];
    const r = rangeFor(u.fi, u.s + ws, u.s + we);
    if (!r) return;
    CSS.highlights.set('aloud-word', new Highlight(r));
    maybeScroll(r);
  }

  function maybeScroll(range) {
    if (!S.autoscroll || performance.now() - lastUserScroll < 3000) return;
    const rect = range.getBoundingClientRect();
    if (!rect.width && !rect.height) return;
    const vh = window.innerHeight;
    if (rect.top >= 80 && rect.bottom <= vh - 90) return;
    const el = range.startContainer.parentElement;
    const er = el && el.getBoundingClientRect();
    if (er && er.height < vh * 0.5) el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    else window.scrollBy({ top: rect.top - vh * 0.33, behavior: 'smooth' });
  }

  function firstVisible(list) {
    if (window.scrollY < 80) return 0;
    for (let i = 0; i < list.length; i++) {
      const m = list[i].map[0];
      if (!m) continue;
      const r = document.createRange();
      r.setStart(m.n, m.o);
      r.setEnd(m.n, Math.min(m.o + 1, m.n.nodeValue.length));
      const rect = r.getBoundingClientRect();
      if (rect.height && rect.top >= 60) return i;
    }
    return 0;
  }

  // ───────────────────────── UI ─────────────────────────
  let host = null;
  let root = null;
  let isOpen = false;
  const ui = {};

  const ICONS = {
    play: 'M8 5v14l11-7z',
    pause: 'M6 5h4v14H6zM14 5h4v14h-4z',
    prev: 'M6 6h2v12H6zm3.5 6 8.5 6V6z',
    next: 'M6 18l8.5-6L6 6v12zM16 6v12h2V6h-2z',
    voice: 'M7 18h2V6H7v12zm4 4h2V2h-2v20zm-8-8h2v-4H3v4zm12 4h2V6h-2v12zm4-8v4h2v-4h-2z',
    gear: 'M19.14 12.94c.04-.3.06-.61.06-.94 0-.32-.02-.64-.07-.94l2.03-1.58a.49.49 0 0 0 .12-.61l-1.92-3.32a.49.49 0 0 0-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54a.48.48 0 0 0-.48-.41h-3.84c-.24 0-.43.17-.47.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96a.49.49 0 0 0-.59.22L2.74 8.87c-.12.21-.08.47.12.61l2.03 1.58c-.05.3-.09.63-.09.94s.02.64.07.94l-2.03 1.58a.49.49 0 0 0-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32a.49.49 0 0 0-.12-.61l-2.01-1.58zM12 15.6A3.6 3.6 0 1 1 12 8.4a3.6 3.6 0 0 1 0 7.2z',
    close: 'M19 6.41 17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z',
    caret: 'M7 10l5 5 5-5z',
    grip: 'M9 6a1.5 1.5 0 1 1-3 0 1.5 1.5 0 0 1 3 0zm0 6a1.5 1.5 0 1 1-3 0 1.5 1.5 0 0 1 3 0zm0 6a1.5 1.5 0 1 1-3 0 1.5 1.5 0 0 1 3 0zm9-12a1.5 1.5 0 1 1-3 0 1.5 1.5 0 0 1 3 0zm0 6a1.5 1.5 0 1 1-3 0 1.5 1.5 0 0 1 3 0zm0 6a1.5 1.5 0 1 1-3 0 1.5 1.5 0 0 1 3 0z',
  };

  function icon(name) {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('aria-hidden', 'true');
    const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    p.setAttribute('d', ICONS[name]);
    svg.append(p);
    return svg;
  }

  function h(tag, attrs, ...kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v == null) continue;
      if (k === 'class') el.className = v;
      else if (k === 'text') el.textContent = v;
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else el.setAttribute(k, v);
    }
    for (const c of kids.flat()) if (c != null) el.append(c);
    return el;
  }

  const CSS_TEXT = `
:host { all: initial; }
* { box-sizing: border-box; }
.bar {
  --bg: rgba(250,250,252,.97); --fg: #1c1c1f; --muted: #6b6b73; --line: rgba(0,0,0,.09);
  --hover: rgba(0,0,0,.06); --accent: #2f6fed; --accent-hover: #255ed4; --pop: #ffffff;
  position: fixed; top: 14px; left: 50%; transform: translateX(-50%); z-index: 2147483647;
  display: flex; align-items: center; gap: 2px; padding: 5px 6px;
  background: var(--bg); color: var(--fg); border: 1px solid var(--line); border-radius: 16px;
  box-shadow: 0 12px 32px rgba(0,0,0,.18), 0 2px 6px rgba(0,0,0,.12);
  font: 13px/1.25 "Segoe UI Variable Text", "Segoe UI", system-ui, -apple-system, Roboto, sans-serif;
  -webkit-font-smoothing: antialiased; user-select: none;
  backdrop-filter: saturate(1.4) blur(14px);
}
@media (prefers-color-scheme: dark) {
  .bar { --bg: rgba(30,30,34,.96); --fg: #f2f2f4; --muted: #a1a1aa; --line: rgba(255,255,255,.09);
    --hover: rgba(255,255,255,.08); --accent: #4d8bff; --accent-hover: #6b9dff; --pop: #26262b; }
}
button { all: unset; }
.ib, .pill { cursor: pointer; color: inherit; border-radius: 10px; transition: background .12s; }
.ib { width: 34px; height: 34px; display: grid; place-items: center; }
.ib:hover, .pill:hover, .pill[aria-expanded="true"] { background: var(--hover); }
.ib:focus-visible, .pill:focus-visible, .play:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
svg { width: 20px; height: 20px; fill: currentColor; display: block; }
.play { width: 40px; height: 40px; margin: 0 3px; border-radius: 50%; display: grid; place-items: center;
  background: var(--accent); color: #fff; cursor: pointer; transition: background .12s, transform .08s; }
.play:hover { background: var(--accent-hover); }
.play:active { transform: scale(.95); }
.play svg { width: 22px; height: 22px; }
.spin { width: 18px; height: 18px; border-radius: 50%; border: 2.5px solid rgba(255,255,255,.35); border-top-color: #fff;
  animation: sp .7s linear infinite; }
@keyframes sp { to { transform: rotate(360deg); } }
.sep { width: 1px; height: 22px; background: var(--line); margin: 0 5px; }
.pill { height: 34px; padding: 0 8px 0 9px; display: flex; align-items: center; gap: 6px; max-width: 190px; }
.pill svg { width: 18px; height: 18px; flex: none; }
.pill .caret { width: 16px; height: 16px; opacity: .6; }
.lbl { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.rate { font-variant-numeric: tabular-nums; min-width: 44px; justify-content: center; font-weight: 600; }
.grip { width: 16px; height: 34px; display: grid; place-items: center; cursor: grab; opacity: .4; }
.grip:active { cursor: grabbing; }
.grip svg { width: 14px; height: 14px; }
.status { position: absolute; top: calc(100% + 8px); left: 50%; transform: translateX(-50%);
  background: var(--pop); color: var(--fg); border: 1px solid var(--line); border-radius: 10px; padding: 7px 12px;
  box-shadow: 0 8px 22px rgba(0,0,0,.16); width: max-content; max-width: min(480px, calc(100vw - 32px));
  display: none; align-items: center; gap: 12px; }
.status.show { display: flex; }
.status.error { border-color: rgba(220,50,50,.45); }
.status .msg { overflow: hidden; text-overflow: ellipsis; white-space: normal; }
.status .act { color: var(--accent); font-weight: 600; cursor: pointer; flex: none; }
.pop { position: absolute; top: calc(100% + 8px); background: var(--pop); color: var(--fg);
  border: 1px solid var(--line); border-radius: 14px; box-shadow: 0 14px 34px rgba(0,0,0,.22); padding: 10px; display: none; }
.pop.show { display: block; }
.speed { width: 250px; right: 40px; }
.speed .row { display: flex; align-items: center; justify-content: space-between; margin-bottom: 8px; color: var(--muted); }
.speed .val { color: var(--fg); font-weight: 600; font-variant-numeric: tabular-nums; }
.speed input[type=range] { width: 100%; accent-color: var(--accent); }
.presets { display: flex; gap: 4px; margin-top: 8px; }
.presets button { flex: 1; text-align: center; padding: 5px 0; border-radius: 8px; cursor: pointer; font-variant-numeric: tabular-nums; }
.presets button:hover { background: var(--hover); }
.presets button.on { background: var(--accent); color: #fff; }
.voices { width: 320px; left: 50%; transform: translateX(-50%); padding: 8px; }
.tabs { display: flex; gap: 4px; padding: 2px; background: var(--hover); border-radius: 10px; margin-bottom: 8px; }
.tabs button { flex: 1; text-align: center; padding: 6px 0; border-radius: 8px; cursor: pointer; font-weight: 600; font-size: 12px; color: var(--muted); }
.tabs button.on { background: var(--pop); color: var(--fg); box-shadow: 0 1px 3px rgba(0,0,0,.15); }
.tabs button.off { opacity: .45; }
.search { all: unset; display: block; width: 100%; box-sizing: border-box; padding: 7px 10px; border-radius: 9px;
  border: 1px solid var(--line); margin-bottom: 6px; font-size: 13px; }
.search:focus { border-color: var(--accent); }
.list { max-height: 300px; overflow: auto; overscroll-behavior: contain; }
.item { padding: 7px 9px; border-radius: 8px; cursor: pointer; display: flex; justify-content: space-between; gap: 8px; }
.item:hover { background: var(--hover); }
.item.on { background: var(--accent); color: #fff; }
.item.on .sub { color: rgba(255,255,255,.8); }
.item .sub { color: var(--muted); font-size: 11.5px; white-space: nowrap; }
.empty { padding: 14px 8px; color: var(--muted); text-align: center; line-height: 1.5; }
.empty a { color: var(--accent); cursor: pointer; font-weight: 600; }
.gutter { position: fixed; z-index: 2147483646; width: 26px; height: 26px; border-radius: 50%;
  background: #2f6fed; color: #fff; display: none; place-items: center; cursor: pointer;
  box-shadow: 0 3px 10px rgba(0,0,0,.25); transition: transform .1s; }
.gutter:hover { transform: scale(1.1); }
.gutter.show { display: grid; }
.gutter svg { width: 16px; height: 16px; }
`;

  function mountUI() {
    host = document.createElement('aloud-reader');
    host.style.cssText = 'position:fixed;top:0;left:0;width:0;height:0;z-index:2147483647;';
    root = host.attachShadow({ mode: 'closed' });
    try {
      const sheet = new CSSStyleSheet();
      sheet.replaceSync(CSS_TEXT);
      root.adoptedStyleSheets = [sheet];
      if (!root.adoptedStyleSheets.length) throw new Error('not adopted');
    } catch (_) {
      // Firefox content scripts can't always adopt constructed sheets.
      root.append(h('style', { text: CSS_TEXT }));
    }

    ui.play = h('button', { class: 'play', title: 'Play / pause', 'aria-label': 'Play', onclick: togglePlay });
    ui.voiceLbl = h('span', { class: 'lbl' });
    ui.voiceBtn = h('button', { class: 'pill', title: 'Voice', 'aria-expanded': 'false', onclick: () => togglePop('voices') },
      icon('voice'), ui.voiceLbl, h('span', { class: 'caret' }, icon('caret')));
    ui.rateBtn = h('button', { class: 'pill rate', title: 'Reading speed', 'aria-expanded': 'false', onclick: () => togglePop('speed') });

    // speed popover
    ui.rateVal = h('span', { class: 'val' });
    ui.rateRange = h('input', { type: 'range', min: '0.5', max: '3', step: '0.05' });
    ui.rateRange.addEventListener('input', () => applyRate(parseFloat(ui.rateRange.value)));
    ui.presets = h('div', { class: 'presets' },
      [0.75, 1, 1.25, 1.5, 1.75, 2].map((v) => h('button', { 'data-v': String(v), text: `${v}×`, onclick: () => applyRate(v) })));
    ui.speed = h('div', { class: 'pop speed' }, h('div', { class: 'row' }, h('span', { text: 'Speed' }), ui.rateVal), ui.rateRange, ui.presets);

    // voices popover
    ui.tabs = h('div', { class: 'tabs' },
      ['azure', 'elevenlabs', 'browser'].map((p) =>
        h('button', { 'data-p': p, text: { azure: 'Azure', elevenlabs: 'ElevenLabs', browser: 'Basic' }[p], onclick: () => chooseProvider(p) })));
    ui.search = h('input', { class: 'search', type: 'text', placeholder: 'Search voices…', spellcheck: 'false' });
    ui.search.addEventListener('input', renderVoices);
    ui.list = h('div', { class: 'list' });
    ui.voices = h('div', { class: 'pop voices' }, ui.tabs, ui.search, ui.list);

    ui.statusMsg = h('span', { class: 'msg' });
    ui.statusAct = h('span', { class: 'act', onclick: () => send({ cmd: 'openOptions' }) });
    ui.status = h('div', { class: 'status', role: 'status' }, ui.statusMsg, ui.statusAct);

    ui.grip = h('div', { class: 'grip', title: 'Drag to move' }, icon('grip'));
    ui.bar = h('div', { class: 'bar', role: 'toolbar', 'aria-label': 'Read aloud' },
      ui.grip,
      h('button', { class: 'ib', title: 'Previous paragraph (Alt+Shift+←)', 'aria-label': 'Previous paragraph', onclick: () => jumpPara(-1) }, icon('prev')),
      ui.play,
      h('button', { class: 'ib', title: 'Next paragraph (Alt+Shift+→)', 'aria-label': 'Next paragraph', onclick: () => jumpPara(1) }, icon('next')),
      h('div', { class: 'sep' }),
      ui.voiceBtn,
      ui.rateBtn,
      h('div', { class: 'sep' }),
      h('button', { class: 'ib', title: 'Settings', 'aria-label': 'Settings', onclick: () => send({ cmd: 'openOptions' }) }, icon('gear')),
      h('button', { class: 'ib', title: 'Close (Esc)', 'aria-label': 'Close', onclick: close }, icon('close')),
      ui.speed, ui.voices, ui.status);

    ui.gutter = h('div', { class: 'gutter', title: 'Read from here', role: 'button', onclick: onGutterClick }, icon('play'));
    ui.gutter.addEventListener('mouseenter', () => clearTimeout(gutterTimer));
    ui.gutter.addEventListener('mouseleave', hideGutterSoon);

    // Keep page shortcuts from firing while typing in our search box.
    for (const t of ['keydown', 'keyup', 'keypress']) ui.bar.addEventListener(t, (e) => {
      if (e.key === 'Escape') { closePops(); e.stopPropagation(); return; }
      e.stopPropagation();
    });
    setupDrag();

    root.append(ui.bar, ui.gutter);
    (document.body || document.documentElement).append(host);

    document.addEventListener('mousemove', onMove, { passive: true, capture: true });
    document.addEventListener('click', onAltClick, true);
    document.addEventListener('keydown', onKey, true);
    document.addEventListener('mousedown', onDocDown, true);
    window.addEventListener('scroll', onScroll, { passive: true, capture: true });
    for (const t of ['wheel', 'touchmove']) window.addEventListener(t, markUserScroll, { passive: true });
    window.addEventListener('pagehide', close);
    // Firefox suspends idle background pages; keep the audio player alive while reading.
    if (FRA.IS_FIREFOX) ui.keepalive = setInterval(() => {
      if (P.engine === 'cloud' && (P.state === 'playing' || P.state === 'loading')) send({ cmd: 'keepalive' });
    }, 10000);
    isOpen = true;
    P.raf = requestAnimationFrame(tick);
    refreshUI();
  }

  function close() {
    if (!isOpen) return;
    stopEngine();
    clearHighlights();
    cancelAnimationFrame(P.raf);
    P.U = [];
    P.state = 'idle';
    document.removeEventListener('mousemove', onMove, { capture: true });
    document.removeEventListener('click', onAltClick, true);
    document.removeEventListener('keydown', onKey, true);
    document.removeEventListener('mousedown', onDocDown, true);
    window.removeEventListener('scroll', onScroll, { capture: true });
    for (const t of ['wheel', 'touchmove']) window.removeEventListener(t, markUserScroll);
    window.removeEventListener('pagehide', close);
    clearInterval(ui.keepalive);
    if (host) host.remove();
    host = root = null;
    isOpen = false;
  }

  function setupDrag() {
    let sx = 0, sy = 0, ox = 0, oy = 0, dragging = false;
    ui.grip.addEventListener('pointerdown', (e) => {
      const r = ui.bar.getBoundingClientRect();
      dragging = true; sx = e.clientX; sy = e.clientY; ox = r.left; oy = r.top;
      ui.grip.setPointerCapture(e.pointerId);
      e.preventDefault();
    });
    ui.grip.addEventListener('pointermove', (e) => {
      if (!dragging) return;
      const r = ui.bar.getBoundingClientRect();
      const x = Math.max(4, Math.min(window.innerWidth - r.width - 4, ox + e.clientX - sx));
      const y = Math.max(4, Math.min(window.innerHeight - r.height - 4, oy + e.clientY - sy));
      ui.bar.style.left = `${x}px`; ui.bar.style.top = `${y}px`; ui.bar.style.transform = 'none';
    });
    ui.grip.addEventListener('pointerup', () => { dragging = false; });
  }

  function setState(st) {
    P.state = st;
    if (!isOpen) return;
    ui.play.replaceChildren(st === 'loading' ? h('div', { class: 'spin' }) : icon(st === 'playing' ? 'pause' : 'play'));
    ui.play.setAttribute('aria-label', st === 'playing' || st === 'loading' ? 'Pause' : 'Play');
  }

  function voiceLabel() {
    if (S.provider === 'azure' && cloudReady()) return FRA.prettyAzure(S.azureVoice);
    if (S.provider === 'elevenlabs' && cloudReady()) return S.elevenVoiceName || 'ElevenLabs';
    return S.browserVoice ? S.browserVoice.replace(/^(Microsoft|Google)\s+/, '').replace(/\s*-.*$/, '') : 'Basic voice';
  }

  function refreshUI() {
    if (!isOpen) return;
    ui.voiceLbl.textContent = voiceLabel();
    const tenths = Math.round(S.rate * 100) % 10 === 0;
    ui.rateBtn.textContent = `${S.rate.toFixed(tenths ? 1 : 2)}×`;
    ui.rateVal.textContent = `${S.rate.toFixed(2)}×`;
    ui.rateRange.value = String(S.rate);
    for (const b of ui.presets.children) b.classList.toggle('on', Math.abs(parseFloat(b.dataset.v) - S.rate) < 0.001);
    if (ui.voices.classList.contains('show')) renderVoices();
    setState(P.state);
  }

  let statusTimer = 0;
  function setStatus(msg, ms = 4000, kind = '', action = null) {
    if (!isOpen) return;
    clearTimeout(statusTimer);
    ui.statusMsg.textContent = msg;
    ui.statusAct.textContent = action || '';
    ui.statusAct.style.display = action ? '' : 'none';
    ui.status.className = `status show ${kind}`;
    if (ms) statusTimer = setTimeout(() => ui.status.classList.remove('show'), ms);
  }
  let hinted = false;
  function hintOnce(msg) { if (!hinted) { hinted = true; setStatus(msg, 7000, '', 'Settings'); } }

  // popovers
  function togglePop(which) {
    const pop = which === 'speed' ? ui.speed : ui.voices;
    const btn = which === 'speed' ? ui.rateBtn : ui.voiceBtn;
    const show = !pop.classList.contains('show');
    closePops();
    if (!show) return;
    pop.classList.add('show');
    btn.setAttribute('aria-expanded', 'true');
    ui.status.classList.remove('show');
    if (which === 'voices') { ui.search.value = ''; voiceTab = S.provider; loadVoices().then(renderVoices); renderVoices(); setTimeout(() => ui.search.focus(), 0); }
  }
  function closePops() {
    if (!isOpen) return false;
    const was = ui.speed.classList.contains('show') || ui.voices.classList.contains('show');
    ui.speed.classList.remove('show');
    ui.voices.classList.remove('show');
    ui.rateBtn.setAttribute('aria-expanded', 'false');
    ui.voiceBtn.setAttribute('aria-expanded', 'false');
    return was;
  }
  function onDocDown(e) {
    if (e.composedPath().includes(host)) return; // closed shadow root: inner nodes aren't exposed
    closePops();
  }

  let voiceTab = 'azure';
  const voiceCache = { azure: null, elevenlabs: null, browser: null };
  async function loadVoices() {
    const st = await ext.storage.local.get(['azureVoices', 'elevenVoices']);
    voiceCache.azure = st.azureVoices || null;
    voiceCache.elevenlabs = st.elevenVoices || null;
    if (!voiceCache.browser) voiceCache.browser = await Local.list();
  }
  function providerConfigured(p) {
    if (p === 'azure') return !!(S.azureKey && S.azureRegion);
    if (p === 'elevenlabs') return !!S.elevenKey;
    return true;
  }
  function chooseProvider(p) {
    voiceTab = p;
    renderVoices();
  }
  function renderVoices() {
    if (!isOpen) return;
    for (const b of ui.tabs.children) {
      b.classList.toggle('on', b.dataset.p === voiceTab);
      b.classList.toggle('off', !providerConfigured(b.dataset.p));
    }
    ui.list.replaceChildren();
    if (!providerConfigured(voiceTab)) {
      ui.search.style.display = 'none';
      ui.list.append(h('div', { class: 'empty' },
        `${voiceTab === 'azure' ? 'Azure' : 'ElevenLabs'} needs an API key. `,
        h('a', { text: 'Open settings', onclick: () => send({ cmd: 'openOptions' }) })));
      return;
    }
    ui.search.style.display = '';
    let voices = voiceCache[voiceTab];
    if (!Array.isArray(voices) || !voices.length) {
      ui.list.append(h('div', { class: 'empty' }, voiceTab === 'browser' ? 'No voices found.' : 'Voices not loaded yet. ',
        voiceTab === 'browser' ? null : h('a', { text: 'Load them in settings', onclick: () => send({ cmd: 'openOptions' }) })));
      return;
    }
    const current = voiceTab === 'azure' ? S.azureVoice : voiceTab === 'elevenlabs' ? S.elevenVoice : S.browserVoice;
    const active = S.provider === voiceTab;
    const q = ui.search.value.trim().toLowerCase();
    const lang = LANG.slice(0, 2).toLowerCase();
    if (q) {
      voices = voices.filter((v) => `${v.id} ${v.name} ${v.locale} ${v.localeName || ''} ${v.gender}`.toLowerCase().includes(q));
    } else if (voiceTab === 'azure') {
      voices = voices.filter((v) => v.multi || v.locale.toLowerCase().startsWith(lang) || v.id === current);
    } else if (voiceTab === 'browser') {
      const pref = voices.filter((v) => !v.locale || v.locale.toLowerCase().startsWith(lang) || v.id === current);
      if (pref.length) voices = pref;
    }
    for (const v of voices.slice(0, 300)) {
      const name = voiceTab === 'azure' ? FRA.prettyAzure(v.id) : v.name;
      const sub = voiceTab === 'azure' ? `${v.locale}${v.gender ? ' · ' + v.gender : ''}` : [v.locale, v.gender].filter(Boolean).join(' · ');
      ui.list.append(h('div', { class: `item${active && v.id === current ? ' on' : ''}`, onclick: () => pickVoice(voiceTab, v) },
        h('span', { class: 'lbl', text: name }), h('span', { class: 'sub', text: sub })));
    }
    if (!voices.length) ui.list.append(h('div', { class: 'empty', text: 'No matches.' }));
  }
  function pickVoice(p, v) {
    const o = { provider: p };
    if (p === 'azure') o.azureVoice = v.id;
    else if (p === 'elevenlabs') { o.elevenVoice = v.id; o.elevenVoiceName = v.name; }
    else o.browserVoice = v.id;
    FRA.setSettings(o); // storage.onChanged applies it and restarts the sentence
    closePops();
  }

  // gutter "read from here" button
  let gutterFi = -1;
  let gutterTimer = 0;
  let moveRaf = 0;
  let lastMove = null;
  function onMove(e) {
    lastMove = e;
    if (moveRaf) return;
    moveRaf = requestAnimationFrame(() => {
      moveRaf = 0;
      const ev = lastMove;
      if (!EX || !ev || !isOpen) return;
      if (ev.composedPath().includes(host)) return;
      const list = P.list || defaultList();
      let fi = -1;
      for (let a = ev.target; a && a.nodeType === 1 && a !== document.body; a = a.parentElement) {
        const idx = list.elIdx.get(a);
        if (idx != null) { fi = idx; break; }
      }
      if (fi < 0) return hideGutterSoon();
      showGutter(fi, list);
    });
  }
  function showGutter(fi, list) {
    clearTimeout(gutterTimer);
    const f = list[fi];
    const m = f && f.map[0];
    if (!m || !m.n.isConnected) return;
    const r = document.createRange();
    r.setStart(m.n, m.o);
    r.setEnd(m.n, Math.min(m.o + 1, m.n.nodeValue.length));
    const cr = r.getBoundingClientRect();
    const er = f.el.getBoundingClientRect();
    if (!cr.height) return;
    gutterFi = fi;
    ui.gutter.dataset.list = list === EX.full ? 'full' : 'smart';
    const left = er.left > 40 ? er.left - 34 : Math.max(4, cr.left - 32);
    ui.gutter.style.left = `${left}px`;
    ui.gutter.style.top = `${cr.top + cr.height / 2 - 13}px`;
    ui.gutter.classList.add('show');
  }
  function hideGutterSoon() {
    clearTimeout(gutterTimer);
    gutterTimer = setTimeout(() => ui.gutter && ui.gutter.classList.remove('show'), 700);
  }
  function onGutterClick() {
    if (gutterFi < 0 || !EX) return;
    const list = ui.gutter.dataset.list === 'full' ? EX.full : (EX.smart || EX.full);
    ui.gutter.classList.remove('show');
    lastUserScroll = 0;
    startAt(list, gutterFi, 0, null);
  }
  function onScroll() {
    if (ui.gutter) ui.gutter.classList.remove('show');
  }
  function markUserScroll() { lastUserScroll = performance.now(); }

  // Alt+click anywhere: read from that sentence.
  function caretAt(x, y) {
    if (document.caretPositionFromPoint) {
      const p = document.caretPositionFromPoint(x, y);
      return p && { node: p.offsetNode, offset: p.offset };
    }
    const r = document.caretRangeFromPoint && document.caretRangeFromPoint(x, y);
    return r && { node: r.startContainer, offset: r.startOffset };
  }
  function onAltClick(e) {
    if (!e.altKey || e.button !== 0 || !EX) return;
    if (e.composedPath().includes(host)) return;
    const pos = caretAt(e.clientX, e.clientY);
    if (!pos) return;
    let list = P.list || defaultList();
    let loc = locate(list, pos.node, pos.offset, true);
    if (!loc || !list[loc.fi].el.contains(pos.node.nodeType === 3 ? pos.node.parentElement : pos.node)) {
      list = EX.full;
      loc = locate(list, pos.node, pos.offset, true);
    }
    if (!loc) return;
    e.preventDefault();
    e.stopPropagation();
    const text = list[loc.fi].text;
    const seg = text.length ? segS.segment(text).containing(Math.min(loc.ci, text.length - 1)) : null;
    lastUserScroll = 0;
    startAt(list, loc.fi, seg ? seg.index : loc.ci, null);
  }

  function onKey(e) {
    if (e.key === 'Escape') {
      if (e.composedPath().includes(host)) return;
      const t = e.target;
      if (t && (t.isContentEditable || /^(input|textarea|select)$/i.test(t.tagName))) return;
      if (!closePops()) close();
      return;
    }
    if (['PageDown', 'PageUp', 'ArrowDown', 'ArrowUp', 'Home', 'End', ' '].includes(e.key)) markUserScroll();
  }

  // ───────────────────────── entry points ─────────────────────────
  async function open(mode = 'auto') {
    await ready;
    if (!isOpen) mountUI();
    extract();

    const sel = window.getSelection();
    const hasSel = sel && sel.rangeCount && !sel.isCollapsed && sel.toString().trim();
    if (hasSel && mode !== 'page') {
      const r = sel.getRangeAt(0);
      const readOnly = mode === 'selection';
      for (const list of [defaultList(), EX.full]) {
        const a = locate(list, r.startContainer, r.startOffset, true);
        if (!a) continue;
        const b = readOnly ? locate(list, r.endContainer, r.endOffset, false) : null;
        if (readOnly && (!b || b.fi < a.fi || (b.fi === a.fi && b.ci <= a.ci))) continue;
        lastUserScroll = 0;
        startAt(list, a.fi, a.ci, b);
        return;
      }
    }
    if (!EX.full.length) { setStatus('Nothing readable on this page.', 4000, 'error'); return; }
    const list = defaultList();
    lastUserScroll = 0;
    startAt(list, firstVisible(list));
    if (!cloudReady() && S.provider === 'browser') {
      hintOnce('Using basic voices. Add an Azure or ElevenLabs key in ⚙ for natural ones.');
    }
  }

  ext.runtime.onMessage.addListener((m, _sender, sendResponse) => {
    if (!m || !m.cmd) return;
    switch (m.cmd) {
      case 'ping': sendResponse({ pong: true }); return;
      case 'toggle': if (isOpen) close(); else open('auto'); return;
      case 'start': open(m.mode); return;
      case 'playpause': if (!isOpen) open('auto'); else togglePlay(); return;
      case 'next': if (isOpen) jumpPara(1); return;
      case 'prev': if (isOpen) jumpPara(-1); return;
      case 'evt': onEvt(m); return;
    }
  });

})();
