import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

/**
 * scripts/ci/lint-targets.mjs picks the files the PR lint job checks. Each case builds a real
 * git repo with a `base` branch and a PR commit on top, runs the script, and reads the lists
 * it wrote. Fixture file names are all distinct so a list holding the wrong file cannot pass.
 */

const SCRIPT = resolve(__dirname, '../ci/lint-targets.mjs');

let repo: string;

const git = (...args: string[]) =>
  execFileSync('git', args, {
    cwd: repo,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 't',
      GIT_AUTHOR_EMAIL: 't@t',
      GIT_COMMITTER_NAME: 't',
      GIT_COMMITTER_EMAIL: 't@t',
    },
  });

const put = (path: string, content = 'export const x = 1;\n') => {
  mkdirSync(dirname(join(repo, path)), { recursive: true });
  writeFileSync(join(repo, path), content);
};

const commit = (msg: string) => {
  git('add', '--all');
  git('commit', '-q', '--no-verify', '-m', msg);
};

const run = () => {
  const out = join(repo, '.out');
  mkdirSync(out, { recursive: true });
  const ghOutput = join(out, 'gh-output');
  writeFileSync(ghOutput, '');
  const r = spawnSync('node', [SCRIPT, 'base', out], {
    cwd: repo,
    encoding: 'utf8',
    env: { ...process.env, GITHUB_OUTPUT: ghOutput },
  });
  const list = (name: string) => readFileSync(join(out, name), 'utf8').split('\n').filter(Boolean);
  return {
    status: r.status,
    stdout: r.stdout,
    githubOutput: readFileSync(ghOutput, 'utf8'),
    added: list('added.txt'),
    addedLint: list('added-lint.txt'),
    report: list('report.txt'),
    reportLint: list('report-lint.txt'),
  };
};

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'lint-targets-'));
  git('init', '-q', '-b', 'base');
  put('package.json', '{"name":"x"}\n');
  put('src/untouched.ts');
  put('src/edited.tsx');
  put('packages/pkg/src/pkg-untouched.ts');
  put('scripts/outside-lint.ts');
  put('README.md', 'readme\n');
  commit('base');
  git('checkout', '-q', '-b', 'pr');
  // `.out` is the script's output dir; keep it out of `git add --all` in later commits.
  put('.git/info/exclude', '.out\n');
});

afterEach(() => rmSync(repo, { recursive: true, force: true }));

describe('lint-targets', () => {
  it('lists only the files the PR changed when no lint config moved', () => {
    put('src/edited.tsx', 'export const x = 2;\n');
    put('src/brand-new.ts');
    put('scripts/new-outside-lint.ts');
    put('README.md', 'changed\n');
    commit('pr');

    const r = run();
    expect(r.status).toBe(0);
    expect(r.githubOutput).toBe('full=false\n');
    expect(r.added.sort()).toEqual(['scripts/new-outside-lint.ts', 'src/brand-new.ts']);
    expect(r.addedLint).toEqual(['src/brand-new.ts']);
    expect(r.report).toEqual(['src/edited.tsx']);
    expect(r.reportLint).toEqual(['src/edited.tsx']);
  });

  it('writes empty lists for a PR that touches no source', () => {
    put('README.md', 'changed\n');
    commit('pr');

    const r = run();
    expect(r.githubOutput).toBe('full=false\n');
    expect([r.added, r.addedLint, r.report, r.reportLint]).toEqual([[], [], [], []]);
  });

  it.each([
    'package.json',
    'pnpm-lock.yaml',
    // packages/.eslintrc.cjs runs import/no-extraneous-dependencies against each package's own
    // package.json, so dropping a dependency there creates errors in files the PR never touched.
    'packages/pkg/package.json',
    '.eslintrc.js',
    'packages/.eslintrc.cjs',
    'eslint.config.js',
    '.eslintignore',
    'eslint-local-rules.js',
    '.prettierrc',
    'apps/app/.prettierrc',
    'prettier.config.js',
    '.prettierignore',
    'tailwind.config.js',
    '.github/workflows/lint.yml',
    '.github/problem-matchers/eslint-unix.json',
    'scripts/ci/lint-targets.mjs',
  ])('lints every tracked file when the PR changes %s', (trigger) => {
    put(trigger, `changed ${trigger}\n`);
    put('src/brand-new.ts');
    commit('pr');

    const r = run();
    expect(r.status).toBe(0);
    expect(r.githubOutput).toBe('full=true\n');
    expect(r.stdout).toContain(`  ${trigger}\n`);
    // Added files stay on the blocking lists and are not linted twice.
    expect(r.addedLint).toEqual(['src/brand-new.ts']);
    expect(r.report.sort()).toEqual([
      'packages/pkg/src/pkg-untouched.ts',
      'scripts/outside-lint.ts',
      'src/edited.tsx',
      'src/untouched.ts',
    ]);
    expect(r.reportLint.sort()).toEqual([
      'packages/pkg/src/pkg-untouched.ts',
      'src/edited.tsx',
      'src/untouched.ts',
    ]);
  });

  it.each([
    'apps/app/package.json',
    'packages/pkg/src/package.json.ts',
    'src/eslint-helper.js',
    'docs/.prettierrc-notes.md',
    'scripts/ci/other-script.mjs',
  ])('does not treat %s as lint config', (path) => {
    put(path, 'x\n');
    commit('pr');
    expect(run().githubOutput).toBe('full=false\n');
  });

  it('treats renaming a lint config away as a config change', () => {
    // `git diff --name-only` with rename detection lists only the NEW path, so renaming
    // .eslintrc.js to any name not on the trigger list would not start a full run unless the
    // old path is listed too.
    git('checkout', '-q', 'base');
    put('.eslintrc.js', 'module.exports = {\n  root: true,\n  rules: { a: 1, b: 2, c: 3 },\n};\n');
    commit('base config');
    git('checkout', '-q', 'pr');
    git('merge', '-q', 'base');
    git('mv', '.eslintrc.js', 'renamed-config.js');
    commit('pr');

    const r = run();
    expect(r.githubOutput).toBe('full=true\n');
    expect(r.stdout).toContain('  .eslintrc.js\n');
  });

  it('ignores changes already on the base branch (diffs from the merge base)', () => {
    put('src/edited.tsx', 'export const x = 3;\n');
    commit('pr');
    git('checkout', '-q', 'base');
    put('package.json', '{"name":"moved-on-base"}\n');
    put('src/untouched.ts', 'export const x = 9;\n');
    commit('base moves');
    git('checkout', '-q', 'pr');

    const r = run();
    expect(r.githubOutput).toBe('full=false\n');
    expect(r.report).toEqual(['src/edited.tsx']);
  });

  it('exits 2 without a base ref', () => {
    expect(spawnSync('node', [SCRIPT], { cwd: repo }).status).toBe(2);
  });
});
