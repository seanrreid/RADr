// M3 W1: rule pack integrity (AC5) and support bar (AC6). check-rules always runs on a COPY.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, cpSync, writeFileSync } from "node:fs";
import path from "node:path";
import { assetPath } from "../../src/core/assets.js";
import { packRules, rulePackHashes, ruleCoverage } from "../../src/rules/pack.js";
import { checkRules } from "../../scripts/check-rules.js";
import { tmpDir } from "../helpers/tmp.js";

function copyRules(): string {
  const root = tmpDir();
  cpSync(assetPath("rules"), path.join(root, "rules"), { recursive: true });
  return root;
}

describe("rule pack integrity (AC5)", () => {
  it("the shipped pack is clean: provenance complete, unmodified, licenses by bucket, fixtures present", () => {
    const { errors, rules } = checkRules(path.dirname(assetPath("rules")));
    assert.deepEqual(errors, []);
    assert.ok(rules.length > 300);
  });

  it("detects an edited vendored rule", () => {
    const root = copyRules();
    appendFileSync(path.join(root, "rules/pack/gitlab/python/eval/rule-eval.yml"), "\n# tweak\n");
    assert.match(checkRules(root).errors.join("\n"), /rule-eval\.yml: modified/);
  });

  it("detects an unlisted file and a copyleft rule smuggled into pack/", () => {
    const root = copyRules();
    writeFileSync(path.join(root, "rules/pack/gitlab/python/eval/sneaky.yml"), "# License: GNU General Public License v2.0\nrules: []\n");
    const errs = checkRules(root).errors.join("\n");
    assert.match(errs, /sneaky\.yml: not in PROVENANCE\.lock/);
  });

  it("requires authored rules to declare their origin and ship a fixture", () => {
    const root = copyRules();
    writeFileSync(path.join(root, "rules/authored/python/orphan.yml"), "rules: []\n");
    const errs = checkRules(root).errors.join("\n");
    assert.match(errs, /orphan\.yml: authored rule lacks/);
    assert.match(errs, /orphan\.yml: no fixture/);
  });
});

describe("support bar (AC6)", () => {
  it("reports supported/partial per stack against rules/targets.yml", () => {
    const cov = Object.fromEntries(ruleCoverage().map((c) => [c.stack, c]));
    for (const s of ["typescript-javascript", "python", "go", "java-kotlin", "csharp", "php", "ruby", "rust"]) assert.equal(cov[s]?.supported, true, s);
    // PHP, Ruby and Rust rest on radr's authored rules: without them the gaps show, by CWE.
    const vendoredOnly = Object.fromEntries(ruleCoverage(["pack", "lgpl"]).map((c) => [c.stack, c]));
    for (const s of ["php", "ruby", "rust"]) assert.equal(vendoredOnly[s]?.supported, false, s);
    assert.ok((vendoredOnly["ruby"]?.missing ?? []).includes(89));
  });

  it("the LGPL sub-pack is what makes TS/JS supported (dropping it is visible)", () => {
    const withoutLgpl = Object.fromEntries(ruleCoverage(["authored", "pack"]).map((c) => [c.stack, c]));
    assert.equal(withoutLgpl["typescript-javascript"]?.supported, false);
  });

  it("indexes rule metadata and hashes every pack for the fingerprint", () => {
    const ids = packRules(["authored"]).map((r) => r.id);
    assert.ok(ids.includes("radr.go.ssrf") && ids.includes("radr.python.ssti-template-from-variable") && ids.includes("radr.rust.sqli") && ids.includes("radr.php.sqli") && ids.includes("radr.ruby.sqli"));
    assert.deepEqual(Object.keys(rulePackHashes()).sort(), ["rules_authored", "rules_lgpl", "rules_pack"]);
  });
});
