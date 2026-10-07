// Build recipes (PRD §14.1a): STRUCTURED per stack, so radr can derive both the online install
// (`deps warm`) and the offline install (from the dependency cache snapshot) from one approved
// recipe. Only the test command is free-form shell; it runs inside the sandbox.

import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { RefusedError } from "../core/errors.js";

/** Python tools radr installs alongside client deps (pinned; in the dependency cache). */
export const PY_TOOLS = { coverage: "coverage==7.16.2", mypy: "mypy==2.4.0", pytest: "pytest==9.1.1" } as const;

export interface NodeRecipe {
  readonly dir: string;
  /** M2 supports npm lockfiles (package-lock.json / npm-shrinkwrap.json). */
  readonly package_manager: "npm";
  /** Free-form test command (runs in the sandbox), e.g. "npm test". null = no tests. */
  readonly test: string | null;
  readonly tsconfig: string | null;
}

export interface PythonRecipe {
  readonly dir: string;
  readonly requirements: readonly string[];
  /** Install the project itself (pip install .) when it has pyproject.toml/setup.py. */
  readonly install_project: boolean;
  /** pytest arguments (run as `coverage run -m pytest <args>`). null = no tests. */
  readonly pytest_args: readonly string[] | null;
  /** Packages radr adds (pinned): coverage + mypy always; pytest if the client doesn't pin it. */
  readonly extra_packages: readonly string[];
}

/** M3 W5 stacks. `dir` is the project root (where the manifest lives), relative to the repo. */
export interface GoRecipe { readonly dir: string; readonly test: boolean }
export interface RustRecipe { readonly dir: string; readonly test: boolean }
export interface JvmRecipe { readonly dir: string; readonly build_tool: "maven" | "gradle"; readonly test: boolean }
export interface PhpRecipe { readonly dir: string; readonly test: boolean }
export interface RubyRecipe { readonly dir: string; readonly test: "rspec" | "rake" | null }
export interface DotnetRecipe { readonly dir: string; readonly sdk: "8.0" | "10.0"; readonly project: string; readonly test: boolean }

export interface BuildRecipe {
  readonly "typescript-javascript"?: NodeRecipe;
  readonly python?: PythonRecipe;
  readonly go?: GoRecipe;
  readonly rust?: RustRecipe;
  readonly "java-kotlin"?: JvmRecipe;
  readonly php?: PhpRecipe;
  readonly ruby?: RubyRecipe;
  readonly csharp?: DotnetRecipe;
}

export const RECIPE_SCHEMA = {
  type: "object", additionalProperties: false,
  properties: {
    "typescript-javascript": {
      type: "object", additionalProperties: false, required: ["dir", "package_manager", "test", "tsconfig"],
      properties: { dir: { type: "string" }, package_manager: { const: "npm" }, test: { type: ["string", "null"] }, tsconfig: { type: ["string", "null"] } },
    },
    python: {
      type: "object", additionalProperties: false, required: ["dir", "requirements", "install_project", "pytest_args", "extra_packages"],
      properties: {
        dir: { type: "string" }, requirements: { type: "array", items: { type: "string" } }, install_project: { type: "boolean" },
        pytest_args: { anyOf: [{ type: "null" }, { type: "array", items: { type: "string" } }] },
        extra_packages: { type: "array", items: { type: "string", pattern: "^[A-Za-z0-9_.-]+==[A-Za-z0-9_.+-]+$" } },
      },
    },
    go: { type: "object", additionalProperties: false, required: ["dir", "test"], properties: { dir: { type: "string" }, test: { type: "boolean" } } },
    rust: { type: "object", additionalProperties: false, required: ["dir", "test"], properties: { dir: { type: "string" }, test: { type: "boolean" } } },
    "java-kotlin": {
      type: "object", additionalProperties: false, required: ["dir", "build_tool", "test"],
      properties: { dir: { type: "string" }, build_tool: { enum: ["maven", "gradle"] }, test: { type: "boolean" } },
    },
    php: { type: "object", additionalProperties: false, required: ["dir", "test"], properties: { dir: { type: "string" }, test: { type: "boolean" } } },
    ruby: { type: "object", additionalProperties: false, required: ["dir", "test"], properties: { dir: { type: "string" }, test: { enum: ["rspec", "rake", null] } } },
    csharp: {
      type: "object", additionalProperties: false, required: ["dir", "sdk", "project", "test"],
      properties: { dir: { type: "string" }, sdk: { enum: ["8.0", "10.0"] }, project: { type: "string" }, test: { type: "boolean" } },
    },
  },
} as const;

