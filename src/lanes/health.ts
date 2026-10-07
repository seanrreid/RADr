// M3 health lanes (W2): maint (lizard, jscpd), license (ScanCode + the sca lane's SBOM),
// iac (Checkov, hadolint), hygiene (Scorecard --local). All static: they read the worktree and
// never run client code.
//
// Each tool runs with radr's OWN (empty) config, so a client's .jscpd.json, .checkov.yaml, or
// .hadolint.yaml can't silently suppress baseline checks. Inline suppression comments in the
// code are still honored by the tools, as with lint.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { ParseError } from "../normalize/adapters.js";
import { SCORECARD_CHECKS, checkovAdapter, hadolintAdapter, jscpdAdapter, lizardAdapter, sbomLicenseAdapter, scancodeAdapter, scorecardAdapter, type LicensePolicy } from "../normalize/health-adapters.js";
import { loadRubric } from "../rubric/rubric.js";
import { rawDir, toolEnv, type Lane, type LaneContext } from "./lane.js";
import { bin, combine, fileStep, listFiles, realWorktree, snippetReader, step, type StepOutcome } from "./steps.js";

/** File extensions lizard parses (lizard 1.24.1's language readers). */
const LIZARD_EXTS = new Set([
  "c", "cc", "cjs", "cpp", "cs", "cxx", "erl", "go", "h", "hpp", "java", "js", "jsx", "kt", "kts", "lua", "m", "mjs", "mm",
  "php", "pl", "pm", "py", "r", "rb", "rs", "scala", "sol", "swift", "ts", "tsx", "vue", "zig",
]);
const ext = (f: string): string => (f.includes(".") ? (f.split(".").at(-1) ?? "").toLowerCase() : "");
/** Lockfiles name their dependencies' licenses as text; those are reported once, from the SBOM. */
const LOCKFILES = ["package-lock.json", "npm-shrinkwrap.json", "yarn.lock", "pnpm-lock.yaml", "composer.lock", "Gemfile.lock", "Cargo.lock",
  "poetry.lock", "uv.lock", "Pipfile.lock", "packages.lock.json", "go.sum", "gradle.lockfile"];
const DOCKERFILE = /(^|\/)(Dockerfile|Containerfile)(\.[^/]+)?$|\.(dockerfile|containerfile)$/i;

/** Every lane step that can't run (no inputs) is a success with no findings. */
const skipped = (detail?: string): StepOutcome => ({ outcome: "success", findings: [], ...(detail !== undefined ? { detail } : {}) });

export const maint: Lane = {
  id: "maint",
  tools: ["lizard", "node-tools"],
  async run(ctx) {
    const wt = realWorktree(ctx);
    const dir = rawDir(ctx, "maint");
    const read = snippetReader(wt);
    const metrics: Record<string, unknown> = {};

    // lizard gets an explicit, sorted file list: given a directory it walks in filesystem order
    // and silently drops byte-identical files after the first one it sees.
    const sources = listFiles(wt).filter((f) => LIZARD_EXTS.has(ext(f)));
    const list = path.join(dir, "lizard-files.txt");
    writeFileSync(list, sources.map((f) => `${f}\n`).join(""));
    const lizard = sources.length === 0
      ? skipped()
      : await step(ctx, "maint", "lizard", "lizard.csv",
        () => ctx.tools.exec({
          command: ctx.tools.python, args: ["-m", "lizard", "--csv", "--no-gitignore", "-f", list],
          cwd: wt, env: toolEnv(ctx, ctx.tools.pythonPath === null ? {} : { PYTHONPATH: ctx.tools.pythonPath }), okExitCodes: [0, 1], timeoutMs: 30 * 60 * 1000,
        }),
        (raw, ref) => {
          const r = lizardAdapter({ raw, rawRef: ref, repoRoot: wt, toolVersion: ctx.tools.versions["lizard"] ?? "", snippet: read });
          Object.assign(metrics, r.metrics);
          return r.findings;
        });
    if (sources.length === 0) Object.assign(metrics, { functions: 0, complex_functions: 0, complex_functions_pct: 0 });

    const config = path.join(dir, "jscpd-config.json");
    writeFileSync(config, "{}\n");
    const out = path.join(dir, "jscpd");
    const jscpd = await fileStep(ctx, "maint", "jscpd", path.join(out, "jscpd-report.json"),
      () => ctx.tools.exec({
        command: ctx.tools.node,
        args: [path.join(ctx.tools.nodeTools, "node_modules", "jscpd", "run-jscpd.js"), "--config", config, "--reporters", "json", "--output", out,
          "--silent", "--min-lines", "5", "--min-tokens", "50", "--ignore", "**/.git/**,**/node_modules/**", "."],
        cwd: wt, env: toolEnv(ctx), timeoutMs: 30 * 60 * 1000,
      }),
      (raw, ref) => {
        const r = jscpdAdapter({ raw, rawRef: ref, repoRoot: wt, toolVersion: ctx.tools.versions["node-tools"] ?? "", snippet: read });
        Object.assign(metrics, r.metrics);
        return r.findings;
      });
    return combine([lizard, jscpd], metrics);
  },
};

function licensePolicy(ctx: LaneContext): LicensePolicy | undefined {
  const classify = loadRubric(ctx.doc.rubric).classifyLicense;
  return classify === undefined ? undefined : { classify, clientLicenses: ctx.doc.client_licenses };
}

