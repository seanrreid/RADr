import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after } from "node:test";

/** A fresh temp dir, removed when the test file finishes. */
export function tmpDir(prefix = "radr-test-"): string {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  after(() => { rmSync(dir, { recursive: true, force: true }); });
  return dir;
}
