#!/usr/bin/env node

/**
 * Browser Automation Runner
 *
 * Supports two modes:
 * 1. REPL exploration (interactive session for discovering and recording flows)
 * 2. Flow execution (run saved flows directly)
 *
 * REPL Mode:
 *   node runner.mjs --explore <url>
 *   Then send JSON commands via stdin:
 *     {"cmd": "chunk", "label": "Click button", "code": "await page.click('button');"}
 *     {"cmd": "inspect"}
 *     {"cmd": "review"}
 *     {"cmd": "list-flows"}
 *     {"cmd": "flow", "name": "my-flow"}
 *     {"cmd": "save", "name": "my-flow", "keep": [1, 3, 4]}
 *     {"cmd": "exit"}
 *
 * Flow Commands:
 *   --run-flow <name>                  Run a saved flow
 *   --list-flows                       List all saved flows
 *
 * One-shot Commands:
 *   --inspect <url>                    One-shot page inspection
 */

import { existsSync, readdirSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { inspectUrl } from './lib/inspector.mjs';
import { startExploreRepl, runFlow, listFlows, listProfiles } from './lib/session.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Parse command line arguments
function parseArgs() {
  const args = process.argv.slice(2);
  const config = {
    // REPL exploration
    explore: null,

    // Flow commands
    runFlow: null,
    listFlows: false,

    // One-shot commands
    inspectUrl: null,

    // Options
    headless: process.env.BROWSER_HEADLESS === 'true',
    timeout: parseInt(process.env.BROWSER_TIMEOUT || '30000', 10),
    profile: null, // Named profile for persistent auth
    listProfiles: false,
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    switch (arg) {
      // REPL exploration
      case '--explore':
        config.explore = args[++i];
        break;

      // Flow commands
      case '--run-flow':
        config.runFlow = args[++i];
        break;
      case '--list-flows':
        config.listFlows = true;
        break;

      // One-shot commands
      case '--inspect':
        config.inspectUrl = args[++i];
        break;

      // Options
      case '--headless':
        config.headless = true;
        break;
      case '--timeout':
        config.timeout = parseInt(args[++i], 10);
        break;
      case '--profile':
      case '-p':
        config.profile = args[++i];
        break;
      case '--list-profiles':
        config.listProfiles = true;
        break;
      case '--help':
      case '-h':
        printHelp();
        process.exit(0);
    }
  }

  return config;
}

function printHelp() {
  console.log(`
Browser Automation Runner

EXPLORATION MODE (Interactive REPL):

  Start exploring:
    node runner.mjs --explore <url>

  The browser opens and you send JSON commands via stdin:

    Execute code chunk (recorded):
      {"cmd": "chunk", "label": "Navigate to models", "code": "await page.click('a[href=\\"/models\\"]');"}

    Inspect current page:
      {"cmd": "inspect"}

    Review all recorded chunks:
      {"cmd": "review"}

    List available flows:
      {"cmd": "list-flows"}

    Run a flow as a chunk:
      {"cmd": "flow", "name": "browse-to-model"}

    Save selected chunks as flow:
      {"cmd": "save", "name": "my-flow", "keep": [1, 3, 4]}

    Exit session:
      {"cmd": "exit"}

  Output is JSON on stdout, logs on stderr.

FLOW MODE (Run Saved Flows):

  Run a flow:
    node runner.mjs --run-flow <name>

  List flows:
    node runner.mjs --list-flows

ONE-SHOT COMMANDS:

  Inspect a page:
    node runner.mjs --inspect <url>

OPTIONS:

  --headless        Run browser without visible window
  --timeout <ms>    Default timeout for actions (default: 30000)
  --profile, -p     Named profile for persistent auth (cookies/localStorage)
  --list-profiles   List saved auth profiles
  --help, -h        Show this help

AUTHENTICATION PERSISTENCE:

  Save login state to reuse across sessions:
    node runner.mjs --explore https://civitai.com --profile civitai-dev

  During session, use save-auth command to persist current auth:
    {"cmd": "save-auth"}

  Future sessions with same profile auto-load saved auth.
  Profiles stored in .browser/profiles/

EXAMPLE WORKFLOW:

  1. Start exploration:
     node runner.mjs --explore https://example.com

  2. Execute chunks (agent sends these via stdin):
     {"cmd": "chunk", "label": "Click login", "code": "await page.click('button.login');"}
     {"cmd": "chunk", "label": "Fill form", "code": "await page.fill('#email', 'test@example.com');"}

  3. Review what was recorded:
     {"cmd": "review"}

  4. Save the good chunks as a flow:
     {"cmd": "save", "name": "login-flow", "keep": [1, 2]}

  5. Later, replay the flow:
     node runner.mjs --run-flow login-flow
`);
}

// Main execution
async function main() {
  const config = parseArgs();

  // === LIST PROFILES ===
  if (config.listProfiles) {
    const profiles = listProfiles();
    console.log('\n=== SAVED AUTH PROFILES ===\n');
    if (profiles.length === 0) {
      console.log('  No profiles saved yet.');
      console.log('  Use --profile <name> with --explore to create one.');
    } else {
      for (const p of profiles) {
        console.log(`  ${p.name}`);
        console.log(`    Path: ${p.path}`);
        console.log();
      }
    }
    return;
  }

  // === REPL EXPLORATION ===
  if (config.explore) {
    await startExploreRepl(config.explore, {
      headless: config.headless,
      profile: config.profile,
    });
    return;
  }

  // === FLOW COMMANDS ===

  if (config.runFlow) {
    console.log(`Running flow: ${config.runFlow}`);
    try {
      const result = await runFlow(config.runFlow, {
        headless: config.headless,
        timeout: config.timeout,
        profile: config.profile,
      });
      console.log('\n--- FLOW RESULT ---');
      console.log(JSON.stringify(result, null, 2));
      process.exit(result.status === 'passed' ? 0 : 1);
    } catch (e) {
      console.error('Failed to run flow:', e.message);
      process.exit(1);
    }
    return;
  }

  if (config.listFlows) {
    const flows = listFlows();
    console.log('\n=== SAVED FLOWS ===\n');
    if (flows.length === 0) {
      console.log('  No flows saved yet.');
      console.log('  Use --explore to start a session and save flows.');
    } else {
      for (const flow of flows) {
        console.log(`  ${flow.name}`);
        console.log(`    Start URL: ${flow.startUrl}`);
        console.log(`    Path: ${flow.path}`);
        console.log();
      }
    }
    return;
  }

  // === ONE-SHOT COMMANDS ===

  if (config.inspectUrl) {
    console.log(`\nInspecting: ${config.inspectUrl}\n`);
    const result = await inspectUrl(config.inspectUrl, { headless: config.headless });
    console.log('--- PAGE INSPECTION ---');
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  // No command specified
  console.error('No command specified. Use --help for usage information.');
  console.error('\nQuick start:');
  console.error('  node runner.mjs --explore https://example.com   # Start exploring');
  console.error('  node runner.mjs --list-flows                    # See saved flows');
  process.exit(1);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
