# Aloud — Natural Read Aloud for Chrome and Firefox

Edge-style read aloud: natural voices, word-by-word highlighting, click any paragraph to start there, and article-only reading that skips menus, ads and comments.

## Download

Get the latest zips from the [releases page](https://github.com/Fezzo753/aloud/releases/latest): `aloud-chrome-<version>.zip` for Chrome, `aloud-firefox-<version>.zip` for Firefox.

## Install on Chrome (Windows)

1. Unzip somewhere permanent. Chrome loads it from this folder, so don't delete it afterwards:
   ```powershell
   Expand-Archive "$env:USERPROFILE\Downloads\aloud-chrome-*.zip" -DestinationPath "$env:USERPROFILE\Extensions"
   ```
2. Open `chrome://extensions`, turn on **Developer mode** (top right), click **Load unpacked**, and pick the `aloud` folder.
3. Pin it from the puzzle-piece menu. The settings page opens automatically on install.

## Install on Firefox (142 or newer, desktop)

Firefox only installs add-ons permanently once Mozilla has signed them. Pick one:

- **Quick test:** open `about:debugging#/runtime/this-firefox` → **Load Temporary Add-on…** → pick `aloud-firefox-<version>.zip`. It works fully but is removed when Firefox restarts.
- **Permanent (free, a few minutes):** sign in at addons.mozilla.org/developers → **Submit a New Add-on** → **On your own** → upload `aloud-firefox-<version>.zip`. Mozilla signs it automatically and gives you an `.xpi`; drag that into Firefox. "On your own" means it isn't listed publicly.
- **Developer Edition, Nightly or ESR only:** set `xpinstall.signatures.required` to `false` in `about:config`, then drag the zip into Firefox.

If the settings page shows **Firefox is blocking the voice services**, click **Allow access**. Firefox lets you switch off an add-on's site access, and Aloud needs it to reach Azure and ElevenLabs.

Firefox differences: the Basic voices are the ones Windows has installed (Firefox has no Google voices), and shortcuts are changed in `about:addons` → ⚙ → **Manage Extension Shortcuts**.

## Voices

| Engine | Quality | Cost | Word highlighting |
|---|---|---|---|
| **Azure Neural** | Same Natural voices as Edge (Ava, Andrew, Natasha, Nanami…) | Free tier, then pay-as-you-go | Estimated from audio, usually within a word |
| **ElevenLabs** | Best available | Your ElevenLabs credits | Exact (timestamps from the API) |
| **Basic** | Whatever Windows (and Chrome) has installed | Free | Exact for local voices |

**Free Azure key:** portal.azure.com → create a **Speech service** → pricing tier **Free F0** → region e.g. *Australia East* → **Keys and Endpoint** → paste Key 1 and the region into settings → **Load voices**.

The `…Multilingual` Azure voices switch language automatically, so one voice handles English, Japanese and Chinese pages.

## Using it

- **Ctrl+Shift+U** or the toolbar icon starts and stops reading. It begins at the article title, or wherever you've scrolled to.
- Hover a paragraph and click the blue ▶ beside it to read from there. **Alt+click** any sentence does the same.
- Select text first to start from the selection. Right-click a selection → **Read only the selection** to read just that bit.
- **Alt+Shift+P** play/pause · **Alt+Shift+←/→** previous/next paragraph · **Esc** close.
- Speed (0.5–3×) and voice change instantly from the toolbar. Drag the toolbar by its grip.
- To change shortcuts: Chrome `chrome://extensions/shortcuts`, Firefox `about:addons` → ⚙ → Manage Extension Shortcuts. The settings page button opens the right one.

## How it works

- The audio plays outside the web page (Chrome: an offscreen document; Firefox: the background page), so a website's security policy can't block it, and speed changes keep the pitch natural.
- Highlighting uses the CSS Custom Highlight API, which paints over the text without editing the page's HTML. Sites don't break.
- The next two sentences are fetched while the current one plays, so there are no gaps.
- Keys stay in `chrome.storage.local` and only go to the provider you picked. The extension only touches a page when you invoke it (`activeTab`).

## Known limits

- Browsers block extensions on their own pages: Chrome on `chrome://` pages, the Web Store and its PDF viewer; Firefox on `about:` pages, Reader View, addons.mozilla.org and its PDF viewer. The icon shows a red ✕ there.
- Google Docs draws text on a canvas, so there's nothing to read.
- Text inside some web components (shadow DOM) is skipped.
- With Azure, word timing is estimated because Azure's REST API doesn't return word positions. Sentences are always exact.

## Building from source

`src/common` is shared by both browsers; `src/chrome` and `src/firefox` hold each one's manifest and background script. The version lives in `VERSION`.

```bash
python build.py            # writes dist/aloud-chrome-<version>.zip and dist/aloud-firefox-<version>.zip
python build.py firefox    # one browser only
```

To publish a release, bump `VERSION`, merge to `main`, then run the **Release** workflow from the Actions tab. It builds both zips and publishes them as GitHub release `v<version>`.
