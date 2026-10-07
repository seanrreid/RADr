// Resolves files that ship inside the radr package (policy/, rubric/, rules/, toolchain/).
// Lookups never leave the package root, which keeps a future single-executable build possible.

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { InternalError } from "./errors.js";

const PACKAGE_NAME = "@torchcodelab/radr";

let cachedRoot: string | undefined;

export function packageRoot(): string {
  if (cachedRoot !== undefined) return cachedRoot;
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (;;) {
    const pkg = path.join(dir, "package.json");
    if (existsSync(pkg)) {
      const parsed = JSON.parse(readFileSync(pkg, "utf8")) as { name?: unknown };
      if (parsed.name === PACKAGE_NAME) return (cachedRoot = dir);
    }
    const parent = path.dirname(dir);
    if (parent === dir) throw new InternalError(`cannot locate ${PACKAGE_NAME} package root`);
    dir = parent;
  }
}

export function assetPath(rel: string): string {
  const root = packageRoot();
  const abs = path.resolve(root, rel);
  if (!abs.startsWith(root + path.sep)) throw new InternalError(`asset path escapes package: ${rel}`);
  return abs;
}

export function readAsset(rel: string): string {
  return readFileSync(assetPath(rel), "utf8");
}
