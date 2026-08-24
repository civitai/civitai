import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * `RatingChanges` is Retool's rating audit trail, and the two writes that fill it were reconstructed
 * from the app export rather than from the audit notes — which had two facts wrong. These cases pin the
 * corrected ones, because both are invisible at runtime: a wrong `originalRating` or an extra row per
 * change still writes successfully and still reads back as an audit trail.
 */

const calls: string[] = [];
let updatedRows = 0;

/** Records which chain ran rather than resolving a fixture: "did it UPDATE first, and INSERT only when
 *  the update matched nothing" is the whole assertion, and a fake that answers from a variable cannot
 *  see the difference. */
const moderatorDb = {
  updateTable: (table: string) => {
    calls.push(`update:${table}`);
    const chain = {
      set: (values: Record<string, unknown>) => {
        calls.push(`set:${Object.keys(values).sort().join(',')}`);
        return chain;
      },
      where: (col: string, op: string, val: unknown) => {
        calls.push(`where:${col}${op}${val}`);
        return chain;
      },
      executeTakeFirst: async () => ({ numUpdatedRows: BigInt(updatedRows) }),
    };
    return chain;
  },
  insertInto: (table: string) => {
    calls.push(`insert:${table}`);
    const chain = {
      values: (values: Record<string, unknown>) => {
        calls.push(`values:${JSON.stringify(values)}`);
        return chain;
      },
      execute: async () => [],
    };
    return chain;
  },
};

vi.mock('$lib/server/moderator-db', () => ({ getModeratorDb: () => moderatorDb }));
vi.mock('$lib/server/db', () => ({ dbRead: {}, dbWrite: {} }));
vi.mock('$lib/server/user-actions.service', () => ({ voteOnImageTags: vi.fn() }));

const { recordRatingChange, recordTagVoteRatingChange } = await import(
  '../front-page-audit.service'
);

beforeEach(() => {
  calls.length = 0;
  updatedRows = 0;
});

describe('recordRatingChange — Retool’s LogNsfwLevel', () => {
  it('updates the image’s existing row rather than adding a second', async () => {
    updatedRows = 1;
    await recordRatingChange({ imageId: 7, originalRating: 4, rating: 16, updatedBy: 'mod' });

    // The audit notes recorded this as a plain INSERT. The export says UPDATE_OR_INSERT_BY, so a
    // regression here silently turns one row per image into one row per rating change.
    expect(calls).toContain('update:RatingChanges');
    expect(calls).toContain('where:imageId=7');
    expect(calls.some((c) => c.startsWith('insert:'))).toBe(false);
  });

  it('inserts when the image has no row yet', async () => {
    updatedRows = 0;
    await recordRatingChange({ imageId: 7, originalRating: 4, rating: 16, updatedBy: 'mod' });

    expect(calls).toContain('insert:RatingChanges');
    expect(calls).toContain(
      `values:${JSON.stringify({ imageId: 7, originalRating: 4, rating: 16, updatedBy: 'mod' })}`
    );
  });

  it('swallows a failure rather than failing the rating that already committed', async () => {
    updatedRows = 0;
    const boom = vi.spyOn(console, 'error').mockImplementation(() => {});
    const original = moderatorDb.updateTable;
    moderatorDb.updateTable = () => {
      throw new Error('moderator db down');
    };

    await expect(
      recordRatingChange({ imageId: 1, originalRating: 1, rating: 2, updatedBy: null })
    ).resolves.toBeUndefined();

    moderatorDb.updateTable = original;
    boom.mockRestore();
  });
});

describe('recordTagVoteRatingChange — Retool’s LogNsfwLevel2', () => {
  it('records the TAG’s level, not the image’s', async () => {
    updatedRows = 0;
    await recordTagVoteRatingChange({
      imageId: 9,
      originalRating: 1,
      tagNsfwLevel: 8,
      direction: 'up',
      updatedBy: 'mod',
    });

    expect(calls).toContain(
      `values:${JSON.stringify({ imageId: 9, originalRating: 1, rating: 8, updatedBy: 'mod' })}`
    );
  });

  it('writes nothing on a downvote — additions only', async () => {
    // Retool disabled the query on `vote === -10`. Dropping that rule would record a rating for a tag
    // the moderator just took OFF the image, which is the opposite of what happened.
    await recordTagVoteRatingChange({
      imageId: 9,
      originalRating: 1,
      tagNsfwLevel: 8,
      direction: 'down',
      updatedBy: 'mod',
    });

    expect(calls).toEqual([]);
  });

  it('writes nothing when the tag has no level of its own', async () => {
    await recordTagVoteRatingChange({
      imageId: 9,
      originalRating: 1,
      tagNsfwLevel: null,
      direction: 'up',
      updatedBy: 'mod',
    });

    expect(calls).toEqual([]);
  });
});
