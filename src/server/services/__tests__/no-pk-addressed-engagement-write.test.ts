import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'fs';
import path from 'path';

/**
 * 🔴 SOURCE GATE for 868kurkc7 / 868kun67j.
 *
 * Every `*Engagement` table is one row per (user, entity) carrying ONE `type`, so the
 * types are mutually exclusive by construction. A writer that addresses that row by
 * its PRIMARY KEY — `delete`/`update` on `userId_<entity>Id` — lands on whatever type
 * occupies the row, including one a sibling writer established a millisecond earlier,
 * and reports success. Six writers across three files had exactly that shape.
 *
 * A guard rather than six per-table tests, on purpose: **the defect is a
 * hand-enumeration bug**, and six hand-enumerated tests catch exactly the six tables
 * that already exist. This one catches the seventh.
 *
 * `BountyEngagement` is exempt, and is the argument for the rule: its key is
 * `type_bountyId_userId`, so the type is IN the key and every PK-addressed write is
 * scoped for free. Add a table here only when its key carries `type`.
 */

const REPO_ROOT = path.resolve(__dirname, '../../../..');
const SRC = path.join(REPO_ROOT, 'src');

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === '__tests__' || entry.name === 'node_modules') continue;
      sourceFiles(full, out);
    } else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) {
      out.push(full);
    }
  }
  return out;
}

