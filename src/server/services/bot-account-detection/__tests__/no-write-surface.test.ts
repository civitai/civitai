import { mkdtempSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'fs';
import os from 'os';
import path from 'path';
import { describe, expect, it } from 'vitest';

/**
 * The structural half of the shadow-mode guarantee.
 *
 * `run.test.ts` proves that a run over ITS fixtures issues no write. That is a claim about the paths
 * those fixtures reach. This is the complementary claim: the detector's source contains no write
 * SURFACE at all, so there is no input, flag or unlucky branch that could reach one. Neither guard
 * subsumes the other — a write behind a condition no fixture satisfies is invisible to the first,
 * and a write issued by an imported module is invisible to the second, which is why the two are
 * asserted against different things (behaviour, and the import ledger below).
 *
 * 🔴 EVERY assertion here is an asserted LEDGER — an exact set, failing when it grows AND when it
 * shrinks — rather than a search for a forbidden word. A word list is walkable by spelling the same
 * hazard differently; a ledger is not, because the new spelling is still a new member of the set.
 */

const MODULE_DIR = path.resolve(__dirname, '..');
const JOB_FILE = path.resolve(__dirname, '../../../jobs/bot-account-detection.ts');

/**
 * Comments removed, because the claims below are about CODE.
 *
 * These files explain at length why they hold no write client, and an explanation that names the
 * thing it forbids would otherwise fail the very guard it documents — training the next maintainer
 * to delete the comment rather than keep the property. Blank lines are substituted for a stripped
 * block so nothing on either side of it is joined into a token that was never written.
 */
export function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:])\/\/[^\n]*/g, (_m, lead: string) => lead);
}

const EXCLUDED_DIRS = new Set(['__tests__']);

/**
 * Every `.ts` file under a directory, RECURSIVELY.
 *
 * 🔴 A flat `readdirSync` was a hole with a name on it: heuristics are the announced next change,
 * they will land in `heuristics/`, and a flat walk stops scanning the moment a subdirectory exists.
 * Nothing goes red when that happens — the ledgers below simply stop covering the new code and keep
 * passing, which is the failure mode this whole file exists to prevent.
 *
 * Test directories are excluded: they legitimately name write paths in order to assert they are
 * unused.
 */
export function listSourceFiles(root: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) {
      if (EXCLUDED_DIRS.has(entry.name)) continue;
      out.push(...listSourceFiles(full));
    } else if (entry.isFile() && entry.name.endsWith('.ts')) {
      out.push(full);
    }
  }
  return out.sort();
}

/** Every source file the detector is made of. */
function detectorFiles(): string[] {
  return [...listSourceFiles(MODULE_DIR), JOB_FILE];
}

function detectorSources(): Array<{ file: string; source: string }> {
  return detectorFiles().map((file) => ({
    file: path.relative(path.resolve(__dirname, '../../../../..'), file),
    source: stripComments(readFileSync(file, 'utf8')),
  }));
}

/** `db.model.method(` / `dbRead.model.method(` / `dbWrite.model.method(` — the shape every Prisma
 *  call in this codebase takes. */