const SAFE_REL = /^[A-Za-z0-9._/-]+$/;

/** Shell-quote a single argument (single quotes; embedded quotes escaped). */
export function q(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

function safeRel(p: string, what: string): string {
  if (!SAFE_REL.test(p) || p.split("/").includes("..") || p.startsWith("/")) throw new RefusedError(`unsafe ${what} path "${p}"`);
  return p;
}

const dirOf = (rel: string): string => (path.posix.dirname(rel) === "." ? "." : path.posix.dirname(rel));
/** Shallowest manifest matching `re` (code-point order breaks ties): the project root for a stack. */
function rootManifest(manifests: readonly string[], re: RegExp): string | undefined {
  return [...manifests].filter((m) => re.test(path.posix.basename(m))).sort((a, b) => a.split("/").length - b.split("/").length || (a < b ? -1 : a > b ? 1 : 0))[0];
}
const read = (worktree: string, rel: string): string => (existsSync(path.join(worktree, rel)) ? readFileSync(path.join(worktree, rel), "utf8") : "");

/** M3 W5 recipes, from detection's manifest lists. */
function proposeStackRecipes(worktree: string, manifests: Readonly<Record<string, readonly string[]>>, out: { -readonly [K in keyof BuildRecipe]: BuildRecipe[K] }): void {
  const has = (dir: string, ...names: string[]): boolean => names.some((n) => existsSync(path.join(worktree, dir, n)));
  const goMod = rootManifest(manifests["go"] ?? [], /^go\.mod$/);
  if (goMod !== undefined) {
    const dir = dirOf(goMod);
    const tests = (manifests["go-tests"] ?? []).length > 0 || /_test\.go/.test(walkNames(path.join(worktree, dir)));
    out.go = { dir, test: tests };
  }
  const cargo = rootManifest(manifests["rust"] ?? [], /^Cargo\.toml$/);
  if (cargo !== undefined) out.rust = { dir: dirOf(cargo), test: true };
  const pom = rootManifest(manifests["java-kotlin"] ?? [], /^pom\.xml$/);
  const gradle = rootManifest(manifests["java-kotlin"] ?? [], /^(settings|build)\.gradle(\.kts)?$/);
  if (pom !== undefined) out["java-kotlin"] = { dir: dirOf(pom), build_tool: "maven", test: has(dirOf(pom), "src/test") };
  else if (gradle !== undefined && has(dirOf(gradle), "gradlew")) out["java-kotlin"] = { dir: dirOf(gradle), build_tool: "gradle", test: has(dirOf(gradle), "src/test") };
  const composer = rootManifest(manifests["php"] ?? [], /^composer\.json$/);
  if (composer !== undefined) out.php = { dir: dirOf(composer), test: /"phpunit\/phpunit"/.test(read(worktree, composer)) };
  const gemfile = rootManifest(manifests["ruby"] ?? [], /^Gemfile$/);
  if (gemfile !== undefined) {
    const dir = dirOf(gemfile);
    const gems = read(worktree, gemfile);
    const test = has(dir, "spec") && /rspec/.test(gems) ? "rspec" : has(dir, "Rakefile") && has(dir, "test") ? "rake" : null;
    out.ruby = { dir, test };
  }
  const project = rootManifest(manifests["csharp"] ?? [], /\.sln$/) ?? rootManifest(manifests["csharp"] ?? [], /\.(csproj|fsproj|vbproj)$/);
  if (project !== undefined) {
    const dir = dirOf(project);
    const projText = (manifests["csharp"] ?? []).filter((m) => /proj$/.test(m)).map((m) => read(worktree, m)).join("\n");
    const sdk = /<TargetFrameworks?>[^<]*net(9|1\d)\.\d/.test(projText) ? "10.0" : "8.0";
    out.csharp = { dir, sdk, project: path.posix.basename(project), test: /Microsoft\.NET\.Test\.Sdk/.test(projText) };
  }
}

/** File names under a directory (bounded walk, skipping dependency dirs): for cheap test detection. */
function walkNames(root: string, depth = 6): string {
  const names: string[] = [];
  const walk = (d: string, n: number): void => {
    if (n < 0 || !existsSync(d)) return;
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (e.isDirectory() && !["vendor", "node_modules", ".git", "target"].includes(e.name)) walk(path.join(d, e.name), n - 1);
      else if (e.isFile()) names.push(e.name);
    }
  };
  walk(root, depth);
  return names.join("\n");
}

