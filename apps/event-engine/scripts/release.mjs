#!/usr/bin/env node

/**
 * Release Script for metric-event-watcher
 *
 * This script automates the release process:
 * 1. Ensures no uncommitted changes on main branch
 * 2. Switches to release branch
 * 3. Pulls from release branch
 * 4. Merges current main branch into release
 * 5. Pushes release branch
 * 6. Switches back to main
 */

import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Configuration
const MAIN_BRANCH = 'main';
const RELEASE_BRANCH = 'release';
const REMOTE = 'origin';

// ANSI color codes for terminal output
const colors = {
  blue: (text) => `\x1b[34m${text}\x1b[0m`,
  green: (text) => `\x1b[32m${text}\x1b[0m`,
  yellow: (text) => `\x1b[33m${text}\x1b[0m`,
  red: (text) => `\x1b[31m${text}\x1b[0m`
};

// Utility functions for logging
const log = {
  info: (msg) => console.log(colors.blue('ℹ️  ' + msg)),
  success: (msg) => console.log(colors.green('✅ ' + msg)),
  warning: (msg) => console.log(colors.yellow('⚠️  ' + msg)),
  error: (msg) => console.log(colors.red('❌ ' + msg))
};

// Execute git command and return output
function gitCommand(cmd, options = {}) {
  try {
    return execSync(`git ${cmd}`, {
      encoding: 'utf8',
      stdio: options.silent ? 'pipe' : 'inherit',
      ...options
    }).trim();
  } catch (error) {
    if (!options.ignoreError) {
      log.error(`Git command failed: git ${cmd}`);
      throw error;
    }
    return null;
  }
}

// Execute npm command and return output
function npmCommand(cmd, options = {}) {
  try {
    return execSync(`npm ${cmd}`, {
      encoding: 'utf8',
      stdio: options.silent ? 'pipe' : 'inherit',
      ...options
    }).trim();
  } catch (error) {
    if (!options.ignoreError) {
      log.error(`npm command failed: npm ${cmd}`);
      throw error;
    }
    return null;
  }
}

// Get current version from package.json
function getCurrentVersion() {
  const packagePath = path.resolve(__dirname, '..', 'package.json');
  const packageJson = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
  return packageJson.version;
}

// Bump version based on release type
function bumpVersion(currentVersion, releaseType = 'minor') {
  const [major, minor, patch] = currentVersion.split('.').map(Number);

  switch (releaseType) {
    case 'major':
      return `${major + 1}.0.0`;
    case 'minor':
      return `${major}.${minor + 1}.0`;
    case 'patch':
      return `${major}.${minor}.${patch + 1}`;
    default:
      throw new Error(`Invalid release type: ${releaseType}. Use 'major', 'minor', or 'patch'`);
  }
}

// Update package.json with new version
function updatePackageVersion(newVersion) {
  const packagePath = path.resolve(__dirname, '..', 'package.json');
  const packageJson = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
  packageJson.version = newVersion;
  fs.writeFileSync(packagePath, JSON.stringify(packageJson, null, 2) + '\n');
  log.success(`Updated package.json version to ${newVersion}`);
}

// Create and push git tag
function createGitTag(version) {
  const tagName = `v${version}`;
  log.info(`Creating git tag ${tagName}...`);

  try {
    // Check if tag already exists
    const existingTag = gitCommand(`tag -l ${tagName}`, { silent: true, ignoreError: true });
    if (existingTag) {
      log.warning(`Tag ${tagName} already exists, skipping tag creation`);
      return;
    }

    // Create the tag
    gitCommand(`tag -a ${tagName} -m "Release version ${version}"`, { silent: true });
    log.success(`Created tag ${tagName}`);

    // Try to push the tag
    try {
      gitCommand(`push ${REMOTE} ${tagName}`, { silent: true });
      log.success(`Pushed tag ${tagName} to remote`);
    } catch (error) {
      log.warning('Could not push tag to remote (authentication/network issue)');
      log.info(`To push tag manually: git push ${REMOTE} ${tagName}`);
    }
  } catch (error) {
    log.error(`Failed to create tag: ${error.message}`);
    throw error;
  }
}

// Check if we're in a git repository
function checkGitRepo() {
  try {
    gitCommand('rev-parse --git-dir', { silent: true });
  } catch {
    log.error('Not in a git repository!');
    process.exit(1);
  }
}

// Get current branch name
function getCurrentBranch() {
  return gitCommand('branch --show-current', { silent: true });
}

// Check for uncommitted changes
function checkCleanWorkingTree() {
  try {
    gitCommand('diff-index --quiet HEAD --', { silent: true });
  } catch {
    log.error('Working tree is not clean. Please commit or stash your changes.');
    console.log('\nUncommitted changes:');
    gitCommand('status --porcelain');
    process.exit(1);
  }
}

