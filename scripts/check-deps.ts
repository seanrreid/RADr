// Dependency budget + install-script check (PRD §15, M1 AC2). Fails CI when:
//   - there are more than MAX_RUNTIME_DEPS runtime dependencies,
//   - a runtime dependency has no `### <name>` entry in docs/dependencies.md,
//   - any locked package (direct or transitive, dev included) declares an install script
//     that isn't in scripts/install-script-allowlist.json.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const MAX_RUNTIME_DEPS = 8;

export interface DepsInput {
  readonly pkg: { readonly dependencies?: Readonly<Record<string, string>> };
  readonly lock: { readonly packages?: Readonly<Record<string, { readonly hasInstallScript?: boolean }>> };
  readonly docs: string;
  readonly allowlist: readonly string[];
}

export function checkDeps(input: DepsInput): string[] {
  const errors: string[] = [];
  const runtime = Object.keys(input.pkg.dependencies ?? {});

  if (runtime.length > MAX_RUNTIME_DEPS) {
    errors.push(`runtime dependency budget exceeded: ${runtime.length} > ${MAX_RUNTIME_DEPS}`);
  }

  const documented = new Set(
    input.docs.split("\n").flatMap((line) => {
      const m = /^###\s+`?([^`\s]+)`?\s*$/.exec(line);
      return m?.[1] === undefined ? [] : [m[1]];
    }),
  );
  for (const name of runtime) {
    if (!documented.has(name)) errors.push(`runtime dependency "${name}" has no "### ${name}" entry in docs/dependencies.md`);
  }

  for (const [key, meta] of Object.entries(input.lock.packages ?? {})) {
    if (key === "" || meta.hasInstallScript !== true) continue;
    const name = key.replace(/^.*node_modules\//, "");
    if (!input.allowlist.includes(name)) errors.push(`package "${name}" (${key}) has an install script and is not allowlisted`);
  }
  return errors;
}

function main(): void {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
  const read = (rel: string): string => readFileSync(path.join(root, rel), "utf8");
  const errors = checkDeps({
    pkg: JSON.parse(read("package.json")) as DepsInput["pkg"],
    lock: JSON.parse(read("package-lock.json")) as DepsInput["lock"],
    docs: read("docs/dependencies.md"),
    allowlist: JSON.parse(read("scripts/install-script-allowlist.json")) as string[],
  });
  if (errors.length > 0) {
    for (const e of errors) process.stderr.write(`check-deps: ${e}\n`);
    process.exit(1);
  }
  process.stdout.write("check-deps: ok\n");
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
