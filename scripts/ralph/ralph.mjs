#!/usr/bin/env node

/**
 * Ralph - Autonomous AI agent loop using Claude Agent SDK
 *
 * Spawns fresh Claude instances for each iteration until all PRD tasks complete.
 * Each iteration gets a clean context window, avoiding context rot.
 *
 * Usage:
 *   node ralph.mjs [options]
 *   npm run ralph [-- options]
 *
 * Options:
 *   --prd <path>           Path to prd.json (default: scripts/ralph/prd.json)
 *   --max-iterations <n>   Maximum iterations (default: 10)
 *   --model <model>        Model to use: opus, sonnet, haiku (default: sonnet)
 *   --quiet                Suppress iteration banners
 *   --dry-run              Show what would be done without executing
 *   --debug                Show debug output for message types
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, '../..');

// Parse arguments
const args = process.argv.slice(2);
let prdPath = resolve(__dirname, 'prd.json');
let maxIterations = 10;
let model = 'sonnet';
let quietMode = false;
let dryRun = false;
let debugMode = false;

for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  if (arg === '--prd' || arg === '-p') {
    prdPath = resolve(process.cwd(), args[++i]);
  } else if (arg === '--max-iterations' || arg === '-n') {
    maxIterations = parseInt(args[++i], 10);
  } else if (arg === '--model' || arg === '-m') {
    model = args[++i];
  } else if (arg === '--quiet' || arg === '-q') {
    quietMode = true;
  } else if (arg === '--dry-run') {
    dryRun = true;
  } else if (arg === '--debug') {
    debugMode = true;
  } else if (arg === '--help' || arg === '-h') {
    console.log(`
Ralph - Autonomous AI agent loop using Claude Agent SDK

Usage: node ralph.mjs [options]

Options:
  --prd, -p <path>         Path to prd.json (default: scripts/ralph/prd.json)
  --max-iterations, -n <n> Maximum iterations (default: 10)
  --model, -m <model>      Model: opus, sonnet, haiku (default: sonnet)
  --quiet, -q              Suppress iteration banners
  --dry-run                Show what would be done without executing
  --debug                  Show debug output for message types
  --help, -h               Show this help

Examples:
  node scripts/ralph/ralph.mjs
  node scripts/ralph/ralph.mjs --max-iterations 50
  node scripts/ralph/ralph.mjs --prd ./my-feature/prd.json --model opus
  npm run ralph -- --max-iterations 20
`);
    process.exit(0);
  }
}

// Read prompt template
const promptPath = resolve(__dirname, 'prompt.md');
if (!existsSync(promptPath)) {
  console.error(`Error: prompt.md not found at ${promptPath}`);
  process.exit(1);
}
const promptTemplate = readFileSync(promptPath, 'utf-8');

// Read progress file path
const progressPath = resolve(__dirname, 'progress.txt');

// Validate PRD exists
if (!existsSync(prdPath)) {
  console.error(`Error: PRD not found at ${prdPath}`);
  console.error('Create a PRD first with: /ralph <path-to-plan.md>');
  process.exit(1);
}

// Read and parse PRD
function readPrd() {
  const content = readFileSync(prdPath, 'utf-8');
  return JSON.parse(content);
}

// Write PRD
function writePrd(prd) {
  writeFileSync(prdPath, JSON.stringify(prd, null, 2));
}

// Get next incomplete story
function getNextStory(prd) {
  const incomplete = prd.userStories
    .filter(s => !s.passes)
    .sort((a, b) => a.priority - b.priority);
  return incomplete[0] || null;
}

// Count remaining stories
function countRemaining(prd) {
  return prd.userStories.filter(s => !s.passes).length;
}

// Initialize or update progress file
function initProgress(prd) {
  if (!existsSync(progressPath)) {
    const content = `# Ralph Progress Log
Started: ${new Date().toISOString()}
Feature: ${prd.description}

## Codebase Patterns
<!-- Patterns will be added as Ralph discovers them -->

---
`;
    writeFileSync(progressPath, content);
  }
}

// Print iteration banner
function printBanner(iteration, maxIterations, story) {
  if (quietMode) return;

  console.log('');
  console.log('═'.repeat(60));
  console.log(`  Ralph Iteration ${iteration} of ${maxIterations}`);
  console.log(`  Working on: ${story.id} - ${story.title}`);
  console.log('═'.repeat(60));
  console.log('');
}

// Run a single iteration using Claude Agent SDK
async function runIteration(prd, story) {
  const { query } = await import('@anthropic-ai/claude-agent-sdk');

  // The prompt is the content of prompt.md
  const prompt = promptTemplate;

  let fullResponse = '';

  // Change to project root so file paths resolve correctly
  const originalCwd = process.cwd();
  process.chdir(projectRoot);

  try {
    for await (const message of query({
      prompt,
      options: {
        model,
        maxTurns: 50,
        // Enable project settings so agent has access to skills, CLAUDE.md, etc.
        settingSources: ['project'],
        // Allow the agent to use all tools for autonomous operation
        permissionMode: 'bypassPermissions',
      },
    })) {
      if (debugMode) {
        console.log(`[DEBUG] Message: ${JSON.stringify(message).substring(0, 200)}`);
      }

      // Handle system messages (init, etc.)
      if (message.type === 'system') {
        if (debugMode) {
          console.log(`[System] ${message.subtype || ''}`);
        }
      }

      // Stream assistant text content to terminal
      if (message.type === 'assistant') {
        if (message.content && Array.isArray(message.content)) {
          for (const block of message.content) {
            if (block.type === 'text' && block.text) {
              process.stdout.write(block.text);
              fullResponse += block.text;
            }
          }
        }
        // Some messages might have message.message with content
        if (message.message?.content && Array.isArray(message.message.content)) {
          for (const block of message.message.content) {
            if (block.type === 'text' && block.text) {
              process.stdout.write(block.text);
              fullResponse += block.text;
            }
          }
        }
      }

      // Handle user messages (tool results)
      if (message.type === 'user' && !quietMode) {
        // Tool results come back as user messages
        if (debugMode && message.content) {
          console.log(`[Tool Result]`);
        }
      }

      // Handle final result
      if (message.type === 'result') {
        if (message.result) {
          console.log('\n' + message.result);
          fullResponse = message.result;
        }
      }
    }
  } catch (err) {
    console.error(`\nError during iteration: ${err.message}`);
    if (debugMode) {
      console.error(err.stack);
    }
    return { completed: false, allDone: false };
  } finally {
    // Restore original cwd
    process.chdir(originalCwd);
  }

  // Check for completion signal
  const allDone = fullResponse.includes('<promise>COMPLETE</promise>');

  // Re-read PRD to see if it was updated
  const updatedPrd = readPrd();
  const storyCompleted = updatedPrd.userStories.find(s => s.id === story.id)?.passes === true;

  return { completed: storyCompleted, allDone };
}

// Main loop
async function main() {
  console.log(`
╔══════════════════════════════════════════════════════════════╗
║                         RALPH                                 ║
║           Autonomous AI Agent Loop                            ║
║                                                               ║
║  Model: ${model.padEnd(10)} Max Iterations: ${String(maxIterations).padEnd(4)}              ║
╚══════════════════════════════════════════════════════════════╝
`);

  let prd = readPrd();
  initProgress(prd);

  const totalStories = prd.userStories.length;
  const initialRemaining = countRemaining(prd);

  console.log(`PRD: ${prdPath}`);
  console.log(`Total stories: ${totalStories}`);
  console.log(`Remaining: ${initialRemaining}`);
  console.log('');

  if (dryRun) {
    console.log('Dry run - would process these stories:');
    prd.userStories
      .filter(s => !s.passes)
      .sort((a, b) => a.priority - b.priority)
      .forEach(s => console.log(`  ${s.id}: ${s.title}`));
    process.exit(0);
  }

  for (let iteration = 1; iteration <= maxIterations; iteration++) {
    // Re-read PRD each iteration (it may have been updated)
    prd = readPrd();

    const story = getNextStory(prd);
    if (!story) {
      console.log('\n✓ All stories complete!');
      process.exit(0);
    }

    printBanner(iteration, maxIterations, story);

    const { completed, allDone } = await runIteration(prd, story);

    if (allDone) {
      console.log('\n');
      console.log('═'.repeat(60));
      console.log('  ✓ RALPH COMPLETE - All tasks finished!');
      console.log(`  Completed in ${iteration} iteration(s)`);
      console.log('═'.repeat(60));
      process.exit(0);
    }

    // Re-read to get updated state
    prd = readPrd();
    const remaining = countRemaining(prd);

    console.log('\n');
    console.log(`Iteration ${iteration} complete.`);
    console.log(`Story ${story.id} ${completed ? '✓ passed' : '✗ not yet complete'}`);
    console.log(`Remaining: ${remaining} stories`);

    if (iteration < maxIterations && remaining > 0) {
      console.log('Starting next iteration in 2 seconds...');
      await new Promise(r => setTimeout(r, 2000));
    }
  }

  console.log('\n');
  console.log('═'.repeat(60));
  console.log(`  Ralph reached max iterations (${maxIterations})`);
  console.log(`  ${countRemaining(readPrd())} stories remaining`);
  console.log('  Run again to continue, or increase --max-iterations');
  console.log('═'.repeat(60));
  process.exit(1);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
