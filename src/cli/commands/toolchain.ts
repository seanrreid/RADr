// Toolchain commands: tools install, doctor, db sync / list.

import { stableSort } from "../../core/determinism.js";
import { RefusedError, UsageError } from "../../core/errors.js";
import { radrHome, resolveEngagement } from "../../engagement/home.js";
import { listSnapshots, syncOsv, OSV_ECOSYSTEMS } from "../../toolchain/db.js";
import { buildLock, diffLocks, doctor as runDoctor, readLock } from "../../toolchain/doctor.js";
import { httpFetcher, installHostPyTools, installNodeTools, installTool } from "../../toolchain/install.js";
import { loadManifest } from "../../toolchain/manifest.js";
import { listContext, syncContext } from "../../toolchain/vulnctx.js";
import { detectRuntime, pullImages } from "../../sandbox/runtime.js";
import { buildImage } from "../../toolchain/image.js";
import { ruleCoverage } from "../../rules/pack.js";
import { canonicalJson } from "../../core/determinism.js";
import { warmDeps } from "../../sandbox/deps.js";
import { loadEngagement } from "../../engagement/config.js";
import { ENGAGEMENT_OPTION, parse } from "../args.js";
import type { CommandSpec } from "../context.js";

export const tools: CommandSpec = {
  name: "tools",
  usage: "radr tools install [--tool <name>] | radr tools build-image",
  summary: "install the pinned toolchain, or build the container toolchain image (network)",
  async run(args, ctx) {
    const { values, positionals } = parse(args, { tool: { type: "string" } }, 1);
    if (positionals[0] === "build-image") {
      const rt = await detectRuntime(ctx.env);
      if (rt === undefined) throw new RefusedError("no container runtime reachable (start Podman or Docker)");
      for (const [image, s] of Object.entries(await pullImages(rt))) ctx.out(`${`image:${image}`.padEnd(12)} ${s} (${rt.name})`);
      const img = await buildImage(radrHome(ctx.env), rt, ctx.out);
      ctx.out(`${img.reused ? "up to date" : "built"}: ${img.tag}`);
      ctx.out(`  id ${img.id}`);
      ctx.out("use it by setting `network: { mode: offline, enforcement: container }` in engagement.yml, then `radr scope`");
      return;
    }
    if (positionals[0] !== "install") throw new UsageError(`unknown tools action "${positionals[0] ?? ""}" (expected: install, build-image)`);
    const home = radrHome(ctx.env);
    const manifest = loadManifest();
    const names = stableSort(Object.keys(manifest.tools), (n) => n);
    const selected = values.tool === undefined ? [...names, "node-tools", "py-tools"] : [values.tool];
    for (const name of selected) {
      if (name !== "node-tools" && name !== "py-tools" && !names.includes(name)) throw new UsageError(`unknown tool "${name}" (known: ${names.join(", ")}, node-tools, py-tools)`);
      const status = name === "node-tools" ? await installNodeTools(home)
        : name === "py-tools" ? await installHostPyTools(home)
        : await installTool(home, name, manifest, httpFetcher);
      ctx.out(`${name.padEnd(12)} ${status === "skipped" ? "skipped (no python3 on PATH: the maint lane needs it in host mode)" : status}`);
    }
    if (values.tool !== undefined) return;
    // Sandbox images are pulled here (network), never during a run (--pull=never).
    const rt = await detectRuntime(ctx.env);
    if (rt === undefined) {
      ctx.out("sandbox      skipped (no Podman/Docker reachable; sandboxed lanes will be unavailable)");
      return;
    }
    for (const [image, s] of Object.entries(await pullImages(rt))) ctx.out(`${`image:${image}`.padEnd(12)} ${s} (${rt.name})`);
  },
};

export const deps: CommandSpec = {
  name: "deps",
  usage: "radr deps warm [-e <id>]",
  summary: "populate the offline dependency cache in the sandbox (network)",
  async run(args, ctx) {
    const { values, positionals } = parse(args, { ...ENGAGEMENT_OPTION }, 1);
    if (positionals[0] !== "warm") throw new UsageError(`unknown deps action "${positionals[0] ?? ""}" (expected: warm)`);
    const home = radrHome(ctx.env);
    const l = resolveEngagement(home, values.engagement, ctx.env, ctx.cwd);
    const rt = await detectRuntime(ctx.env);
    if (rt === undefined) throw new RefusedError("no container runtime reachable (start Podman or Docker)");
    const snap = await warmDeps(home, l, loadEngagement(l.engagementYml), rt, ctx.clock);
    ctx.out(`deps snapshot ${snap.id} (${snap.stacks.join(", ")}; ${snap.files} files); pinned by the next \`radr scope\``);
  },
};

