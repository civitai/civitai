import { TRPCError } from '@trpc/server';
import { describe, expect, it, vi } from 'vitest';

import {
  BETA_UNAVAILABLE_MESSAGE,
  assertBetaWritable,
  betaWriteFragment,
  isBetaColumnAvailable,
  readListingBeta,
  readListingBetaBySlug,
  readListingBetaMany,
  type BetaReadClient,
  type ListingBetaRead,
} from '~/server/services/blocks/app-listing-beta.service';

/**
 * The UNAPPLIED-MIGRATION posture for `app_listings.is_beta` / `beta_message`.
 *
 * 🔴 THE OUTAGE THIS PREVENTS, stated concretely: migrations in this repo are never
 * auto-applied. Between merging this change and a human running the SQL on the primary,
 * production runs code that names columns the database does not have. Prisma does NOT
 * return `undefined` for a missing column — it throws P2022, for the WHOLE query. So
 * `isBeta: true` inside `listingHydrateSelect` (which the public `/apps` GRID and the store
 * detail page share) would 500 both, turning an additive cosmetic label into an outage on a
 * public page.
 *
 * These tests exercise the degraded branch directly, with a client that throws the real
 * error shape — the only way to reach it without a database that is actually missing the
 * columns.
 *
 * 🔴 AND THEY CANNOT SEE THE REAL HAZARD, which is worth stating in the test file as well
 * as in the module: every suite here mocks Prisma, so none of them generates SQL. A query
 * that passes NO `select` names every scalar the MODEL declares regardless of anything in
 * this file. The migration is a hard PRE-DEPLOY step; this module is defence in depth.
 */

/** A Prisma-shaped "column does not exist" error. */
function missingColumnError(code = 'P2022'): Error {
  const err = new Error(
    'The column `app_listings.is_beta` does not exist in the current database.'
  ) as Error & { code?: string };
  err.code = code;
  return err;
}

/** An error this module must PROPAGATE rather than degrade on. */
function otherError(code: string, message: string): Error {
  const err = new Error(message) as Error & { code?: string };
  err.code = code;
  return err;
}

type Row = { isBeta: boolean; betaMessage: string | null };

/** A client whose reads resolve to `row` / `rows`. */
function okClient(row: Row | null, rows: Array<Row & { id: string }> = []): BetaReadClient {
  return {
    appListing: {
      findUnique: vi.fn(async () => row),
      findMany: vi.fn(async () => rows),
    },
  };
}

/** A client whose reads throw `err`. */
function throwingClient(err: unknown): BetaReadClient {
  return {
    appListing: {
      findUnique: vi.fn(async () => {
        throw err;
      }),
      findMany: vi.fn(async () => {
        throw err;
      }),
    },
  };
}

describe('readListingBeta — the AVAILABLE branch', () => {
  it('reports a listing that IS in beta, with its note', async () => {
    const read = await readListingBeta('apl_1', okClient({ isBeta: true, betaMessage: 'rough' }));
    expect(read).toEqual({ available: true, isBeta: true, betaMessage: 'rough' });
  });

  it('reports a listing that is NOT in beta as available — "no beta set" is not "unreadable"', async () => {
    const read = await readListingBeta('apl_1', okClient({ isBeta: false, betaMessage: null }));
    expect(read).toEqual({ available: true, isBeta: false, betaMessage: null });
  });

  it('a MISSING ROW is still `available: true` — the columns were readable, there was no row', async () => {
    // 🔴 THE POINT OF THIS CASE. `available` answers "can the schema be read?", never
    // "does this listing exist?". Conflating them would make a deleted listing look like an
    // unapplied migration and REFUSE writes across the whole feature.
    const read = await readListingBeta('apl_nope', okClient(null));
    expect(read).toEqual({ available: true, isBeta: false, betaMessage: null });
  });

  it('carries a beta flag with NO note — the note is optional, the label is not', async () => {
    const read = await readListingBeta('apl_1', okClient({ isBeta: true, betaMessage: null }));
    expect(read.isBeta).toBe(true);
    expect(read.betaMessage).toBeNull();
  });
});

