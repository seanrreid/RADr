// Per-stack sandbox drivers (M3 W5): the environment, install command (warm / offline / online),
// and the type-check, lint, and test steps for each stack radr builds in a stack image. Commands
// run INSIDE the sandbox (src/sandbox/runtime.ts) in /tmp/work/<recipe dir>.
//
// Dependency caches: `deps warm` (online) fills /radr/cache/<kind>; offline runs mount it
// read-only, and tools that write into their cache get a scratch copy first.

import type { FindingDraft } from "../findings/types.js";
import { cargoAdapter, golangciAdapter, goVetAdapter, jvmCompileAdapter, msbuildAdapter, phpstanAdapter, pmdAdapter, rubocopAdapter, type StackAdapterInput } from "../normalize/stack-adapters.js";
import { CACHE_MOUNT, q, type BuildRecipe, type DotnetRecipe, type GoRecipe, type JvmRecipe, type PhpRecipe, type RubyRecipe, type RustRecipe } from "./recipe.js";
import { RUBOCOP_DIR, sandboxToolPaths } from "./stack-images.js";

export const DRIVER_STACKS = ["go", "rust", "java-kotlin", "php", "ruby", "csharp"] as const;
export type DriverStack = (typeof DRIVER_STACKS)[number];
export type InstallMode = "warm" | "offline" | "online";
type AnyRecipe = GoRecipe | RustRecipe | JvmRecipe | PhpRecipe | RubyRecipe | DotnetRecipe;

/** A step whose output radr parses: from its log, or from a file it writes under /radr/out. */
export interface AnalysisStep {
  readonly name: string;
  readonly command: string;
  /** File under /radr/out holding the machine-readable output; null = the step's log. */
  readonly output: string | null;
  /** Needs the project's dependencies installed (otherwise the install step is skipped). */
  readonly needsInstall: boolean;
  readonly tool: string;
  readonly parse: (text: string, inp: StackAdapterInput) => FindingDraft[];
}

export interface Driver {
  readonly stack: DriverStack;
  env(mode: InstallMode): Record<string, string>;
  install(mode: InstallMode): string;
  /** The manifest a "doesn't build" finding points at. */
  readonly manifest: string;
  typecheck(): AnalysisStep | null;
  lint(): AnalysisStep | null;
  /** Test command for run n (1-based); null = no tests declared. Go also writes a cover profile. */
  test(n: number): string | null;
}

/** Warm into container-local storage, then copy into the cache mount: some tools (Maven's
 *  resolver, Gradle) spin on file locks over host-mounted filesystems such as virtiofs. */
const saveCache = (from: string, to: string): string => `mkdir -p ${CACHE_MOUNT}/${to} && cp -R ${from}/. ${CACHE_MOUNT}/${to}/`;
const copyCache = (from: string, to: string): string => `mkdir -p ${to} && if [ -d ${CACHE_MOUNT}/${from} ]; then cp -R ${CACHE_MOUNT}/${from}/. ${to}/; fi`;

function goDriver(r: GoRecipe): Driver {
  const common = { GOCACHE: "/tmp/gocache", GOPATH: "/tmp/gopath", GOTOOLCHAIN: "local", GOTELEMETRY: "off", GOFLAGS: "-mod=mod -buildvcs=false -modcacherw", GOLANGCI_LINT_CACHE: "/tmp/golangci" };
  return {
    stack: "go", manifest: "go.mod",
    env: (mode) => mode === "warm" ? { ...common, GOMODCACHE: `${CACHE_MOUNT}/gomod` }
      : mode === "offline" ? { ...common, GOMODCACHE: "/tmp/gomod", GOPROXY: "off", GOSUMDB: "off" } : { ...common, GOMODCACHE: "/tmp/gomod" },
    install: (mode) => (mode === "offline" ? `${copyCache("gomod", "/tmp/gomod")} && go mod download` : "go mod download"),
    typecheck: () => ({ name: "typecheck", tool: "go-vet", command: "go vet ./...", output: null, needsInstall: true, parse: goVetAdapter }),
    lint: () => ({
      name: "golangci", tool: "golangci-lint", output: "golangci.json", needsInstall: true, parse: golangciAdapter,
      command: "golangci-lint run --no-config --issues-exit-code=0 --show-stats=false --output.json.path=/radr/out/golangci.json --output.text.path=stderr ./...",
    }),
    test: (n) => (r.test ? `mkdir -p /radr/out/cov${String(n)} && go test -count=1 -vet=off -coverprofile=/radr/out/cov${String(n)}/cover.out ./...` : null),
  };
}

