// M3 W5 (unit): recipe proposal for the six stacks, driver commands and environments (offline
// installs never reach the network), and when a scope needs the build sandbox.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { canonicalJson } from "../../src/core/determinism.js";
import path from "node:path";
import { detectStacks } from "../../src/engagement/detect.js";
import { proposeRecipe } from "../../src/sandbox/recipe.js";
import { drivers, scopeUsesSandbox } from "../../src/sandbox/stacks.js";
import { stackContainerfile } from "../../src/sandbox/stack-images.js";
import { goCoverAdapter, goModulePath, msbuildAdapter, cargoAdapter, jvmCompileAdapter, goVetAdapter, golangciAdapter, phpstanAdapter, pmdAdapter, rubocopAdapter } from "../../src/normalize/stack-adapters.js";
import { tmpDir } from "../helpers/tmp.js";

function tree(files: Record<string, string>): string {
  const root = tmpDir();
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    writeFileSync(path.join(root, rel), body);
  }
  return root;
}

describe("stack recipes (W5)", () => {
  it("proposes a recipe per detected stack from its shallowest manifest", () => {
    const root = tree({
      "svc/go.mod": "module example.com/svc\n", "svc/x_test.go": "package main\n",
      "rs/Cargo.toml": "[package]\n", "jvm/pom.xml": "<project/>", "jvm/src/test/java/A.java": "",
      "php/composer.json": '{"require-dev":{"phpunit/phpunit":"^11"}}', "rb/Gemfile": "gem 'rspec'\n", "rb/spec/a_spec.rb": "",
      "net/App.sln": "", "net/App/App.csproj": "<Project><PropertyGroup><TargetFramework>net10.0</TargetFramework></PropertyGroup><ItemGroup><PackageReference Include=\"Microsoft.NET.Test.Sdk\"/></ItemGroup></Project>",
    });
    const d = detectStacks(root);
    const r = proposeRecipe(root, d.stacks, d.manifests);
    assert.deepEqual(r.go, { dir: "svc", test: true });
    assert.deepEqual(r.rust, { dir: "rs", test: true });
    assert.deepEqual(r["java-kotlin"], { dir: "jvm", build_tool: "maven", test: true });
    assert.deepEqual(r.php, { dir: "php", test: true });
    assert.deepEqual(r.ruby, { dir: "rb", test: "rspec" });
    assert.deepEqual(r.csharp, { dir: "net", sdk: "10.0", project: "App.sln", test: true });
  });

  it("gradle needs a wrapper; without one there is no JVM recipe", () => {
    const root = tree({ "build.gradle.kts": "plugins { java }\n", "src/main/java/A.java": "" });
    const d = detectStacks(root);
    assert.equal(proposeRecipe(root, d.stacks, d.manifests)["java-kotlin"], undefined);
  });
});

describe("stack drivers (W5)", () => {
  const all = drivers({
    go: { dir: ".", test: true }, rust: { dir: ".", test: true }, "java-kotlin": { dir: ".", build_tool: "maven", test: true },
    php: { dir: ".", test: false }, ruby: { dir: ".", test: "rake" }, csharp: { dir: ".", sdk: "8.0", project: "App.csproj", test: false },
  }, ["go", "rust", "java-kotlin", "php", "ruby", "csharp"]);

  it("offline installs only ever read the warmed cache", () => {
    const env = (s: string) => all.find((x) => x.driver.stack === s)?.driver.env("offline") ?? {};
    const install = (s: string) => all.find((x) => x.driver.stack === s)?.driver.install("offline") ?? "";
    assert.equal(env("go")["GOPROXY"], "off");
    assert.equal(env("rust")["CARGO_NET_OFFLINE"], "true");
    assert.match(install("java-kotlin"), / -o /);
    assert.equal(env("php")["COMPOSER_DISABLE_NETWORK"], "1");
    assert.match(install("ruby"), /--local/);
    assert.match(install("csharp"), /--source \/radr\/cache\/nuget/);
  });

  it("tests: only when the recipe declares them; Go writes a cover profile per run", () => {
    const test = (s: string, n: number) => all.find((x) => x.driver.stack === s)?.driver.test(n);
    assert.match(test("go", 2) ?? "", /-coverprofile=\/radr\/out\/cov2\/cover\.out/);
    assert.equal(test("php", 1), null);
    assert.equal(test("ruby", 1), "bundle exec rake test");
  });

  it("linters use radr's own configuration, never the client's", () => {
    const lint = (s: string) => all.find((x) => x.driver.stack === s)?.driver.lint()?.command ?? "";
    assert.match(lint("go"), /--no-config/);
    assert.match(lint("ruby"), /--config \/tmp\/radr-rubocop\.yml/);
    assert.match(lint("java-kotlin"), /rulesets\/java\/quickstart\.xml/);
  });

  it("a scope uses the sandbox for W5 linters (not in triage)", () => {
    const doc = { lanes: ["lint"], stacks: ["go"], build: { go: { dir: ".", test: false } }, tier: "standard" };
    assert.equal(scopeUsesSandbox(doc), true);
    assert.equal(scopeUsesSandbox({ ...doc, tier: "triage" }), false);
    assert.equal(scopeUsesSandbox({ ...doc, stacks: [] }), false);
  });

  it("stack images build from pinned digests with verified tools", () => {
    assert.match(stackContainerfile("go"), /FROM docker\.io\/library\/golang@sha256:[0-9a-f]{64}/);
    assert.match(stackContainerfile("go"), /fetch\.py/);
    assert.match(stackContainerfile("ruby"), /BUNDLE_FROZEN=true/);
    assert.match(stackContainerfile("rust"), /rustup component add clippy/);
  });
});

