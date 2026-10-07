import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fixedClock } from "../../src/core/clock.js";
import { RefusedError, UsageError } from "../../src/core/errors.js";
import { run } from "../../src/core/exec.js";
import { parseEngagement } from "../../src/engagement/config.js";
import { detectStacks } from "../../src/engagement/detect.js";
import { layout, resolveEngagement } from "../../src/engagement/home.js";
import { initEngagement } from "../../src/engagement/init.js";
import { normalizeOrigin } from "../../src/engagement/scope.js";
import { checkoutWorktree, mirrorSource, resolveSha, setWritable, verifyWorktree } from "../../src/engagement/source.js";
import { invokeAgent } from "../../src/llm/policy.js";
import { EventLog } from "../../src/state/events.js";
import { readScopeInputs, scopeFingerprint } from "../../src/state/fingerprint.js";
import { Gates } from "../../src/state/gates.js";
import { cliRunner } from "../helpers/cli.js";
import { makeFixtureRepo, type FixtureRepo } from "../helpers/fixture-repo.js";
import { tmpDir } from "../helpers/tmp.js";

const clock = fixedClock("2026-10-07T00:00:00Z", 1000);
// Created at module scope: tmpDir() registers an after() hook, which must belong to the file,
// not to a before() hook (where it would fire as soon as that hook finished).
const fixtureRoot = tmpDir();
let fixture: FixtureRepo;
before(async () => { fixture = await makeFixtureRepo(path.join(fixtureRoot, "client-fork")); });

describe("radr init (T2.1)", () => {
  it("creates the layout, a private salt, and an engagement-created event", () => {
    const home = tmpDir();
    const l = initEngagement(home, "acme-corp", "audit", "c@example.com", clock);
    assert.equal(l.id, "acme-corp-audit");
    assert.equal(statSync(l.salt).mode & 0o777, 0o600);
    assert.equal(readFileSync(l.salt, "utf8").length, 64);
    const [created] = new EventLog(l.events, clock).read();
    assert.ok(created);
    assert.equal(created.type, "engagement-created");
    assert.deepEqual([created.data["client"], created.data["slug"]], ["acme-corp", "audit"]);
  });

  it("refuses an existing engagement and rejects invalid names", () => {
    const home = tmpDir();
    initEngagement(home, "acme", "audit", "c@example.com", clock);
    assert.throws(() => initEngagement(home, "acme", "audit", "c@example.com", clock), RefusedError);
    assert.throws(() => initEngagement(home, "Acme", "audit", "c@example.com", clock), UsageError);
    assert.throws(() => initEngagement(home, "acme", "../escape", "c@example.com", clock), UsageError);
  });
});

describe("source snapshot (T2.2)", () => {
  it("mirrors, resolves HEAD, and checks out a read-only worktree at the SHA", async () => {
    const dir = tmpDir();
    const mirror = path.join(dir, "source", "mirror.git");
    const worktree = path.join(dir, "source", "worktree");
    await mirrorSource(fixture.dir, mirror);
    const head = await resolveSha(mirror, undefined);
    assert.equal(head, fixture.commits[2]);
    await checkoutWorktree(mirror, worktree, head);
    assert.equal(statSync(path.join(worktree, "src/server.ts")).mode & 0o222, 0, "files must be read-only");
    await verifyWorktree(worktree, head);
  });

  it("re-checks out at a different SHA (history-only file reappears)", async () => {
    const dir = tmpDir();
    const mirror = path.join(dir, "mirror.git");
    const worktree = path.join(dir, "worktree");
    await mirrorSource(fixture.dir, mirror);
    await checkoutWorktree(mirror, worktree, fixture.commits[2] ?? "");
    assert.equal(existsSync(path.join(worktree, "config/deploy.env")), false);
    await checkoutWorktree(mirror, worktree, fixture.commits[1] ?? "");
    assert.equal(existsSync(path.join(worktree, "config/deploy.env")), true);
  });

  it("detects a wrong SHA, modified files, and untracked files (AC9)", async () => {
    const dir = tmpDir();
    const mirror = path.join(dir, "mirror.git");
    const worktree = path.join(dir, "worktree");
    await mirrorSource(fixture.dir, mirror);
    const head = fixture.commits[2] ?? "";
    await checkoutWorktree(mirror, worktree, head);
    await assert.rejects(verifyWorktree(worktree, fixture.commits[0] ?? ""), /is at .* but scope is approved for/);

    setWritable(worktree, true);
    appendFileSync(path.join(worktree, "README.md"), "tampered\n");
    await assert.rejects(verifyWorktree(worktree, head), /has changes/);

    await checkoutWorktree(mirror, worktree, head);
    setWritable(worktree, true);
    writeFileSync(path.join(worktree, "stray.txt"), "x");
    await assert.rejects(verifyWorktree(worktree, head), /has changes/);
  });

  it("refuses shallow sources and option-like arguments", async () => {
    const dir = tmpDir();
    const shallow = path.join(dir, "shallow");
    const r = await run({ command: "git", args: ["clone", "-q", "--depth", "1", `file://${fixture.dir}`, shallow], cwd: dir, inheritEnv: ["PATH"] });
    assert.equal(r.outcome, "ok", r.stderr.toString());
    await assert.rejects(mirrorSource(shallow, path.join(dir, "m1.git")), /shallow clone/);
    await assert.rejects(mirrorSource("--upload-pack=touch /tmp/pwned", path.join(dir, "m2.git")), UsageError);
    const mirror = path.join(dir, "m3.git");
    await mirrorSource(fixture.dir, mirror);
    await assert.rejects(resolveSha(mirror, "--output=/tmp/x"), UsageError);
    await assert.rejects(resolveSha(mirror, "no-such-branch"), RefusedError);
  });
});

