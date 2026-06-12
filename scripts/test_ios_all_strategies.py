#!/usr/bin/env python3
"""
Test all URLs against all strategies natively on iOS via deep link injection.
Generates an artifacts/ios_all_strategies_report.md report.
"""
import argparse
import http.server
import json
import socketserver
import subprocess
import sys
import threading
import time
import urllib.parse
from pathlib import Path

# Add root to path
ROOT = Path(__file__).resolve().parents[1]
sys.path.append(str(ROOT))
from scripts.url_catalog import select_urls

PORT = 8766
DEFAULT_DEVICE = "iPhone 17"
current_result = None
result_event = threading.Event()

class ReportHandler(http.server.BaseHTTPRequestHandler):
    def do_POST(self):
        global current_result
        content_length = int(self.headers['Content-Length'])
        post_data = self.rfile.read(content_length)
        
        try:
            current_result = json.loads(post_data)
            result_event.set()
            
            self.send_response(200)
            self.send_header('Content-type', 'application/json')
            self.end_headers()
            self.wfile.write(b'{"status":"ok"}')
        except Exception as e:
            self.send_response(400)
            self.end_headers()
            print(f"Error parsing JSON: {e}")

    def log_message(self, format, *args):
        pass # Suppress logging

def start_server():
    socketserver.TCPServer.allow_reuse_address = True
    httpd = socketserver.TCPServer(("", PORT), ReportHandler)
    thread = threading.Thread(target=httpd.serve_forever, daemon=True)
    thread.start()
    return httpd

def sim_udid(device_name: str) -> str:
    proc = subprocess.run(["xcrun", "simctl", "list", "devices", "available", "--json"], capture_output=True, text=True)
    data = json.loads(proc.stdout)
    for devices in data.get("devices", {}).values():
        for device in devices:
            if device.get("name") == device_name and device.get("isAvailable"):
                return device["udid"]
    raise SystemExit(f"Simulator not found: {device_name}")

def enc(value: str) -> str:
    return urllib.parse.quote(value or "", safe="")

def format_cell(res):
    if not res:
        return "N/A"
    if res['success']:
        return "\033[92mPASS\033[0m"
    return "\033[91mFAIL\033[0m"

def format_md_cell(res):
    if not res:
        return "N/A"
    if res['success']:
        return "✅ PASS"
    return "❌ FAIL"

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("names", nargs="*", help="Optional URL names to run.")
    parser.add_argument("--device", default=DEFAULT_DEVICE)
    args = parser.parse_args()

    urls = select_urls(args.names, include_extra=True)
    udid = sim_udid(args.device)
    
    # Ensure simulator is booted
    subprocess.run(["xcrun", "simctl", "boot", udid], capture_output=True)
    
    print(f"Starting local reporting server on port {PORT}...")
    httpd = start_server()
    
    print(f"Testing {len(urls)} URLs on {args.device} ({udid})")
    print("-" * 80)
    print(f"{'PLATFORM/NOTE':<30} | {'SERVER':<15} | {'ON-DEVICE':<15}")
    print("-" * 80)

    report_data = []

    for name, url, note in urls:
        global current_result
        current_result = None
        result_event.clear()

        report_url = f"http://127.0.0.1:{PORT}/report"
        deep_link = f"fcdownloader://test_strategies?url={enc(url)}&reportUrl={enc(report_url)}"
        
        subprocess.run(["xcrun", "simctl", "openurl", udid, deep_link], check=False, capture_output=True)
        
        # Wait for the iOS app to run extraction and POST back
        success = result_event.wait(timeout=25.0)
        
        if success and current_result:
            strategies = {r['strategy']: r for r in current_result['results']}
            srv = strategies.get("SERVER")
            dev = strategies.get("ON-DEVICE")
            
            print(f"{name:<30} | {format_cell(srv):<24} | {format_cell(dev):<24}")
            
            report_data.append({
                "name": name,
                "url": url,
                "note": note,
                "server": srv,
                "device": dev
            })
        else:
            print(f"{name:<30} | \033[93mTIMEOUT\033[0m")
            report_data.append({
                "name": name,
                "url": url,
                "note": note,
                "server": {"success": False, "error": "TIMEOUT"},
                "device": {"success": False, "error": "TIMEOUT"}
            })

    print("-" * 80)
    httpd.shutdown()
    httpd.server_close()

    # Generate Markdown Report
    out_dir = ROOT / 'artifacts'
    out_dir.mkdir(parents=True, exist_ok=True)
    out_path = out_dir / 'ios_all_strategies_report.md'
    
    with out_path.open('w', encoding='utf-8') as f:
        f.write("# iOS Extraction Strategies Report\n\n")
        f.write(f"Tested **{len(urls)}** URLs natively on iOS Simulator ({args.device}).\n\n")
        f.write("| Platform | Note | Server | On-Device |\n")
        f.write("| :--- | :--- | :--- | :--- |\n")
        for r in report_data:
            f.write(f"| **{r['name']}** | {r['note']} | {format_md_cell(r['server'])} | {format_md_cell(r['device'])} |\n")
            
    print(f"\nReport written to {out_path}")

if __name__ == "__main__":
    main()
