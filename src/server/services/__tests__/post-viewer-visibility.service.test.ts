import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { NsfwLevel } from '~/server/common/enums';

const mocks = vi.hoisted(() => ({
  getPostDetail: vi.fn(async (..._a: unknown[]): Promise<unknown> => undefined),
  amIBlockedByUser: vi.fn(async (..._a: unknown[]) => false),
}));

vi.mock('~/server/services/post.service', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getPostDetail: mocks.getPostDetail,
}));
vi.mock('~/server/services/user.service', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  amIBlockedByUser: mocks.amIBlockedByUser,
}));
vi.mock('~/server/services/blocks/post-app-chip.service', () => ({
  readPostAppChip: vi.fn(async () => null),
}));

import { getPostHandler } from '~/server/controllers/post.controller';
import { assertPostTextVisible } from '~/server/services/post-viewer-visibility.service';

const POST = 31;
const AUTHOR = 5;
const TEXT = 900;
const member = { id: 77, isModerator: false, browsingLevel: 31, showNsfw: true };
const author = { ...member, id: AUTHOR };
const moderator = { ...member, isModerator: true };

const ctx = (user: unknown, over: Record<string, unknown> = {}) =>
  ({
    user,
    features: { canViewNsfw: true, storylineText: true },
    req: { headers: { host: 'civitai.com' } },
    ...over,
  } as never);

type Row = { refused: boolean; csamHeld: boolean; nsfwLevel: number };
const scanned: Row = { refused: false, csamHeld: false, nsfwLevel: NsfwLevel.PG };
/**
 * What the primary decides: `hidden` is its one-snapshot verdict on the row flags and the csam hold.
 * The gate's statement is a Prisma.Sql; the reader's hidden-ids read is a tagged template.
 */
const sqlOf = (first: unknown) =>
  JSON.stringify(first && typeof first === 'object' && 'sql' in first ? first.sql : first);
const givenPrimary = (row: { nsfwLevel: number; hidden: boolean } | null) =>
  dbMock.dbWrite.$queryRaw.mockImplementation(((first: unknown) => {
    if (!row) return Promise.resolve([]);
    // The gate's statement selects `AS hidden`; the reader's asks for the hidden ids.
    const gate = sqlOf(first).includes('AS hidden');
    return Promise.resolve(gate ? [{ postId: POST, ...row }] : row.hidden ? [{ id: TEXT }] : []);
  }) as never);
/** A text as the replica shows it, and the primary agreeing with it. */
const givenText = (row: Row | null) => {
  givenPrimary(row && { nsfwLevel: row.nsfwLevel, hidden: row.refused || row.csamHeld });
  givenReplica(row);
};
const givenReplica = (row: Row | null) =>
  dbMock.dbRead.postText.findMany.mockResolvedValue(
    row ? ([{ id: TEXT, index: 0, content: '<p>t</p>', ...row }] as never) : []
  );
const threadReadable = (c: never) =>
  assertPostTextVisible(TEXT, c).then(
    () => true,
    () => false
  );
const servedByPostGet = async (c: never) => {
  const post = (await getPostHandler({ input: { id: POST }, ctx: c })) as {
    texts: { id: number }[];
  };
  return post.texts.some((t) => t.id === TEXT);
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getPostDetail.mockResolvedValue({ id: POST, user: { id: AUTHOR } });
  mocks.amIBlockedByUser.mockResolvedValue(false);
});

describe("a storyline text's thread is readable exactly where post.get serves the text", () => {
  const rows: [string, Row][] = [
    ['scanned', scanned],
    ['unscanned', { ...scanned, nsfwLevel: 0 }],
    ['refused', { ...scanned, refused: true }],
    ['held', { ...scanned, csamHeld: true }],
    ['rated X', { ...scanned, nsfwLevel: NsfwLevel.X }],
  ];
  const viewers: [string, unknown, Record<string, unknown>?][] = [
    ['signed out', undefined],
    ['a member', member],
    ['a member on the SFW domain', member, { req: { headers: { host: 'civitai.green' } } }],
    ['the author', author],
    ['a moderator', moderator],
  ];
  const cases = rows.flatMap(([rowName, row]) =>
    viewers.map(([who, user, over]) => [rowName, who, row, user, over] as const)
  );

  it.each(cases)('%s text, %s', async (_, __, row, user, over) => {
    givenText(row);
    const c = ctx(user, over);
    expect(await threadReadable(c)).toBe(await servedByPostGet(c));
  });

  // Controls: the parity above must not hold only because everything is hidden, or all shown.
  it('a scanned PG text is readable by a stranger', async () => {
    givenText(scanned);
    expect(await threadReadable(ctx(undefined))).toBe(true);
  });

  it('a refused or held text has no readable thread, author and moderators included', async () => {
    for (const row of [
      { ...scanned, refused: true },
      { ...scanned, csamHeld: true },
    ]) {
      givenText(row);
      for (const user of [author, moderator]) expect(await threadReadable(ctx(user))).toBe(false);
    }
  });

  // The replica lags the primary; only the primary decides whether a text is hidden.
  const everyone = [undefined, member, author, moderator];
  const readBy = async (user: unknown) => {
    const c = ctx(user);
    return [await threadReadable(c), await servedByPostGet(c)];
  };

  it('(a) is hidden right after its hold is confirmed, while the replica still shows it unheld', async () => {
    givenReplica(scanned);
    givenPrimary({ nsfwLevel: scanned.nsfwLevel, hidden: true });
    for (const user of everyone) expect(await readBy(user)).toEqual([false, false]);
  });

  it('(b) is hidden right after a hold is detected, before the replica has it', async () => {
    givenReplica(scanned);
    givenPrimary({ nsfwLevel: scanned.nsfwLevel, hidden: true });
    expect(await readBy(member)).toEqual([false, false]);
    expect(dbMock.dbRead.postText.findUnique).not.toHaveBeenCalled();
  });

  it('(c) is shown again once the hold is released, though the replica still shows it held', async () => {
    givenReplica({ ...scanned, csamHeld: true });
    givenPrimary({ nsfwLevel: scanned.nsfwLevel, hidden: false });
    for (const user of everyone) expect(await readBy(user)).toEqual([true, true]);
  });

  it('an unscanned text is readable by its author and moderators only', async () => {
    givenText({ ...scanned, nsfwLevel: 0 });
    expect(await threadReadable(ctx(author))).toBe(true);
    expect(await threadReadable(ctx(moderator))).toBe(true);
    expect(await threadReadable(ctx(member))).toBe(false);
  });
});

describe('assertPostTextVisible: the post gate', () => {
  it('is not found when the post is not visible to the viewer', async () => {
    givenText(scanned);
    mocks.getPostDetail.mockRejectedValue(new Error('not found'));
    expect(await threadReadable(ctx(member))).toBe(false);
  });

  it("is not found to a member the post's author blocked, but a moderator reads it", async () => {
    givenText(scanned);
    mocks.amIBlockedByUser.mockResolvedValue(true);
    expect(await threadReadable(ctx(member))).toBe(false);
    expect(await threadReadable(ctx(moderator))).toBe(true);
  });

  it('is not found with the flag off, or when the text is gone', async () => {
    givenText(scanned);
    expect(
      await threadReadable(
        ctx(moderator, { features: { canViewNsfw: true, storylineText: false } })
      )
    ).toBe(false);
    givenText(null);
    expect(await threadReadable(ctx(moderator))).toBe(false);
  });
});
