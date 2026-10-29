import { readdirSync, readFileSync, statSync } from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

/**
 * Every file that writes `Model."lockedProperties"` has made a decision about `meta.systemNsfwLock`.
 *
 * The marker says a system check set the nsfw lock, which lets the owner dispute it. A write that
 * changes the lock on anyone else's behalf must clear it in the same statement, or a later
 * moderator lock reads as the system's. The rating-review reader also checks ModActivity, but only
 * for paths that log, so a new unlogged lock writer would reopen that gap without this guard.
 *
 * Checked as source text across `src/`, `apps/`, `packages/` and `scripts/`. A file is in scope when
 * it writes the `Model` table and assigns `lockedProperties`. Each in-scope file is in the ledger
 * with its decision and the exact count of lock assignments it holds: a new file fails, a file that
 * gains or loses one fails, so every change to a lock write gets a decision.
 */
const repoRoot = path.resolve(__dirname, '../../../..');
const ROOTS = ['src', 'apps', 'packages', 'scripts'];
const SKIP =
  /node_modules|__tests__|\.test\.|\.spec\.|\/dist\/|\/build\/|\.svelte-kit|\/generated\//;

const MODEL_WRITE =
  /UPDATE\s+"Model"|\.model\.(update|updateMany|upsert|create)\b|updateTable\(\s*['"]Model['"]\s*\)|insertInto\(\s*['"]Model['"]\s*\)/;
// Assignments only: a `select { lockedProperties: true }` or a type annotation is not a write.
const LOCK_WRITE =
  /"lockedProperties"\s*=(?!=)|\blockedProperties\s*:(?!\s*(?:true\b|string|boolean|readonly|Array\b|\w+\[\]))|(?<![.'"\w$])lockedProperties\s*[,}]|addLock\(/g;
const MARKER = /systemNsfwLock|SYSTEM_NSFW_LOCK_META_KEY|withoutSystemNsfwLock/;

type Decision =
  /** Clears the marker where a moderator or rollback changes the lock. */
  | { kind: 'clears' }
  /** A system check that sets the marker with the lock it adds. */
  | { kind: 'sets' }
  /** Writes locks without touching the marker, and why that is safe. */
  | { kind: 'exempt'; why: string };

const LEDGER: Record<string, { lockWrites: number; decision: Decision }> = {
  'src/server/services/model.service.ts': { lockWrites: 12, decision: { kind: 'clears' } },
  'src/server/services/poi-hash.service.ts': { lockWrites: 4, decision: { kind: 'clears' } },
  'src/server/services/minor-hash.service.ts': { lockWrites: 1, decision: { kind: 'clears' } },
  'apps/moderator/src/lib/server/rating-reviews.service.ts': {
    lockWrites: 6,
    decision: { kind: 'clears' },
  },
  'src/server/services/text-scan/actions/model-nsfw.ts': {
    lockWrites: 4,
    decision: { kind: 'sets' },
  },
  'src/server/services/text-scan/actions/model-poi-minor.ts': {
    lockWrites: 9,
    decision: {
      kind: 'exempt',
      why: 'a poi/minor lock forces nsfw off and restricts disputes, so a stale marker never reads',
    },
  },
  'src/pages/api/admin/temp/migrate-profanity-nsfw.ts': {
    lockWrites: 8,
    decision: {
      kind: 'exempt',
      why: 'one-off backfill; the locks it adds carry no marker, which reads as not disputable',
    },
  },
};

function sourceFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry);
      const rel = path.relative(repoRoot, full);
      if (SKIP.test(rel)) continue;
      if (statSync(full).isDirectory()) walk(full);
      else if (/\.(ts|tsx|mjs|js)$/.test(entry)) out.push(rel);
    }
  };
  for (const root of ROOTS) walk(path.join(repoRoot, root));
  return out;
}

export function lockWriters(files: string[], read: (rel: string) => string) {
  const found: Record<string, { lockWrites: number; marker: boolean }> = {};
  for (const rel of files) {
    const text = read(rel);
    if (!MODEL_WRITE.test(text)) continue;
    const lockWrites = (text.match(LOCK_WRITE) ?? []).length;
    if (lockWrites) found[rel] = { lockWrites, marker: MARKER.test(text) };
  }
  return found;
}

const readRepo = (rel: string) => readFileSync(path.join(repoRoot, rel), 'utf8');

describe('no-undecided-model-lock-write', () => {
  it('sees raw, Prisma, Kysely and shorthand lock writes, and not a select', () => {
    const files: Record<string, string> = {
      'raw.ts': 'sql`UPDATE "Model" SET "lockedProperties" = ${x}`',
      'prisma.ts': 'tx.model.update({ data: { lockedProperties: next } })',
      'kysely.ts': "trx.updateTable('Model').set({ lockedProperties: addLock('nsfw') })",
      'shorthand.ts': 'tx.model.update({ data: { nsfw, lockedProperties } })',
      'select.ts': 'db.model.update({ select: { lockedProperties: true } })',
    };
    expect(Object.keys(lockWriters(Object.keys(files), (f) => files[f]))).toEqual([
      'raw.ts',
      'prisma.ts',
      'kysely.ts',
      'shorthand.ts',
    ]);
  });

  const found = lockWriters(sourceFiles(), readRepo);

  it('finds every ledger file, so a broken scan cannot pass as a clean one', () => {
    expect(Object.keys(found).sort()).toEqual(expect.arrayContaining(Object.keys(LEDGER).sort()));
  });

  it('has a marker decision for every file that writes Model lockedProperties', () => {
    const undecided = Object.keys(found).filter((f) => !(f in LEDGER));
    expect(
      undecided,
      'Decide whether this write clears meta.systemNsfwLock, then add the file to LEDGER'
    ).toEqual([]);
  });

  it('pins the lock writes in each file, so a new one gets a decision too', () => {
    for (const [file, { lockWrites }] of Object.entries(LEDGER))
      expect({ file, lockWrites: found[file]?.lockWrites }).toEqual({ file, lockWrites });
  });

  it('names the marker in every file that clears or sets it', () => {
    for (const [file, { decision }] of Object.entries(LEDGER))
      if (decision.kind !== 'exempt')
        expect({ file, marker: found[file]?.marker }).toEqual({
          file,
          marker: true,
        });
  });
});