function rustDriver(r: RustRecipe): Driver {
  const common = { CARGO_TARGET_DIR: "/tmp/target", CARGO_TERM_COLOR: "never", CARGO_INCREMENTAL: "0" };
  return {
    stack: "rust", manifest: "Cargo.toml",
    env: (mode) => mode === "warm" ? { ...common, CARGO_HOME: `${CACHE_MOUNT}/cargo` }
      : mode === "offline" ? { ...common, CARGO_HOME: "/tmp/cargo", CARGO_NET_OFFLINE: "true" } : { ...common, CARGO_HOME: "/tmp/cargo" },
    install: (mode) => (mode === "offline" ? `${copyCache("cargo", "/tmp/cargo")} && cargo fetch --offline` : "cargo fetch"),
    typecheck: () => ({ name: "typecheck", tool: "rustc", command: "cargo check --all-targets --message-format=json", output: null, needsInstall: true, parse: (t, i) => cargoAdapter(t, i, "errors") }),
    lint: () => ({ name: "clippy", tool: "clippy", command: "cargo clippy --all-targets --message-format=json", output: null, needsInstall: true, parse: (t, i) => cargoAdapter(t, i, "clippy") }),
    test: () => (r.test ? "cargo test --quiet" : null),
  };
}

function jvmDriver(r: JvmRecipe, online: boolean): Driver {
  const runMode: InstallMode = online ? "online" : "offline";
  const t = sandboxToolPaths();
  const pmd: AnalysisStep = {
    name: "pmd", tool: "pmd", output: "pmd.json", needsInstall: false, parse: pmdAdapter,
    command: `${t.pmd} check -d . -R rulesets/java/quickstart.xml -f json --no-cache --no-progress -r /radr/out/pmd.json; rc=$?; [ $rc -eq 0 ] || [ $rc -eq 4 ]`,
  };
  if (r.build_tool === "maven") {
    const mvn = (mode: InstallMode, goals: string): string => `${t.mvn} ${mode === "offline" ? "-o " : ""}-B -q -Dmaven.repo.local=/tmp/m2 ${goals}`;
    return {
      stack: "java-kotlin", manifest: "pom.xml",
      env: () => ({ MAVEN_OPTS: "-Xmx1g" }),
      install: (mode) => mode === "warm" ? `${mvn(mode, "dependency:go-offline")} && ${mvn(mode, "-Dmaven.test.failure.ignore=true test")} && ${saveCache("/tmp/m2", "m2")}`
        : mode === "offline" ? `${copyCache("m2", "/tmp/m2")} && ${mvn(mode, "dependency:resolve")}` : mvn(mode, "dependency:resolve"),
      typecheck: () => ({ name: "typecheck", tool: "javac", command: mvn(runMode, "-DskipTests test-compile"), output: null, needsInstall: true, parse: jvmCompileAdapter }),
      lint: () => pmd,
      test: () => (r.test ? mvn(runMode, "test") : null),
    };
  }
  const gradle = (mode: InstallMode, tasks: string): string => `chmod +x gradlew && ./gradlew --no-daemon --console=plain -q ${mode === "offline" ? "--offline " : ""}${tasks}`;
  return {
    stack: "java-kotlin", manifest: "build.gradle",
    env: () => ({ GRADLE_USER_HOME: "/tmp/gradle", GRADLE_OPTS: "-Xmx1g" }),
    install: (mode) => mode === "warm" ? `${gradle(mode, "testClasses")} && ${saveCache("/tmp/gradle", "gradle")}` : mode === "offline" ? `${copyCache("gradle", "/tmp/gradle")} && ${gradle(mode, "dependencies")}` : gradle(mode, "dependencies"),
    typecheck: () => ({ name: "typecheck", tool: "javac", command: gradle(runMode, "testClasses"), output: null, needsInstall: true, parse: jvmCompileAdapter }),
    lint: () => pmd,
    test: () => (r.test ? gradle(runMode, "test") : null),
  };
}