const DB_CALL = /\bdb(?:Read|Write)?\.([A-Za-z_$][\w$]*)\.([A-Za-z_$][\w$]*)\(/g;

function databaseOperations(sources: ReturnType<typeof detectorSources>): string[] {
  const found = new Set<string>();
  for (const { source } of sources)
    for (const match of source.matchAll(DB_CALL)) found.add(`${match[1]}.${match[2]}`);
  return [...found].sort();
}

/**
 * Every module specifier this code can pull in, however it is spelled.
 *
 * 🔴 Three spellings, because a ledger that only knows one of them is a word list wearing a
 * ledger's clothes. Each of these was a demonstrated escape from the single-quoted `from '…'`
 * pattern this used to be, and each left the whole suite green:
 *  - `from "…"` — double quotes. A one-character difference.
 *  - `await import('…')` / `import("…")` — a DYNAMIC import, which defeats BOTH halves of the guard
 *    at once: it adds no `dbWrite` token and no new database operation, so the operation ledger is
 *    unmoved, and it is not a `from` clause, so the import ledger was unmoved too. It is also the
 *    natural way to reach a heavy service from a job.
 *  - `require('…')` — included for completeness; it is a module reference like any other and
 *    leaving it out would just move the hole.
 * The alternation is written once so a fourth spelling is added in one place.
 */
const MODULE_REF = /(?:\bfrom|\bimport|\brequire)\s*\(?\s*(?:'([^'\n]+)'|"([^"\n]+)")/g;

function importSpecifiers(sources: ReturnType<typeof detectorSources>): string[] {
  const found = new Set<string>();
  for (const { source } of sources)
    for (const match of source.matchAll(MODULE_REF)) found.add(match[1] ?? match[2]);
  return [...found].sort();
}

describe('the detector has no write surface', () => {
  it('reads its own source — positive control', () => {
    // Everything below is a claim about a set of files. If the walk returns nothing, or files with
    // no content, every one of those claims is vacuously true and this suite reports success while
    // checking nothing.
    const sources = detectorSources();
    expect(sources.length).toBeGreaterThanOrEqual(5);
    expect(sources.every((s) => s.source.length > 200)).toBe(true);
    expect(sources.map((s) => path.basename(s.file))).toContain('cohort.ts');
    expect(sources.map((s) => path.basename(s.file))).toContain('bot-account-detection.ts');
  });

  it('scans EVERY file in the module tree, at any depth — exhaustiveness', () => {
    // 🔴 This replaces a hand-maintained list of five basenames. That list was the wrong shape of
    // assertion: it pinned which files exist, not that every file that exists is SCANNED, so a
    // sixth file added under `heuristics/` failed the list once (a maintainer deletes the stale
    // name) and was then invisible forever after.
    //
    // The enumeration this is checked against is deliberately a DIFFERENT MECHANISM from the walk
    // it grades — Node's own `readdirSync(..., { recursive: true })` rather than the hand-rolled
    // recursion in `listSourceFiles` — so the two cannot share a bug and agree on it.
    const expected = readdirSync(MODULE_DIR, { recursive: true, encoding: 'utf8' })
      .filter((rel) => rel.endsWith('.ts'))
      .filter((rel) => !rel.split(path.sep).some((seg) => EXCLUDED_DIRS.has(seg)))
      .map((rel) => path.join(MODULE_DIR, rel))
      .sort();

    const scanned = detectorFiles().sort();
    expect(expected.length).toBeGreaterThanOrEqual(4);
    // Every file in the tree is scanned. Set equality, not containment: a scanned file that is not
    // in the tree means the walk is reading something it should not be.
    expect(scanned).toEqual([...expected, JOB_FILE].sort());
  });

  it('a module in a SUBDIRECTORY is scanned — the escape heuristics will walk into', () => {
    // Red before the recursive walk landed: a flat `readdirSync` returns the directory entry and
    // filters it out for not ending in `.ts`, so the nested file is never opened and everything
    // inside it is unledgered. Built on a temp tree rather than the real one so the control is a
    // control and not a commit.
    const root = mkdtempSync(path.join(os.tmpdir(), 'bot-account-tree-'));
    mkdirSync(path.join(root, 'heuristics'));
    mkdirSync(path.join(root, '__tests__'));
    writeFileSync(path.join(root, 'top.ts'), 'export const a = 1;\n');
    writeFileSync(
      path.join(root, 'heuristics', 'ip-cluster.ts'),
      "import { applyPendingReviewMute } from '~/server/services/user-restriction.service';\n" +
        'await dbWrite.user.update({ where: { id }, data: { muted: true } });\n'
    );
    writeFileSync(path.join(root, '__tests__', 'ignored.ts'), 'export const b = 2;\n');
    writeFileSync(path.join(root, 'notes.md'), 'dbWrite.user.update(x)\n');

    const files = listSourceFiles(root).map((f) => path.relative(root, f));
    expect(files).toEqual([path.join('heuristics', 'ip-cluster.ts'), 'top.ts']);

    // And the scanners see through to it: the planted write is a ledger member, not invisible.
    const sources = listSourceFiles(root).map((file) => ({
      file,
      source: stripComments(readFileSync(file, 'utf8')),
    }));
    expect(databaseOperations(sources)).toEqual(['user.update']);
    expect(importSpecifiers(sources)).toEqual(['~/server/services/user-restriction.service']);
  });

  it('sees an import however it is spelled — the two quote/dynamic escapes', () => {
    // Each of these was planted alone in the real tree and left the full suite green, because the
    // scanner matched only `from '…'`. They are asserted here on synthetic sources so the control
    // is repeatable and does not require editing a shipped file.
    const doubleQuoted = [
      { file: 'a.ts', source: 'import { x } from "~/server/services/user-restriction.service";\n' },
    ];
    expect(importSpecifiers(doubleQuoted)).toEqual(['~/server/services/user-restriction.service']);

    const dynamic = [
      {
        file: 'b.ts',
        source:
          "const m = await import('~/server/services/user-restriction.service');\nm.applyPendingReviewMute(id);\n",
      },
    ];
    // 🔴 The case that defeats BOTH halves of the guard: no `dbWrite` token, no new database
    // operation, and — until this — no `from` clause either.
    expect(importSpecifiers(dynamic)).toEqual(['~/server/services/user-restriction.service']);
    expect(databaseOperations(dynamic)).toEqual([]);

    const dynamicDoubleQuoted = [
      { file: 'c.ts', source: 'await import("~/server/services/user-restriction.service");\n' },
    ];
    expect(importSpecifiers(dynamicDoubleQuoted)).toEqual([
      '~/server/services/user-restriction.service',
    ]);

    const required = [
      {
        file: 'd.ts',
        source: "const m = require('~/server/services/user-restriction.service');\n",
      },
    ];
    expect(importSpecifiers(required)).toEqual(['~/server/services/user-restriction.service']);
  });

  it('the comment stripper removes prose and keeps code — controls, both directions', () => {
    // The stripper is an instrument the ledgers below read through. A stripper that removed too
    // much would delete a real write and report a clean ledger; one that removed nothing would fail
    // on the files' own explanations. Both directions, so neither is assumed.
    expect(stripComments('// dbWrite.user.update(x)\nconst a = 1;')).not.toContain('dbWrite');
    expect(stripComments('/* a\n dbWrite.user.update(x)\n */ const a = 1;')).not.toContain(
      'dbWrite'
    );
    expect(stripComments('await dbWrite.user.update(x); // fine')).toContain(
      'dbWrite.user.update(x)'
    );
    // A `://` inside a URL is not a line comment, and treating it as one would silently truncate
    // the rest of that line — including a write sitting after it.
    expect(stripComments("fetch('https://x/y'); dbWrite.user.update(z);")).toContain(
      'dbWrite.user.update'
    );
  });

  it('the scanners can see a write — negative control', () => {
    // Proves the instrument can go red before its zero is believed. Built from the exact text a
    // real regression would carry, not a textbook fixture.
    const planted = [
      {
        file: 'planted.ts',
        source:
          "import { applyPendingReviewMute } from '~/server/services/user-restriction.service';\n" +
          'await dbWrite.user.update({ where: { id }, data: { muted: true } });\n',
      },
    ];
    expect(databaseOperations(planted)).toEqual(['user.update']);
    expect(importSpecifiers(planted)).toEqual(['~/server/services/user-restriction.service']);
  });

  it('performs exactly five database operations, all of them reads', () => {
    // 🔴 THE LEDGER. A write added anywhere in these files is a sixth member and fails here; a read
    // removed is a missing member and fails here too (dropping `commentV2` would silently turn
    // every newer-comment-only account into a false negative).
    expect(databaseOperations(detectorSources())).toEqual([
      'comment.groupBy',
      'commentV2.groupBy',
      'image.groupBy',
      'model.groupBy',
      'user.findMany',
    ]);
  });

  it('imports exactly the modules it needs, and none that can act on an account', () => {
    // The other half of the ledger: a write does not have to be spelled here to happen here. Calling
    // `applyPendingReviewMute` is one import and one line, and it would leave the database-operation
    // ledger above completely unmoved. Adding a module to this list is the moment to ask whether
    // the shadow guarantee still holds.
    expect(importSpecifiers(detectorSources())).toEqual([
      './cohort',
      './job',
      './report',
      './scoring',
      '@civitai/moderation',
      '~/server/db/client',
      '~/server/logging/client',
      '~/server/services/bot-account-detection/cohort',
      '~/server/services/bot-account-detection/run',
      '~/server/services/moderator-app.service',
      '~/shared/utils/prisma/enums',
    ]);
  });

  it('names the write client nowhere', () => {
    // Redundant with the ledgers by construction, and kept anyway: it is the assertion whose failure
    // message names the hazard directly, so a maintainer who trips it is told what they did rather
    // than shown a set diff.
    for (const { file, source } of detectorSources())
      expect(source.includes('dbWrite'), `${file} names the write client`).toBe(false);
  });
});