// Run npm run typecheck to validate TypeScript code
function runTypeCheck() {
  log.info('Running type check (npm run typecheck)...');

  try {
    // Run typecheck command with visible output
    execSync('npm run typecheck', {
      encoding: 'utf8',
      stdio: 'inherit'
    });
    log.success('Type check passed');
  } catch (error) {
    log.error('Type check failed');
    if (error.stdout) {
      console.log('\nType check output:');
      console.log(error.stdout);
    }
    if (error.stderr) {
      console.log('\nError output:');
      console.log(error.stderr);
    }
    process.exit(1);
  }
}

// Check if branch exists locally
function branchExistsLocally(branch) {
  try {
    const result = gitCommand(`show-ref --verify refs/heads/${branch}`, { silent: true, ignoreError: true });
    return result !== null;
  } catch {
    return false;
  }
}

// Check if branch exists on remote
function branchExistsRemotely(branch) {
  try {
    gitCommand(`ls-remote --exit-code --heads ${REMOTE} ${branch}`, { silent: true, ignoreError: true });
    return true;
  } catch {
    return false;
  }
}

// Ensure we're on main branch
function ensureOnMain() {
  const currentBranch = getCurrentBranch();
  if (currentBranch !== MAIN_BRANCH) {
    log.info(`Currently on branch '${currentBranch}', switching to '${MAIN_BRANCH}'...`);
    gitCommand(`checkout ${MAIN_BRANCH}`);
  }
  log.success(`On ${MAIN_BRANCH} branch`);
}

// Switch to release branch and set it up
function setupReleaseBranch() {
  log.info(`Switching to ${RELEASE_BRANCH} branch...`);

  if (branchExistsLocally(RELEASE_BRANCH)) {
    log.info('Release branch exists locally, switching to it...');
    gitCommand(`checkout ${RELEASE_BRANCH}`, { silent: true });
  } else {
    log.info('Creating release branch...');
    gitCommand(`checkout -b ${RELEASE_BRANCH}`, { silent: true });
  }

  log.success(`On ${RELEASE_BRANCH} branch`);
}

// Pull from release branch if it exists remotely
function pullReleaseBranch() {
  if (branchExistsRemotely(RELEASE_BRANCH)) {
    log.info(`Pulling latest changes from ${REMOTE}/${RELEASE_BRANCH}...`);
    try {
      gitCommand(`pull ${REMOTE} ${RELEASE_BRANCH}`, { silent: true });
      log.success('Release branch updated');
    } catch (error) {
      log.warning('Could not pull from remote (authentication/network issue)');
      log.info('Continuing with local release branch - this is acceptable for development');
    }
  } else {
    log.info('Release branch does not exist on remote, will be created on push');
  }
}

// Rebase release branch onto main
function rebaseOntoMain() {
  log.info(`Rebasing ${RELEASE_BRANCH} onto ${MAIN_BRANCH}...`);
  gitCommand(`rebase ${MAIN_BRANCH}`, { silent: true });
  log.success('Release branch rebased onto main');
}

// Commit version bump
function commitVersionBump(version) {
  log.info('Committing version bump...');
  gitCommand('add package.json', { silent: true });
  gitCommand(`commit -m "Release version ${version}"`, { silent: true });
  log.success(`Committed version ${version}`);
}

// Push release branch to remote
function pushRelease() {
  log.info(`Pushing ${RELEASE_BRANCH} branch to ${REMOTE}...`);

  try {
    if (branchExistsRemotely(RELEASE_BRANCH)) {
      // Regular push for existing branch
      gitCommand(`push ${REMOTE} ${RELEASE_BRANCH}`, { silent: true });
      log.success('Release branch pushed to remote');
    } else {
      // Set upstream for new branch
      gitCommand(`push -u ${REMOTE} ${RELEASE_BRANCH}`, { silent: true });
      log.success('Release branch created and pushed to remote');
    }
  } catch (error) {
    log.warning('Could not push to remote (authentication/network issue)');
    log.info('Release branch updated locally - manual push may be required');
    log.info(`To push manually: git push ${REMOTE} ${RELEASE_BRANCH}`);
  }
}

// Return to main branch
function returnToMain() {
  log.info(`Returning to ${MAIN_BRANCH} branch...`);
  gitCommand(`checkout ${MAIN_BRANCH}`, { silent: true });
  log.success(`Back on ${MAIN_BRANCH} branch`);
}