function phpDriver(r: PhpRecipe): Driver {
  const t = sandboxToolPaths();
  const common = { COMPOSER_HOME: "/tmp/composer-home", COMPOSER_NO_INTERACTION: "1" };
  const install = "php " + t.composer + " install --no-scripts --no-plugins --no-progress --prefer-dist";
  // radr's own PHPStan config: a client phpstan.neon must not change the baseline.
  // PHPStan resolves config paths relative to the config file, so the exclude is absolute.
  const vendor = `${r.dir === "." ? "/tmp/work" : `/tmp/work/${r.dir}`}/vendor (?)`;
  const neon = `printf 'parameters:\\n  excludePaths:\\n    analyse:\\n      - ${vendor}\\n' > /tmp/radr-phpstan.neon`;
  return {
    stack: "php", manifest: "composer.json",
    env: (mode) => mode === "warm" ? { ...common, COMPOSER_CACHE_DIR: `${CACHE_MOUNT}/composer` }
      : mode === "offline" ? { ...common, COMPOSER_CACHE_DIR: "/tmp/composer-cache", COMPOSER_DISABLE_NETWORK: "1" } : { ...common, COMPOSER_CACHE_DIR: "/tmp/composer-cache" },
    install: (mode) => (mode === "offline" ? `${copyCache("composer", "/tmp/composer-cache")} && ${install}` : install),
    typecheck: () => ({
      name: "phpstan", tool: "phpstan", output: "phpstan.json", needsInstall: true, parse: phpstanAdapter,
      command: `${neon} && php -d memory_limit=-1 ${t.phpstan} analyse --no-progress --no-interaction --error-format=json --level=5 -c /tmp/radr-phpstan.neon . > /radr/out/phpstan.json; rc=$?; [ $rc -le 1 ]`,
    }),
    lint: () => null, // PHPStan covers PHP static analysis (types lane)
    test: () => (r.test ? "vendor/bin/phpunit" : null),
  };
}

function rubyDriver(r: RubyRecipe): Driver {
  const common = { BUNDLE_APP_CONFIG: "/tmp/bundle-config", BUNDLE_PATH: "/tmp/bundle", BUNDLE_SILENCE_ROOT_WARNING: "1", BUNDLE_CACHE_PATH: `${CACHE_MOUNT}/gems` };
  const dirAbs = r.dir === "." ? "/tmp/work" : `/tmp/work/${r.dir}`;
  // radr's RuboCop config (Lint + Security only); excludes are absolute because RuboCop resolves them relative to the config file.
  const config = `printf 'AllCops:\\n  NewCops: enable\\n  SuggestExtensions: false\\n  Exclude:\\n    - "${dirAbs}/vendor/**/*"\\n    - "${dirAbs}/node_modules/**/*"\\n' > /tmp/radr-rubocop.yml`;
  return {
    stack: "ruby", manifest: "Gemfile",
    env: () => common,
    install: (mode) => (mode === "warm" ? "bundle cache --all-platforms --no-install" : mode === "offline" ? "bundle install --local --quiet" : "bundle install --quiet"),
    typecheck: () => null, // no type checker in the baseline (Sorbet/RBS are opt-in per project)
    lint: () => ({
      name: "rubocop", tool: "rubocop", output: "rubocop.json", needsInstall: false, parse: rubocopAdapter,
      command: `${config} && BUNDLE_GEMFILE=${RUBOCOP_DIR}/Gemfile BUNDLE_PATH=${RUBOCOP_DIR}/vendor BUNDLE_APP_CONFIG=/tmp/rubocop-bundle bundle exec rubocop --config /tmp/radr-rubocop.yml --only Lint,Security --format json --force-exclusion --cache false . > /radr/out/rubocop.json; rc=$?; [ $rc -le 1 ]`,
    }),
    test: () => (r.test === "rspec" ? "bundle exec rspec" : r.test === "rake" ? "bundle exec rake test" : null),
  };
}