describe("stack detection (T2.3)", () => {
  it("finds TS/JS and Python manifests in sorted order, skipping dependency dirs", () => {
    const root = tmpDir();
    for (const [rel, body] of [
      ["web/package.json", "{}"], ["web/src/a.ts", ""], ["api/pyproject.toml", ""], ["api/requirements-dev.txt", ""],
      ["node_modules/x/package.json", "{}"], [".venv/lib/setup.py", ""], ["svc/go.mod", ""],
    ] as const) {
      mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
      writeFileSync(path.join(root, rel), body);
    }
    const d = detectStacks(root);
    assert.deepEqual(d.stacks, ["python", "typescript-javascript"]);
    assert.deepEqual(d.manifests.python, ["api/pyproject.toml", "api/requirements-dev.txt"]);
    assert.deepEqual(d.manifests["typescript-javascript"], ["web/package.json"]);
    assert.deepEqual(d.unsupported, ["go"]);
  });

  it("detects a stack from source files alone", () => {
    const root = tmpDir();
    writeFileSync(path.join(root, "script.py"), "");
    assert.deepEqual(detectStacks(root).stacks, ["python"]);
  });
});

describe("engagement.yml validation", () => {
  const base = `version: 1
client: acme
slug: audit
engagement_type: health-audit
tier: standard
source: { origin: /x, sha: ${"a".repeat(40)} }
paths: { include: ["**"], exclude: [] }
stacks: [python]
lanes: [lint]
rubric: v0
network: { mode: offline, enforcement: declared }
llm_policy: off
client_licenses: []
`;
  it("accepts a valid doc", () => {
    assert.equal(parseEngagement(base, "e.yml").client, "acme");
  });
  it("rejects unknown keys, unknown lanes, and not-yet-available policies", () => {
    assert.throws(() => parseEngagement(`${base}surprise: 1\n`, "e.yml"), /surprise/);
    assert.throws(() => parseEngagement(base.replace("lanes: [lint]", "lanes: [sast]"), "e.yml"), UsageError);
    assert.throws(() => parseEngagement(base.replace("llm_policy: off", "llm_policy: code-allowed"), "e.yml"), /M4/);
    assert.throws(() => parseEngagement(base.replace("enforcement: declared", "enforcement: container"), "e.yml"), /M3/);
  });
});

