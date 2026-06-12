#!/usr/bin/env python3
"""
Test all URLs against all strategies natively on the Web App.
Generates an artifacts/web_all_strategies_report.md report.
"""
import argparse
import http.server
import json
import socketserver
import sys
import threading
import urllib.parse
from pathlib import Path

try:
    from playwright.sync_api import sync_playwright
except ImportError:
    print("Please run: .venv/bin/pip install playwright && .venv/bin/playwright install chromium")
    sys.exit(1)

# Add root to path
ROOT = Path(__file__).resolve().parents[1]
sys.path.append(str(ROOT))
from scripts.url_catalog import select_urls

PORT = 8767
DEFAULT_WEB_APP_URL = "http://localhost:8081"
RESULT_TIMEOUT = 60.0  # seconds per URL
current_result = None
result_event = threading.Event()

class ReportHandler(http.server.BaseHTTPRequestHandler):
    def do_OPTIONS(self):
        self.send_response(200)
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'POST, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type')
        self.end_headers()

    def do_POST(self):
        global current_result
        content_length = int(self.headers['Content-Length'])
        post_data = self.rfile.read(content_length)
        
        try:
            current_result = json.loads(post_data)
            result_event.set()
            
            self.send_response(200)
            self.send_header('Content-type', 'application/json')
            self.send_header('Access-Control-Allow-Origin', '*')
            self.end_headers()
            self.wfile.write(b'{"status":"ok"}')
        except Exception as e:
            self.send_response(400)
            self.send_header('Access-Control-Allow-Origin', '*')
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

def enc(value: str) -> str:
    return urllib.parse.quote(value or "", safe="")

def format_cell(res):
    if not res:
        return "N/A"
    if res.get('success'):
        return "\033[92mPASS\033[0m"
    return "\033[91mFAIL\033[0m"

def format_md_cell(res):
    if not res:
        return "N/A"
    if res.get('success'):
        return "✅ PASS"
    return "❌ FAIL"

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("names", nargs="*", help="Optional URL names to run.")
    parser.add_argument("--web-app", default=DEFAULT_WEB_APP_URL, help="Web app base URL (default: %(default)s)")
    args = parser.parse_args()

    web_app_url = args.web_app.rstrip("/")
    urls = select_urls(args.names, include_extra=True)

    print(f"Starting local reporting server on port {PORT}...")
    httpd = start_server()

    print(f"Testing {len(urls)} URLs on Web App ({web_app_url})")
    print("-" * 80)
    print(f"{'PLATFORM/NOTE':<30} | {'SERVER':<15} | {'CLIENT':<15}")
    print("-" * 80)

    report_data = []

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        page = browser.new_page()
        page.on("console", lambda msg: print(f"Console: {msg.text}"))
        page.on("pageerror", lambda err: print(f"Error: {err}"))

        for name, url, note in urls:
            global current_result
            current_result = None
            result_event.clear()

            report_url = f"http://127.0.0.1:{PORT}/report"
            deep_link = f"{web_app_url}/test_strategies?url={enc(url)}&reportUrl={enc(report_url)}"
            
            try:
                page.goto(deep_link, timeout=10000)
            except Exception as e:
                print(f"{name:<30} | \033[93mPAGE LOAD FAILED: {e}\033[0m")
                report_data.append({
                    "name": name,
                    "url": url,
                    "note": note,
                    "server": {"success": False, "error": "PAGE LOAD FAILED"},
                    "client": {"success": False, "error": "PAGE LOAD FAILED"}
                })
                continue
            
            # Wait for the web app to run extraction and POST back
            success = result_event.wait(timeout=RESULT_TIMEOUT)
            
            if success and current_result:
                strategies = {r['strategy']: r for r in current_result['results']}
                srv = strategies.get("SERVER")
                dev = strategies.get("ON-DEVICE") or strategies.get("CLIENT") or strategies.get("CLIENT-API")
                
                print(f"{name:<30} | {format_cell(srv):<24} | {format_cell(dev):<24}")
                
                report_data.append({
                    "name": name,
                    "url": url,
                    "note": note,
                    "server": srv,
                    "client": dev
                })
            else:
                print(f"{name:<30} | \033[93mTIMEOUT\033[0m")
                report_data.append({
                    "name": name,
                    "url": url,
                    "note": note,
                    "server": {"success": False, "error": "TIMEOUT"},
                    "client": {"success": False, "error": "TIMEOUT"}
                })

        browser.close()

    print("-" * 80)
    httpd.shutdown()
    httpd.server_close()

    # Generate Markdown Report
    out_dir = ROOT / 'artifacts'
    out_dir.mkdir(parents=True, exist_ok=True)
    out_path = out_dir / 'web_all_strategies_report.md'
    
    with out_path.open('w', encoding='utf-8') as f:
        f.write("# Web App Extraction Strategies Report\n\n")
        f.write(f"Tested **{len(urls)}** URLs natively on the Web App.\n\n")
        f.write("| Platform | Note | Server | Client |\n")
        f.write("| :--- | :--- | :--- | :--- |\n")
        for r in report_data:
            f.write(f"| **{r['name']}** | {r['note']} | {format_md_cell(r['server'])} | {format_md_cell(r['client'])} |\n")
            
    print(f"\nReport written to {out_path}")

if __name__ == "__main__":
    main()