function dotnetDriver(r: DotnetRecipe): Driver {
  const common = {
    DOTNET_CLI_TELEMETRY_OPTOUT: "1", DOTNET_NOLOGO: "1", DOTNET_SKIP_FIRST_TIME_EXPERIENCE: "1", DOTNET_CLI_HOME: "/tmp/home",
    DOTNET_GENERATE_ASPNET_CERTIFICATE: "false", MSBUILDDISABLENODEREUSE: "1",
  };
  const p = q(r.project);
  const build = "--no-restore -nologo -clp:NoSummary -p:TreatWarningsAsErrors=false";
  return {
    stack: "csharp", manifest: r.project,
    env: (mode) => ({ ...common, NUGET_PACKAGES: mode === "warm" ? `${CACHE_MOUNT}/nuget` : "/tmp/nuget" }),
    // The warmed global-packages folder is itself a valid local feed (<id>/<version>/*.nupkg).
    install: (mode) => (mode === "offline" ? `dotnet restore ${p} --source ${CACHE_MOUNT}/nuget` : `dotnet restore ${p}`),
    typecheck: () => ({ name: "typecheck", tool: "dotnet-build", command: `dotnet build ${p} ${build} -p:RunAnalyzers=false`, output: null, needsInstall: true, parse: (t, i) => msbuildAdapter(t, i, "errors") }),
    lint: () => ({
      name: "analyzers", tool: "dotnet-analyzers", output: null, needsInstall: true, parse: (t, i) => msbuildAdapter(t, i, "analyzers"),
      command: `dotnet build ${p} ${build} --no-incremental -p:RunAnalyzers=true -p:EnableNETAnalyzers=true -p:AnalysisLevel=latest -p:AnalysisModeSecurity=All`,
    }),
    test: () => (r.test ? `dotnet test ${p} --no-restore -nologo` : null),
  };
}

/** Drivers for the W5 stacks that have a recipe and were detected. */
export function drivers(build: BuildRecipe | undefined, stacks: readonly string[], online = false): { driver: Driver; recipe: AnyRecipe; dotnetSdk: "8.0" | "10.0" }[] {
  const b = build ?? {};
  const out: { driver: Driver; recipe: AnyRecipe; dotnetSdk: "8.0" | "10.0" }[] = [];
  const add = (stack: DriverStack, recipe: AnyRecipe | undefined, make: () => Driver): void => {
    if (recipe !== undefined && stacks.includes(stack)) out.push({ driver: make(), recipe, dotnetSdk: b.csharp?.sdk ?? "8.0" });
  };
  add("go", b.go, () => goDriver(b.go as GoRecipe));
  add("rust", b.rust, () => rustDriver(b.rust as RustRecipe));
  add("java-kotlin", b["java-kotlin"], () => jvmDriver(b["java-kotlin"] as JvmRecipe, online));
  add("php", b.php, () => phpDriver(b.php as PhpRecipe));
  add("ruby", b.ruby, () => rubyDriver(b.ruby as RubyRecipe));
  add("csharp", b.csharp, () => dotnetDriver(b.csharp as DotnetRecipe));
  return out;
}

/** Does this scope run anything in the build sandbox? (types/coverage, eslint project mode, or W5 stack linters.) */
export function scopeUsesSandbox(doc: { readonly lanes: readonly string[]; readonly lint_modes?: readonly string[]; readonly build?: BuildRecipe; readonly stacks: readonly string[]; readonly tier: string }): boolean {
  if (doc.lanes.includes("types") || doc.lanes.includes("coverage")) return true;
  if ((doc.lint_modes ?? []).includes("project")) return true;
  return doc.lanes.includes("lint") && doc.tier !== "triage" && drivers(doc.build, doc.stacks).some((d) => d.driver.lint() !== null);
}
