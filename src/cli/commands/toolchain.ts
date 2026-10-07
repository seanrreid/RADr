// Toolchain commands: tools install, doctor, db sync / list.

import { stableSort } from "../../core/determinism.js";
import { RefusedError, UsageError } from "../../core/errors.js";
import { radrHome, resolveEngagement } from "../../engagement/home.js";
import { listSnapshots, syncOsv, OSV_ECOSYSTEMS } from "../../toolchain/db.js";
import { buildLock, diffLocks, doctor as runDoctor, readLock } from "../../toolchain/doctor.js";
import { httpFetcher, installNodeTools, installTool } from "../../toolchain/install.js";
import { loadManifest } from "../../toolchain/manifest.js";
import { listContext, syncContext } from "../../toolchain/vulnctx.js";
import { ENGAGEMENT_OPTION, parse } from "../args.js";
import type { CommandSpec } from "../context.js";

export const tools: CommandSpec = {
  name: "tools",
  usage: "radr tools install [--tool <name>]",
  summary: "download + checksum-verify the pinned toolchain (network)",
  async run(args, ctx) {
    const { values, positionals } = parse(args, { tool: { type: "string" } }, 1);
    if (positionals[0] !== "install") throw new UsageError(`unknown tools action "${positionals[0] ?? ""}" (expected: install)`);
    const home = radrHome(ctx.env);
    const manifest = loadManifest();
    const names = stableSort(Object.keys(manifest.tools), (n) => n);
    const selected = values.tool === undefined ? [...names, "node-tools"] : [values.tool];
    for (const name of selected) {
      if (name !== "node-tools" && !names.includes(name)) throw new UsageError(`unknown tool "${name}" (known: ${names.join(", ")}, node-tools)`);
      const status = name === "node-tools" ? await installNodeTools(home) : await installTool(home, name, manifest, httpFetcher);
      ctx.out(`${name.padEnd(12)} ${status}`);
    }
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
