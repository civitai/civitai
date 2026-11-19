import { beforeEach, describe, expect, it } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import type { RequestCredential } from '~/server/auth/request-credential';
import { getIngestionResults } from '~/server/services/image.service';
import { TokenScope } from '~/shared/constants/token-scope.constants';

const OWNER = { id: 10, isModerator: false };
const STRANGER = { id: 20, isModerator: false };
const MODERATOR = { id: 30, isModerator: true };

const ROWS = [
  { id: 1, userId: OWNER.id, ingestion: 'Scanned', blockedFor: null, tagComposites: [] },
  { id: 2, userId: STRANGER.id, ingestion: 'Blocked', blockedFor: 'reason', tagComposites: [] },
];

const SESSION: RequestCredential = { tokenScope: TokenScope.Full } as RequestCredential;
const reducedKey = {
  tokenScope: TokenScope.MediaRead,
  apiKeyId: 7,
  apiKeyType: 'User',
  subject: { type: 'apiKey', id: 7 },
} as unknown as RequestCredential;

beforeEach(() => {
  // Answers the query as Postgres would for the id and owner columns it filters on.
  dbMock.dbRead.image.findMany.mockImplementation((async (args: {
    where: { id: { in: number[] }; userId?: number };
  }) =>
    ROWS.filter(
      (row) =>
        args.where.id.in.includes(row.id) &&
        (args.where.userId === undefined || row.userId === args.where.userId)
    )) as never);
});

const idsSeen = async (user: { id: number; isModerator: boolean }, credential = SESSION) =>
  Object.keys(await getIngestionResults({ ids: [1, 2], user, credential })).map(Number);

describe('ingestion results', () => {
  it("returns the viewer's own image", async () => {
    expect(await idsSeen(OWNER)).toEqual([1]);
  });

  it("leaves another user's image out, the same as one that does not exist", async () => {
    expect(await idsSeen(STRANGER)).toEqual([2]);
    expect(await idsSeen({ id: 99, isModerator: false })).toEqual([]);
  });

  it('returns any image for a moderator on a browser session', async () => {
    expect(await idsSeen(MODERATOR)).toEqual([1, 2]);
  });

  it("leaves other users' images out for a moderator on a reduced-scope key", async () => {
    expect(await idsSeen(MODERATOR, reducedKey)).toEqual([]);
  });
});