describe('readListingBeta — the DEGRADED branch (unapplied migration)', () => {
  it.each([
    ['Prisma P2022', 'P2022'],
    ['Postgres 42703 (undefined_column)', '42703'],
  ])('degrades to available:false on %s', async (_label, code) => {
    const read = await readListingBeta('apl_1', throwingClient(missingColumnError(code)));
    expect(read).toEqual({ available: false, isBeta: false, betaMessage: null });
  });

  it('the degraded read is INDISTINGUISHABLE from "not beta" in its VALUES, and that is deliberate', async () => {
    const degraded = await readListingBeta('apl_1', throwingClient(missingColumnError()));
    const notBeta = await readListingBeta('apl_1', okClient({ isBeta: false, betaMessage: null }));
    // Same rendering, different licence to WRITE — which is exactly what `available` is for.
    expect(degraded.isBeta).toBe(notBeta.isBeta);
    expect(degraded.betaMessage).toBe(notBeta.betaMessage);
    expect(degraded.available).not.toBe(notBeta.available);
  });
});

describe('readListingBeta — errors that must PROPAGATE, never degrade', () => {
  /**
   * 🔴 THE WHOLE VALUE OF A NARROW GUARD IS IN THESE CASES. Degrading on a real outage
   * would convert it into a silently missing field — the failure mode this module exists to
   * avoid, arrived at from the other direction. Each of these is a DIFFERENT mechanism that
   * a message-substring guard, or a bare `catch { return unavailable }`, would swallow.
   */
  it.each([
    [
      'a missing TABLE (42P01) — a half-applied schema must surface',
      '42P01',
      'relation does not exist',
    ],
    ['a statement TIMEOUT', '57014', 'canceling statement due to statement timeout'],
    ['a PERMISSION error', '42501', 'permission denied for table app_listings'],
    ['a CONNECTION failure', 'P1001', "Can't reach database server"],
  ])('propagates %s', async (_label, code, message) => {
    const err = otherError(code, message);
    await expect(readListingBeta('apl_1', throwingClient(err))).rejects.toBe(err);
  });

  it('propagates an error with NO code at all (an unknown failure is not a missing column)', async () => {
    const err = new Error('boom');
    await expect(readListingBeta('apl_1', throwingClient(err))).rejects.toBe(err);
  });
});

describe('readListingBetaBySlug — the run page key', () => {
  it('resolves by slug and selects ONLY the two beta columns', async () => {
    const client = okClient({ isBeta: true, betaMessage: 'note' });
    const read = await readListingBetaBySlug('my-app', client);
    expect(read).toEqual({ available: true, isBeta: true, betaMessage: 'note' });
    expect(client.appListing.findUnique).toHaveBeenCalledWith({
      where: { slug: 'my-app' },
      select: { isBeta: true, betaMessage: true },
    });
  });

  it('FAILS OPEN on an unapplied migration — this key is on the app-LAUNCH path', async () => {
    // A throw here does not degrade a badge; it 500s the page that runs the app.
    const read = await readListingBetaBySlug('my-app', throwingClient(missingColumnError()));
    expect(read.available).toBe(false);
    expect(read.isBeta).toBe(false);
  });

  it('a slug with NO listing row resolves to not-beta rather than throwing', async () => {
    // The run page resolves its app out of `app_blocks`; a block with no store listing is a
    // perfectly ordinary state and must not take the launch down.
    expect((await readListingBetaBySlug('orphan', okClient(null))).isBeta).toBe(false);
  });
});

describe('readListingBetaMany — the page-at-a-time reads', () => {
  it('keys the map by listing id', async () => {
    const map = await readListingBetaMany(
      ['a', 'b'],
      okClient(null, [
        { id: 'a', isBeta: true, betaMessage: 'x' },
        { id: 'b', isBeta: false, betaMessage: null },
      ])
    );
    expect(map.get('a')).toEqual({ available: true, isBeta: true, betaMessage: 'x' });
    expect(map.get('b')).toEqual({ available: true, isBeta: false, betaMessage: null });
  });

  it('issues NO query for an empty page', async () => {
    const client = okClient(null, []);
    expect((await readListingBetaMany([], client)).size).toBe(0);
    expect(client.appListing.findMany).not.toHaveBeenCalled();
  });

  it('degrades to an EMPTY map on an unapplied migration — every card renders as not-beta', async () => {
    const map = await readListingBetaMany(['a'], throwingClient(missingColumnError('42703')));
    expect(map.size).toBe(0);
  });

  it('propagates a non-missing-column error', async () => {
    const err = otherError('42P01', 'relation does not exist');
    await expect(readListingBetaMany(['a'], throwingClient(err))).rejects.toBe(err);
  });

  it('a requested id with no returned row is simply absent — callers default it to not-beta', async () => {
    const map = await readListingBetaMany(
      ['a', 'gone'],
      okClient(null, [{ id: 'a', isBeta: true, betaMessage: null }])
    );
    expect(map.has('gone')).toBe(false);
  });
});

