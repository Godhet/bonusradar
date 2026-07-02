#!/usr/bin/env python3
"""Package Bonusradar for Firefox and Chrome.

No transpiler/minifier/bundler — the packaged files are byte-for-byte the
source files in this repo. The only per-browser difference is which manifest
is used (see manifest.json vs manifest.chrome.json); everything else is shared.

Usage:  python3 build.py
Outputs (in the parent directory):
  bonusradar-firefox-<version>.xpi
  bonusradar-chrome-<version>.zip
"""
import json
import os
import zipfile

HERE = os.path.dirname(os.path.abspath(__file__))
OUT_DIR = os.path.dirname(HERE)

# Files shared by both builds, packaged at these same paths.
SHARED = [
    "lib/compat.js",
    "lib/match.js",
    "background.js",
    "content.js",
    "popup.html",
    "popup.js",
    "icons/icon-48.png",
    "icons/icon-96.png",
]


def version():
    with open(os.path.join(HERE, "manifest.json")) as f:
        return json.load(f)["version"]


def build(manifest_src, out_name):
    out_path = os.path.join(OUT_DIR, out_name)
    with zipfile.ZipFile(out_path, "w", zipfile.ZIP_DEFLATED) as z:
        # The right manifest always lands at the archive root as manifest.json.
        z.write(os.path.join(HERE, manifest_src), "manifest.json")
        for rel in SHARED:
            z.write(os.path.join(HERE, rel), rel)
    print(f"wrote {out_path} ({os.path.getsize(out_path)} bytes)")


def main():
    v = version()
    build("manifest.json", f"bonusradar-firefox-{v}.xpi")
    build("manifest.chrome.json", f"bonusradar-chrome-{v}.zip")


if __name__ == "__main__":
    main()
