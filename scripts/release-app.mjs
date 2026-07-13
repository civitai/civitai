#!/usr/bin/env node
// Release a per-app image from the monorepo by cutting a prefixed git tag that
// the in-cluster Tekton `tag-webhook` receiver builds + Flux deploys.
//
//   node scripts/release-app.mjs <appDir> <tagPrefix> <patch|minor|major>
//   e.g. node scripts/release-app.mjs apps/auth auth-app-v patch  ->  auth-app-v0.1.1
//
// WHY a script (not `npm version` inline): `npm version` only creates the git
// commit + tag when the package it operates on contains the repo `.git`. In this
// monorepo `.git` is at the ROOT, so `npm --prefix apps/auth version ...` rewrites
// apps/auth/package.json but SILENTLY skips the commit + tag (exit 0). So we bump
// with `--no-git-tag-version` and do the commit/tag/push explicitly, here, at the
// root — and stage ONLY the app's package.json so unrelated working-tree changes
// are never swept into the release commit.
import { execSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';

const [appDir, tagPrefix, bump] = process.argv.slice(2);
const BUMPS = new Set(['patch', 'minor', 'major']);
if (!appDir || !tagPrefix || !BUMPS.has(bump)) {
  console.error('usage: node scripts/release-app.mjs <appDir> <tagPrefix> <patch|minor|major>');
  process.exit(1);
}
if (!existsSync(`${appDir}/package.json`)) {
  console.error(`no ${appDir}/package.json`);
  process.exit(1);
}

const sh = (cmd) => execSync(cmd, { stdio: 'inherit' });
const cap = (cmd) => execSync(cmd, { encoding: 'utf8' }).trim();

// Releases cut a commit + tag onto the current branch and push it. Require a
// clean tree (so we never commit unrelated changes) and an up-to-date main.
if (cap('git status --porcelain')) {
  console.error('working tree is not clean — commit, stash, or discard changes before releasing.');
  process.exit(1);
}
const branch = cap('git rev-parse --abbrev-ref HEAD');
// Default: releases are cut from 'main'. Set RELEASE_ALLOW_BRANCH=1 to cut from
// the current branch instead (e.g. an app still living on a feature branch that
// hasn't merged to main yet).
if (branch !== 'main' && process.env.RELEASE_ALLOW_BRANCH !== '1') {
  console.error(
    `releases must be cut from 'main' (you are on '${branch}'). ` +
      `Checkout main first, or set RELEASE_ALLOW_BRANCH=1 to release from this branch.`
  );
  process.exit(1);
}
if (branch !== 'main') {
  console.warn(`⚠  releasing from '${branch}' (RELEASE_ALLOW_BRANCH=1), not 'main'.`);
}

sh('git pull --rebase');

// Bump the sub-package version ONLY (no git side effects from npm).
sh(`npm --prefix ${appDir} version ${bump} --no-git-tag-version`);
const version = JSON.parse(readFileSync(`${appDir}/package.json`, 'utf8')).version;
const tag = `${tagPrefix}${version}`;
const app = appDir.split('/').pop();

// Commit ONLY the app's package.json, tag, and push the commit + tag.
sh(`git add ${appDir}/package.json`);
sh(`git commit -m "chore(${app}): release ${tag}"`);
sh(`git tag -a ${tag} -m ${tag}`);
sh('git push --follow-tags');

console.log(`\nReleased ${tag} (pushed to ${branch}). The tag-webhook will build + Flux will deploy.`);
