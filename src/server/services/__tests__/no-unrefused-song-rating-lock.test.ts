import { readdirSync, readFileSync, statSync } from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

/**
 * Every file that sets `Image."nsfwLevelLocked"` to true has been reviewed for songs.
 *
 * A rating lock counts as the image's review, and a song is published only by its own scan: a lock
 * written on a song without that scan would publish it. So each writer refuses a song (`audio`),
 * and this ledger is what makes a new writer get that review.
 *
 * Checked as source text across `src/`, `apps/`, `packages/` and `scripts/`, tests and fixtures
 * excluded. Every literal `nsfwLevelLocked: true` (a Prisma `data` or Kysely `set`, and also a
 * Prisma `select`, which reads the same) and `"nsfwLevelLocked" = TRUE` (a raw SQL write, or a
 * read in a WHERE) is counted per file. Each file holding one is in the ledger with that count and
 * its decision: a new file fails, a file that gains or loses one fails.
 *
 * Limits, all failing OPEN: the refusal is checked per file, so a new unrefused write in a
 * `refuses` file passes once its count is bumped; a lock set from a variable (`nsfwLevelLocked:
 * locked`) or a `data` object built elsewhere is not seen.
 */
const repoRoot = path.resolve(__dirname, '../../../..');
const ROOTS = ['src', 'apps', 'packages', 'scripts'];
const SKIP =
  /node_modules|__tests__|\.test\.|\.spec\.|\/test\/|\/dist\/|\/build\/|\.svelte-kit|\/generated\//;

const LOCK_TRUE = /\bnsfwLevelLocked\s*:\s*true\b|"nsfwLevelLocked"\s*=\s*true\b/gi;
const SONG_REFUSAL = /MediaType\.audio|['"]audio['"]/;

type Decision =
  /** Writes the lock, and refuses a song before or in the write. */
  | { kind: 'refuses' }
  /** Only reads the lock. */
  | { kind: 'reads'; why: string };

const LEDGER: Record<string, { locks: number; decision: Decision }> = {
  // A moderator rating, the Knights consensus rating (in its WHERE), the ingestion-error resolve,
  // and one select.
  'src/server/services/image.service.ts': { locks: 4, decision: { kind: 'refuses' } },
  'apps/moderator/src/lib/server/image-nsfw-level.ts': { locks: 1, decision: { kind: 'refuses' } },
  'apps/moderator/src/lib/server/ingestion.service.ts': { locks: 1, decision: { kind: 'refuses' } },
  'src/server/services/image-scan-pipeline.ts': {
    locks: 1,
    decision: { kind: 'reads', why: 'loadImageForScan selects it' },
  },
  'src/server/services/user-preferences.service.ts': {
    locks: 1,
    decision: { kind: 'reads', why: 'an image select' },
  },
  'src/server/services/article.service.ts': {
    locks: 3,
    decision: { kind: 'reads', why: 'image selects' },
  },
  'src/server/services/report.service.ts': {
    locks: 1,
    decision: { kind: 'reads', why: 'an image select' },
  },
  'src/server/common/image-visibility.ts': {
    locks: 1,
    decision: { kind: 'reads', why: 'a WHERE condition' },
  },
  'packages/civitai-db-queries/src/profile-picture-clear.db.ts': {
    locks: 1,
    decision: { kind: 'reads', why: 'a WHERE condition' },
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
      // LEDGER keys and SKIP use forward slashes; Windows paths come back with backslashes.
      const rel = path.relative(repoRoot, full).split(path.sep).join('/');
      if (SKIP.test(rel)) continue;
      if (statSync(full).isDirectory()) walk(full);
      else if (/\.(ts|tsx|mjs|js|svelte)$/.test(entry)) out.push(rel);
    }
  };
  for (const root of ROOTS) walk(path.join(repoRoot, root));
  return out;
}

export function lockSetters(files: string[], read: (rel: string) => string) {
  const found: Record<string, { locks: number; refusesSong: boolean }> = {};
  for (const rel of files) {
    const text = read(rel);
    const locks = (text.match(LOCK_TRUE) ?? []).length;
    if (locks) found[rel] = { locks, refusesSong: SONG_REFUSAL.test(text) };
  }
  return found;
}

const readRepo = (rel: string) => readFileSync(path.join(repoRoot, rel), 'utf8');

describe('no-unrefused-song-rating-lock', () => {
  it('sees Prisma, Kysely and raw SQL locks, and not an unlock', () => {
    const files: Record<string, string> = {
      'prisma.ts': 'tx.image.update({ data: { nsfwLevel, nsfwLevelLocked: true } })',
      'kysely.ts': "trx.updateTable('Image').set({ nsfwLevelLocked: true })",
      'raw.ts': 'sql`UPDATE "Image" SET "nsfwLevelLocked" = TRUE WHERE id = ${id}`',
      'lower.ts': 'sql`UPDATE "Image" SET "nsfwLevelLocked"=true`',
      'unlock.ts': 'tx.image.update({ data: { nsfwLevelLocked: false } })',
    };
    expect(Object.keys(lockSetters(Object.keys(files), (f) => files[f]))).toEqual([
      'prisma.ts',
      'kysely.ts',
      'raw.ts',
      'lower.ts',
    ]);
  });

  const found = lockSetters(sourceFiles(), readRepo);

  it('finds every ledger file, so a broken scan cannot pass as a clean one', () => {
    expect(Object.keys(found)).toEqual(expect.arrayContaining(Object.keys(LEDGER)));
  });

  it('has a song decision for every file that sets the rating lock', () => {
    const undecided = Object.keys(found).filter((f) => !(f in LEDGER));
    expect(
      undecided,
      'A lock publishes a song that only its own scan may publish: refuse `audio` in the write, then add the file to LEDGER'
    ).toEqual([]);
  });

  it('pins the lock count of every ledger file', () => {
    const counts = Object.fromEntries(Object.entries(found).map(([f, { locks }]) => [f, locks]));
    const expected = Object.fromEntries(Object.entries(LEDGER).map(([f, { locks }]) => [f, locks]));
    expect(counts, 'Review the added or removed lock for songs, then update LEDGER').toEqual(
      expected
    );
  });

  it('refuses a song in every file that writes the lock', () => {
    const unrefused = Object.entries(LEDGER)
      .filter(([f, { decision }]) => decision.kind === 'refuses' && !found[f]?.refusesSong)
      .map(([f]) => f);
    expect(unrefused).toEqual([]);
  });
});
