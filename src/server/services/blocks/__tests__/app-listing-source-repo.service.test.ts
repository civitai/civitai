import { describe, expect, it, vi } from 'vitest';

import {
  isMissingColumnError,
  isSourceRepoColumnAvailable,
  readListingSourceRepoUrl,
  sourceRepoWriteFragment,
  type SourceRepoReadClient,
} from '~/server/services/blocks/app-listing-source-repo.service';

/**
 * The UNAPPLIED-MIGRATION posture for `app_listings.source_repo_url`.
 *
 * 🔴 THE OUTAGE THIS PREVENTS, stated concretely: migrations in this repo are never
 * auto-applied. Between merging this change and a human running the SQL on the CNPG
 * primary, production runs code that names a column the database does not have. Prisma
 * does NOT return `undefined` for a missing column — it throws P2022, for the WHOLE
 * query. So `sourceRepoUrl: true` inside `listingHydrateSelect` (which the public
 * `/apps` grid and the store detail page share) would 500 both, turning an additive,
 * optional, cosmetic field into an outage on a public page.
 *
 * These tests exercise the degraded branch directly, with a client that throws the real
 * error shape — the only way to reach it without a database that is actually missing
 * the column.
 */

/** A Prisma-shaped "column does not exist" error. */
function missingColumnError(code = 'P2022'): Error {
  const err = new Error(
    'The column `app_listings.source_repo_url` does not exist in the current database.'
  ) as Error & { code?: string };
  err.code = code;
  return err;
}

/** A client whose `findUnique` resolves to `row`. */
function okClient(row: { sourceRepoUrl: string | null } | null): SourceRepoReadClient {
  return { appListing: { findUnique: vi.fn(async () => row) } };
}

/** A client whose `findUnique` throws `err`. */
function throwingClient(err: unknown): SourceRepoReadClient {
  return {
    appListing: {
      findUnique: vi.fn(async () => {
        throw err;
      }),
    },
  };
}

describe('isMissingColumnError — matched on the CODE, never a message substring', () => {
  it.each([
    ['Prisma P2022', missingColumnError('P2022')],
    ['Postgres 42703', missingColumnError('42703')],
  ])('recognises %s', (_label, err) => {
    expect(isMissingColumnError(err)).toBe(true);
  });

  it('recognises the code nested under `meta` (some engine versions report it there)', () => {
    expect(isMissingColumnError({ code: 'P2000', meta: { code: '42703' } })).toBe(true);
    expect(isMissingColumnError({ meta: { code: 'P2022' } })).toBe(true);
  });

  it('🔴 does NOT match on the MESSAGE alone — the code is the contract', () => {
    // A message-substring guard is the version that silently stops matching when the
    // driver rewords its errors. An error carrying the exact prose but no code must not
    // be treated as a missing column.
    const worded = new Error('The column `source_repo_url` does not exist');
    expect(isMissingColumnError(worded)).toBe(false);
  });

  it.each([
    ['a missing TABLE (42P01)', { code: '42P01' }],
    ['a Prisma missing-table (P2021)', { code: 'P2021' }],
    ['a unique violation', { code: 'P2002' }],
    ['a connection failure', { code: 'P1001' }],
    ['a permission error', { code: '42501' }],
    ['a plain Error', new Error('boom')],
    ['a string', 'P2022'],
    ['null', null],
    ['undefined', undefined],
  ])('🔴 does NOT swallow %s — degrading on those would hide a real outage', (_label, err) => {
    expect(isMissingColumnError(err)).toBe(false);
  });
});

