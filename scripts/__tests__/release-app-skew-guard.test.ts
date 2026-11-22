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

/**
 * A git repo on branch `main`, tracking a bare remote, with apps/moderator at `version`.
 *
 * `tags` are cut on a commit of an unmerged side branch, as the real moderator
 * releases were: history `main` does NOT contain. `headTags` are cut on `main`'s HEAD
 * itself (history it does contain), and `remoteTags` likewise but pushed to the remote
 * and deleted locally, as a tag created through the GitHub API arrives.
 */
function makeSandbox(
  version: string,
  tags: string[],
  scripts?: Record<string, string>,
  { headTags = [], remoteTags = [] }: { headTags?: string[]; remoteTags?: string[] } = {}
) {
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
    `${JSON.stringify(
      { name: '@civitai/moderator-app', version, private: true, scripts },
      null,
      2
    )}\n`
  );
  git(work, ['add', 'apps/moderator/package.json']);
  git(work, ['commit', '-m', 'seed']);
  git(work, ['push', '-u', 'origin', 'main']);
  for (const tag of headTags) git(work, ['tag', tag]);
  for (const tag of remoteTags) {
    git(work, ['tag', tag]);
    git(work, ['push', 'origin', `refs/tags/${tag}`]);
    git(work, ['tag', '-d', tag]);
  }
  if (tags.length) {
    git(work, ['checkout', '-q', '-b', 'release-line']);
    git(work, ['commit', '-q', '--allow-empty', '-m', 'released from a branch main never merged']);
    for (const tag of tags) git(work, ['tag', tag]);
    git(work, ['checkout', '-q', 'main']);
  }

  return { work, git, remote };
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
    expect(versionOf(work)).toBe('0.0.1');
    expect(git(work, ['rev-parse', 'HEAD']).trim()).toBe(before);
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
});

describe('release-app.mjs typechecks only the app it releases', () => {
  it('blocks the release when the app typecheck fails, leaving the tree untouched', () => {
    const { work, git } = makeSandbox('0.0.26', RELEASED_TAGS, {
      typecheck: 'node -e "process.exit(3)"',
    });
    const before = git(work, ['rev-parse', 'HEAD']).trim();

    const res = runRelease(work, 'patch');

    expect(res.status).not.toBe(0);
    // Pins the failure to the typecheck, not some other early exit (a pull error, no pnpm).
    expect(res.stderr).toContain('Command failed: pnpm --dir apps/moderator run typecheck');
    expect(versionOf(work)).toBe('0.0.26');
    expect(git(work, ['rev-parse', 'HEAD']).trim()).toBe(before);
    expect(git(work, ['tag', '-l', 'moderator-v0.0.27']).trim()).toBe('');
  });

  it('releases when the app typecheck passes', () => {
    const { work } = makeSandbox('0.0.26', RELEASED_TAGS, { typecheck: 'node -e ""' });

    const res = runRelease(work, 'patch');

    expect(res.status).toBe(0);
    expect(versionOf(work)).toBe('0.0.27');
  });
});

// A tagger may cut feed-go-v tags on `main` commits without a release commit, so
// package.json stays at the last human release while higher tags sit on history the
// branch CONTAINS. That is not a stale branch: the release must continue from the
// highest such tag instead of refusing (or colliding with it).
const HUMAN_TAGS = Array.from({ length: 38 }, (_, i) => `moderator-v0.0.${i + 1}`);

describe('release-app.mjs continues from tags HEAD already contains', () => {
  it('releases past higher tags on HEAD and catches package.json up', () => {
    const { work, git, remote } = makeSandbox('0.0.38', [], undefined, {
      headTags: [...HUMAN_TAGS, 'moderator-v0.0.39', 'moderator-v0.0.40'],
    });

    const res = runRelease(work, 'patch');

    expect(res.stderr).not.toContain('refusing to release');
    expect(res.status).toBe(0);
    expect(versionOf(work)).toBe('0.0.41');
    expect(git(remote, ['tag', '-l', 'moderator-v0.0.41']).trim()).toBe('moderator-v0.0.41');
    expect(git(remote, ['log', '-1', '--format=%s', 'main']).trim()).toBe(
      'chore(moderator): release moderator-v0.0.41'
    );
  });

  // The API-created shape: the tag exists only on the remote, on a commit the clone
  // already has. The release must fetch it rather than compute a version that is taken.
  it('sees a tag that exists only on the remote', () => {
    const { work, git, remote } = makeSandbox('0.0.38', [], undefined, {
      headTags: HUMAN_TAGS,
      remoteTags: ['moderator-v0.0.39'],
    });
    expect(git(work, ['tag', '-l', 'moderator-v0.0.39']).trim()).toBe('');

    const res = runRelease(work, 'patch');

    expect(res.status).toBe(0);
    expect(versionOf(work)).toBe('0.0.40');
    expect(git(remote, ['tag', '-l', 'moderator-v0.0.40']).trim()).toBe('moderator-v0.0.40');
  });

  it('a minor release bumps from the highest contained tag', () => {
    const { work } = makeSandbox('0.0.38', [], undefined, {
      headTags: [...HUMAN_TAGS, 'moderator-v0.0.39', 'moderator-v0.0.40'],
    });

    const res = runRelease(work, 'minor');

    expect(res.status).toBe(0);
    expect(versionOf(work)).toBe('0.1.0');
  });

  // Contained tags must not mask a stale branch: a higher tag cut on history this
  // branch does NOT contain still refuses, even when HEAD carries tags above package.json.
  it('still refuses when a higher tag sits on history HEAD does not contain', () => {
    const { work, git } = makeSandbox('0.0.38', ['moderator-v0.0.45'], undefined, {
      headTags: [...HUMAN_TAGS, 'moderator-v0.0.39', 'moderator-v0.0.40'],
    });
    const before = git(work, ['rev-parse', 'HEAD']).trim();

    const res = runRelease(work, 'patch');

    expect(res.status).toBe(1);
    expect(res.stderr).toContain('refusing to release');
    expect(res.stderr).toContain('moderator-v0.0.45 is already released');
    expect(versionOf(work)).toBe('0.0.38');
    expect(git(work, ['rev-parse', 'HEAD']).trim()).toBe(before);
  });
});
