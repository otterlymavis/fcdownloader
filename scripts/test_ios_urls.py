#!/usr/bin/env python3
"""Inject the URL catalog into the iOS app via its fcdownloader:// deep link."""
from __future__ import annotations

import argparse
import json
from pathlib import Path
import subprocess
import sys
import time
import urllib.parse

from url_catalog import ROOT, select_urls


DEFAULT_DEVICE = "iPhone 17"
DEFAULT_BUNDLE_ID = "com.otterpia.fcdownloader"
SAFARI_PROJECT = ROOT / "safari-extension-xcode" / "FCDownloader Safari" / "FCDownloader Safari.xcodeproj"
SAFARI_SCHEME = "FCDownloader Safari (iOS)"
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


def sim_udid(device_name: str) -> str:
    proc = run(["xcrun", "simctl", "list", "devices", "available", "--json"])
    data = json.loads(proc.stdout)
    for devices in data.get("devices", {}).values():
        for device in devices:
            if device.get("name") == device_name and device.get("isAvailable"):
                return device["udid"]
    raise SystemExit(f"Simulator not found: {device_name}")


def boot_if_needed(udid: str) -> None:
    run(["xcrun", "simctl", "boot", udid], check=False)
    run(["xcrun", "simctl", "bootstatus", udid, "-b"], capture=False)


def app_installed(udid: str, bundle_id: str) -> bool:
    proc = run(["xcrun", "simctl", "get_app_container", udid, bundle_id], check=False)
    return proc.returncode == 0


def screenshot(udid: str, path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    run(["xcrun", "simctl", "io", udid, "screenshot", str(path)], check=False)


def open_url(udid: str, raw_url: str) -> tuple[bool, str]:
    proc = run(["xcrun", "simctl", "openurl", udid, raw_url], check=False)
    return proc.returncode == 0, (proc.stdout or "").strip()


def enc(value: str) -> str:
    return urllib.parse.quote(value or "", safe="")


def fcdownloader_url(raw_url: str) -> str:
    return f"fcdownloader://share?url={enc(raw_url)}"


def handoff_url(target: str, page_url: str, media_url: str = "", template: str = DEFAULT_TEMPLATE) -> str:
    source = media_url or page_url
    if target == "fcdownloader":
        return fcdownloader_url(source)
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


def build_safari_extension() -> None:
    if not SAFARI_PROJECT.exists():
        raise SystemExit(f"Missing Safari extension Xcode project: {SAFARI_PROJECT}")
    run([
        "xcodebuild",
        "-project", str(SAFARI_PROJECT),
        "-scheme", SAFARI_SCHEME,
        "-configuration", "Debug",
        "-destination", "generic/platform=iOS Simulator",
        "CODE_SIGNING_ALLOWED=NO",
        "build",
    ], capture=False)


def main() -> int:
    parser = argparse.ArgumentParser(description="Run all FCDownloader sample URLs through the iOS app deep link.")
    parser.add_argument("names", nargs="*", help="Optional URL names to run.")
    parser.add_argument("--device", default=DEFAULT_DEVICE, help=f"Simulator name. Default: {DEFAULT_DEVICE}")
    parser.add_argument("--bundle-id", default=DEFAULT_BUNDLE_ID, help=f"App bundle id. Default: {DEFAULT_BUNDLE_ID}")
    parser.add_argument("--build", action="store_true", help="Run `npx expo run:ios --device ...` before testing.")
    parser.add_argument("--build-safari-extension", action="store_true", help="Build the iOS Safari extension app target first.")
    parser.add_argument("--target", choices=["fcdownloader", "shortcuts", "ashell", "custom"], default="fcdownloader")
    parser.add_argument("--template", default=DEFAULT_TEMPLATE, help="Custom template for --target custom.")
    parser.add_argument("--no-extra", action="store_true", help="Only use URLs from test_all_urls.py.")
    parser.add_argument("--pace", type=float, default=1.25, help="Seconds between URL injections.")
    parser.add_argument("--out-dir", default="artifacts/ios-url-tests", help="Output directory.")
    parser.add_argument("--screenshots", action="store_true", help="Capture one screenshot after each URL.")
    args = parser.parse_args()

    urls = select_urls(args.names, include_extra=not args.no_extra)
    out_dir = ROOT / args.out_dir
    out_dir.mkdir(parents=True, exist_ok=True)
    results_path = out_dir / "results.jsonl"

    udid = sim_udid(args.device)
    boot_if_needed(udid)

    if args.build_safari_extension:
        build_safari_extension()

    if args.build:
        run(["npx", "expo", "run:ios", "--device", args.device], capture=False)
    elif args.target == "fcdownloader" and not app_installed(udid, args.bundle_id):
        raise SystemExit(
            f"{args.bundle_id} is not installed on {args.device}. "
            f"Run with --build or install the app first."
        )

    print(f"Testing {len(urls)} URLs on {args.device} ({udid})")
    passed = 0
    with results_path.open("w", encoding="utf-8") as f:
        for idx, (name, url, note) in enumerate(urls, start=1):
            generated = handoff_url(args.target, url, template=args.template)
            ok, output = open_url(udid, generated)
            if ok:
                passed += 1
            row = {
                "index": idx,
                "name": name,
                "url": url,
                "note": note,
                "target": args.target,
                "handoffUrl": generated,
                "ok": ok,
                "output": output,
                "timestamp": time.time(),
            }
            f.write(json.dumps(row, ensure_ascii=False) + "\n")
            status = "PASS" if ok else "FAIL"
            print(f"[{status}] {idx:02d}/{len(urls):02d} {name}: {generated}")
            if args.screenshots:
                safe = "".join(c if c.isalnum() or c in "-_." else "_" for c in name)
                screenshot(udid, out_dir / "screenshots" / f"{idx:02d}-{safe}.png")
            time.sleep(args.pace)

    print(f"\n{passed}/{len(urls)} deep links opened")
    print(f"Results: {results_path}")
    return 0 if passed == len(urls) else 1


if __name__ == "__main__":
    sys.exit(main())
