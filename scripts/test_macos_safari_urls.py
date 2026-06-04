#!/usr/bin/env python3
"""Exercise the URL catalog against the macOS Safari-extension handoff paths."""
from __future__ import annotations

import argparse
import json
from pathlib import Path
import subprocess
import sys
import time
import urllib.parse

from url_catalog import ROOT, select_urls


PROJECT = ROOT / "safari-extension-xcode" / "FCDownloader Safari" / "FCDownloader Safari.xcodeproj"
SCHEME = "FCDownloader Safari (macOS)"
DEFAULT_TEMPLATE = "fcdownloader://share?url={url}"


def run(cmd: list[str], *, check: bool = True, capture: bool = True) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        cmd,
        cwd=ROOT,
        check=check,
        text=True,
        stdout=subprocess.PIPE if capture else None,
        stderr=subprocess.STDOUT if capture else None,
    )


def enc(value: str) -> str:
    return urllib.parse.quote(value or "", safe="")


def handoff_url(target: str, page_url: str, media_url: str = "", template: str = DEFAULT_TEMPLATE) -> str:
    source = media_url or page_url
    if target == "fcdownloader":
        return f"fcdownloader://share?url={enc(source)}"
    if target == "shortcuts":
        return f"shortcuts://run-shortcut?name={enc('FCDownloader')}&input=text&text={enc(source)}"
    if target == "ashell":
        command = f"curl -L {json.dumps(source)}"
        return f"a-shell://?command={enc(command)}"
    if target == "custom":
        return (
            template
            .replace("{url}", enc(source))
            .replace("{pageUrl}", enc(page_url))
            .replace("{mediaUrl}", enc(media_url))
        )
    raise ValueError(f"unknown target: {target}")


def build_extension() -> None:
    if not PROJECT.exists():
        raise SystemExit(f"Missing Safari extension Xcode project: {PROJECT}")
    run([
        "xcodebuild",
        "-project", str(PROJECT),
        "-scheme", SCHEME,
        "-configuration", "Debug",
        "CODE_SIGNING_ALLOWED=NO",
        "build",
    ], capture=False)


def open_url(url: str, app: str | None = None) -> bool:
    cmd = ["open"]
    if app:
        cmd.extend(["-a", app])
    cmd.append(url)
    return run(cmd, check=False).returncode == 0


def main() -> int:
    parser = argparse.ArgumentParser(description="Run all sample URLs through macOS Safari-extension handoff logic.")
    parser.add_argument("names", nargs="*", help="Optional URL names to run.")
    parser.add_argument("--target", choices=["fcdownloader", "shortcuts", "ashell", "custom"], default="fcdownloader")
    parser.add_argument("--template", default=DEFAULT_TEMPLATE, help="Custom template for --target custom.")
    parser.add_argument("--no-extra", action="store_true", help="Only use URLs from test_all_urls.py.")
    parser.add_argument("--skip-build", action="store_true", help="Do not build the macOS Safari extension app first.")
    parser.add_argument("--open-pages", action="store_true", help="Open each source page in Safari.")
    parser.add_argument("--open-handoff", action="store_true", help="Open each generated downloader handoff URL.")
    parser.add_argument("--pace", type=float, default=1.25, help="Seconds between open operations.")
    parser.add_argument("--out-dir", default="artifacts/macos-safari-url-tests", help="Output directory.")
    args = parser.parse_args()

    urls = select_urls(args.names, include_extra=not args.no_extra)
    out_dir = ROOT / args.out_dir
    out_dir.mkdir(parents=True, exist_ok=True)
    results_path = out_dir / "results.jsonl"

    if not args.skip_build:
        build_extension()

    print(f"Testing {len(urls)} URLs with macOS target={args.target}")
    passed = 0
    with results_path.open("w", encoding="utf-8") as f:
        for idx, (name, page_url, note) in enumerate(urls, start=1):
            generated = handoff_url(args.target, page_url, template=args.template)
            page_opened = open_url(page_url, "Safari") if args.open_pages else None
            handoff_opened = open_url(generated) if args.open_handoff else None
            ok = generated.startswith(("fcdownloader://", "shortcuts://", "a-shell://", "http://", "https://"))
            if args.open_pages:
                ok = ok and bool(page_opened)
            if args.open_handoff:
                ok = ok and bool(handoff_opened)
            if ok:
                passed += 1
            row = {
                "index": idx,
                "name": name,
                "pageUrl": page_url,
                "note": note,
                "target": args.target,
                "handoffUrl": generated,
                "pageOpened": page_opened,
                "handoffOpened": handoff_opened,
                "ok": ok,
                "timestamp": time.time(),
            }
            f.write(json.dumps(row, ensure_ascii=False) + "\n")
            status = "PASS" if ok else "FAIL"
            print(f"[{status}] {idx:02d}/{len(urls):02d} {name}: {generated}")
            if args.open_pages or args.open_handoff:
                time.sleep(args.pace)

    print(f"\n{passed}/{len(urls)} macOS handoff cases passed")
    print(f"Results: {results_path}")
    return 0 if passed == len(urls) else 1


if __name__ == "__main__":
    sys.exit(main())
