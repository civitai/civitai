import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { parse } from 'yaml';
import { afterAll, describe, expect, it } from 'vitest';

import {
  MAX_LISTED_FILES,
  NOT_DRAFT_REASON,
  decide,
  globToRegExp,
  matchesPatterns,
  readPullRequestFilter,
} from '../ci/github-paths-filter.mjs';

// full-ci.yml dispatches apps.yml, moderator-boot.yml and the other draft-gated workflows only
// when their own pull_request run would start (scripts/ci/github-paths-filter.mjs). A dispatch is
// never path-filtered, so before this every label on a draft PR ran every one of them, including
// on PRs that touch nothing they read. The cases below are the decision that replaced that, run
// against the real workflow files so a filter edit there moves the answer here.

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '../..');
const WORKFLOW_DIR = path.join(REPO, '.github/workflows');
const workflow = (file: string) => readFileSync(path.join(WORKFLOW_DIR, file), 'utf8');
const DRAFT = { draft: 'true' };

describe('github-paths-filter', () => {
  describe('globToRegExp, GitHub rules', () => {
    it.each<[string, string, boolean]>([
      ['scripts/*.mjs', 'scripts/a.mjs', true],
      ['scripts/*.mjs', 'scripts/ci/a.mjs', false],
      ['apps/**', 'apps/a/src/x.ts', true],
      ['apps/**', 'appsx/a.ts', false],
      ['package.json', 'apps/a/package.json', false],
      ['package.json', 'package.json', true],
      // `**/` also matches zero directories.
      ['docs/**/*.md', 'docs/a.md', true],
      ['docs/**/*.md', 'docs/x/y/a.md', true],
      ['docs/**/*.md', 'docs/x/a.ts', false],
      ['**/*.go', 'main.go', true],
      ['**/*.go', 'apps/feed-go/internal/x.go', true],
      // `.` is literal.
      ['.npmrc', 'xnpmrc', false],
    ])('%s vs %s -> %s', (pattern, file, want) => {
      expect(globToRegExp(pattern).test(file)).toBe(want);
    });

    it('throws on syntax it does not handle, rather than guessing', () => {
      for (const p of ['src/{a,b}.ts', 'src/a?.ts', 'src/[ab].ts', 'src/a+.ts']) {
        expect(() => globToRegExp(p), p).toThrow(/unsupported glob/);
      }
    });
  });

  // GitHub: the last pattern that matches a file decides it; `!` excludes, plain includes.
  describe('matchesPatterns, negation order', () => {
    const lintLike = ['**', '!docs/**', '!claudedocs/**'];
    it.each<[string[], string, boolean]>([
      [lintLike, 'src/a.ts', true],
      [lintLike, 'docs/a.md', false],
      [lintLike, 'claudedocs/x/y.md', false],
      [['**', '!docs/**', 'docs/keep/**'], 'docs/keep/a.md', true],
      [['**', '!docs/**', 'docs/keep/**'], 'docs/other.md', false],
      [['!docs/**', '**'], 'docs/a.md', true],
      [['apps/x/**'], 'apps/y/a.ts', false],
    ])('%j vs %s -> %s', (patterns, file, want) => {
      expect(matchesPatterns(file, patterns)).toBe(want);
    });
  });

  // The workflow files are read with a small reader (the dispatching job installs no packages).
  // It must agree with a full YAML parser on every workflow this repo has, or throw.
  describe('readPullRequestFilter agrees with a YAML parser', () => {
    const files = readdirSync(WORKFLOW_DIR).filter((f) => /\.ya?ml$/.test(f));

    it('reads every workflow in the repo, and at least the ones with a filter', () => {
      const kinds = files.map((f) => readPullRequestFilter(workflow(f)).kind);
      // Positive control: a reader that returned `none` for everything would pass the
      // comparison below on a repo with no filters, but not here.
      expect(kinds.filter((k) => k === 'paths').length).toBeGreaterThanOrEqual(10);
    });

    it.each(files)('%s', (file) => {
      const text = workflow(file);
      const pr = (parse(text) as { on?: Record<string, unknown> })?.on?.pull_request as
        | { paths?: string[]; 'paths-ignore'?: string[] }
        | null
        | undefined;
      const want = pr?.paths
        ? { kind: 'paths', patterns: pr.paths }
        : pr?.['paths-ignore']
        ? { kind: 'paths-ignore', patterns: pr['paths-ignore'] }
        : { kind: 'none' };
      expect(readPullRequestFilter(text)).toEqual(want);
    });

    it('reads an anchored list, quoted and plain items, and a same-indent list', () => {
      const text = [
        'on:',
        '  pull_request:',
        '    branches: [main]',
        '    # a comment',
        '    paths: &inputs # trailing',
        "      - 'a/**'",
        '      - "b/*.ts"',
        '',
        '      - c/d.json # note',
        "      - 'it''s'",
        '    types: [opened]',
        '  push:',
        '    paths: *inputs',
        'jobs: {}',
      ].join('\n');
      expect(readPullRequestFilter(text)).toEqual({
        kind: 'paths',
        patterns: ['a/**', 'b/*.ts', 'c/d.json', "it's"],
      });
      const sameIndent = 'on:\n  pull_request:\n    paths-ignore:\n    - docs/**\n    types: [x]\n';
      expect(readPullRequestFilter(sameIndent)).toEqual({
        kind: 'paths-ignore',
        patterns: ['docs/**'],
      });
    });

    it.each<[string, string]>([
      ['no filter', 'on:\n  pull_request:\n    types: [opened]\n  push:\n    paths:\n      - x\n'],
      ['pull_request with no value', 'on:\n  pull_request:\n  push:\n'],
      ['no pull_request', 'on:\n  push:\n    paths:\n      - x\n'],
      ['inline on', 'on: [push, pull_request]\njobs: {}\n'],
    ])('no filter: %s', (_label, text) => {
      expect(readPullRequestFilter(text)).toEqual({ kind: 'none' });
    });

    it.each<[string, string]>([
      ['a flow list', 'on:\n  pull_request:\n    paths: [a, b]\n'],
      ['an alias', 'on:\n  pull_request:\n    paths: *x\n'],
      [
        'both filters',
        'on:\n  pull_request:\n    paths:\n      - a\n    paths-ignore:\n      - b\n',
      ],
      ['an empty list', 'on:\n  pull_request:\n    paths:\n    types: [x]\n'],
      ['tabs', 'on:\n\tpull_request:\n'],
      ['no on', 'jobs: {}\n'],
    ])('throws on %s', (_label, text) => {
      expect(() => readPullRequestFilter(text)).toThrow();
    });
  });

  // The decision full-ci.yml acts on, against the real workflow files.
  describe('decide', () => {
    it('MUST NOT dispatch apps.yml on a draft PR that changes only main-app files', () => {
      expect(decide(workflow('apps.yml'), ['src/pages/index.tsx', 'docs/x.md'], DRAFT)).toEqual({
        run: false,
        reason: 'no changed file passes its pull_request paths filter',
      });
    });

    it('MUST dispatch apps.yml on a draft PR that changes an app', () => {
      expect(
        decide(workflow('apps.yml'), ['src/pages/index.tsx', 'apps/moderator/src/a.ts'], DRAFT)
      ).toEqual({ run: true, reason: 'a changed file passes its pull_request paths filter' });
    });

    it('reads the filter from the workflow text: one change, two filters, two verdicts', () => {
      const lists = (p: string) => `on:\n  pull_request:\n    paths:\n      - '${p}'\n`;
      const change = ['lib/shared/x.ts'];
      expect(decide(lists('lib/**'), change, DRAFT).run).toBe(true);
      expect(decide(lists('apps/**'), change, DRAFT).run).toBe(false);
    });

    it('MUST NOT dispatch on a ready PR: its own run on the commit is not draft-gated', () => {
      expect(decide(workflow('apps.yml'), ['apps/moderator/src/a.ts'], { draft: 'false' })).toEqual(
        {
          run: false,
          reason: NOT_DRAFT_REASON,
        }
      );
    });

    it('treats a draft flag other than an exact "false" as a draft', () => {
      for (const draft of ['', 'False', undefined]) {
        expect(decide(workflow('apps.yml'), ['apps/a/b.ts'], { draft }).run, String(draft)).toBe(
          true
        );
        expect(decide(workflow('apps.yml'), ['src/a.ts'], { draft }).run, String(draft)).toBe(
          false
        );
      }
    });

    // Every workflow full-ci.yml dispatches lists itself in its filter, so a PR changing it
    // must get it dispatched; a PR changing only a docs file must not.
    it.each([
      'apps.yml',
      'moderator-boot.yml',
      'feed-go.yml',
      'beacon-go.yml',
      'app-index-go.yml',
      'app-data-go.yml',
      'content-policy-go.yml',
      'registry-adapter-image.yml',
      'storage-hook-runner-image.yml',
    ])('%s: dispatched for its own file, not for a docs-only change', (file) => {
      expect(decide(workflow(file), [`.github/workflows/${file}`], DRAFT).run).toBe(true);
      expect(decide(workflow(file), ['docs/testing/x.md'], DRAFT).run).toBe(false);
    });

    it('honours negations and paths-ignore', () => {
      expect(decide(workflow('lint.yml'), ['docs/a.md', 'claudedocs/b.md'], DRAFT).run).toBe(false);
      expect(decide(workflow('lint.yml'), ['docs/a.md', 'src/a.ts'], DRAFT).run).toBe(true);
      const ignore = 'on:\n  pull_request:\n    paths-ignore:\n      - docs/**\n';
      expect(decide(ignore, ['docs/a.md'], DRAFT).run).toBe(false);
      expect(decide(ignore, ['docs/a.md', 'src/b.ts'], DRAFT).run).toBe(true);
    });

    it('dispatches a workflow with no paths filter', () => {
      const text = 'on:\n  pull_request:\n    types: [opened]\n';
      expect(decide(text, ['docs/a.md'], DRAFT)).toEqual({
        run: true,
        reason: 'no pull_request paths filter',
      });
    });

    describe('fails open, and says so', () => {
      it.each<[string, string, string[]]>([
        ['an empty changed-file list', workflow('apps.yml'), []],
        [
          'a list at the API cap',
          workflow('apps.yml'),
          Array.from({ length: MAX_LISTED_FILES }, (_, i) => `src/f${i}.ts`),
        ],
        [
          'a pattern it cannot read',
          "on:\n  pull_request:\n    paths:\n      - 'src/{a,b}.ts'\n",
          ['x.ts'],
        ],
        ['YAML it cannot read', 'on:\n  pull_request:\n    paths: [a]\n', ['x.ts']],
      ])('%s', (_label, text, files) => {
        const got = decide(text, files, DRAFT);
        expect(got.run).toBe(true);
        expect(got.reason).toMatch(/failing open$/);
      });
    });
  });

  // The command line full-ci.yml runs. Its step reads column 2 of each tab-separated line with
  // `cut -f2` and dispatches unless it is exactly `skip`, so the separator and the fail-open
  // verdicts are the contract: pinned here as whole lines, by running the script.
  describe('the CLI', () => {
    const SCRIPT = path.join(REPO, 'scripts/ci/github-paths-filter.mjs');
    const tmp = mkdtempSync(path.join(tmpdir(), 'github-paths-filter-'));
    afterAll(() => rmSync(tmp, { recursive: true, force: true }));
    const APPS = '.github/workflows/apps.yml';
    const FEED = '.github/workflows/feed-go.yml';
    const cli = (args: string[]) =>
      execFileSync(process.execPath, [SCRIPT, ...args], { cwd: REPO, encoding: 'utf8' });
    const changed = (name: string, files: string[]) => {
      const file = path.join(tmp, name);
      writeFileSync(file, files.map((f) => `${f}\n`).join(''));
      return file;
    };

    it('prints <workflow> TAB run|skip TAB <reason> per workflow, on a draft', () => {
      const list = changed('draft.txt', ['apps/moderator/src/a.ts', 'docs/x.md']);
      expect(cli(['--draft', 'true', '--changed', list, APPS, FEED])).toBe(
        `${APPS}\trun\ta changed file passes its pull_request paths filter\n` +
          `${FEED}\tskip\tno changed file passes its pull_request paths filter\n`
      );
    });

    it('skips every workflow with --draft false, whatever changed', () => {
      const list = changed('ready.txt', ['apps/moderator/src/a.ts', 'apps/feed-go/main.go']);
      expect(cli(['--draft', 'false', '--changed', list, APPS, FEED])).toBe(
        `${APPS}\tskip\t${NOT_DRAFT_REASON}\n${FEED}\tskip\t${NOT_DRAFT_REASON}\n`
      );
    });

    it('runs every workflow when the changed-file list is missing or not given', () => {
      const missing = path.join(tmp, 'missing.txt');
      const unreadable = `changed-file list unreadable (ENOENT: no such file or directory, open '${missing}'); failing open`;
      expect(cli(['--draft', 'true', '--changed', missing, APPS, FEED])).toBe(
        `${APPS}\trun\t${unreadable}\n${FEED}\trun\t${unreadable}\n`
      );
      expect(cli(['--draft', 'true', APPS, FEED])).toBe(
        `${APPS}\trun\tno --changed file given; failing open\n` +
          `${FEED}\trun\tno --changed file given; failing open\n`
      );
    });
  });
});
