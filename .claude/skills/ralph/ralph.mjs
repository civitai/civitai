#!/usr/bin/env node

/**
 * Ralph - Autonomous AI agent loop using Claude Agent SDK
 *
 * Spawns fresh Claude instances for each iteration until all PRD tasks complete.
 * Each iteration gets a clean context window, avoiding context rot.
 *
 * Usage:
 *   node .claude/skills/ralph/ralph.mjs [options]
 *
 * Options:
 *   --prd <path>           Path to prd.json (default: .claude/skills/ralph/prd.json)
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
const defaultProjectRoot = resolve(__dirname, '../../..');

// Parse arguments
const args = process.argv.slice(2);
let prdPath = resolve(__dirname, 'prd.json');
let maxIterations = null; // Will default to story count
let model = 'opus';
let quietMode = false;
let dryRun = false;
let debugMode = false;
let noCommit = false;
let cwdOverride = null;
let maxTurns = 100;

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
  } else if (arg === '--no-commit') {
    noCommit = true;
  } else if (arg === '--cwd' || arg === '-C') {
    cwdOverride = resolve(process.cwd(), args[++i]);
  } else if (arg === '--max-turns' || arg === '-t') {
    maxTurns = parseInt(args[++i], 10);
  } else if (arg === '--help' || arg === '-h') {
    console.log(`
Ralph - Autonomous AI agent loop using Claude Agent SDK

Usage: node .claude/skills/ralph/ralph.mjs [options]

Options:
  --prd, -p <path>         Path to prd.json (default: .claude/skills/ralph/prd.json)
  --max-iterations, -n <n> Maximum iterations (default: number of stories)
  --max-turns, -t <n>      Max tool calls per iteration (default: 100)
  --model, -m <model>      Model: opus, sonnet, haiku (default: opus)
  --cwd, -C <path>         Working directory for Ralph (default: script location)
  --quiet, -q              Suppress iteration banners
  --dry-run                Show what would be done without executing
  --no-commit              Skip git commits (for testing)
  --debug                  Show debug output for message types
  --help, -h               Show this help

Examples:
  node .claude/skills/ralph/ralph.mjs
  node .claude/skills/ralph/ralph.mjs --max-iterations 50
  node .claude/skills/ralph/ralph.mjs --prd ./my-feature/prd.json --model opus
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

// Read progress file path (in same directory as PRD)
const progressPath = resolve(dirname(prdPath), 'progress.txt');

// Validate PRD exists
if (!existsSync(prdPath)) {
  console.error(`Error: PRD not found at ${prdPath}`);
  console.error('Create a PRD first using the /ralph skill');
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

// Build the prompt with PRD and progress paths injected
function buildPrompt() {
  // Replace placeholder paths in prompt template with actual paths
  let prompt = promptTemplate
    .replace(/`[^`]*prd\.json`/g, `\`${prdPath}\``)
    .replace(/`[^`]*progress\.txt`/g, `\`${progressPath}\``);

  // Add no-commit instruction if flag is set
  if (noCommit) {
    prompt += `

## TESTING MODE - NO COMMITS

**DO NOT commit any changes.** This is a test run.
- Make the code changes as normal
- Run typecheck as normal
- Update prd.json to mark story as passing
- Update progress.txt as normal
- But SKIP the git commit step entirely
`;
  }

  return prompt;
}

// Format tool name for logging
function formatToolName(name) {
  // Shorten common tool names for cleaner output
  const shortNames = {
    'Read': 'Read',
    'Write': 'Write',
    'Edit': 'Edit',
    'Bash': 'Bash',
    'Glob': 'Glob',
    'Grep': 'Grep',
    'TodoWrite': 'Todo',
    'WebFetch': 'Fetch',
    'WebSearch': 'Search',
  };
  return shortNames[name] || name;
}

// Run a single iteration using Claude Agent SDK
async function runIteration(prd, story) {
  const { query } = await import('@anthropic-ai/claude-agent-sdk');

  // Build the prompt with correct paths
  const prompt = buildPrompt();

  let fullResponse = '';
  let lastWasToolCall = false;
  let pendingNewline = false;

  // Turn tracking for context-aware warnings
  let turnCount = 0;
  let warned70 = false;
  let warned90 = false;

  // Create turn-tracking hook that injects warnings at thresholds
  const turnTrackingHook = async () => {
    turnCount++;
    const percentUsed = (turnCount / maxTurns) * 100;

    if (!quietMode) {
      // Log turn count periodically
      if (turnCount % 10 === 0) {
        console.log(`  [Turn ${turnCount}/${maxTurns} - ${Math.round(percentUsed)}%]`);
      }
    }

    // 70% warning - suggest checkpoint
    if (percentUsed >= 70 && !warned70) {
      warned70 = true;
      return {
        systemMessage: `⚠️ TURN BUDGET WARNING: You've used ${turnCount} of ${maxTurns} turns (${Math.round(percentUsed)}%). If you're not close to completing this story, consider:
1. Documenting your current progress in progress.txt
2. Noting what's left to do
3. Preparing for a clean handoff to the next iteration`
      };
    }

    // 90% warning - force wrap-up
    if (percentUsed >= 90 && !warned90) {
      warned90 = true;
      return {
        systemMessage: `🚨 TURN BUDGET CRITICAL: You've used ${turnCount} of ${maxTurns} turns (${Math.round(percentUsed)}%). You MUST wrap up NOW:
1. Stop any new work
2. Document exactly what's done and what's remaining in progress.txt
3. If the story isn't complete, leave it as passes: false
4. Exit gracefully - another iteration will continue the work`
      };
    }

    return {};
  };

  // Change to project root so file paths resolve correctly
  const projectRoot = cwdOverride || defaultProjectRoot;
  const originalCwd = process.cwd();
  process.chdir(projectRoot);

  try {
    for await (const message of query({
      prompt,
      options: {
        model,
        maxTurns,
        // Enable project settings so agent has access to skills, CLAUDE.md, etc.
        settingSources: ['project'],
        // Allow the agent to use all tools for autonomous operation
        permissionMode: 'bypassPermissions',
        // Hook to track turns and inject warnings
        hooks: {
          PostToolUse: [{
            hooks: [turnTrackingHook]
          }]
        }
      },
    })) {
      if (debugMode) {
        console.log(`\n[DEBUG] Message type: ${message.type}`);
        console.log(`[DEBUG] Content: ${JSON.stringify(message).substring(0, 300)}`);
      }

      // Handle system messages (init, etc.)
      if (message.type === 'system') {
        if (debugMode) {
          console.log(`[System] ${message.subtype || ''}`);
        }
      }

      // Process content blocks from assistant messages
      const processContent = (content) => {
        if (!content || !Array.isArray(content)) return;

        for (const block of content) {
          // Handle text blocks
          if (block.type === 'text' && block.text) {
            // Add newline before text if we just had tool calls
            if (lastWasToolCall) {
              console.log('');
              lastWasToolCall = false;
            }
            // Ensure text ends with newline for proper formatting
            const text = block.text;
            process.stdout.write(text);
            fullResponse += text;
            // Track if we need a newline after this
            pendingNewline = !text.endsWith('\n');
          }

          // Handle tool_use blocks - log the tool being called
          if (block.type === 'tool_use' && !quietMode) {
            // Add newline before tool call if text didn't end with one
            if (pendingNewline) {
              console.log('');
              pendingNewline = false;
            }
            const toolName = formatToolName(block.name);
            // Extract brief context from input if available
            let context = '';
            if (block.input) {
              if (block.input.file_path) {
                // For file operations, show the path
                const path = block.input.file_path;
                const shortPath = path.length > 50 ? '...' + path.slice(-47) : path;
                context = ` → ${shortPath}`;
              } else if (block.input.command) {
                // For bash, show truncated command
                const cmd = block.input.command;
                const shortCmd = cmd.length > 40 ? cmd.slice(0, 37) + '...' : cmd;
                context = ` → ${shortCmd}`;
              } else if (block.input.pattern) {
                // For glob/grep, show the pattern
                context = ` → ${block.input.pattern}`;
              }
            }
            console.log(`  [${toolName}]${context}`);
            lastWasToolCall = true;
          }
        }
      };

      // Stream assistant content
      if (message.type === 'assistant') {
        processContent(message.content);
        // Some messages might have message.message with content
        if (message.message?.content) {
          processContent(message.message.content);
        }
      }

      // Handle user messages (tool results) - just note completion
      if (message.type === 'user') {
        // Tool results come back as user messages - we don't need to log these
        // as the tool call was already logged above
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

  // Ensure we end with a newline
  if (pendingNewline) {
    console.log('');
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
  let prd = readPrd();
  initProgress(prd);

  const totalStories = prd.userStories.length;
  const initialRemaining = countRemaining(prd);

  // Default maxIterations to story count if not explicitly set
  if (maxIterations === null) {
    maxIterations = totalStories;
  }

  console.log(`
╔══════════════════════════════════════════════════════════════╗
║                         RALPH                                 ║
║           Autonomous AI Agent Loop                            ║
║                                                               ║
║  Model: ${model.padEnd(10)} Iterations: ${String(maxIterations).padEnd(4)} Turns: ${String(maxTurns).padEnd(4)}     ║
╚══════════════════════════════════════════════════════════════╝
`);

  console.log(`PRD: ${prdPath}`);
  console.log(`Progress: ${progressPath}`);
  if (cwdOverride) {
    console.log(`Working dir: ${cwdOverride}`);
  }
  console.log(`Total stories: ${totalStories}`);
  console.log(`Remaining: ${initialRemaining}`);
  if (noCommit) {
    console.log(`Mode: NO-COMMIT (testing)`);
  }
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
