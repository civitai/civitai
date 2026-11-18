import { describe, expect, it, vi } from 'vitest';
import { TRPCError } from '@trpc/server';

import {
  assertIssueTrackerWritable,
  isIssueTrackerColumnAvailable,
  readListingIssueTrackerUrl,
  readListingIssueTrackerUrlForRender,
  readListingIssueTrackerUrlsForRender,
  readListingProblemLinkMaps,
  resolveIssueTrackerPatch,
  writeIssueTrackerBestEffort,
  writeListingIssueTrackerUrl,
} from '~/server/services/blocks/app-listing-issue-tracker.service';

/**
 * The MISSING-COLUMN FALLBACK for `app_listings.issue_tracker_url`.
 *
 * The column is manual-apply and no-type (raw SQL only), so between the deploy and the human who
 * runs the SQL every read raises 42703 / P2022. These cases drive that state with throwing fakes —
 * the only way to reach it without a database missing a real column — and pin the three states
 * the module exists to keep apart: column absent, column present and empty, column present and set.
 */

const TRACKER = 'https://tracker-4471.example.test/issues';

/** Postgres `undefined_column`, as `$queryRaw` raises it. */
const missingColumn = () =>
  Object.assign(new Error('column "issue_tracker_url" does not exist'), { code: '42703' });
/** Prisma's spelling of the same thing. */
const missingColumnPrisma = () =>
  Object.assign(new Error('The column `issue_tracker_url` does not exist'), { code: 'P2022' });
/** Anything else — a connection failure must NOT be read as "no column". */
const connectionLost = () =>
  Object.assign(new Error('Connection terminated unexpectedly'), { code: 'P1001' });

const reads = (impl: () => Promise<unknown>) => ({ $queryRaw: vi.fn(impl) });

describe('readListingIssueTrackerUrl', () => {
  it('column present, link set → available + the value', async () => {
    const db = reads(async () => [{ issueTrackerUrl: TRACKER }]);
    expect(await readListingIssueTrackerUrl('apl_1', db)).toEqual({
      available: true,
      value: TRACKER,
    });
    expect(db.$queryRaw).toHaveBeenCalledTimes(1);
  });

  it('column present, no link → available + null (NOT the unavailable state)', async () => {
    expect(
      await readListingIssueTrackerUrl(
        'apl_1',
        reads(async () => [{ issueTrackerUrl: null }])
      )
    ).toEqual({ available: true, value: null });
    // A listing id with no row: the column was readable, there was simply nothing to read.
    expect(
      await readListingIssueTrackerUrl(
        'apl_1',
        reads(async () => [])
      )
    ).toEqual({
      available: true,
      value: null,
    });
  });

  it.each([
    ['42703', missingColumn],
    ['P2022', missingColumnPrisma],
  ])('🔴 column MISSING (%s) → unavailable, never throws', async (_code, err) => {
    expect(
      await readListingIssueTrackerUrl(
        'apl_1',
        reads(async () => {
          throw err();
        })
      )
    ).toEqual({ available: false, value: null });
  });

  it('🔴 any OTHER error propagates — an outage is not a missing column', async () => {
    await expect(
      readListingIssueTrackerUrl(
        'apl_1',
        reads(async () => {
          throw connectionLost();
        })
      )
    ).rejects.toThrow('Connection terminated');
  });
});

describe('readListingIssueTrackerUrlForRender (store page / preview / edit prefill)', () => {
  it('degrades ANY error to unavailable rather than failing the page', async () => {
    expect(
      await readListingIssueTrackerUrlForRender(
        'apl_1',
        reads(async () => {
          throw connectionLost();
        })
      )
    ).toEqual({ available: false, value: null });
  });

  it('still returns the stored value when the read works', async () => {
    expect(
      await readListingIssueTrackerUrlForRender(
        'apl_1',
        reads(async () => [{ issueTrackerUrl: TRACKER }])
      )
    ).toEqual({ available: true, value: TRACKER });
  });
});

describe('isIssueTrackerColumnAvailable', () => {
  it('true when the probe reads (even with no row)', async () => {
    expect(await isIssueTrackerColumnAvailable(reads(async () => []))).toBe(true);
  });

  it('🔴 false when the column is missing — the transactional callers then never name it', async () => {
    expect(
      await isIssueTrackerColumnAvailable(
        reads(async () => {
          throw missingColumn();
        })
      )
    ).toBe(false);
  });

  it('🔴 any OTHER error PROPAGATES — a transient fault is not "no column"', async () => {
    // Read as "unavailable", the transactional callers would skip the column and silently
    // drop or clear a link; propagating fails the operation instead (as the source-repo probe does).
    await expect(
      isIssueTrackerColumnAvailable(
        reads(async () => {
          throw connectionLost();
        })
      )
    ).rejects.toThrow('Connection terminated');
  });
});

