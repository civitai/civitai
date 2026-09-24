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
  IMAGE_REACTOR_TYPES,
  IMAGE_REACTORS_LIMIT,
  safeProfilePicture,
} from '~/server/services/image-reactors.service';

const OWNER = 100;
const STRANGER = 7;
const IMAGE_ID = 555;
const OTHER_IMAGE_ID = 556;

type Row = { userId: number; reaction: string };

/**
 * Answers the two reads the way Postgres would. The image read resolves the owner from `where.id`, so the ownership
 * decision is made by the code under test, not by the fake. The reaction read binds `"imageId" =` from the SQL and
 * returns rows only for that image, so a query that loses or misbinds its image filter returns another image's
 * reactors and the tests below see them.
 */
function installFakeDb(rowsByImage: Record<number, Row[]>) {
  const reactionReads: { text: string; imageId: unknown; filter: unknown; limit: unknown }[] = [];

  dbMock.dbRead.image.findUnique.mockImplementation(async ({ where }: { where: { id: number } }) =>
    where.id === IMAGE_ID || where.id === OTHER_IMAGE_ID ? { userId: OWNER } : null
  );

  dbMock.dbRead.$queryRaw.mockImplementation(
    async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const text = strings.join('?');
      let imageId: unknown;
      let filter: unknown;
      strings.forEach((s, i) => {
        if (/"imageId" = $/.test(s)) imageId = values[i];
        if (/reaction::text IN \($/.test(s)) filter = values[i];
      });
      reactionReads.push({ text, imageId, filter, limit: values.at(-1) });
      if (typeof imageId !== 'number') return Object.values(rowsByImage).flat();
      return rowsByImage[imageId] ?? [];
    }
  );
  return { reactionReads };
}

const stranger = () => installFakeDb({ [IMAGE_ID]: [{ userId: 1, reaction: 'Like' }] });

beforeEach(() => {
  vi.clearAllMocks();
  dbMock.dbRead.user.findUnique.mockResolvedValue(null);
  getBasicDataForUsers.mockResolvedValue({});
  getProfilePicturesForUsers.mockResolvedValue({});
});

