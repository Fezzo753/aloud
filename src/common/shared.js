// Shared settings + speech-provider calls.
// Loaded by the background, the audio player, the options page and the content script.
// `ext` is the extension API: `browser` on Firefox, `chrome` on Chrome.
globalThis.ext = globalThis.ext || globalThis.browser || globalThis.chrome;

(() => {
  'use strict';
  if (globalThis.FRA) return;

  const IS_FIREFOX = ext.runtime.getURL('').startsWith('moz-extension:');
  const PERM_HINT = IS_FIREFOX ? ' If the region is right, Firefox may be blocking access — open Aloud settings and click Allow access.' : '';

  const DEFAULTS = {
    provider: 'browser',              // 'azure' | 'elevenlabs' | 'browser'
    azureKey: '',
    azureRegion: 'australiaeast',
    azureVoice: 'en-US-AvaMultilingualNeural',
    elevenKey: '',
    elevenModel: 'eleven_flash_v2_5',
    elevenVoice: '',
    elevenVoiceName: '',
    browserVoice: '',
    rate: 1,
    smart: true,                      // skip menus, ads, comments, footers
    autoscroll: true,
    highlight: 'word',                // 'word' | 'sentence' | 'none'
  };

  class TTSError extends Error {
    constructor(message, code) { super(message); this.code = code; }
  }

  const getSettings = () => ext.storage.local.get(DEFAULTS);
  const setSettings = (o) => ext.storage.local.set(o);

  const escapeXml = (s) => s.replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[c]));

  const azureLocale = (voice) => {
    const i = (voice || '').lastIndexOf('-');
    return i > 0 ? voice.slice(0, i) : 'en-US';
  };

  // "en-US-AvaMultilingualNeural" -> "Ava (Multilingual)"
  const prettyAzure = (voice) => {
    const base = (voice || '').slice((voice || '').lastIndexOf('-') + 1).replace(/Neural$/, '');
    const m = /^(.*?)(Multilingual|Turbo|HD)?$/.exec(base);
    return m && m[2] ? `${m[1]} (${m[2]})` : base || voice;
  };

  function azureError(status) {
    switch (status) {
      case 400: return 'Azure rejected the request — the voice may not exist in your region.';
      case 401: return 'Azure rejected the key. Check the key and region in settings.';
      case 403: return 'Azure denied access. Check the key matches the region.';
      case 429: return 'Azure rate limit or free-tier quota hit. Wait a bit or check your plan.';
      default: return `Azure speech error (HTTP ${status}).`;
    }
  }

  async function azureFetch(cfg, path, init) {
    const region = (cfg.azureRegion || '').trim().toLowerCase();
    if (!cfg.azureKey) throw new TTSError('Add your Azure Speech key in settings.', 'nokey');
    if (!region) throw new TTSError('Add your Azure region in settings.', 'nokey');
    let res;
    try {
      res = await fetch(`https://${region}.tts.speech.microsoft.com${path}`, {
        ...init,
        headers: { 'Ocp-Apim-Subscription-Key': cfg.azureKey.trim(), ...(init && init.headers) },
      });
    } catch (e) {
      throw new TTSError(`Couldn't reach Azure region "${region}". Check the region name.${PERM_HINT}`, 'network');
    }
    if (!res.ok) throw new TTSError(azureError(res.status), 'http' + res.status);
    return res;
  }

  async function azureSynth(cfg, text) {
    const voice = cfg.azureVoice || DEFAULTS.azureVoice;
    const ssml =
      `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="${azureLocale(voice)}">` +
      `<voice name="${escapeXml(voice)}">${escapeXml(text)}</voice></speak>`;
    const res = await azureFetch(cfg, '/cognitiveservices/v1', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/ssml+xml',
        'X-Microsoft-OutputFormat': 'audio-24khz-96kbitrate-mono-mp3',
      },
      body: ssml,
    });
    return res.arrayBuffer();
  }

  async function listAzureVoices(cfg) {
    const res = await azureFetch(cfg, '/cognitiveservices/voices/list', { method: 'GET' });
    const raw = await res.json();
    return raw
      .filter((v) => !v.VoiceType || v.VoiceType === 'Neural')
      .map((v) => ({
        id: v.ShortName,
        name: v.LocalName && v.LocalName !== v.DisplayName ? `${v.DisplayName} · ${v.LocalName}` : v.DisplayName,
        locale: v.Locale,
        localeName: v.LocaleName || v.Locale,
        gender: v.Gender || '',
        multi: /Multilingual/i.test(v.ShortName) || (v.SecondaryLocaleList && v.SecondaryLocaleList.length > 0),
      }))
      .sort((a, b) => a.locale.localeCompare(b.locale) || a.id.localeCompare(b.id));
  }

  function b64ToBuf(b64) {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out.buffer;
  }

  async function elevenFetch(cfg, path, init) {
    if (!cfg.elevenKey) throw new TTSError('Add your ElevenLabs API key in settings.', 'nokey');
    let res;
    try {
      res = await fetch(`https://api.elevenlabs.io${path}`, {
        ...init,
        headers: { 'xi-api-key': cfg.elevenKey.trim(), ...(init && init.headers) },
      });
    } catch (e) {
      throw new TTSError(`Couldn't reach ElevenLabs.${PERM_HINT}`, 'network');
    }
    if (!res.ok) {
      let detail = '';
      try {
        const j = await res.json();
        detail = (j.detail && (j.detail.message || j.detail.status || (typeof j.detail === 'string' ? j.detail : ''))) || '';
      } catch (_) { /* ignore */ }
      const base = res.status === 401 ? 'ElevenLabs rejected the API key.'
        : res.status === 429 ? 'ElevenLabs rate limit or quota hit.'
        : `ElevenLabs error (HTTP ${res.status}).`;
      throw new TTSError(detail ? `${base} ${detail}` : base, 'http' + res.status);
    }
    return res;
  }

  async function elevenSynth(cfg, item) {
    if (!cfg.elevenVoice) throw new TTSError('Pick an ElevenLabs voice in settings.', 'nokey');
    const body = { text: item.text, model_id: cfg.elevenModel || DEFAULTS.elevenModel };
    if (item.prev) body.previous_text = item.prev.slice(-400);
    if (item.next) body.next_text = item.next.slice(0, 400);
    const res = await elevenFetch(
      cfg,
      `/v1/text-to-speech/${encodeURIComponent(cfg.elevenVoice)}/with-timestamps?output_format=mp3_44100_128`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
    );
    const j = await res.json();
    if (!j.audio_base64) throw new TTSError('ElevenLabs returned no audio.', 'empty');
    return { buf: b64ToBuf(j.audio_base64), alignment: j.alignment || j.normalized_alignment || null };
  }

  async function listElevenVoices(cfg) {
    const res = await elevenFetch(cfg, '/v1/voices', { method: 'GET' });
    const j = await res.json();
    return (j.voices || [])
      .map((v) => {
        const l = v.labels || {};
        return {
          id: v.voice_id,
          name: v.name,
          locale: [l.accent, l.language].filter(Boolean).join(' · '),
          gender: l.gender || '',
          category: v.category || '',
        };
      })
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  globalThis.FRA = {
    IS_FIREFOX, DEFAULTS, TTSError, getSettings, setSettings,
    azureSynth, listAzureVoices, azureLocale, prettyAzure,
    elevenSynth, listElevenVoices,
  };
})();
