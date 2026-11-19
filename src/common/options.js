(() => {
  'use strict';
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));

  let S = { ...FRA.DEFAULTS };

  // Basic voices: chrome.tts on Chrome, Web Speech on Firefox.
  const LocalTTS = FRA.IS_FIREFOX ? {
    voices(cb) {
      const ss = speechSynthesis;
      const done = () => cb(ss.getVoices().map((v) => ({ voiceName: v.name, lang: v.lang })));
      if (ss.getVoices().length) return done();
      ss.addEventListener('voiceschanged', done, { once: true });
      setTimeout(done, 1500);
    },
    stop() { speechSynthesis.cancel(); },
    speak(text, { rate, voiceName, onError }) {
      const u = new SpeechSynthesisUtterance(text);
      u.rate = rate;
      const v = voiceName && speechSynthesis.getVoices().find((x) => x.name === voiceName);
      if (v) u.voice = v;
      u.onerror = (e) => { if (e.error !== 'interrupted' && e.error !== 'canceled') onError(e.error || 'Voice failed.'); };
      speechSynthesis.speak(u);
    },
  } : {
    voices(cb) { ext.tts.getVoices(cb); },
    stop() { ext.tts.stop(); },
    speak(text, { rate, voiceName, onError }) {
      ext.tts.speak(text, { rate, voiceName: voiceName || undefined, onEvent: (e) => { if (e.type === 'error') onError(e.errorMessage || 'Voice failed.'); } });
    },
  };

  // Firefox lets people switch off an add-on's site access; check we can reach the voice services.
  async function checkAccess() {
    if (!FRA.IS_FIREFOX) return;
    const origins = ext.runtime.getManifest().host_permissions || [];
    const ok = await ext.permissions.contains({ origins });
    $('#perm').hidden = ok;
  }
  const voices = { azure: [], elevenlabs: [], browser: [] };
  let previewAudio = null;

  // ── saving ──
  let savedTimer = 0;
  function flashSaved() {
    const el = $('#saved');
    el.textContent = 'Saved';
    el.classList.add('show');
    clearTimeout(savedTimer);
    savedTimer = setTimeout(() => el.classList.remove('show'), 1400);
  }
  async function save(patch) {
    Object.assign(S, patch);
    await FRA.setSettings(patch);
    flashSaved();
  }
  const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };

  // ── engine panels ──
  function showPanel() {
    for (const r of $$('input[name=provider]')) r.checked = r.value === S.provider;
    for (const p of $$('.panel')) p.classList.toggle('show', p.dataset.panel === S.provider);
  }

  // ── voice lists ──
  const currentVoice = (p) => (p === 'azure' ? S.azureVoice : p === 'elevenlabs' ? S.elevenVoice : S.browserVoice);

  function renderVoices(p) {
    const sel = $(`.vselect[data-p="${p}"]`);
    const q = $(`.vsearch[data-p="${p}"]`).value.trim().toLowerCase();
    const cur = currentVoice(p);
    let list = voices[p];
    if (q) list = list.filter((v) => `${v.id} ${v.name} ${v.locale} ${v.localeName || ''} ${v.gender}`.toLowerCase().includes(q));
    sel.replaceChildren();

    const groups = new Map();
    for (const v of list) {
      const g = p === 'azure' ? `${v.localeName || v.locale}` : p === 'browser' ? (v.locale || 'Other') : (v.category ? cap(v.category) : 'Voices');
      if (!groups.has(g)) groups.set(g, []);
      groups.get(g).push(v);
    }
    for (const [g, vs] of groups) {
      const og = document.createElement('optgroup');
      og.label = g;
      for (const v of vs) {
        const o = document.createElement('option');
        o.value = v.id;
        o.textContent = p === 'azure'
          ? `${FRA.prettyAzure(v.id)}${v.gender ? ' — ' + v.gender : ''}${v.multi ? ' · speaks many languages' : ''}`
          : `${v.name}${v.locale && p !== 'browser' ? ' — ' + v.locale : ''}${v.gender ? ' · ' + v.gender : ''}`;
        o.selected = v.id === cur;
        og.append(o);
      }
      sel.append(og);
    }
    const hint = $(`.hint[data-hint="${p}"]`);
    if (hint && p !== 'browser') {
      if (!voices[p].length) hint.textContent = 'Add your key, then Load voices.';
      else hint.textContent = `${voices[p].length} voices. Selected: ${p === 'azure' ? (cur || '—') : (S.elevenVoiceName || '—')}`;
    }
    const opt = sel.querySelector('option:checked');
    if (opt) opt.scrollIntoView({ block: 'nearest' });
  }
  const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

  async function loadVoices(p, quiet) {
    const btn = $(`[data-load="${p}"]`);
    const hint = $(`.hint[data-hint="${p}"]`);
    if (btn) { btn.disabled = true; btn.textContent = 'Loading…'; }
    try {
      const list = p === 'azure' ? await FRA.listAzureVoices(S) : await FRA.listElevenVoices(S);
      voices[p] = list;
      await ext.storage.local.set({ [p === 'azure' ? 'azureVoices' : 'elevenVoices']: list });
      if (p === 'elevenlabs' && list.length && !list.some((v) => v.id === S.elevenVoice)) {
        await save({ elevenVoice: list[0].id, elevenVoiceName: list[0].name });
      }
      if (p === 'azure' && list.length && !list.some((v) => v.id === S.azureVoice)) {
        const pick = list.find((v) => v.id === FRA.DEFAULTS.azureVoice) || list.find((v) => v.locale === 'en-AU') || list[0];
        await save({ azureVoice: pick.id });
      }
      renderVoices(p);
    } catch (e) {
      if (!quiet && hint) { hint.textContent = e.message || String(e); hint.classList.add('err'); }
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = 'Load voices'; }
    }
  }

  function loadBrowserVoices() {
    LocalTTS.voices((vs) => {
      voices.browser = (vs || [])
        .map((v) => ({ id: v.voiceName, name: v.voiceName, locale: v.lang || '', gender: '' }))
        .sort((a, b) => a.locale.localeCompare(b.locale) || a.name.localeCompare(b.name));
      renderVoices('browser');
    });
  }

  // ── preview ──
  async function preview() {
    const btn = $('#previewBtn');
    const err = $('#previewErr');
    err.textContent = '';
    const text = $('#sample').value.trim() || 'Hello.';
    if (previewAudio) { previewAudio.pause(); previewAudio = null; }
    LocalTTS.stop();

    if (S.provider === 'browser') {
      LocalTTS.speak(text, { rate: S.rate, voiceName: S.browserVoice, onError: (m) => { err.textContent = m; } });
      return;
    }
    btn.disabled = true;
    btn.textContent = 'Generating…';
    try {
      let buf;
      if (S.provider === 'azure') buf = await FRA.azureSynth(S, text);
      else ({ buf } = await FRA.elevenSynth(S, { text }));
      previewAudio = new Audio(URL.createObjectURL(new Blob([buf], { type: 'audio/mpeg' })));
      previewAudio.preservesPitch = true;
      previewAudio.playbackRate = S.rate;
      await previewAudio.play();
    } catch (e) {
      err.textContent = e.message || String(e);
    } finally {
      btn.disabled = false;
      btn.textContent = 'Preview';
    }
  }

  // ── usage ──
  async function showUsage() {
    const { usage } = await ext.storage.local.get('usage');
    const month = new Date().toISOString().slice(0, 7);
    const u = usage && usage.month === month ? usage : {};
    $('#useAzure').textContent = (u.azure || 0).toLocaleString();
    $('#useEleven').textContent = (u.elevenlabs || 0).toLocaleString();
  }

  // ── wire up ──
  async function init() {
    S = await FRA.getSettings();
    const cached = await ext.storage.local.get(['azureVoices', 'elevenVoices']);
    voices.azure = cached.azureVoices || [];
    voices.elevenlabs = cached.elevenVoices || [];

    $('#azureKey').value = S.azureKey;
    $('#azureRegion').value = S.azureRegion;
    $('#elevenKey').value = S.elevenKey;
    $('#elevenModel').value = S.elevenModel;
    $('#rate').value = S.rate;
    $('#rateOut').textContent = `${S.rate.toFixed(2)}×`;
    $('#highlight').value = S.highlight;
    $('#smart').checked = S.smart;
    $('#autoscroll').checked = S.autoscroll;
    showPanel();
    renderVoices('azure');
    renderVoices('elevenlabs');
    loadBrowserVoices();
    showUsage();

    for (const r of $$('input[name=provider]')) r.addEventListener('change', () => { save({ provider: r.value }); showPanel(); });

    const keyChanged = (p) => debounce(() => {
      if ((p === 'azure' && S.azureKey && S.azureRegion) || (p === 'elevenlabs' && S.elevenKey)) loadVoices(p, true);
    }, 700);
    const azReload = keyChanged('azure');
    const elReload = keyChanged('elevenlabs');
    $('#azureKey').addEventListener('input', (e) => { save({ azureKey: e.target.value.trim() }); azReload(); });
    $('#azureRegion').addEventListener('input', (e) => { save({ azureRegion: e.target.value.trim().toLowerCase().replace(/\s+/g, '') }); azReload(); });
    $('#elevenKey').addEventListener('input', (e) => { save({ elevenKey: e.target.value.trim() }); elReload(); });
    $('#elevenModel').addEventListener('change', (e) => save({ elevenModel: e.target.value }));

    for (const b of $$('.reveal')) b.addEventListener('click', () => {
      const inp = document.getElementById(b.dataset.for);
      inp.type = inp.type === 'password' ? 'text' : 'password';
      b.textContent = inp.type === 'password' ? 'Show' : 'Hide';
    });
    for (const b of $$('[data-load]')) b.addEventListener('click', () => {
      const h = $(`.hint[data-hint="${b.dataset.load}"]`);
      if (h) h.classList.remove('err');
      loadVoices(b.dataset.load);
    });
    for (const s of $$('.vsearch')) s.addEventListener('input', () => renderVoices(s.dataset.p));
    for (const sel of $$('.vselect')) sel.addEventListener('change', () => {
      const p = sel.dataset.p;
      const v = voices[p].find((x) => x.id === sel.value);
      if (!v) return;
      if (p === 'azure') save({ azureVoice: v.id });
      else if (p === 'elevenlabs') save({ elevenVoice: v.id, elevenVoiceName: v.name });
      else save({ browserVoice: v.id });
      renderVoices(p);
    });
    for (const sel of $$('.vselect')) sel.addEventListener('dblclick', preview);

    const rateSave = debounce((v) => save({ rate: v }), 250);
    $('#rate').addEventListener('input', (e) => {
      const v = parseFloat(e.target.value);
      $('#rateOut').textContent = `${v.toFixed(2)}×`;
      if (previewAudio) previewAudio.playbackRate = v;
      S.rate = v;
      rateSave(v);
    });
    $('#highlight').addEventListener('change', (e) => save({ highlight: e.target.value }));
    $('#smart').addEventListener('change', (e) => save({ smart: e.target.checked }));
    $('#autoscroll').addEventListener('change', (e) => save({ autoscroll: e.target.checked }));
    $('#previewBtn').addEventListener('click', preview);
    $('#sample').addEventListener('keydown', (e) => { if (e.key === 'Enter') preview(); });
    $('#shortcuts').addEventListener('click', () => {
      if (FRA.IS_FIREFOX) ext.commands.openShortcutSettings();
      else ext.tabs.create({ url: 'chrome://extensions/shortcuts' });
    });
    checkAccess();
    $('#permBtn').addEventListener('click', async () => {
      const origins = ext.runtime.getManifest().host_permissions || [];
      try { await ext.permissions.request({ origins }); } catch (_) { /* declined */ }
      checkAccess();
    });

    ext.storage.onChanged.addListener((ch, area) => {
      if (area !== 'local') return;
      if (ch.usage) showUsage();
      // Voice picked from the in-page toolbar while this page is open.
      for (const k of ['provider', 'azureVoice', 'elevenVoice', 'elevenVoiceName', 'browserVoice', 'rate']) {
        if (ch[k] && ch[k].newValue !== undefined && ch[k].newValue !== S[k]) {
          S[k] = ch[k].newValue;
          if (k === 'provider') showPanel();
          if (k === 'rate') { $('#rate').value = S.rate; $('#rateOut').textContent = `${S.rate.toFixed(2)}×`; }
        }
      }
    });
  }

  init();
})();
