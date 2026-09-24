import { beforeEach, describe, expect, it, vi } from 'vitest';

const { getBasicDataForUsers, getProfilePicturesForUsers } = vi.hoisted(() => ({
  getBasicDataForUsers: vi.fn(async (..._a: unknown[]): Promise<Record<number, unknown>> => ({})),
  getProfilePicturesForUsers: vi.fn(
    async (..._a: unknown[]): Promise<Record<number, unknown>> => ({})
  ),
}));

vi.mock('~/server/services/user.service', () => ({
  getBasicDataForUsers,
  getProfilePicturesForUsers,
}));

import { dbMock } from '~/__tests__/mocks/db.mock';
import {
  getImageReactors,
  groupReactorRows,
  IMAGE_REACTORS_LIMIT,
} from '~/server/services/image-reactors.service';

const OWNER = 100;
const STRANGER = 7;
const IMAGE_ID = 555;

type Row = { userId: number; reaction: string };

/**
 * A fake that answers the ownership read the way Postgres would: it binds `id =` and `"userId" =` from the SQL it is
 * handed, so dropping the owner clause from the query makes a stranger's call return the image and the refusal
 * tests go red. A fake that just returned [] for strangers would pass with no owner check at all.
 */
function installFakeDb(reactionRows: Row[]) {
  const reactionQueries: string[] = [];
  const reactionLimits: unknown[] = [];
  dbMock.dbRead.$queryRaw.mockImplementation(
    async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const text = strings.join('?');
      if (/FROM "Image"/.test(text)) {
        let id: unknown;
        let userId: unknown;
        strings.forEach((s, i) => {
          if (/(^|\s)id = $/.test(s)) id = values[i];
          if (/"userId" = $/.test(s)) userId = values[i];
        });
        const matches = id === IMAGE_ID && (userId === undefined || userId === OWNER);
        return matches ? [{ id: IMAGE_ID }] : [];
      }
      reactionQueries.push(text);
      reactionLimits.push(values.at(-1));
      return reactionRows;
    }
  );
  return { reactionQueries, reactionLimits };
}

beforeEach(() => {
  vi.clearAllMocks();
  getBasicDataForUsers.mockResolvedValue({});
  getProfilePicturesForUsers.mockResolvedValue({});
});

describe('getImageReactors — owner only', () => {
  it('refuses a non-owner with NOT_FOUND before reading any reaction', async () => {
    const { reactionQueries } = installFakeDb([{ userId: 1, reaction: 'Like' }]);

    await expect(getImageReactors({ imageId: IMAGE_ID, userId: STRANGER })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    expect(reactionQueries).toEqual([]);
    expect(getBasicDataForUsers).not.toHaveBeenCalled();
  });

  it('refuses a missing image the same way as someone else’s', async () => {
    installFakeDb([]);
    await expect(getImageReactors({ imageId: 999, userId: OWNER })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });

  it('returns the owner their reactors with names and pictures', async () => {
    installFakeDb([
      { userId: 30, reaction: 'Like' },
      { userId: 30, reaction: 'Heart' },
      { userId: 20, reaction: 'Cry' },
    ]);
    getBasicDataForUsers.mockResolvedValue({
      30: { id: 30, username: 'reactor-a', deletedAt: null, image: null },
      20: { id: 20, username: 'reactor-b', deletedAt: null, image: null },
    });
    getProfilePicturesForUsers.mockResolvedValue({ 30: { id: 9, url: 'pic' } });

    expect(await getImageReactors({ imageId: IMAGE_ID, userId: OWNER })).toEqual([
      {
        userId: 30,
        reactions: ['Like', 'Heart'],
        username: 'reactor-a',
        deletedAt: null,
        profilePicture: { id: 9, url: 'pic' },
      },
      {
        userId: 20,
        reactions: ['Cry'],
        username: 'reactor-b',
        deletedAt: null,
        profilePicture: null,
      },
    ]);
  });

  it('hides the name and picture of a deleted reactor', async () => {
    const deletedAt = new Date('2026-01-01');
    installFakeDb([{ userId: 30, reaction: 'Like' }]);
    getBasicDataForUsers.mockResolvedValue({
      30: { id: 30, username: 'was-here', deletedAt, image: null },
    });
    getProfilePicturesForUsers.mockResolvedValue({ 30: { id: 9, url: 'pic' } });

    expect(await getImageReactors({ imageId: IMAGE_ID, userId: OWNER })).toEqual([
      { userId: 30, reactions: ['Like'], username: null, deletedAt, profilePicture: null },
    ]);
  });
});

// Newest accounts first is a measured decision, not an oversight: ordering by reaction time has no covering index
// and read all 36k reactions of the most-reacted image (3.4 s cold) against 1.5 ms for this. Do not "fix" it to
// createdAt without adding an index.
describe('getImageReactors — newest accounts first, bounded', () => {
  it('orders by userId descending with a fixed LIMIT, never by reaction time', async () => {
    const { reactionQueries, reactionLimits } = installFakeDb([]);
    await getImageReactors({ imageId: IMAGE_ID, userId: OWNER });

    expect(reactionQueries).toHaveLength(1);
    const sql = reactionQueries[0].replace(/\s+/g, ' ');
    expect(sql).toMatch(/ORDER BY "userId" DESC LIMIT \?\s*$/);
    expect(sql).not.toMatch(/createdAt/);
    // One row per reaction type per user, so this is exactly enough to complete the last user kept.
    expect(reactionLimits).toEqual([IMAGE_REACTORS_LIMIT * 4]);
  });
});

describe('groupReactorRows', () => {
  it('keeps at most the limit of distinct users, in row order', () => {
    const rows = Array.from({ length: 15 }, (_, i) => ({
      userId: 100 - i,
      reaction: 'Like' as const,
    }));
    const grouped = groupReactorRows(rows);
    expect(grouped.map((r) => r.userId)).toEqual(
      Array.from({ length: IMAGE_REACTORS_LIMIT }, (_, i) => 100 - i)
    );
  });

  it('keeps every reaction of a kept user, and none of a user past the limit', () => {
    const grouped = groupReactorRows(
      [
        { userId: 9, reaction: 'Like' },
        { userId: 8, reaction: 'Heart' },
        { userId: 8, reaction: 'Cry' },
        { userId: 7, reaction: 'Laugh' },
      ],
      2
    );
    expect(grouped).toEqual([
      { userId: 9, reactions: ['Like'] },
      { userId: 8, reactions: ['Heart', 'Cry'] },
    ]);
  });
});
