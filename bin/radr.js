#!/usr/bin/env node
import { processContext, runCli } from "../dist/src/cli/main.js";

process.exitCode = await runCli(process.argv.slice(2), processContext());
