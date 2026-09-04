import { readFileSync, readdirSync } from 'fs';
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

/** Every source file the detector is made of. Tests excluded: they legitimately name write paths in
 *  order to assert they are unused. */
function detectorSources(): Array<{ file: string; source: string }> {
  const files = readdirSync(MODULE_DIR)
    .filter((f) => f.endsWith('.ts'))
    .map((f) => path.join(MODULE_DIR, f));
  return [...files, JOB_FILE].map((file) => ({
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

function importSpecifiers(sources: ReturnType<typeof detectorSources>): string[] {
  const found = new Set<string>();
  for (const { source } of sources)
    for (const match of source.matchAll(/\bfrom\s+'([^']+)'/g)) found.add(match[1]);
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
    expect(sources.map((s) => path.basename(s.file)).sort()).toEqual([
      'bot-account-detection.ts',
      'cohort.ts',
      'report.ts',
      'run.ts',
      'scoring.ts',
    ]);
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
