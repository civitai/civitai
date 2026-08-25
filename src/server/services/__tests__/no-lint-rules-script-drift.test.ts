import { existsSync, readFileSync, readdirSync } from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

/**
 * `test:lint-rules` is a hand-maintained file list and two documents hand-copy its contents, so all
 * three go stale the moment somebody writes a guard and forgets one of them. A guard missing from the
 * script fails only in a full-suite run, hours later, in a file nobody was looking at; a wrong count
 * in a doc an agent reads is followed as instruction. The counts had drifted three separate times
 * before this existed (868kv4d21), which is why the check is a test rather than another sentence
 * telling people to remember.
 *
 * The two phrasings below are read literally, so the failure messages name them — a guard whose
 * easiest fix is deleting it is not a guard.
 */
const COUNT_PHRASE = '<n> live in `src/server/services/__tests__/no-*.test.ts`';
const FILES_PHRASE = '`test:lint-rules` names <n> files today';

const COUNT_RE = /(\d+) live in\s+`src\/server\/services\/__tests__\/no-\*\.test\.ts`/;
const FILES_RE = /`test:lint-rules` names (\d+) files today/;

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

/**
 * The names are read from the enumerating PARAGRAPH, not the whole section: a guard mentioned in any
 * surrounding prose would otherwise satisfy the list check while missing from the list.
 */
function readDoc(relPath: string, heading: string) {
  const text = readFileSync(path.join(repoRoot, relPath), 'utf8');
  const start = text.indexOf(heading);
  const end = start === -1 ? -1 : text.indexOf(`\n${heading.split(' ')[0]} `, start + 1);
  const section = start === -1 ? '' : text.slice(start, end === -1 ? undefined : end);
  const listParagraph = section.split(/\r?\n\s*\r?\n/).find((p) => COUNT_RE.test(p)) ?? '';
  return { relPath, found: start !== -1, section, listParagraph };
}

const docs = [
  readDoc('CLAUDE.md', '#### Convention guards run as tests'),
  readDoc('.claude/agents/civitai-test-review.md', '### Convention guards'),
];

describe('test:lint-rules stays in step with the guards on disk', () => {
  it('names every no-* guard in the directory', () => {
    expect(
      guardsOnDisk.filter((g) => !scriptGuards.includes(g)),
      'add these to the test:lint-rules script in package.json'
    ).toEqual([]);
  });

  it('names no guard that has been deleted or renamed', () => {
    expect(
      scriptGuards.filter((g) => !guardsOnDisk.includes(g)),
      'these are in the test:lint-rules script but not on disk'
    ).toEqual([]);
  });

  it('names only files that exist', () => {
    expect(scriptFiles.filter((f) => !existsSync(path.join(repoRoot, f)))).toEqual([]);
  });
});

describe.each(docs)('$relPath stays in step with both', (doc) => {
  it('has the section this guard reads', () => {
    // A rename upstream would otherwise make every assertion below vacuous rather than red.
    expect(doc.found, `${doc.relPath} no longer has the heading this guard anchors on`).toBe(true);
    expect(
      doc.listParagraph,
      `${doc.relPath} must contain a paragraph reading "${COUNT_PHRASE}"`
    ).not.toBe('');
  });

  it('states the number of no-* guards correctly', () => {
    const stated = doc.listParagraph.match(COUNT_RE);
    expect(
      stated,
      `${doc.relPath} must say "${COUNT_PHRASE}" verbatim, with n as digits`
    ).not.toBeNull();
    expect(
      Number(stated![1]),
      `${doc.relPath}: update the count, ${guardsOnDisk.length} guards are on disk`
    ).toBe(guardsOnDisk.length);
  });

  it('lists exactly the guards that exist', () => {
    const listed = [...doc.listParagraph.matchAll(/`(no-[a-z0-9-]+)`/g)].map((m) => m[1]).sort();
    expect(
      [...new Set(listed)],
      `${doc.relPath}: the list paragraph must name every guard in ${path.relative(
        repoRoot,
        guardDir
      )}`
    ).toEqual(guardsOnDisk);
  });

  it('states the number of files the script runs correctly', () => {
    const stated = doc.section.match(FILES_RE);
    expect(
      stated,
      `${doc.relPath} must say "${FILES_PHRASE}" verbatim, with n as digits`
    ).not.toBeNull();
    expect(
      Number(stated![1]),
      `${doc.relPath}: update the count, the script names ${scriptFiles.length} files`
    ).toBe(scriptFiles.length);
  });
});
