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

// `dbWrite.modelEngagement.delete(` / `tx.imageEngagement.update(`. The receiver is
// left open so a client held under any local name is still caught.
const PK_ADDRESSED = /\.(\w*[eE]ngagement)\s*\.\s*(delete|update)\s*\(/g;

/** Keys that already carry `type`, so a PK-addressed write cannot cross types. */
const TYPE_IN_KEY = new Set([
  'bountyEngagement', // type_bountyId_userId
  'challengeEngagement', // type_challengeId_userId
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
        const line = text.slice(0, match.index).split('\n').length;
        found.push(`${rel(file)}:${line} — ${delegate}.${op}()`);
      }
    }

    expect(found).toEqual([]);
  });
});
