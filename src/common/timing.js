// Word timing: exact (ElevenLabs alignment) or estimated (Azure REST has no word events).
(() => {
  'use strict';

  const RE_SPACE = /\s/;
  const RE_STOP = /[.!?。！？…]/;
  const RE_PAUSE = /[,;:，、；：]/;
  const RE_DASH = /[—–]/;
  const RE_NUM = /\p{N}/u;
  const RE_HAN = /\p{Script=Han}/u;
  const RE_KANA = /[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
  const RE_LETTER = /\p{L}/u;

  // Rough "how long does this character take to say" weight.
  function charWeight(ch) {
    if (RE_SPACE.test(ch)) return 0.5;
    if (RE_STOP.test(ch)) return 6;
    if (RE_PAUSE.test(ch)) return 3;
    if (RE_DASH.test(ch)) return 2;
    if (RE_NUM.test(ch)) return 2.2;
    if (RE_HAN.test(ch)) return 2.6;
    if (RE_KANA.test(ch)) return 1.7;
    if (RE_LETTER.test(ch)) return 1;
    return 0.3;
  }

  // words: [[start, end], ...] offsets into text. Returns start time (s) per word.
  function estimateMarks(text, words, t0, t1) {
    if (!words.length) return [];
    const cum = new Float64Array(text.length + 1);
    for (let i = 0; i < text.length; i++) cum[i + 1] = cum[i] + charWeight(text[i]);
    const end = cum[words[words.length - 1][1]] || cum[text.length] || 1;
    const span = Math.max(0.05, t1 - t0);
    return words.map(([s]) => t0 + (span * cum[s]) / end);
  }

  // alignment: { characters: [...], character_start_times_seconds: [...] }
  function marksFromAlignment(alignment, text, words) {
    const chars = alignment && alignment.characters;
    const starts = alignment && alignment.character_start_times_seconds;
    if (!chars || !starts || !chars.length || chars.length !== starts.length) return null;

    const at = new Array(text.length).fill(-1);
    let j = 0;
    for (let k = 0; k < text.length && j < chars.length; k++) {
      const c = text[k];
      if (chars[j] === c) { at[k] = starts[j++]; continue; }
      for (let d = 1; d <= 6 && j + d < chars.length; d++) {
        if (chars[j + d] === c) { j += d; at[k] = starts[j++]; break; }
      }
    }

    let missing = 0;
    const marks = words.map(([s, e]) => {
      for (let k = s; k < e; k++) if (at[k] >= 0) return at[k];
      missing++;
      return -1;
    });
    if (missing > words.length * 0.4) return null;
    let last = 0;
    for (let i = 0; i < marks.length; i++) {
      if (marks[i] < 0 || marks[i] < last) marks[i] = last;
      last = marks[i];
    }
    return marks;
  }

  // Leading/trailing silence of decoded audio, so estimates line up with actual speech.
  function silenceBounds(samples, sampleRate) {
    let peak = 0;
    for (let i = 0; i < samples.length; i++) {
      const a = Math.abs(samples[i]);
      if (a > peak) peak = a;
    }
    const th = Math.max(0.004, peak * 0.04);
    let a = 0;
    while (a < samples.length && Math.abs(samples[a]) < th) a++;
    let b = samples.length - 1;
    while (b > a && Math.abs(samples[b]) < th) b--;
    return { lead: a / sampleRate, tail: (samples.length - 1 - b) / sampleRate };
  }

  globalThis.FRATiming = { estimateMarks, marksFromAlignment, silenceBounds, charWeight };
})();