describe('readListingSourceRepoUrl', () => {
  it('POSITIVE CONTROL: returns the stored value with available=true', async () => {
    // Without this, a function hardcoded to `{available:false, value:null}` would pass
    // every degradation case below.
    const db = okClient({ sourceRepoUrl: 'https://github.com/civitai/civitai' });
    await expect(readListingSourceRepoUrl('apl_1', db)).resolves.toEqual({
      available: true,
      value: 'https://github.com/civitai/civitai',
    });
    expect(db.appListing.findUnique).toHaveBeenCalledWith({
      where: { id: 'apl_1' },
      // 🔴 The select must name ONLY this column. Widening it here would put the
      // manual-apply column back into a query that carries other fields.
      select: { sourceRepoUrl: true },
    });
  });

  it('a listing with no source repo is available=true, value=null', async () => {
    await expect(
      readListingSourceRepoUrl('apl_1', okClient({ sourceRepoUrl: null }))
    ).resolves.toEqual({ available: true, value: null });
  });

  it('a missing ROW is available=true (the column was readable; there was nothing to read)', async () => {
    await expect(readListingSourceRepoUrl('apl_missing', okClient(null))).resolves.toEqual({
      available: true,
      value: null,
    });
  });

  it.each([['P2022'], ['42703']])(
    '🔴 DEGRADES to {available:false, value:null} on %s instead of throwing',
    async (code) => {
      const db = throwingClient(missingColumnError(code));
      await expect(readListingSourceRepoUrl('apl_1', db)).resolves.toEqual({
        available: false,
        value: null,
      });
    }
  );

  it('🔴 RE-THROWS anything else — a connection failure must NOT read as "no repo set"', async () => {
    const boom = Object.assign(new Error('Can’t reach database server'), { code: 'P1001' });
    await expect(readListingSourceRepoUrl('apl_1', throwingClient(boom))).rejects.toBe(boom);
  });
});

describe('isSourceRepoColumnAvailable — the write-path probe', () => {
  it('true when the column reads', async () => {
    await expect(isSourceRepoColumnAvailable(okClient(null))).resolves.toBe(true);
  });

  it('false when the column is missing', async () => {
    await expect(isSourceRepoColumnAvailable(throwingClient(missingColumnError()))).resolves.toBe(
      false
    );
  });

  it('probes by a listing id that CANNOT exist, so it never depends on table contents', async () => {
    // The probe asks about the COLUMN, not a row. Keying it on a real id would make the
    // answer depend on whether that listing happened to exist.
    const db = okClient(null);
    await isSourceRepoColumnAvailable(db);
    const arg = (
      db.appListing.findUnique as unknown as { mock: { calls: [{ where: { id: string } }][] } }
    ).mock.calls[0][0];
    // `AppListing.id` is an `apl_<ULID>`; this cannot collide with one.
    expect(arg.where.id).not.toMatch(/^apl_/);
  });

  it('🔴 is NOT memoised — the column APPEARS partway through a deploy’s life', async () => {
    // A cached `false` would keep the feature inert until the process restarted, long
    // after a human applied the SQL. Two calls, two queries.
    const db = okClient(null);
    await isSourceRepoColumnAvailable(db);
    await isSourceRepoColumnAvailable(db);
    expect(db.appListing.findUnique).toHaveBeenCalledTimes(2);
  });
});

describe('sourceRepoWriteFragment — an unavailable column is OMITTED, never written as null', () => {
  it('emits the key when available', () => {
    expect(sourceRepoWriteFragment({ available: true, value: 'https://github.com/a/b' })).toEqual({
      sourceRepoUrl: 'https://github.com/a/b',
    });
  });

  it('emits an EXPLICIT null when available and unset (this is how a link is CLEARED)', () => {
    const frag = sourceRepoWriteFragment({ available: true, value: null });
    expect(frag).toEqual({ sourceRepoUrl: null });
    expect('sourceRepoUrl' in frag).toBe(true);
  });

  it('🔴 emits NOTHING when unavailable — `{sourceRepoUrl: null}` here would raise P2022', () => {
    const frag = sourceRepoWriteFragment({ available: false, value: null });
    expect(frag).toEqual({});
    // Asserted as key ABSENCE, not as an undefined value: `{sourceRepoUrl: undefined}`
    // still names the column in a Prisma payload in some code paths, and `toEqual`
    // treats it as equal to `{}`.
    expect('sourceRepoUrl' in frag).toBe(false);
  });

  it('🔴 the two null cases are DISTINGUISHABLE — the whole reason `available` exists', () => {
    // "the author removed the link" and "I could not read the column" both carry
    // value=null. If the fragment could not tell them apart, an unreadable column would
    // either clear every listing's link or make clearing impossible.
    const unset = sourceRepoWriteFragment({ available: true, value: null });
    const unreadable = sourceRepoWriteFragment({ available: false, value: null });
    expect(unset).not.toEqual(unreadable);
    expect(Object.keys(unset)).toEqual(['sourceRepoUrl']);
    expect(Object.keys(unreadable)).toEqual([]);
  });
});
