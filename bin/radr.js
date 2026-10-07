#!/usr/bin/env node
import { processContext, runCli } from "../dist/src/cli/main.js";

// A closed pipe (e.g. `radr ... | head`) is not an error: stop quietly, like other CLIs.
for (const stream of [process.stdout, process.stderr]) {
  stream.on("error", (e) => {
    if (e.code === "EPIPE") process.exit(process.exitCode ?? 0);
    throw e;
  });
}

process.exitCode = await runCli(process.argv.slice(2), processContext());
