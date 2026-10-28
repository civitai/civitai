import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  newEntries,
  newEslintFindings,
  prettierErrorFiles,
  report,
} from '../ci/lint-new-findings.mjs';

/**
 * scripts/ci/lint-new-findings.mjs: on a full lint run, report only what the PR head adds over
 * its merge base. The end-to-end cases run the repo's real ESLint and Prettier against a
 * throwaway tree that is rewritten in place between the base and head collections, the same
 * way the workflow checks out the merge base in the job's own workspace.
 */

const SCRIPT = resolve(__dirname, '../ci/lint-new-findings.mjs');
const NODE_MODULES = resolve(__dirname, '../../node_modules');

const msg = (ruleId: string | null, message: string, line: number, severity = 2) => ({
  ruleId,
  severity,
  message,
  line,
  column: 1,
});

describe('newEslintFindings', () => {
  it('reports nothing when head has the same findings as base on shifted lines', () => {
    const base = [
      { filePath: 'src/a.ts', messages: [msg('no-var', 'Unexpected var.', 3)] },
      { filePath: 'src/b.ts', messages: [msg('eqeqeq', "Expected '==='.", 10)] },
    ];
    const head = [
      { filePath: 'src/a.ts', messages: [msg('no-var', 'Unexpected var.', 7)] },
      { filePath: 'src/b.ts', messages: [msg('eqeqeq', "Expected '==='.", 40)] },
    ];
    expect(newEslintFindings(base, head)).toEqual([]);
  });

  it('reports a second copy of an existing finding in the same file once, with every head line', () => {
    const base = [{ filePath: 'src/a.ts', messages: [msg('no-var', 'Unexpected var.', 3)] }];
    const head = [
      {
        filePath: 'src/a.ts',
        messages: [msg('no-var', 'Unexpected var.', 3), msg('no-var', 'Unexpected var.', 9)],
      },
    ];
    const [g, ...rest] = newEslintFindings(base, head);
    expect(rest).toEqual([]);
    expect(g).toMatchObject({ file: 'src/a.ts', rule: 'no-var', added: 1 });
    expect(g.items.map((i: { line: number }) => i.line)).toEqual([3, 9]);
  });

  it('treats the same rule in another file, another message, or a promoted severity as new', () => {
    const base = [{ filePath: 'src/a.ts', messages: [msg('no-var', 'Unexpected var.', 3, 1)] }];
    const head = [
      { filePath: 'src/a.ts', messages: [msg('no-var', 'Unexpected var.', 3, 2)] },
      { filePath: 'src/c.ts', messages: [msg('no-var', 'Unexpected var.', 3, 1)] },
      { filePath: 'src/a.ts', messages: [msg('no-var', 'Other text.', 3, 1)] },
    ];
    expect(
      newEslintFindings(base, head).map(
        (g: { file: string; message: string; severity: string }) => [g.file, g.message, g.severity]
      )
    ).toEqual([
      ['src/a.ts', 'Unexpected var.', 'error'],
      ['src/a.ts', 'Other text.', 'warning'],
      ['src/c.ts', 'Unexpected var.', 'warning'],
    ]);
  });

  it('keys a fatal parse error (no ruleId) like any other finding', () => {
    const head = [
      { filePath: 'src/p.ts', messages: [msg(null, "Parsing error: ';' expected.", 2)] },
    ];
    expect(newEslintFindings([], head)).toMatchObject([
      { file: 'src/p.ts', rule: '(fatal)', added: 1 },
    ]);
    expect(newEslintFindings(head, head)).toEqual([]);
  });
});

describe('newEntries / prettierErrorFiles', () => {
  it('returns only what head adds', () => {
    expect(
      newEntries(['src/old.ts', 'src/gone.ts'], ['src/old.ts', 'src/z.ts', 'src/y.ts'])
    ).toEqual(['src/y.ts', 'src/z.ts']);
  });

  it('extracts files from Prettier [error] lines and ignores the rest', () => {
    const stderr = [
      "[error] src/bad.ts: SyntaxError: ';' expected. (3:5)",
      '[error]   1 | const = ;',
      '[warn] src/other.ts',
      '[error] src/bad.ts: SyntaxError: again (9:1)',
    ].join('\n');
    expect(prettierErrorFiles(stderr)).toEqual(['src/bad.ts']);
  });
});

