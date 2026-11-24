#!/usr/bin/env node
// Entry point of the app-assistant-trace skill: see SKILL.md, and lib.mjs for what each command reads.
import { run } from './lib.mjs';

process.exitCode = await run(process.argv.slice(2));
