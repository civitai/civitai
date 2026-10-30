import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, describe, expect, it } from 'vitest';

// BEHAVIOURAL guard for scripts/release-app.mjs.
//
// release-version.test.ts pins the version arithmetic in isolation, which proves
// nothing about whether release-app.mjs actually CALLS it — a guard that is never
// reached is not a guard. So these run the real script, as a real process, against
// a throwaway git repo with a real (local, bare) remote so `git pull --rebase`
// succeeds and execution reaches the guard.
//
// Everything is offline and confined to a temp dir: no network, no tags or commits
// in the actual repository.

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RELEASE_SCRIPT = path.resolve(HERE, '../release-app.mjs');

const sandboxes: string[] = [];
afterAll(() => {
  for (const dir of sandboxes) rmSync(dir, { recursive: true, force: true });
});

/** A git repo on branch `main`, tracking a bare remote, with apps/moderator at `version`. */
function makeSandbox(version: string, tags: string[]) {
  const root = mkdtempSync(path.join(tmpdir(), 'release-skew-'));
  sandboxes.push(root);
  const remote = path.join(root, 'remote.git');
  const work = path.join(root, 'work');

  const git = (cwd: string, args: string[]) =>
    execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: 'test',
        GIT_AUTHOR_EMAIL: 'test@example.com',
        GIT_COMMITTER_NAME: 'test',
        GIT_COMMITTER_EMAIL: 'test@example.com',
      },
    });

  execFileSync('git', ['init', '--bare', '-b', 'main', remote]);
  execFileSync('git', ['clone', remote, work]);
  git(work, ['config', 'user.name', 'test']);
  git(work, ['config', 'user.email', 'test@example.com']);

  mkdirSync(path.join(work, 'apps/moderator'), { recursive: true });
  writeFileSync(
    path.join(work, 'apps/moderator/package.json'),
    `${JSON.stringify({ name: '@civitai/moderator-app', version, private: true }, null, 2)}\n`
  );
  git(work, ['add', 'apps/moderator/package.json']);
  git(work, ['commit', '-m', 'seed']);
  git(work, ['push', '-u', 'origin', 'main']);
  for (const tag of tags) git(work, ['tag', tag]);

  return { work, git };
}

const RELEASED_TAGS = Array.from({ length: 26 }, (_, i) => `moderator-v0.0.${i + 1}`);

function runRelease(cwd: string, bump: string) {
  return spawnSync(process.execPath, [RELEASE_SCRIPT, 'apps/moderator', 'moderator-v', bump], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  });
}

const versionOf = (work: string) =>
  JSON.parse(readFileSync(path.join(work, 'apps/moderator/package.json'), 'utf8')).version;

describe('release-app.mjs refuses to release from a branch behind the released history', () => {
  it('blocks a patch release and leaves the tree untouched', () => {
    const { work, git } = makeSandbox('0.0.1', RELEASED_TAGS);
    const before = git(work, ['rev-parse', 'HEAD']).trim();

    const res = runRelease(work, 'patch');

    expect(res.status).toBe(1);
    expect(res.stderr).toContain('refusing to release');
    expect(res.stderr).toContain('moderator-v0.0.26 is already released');
    // A refusal must not leave the half-done state the old code did: the version is
    // unbumped and no release commit exists.
    expect(versionOf(work)).toBe('0.0.1');
    expect(git(work, ['rev-parse', 'HEAD']).trim()).toBe(before);
    expect(git(work, ['status', '--porcelain']).trim()).toBe('');
  });

  // The dangerous path: 0.1.0 collides with nothing, so without this guard the
  // release SUCCEEDS and becomes the highest tag for the app.
  it('blocks a minor release, which no tag collision would have caught', () => {
    const { work } = makeSandbox('0.0.1', RELEASED_TAGS);
    expect(RELEASED_TAGS).not.toContain('moderator-v0.1.0');

    const res = runRelease(work, 'minor');

    expect(res.status).toBe(1);
    expect(res.stderr).toContain('refusing to release');
    expect(versionOf(work)).toBe('0.0.1');
  });

  // Positive control: the guard must not block the legitimate release, or it would
  // just be an outage of its own. Runs the script to completion.
  it('allows a release from a branch that carries the released history', () => {
    const { work, git } = makeSandbox('0.0.26', RELEASED_TAGS);

    const res = runRelease(work, 'patch');

    expect(res.stderr).not.toContain('refusing to release');
    expect(res.status).toBe(0);
    expect(versionOf(work)).toBe('0.0.27');
    expect(git(work, ['tag', '-l', 'moderator-v0.0.27']).trim()).toBe('moderator-v0.0.27');
  });

  // An app with no releases yet must still be releasable.
  it('allows the first release of an app that has never been tagged', () => {
    const { work } = makeSandbox('0.0.1', []);

    const res = runRelease(work, 'patch');

    expect(res.stderr).not.toContain('refusing to release');
    expect(res.status).toBe(0);
    expect(versionOf(work)).toBe('0.0.2');
  });
});
