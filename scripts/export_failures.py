import re
import json

log_path = "/Users/imac/.gemini/antigravity/brain/abfa510f-b2fa-4c56-87b5-6c43307053f4/.system_generated/tasks/task-194.log"
output_path = "/Users/imac/Documents/fcdownloader/failures.md"

with open(log_path, "r", encoding="utf-8") as f:
    content = f.read()

failures = re.findall(r"\[([^\]]+)\] -> FAIL \(HTTP (\d+)\): (\{.*\})", content)

parsed_failures = []
for platform, status_code, raw_json in failures:
    try:
        data = json.loads(raw_json)
        detail = data.get("detail", {})
        if isinstance(detail, dict):
            msg = detail.get("message", "No message provided")
            diagnostics = detail.get("diagnostics", [])
        else:
            msg = str(detail)
            diagnostics = []
    except Exception:
        msg = raw_json[:200]
        diagnostics = []
    parsed_failures.append({
        "platform": platform,
        "status": status_code,
        "message": msg,
        "diagnostics": diagnostics
    })

with open(output_path, "w", encoding="utf-8") as out:
    out.write("# FCDownloader - Backend Test Failures Log\n\n")
    out.write(f"Total Failures: **{len(parsed_failures)}**\n\n")
    
    # Write summary table
    out.write("## Summary Table\n\n")
    out.write("| Platform | HTTP Status | Error Message Summary |\n")
    out.write("| :--- | :--- | :--- |\n")
    for f in parsed_failures:
        # Truncate message for table readability
        short_msg = f["message"].replace("\n", " ").strip()
        if len(short_msg) > 95:
            short_msg = short_msg[:92] + "..."
        out.write(f"| **{f['platform']}** | {f['status']} | {short_msg} |\n")
    out.write("\n---\n\n")
    
    # Write detailed diagnostics
    out.write("## Detailed Diagnostics\n\n")
    for f in parsed_failures:
        out.write(f"### {f['platform']} (HTTP {f['status']})\n\n")
        out.write(f"> {f['message']}\n\n")
        
        if f["diagnostics"]:
            out.write("**Diagnostics by extraction strategy:**\n\n")
            for diag in f["diagnostics"]:
                strat = diag.get("strategy", "unknown")
                reason = diag.get("reason", "unknown reason")
                # Wrap long error outputs in inline code or blockquotes
                out.write(f"- **{strat}**: `{reason}`\n")
            out.write("\n")
        out.write("---\n\n")

print(f"Exported {len(parsed_failures)} failures in markdown format to {output_path}")