describe('report', () => {
  const one = {
    file: 'src/x.ts',
    rule: 'eqeqeq',
    severity: 'error',
    message: "Expected '===' and instead saw '=='.",
    line: 4,
    column: 7,
  };
  const finding = { ...one, added: 1, items: [one] };

  it('counts errors and newly unformatted files, annotates them, and ignores warnings in the total', () => {
    const r = report({
      eslint: [finding, { ...finding, severity: 'warning', rule: 'no-console' }],
      unformatted: ['src/fmt.ts'],
      prettierErrors: [],
      baseErrorCount: 486,
      baseUnformattedCount: 565,
    });
    expect(r.total).toBe(2);
    expect(r.newErrors).toBe(1);
    expect(r.annotations).toEqual([
      "::error file=src/x.ts,line=4,col=7,title=New ESLint error%3A eqeqeq::Expected '===' and instead saw '=='.",
      '::error file=src/fmt.ts,title=Newly unformatted::Formatted at the merge base, not at the PR head. Run: pnpm exec prettier --write src/fmt.ts',
    ]);
    expect(r.summary).toContain('### Lint (full run): 2 new finding(s) vs the merge base');
    expect(r.summary).toContain('| ESLint errors | **1** | 486 |');
    expect(r.summary).toContain('| Unformatted files | **1** | 565 |');
    expect(r.summary).toContain(
      "| `src/x.ts:4` | eqeqeq | Expected '===' and instead saw '=='. | 1 |"
    );
  });

  it('says so plainly when there is nothing new', () => {
    const r = report({
      eslint: [],
      unformatted: [],
      prettierErrors: [],
      baseErrorCount: 3,
      baseUnformattedCount: 2,
    });
    expect(r.total).toBe(0);
    expect(r.annotations).toEqual([]);
    expect(r.summary.split('\n')[0]).toBe('### Lint (full run): no new findings vs the merge base');
  });
});

describe('compare CLI', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'lint-new-cmp-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const write = (side: string, eslint: unknown[], unformatted: string[] = []) => {
    writeFileSync(join(dir, `${side}-eslint.json`), JSON.stringify(eslint));
    writeFileSync(join(dir, `${side}-unformatted.txt`), unformatted.map((f) => f + '\n').join(''));
    writeFileSync(join(dir, `${side}-prettier-errors.txt`), '');
  };

  const compare = () => {
    const summary = join(dir, 'summary.md');
    const output = join(dir, 'output');
    writeFileSync(summary, '');
    writeFileSync(output, '');
    const r = spawnSync('node', [SCRIPT, 'compare', dir], {
      encoding: 'utf8',
      env: { ...process.env, GITHUB_STEP_SUMMARY: summary, GITHUB_OUTPUT: output },
    });
    return { ...r, summary: readFileSync(summary, 'utf8'), output: readFileSync(output, 'utf8') };
  };

  it('exits 1 and writes the summary and new=N when head adds a finding', () => {
    write('base', [{ filePath: 'src/a.ts', messages: [] }], ['src/old.ts']);
    write(
      'head',
      [{ filePath: 'src/a.ts', messages: [msg('no-var', 'Unexpected var.', 1)] }],
      ['src/old.ts']
    );
    const r = compare();
    expect(r.status).toBe(1);
    expect(r.output).toBe('new=1\n');
    expect(r.summary).toContain('| ESLint errors | **1** | 0 |');
    expect(r.summary).toContain('| Unformatted files | **0** | 1 |');
  });

  it('exits 0 with new=0 when head only carries the base debt', () => {
    const debt = [{ filePath: 'src/a.ts', messages: [msg('no-var', 'Unexpected var.', 1)] }];
    write('base', debt, ['src/old.ts']);
    write('head', debt, ['src/old.ts']);
    const r = compare();
    expect(r.status).toBe(0);
    expect(r.output).toBe('new=0\n');
  });

  it('exits 2, not 0, when a side never produced its results', () => {
    write('head', [{ filePath: 'src/a.ts', messages: [] }]);
    const r = compare();
    expect(r.status).toBe(2);
    expect(r.stdout).toContain('base-eslint.json is missing');
    expect(r.output).toBe('');
  });
});