export const doctor: CommandSpec = {
  name: "doctor",
  usage: "radr doctor [-e <id>]",
  summary: "verify the toolchain (and, with -e, against the engagement's lock)",
  async run(args, ctx) {
    const { values } = parse(args, { ...ENGAGEMENT_OPTION }, 0);
    const home = radrHome(ctx.env);
    const checks = await runDoctor(home);
    for (const c of checks) ctx.out(`${c.tool.padEnd(12)} ${c.state.padEnd(8)} ${c.version.padEnd(10)} ${c.detail}`);
    const bad = checks.filter((c) => c.state !== "ok");
    if (bad.length > 0) throw new RefusedError(`${bad.length} tool(s) not ready`);
    if (values.engagement !== undefined || ctx.env["RADR_ENGAGEMENT"] !== undefined) {
      const l = resolveEngagement(home, values.engagement, ctx.env, ctx.cwd);
      const drift = diffLocks(readLock(l.toolchainLock), buildLock(checks));
      for (const d of drift) ctx.out(`drift: ${d}`);
      if (drift.length > 0) throw new RefusedError(`toolchain differs from ${l.id}'s toolchain.lock (version-drift)`);
      ctx.out(`toolchain matches ${l.id}'s lock`);
    }
  },
};

export const db: CommandSpec = {
  name: "db",
  usage: "radr db sync [--only osv|epss|kev] [--ecosystem <name>]... | radr db list",
  summary: "snapshot OSV, EPSS, and CISA KEV for offline scans (network)",
  async run(args, ctx) {
    const { values, positionals } = parse(args, { ecosystem: { type: "string", multiple: true }, only: { type: "string" } }, 1);
    const home = radrHome(ctx.env);
    if (positionals[0] === "list") {
      const snaps = listSnapshots(home);
      for (const s of snaps) ctx.out(`osv   ${s.id}  ${s.fetched_at}  ${Object.keys(s.ecosystems).join(", ")}`);
      for (const kind of ["epss", "kev"] as const) {
        for (const s of listContext(home, kind)) ctx.out(`${kind.padEnd(5)} ${s.id}  ${s.fetched_at}  published ${s.published} (${s.rows} rows)`);
      }
      if (snaps.length === 0) ctx.out("no OSV snapshots (run `radr db sync`)");
      return;
    }
    if (positionals[0] !== "sync") throw new UsageError(`unknown db action "${positionals[0] ?? ""}" (expected: sync, list)`);
    const only = values.only;
    if (only !== undefined && !["osv", "epss", "kev"].includes(only)) throw new UsageError(`--only must be osv, epss, or kev`);
    if (only === undefined || only === "osv") {
      const info = await syncOsv(home, ctx.clock, httpFetcher, values.ecosystem ?? [...OSV_ECOSYSTEMS]);
      ctx.out(`osv   ${info.id} (${Object.keys(info.ecosystems).join(", ")})`);
    }
    for (const kind of ["epss", "kev"] as const) {
      if (only !== undefined && only !== kind) continue;
      const s = await syncContext(home, kind, ctx.clock, httpFetcher);
      ctx.out(`${kind.padEnd(5)} ${s.id} (published ${s.published}, ${s.rows} rows)`);
    }
    ctx.out("pinned by the next `radr scope`");
  },
};

export const rules: CommandSpec = {
  name: "rules",
  usage: "radr rules coverage [--pack authored|pack|lgpl]... [--json]",
  summary: "rule-pack support bar per stack (top-10 CWE targets)",
  run(args, ctx) {
    const { values, positionals } = parse(args, { pack: { type: "string", multiple: true }, json: { type: "boolean" } }, 1);
    if (positionals[0] !== "coverage") throw new UsageError(`unknown rules action "${positionals[0] ?? ""}" (expected: coverage)`);
    const packs = (values.pack ?? ["authored", "pack", "lgpl"]).map((p) => {
      if (p !== "authored" && p !== "pack" && p !== "lgpl") throw new UsageError(`unknown pack "${p}"`);
      return p;
    });
    const cov = ruleCoverage(packs);
    if (values.json === true) {
      ctx.out(canonicalJson(cov.map((c) => ({ ...c }))));
      return;
    }
    ctx.out(`rule packs: ${packs.join(" + ")}`);
    for (const c of cov) {
      ctx.out(`  ${c.stack.padEnd(22)} ${(c.supported ? "supported" : "partial").padEnd(10)} ${String(c.covered.length)}/${String(c.covered.length + c.missing.length)} targets, ${String(c.rules)} rules${c.missing.length > 0 ? `; missing CWE-${c.missing.join(", CWE-")}` : ""}`);
    }
  },
};
