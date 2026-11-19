#!/usr/bin/env python3
"""Build Aloud for Chrome and Firefox.

    python build.py            # builds both into dist/
    python build.py firefox    # one target

src/common is shared; src/<target> holds that browser's manifest and background.
Text placeholders like {{BROWSER}} are filled per target.
"""
import json
import pathlib
import shutil
import sys
import zipfile

ROOT = pathlib.Path(__file__).resolve().parent
SRC, DIST = ROOT / "src", ROOT / "dist"
VERSION = (ROOT / "VERSION").read_text().strip()
TEXT_EXT = {".html", ".js", ".json", ".css", ".md"}
REPO_URL = "https://github.com/Fezzo753/aloud"

VARS = {
    "chrome": {
        "BROWSER": "Chrome",
        "BASIC_HINT": "Quality depends on what Windows has installed. Word highlighting works with local voices; "
                      "Google's online voices only highlight sentences.",
    },
    "firefox": {
        "BROWSER": "Firefox",
        "BASIC_HINT": "Uses the voices Windows has installed (Settings → Time & language → Speech). "
                      "Word highlighting depends on the voice.",
    },
}


def build(target: str) -> pathlib.Path:
    out = DIST / target
    shutil.rmtree(out, ignore_errors=True)
    shutil.copytree(SRC / "common", out)
    shutil.copytree(SRC / target, out, dirs_exist_ok=True)
    shutil.copy(ROOT / "README.md", out / "README.md")

    subs = {**VARS[target], "VERSION": VERSION, "REPO_URL": REPO_URL}
    for f in out.rglob("*"):
        if f.suffix in TEXT_EXT:
            s = f.read_text(encoding="utf-8")
            for k, v in subs.items():
                s = s.replace("{{" + k + "}}", v)
            if "{{" in s and f.suffix != ".js":
                raise SystemExit(f"unfilled placeholder in {f}")
            f.write_text(s, encoding="utf-8")

    # Chrome: folder inside the zip (unzip, then Load unpacked).
    # Firefox: manifest at the zip root (about:debugging and AMO both want that).
    zpath = DIST / f"aloud-{target}-{VERSION}.zip"
    with zipfile.ZipFile(zpath, "w", zipfile.ZIP_DEFLATED) as z:
        for f in sorted(out.rglob("*")):
            if f.is_file():
                rel = f.relative_to(out)
                z.write(f, (pathlib.Path("aloud") / rel) if target == "chrome" else rel)
    if target == "firefox":
        write_updates_json(out)
    return zpath


def write_updates_json(out: pathlib.Path) -> None:
    """Firefox update manifest for self-distributed (signed, unlisted) installs.

    The Firefox manifest's update_url points at this file on the latest GitHub
    release; it in turn points at the signed .xpi attached to that release.
    """
    gecko = json.loads((out / "manifest.json").read_text(encoding="utf-8"))["browser_specific_settings"]["gecko"]
    update = {
        "version": VERSION,
        "update_link": f"{REPO_URL}/releases/download/v{VERSION}/aloud-firefox-{VERSION}.xpi",
        "applications": {"gecko": {"strict_min_version": gecko["strict_min_version"]}},
    }
    data = {"addons": {gecko["id"]: {"updates": [update]}}}
    (DIST / "updates.json").write_text(json.dumps(data, indent=2) + "\n", encoding="utf-8")


if __name__ == "__main__":
    for t in sys.argv[1:] or ["chrome", "firefox"]:
        print("built", build(t).relative_to(ROOT))
