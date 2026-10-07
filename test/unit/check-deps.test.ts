import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { MAX_RUNTIME_DEPS, checkDeps, type DepsInput } from "../../scripts/check-deps.js";

const base: DepsInput = {
  pkg: { dependencies: { ajv: "8.20.0" } },
  lock: { packages: { "": {}, "node_modules/ajv": {} } },
  docs: "# Runtime dependencies\n\n### ajv\nWhy: schemas.\n",
  allowlist: [],
};

describe("checkDeps", () => {
  it("passes a documented, script-free dependency set", () => {
    assert.deepEqual(checkDeps(base), []);
  });

  it("fails when the runtime budget is exceeded", () => {
    const deps = Object.fromEntries(Array.from({ length: MAX_RUNTIME_DEPS + 1 }, (_, i) => [`d${i}`, "1.0.0"]));
    const docs = Object.keys(deps).map((d) => `### ${d}`).join("\n");
    const errors = checkDeps({ ...base, pkg: { dependencies: deps }, docs });
    assert.equal(errors.length, 1);
    assert.match(errors[0] ?? "", /budget exceeded/);
  });

  it("fails when a runtime dependency is undocumented", () => {
    const errors = checkDeps({ ...base, pkg: { dependencies: { ajv: "8.20.0", yaml: "2.9.1" } } });
    assert.deepEqual(errors, ['runtime dependency "yaml" has no "### yaml" entry in docs/dependencies.md']);
  });

  it("does not count dev dependencies (they are not in `dependencies`)", () => {
    assert.deepEqual(checkDeps({ ...base, pkg: {} }), []);
  });

  it("fails on a transitive install script unless allowlisted", () => {
    const lock = { packages: { "": {}, "node_modules/a/node_modules/esbuild": { hasInstallScript: true } } };
    assert.match(checkDeps({ ...base, lock }).join(), /"esbuild".*install script/);
    assert.deepEqual(checkDeps({ ...base, lock, allowlist: ["esbuild"] }), []);
  });

  it("accepts backticked headings", () => {
    assert.deepEqual(checkDeps({ ...base, docs: "### `ajv`\n" }), []);
  });
});
