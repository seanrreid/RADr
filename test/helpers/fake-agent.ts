// A scripted stand-in for RADR_AGENT_CMD. Run as `node fake-agent.js <dir>`. Each invocation
// is numbered (1, 2, …) and records what it was given:
//   <dir>/stdin-<n>  the prompt it read
//   <dir>/seen-<n>   {"cwd", "cwd_entries", "env_keys"} as JSON
// and then replays the script for call n:
//   <dir>/response-<n>  written to stdout verbatim (absent: "{}")
//   <dir>/exit-<n>      exit code (absent: 0)

import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";

const dir = process.argv[2];
if (dir === undefined) process.exit(64);
const counter = path.join(dir, "count");
const n = (existsSync(counter) ? Number(readFileSync(counter, "utf8")) : 0) + 1;
writeFileSync(counter, String(n));

writeFileSync(path.join(dir, `stdin-${String(n)}`), readFileSync(0));
const seen = { cwd: process.cwd(), cwd_entries: readdirSync(process.cwd()).length, env_keys: Object.keys(process.env).sort() };
writeFileSync(path.join(dir, `seen-${String(n)}`), JSON.stringify(seen));

const response = path.join(dir, `response-${String(n)}`);
process.stdout.write(existsSync(response) ? readFileSync(response) : "{}");
const exit = path.join(dir, `exit-${String(n)}`);
process.exitCode = existsSync(exit) ? Number(readFileSync(exit, "utf8")) : 0;
