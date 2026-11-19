# Aloud

Edge-style read-aloud extension for Chrome and Firefox (Manifest V3). Read `README.md` first: it covers install, voices, usage and known limits.

## Layout

- `src/common/` — code shared by both browsers: content script (`content.js`, `content.css`), audio player (`player.js`), word timing (`timing.js`), settings page (`options.*`), `shared.js`, icons.
- `src/chrome/` — Chrome manifest, background service worker, and the offscreen document that plays audio.
- `src/firefox/` — Firefox manifest and background page. Audio plays from the background page, with a keepalive so Firefox doesn't suspend it mid-read.
- `build.py` — copies `src/common` then `src/<target>` into `dist/<target>/`, fills placeholders, and zips.
- `VERSION` — the single source of the version number.

Voices: Azure Neural (word timing estimated), ElevenLabs (exact word timestamps from the API), or the browser's built-in voices.

## Build

```bash
python build.py            # dist/aloud-chrome-<version>.zip and dist/aloud-firefox-<version>.zip
python build.py firefox    # one browser only
```

No dependencies beyond the Python standard library. `dist/` is git-ignored.

The Chrome zip holds an `aloud/` folder (unzip, then Load unpacked). The Firefox zip has the manifest at its root (about:debugging and AMO both need that).

## Conventions

- Put code in `src/common` unless it is specific to one browser. A file in `src/<target>` overrides a same-named file from `src/common`.
- Text files may use `{{VERSION}}`, `{{BROWSER}}` and `{{BASIC_HINT}}`; `build.py` fills them per target and fails on an unfilled placeholder outside `.js` files. Add new ones to `VARS` in `build.py`.
- Don't hard-code the version in manifests; bump `VERSION` for a release.
- To release, push a tag `v<VERSION>`: `.github/workflows/release.yml` builds both zips and publishes them as a GitHub release. The tag must match `VERSION`.
- There is no test suite. After a change, run `python build.py` and syntax-check the output: `for f in dist/chrome/*.js dist/firefox/*.js; do node --check "$f"; done`. Behaviour has to be checked by loading the built extension in each browser.
