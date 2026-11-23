import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';

import { FILES_CAP, decide, filterOf, patternToRegExp, selected } from '../ci/full-ci-paths.mjs';

// scripts/ci/full-ci-paths.mjs: would a workflow's own `paths:` filter have run it for this PR?
// full-ci.yml asks before dispatching a draft-gated workflow on a labelled draft.
//
// Every expected value below is a literal, written from GitHub's filter-pattern cheat sheet, not
// from the implementation. Fixture paths are chosen so that each one is matched by exactly the
// patterns its case names.

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WORKFLOW_DIR = path.resolve(HERE, '../../.github/workflows');
const onOf = (file: string) =>
  (parse(readFileSync(path.join(WORKFLOW_DIR, file), 'utf8')) as { on: unknown }).on;

describe('patternToRegExp: GitHub filter semantics', () => {
  it.each<[string, string, boolean]>([
    // `*` stops at `/`; this is where a bash `[[ == ]]` glob differs.
    ['packages/*/package.json', 'packages/sdk/package.json', true],
    ['packages/*/package.json', 'packages/sdk/nested/package.json', false],
    ['*.md', 'README.md', true],
    ['*.md', 'docs/README.md', false],
    // `**` crosses directories; `**/` also matches no directory.
    ['apps/**', 'apps/feed-go/internal/x.go', true],
    ['apps/**', 'apps', false],
    ['**/package.json', 'package.json', true],
    ['**/package.json', 'apps/a/package.json', true],
    ['**.js', 'src/deep/file.js', true],
    // A literal path is exact, dots included.
    ['package.json', 'package.json', true],
    ['package.json', 'packageXjson', false],
    ['package.json', 'apps/package.json', false],
    // `?` is zero or one of the preceding character, `+` one or more of it.
    ['docs?/x', 'doc/x', true],
    ['docs?/x', 'docs/x', true],
    ['docs?/x', 'docss/x', false],
    ['a+b', 'aaab', true],
    ['a+b', 'b', false],
    // A character class.
    ['file[0-9].ts', 'file7.ts', true],
    ['file[0-9].ts', 'filex.ts', false],
  ])('%s against %s: %s', (pattern, file, want) => {
    expect(patternToRegExp(pattern).test(file)).toBe(want);
  });
});

describe('selected: ordered patterns, the last match decides', () => {
  const LINT = ['**', '!docs/**', '!claudedocs/**'];
  it.each<[string[], string, boolean]>([
    [LINT, 'src/a.ts', true],
    [LINT, 'docs/a.md', false],
    [LINT, 'claudedocs/a.md', false],
    // A positive after a negative includes again.
    [['**', '!docs/**', 'docs/keep.md'], 'docs/keep.md', true],
    [['**', '!docs/**', 'docs/keep.md'], 'docs/other.md', false],
    // A negative alone selects nothing.
    [['!docs/**'], 'src/a.ts', false],
    [[], 'src/a.ts', false],
  ])('%j selects %s: %s', (patterns, file, want) => {
    expect(selected(file, patterns)).toBe(want);
  });
});

describe('filterOf: which trigger the filter comes from', () => {
  it('the pull_request trigger when there is one', () => {
    const on = { pull_request: { paths: ['a/**'] }, push: { paths: ['b/**'] } };
    expect(filterOf(on)).toEqual({ filter: { paths: ['a/**'] }, source: 'pull_request' });
  });
  it('push when there is no pull_request trigger', () => {
    const on = { push: { branches: ['main'], paths: ['b/**'] }, workflow_dispatch: null };
    expect(filterOf(on)).toEqual({
      filter: { branches: ['main'], paths: ['b/**'] },
      source: 'push',
    });
  });
  it.each<[string, unknown, string]>([
    ['a bare pull_request', { pull_request: null, push: { paths: ['b/**'] } }, 'pull_request'],
    ['a pull_request with branches only', { pull_request: { branches: ['main'] } }, 'pull_request'],
    ['dispatch only', { workflow_dispatch: null }, 'on:'],
    ['a string on:', 'push', 'on:'],
    ['no on:', null, 'on:'],
  ])('no filter for %s', (_label, on, source) => {
    expect(filterOf(on)).toEqual({ filter: null, source });
  });
});

describe('decide', () => {
  const on = { pull_request: { paths: ['apps/feed-go/**', '.github/workflows/feed-go.yml'] } };

  it('runs when a changed file matches, naming it', () => {
    expect(decide(['src/x.ts', 'apps/feed-go/main.go'], on)).toEqual({
      run: true,
      reason: 'apps/feed-go/main.go matches on.pull_request.paths',
    });
  });

  it('skips when no changed file matches', () => {
    expect(decide(['src/x.ts', 'apps/beacon-go/main.go'], on)).toEqual({
      run: false,
      reason: 'no changed file matches on.pull_request.paths',
    });
  });

  it('paths-ignore: runs when one file is outside it, skips when all are inside', () => {
    const ign = { pull_request: { 'paths-ignore': ['docs/**'] } };
    expect(decide(['docs/a.md', 'src/b.ts'], ign)).toEqual({
      run: true,
      reason: 'src/b.ts is outside on.pull_request.paths-ignore',
    });
    expect(decide(['docs/a.md', 'docs/c.md'], ign)).toEqual({
      run: false,
      reason: 'every changed file matches on.pull_request.paths-ignore',
    });
  });

  // FAILS OPEN: each of these is a lookup that did not work, and must dispatch.
  it.each<[string, string[] | null, unknown, string]>([
    ['an unreadable file list', null, on, "could not read the PR's changed files"],
    ['an empty file list', [], on, "could not read the PR's changed files"],
    ['an unreadable on:', ['src/x.ts'], undefined, "could not read the workflow's on: block"],
    ['no filter at all', ['src/x.ts'], { workflow_dispatch: null }, 'on: has no paths filter'],
  ])('runs on %s', (_label, files, o, reason) => {
    expect(decide(files, o)).toEqual({ run: true, reason });
  });

  // At the cap the list may be cut short, so a matching file could be missing from it. The
  // fixture's files match nothing, so only the cap rule can make this run.
  it("runs at GitHub's file cap even when nothing listed matches", () => {
    const many = Array.from({ length: FILES_CAP }, (_, i) => `src/f${i}.ts`);
    expect(decide(many, on).run).toBe(true);
    expect(decide(many.slice(1), on).run).toBe(false);
  });
});

// The nine workflows full-ci.yml path-matches, read through the same `on:` the job reads. A
// change to a workflow's own file must always dispatch it (each lists itself), and a docs-only
// change must dispatch none of the nine. This is the positive control that the real filters
// parse into something that can match at all.
describe('the real workflow filters', () => {
  const NINE = [
    'apps.yml',
    'moderator-boot.yml',
    'feed-go.yml',
    'beacon-go.yml',
    'app-index-go.yml',
    'app-data-go.yml',
    'content-policy-go.yml',
    'registry-adapter-image.yml',
    'storage-hook-runner-image.yml',
  ];

  it.each(NINE)('%s runs when its own workflow file changes', (file) => {
    expect(decide([`.github/workflows/${file}`], onOf(file)).run).toBe(true);
  });

  it.each(NINE)('%s does not run for a docs-only change', (file) => {
    expect(decide(['docs/testing/reading-ci-results.md'], onOf(file))).toEqual({
      run: false,
      reason: expect.stringMatching(/^no changed file matches on\.(pull_request|push)\.paths$/),
    });
  });
});