describe("stack adapters (W5)", () => {
  const inp = { dir: "svc", rawRef: "raw/x.log", toolVersion: "t", snippet: () => null };
  it("go vet / compile lines map to repo paths; other lines are ignored", () => {
    const f = goVetAdapter("# example.com/svc\n./main.go:15:2: fmt.Printf format %d has arg ID() of wrong type string\nok\n", inp);
    assert.deepEqual(f.map((x) => [x.file, x.line, x.tool]), [["svc/main.go", 15, "go-vet"]]);
  });
  it("cargo JSON: errors for types, clippy:: lints for lint", () => {
    const msg = (level: string, code: string) => JSON.stringify({ reason: "compiler-message", message: { level, message: "m", code: { code }, spans: [{ is_primary: true, file_name: "src/lib.rs", line_start: 7, line_end: 7 }] } });
    const log = ["Compiling svc", msg("warning", "clippy::len_zero"), msg("error", "E0308"), msg("warning", "unused_variables")].join("\n");
    assert.deepEqual(cargoAdapter(log, inp, "errors").map((x) => x.rule_id), ["E0308"]);
    assert.deepEqual(cargoAdapter(log, inp, "clippy").map((x) => x.rule_id), ["clippy::len_zero"]);
  });
  it("javac (Maven, Gradle) and kotlinc errors", () => {
    const log = "[ERROR] /tmp/work/svc/src/A.java:[3,5] cannot find symbol\n/tmp/work/svc/src/B.java:9: error: ';' expected\ne: file:///tmp/work/svc/src/C.kt:4:1 Unresolved reference: x\n";
    assert.deepEqual(jvmCompileAdapter(log, inp).map((x) => [x.file, x.line]), [["svc/src/A.java", 3], ["svc/src/B.java", 9], ["svc/src/C.kt", 4]]);
  });
  it("MSBuild: errors vs CA analyzers, deduplicated across targets", () => {
    const line = "/tmp/work/svc/Token.cs(10,17): warning CA5394: Random is an insecure random number generator [/tmp/work/svc/Svc.csproj]";
    const log = `${line}\n${line}\n/tmp/work/svc/X.cs(1,1): error CS0029: Cannot convert [/tmp/work/svc/Svc.csproj]\n`;
    assert.deepEqual(msbuildAdapter(log, inp, "analyzers").map((x) => [x.rule_id, x.category]), [["CA5394", "security"]]);
    assert.deepEqual(msbuildAdapter(log, inp, "errors").map((x) => x.rule_id), ["CS0029"]);
  });
  it("Go cover profiles: statements per file, a block hit by any test binary counts", () => {
    const profile = "mode: set\nexample.com/svc/main.go:10.1,12.2 2 1\nexample.com/svc/main.go:14.1,16.2 3 0\nexample.com/svc/main.go:14.1,16.2 3 1\nexample.com/svc/util.go:1.1,2.2 1 0\n";
    const c = goCoverAdapter(profile, goModulePath("module example.com/svc\n\ngo 1.27\n"), "svc");
    assert.deepEqual(c.files["svc/main.go"], { lines_found: 5, lines_hit: 5, branches_found: 0, branches_hit: 0 });
    assert.deepEqual(c.totals, { lines_found: 6, lines_hit: 5, branches_found: 0, branches_hit: 0 });
  });
});

describe("stack adapter goldens (real output from the pinned stack images)", () => {
  const golden = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../test/golden/stacks");
  const read = (f: string) => readFileSync(path.join(golden, f), "utf8");
  const inp = (dir: string, ref: string) => ({ dir, rawRef: ref, toolVersion: "pinned", snippet: () => null });
  function check(name: string, actual: unknown): void {
    const file = path.join(golden, `${name}.expected.jsonl`);
    const lines = (Array.isArray(actual) ? actual : [actual]).map((x) => canonicalJson(x)).join("\n") + "\n";
    if (process.env["UPDATE_GOLDEN"] === "1" || !existsSync(file)) writeFileSync(file, lines);
    assert.equal(lines, readFileSync(file, "utf8"), `${name} golden output changed`);
  }
  it("go vet", () => { check("go-vet", goVetAdapter(read("go-vet.log"), inp("go-svc", "raw/go-vet.log"))); });
  it("golangci-lint", () => { check("golangci", golangciAdapter(read("golangci.json"), inp("go-svc", "raw/golangci.json"))); });
  it("clippy", () => { check("clippy", cargoAdapter(read("clippy.log"), inp("rust-svc", "raw/clippy.log"), "clippy")); });
  it("phpstan", () => { check("phpstan", phpstanAdapter(read("phpstan.json"), inp("php-svc", "raw/phpstan.json"))); });
  it("pmd", () => { check("pmd", pmdAdapter(read("pmd.json"), inp("jvm-svc", "raw/pmd.json"))); });
  it("rubocop", () => { check("rubocop", rubocopAdapter(read("rubocop.json"), inp("ruby-svc", "raw/rubocop.json"))); });
  it("dotnet analyzers", () => { check("analyzers", msbuildAdapter(read("analyzers.log"), inp("net-svc", "raw/analyzers.log"), "analyzers")); });
  it("go cover profile", () => { check("cover", goCoverAdapter(read("cover.out"), "example.com/svc", "go-svc")); });
});
