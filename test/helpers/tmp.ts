import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after } from "node:test";
import { setWritable } from "../../src/engagement/source.js";

/** A fresh temp dir, removed when the test file finishes (read-only worktrees included). */
export function tmpDir(prefix = "radr-test-"): string {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  after(() => {
    setWritable(dir, true);
    rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}