describe('getImageReactors — owner only', () => {
  it('refuses a non-owner with NOT_FOUND before reading any reaction', async () => {
    const { reactionReads } = stranger();

    await expect(getImageReactors({ imageId: IMAGE_ID, userId: STRANGER })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    expect(reactionReads).toEqual([]);
    expect(getBasicDataForUsers).not.toHaveBeenCalled();
  });

  it('refuses a moderator who is not the owner: reactor identities are the owner’s alone', async () => {
    const { reactionReads } = stranger();
    dbMock.dbRead.user.findUnique.mockResolvedValue({ isModerator: true });

    await expect(getImageReactors({ imageId: IMAGE_ID, userId: STRANGER })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    expect(reactionReads).toEqual([]);
  });

  it('refuses a missing image the same way as someone else’s', async () => {
    installFakeDb({});
    await expect(getImageReactors({ imageId: 999, userId: OWNER })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });

  it('returns the owner the reactors of THIS image only, with names and safe pictures', async () => {
    const { reactionReads } = installFakeDb({
      [IMAGE_ID]: [
        { userId: 30, reaction: 'Like' },
        { userId: 30, reaction: 'Heart' },
        { userId: 20, reaction: 'Cry' },
      ],
      [OTHER_IMAGE_ID]: [{ userId: 99, reaction: 'Like' }],
    });
    const picture = { id: 9, url: 'pic', ingestion: 'Scanned', nsfwLevel: 1 };
    getBasicDataForUsers.mockResolvedValue({
      30: { id: 30, username: 'reactor-a', deletedAt: null, image: null },
      20: { id: 20, username: 'reactor-b', deletedAt: null, image: null },
    });
    getProfilePicturesForUsers.mockResolvedValue({ 30: picture });

    expect(await getImageReactors({ imageId: IMAGE_ID, userId: OWNER })).toEqual([
      {
        userId: 30,
        reactions: ['Like', 'Heart'],
        username: 'reactor-a',
        deletedAt: null,
        profilePicture: picture,
      },
      {
        userId: 20,
        reactions: ['Cry'],
        username: 'reactor-b',
        deletedAt: null,
        profilePicture: null,
      },
    ]);
    expect(reactionReads.map((r) => r.imageId)).toEqual([IMAGE_ID]);
    expect(getBasicDataForUsers).toHaveBeenCalledTimes(1);
    expect(getBasicDataForUsers).toHaveBeenCalledWith([30, 20]);
    expect(getProfilePicturesForUsers).toHaveBeenCalledTimes(1);
    expect(getProfilePicturesForUsers).toHaveBeenCalledWith([30, 20]);
  });

  it('hides the name and picture of a deleted reactor, and of one with no user row', async () => {
    const deletedAt = new Date('2026-01-01');
    installFakeDb({
      [IMAGE_ID]: [
        { userId: 30, reaction: 'Like' },
        { userId: 20, reaction: 'Heart' },
      ],
    });
    getBasicDataForUsers.mockResolvedValue({
      30: { id: 30, username: 'was-here', deletedAt, image: null },
    });
    const picture = { id: 9, url: 'pic', ingestion: 'Scanned', nsfwLevel: 1 };
    getProfilePicturesForUsers.mockResolvedValue({ 30: picture, 20: picture });

    expect(await getImageReactors({ imageId: IMAGE_ID, userId: OWNER })).toEqual([
      { userId: 30, reactions: ['Like'], username: null, deletedAt, profilePicture: null },
      { userId: 20, reactions: ['Heart'], username: null, deletedAt: null, profilePicture: null },
    ]);
  });

  it('sends no picture that is unscanned or above a safe level', async () => {
    installFakeDb({
      [IMAGE_ID]: [
        { userId: 30, reaction: 'Like' },
        { userId: 20, reaction: 'Like' },
      ],
    });
    getBasicDataForUsers.mockResolvedValue({
      30: { id: 30, username: 'a', deletedAt: null, image: null },
      20: { id: 20, username: 'b', deletedAt: null, image: null },
    });
    getProfilePicturesForUsers.mockResolvedValue({
      30: { id: 1, url: 'r-rated', ingestion: 'Scanned', nsfwLevel: 4 },
      20: { id: 2, url: 'unscanned', ingestion: 'Pending', nsfwLevel: 0 },
    });

    const result = await getImageReactors({ imageId: IMAGE_ID, userId: OWNER });
    expect(result.map((r) => r.profilePicture)).toEqual([null, null]);
  });
});

// Newest accounts first is a measured decision, not an oversight: ordering by reaction time has no covering index
// and read all 36k reactions of the most-reacted image (3.4 s cold) against 1.0 ms for this. Do not "fix" it to
// createdAt without adding an index.
describe('getImageReactors — newest accounts first, bounded', () => {
  it('orders by userId descending with a fixed LIMIT, never by reaction time', async () => {
    const { reactionReads } = installFakeDb({});
    await getImageReactors({ imageId: IMAGE_ID, userId: OWNER });

    expect(reactionReads).toHaveLength(1);
    const sql = reactionReads[0].text.replace(/\s+/g, ' ');
    expect(sql).toMatch(/ORDER BY "userId" DESC LIMIT \?\s*$/);
    expect(sql).not.toMatch(/createdAt/);
    // One row per reaction type per user, so this is exactly enough to complete the last user kept.
    expect(reactionReads[0].limit).toBe(IMAGE_REACTORS_LIMIT * 4);
  });

  it('filters to the four live reaction types, which leaves Dislike out', async () => {
    const { reactionReads } = installFakeDb({});
    await getImageReactors({ imageId: IMAGE_ID, userId: OWNER });

    const filter = reactionReads[0].filter;
    expect((filter as { values?: unknown[] } | undefined)?.values).toEqual([
      'Like',
      'Heart',
      'Laugh',
      'Cry',
    ]);
    expect(IMAGE_REACTOR_TYPES).not.toContain('Dislike');
  });
});

describe('safeProfilePicture', () => {
  const pic = (ingestion: string, nsfwLevel: number) =>
    ({ id: 1, url: 'u', ingestion, nsfwLevel } as Parameters<typeof safeProfilePicture>[0]);

  it.each([
    ['scanned PG', pic('Scanned', 1), true],
    ['scanned PG-13', pic('Scanned', 2), true],
    ['scanned R', pic('Scanned', 4), false],
    ['scanned PG with an R bit', pic('Scanned', 1 | 4), false],
    ['scanned but unrated', pic('Scanned', 0), false],
    ['pending', pic('Pending', 1), false],
    ['blocked', pic('Blocked', 1), false],
    ['none', null, false],
  ])('%s -> kept: %s', (_, picture, kept) => {
    expect(safeProfilePicture(picture)).toBe(kept ? picture : null);
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
