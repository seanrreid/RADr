// Coverage gaps (dogfood 2026-10-08): a check that ran and saw nothing is "not assessed", never
// "good". Unsupported languages, missing lockfiles, unlinted languages, unscanned SAST languages,
// and partly parsed files are stated; the matching scorecard rows go grey.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { computeScorecard } from "../../src/address/scorecard.js";
import { TEST_GLOBS } from "../../src/lanes/metrics.js";
import { matchesAny } from "../../src/core/glob.js";
import { coverageGaps, lockfiles, sastCoverage } from "../../src/review/coverage.js";
import { loadRubric } from "../../src/rubric/rubric.js";

const census = {
  files: {
    "android/core/src/main/kotlin/Note.kt": { code: 400, language: "Kotlin" },
    "android/app/src/main/java/Legacy.java": { code: 100, language: "Java" },
    "mac/Sources/Core/Note.swift": { code: 500, language: "Swift" },
    "README.md": { code: 50, language: "Markdown" },
  },
};
const doc = { stacks: ["java-kotlin"] as const, lanes: ["census", "lint", "sca", "sast"] as const };

describe("coverage gaps", () => {
  it("names unsupported languages, missing lockfiles, unlinted languages, unscanned and partly parsed SAST", () => {
    const gaps = coverageGaps(doc, {
      census,
      sca: { lockfiles: [] },
      lint: { linted: ["java-kotlin"], skipped: [] },
      sast: { languages: { Kotlin: { files: 1, scanned: 1 }, Java: { files: 1, scanned: 0 } }, partial_parse: ["android/core/src/main/kotlin/Note.kt"] },
    });
    assert.deepEqual(gaps, [
      "Swift (500 lines, 50% of the code) isn't a supported stack: no lint, type, dependency or SAST analysis covered it (secrets, complexity, duplication and history did)",
      "Dependencies (Java/Kotlin): no lockfile the scanner can read, so dependency vulnerabilities were not assessed (Gradle builds need a gradle.lockfile; version catalogs aren't resolved offline)",
      "Lint (Kotlin, 400 lines, 40% of the code): not linted: radr has no Kotlin linter yet (PMD lints Java)",
      "SAST (Java, 100 lines, 10% of the code): no file was scanned",
      "SAST parsed 1 file(s) only partly (syntax the engine doesn't know), so rules may have missed code in: android/core/src/main/kotlin/Note.kt",
    ]);
  });

  it("a skipped stack's reason is used; runs without coverage metrics claim nothing", () => {
    const gaps = coverageGaps(doc, { census, lint: { linted: [], skipped: [{ stack: "java-kotlin", why: "the stack's build environment wasn't set up for this review" }] } });
    assert.ok(gaps.includes("Lint (Java, 100 lines, 10% of the code): not linted: the stack's build environment wasn't set up for this review"));
    assert.deepEqual(coverageGaps({ stacks: [], lanes: ["census"] } as never, { census: { files: { "a.ts": { code: 10, language: "TypeScript" } } } }), []);
  });

  it("lockfiles: the names the scanner reads, nested, never inside node_modules", () => {
    assert.deepEqual(lockfiles(["package-lock.json", "web/yarn.lock", "node_modules/x/package-lock.json", "api/requirements-dev.txt", "android/gradle/libs.versions.toml", "build.gradle.kts"]),
      ["package-lock.json", "web/yarn.lock", "api/requirements-dev.txt"]);
  });

  it("sastCoverage: scanned files per census language and partly parsed files; unknown without paths", () => {
    const raw = JSON.stringify({ paths: { scanned: ["android/core/src/main/kotlin/Note.kt"] }, errors: [{ type: ["PartialParsing", []], path: "android/core/src/main/kotlin/Note.kt" }, { type: "Timeout", path: "x" }] });
    assert.deepEqual(sastCoverage(raw, census), {
      languages: { Java: { files: 1, scanned: 0 }, Kotlin: { files: 1, scanned: 1 }, Swift: { files: 1, scanned: 0 } },
      partial_parse: ["android/core/src/main/kotlin/Note.kt"],
    });
    assert.deepEqual(sastCoverage(JSON.stringify({ results: [], errors: [] }), census), {});
  });

  it("the scorecard greys dependencies and lint that weren't assessed, instead of rating them good", () => {
    const spec = loadRubric("v2").scorecard;
    assert.ok(spec);
    const rows = (metrics: Record<string, Record<string, unknown>>) => Object.fromEntries(computeScorecard(spec, {
      metrics: { census: { files: {}, totals: { code: 1000 } }, tests: { source_code: 1000 }, ...metrics }, findings: [], states: new Map(), lanesRun: new Set(["sca", "lint", "census", "tests"]),
    }).rows.map((r) => [r.key, r.rating]));
    const blind = rows({ sca: { lockfiles: [] }, lint: { linted: [], skipped: [] } });
    assert.equal(blind["dependency_vulns"], "grey");
    assert.equal(blind["lint_errors_per_kloc_x10"], "grey");
    const seen = rows({ sca: { lockfiles: ["package-lock.json"] }, lint: { linted: ["typescript-javascript"], skipped: [] } });
    assert.equal(seen["dependency_vulns"], "green");
    assert.equal(seen["lint_errors_per_kloc_x10"], "green");
  });
});

describe("scorecard percentages under 1%", () => {
  it('read "<1" when something was counted, 0 when nothing was', () => {
    const spec = loadRubric("v2").scorecard;
    assert.ok(spec);
    const value = (maint: Record<string, unknown>) => Object.fromEntries(computeScorecard(spec, { metrics: { maint }, findings: [], states: new Map(), lanesRun: new Set(["maint"]) }).rows.map((r) => [r.key, r.value]));
    const some = value({ complex_functions: 7, complex_functions_pct: 0, duplicated_lines: 64, duplication_pct: 0 });
    assert.deepEqual([some["complex_functions_pct"], some["duplication_pct"]], ["<1", "<1"]);
    const none = value({ complex_functions: 0, complex_functions_pct: 0, duplicated_lines: 0, duplication_pct: 0 });
    assert.deepEqual([none["complex_functions_pct"], none["duplication_pct"]], [0, 0]);
  });
});

describe("test-file conventions", () => {
  it("recognise Swift, .NET and JVM test layouts as tests", () => {
    for (const f of ["mac/Tests/SeanboyCoreTests/NoteStoreTests.swift", "src/App.Tests/OrderTests.cs", "app/src/test/kotlin/NoteTest.kt", "lib/NoteSpec_spec.rb", "android/core/src/main/kotlin/NoteTest.kt"]) {
      assert.ok(matchesAny(f, TEST_GLOBS), f);
    }
    for (const f of ["mac/Sources/SeanboyCore/NoteStore.swift", "src/App/Order.cs", "src/contest.ts"]) assert.ok(!matchesAny(f, TEST_GLOBS), f);
  });
});