// Show deployment summary
function showSummary(version) {
  const mainCommit = gitCommand(`rev-parse --short ${MAIN_BRANCH}`, { silent: true });
  const releaseCommit = gitCommand(`rev-parse --short ${RELEASE_BRANCH}`, { silent: true });

  console.log('');
  log.success('🚀 Release Complete!');
  console.log('');
  console.log(colors.blue('Summary:'));
  console.log(`  Version:        ${colors.green(version)}`);
  console.log(`  Tag:            ${colors.green(`v${version}`)}`);
  console.log(`  Main branch:    ${colors.green(mainCommit)}`);
  console.log(`  Release branch: ${colors.green(releaseCommit)}`);
  console.log(`  Remote:         ${colors.green(REMOTE)}`);
  console.log('');
  console.log(colors.yellow('Next steps:'));
  console.log('  • GitHub Actions will automatically build and deploy the Docker image');
  console.log('  • Monitor the deployment workflow in GitHub Actions');
  console.log('  • Verify deployment in Kubernetes cluster');
  console.log('  • Monitor application logs for any issues');
  console.log('');
  console.log(colors.blue('Pre-release checks completed:'));
  console.log('  • Working tree clean ✓');
  console.log('  • Type check passed ✓');
  console.log('  • Version bumped ✓');
  console.log('  • Git tag created ✓');
  console.log('');
}

// Main release function
function main() {
  let originalBranch;
  let newVersion;

  // Determine release type from command line argument
  const releaseType = process.argv[2] || 'minor';
  if (!['major', 'minor', 'patch'].includes(releaseType)) {
    log.error(`Invalid release type: ${releaseType}`);
    log.info('Usage: npm run release [major|minor|patch]');
    process.exit(1);
  }

  try {
    log.info(`🚀 Starting automated ${releaseType} release process...`);
    console.log('');

    // Pre-release checks
    log.info('Performing pre-release checks...');
    checkGitRepo();
    originalBranch = getCurrentBranch();
    checkCleanWorkingTree();
    runTypeCheck();

    // Ensure we're on main branch
    ensureOnMain();

    // Get current version and bump it
    const currentVersion = getCurrentVersion();
    newVersion = bumpVersion(currentVersion, releaseType);
    log.info(`Bumping version from ${currentVersion} to ${newVersion} (${releaseType} release)`);

    // Update package.json with new version on main branch
    updatePackageVersion(newVersion);

    // Commit the version bump on main branch
    commitVersionBump(newVersion);

    // Now switch to release branch and rebase
    setupReleaseBranch();
    pullReleaseBranch();
    rebaseOntoMain();

    // Create git tag for this release
    createGitTag(newVersion);

    // Push release branch
    pushRelease();
    returnToMain();

    // Show summary
    showSummary(newVersion);

  } catch (error) {
    log.error('Release process failed!');
    if (originalBranch) {
      log.info(`Attempting to return to original branch: ${originalBranch}`);
      try {
        gitCommand(`checkout ${originalBranch}`, { silent: true });
        log.success(`Returned to ${originalBranch} branch`);
      } catch {
        log.error(`Could not return to ${originalBranch}. You may need to manually checkout: git checkout ${originalBranch}`);
      }
    }
    process.exit(1);
  }
}

// Show help text
function showHelp() {
  console.log('Release Script for metric-event-watcher');
  console.log('');
  console.log('Usage: npm run release [release-type]');
  console.log('');
  console.log('Release types:');
  console.log('  major  - Bump major version (1.0.0 -> 2.0.0)');
  console.log('  minor  - Bump minor version (1.0.0 -> 1.1.0) [default]');
  console.log('  patch  - Bump patch version (1.0.0 -> 1.0.1)');
  console.log('');
  console.log('Examples:');
  console.log('  npm run release         # Minor release (default)');
  console.log('  npm run release minor   # Minor release (explicit)');
  console.log('  npm run release patch   # Patch release');
  console.log('  npm run release major   # Major release');
  console.log('');
  console.log('This script will:');
  console.log('  1. Ensure no uncommitted changes on main branch');
  console.log('  2. Run type check (npm run typecheck) - must pass with no errors');
  console.log('  3. Bump version in package.json based on release type');
  console.log('  4. Commit version bump on main branch');
  console.log('  5. Switch to release branch');
  console.log('  6. Pull from release branch (if exists)');
  console.log('  7. Rebase release onto main (keeps linear history)');
  console.log('  8. Create git tag with new version');
  console.log('  9. Push release branch and tag');
  console.log('  10. Switch back to main');
  console.log('');
}

// Parse command line arguments
if (process.argv.includes('--help') || process.argv.includes('-h')) {
  showHelp();
  process.exit(0);
}

// Check if first arg after script name is help
if (process.argv[2] === 'help') {
  showHelp();
  process.exit(0);
}

// Run the release process
main();