/** Propose a recipe from the worktree (the consultant reviews it in engagement.yml). */
export function proposeRecipe(worktree: string, stacks: readonly string[], manifests: Readonly<Record<string, readonly string[]>> = {}): BuildRecipe {
  const out: { -readonly [K in keyof BuildRecipe]: BuildRecipe[K] } = {};
  proposeStackRecipes(worktree, Object.fromEntries(Object.entries(manifests).filter(([k]) => stacks.includes(k))), out);
  if (stacks.includes("typescript-javascript") && existsSync(path.join(worktree, "package.json"))) {
    const pkg = JSON.parse(readFileSync(path.join(worktree, "package.json"), "utf8")) as { scripts?: Record<string, unknown> };
    const testScript = pkg.scripts?.["test"];
    const hasTest = typeof testScript === "string" && !/no test specified/.test(testScript);
    out["typescript-javascript"] = {
      dir: ".", package_manager: "npm", test: hasTest ? "npm test" : null,
      tsconfig: existsSync(path.join(worktree, "tsconfig.json")) ? "tsconfig.json" : null,
    };
  }
  if (stacks.includes("python")) {
    const reqs = ["requirements.txt", "requirements-dev.txt", "requirements-test.txt"].filter((f) => existsSync(path.join(worktree, f)));
    const project = existsSync(path.join(worktree, "pyproject.toml")) || existsSync(path.join(worktree, "setup.py"));
    const pinsPytest = reqs.some((f) => /^pytest\b/m.test(readFileSync(path.join(worktree, f), "utf8")));
    const hasTests = ["tests", "test"].some((d) => existsSync(path.join(worktree, d))) || existsSync(path.join(worktree, "conftest.py"));
    out.python = {
      dir: ".", requirements: reqs, install_project: project,
      pytest_args: hasTests ? [] : null,
      extra_packages: [PY_TOOLS.coverage, PY_TOOLS.mypy, ...(hasTests && !pinsPytest ? [PY_TOOLS.pytest] : [])],
    };
  }
  return out;
}

export const CACHE_MOUNT = "/radr/cache";
export const NODE_TOOLS_MOUNT = "/radr/node-tools";

/** npm install command. `warm` populates the cache online; otherwise install offline from it. */
export function nodeInstall(mode: "warm" | "offline" | "online"): string {
  if (mode === "warm") return `npm ci --ignore-scripts --no-audit --no-fund --cache ${CACHE_MOUNT}/npm`;
  if (mode === "offline") return `npm ci --offline --no-audit --no-fund --cache ${CACHE_MOUNT}/npm`;
  return "npm ci --no-audit --no-fund";
}

/** Python venv + install. `warm` downloads wheels into the cache; offline installs only from it. */
export function pythonInstall(r: PythonRecipe, mode: "warm" | "offline" | "online"): string {
  const reqs = r.requirements.map((f) => `-r ${q(safeRel(f, "requirements"))}`).join(" ");
  const extras = r.extra_packages.map(q).join(" ");
  const project = r.install_project ? "." : "";
  if (mode === "warm") return `python -m pip download --dest ${CACHE_MOUNT}/wheels ${reqs} ${extras} ${project}`.replace(/\s+/g, " ").trim();
  const venv = "python -m venv /tmp/venv && . /tmp/venv/bin/activate";
  const source = mode === "offline" ? `--no-index --find-links ${CACHE_MOUNT}/wheels` : "";
  return `${venv} && pip install ${source} ${reqs} ${extras} ${project}`.replace(/\s+/g, " ").trim();
}
