// Dependency findings grouped by package (user decision 2026-10-08: npm trees produce hundreds
// of advisories; the report and the plan read per package, with the version to upgrade to).

import { stableSort } from "../core/determinism.js";
import { cvssTenths } from "../rubric/rubric.js";
import { SEVERITIES, type Finding, type Severity } from "./types.js";

/**
 * Order two version strings: numeric dot/dash-separated parts compare numerically, anything else
 * by code point; a release sorts after its pre-release (1.0.0 > 1.0.0-rc.1). Good enough for the
 * semver-like versions OSV reports for npm, PyPI, Go, crates.io, Maven, Packagist, RubyGems, NuGet.
 */
export function compareVersions(a: string, b: string): number {
  const split = (v: string) => v.replace(/^v/, "").split("+")[0]?.split("-") ?? [""];
  const [aMain = "", ...aPre] = split(a);
  const [bMain = "", ...bPre] = split(b);
  const parts = (s: string) => s.split(".");
  const cmp = (x: string, y: string): number => {
    const nx = /^\d+$/.test(x) ? Number(x) : null;
    const ny = /^\d+$/.test(y) ? Number(y) : null;
    if (nx !== null && ny !== null) return nx - ny;
    if (nx !== null) return -1;
    if (ny !== null) return 1;
    return x < y ? -1 : x > y ? 1 : 0;
  };
  const am = parts(aMain);
  const bm = parts(bMain);
  for (let i = 0; i < Math.max(am.length, bm.length); i++) {
    const c = cmp(am[i] ?? "0", bm[i] ?? "0");
    if (c !== 0) return c;
  }
  if (aPre.length === 0 || bPre.length === 0) return aPre.length === bPre.length ? 0 : aPre.length === 0 ? 1 : -1;
  return cmp(aPre.join("-"), bPre.join("-"));
}

export interface PackageGroup {
  /** "name@version" as the scanner reported it. */
  readonly pkg: string;
  readonly ecosystem: string;
  readonly findings: readonly Finding[];
  readonly severity: Severity;
  /** The lowest version that fixes every advisory with a known fix; null if none has one. */
  readonly upgradeTo: string | null;
  /** Advisories with no fixed version. */
  readonly unfixed: number;
  readonly cves: readonly string[];
  /** Highest CVSS base score (as reported, a decimal string), null if none. */
  readonly maxCvss: string | null;
  readonly maxEpssBp: number | null;
  readonly kev: boolean;
  readonly files: readonly string[];
}

const tag = (f: Finding, prefix: string): string | undefined => f.tags.find((t) => t.startsWith(prefix))?.slice(prefix.length);

/** Group findings that carry a `package:` tag; others are returned as they are. */
export function groupByPackage(fs: readonly Finding[]): { groups: PackageGroup[]; rest: Finding[] } {
  const by = new Map<string, Finding[]>();
  const rest: Finding[] = [];
  for (const f of fs) {
    const pkg = tag(f, "package:");
    if (pkg === undefined) rest.push(f);
    else by.set(pkg, [...(by.get(pkg) ?? []), f]);
  }
  const groups = [...by].map(([pkg, members]): PackageGroup => {
    const fixes = members.map((f) => tag(f, "fixed:")).filter((x): x is string => x !== undefined);
    const cvss = members.map((f) => f.cvss).filter((x): x is string => x !== null);
    const epss = members.map((f) => f.epss_bp).filter((x): x is number => x !== null);
    return {
      pkg, ecosystem: tag(members[0] as Finding, "ecosystem:") ?? "", findings: stableSort(members, (f) => f.id),
      severity: members.reduce<Severity>((s, f) => (SEVERITIES.indexOf(f.severity) > SEVERITIES.indexOf(s) ? f.severity : s), "info"),
      upgradeTo: fixes.length === 0 ? null : fixes.reduce((a, b) => (compareVersions(a, b) >= 0 ? a : b)),
      unfixed: members.length - fixes.length,
      cves: stableSort([...new Set(members.flatMap((f) => f.aliases.filter((a) => a.startsWith("CVE-"))))], (x) => x),
      maxCvss: cvss.length === 0 ? null : cvss.reduce((a, b) => (cvssTenths(a) >= cvssTenths(b) ? a : b)),
      maxEpssBp: epss.length === 0 ? null : Math.max(...epss),
      kev: members.some((f) => f.kev === true),
      files: stableSort([...new Set(members.map((f) => f.file))], (x) => x),
    };
  });
  return { groups: stableSort(groups, (g) => [-SEVERITIES.indexOf(g.severity), -g.findings.length, g.pkg]), rest };
}

/** "≥ 4.17.21", "≥ 4.17.21 (2 advisories have no fix yet)", or "no fixed version known". */
export function upgradeText(g: PackageGroup): string {
  if (g.upgradeTo === null) return "no fixed version known";
  return `≥ ${g.upgradeTo}${g.unfixed > 0 ? ` (${String(g.unfixed)} advisor${g.unfixed === 1 ? "y has" : "ies have"} no fix yet)` : ""}`;
}
