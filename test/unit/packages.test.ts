// Dependency findings grouped by package, with the version to upgrade to (user decision 2026-10-08).

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { compareVersions, groupByPackage, upgradeText } from "../../src/findings/packages.js";
import type { Finding } from "../../src/findings/types.js";
import { JSCPD_IGNORE } from "../../src/lanes/health.js";

const f = (id: string, sev: Finding["severity"], tags: string[], over: Partial<Finding> = {}): Finding => ({
  type: "finding", id, fingerprint: id, class: "tool", severity: sev, rubric_version: "v2", epss_bp: null, kev: null, snippet_hash: null,
  lane: "sca", tool: "osv-scanner", tool_version: "1", rule_id: `GHSA-${id}`, category: "dependency", file: "pnpm-lock.yaml", line: 0, end_line: 0,
  message: `npm pkg: advisory ${id}`, tool_severity: "cvss", snippet: null, engine_fingerprint: id, cve: null, aliases: [], cvss: null, raw_ref: "r", tags, ...over,
});

describe("compareVersions", () => {
  it("orders numeric parts numerically, pre-releases before releases", () => {
    const sorted = ["4.17.21", "4.9.0", "4.17.3", "4.17.21-rc.1", "v5.0.0", "4.17"].sort(compareVersions);
    assert.deepEqual(sorted, ["4.9.0", "4.17", "4.17.3", "4.17.21-rc.1", "4.17.21", "v5.0.0"]);
    assert.equal(compareVersions("1.0.0", "1.0.0+build.5"), 0);
  });
});

describe("groupByPackage", () => {
  it("one group per package@version: worst severity, the highest fix, unfixed counted, max CVSS/EPSS, KEV", () => {
    const { groups, rest } = groupByPackage([
      f("A", "high", ["ecosystem:npm", "package:hono@4.11.7", "fixed:4.11.10"], { cvss: "7.5", aliases: ["CVE-2026-1"] }),
      f("B", "critical", ["ecosystem:npm", "package:hono@4.11.7", "fixed:4.12.4"], { cvss: "9.8", epss_bp: 120, aliases: ["CVE-2026-2"] }),
      f("C", "medium", ["ecosystem:npm", "package:hono@4.11.7"], { kev: true }),
      f("D", "low", ["ecosystem:npm", "package:undici@7.24.5", "fixed:7.25.0"]),
      f("E", "high", [], { lane: "sast", category: "security" }),
    ]);
    assert.deepEqual(rest.map((x) => x.id), ["E"]);
    assert.deepEqual(groups.map((g) => g.pkg), ["hono@4.11.7", "undici@7.24.5"]);
    const hono = groups[0];
    assert.deepEqual(hono && [hono.severity, hono.findings.length, hono.upgradeTo, hono.unfixed, hono.maxCvss, hono.maxEpssBp, hono.kev, hono.cves],
      ["critical", 3, "4.12.4", 1, "9.8", 120, true, ["CVE-2026-1", "CVE-2026-2"]]);
    assert.equal(hono && upgradeText(hono), "≥ 4.12.4 (1 advisory has no fix yet)");
  });
});

describe("duplication excludes test code (user decision 2026-10-08)", () => {
  it("jscpd ignores the test-file conventions", () => {
    for (const g of ["**/__tests__/**", "**/*.test.*", "**/Tests/**"]) assert.ok(JSCPD_IGNORE.split(",").includes(g), g);
  });
});
