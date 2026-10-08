// Replace the report's and plan's placeholder prose (keep-blocks) with real text, as a consultant
// must before Gate 2 (which refuses template placeholders).

import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { KEEP_DEFAULTS } from "../../src/address/report.js";

export function writeProse(engagementDir: string): void {
  for (const f of [path.join(engagementDir, "report", "report.md"), path.join(engagementDir, "plan", "remediation.md")]) {
    let text = readFileSync(f, "utf8");
    for (const [id, body] of Object.entries(KEEP_DEFAULTS)) text = text.replace(body, `Consultant text for ${id}.`);
    writeFileSync(f, text);
  }
}