describe("CLI: init → scope → approve (T2.4, T2.5, AC7, AC8)", () => {
  it("runs the Gate 1 flow and the gate tracks scope edits", async () => {
    const home = tmpDir();
    const radr = cliRunner(home);
    assert.equal((await radr("init", "acme", "audit")).code, 0);

    const scoped = await radr("scope", "-e", "acme-audit", "--source", fixture.dir);
    assert.equal(scoped.code, 0, scoped.err);
    assert.match(scoped.out, /stacks: python, typescript-javascript/);

    const l = layout(home, "acme-audit");
    const approved = await radr("approve", "scope", "-e", "acme-audit");
    assert.equal(approved.code, 0, approved.err);

    const gates = Gates.load();
    const events = () => new EventLog(l.events, clock).read();
    const current = () => scopeFingerprint(readScopeInputs(l));
    assert.equal(gates.evaluate("scope", events(), { fingerprint: current() }).passed, true);

    // Any edit to the scope closes the gate (AC8)…
    writeFileSync(l.engagementYml, readFileSync(l.engagementYml, "utf8").replace("tier: standard", "tier: deep"));
    assert.equal(gates.evaluate("scope", events(), { fingerprint: current() }).passed, false);
    // …and so does a lock file appearing or changing after approval.
    writeFileSync(l.engagementYml, readFileSync(l.engagementYml, "utf8").replace("tier: deep", "tier: standard"));
    assert.equal(gates.evaluate("scope", events(), { fingerprint: current() }).passed, true);
    writeFileSync(l.snapshotsLock, "osv: changed\n");
    assert.equal(gates.evaluate("scope", events(), { fingerprint: current() }).passed, false);

    assert.deepEqual(events().map((e) => e.type), ["engagement-created", "source-mirrored", "scope-proposed", "scope-approved"]);
  });

  it("re-scoping to another commit keeps consultant edits and moves the worktree", async () => {
    const home = tmpDir();
    const radr = cliRunner(home);
    await radr("init", "acme", "audit");
    await radr("scope", "-e", "acme-audit", "--source", fixture.dir);
    const l = layout(home, "acme-audit");
    writeFileSync(l.engagementYml, readFileSync(l.engagementYml, "utf8").replace("exclude: []", "exclude:\n    - docs/**"));
    const r = await radr("scope", "-e", "acme-audit", "--rev", fixture.commits[0] ?? "");
    assert.equal(r.code, 0, r.err);
    const yml = readFileSync(l.engagementYml, "utf8");
    assert.match(yml, /docs\/\*\*/);
    assert.match(yml, new RegExp(`sha: ${fixture.commits[0] ?? ""}`));
  });

  it("refuses approval when engagement.yml names a SHA the worktree isn't at", async () => {
    const home = tmpDir();
    const radr = cliRunner(home);
    await radr("init", "acme", "audit");
    await radr("scope", "-e", "acme-audit", "--source", fixture.dir);
    const l = layout(home, "acme-audit");
    writeFileSync(l.engagementYml, readFileSync(l.engagementYml, "utf8").replace(fixture.commits[2] ?? "", fixture.commits[0] ?? ""));
    const r = await radr("approve", "scope", "-e", "acme-audit");
    assert.equal(r.code, 1);
    assert.match(r.err, /radr scope --rev/);
  });

  it("maps errors to exit codes: usage 2, refused 1", async () => {
    const home = tmpDir();
    const radr = cliRunner(home);
    assert.equal((await radr("bogus")).code, 2);
    assert.equal((await radr("init", "acme")).code, 2);
    assert.equal((await radr("scope", "-e", "nope-none")).code, 2);
    await radr("init", "acme", "audit");
    assert.equal((await radr("init", "acme", "audit")).code, 1);
    const noActor = cliRunner(home, { RADR_ACTOR: "", HOME: tmpDir() });
    assert.equal((await noActor("init", "other", "x")).code, 1);
  });

  it("resolves the engagement from RADR_ENGAGEMENT or the current directory", () => {
    const home = tmpDir();
    initEngagement(home, "acme", "audit", "c@example.com", clock);
    assert.equal(resolveEngagement(home, undefined, { RADR_ENGAGEMENT: "acme-audit" }, "/").id, "acme-audit");
    assert.equal(resolveEngagement(home, undefined, {}, path.join(home, "engagements", "acme-audit", "raw")).id, "acme-audit");
    assert.throws(() => resolveEngagement(home, undefined, {}, "/"), UsageError);
  });
});

describe("helpers", () => {
  it("normalizeOrigin keeps URLs and scp remotes, absolutizes paths", () => {
    assert.equal(normalizeOrigin("https://github.com/acme/app.git"), "https://github.com/acme/app.git");
    assert.equal(normalizeOrigin("git@github.com:acme/app.git"), "git@github.com:acme/app.git");
    assert.equal(normalizeOrigin("rel/repo"), path.resolve("rel/repo"));
  });

  it("LLM policy off refuses before any process is spawned (T2.6)", async () => {
    await assert.rejects(invokeAgent("off", { purpose: "triage", prompt: "x" }), /policy is "off"/);
  });
});