describe('isBetaColumnAvailable — the column probe', () => {
  it('is TRUE when the columns read (even though the probe id matches no row)', async () => {
    expect(await isBetaColumnAvailable(okClient(null))).toBe(true);
  });

  it('is FALSE when the columns are missing', async () => {
    expect(await isBetaColumnAvailable(throwingClient(missingColumnError()))).toBe(false);
  });

  it('is NOT memoised — the columns appear partway through a deploy', async () => {
    // A cached `false` would keep the feature inert until the next process restart, which is
    // precisely the window this whole module is written for.
    const flaky: BetaReadClient = {
      appListing: {
        findUnique: vi.fn().mockRejectedValueOnce(missingColumnError()).mockResolvedValueOnce(null),
        findMany: vi.fn(async () => []),
      },
    };
    expect(await isBetaColumnAvailable(flaky)).toBe(false);
    expect(await isBetaColumnAvailable(flaky)).toBe(true);
  });
});

describe('betaWriteFragment — the SYSTEM-originated write', () => {
  it('emits both keys when the columns are available', () => {
    expect(betaWriteFragment({ available: true, isBeta: true, betaMessage: 'x' })).toEqual({
      isBeta: true,
      betaMessage: 'x',
    });
  });

  it('emits an EMPTY object when they are not — the keys must be OMITTED, not defaulted', () => {
    // 🔴 THE ASSERTION THAT MATTERS. Writing `{isBeta:false}` against a missing column
    // raises the same P2022 and rolls back the surrounding transaction, so a feature that
    // is merely inert would instead break the pre-existing flow it rides along with.
    const fragment = betaWriteFragment({ available: false, isBeta: false, betaMessage: null });
    expect(fragment).toEqual({});
    expect(Object.keys(fragment)).toHaveLength(0);
    expect('isBeta' in fragment).toBe(false);
    expect('betaMessage' in fragment).toBe(false);
  });

  it('emits `isBeta: false` explicitly when the columns ARE available and beta is off', () => {
    // The positive control for the case above: "off" and "unreadable" produce DIFFERENT
    // fragments, so a mutant that returns `{}` unconditionally is killed here rather than
    // passing because both arms looked empty.
    expect(betaWriteFragment({ available: true, isBeta: false, betaMessage: null })).toEqual({
      isBeta: false,
      betaMessage: null,
    });
  });
});

describe('assertBetaWritable — the AUTHOR-originated write', () => {
  it('passes when the columns are available', () => {
    expect(() => assertBetaWritable(true)).not.toThrow();
  });

  it('throws PRECONDITION_FAILED with the EXACT exported message', () => {
    // 🔴 THE EXACT STRING AND THE EXACT CODE, both asserted. A mutant that swaps this guard
    // for a `BAD_REQUEST`, or for the source-repo guard's refusal, still throws — so
    // "something threw" would pass it. The code is also what distinguishes this refusal
    // from the validator's rejection of an over-long message, which is the one mutation
    // that would otherwise go unnoticed.
    let caught: unknown;
    try {
      assertBetaWritable(false);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(TRPCError);
    expect((caught as TRPCError).code).toBe('PRECONDITION_FAILED');
    expect((caught as TRPCError).message).toBe(BETA_UNAVAILABLE_MESSAGE);
  });

  it('refuses a non-boolean-true value — fail CLOSED', () => {
    // A refusal an author can act on beats a 500 they cannot. `=== true` rather than
    // truthiness, so an `undefined` threaded in from a call site that forgot the flag
    // refuses rather than writing.
    expect(() => assertBetaWritable(undefined as unknown as boolean)).toThrow(TRPCError);
  });
});

describe('the two write helpers are NOT interchangeable', () => {
  /**
   * 🔴 THIS IS THE SEAM, and it is the one a future maintainer is most likely to collapse:
   * both helpers answer "may I write?", so reaching for whichever is nearer looks harmless.
   * Using the omit-fragment on an AUTHOR write reports success while the author's value
   * silently vanishes; using the assert on a SYSTEM write turns an unapplied migration into
   * a hard failure of a pre-existing flow (opening a revision). Pinned as a relationship —
   * on the SAME unavailable input the two must disagree, one silently, one loudly.
   */
  const unavailable: ListingBetaRead = { available: false, isBeta: false, betaMessage: null };

  it('the system helper is SILENT and the author helper is LOUD on the same input', () => {
    expect(betaWriteFragment(unavailable)).toEqual({});
    expect(() => assertBetaWritable(unavailable.available)).toThrow(TRPCError);
  });
});
