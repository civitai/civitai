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
import { bumpVersion, releaseSkew, skewMessage } from './lib/release-version.mjs';

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
// Every remote tag, including one cut on a commit this clone already had (an
// automated tagger tags existing `main` commits), so the skew check and the next
// version below see the whole released history.
sh('git fetch --tags --quiet');

// 🔴 Refuse if this branch is BEHIND the app's released history. Checked here —
// after the fetch so the tag list is current, and BEFORE `npm version` so a refusal
// leaves the tree exactly as it found it. See scripts/lib/release-version.mjs for
// the two ways a stale base produces a wrong tag; the dangerous one deploys this
// branch's code to production without colliding with anything.
//
// The release continues from `skew.base`: package.json, or a higher tag that HEAD
// already contains (one cut on `main` without a release commit).
let base;
{
  const currentVersion = JSON.parse(readFileSync(`${appDir}/package.json`, 'utf8')).version;
  const tags = cap('git tag -l').split('\n').filter(Boolean);
  const reachableTags = cap('git tag -l --merged HEAD').split('\n').filter(Boolean);
  const skew = releaseSkew({ currentVersion, tags, tagPrefix, reachableTags });
  if (skew.behind) {
    console.error(
      skewMessage({ appDir, tagPrefix, current: skew.current, highest: skew.highest, branch })
    );
    process.exit(1);
  }
  base = skew.base;
}

// Typecheck this app only, before the bump, so a failure leaves the tree untouched. An app with no
// `typecheck` script (the Go apps) has nothing to check.
if (JSON.parse(readFileSync(`${appDir}/package.json`, 'utf8')).scripts?.typecheck) {
  sh(`pnpm --dir ${appDir} run typecheck`);
} else {
  console.log(`${appDir} has no typecheck script; skipping the typecheck.`);
}

// Set the sub-package version ONLY (no git side effects from npm). The version is
// computed from `base`, not left to `npm version <bump>`, which would bump
// package.json and so reuse a tag that HEAD already carries.
const next = bumpVersion(base, bump);
sh(`npm --prefix ${appDir} version ${next} --no-git-tag-version`);
const version = JSON.parse(readFileSync(`${appDir}/package.json`, 'utf8')).version;
if (version !== next) {
  console.error(`npm set ${appDir}/package.json to ${version}, expected ${next}; not releasing.`);
  process.exit(1);
}
const tag = `${tagPrefix}${version}`;
const app = appDir.split('/').pop();

// Commit ONLY the app's package.json, tag, and push the commit + tag.
sh(`git add ${appDir}/package.json`);
sh(`git commit -m "chore(${app}): release ${tag}"`);
sh(`git tag -a ${tag} -m ${tag}`);
// HUSKY=0: the pre-push hook typechecks the root app, which this commit does not touch, and this
// app was checked above. --atomic: if the tag was taken on the remote since the fetch
// above, the release commit is not pushed without it; re-run to take the next version.
execSync('git push --atomic --follow-tags', {
  stdio: 'inherit',
  env: { ...process.env, HUSKY: '0' },
});

console.log(
  `\nReleased ${tag} (pushed to ${branch}). The tag-webhook will build + Flux will deploy.`
);
