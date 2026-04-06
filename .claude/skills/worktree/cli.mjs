#!/usr/bin/env node

import { execSync, spawn } from 'child_process';
import { existsSync, copyFileSync } from 'fs';
import { resolve, dirname, basename } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Get the main worktree root (where this script lives)
const MAIN_WORKTREE = resolve(__dirname, '../../..');
const PARENT_DIR = resolve(MAIN_WORKTREE, '..');

function branchToDir(branch) {
  // Convert branch name to directory name (replace slashes with dashes)
  return `model-share-${branch.replace(/\//g, '-')}`;
}

function getWorktreePath(branch) {
  return resolve(PARENT_DIR, branchToDir(branch));
}

function exec(cmd, options = {}) {
  try {
    return execSync(cmd, {
      encoding: 'utf-8',
      cwd: MAIN_WORKTREE,
      stdio: options.silent ? 'pipe' : 'inherit',
      ...options
    });
  } catch (error) {
    if (options.silent) {
      return null;
    }
    throw error;
  }
}

function listWorktrees() {
  const output = exec('git worktree list --porcelain', { silent: true });
  if (!output) return [];

  const worktrees = [];
  let current = {};

  for (const line of output.split('\n')) {
    if (line.startsWith('worktree ')) {
      if (current.path) worktrees.push(current);
      current = { path: line.slice(9) };
    } else if (line.startsWith('HEAD ')) {
      current.head = line.slice(5);
    } else if (line.startsWith('branch ')) {
      current.branch = line.slice(7).replace('refs/heads/', '');
    } else if (line === 'detached') {
      current.detached = true;
    }
  }
  if (current.path) worktrees.push(current);

  return worktrees;
}

async function createWorktree(branch) {
  const worktreePath = getWorktreePath(branch);
  const dirName = branchToDir(branch);

  console.log(`Creating worktree for branch: ${branch}`);
  console.log(`Location: ${worktreePath}\n`);

  // Check if worktree already exists
  if (existsSync(worktreePath)) {
    console.error(`Error: Directory already exists: ${worktreePath}`);
    console.error('Use "remove" command first if you want to recreate it.');
    process.exit(1);
  }

  // Check if branch exists
  const branchExists = exec(`git show-ref --verify --quiet refs/heads/${branch}`, { silent: true }) !== null;
  const remoteBranchExists = exec(`git show-ref --verify --quiet refs/remotes/origin/${branch}`, { silent: true }) !== null;

  try {
    if (branchExists) {
      // Branch exists locally, just add worktree
      console.log(`Using existing local branch: ${branch}`);
      exec(`git worktree add "${worktreePath}" ${branch}`);
    } else if (remoteBranchExists) {
      // Branch exists on remote, track it
      console.log(`Tracking remote branch: origin/${branch}`);
      exec(`git worktree add "${worktreePath}" -b ${branch} origin/${branch}`);
    } else {
      // Create new branch from current HEAD
      console.log(`Creating new branch: ${branch}`);
      exec(`git worktree add -b ${branch} "${worktreePath}"`);
    }
  } catch (error) {
    console.error('Failed to create worktree');
    process.exit(1);
  }

  // Initialize git submodules
  console.log('\nInitializing git submodules...');
  try {
    execSync('git submodule update --init --recursive', {
      cwd: worktreePath,
      stdio: 'inherit',
    });
    console.log('Submodules initialized');
  } catch (error) {
    console.error('\nWarning: git submodule init failed. You may need to run it manually:');
    console.error(`  cd "${worktreePath}" && git submodule update --init --recursive`);
  }

  // Copy .env file
  const envSource = resolve(MAIN_WORKTREE, '.env');
  const envDest = resolve(worktreePath, '.env');

  if (existsSync(envSource)) {
    console.log('\nCopying .env file...');
    copyFileSync(envSource, envDest);
    console.log('Copied .env');
  } else {
    console.log('\nWarning: No .env file found in main worktree');
  }

  // Run pnpm install
  console.log('\nRunning pnpm install...');
  console.log('(This uses pnpm\'s content-addressable store, so it should be fast)\n');

  try {
    execSync('pnpm install', {
      cwd: worktreePath,
      stdio: 'inherit',
    });
  } catch (error) {
    console.error('\nWarning: pnpm install failed. You may need to run it manually.');
  }

  console.log('\n----------------------------------------');
  console.log(`Worktree created successfully!`);
  console.log(`\nLocation: ${worktreePath}`);
  console.log(`Branch: ${branch}`);
  console.log(`\nNext steps:`);
  console.log(`  cd "${worktreePath}"`);
  console.log(`  # Or use /dev-server skill to start the dev server`);
  console.log('----------------------------------------');
}

function removeWorktree(branch) {
  const worktreePath = getWorktreePath(branch);

  console.log(`Removing worktree for branch: ${branch}`);
  console.log(`Location: ${worktreePath}\n`);

  // Check if worktree exists
  const worktrees = listWorktrees();
  const worktree = worktrees.find(w => w.path === worktreePath || w.branch === branch);

  if (!worktree && !existsSync(worktreePath)) {
    console.error(`Error: Worktree not found for branch: ${branch}`);
    process.exit(1);
  }

  try {
    // Remove the worktree
    exec(`git worktree remove "${worktreePath}" --force`);
    console.log('Worktree removed successfully');
  } catch (error) {
    // If that fails, try manual cleanup
    console.log('Standard removal failed, trying manual cleanup...');
    try {
      if (existsSync(worktreePath)) {
        if (process.platform === 'win32') {
          exec(`rmdir /s /q "${worktreePath}"`, { silent: true });
        } else {
          exec(`rm -rf "${worktreePath}"`, { silent: true });
        }
      }
      exec('git worktree prune');
      console.log('Worktree cleaned up successfully');
    } catch (cleanupError) {
      console.error('Failed to clean up worktree. You may need to manually delete:', worktreePath);
      process.exit(1);
    }
  }
}

function showList() {
  const worktrees = listWorktrees();

  console.log('Git Worktrees:\n');

  for (const wt of worktrees) {
    const isMain = wt.path === MAIN_WORKTREE;
    const marker = isMain ? ' (main)' : '';
    const branch = wt.branch || (wt.detached ? 'detached' : 'unknown');
    console.log(`  ${branch}${marker}`);
    console.log(`    Path: ${wt.path}`);
    console.log('');
  }
}

function showHelp() {
  console.log(`
Worktree Setup CLI

Usage:
  node cli.mjs <command> [options]

Commands:
  create <branch>   Create a new worktree for the specified branch
  list              List all worktrees
  remove <branch>   Remove a worktree

Examples:
  node cli.mjs create feature/my-feature
  node cli.mjs create fix/bug-123
  node cli.mjs list
  node cli.mjs remove feature/my-feature
`);
}

// Main
const args = process.argv.slice(2);
const command = args[0];

switch (command) {
  case 'create':
    if (!args[1]) {
      console.error('Error: Branch name required');
      console.error('Usage: node cli.mjs create <branch>');
      process.exit(1);
    }
    await createWorktree(args[1]);
    break;

  case 'list':
    showList();
    break;

  case 'remove':
    if (!args[1]) {
      console.error('Error: Branch name required');
      console.error('Usage: node cli.mjs remove <branch>');
      process.exit(1);
    }
    removeWorktree(args[1]);
    break;

  case 'help':
  case '--help':
  case '-h':
    showHelp();
    break;

  default:
    if (command) {
      console.error(`Unknown command: ${command}\n`);
    }
    showHelp();
    process.exit(command ? 1 : 0);
}