export const license: Lane = {
  id: "license",
  tools: ["scancode"],
  async run(ctx) {
    const policy = licensePolicy(ctx);
    if (policy === undefined) return { outcome: "tool-error", tools: [], findings: [], detail: `rubric ${ctx.doc.rubric} has no license classes (use v1 or later)` };
    const wt = realWorktree(ctx);
    const metrics: Record<string, unknown> = {};
    const report = path.join(rawDir(ctx, "license"), "scancode.json");
    const scan = await fileStep(ctx, "license", "scancode", report,
      () => ctx.tools.exec({
        command: bin(ctx, "scancode"),
        args: ["--license", "--strip-root", "--processes", "2", "--quiet", "--ignore", "*/.git/*", ...LOCKFILES.flatMap((f) => ["--ignore", f]), "--json", report, "."],
        cwd: wt, env: toolEnv(ctx, { TYPECODE_LIBMAGIC_DB_PATH: "/usr/lib/file/magic.mgc" }), timeoutMs: 60 * 60 * 1000,
      }),
      (raw, ref) => {
        const r = scancodeAdapter({ raw, rawRef: ref, repoRoot: wt, toolVersion: ctx.tools.versions["scancode"] ?? "", snippet: () => null }, policy);
        metrics["files"] = r.metrics.files;
        return r.findings;
      });

    // Dependency licenses come from the sca lane's SBOM for this run (syft reads declared
    // licenses from lockfiles). No SBOM → that half is reported as a gap, never guessed.
    const sbom = path.join(ctx.layout.artifacts, `sbom-${ctx.runId}.spdx.json`);
    let deps: StepOutcome = skipped("no SBOM from the sca lane in this run: dependency licenses not assessed");
    if (existsSync(sbom)) {
      const ref = path.relative(ctx.layout.dir, sbom).split(path.sep).join("/");
      try {
        const r = sbomLicenseAdapter({ raw: readFileSync(sbom, "utf8"), rawRef: ref, repoRoot: wt, toolVersion: ctx.tools.versions["syft"] ?? "", snippet: () => null }, policy);
        metrics["packages"] = r.metrics.packages;
        deps = { outcome: "success", findings: r.findings };
      } catch (e) {
        if (!(e instanceof ParseError)) throw e;
        deps = { outcome: "parse-error", findings: [], detail: e.message };
      }
    }
    return combine([scan, deps], metrics);
  },
};

export const iac: Lane = {
  id: "iac",
  tools: ["checkov", "hadolint"],
  async run(ctx) {
    const wt = realWorktree(ctx);
    const dir = rawDir(ctx, "iac");
    const read = snippetReader(wt);
    // Checkov reads .checkov.yaml from the directory given as `-d DIR` and from its cwd. Passing
    // --directory=DIR (one token) and running from raw/ means only radr's config applies.
    const checkovConfig = path.join(dir, "checkov-config.yml");
    writeFileSync(checkovConfig, "compact: true\n");
    const checkov = await step(ctx, "iac", "checkov", "checkov.json",
      () => ctx.tools.exec({
        command: bin(ctx, "checkov"),
        args: [`--directory=${wt}`, "--config-file", checkovConfig, "--output", "json", "--quiet", "--compact", "--skip-download",
          "--skip-framework", "secrets", "sca_package", "sca_image"],
        cwd: dir, env: toolEnv(ctx), okExitCodes: [0, 1], timeoutMs: 30 * 60 * 1000,
      }),
      (raw, ref) => checkovAdapter({ raw, rawRef: ref, repoRoot: wt, toolVersion: ctx.tools.versions["checkov"] ?? "", snippet: read }));

    const dockerfiles = listFiles(wt).filter((f) => DOCKERFILE.test(f));
    const hadolintConfig = path.join(dir, "hadolint-config.yml");
    writeFileSync(hadolintConfig, "ignored: []\n");
    const hadolint: StepOutcome = dockerfiles.length === 0
      ? skipped()
      : await step(ctx, "iac", "hadolint", "hadolint.json",
        () => ctx.tools.exec({ command: bin(ctx, "hadolint"), args: ["--format", "json", "--no-fail", "--config", hadolintConfig, ...dockerfiles], cwd: wt, env: toolEnv(ctx) }),
        (raw, ref) => hadolintAdapter({ raw, rawRef: ref, repoRoot: wt, toolVersion: ctx.tools.versions["hadolint"] ?? "", snippet: read }));
    return combine([checkov, hadolint], { dockerfiles: dockerfiles.length });
  },
};

export const hygiene: Lane = {
  id: "hygiene",
  tools: ["scorecard"],
  async run(ctx) {
    const wt = realWorktree(ctx);
    let metrics: Record<string, unknown> | undefined;
    const s = await step(ctx, "hygiene", "scorecard", "scorecard.json",
      () => ctx.tools.exec({
        command: bin(ctx, "scorecard"),
        args: ["--local", ".", "--format", "json", "--checks", SCORECARD_CHECKS.join(",")],
        cwd: wt, env: toolEnv(ctx), timeoutMs: 30 * 60 * 1000,
      }),
      (raw, ref) => {
        const r = scorecardAdapter({ raw, rawRef: ref, repoRoot: wt, toolVersion: ctx.tools.versions["scorecard"] ?? "", snippet: () => null });
        metrics = r.metrics;
        return r.findings;
      });
    return combine([s], metrics);
  },
};
