import { existsSync, readFileSync, readdirSync } from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

/**
 * `test:lint-rules` is a hand-maintained file list and `CLAUDE.md` hand-copies its contents, so both
 * go stale the moment somebody writes a guard and forgets one of them. A guard missing from the
 * script fails only in a full-suite run, hours later, in a file nobody was looking at; a wrong count
 * in `CLAUDE.md` is read as instruction. The counts had drifted three separate times before this
 * existed (868kv4d21), which is why the check is a test rather than another sentence telling people
 * to remember.
 */
const repoRoot = path.resolve(__dirname, '../../../..');
const guardDir = path.join(repoRoot, 'src/server/services/__tests__');

const guardsOnDisk = readdirSync(guardDir)
  .filter((f) => f.startsWith('no-') && f.endsWith('.test.ts'))
  .map((f) => f.replace(/\.test\.ts$/, ''))
  .sort();

const scriptLine: string = JSON.parse(readFileSync(path.join(repoRoot, 'package.json'), 'utf8'))
  .scripts['test:lint-rules'];

const scriptFiles = scriptLine
  .split(/\s+/)
  .filter((token) => token.endsWith('.test.ts'))
  .map((token) => token.split('\\').join('/'));

const scriptGuards = scriptFiles
  .filter((f) => f.startsWith('src/server/services/__tests__/no-'))
  .map((f) => path.basename(f).replace(/\.test\.ts$/, ''))
  .sort();

const claudeMd = readFileSync(path.join(repoRoot, 'CLAUDE.md'), 'utf8');
const sectionStart = claudeMd.indexOf('#### Convention guards run as tests');
const sectionEnd = claudeMd.indexOf('\n#### ', sectionStart + 1);
const section = claudeMd.slice(sectionStart, sectionEnd === -1 ? undefined : sectionEnd);

describe('test:lint-rules stays in step with the guards on disk', () => {
  it('names every no-* guard in the directory', () => {
    expect(guardsOnDisk.filter((g) => !scriptGuards.includes(g))).toEqual([]);
  });

  it('names no guard that has been deleted or renamed', () => {
    expect(scriptGuards.filter((g) => !guardsOnDisk.includes(g))).toEqual([]);
  });

  it('names only files that exist', () => {
    expect(scriptFiles.filter((f) => !existsSync(path.join(repoRoot, f)))).toEqual([]);
  });
});

describe('CLAUDE.md stays in step with both', () => {
  it('has the section this guard reads', () => {
    // A rename upstream would otherwise make every assertion below vacuous rather than red.
    expect(sectionStart).toBeGreaterThan(-1);
    expect(section).toContain('test:lint-rules');
  });

  it('states the number of no-* guards correctly', () => {
    const stated = section.match(
      /(\d+) live in\s+`src\/server\/services\/__tests__\/no-\*\.test\.ts`/
    );
    expect(stated).not.toBeNull();
    expect(Number(stated![1])).toBe(guardsOnDisk.length);
  });

  it('lists exactly the guards that exist', () => {
    const listed = [...section.matchAll(/`(no-[a-z0-9-]+)`/g)].map((m) => m[1]).sort();
    expect([...new Set(listed)]).toEqual(guardsOnDisk);
  });

  it('states the number of files the script runs correctly', () => {
    const stated = section.match(/all now wired in, (\d+) files/);
    expect(stated).not.toBeNull();
    expect(Number(stated![1])).toBe(scriptFiles.length);
  });
});