describe('collect + compare with the real ESLint and Prettier', () => {
  let tree: string;

  const put = (path: string, content: string) => {
    mkdirSync(dirname(join(tree, path)), { recursive: true });
    writeFileSync(join(tree, path), content);
  };

  const eslintrc = (rules: Record<string, string>) =>
    put(
      '.eslintrc.json',
      JSON.stringify({
        root: true,
        parserOptions: { ecmaVersion: 2022, sourceType: 'module' },
        rules,
      })
    );

  const collect = (side: 'base' | 'head') => {
    const r = spawnSync('node', [SCRIPT, 'collect', side, 'lint.txt', 'fmt.txt', 'out'], {
      cwd: tree,
      encoding: 'utf8',
    });
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
    return r.stdout;
  };

  const compare = () => {
    const r = spawnSync('node', [SCRIPT, 'compare', 'out'], { cwd: tree, encoding: 'utf8' });
    const errors = r.stdout.split('\n').filter((l) => l.startsWith('::error '));
    return { status: r.status, errors, stdout: r.stdout };
  };

  beforeEach(() => {
    tree = mkdtempSync(join(tmpdir(), 'lint-new-e2e-'));
    symlinkSync(NODE_MODULES, join(tree, 'node_modules'));
    mkdirSync(join(tree, 'out'));
    put('.prettierrc', '{ "singleQuote": true }\n');
    // Pre-existing debt at base: an ESLint error and an unformatted file.
    put('src/old-debt.ts', "var legacy = 'x';\nexport { legacy };\n");
    put('src/unformatted.ts', "export const  spaced   =  'y';\n");
    // Clean at base; only a rule the PR turns on can flag it.
    put('src/untouched.ts', 'export function same(a, b) {\n  return a == b;\n}\n');
    writeFileSync(
      join(tree, 'lint.txt'),
      'src/old-debt.ts\nsrc/unformatted.ts\nsrc/untouched.ts\n'
    );
    writeFileSync(join(tree, 'fmt.txt'), 'src/old-debt.ts\nsrc/unformatted.ts\nsrc/untouched.ts\n');
    eslintrc({ 'no-var': 'error' });
    expect(collect('base')).toContain(
      'base: ESLint 3 files, 1 errors; Prettier 3 files, 1 unformatted'
    );
  });

  afterEach(() => rmSync(tree, { recursive: true, force: true }));

  it('reports zero new findings when head keeps the same debt (lines moved, config reworded)', () => {
    put('src/old-debt.ts', "// moved down\n\nvar legacy = 'x';\nexport { legacy };\n");
    eslintrc({ 'no-var': 'error', 'no-debugger': 'error' });
    expect(collect('head')).toContain(
      'head: ESLint 3 files, 1 errors; Prettier 3 files, 1 unformatted'
    );

    const r = compare();
    expect(r.errors).toEqual([]);
    expect(r.stdout).toContain('### Lint (full run): no new findings vs the merge base');
    expect(r.status).toBe(0);
  });

  it('reports exactly the one error a config change creates in a file the PR did not touch', () => {
    eslintrc({ 'no-var': 'error', eqeqeq: 'error' });
    collect('head');

    const r = compare();
    expect(r.errors).toEqual([
      "::error file=src/untouched.ts,line=2,col=12,title=New ESLint error%3A eqeqeq::Expected '===' and instead saw '=='.",
    ]);
    expect(r.stdout).toContain('| ESLint errors | **1** | 1 |');
    expect(r.status).toBe(1);
  });

  it('reports the files a Prettier config change unformats, and not the one already unformatted', () => {
    put('.prettierrc', '{ "singleQuote": false }\n');
    collect('head');

    const r = compare();
    expect(r.errors.map((l) => l.split('::')[1])).toEqual([
      'error file=src/old-debt.ts,title=Newly unformatted',
    ]);
    expect(r.status).toBe(1);
  });

  it('fails collect when ESLint cannot produce a verdict', () => {
    put('.eslintrc.json', '{ not json');
    const r = spawnSync('node', [SCRIPT, 'collect', 'head', 'lint.txt', 'fmt.txt', 'out'], {
      cwd: tree,
      encoding: 'utf8',
    });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('eslint exited 2');
    expect(compare().status).toBe(2);
  });
});
