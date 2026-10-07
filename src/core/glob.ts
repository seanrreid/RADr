// Minimal, deterministic glob matching for engagement.yml include/exclude (repo-relative POSIX
// paths). Supports `**` (any depth, incl. none), `*` (within a segment), `?` (one char).
// No braces or classes: scope patterns stay simple enough to review by eye.

const cache = new Map<string, RegExp>();

export function globToRegExp(glob: string): RegExp {
  const cached = cache.get(glob);
  if (cached !== undefined) return cached;
  let re = "^";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i] ?? "";
    if (c === "*" && glob[i + 1] === "*") {
      const slashAfter = glob[i + 2] === "/";
      re += slashAfter ? "(?:.*/)?" : ".*";
      i += slashAfter ? 2 : 1;
    } else if (c === "*") {
      re += "[^/]*";
    } else if (c === "?") {
      re += "[^/]";
    } else {
      re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
  }
  const out = new RegExp(`${re}$`);
  cache.set(glob, out);
  return out;
}

export function matchesAny(file: string, globs: readonly string[]): boolean {
  return globs.some((g) => globToRegExp(g).test(file));
}

/** In scope = matches an include and no exclude. */
export function inScope(file: string, paths: { readonly include: readonly string[]; readonly exclude: readonly string[] }): boolean {
  return matchesAny(file, paths.include) && !matchesAny(file, paths.exclude);
}