// `dbWrite.modelEngagement.delete(` / `tx.imageEngagement.update(` / `.upsert(`. The
// receiver is left open so a client held under any local name is still caught.
// `upsert` is in the list because it addresses the row by the same compound key: it is
// safe in `toggleBlockUser` only because Block is top of precedence, and a copy of that
// shape for any other type is precisely the case this rule exists for.
const PK_ADDRESSED = /\.(\w*[eE]ngagement)\s*\.\s*(delete|update|upsert)\s*\(/g;

// The remediation this rule pushes an author toward is `delete` -> `deleteMany`. Doing
// that WITHOUT adding the `type` filter reproduces the defect with the rule green, so
// the `*Many` spelling is checked for a `type` in its `where` rather than trusted.
// Window-based rather than brace-matched: enough to catch the forgetful rewrite, not a
// parser. It cannot see a `where` built in a variable — that is the known hole.
const SCOPED_MANY =
  /\.(\w*[eE]ngagement)\s*\.\s*(deleteMany|updateMany)\s*\(([\s\S]{0,400}?)\)\s*;/g;

/** Keys that already carry `type`, so a PK-addressed write cannot cross types. */
const TYPE_IN_KEY = new Set([
  'bountyEngagement', // type_bountyId_userId
  'challengeEngagement', // type_challengeId_userId
]);

/**
 * PK-addressed writes that are correct because the type they write is top of its
 * table's precedence order, so there is nothing it could overwrite that outranks it.
 * Each entry is a claim someone checked — not a snooze.
 */
const PRECEDENCE_TOP = new Set([
  'src/server/services/user-preferences.service.ts:userEngagement.upsert', // Block
]);

/**
 * Writes whose `type` filter is real but lives in a VARIABLE, which the text scan
 * cannot see. Each entry is a claim someone checked by reading the file.
 *
 * `setUserEngagement` is the canonical scoped writer for `UserEngagement` — its guard
 * is `claimable`, derived from the requested type's precedence, which is exactly what
 * this rule wants and is the one shape a regex cannot confirm.
 */
const WHERE_IN_VARIABLE = new Set([
  'src/server/services/user-engagement.ts:userEngagement.updateMany',
]);

const FILES = sourceFiles(SRC);
const rel = (f: string) => path.relative(REPO_ROOT, f).split(path.sep).join('/');

describe('no PK-addressed write to a type-carrying engagement table', () => {
  it('scans a corpus that is actually there', () => {
    // A gate that silently scans nothing reports the property as held. Pin the corpus
    // from below, and name the three files that carry the writers this rule exists
    // for — so a move or a rename fails HERE rather than dropping out of the scan.
    expect(FILES.length).toBeGreaterThan(500);
    const names = FILES.map(rel);
    for (const f of [
      'src/server/services/user-preferences.service.ts',
      'src/server/services/user.service.ts',
      'src/server/services/model-version.service.ts',
    ]) {
      expect(names).toContain(f);
    }
  });

  it.each([
    ['dbWrite.modelEngagement.delete({ where: { userId_modelId } })', 'modelEngagement'],
    ['await tx.imageEngagement.update({ where: { userId_imageId } })', 'imageEngagement'],
    ['dbWrite.model3DEngagement . delete ( { } )', 'model3DEngagement'],
  ])('matches the shape it forbids: %s', (source, delegate) => {
    // Control. Without this every clean result below could be a regex that matches
    // nothing — the failure mode that makes a source gate worse than no gate.
    const hits = [...source.matchAll(PK_ADDRESSED)];
    expect(hits).toHaveLength(1);
    expect(hits[0][1]).toBe(delegate);
  });

  it.each([
    'dbWrite.modelEngagement.deleteMany({ where: { userId, modelId, type } })',
    'dbWrite.modelEngagement.updateMany({ where: { userId, modelId, type } })',
    'dbRead.modelEngagement.findUnique({ where: { userId_modelId } })',
  ])('does not fire on the scoped form: %s', (source) => {
    expect([...source.matchAll(PK_ADDRESSED)]).toEqual([]);
  });

  it('finds no PK-addressed engagement write in src/', () => {
    const found: string[] = [];

    for (const file of FILES) {
      const text = readFileSync(file, 'utf8');
      if (!text.includes('Engagement')) continue;

      for (const match of text.matchAll(PK_ADDRESSED)) {
        const [, delegate, op] = match;
        if (TYPE_IN_KEY.has(delegate)) continue;
        if (PRECEDENCE_TOP.has(`${rel(file)}:${delegate}.${op}`)) continue;
        const line = text.slice(0, match.index).split('\n').length;
        found.push(`${rel(file)}:${line} — ${delegate}.${op}()`);
      }
    }

    expect(found).toEqual([]);
  });

  it('finds no type-setting *Many engagement write that is not scoped by type', () => {
    const found: string[] = [];

    for (const file of FILES) {
      const text = readFileSync(file, 'utf8');
      if (!text.includes('Engagement')) continue;

      for (const match of text.matchAll(SCOPED_MANY)) {
        const [, delegate, op, args] = match;
        if (TYPE_IN_KEY.has(delegate)) continue;
        const dataAt = args.indexOf('data');
        if (dataAt === -1) continue;
        // Only a write that SETS `type` can cross types. A bulk re-point that moves
        // rows to another entity id touches no type and needs no type filter — the
        // version-merge in model-version.service.ts is the real example.
        if (!/\btype\b/.test(args.slice(dataAt))) continue;
        if (/\btype\b/.test(args.slice(0, dataAt))) continue;
        if (WHERE_IN_VARIABLE.has(`${rel(file)}:${delegate}.${op}`)) continue;
        const line = text.slice(0, match.index).split('\n').length;
        found.push(`${rel(file)}:${line} — ${delegate}.${op}() sets type, unscoped`);
      }
    }

    expect(found).toEqual([]);
  });

  it.each([
    [
      'sets type with no filter',
      'deleteMany({ where: { userId, modelId }, data: { type } })',
      true,
    ],
    [
      'sets type, scoped',
      'updateMany({ where: { userId, modelId, type }, data: { type } })',
      false,
    ],
    [
      're-points, sets no type',
      'updateMany({ where: { modelVersionId: { in: ids } }, data: { modelVersionId: t } })',
      false,
    ],
  ])('the *Many check reads the where AND the data: %s', (_label, tail, shouldFlag) => {
    // Controls. The remediation this rule pushes an author toward is
    // `delete` -> `deleteMany`; a check that only matched the method name would bless
    // the forgetful rewrite, and one that ignored `data` would flag every bulk
    // re-point in the repo.
    const source = `dbWrite.modelEngagement.${tail};`;
    const flagged = [...source.matchAll(SCOPED_MANY)].filter((m) => {
      const args = m[3];
      const dataAt = args.indexOf('data');
      if (dataAt === -1) return false;
      if (!/\btype\b/.test(args.slice(dataAt))) return false;
      return !/\btype\b/.test(args.slice(0, dataAt));
    });
    expect(flagged.length > 0).toBe(shouldFlag);
  });
});