describe('readListingIssueTrackerUrlsForRender / readListingProblemLinkMaps', () => {
  it('maps every returned row; a listing absent from the result is ABSENT from the map', async () => {
    const map = await readListingIssueTrackerUrlsForRender(
      ['apl_a', 'apl_b', 'apl_c'],
      reads(async () => [
        { id: 'apl_a', issueTrackerUrl: TRACKER },
        { id: 'apl_b', issueTrackerUrl: null },
      ])
    );
    expect(map.get('apl_a')).toBe(TRACKER);
    expect(map.has('apl_b')).toBe(true);
    expect(map.get('apl_b')).toBeNull();
    expect(map.has('apl_c')).toBe(false);
  });

  it('🔴 a missing column yields an EMPTY map (every link unknown), not a map of nulls', async () => {
    const map = await readListingIssueTrackerUrlsForRender(
      ['apl_a'],
      reads(async () => {
        throw missingColumn();
      })
    );
    expect(map.size).toBe(0);
  });

  it('issues no query for an empty page', async () => {
    const db = reads(async () => []);
    expect((await readListingIssueTrackerUrlsForRender([], db)).size).toBe(0);
    expect(db.$queryRaw).not.toHaveBeenCalled();
  });

  it('readListingProblemLinkMaps: each column degrades INDEPENDENTLY', async () => {
    // Source column present, issue-tracker column missing — two migrations, applied apart.
    const db = {
      // A tagged-template call: the first argument is the static strings array.
      $queryRaw: vi.fn(async (strings: readonly string[]) => {
        const text = strings.join('?');
        if (text.includes('issue_tracker_url')) throw missingColumn();
        return [{ id: 'apl_a', sourceRepoUrl: 'https://github.com/o/r' }];
      }),
    };
    const maps = await readListingProblemLinkMaps(['apl_a'], db);
    expect(maps.sourceRepoUrls.get('apl_a')).toBe('https://github.com/o/r');
    expect(maps.issueTrackerUrls.size).toBe(0);
  });
});

describe('author writes: assertIssueTrackerWritable / resolveIssueTrackerPatch', () => {
  const REFUSAL =
    'The issue tracker link is not available on this environment yet. Leave the field empty and try again later.';

  it('refuses with PRECONDITION_FAILED and the exact message when the column is absent', () => {
    try {
      assertIssueTrackerWritable(false);
      expect.unreachable('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(TRPCError);
      expect((e as TRPCError).code).toBe('PRECONDITION_FAILED');
      expect((e as TRPCError).message).toBe(REFUSAL);
    }
    expect(() => assertIssueTrackerWritable(true)).not.toThrow();
  });

  it('OMITTED → no write, and no refusal even while the column is absent', () => {
    expect(resolveIssueTrackerPatch(undefined, false)).toEqual({ write: false });
  });

  it('🔴 an explicit CLEAR is refused while the column is absent (it is a write too)', () => {
    expect(() => resolveIssueTrackerPatch(null, false)).toThrow(REFUSAL);
    expect(resolveIssueTrackerPatch(null, true)).toEqual({ write: true, value: null });
  });

  it('a value is validated and NORMALISED; a bad one is BAD_REQUEST, not PRECONDITION_FAILED', () => {
    expect(resolveIssueTrackerPatch('  https://EXAMPLE.com/bugs ', true)).toEqual({
      write: true,
      value: 'https://example.com/bugs',
    });
    try {
      resolveIssueTrackerPatch('http://example.com/bugs', true);
      expect.unreachable('should have thrown');
    } catch (e) {
      expect((e as TRPCError).code).toBe('BAD_REQUEST');
    }
  });
});

describe('writes', () => {
  it('writeListingIssueTrackerUrl issues one UPDATE naming the column, with the value bound', async () => {
    const db = { $executeRaw: vi.fn(async () => 1) };
    expect(await writeListingIssueTrackerUrl(db, 'apl_9', TRACKER)).toBe(1);
    expect(db.$executeRaw).toHaveBeenCalledTimes(1);
    const [strings, ...values] = db.$executeRaw.mock.calls[0] as unknown as [
      string[],
      ...unknown[]
    ];
    expect(strings.join('?')).toContain('"issue_tracker_url"');
    expect(values).toEqual([TRACKER, 'apl_9']);
  });

  it('writeIssueTrackerBestEffort swallows (and logs) a failure', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await expect(
      writeIssueTrackerBestEffort('test', async () => {
        throw new Error('boom');
      })
    ).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });
});
