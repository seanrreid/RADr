// Build recipes (PRD §14.1a): STRUCTURED per stack, so radr can derive both the online install
// (`deps warm`) and the offline install (from the dependency cache snapshot) from one approved
// recipe. Only the test command is free-form shell; it runs inside the sandbox.

import { existsSync, readFileSync } from "node:fs";
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

export interface BuildRecipe {
  readonly "typescript-javascript"?: NodeRecipe;
  readonly python?: PythonRecipe;
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

/** Propose a recipe from the worktree (the consultant reviews it in engagement.yml). */
export function proposeRecipe(worktree: string, stacks: readonly string[]): BuildRecipe {
  const out: { -readonly [K in keyof BuildRecipe]: BuildRecipe[K] } = {};
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
