// Stack detection (T2.3): which supported stacks are present, from which manifests. Output is
// stable-sorted, so the same tree always yields the same proposal.

import { readdirSync } from "node:fs";
import path from "node:path";
import { stableSort } from "../core/determinism.js";
import type { STACKS } from "./config.js";

type Stack = (typeof STACKS)[number];

/** Directories that hold third-party or generated code, never the client's own source. */
const SKIP_DIRS = new Set([".git", "node_modules", "bower_components", "vendor", ".venv", "venv", "__pycache__", ".tox", ".mypy_cache", ".ruff_cache"]);

const MANIFESTS: Readonly<Record<Stack, RegExp>> = {
  "typescript-javascript": /^(package\.json|package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?|tsconfig(\..+)?\.json)$/,
  python: /^(pyproject\.toml|setup\.py|setup\.cfg|requirements[^/]*\.txt|Pipfile(\.lock)?|poetry\.lock|uv\.lock)$/,
};
const SOURCES: Readonly<Record<Stack, RegExp>> = {
  "typescript-javascript": /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/,
  python: /\.py$/,
};
/** Stacks radr recognizes but does not support until M3, so `scope` can warn about them. */
const UNSUPPORTED: Readonly<Record<string, RegExp>> = {
  go: /^go\.mod$/,
  rust: /^Cargo\.toml$/,
  jvm: /^(pom\.xml|build\.gradle(\.kts)?)$/,
  php: /^composer\.json$/,
  ruby: /^(Gemfile|.+\.gemspec)$/,
  dotnet: /\.(csproj|fsproj|sln)$/,
};

export interface Detection {
  readonly stacks: Stack[];
  readonly manifests: Readonly<Record<Stack, string[]>>;
  readonly unsupported: string[];
}

export function detectStacks(root: string): Detection {
  const manifests: Record<Stack, string[]> = { "typescript-javascript": [], python: [] };
  const sourceSeen: Record<Stack, boolean> = { "typescript-javascript": false, python: false };
  const unsupported = new Set<string>();

  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) continue;
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) walk(abs);
        continue;
      }
      if (!entry.isFile()) continue;
      const rel = path.relative(root, abs).split(path.sep).join("/");
      for (const stack of Object.keys(MANIFESTS) as Stack[]) {
        if (MANIFESTS[stack].test(entry.name)) manifests[stack].push(rel);
        if (SOURCES[stack].test(entry.name)) sourceSeen[stack] = true;
      }
      for (const [name, re] of Object.entries(UNSUPPORTED)) if (re.test(entry.name)) unsupported.add(name);
    }
  };
  walk(root);

  const stacks = (Object.keys(MANIFESTS) as Stack[]).filter((s) => manifests[s].length > 0 || sourceSeen[s]);
  return {
    stacks: stableSort(stacks, (s) => s),
    manifests: {
      "typescript-javascript": stableSort(manifests["typescript-javascript"], (m) => m),
      python: stableSort(manifests.python, (m) => m),
    },
    unsupported: stableSort([...unsupported], (u) => u),
  };
}
