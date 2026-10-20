import { beforeEach, describe, expect, it } from 'vitest';
import '~/__tests__/mocks/logging.mock';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { TokenScope } from '~/shared/constants/token-scope.constants';

import { modelRouter } from '~/server/routers/model.router';

/**
 * `model.getModelsByHash` backs the bounty entry file check: it tells a signed-in caller, per
 * hash, whether the file is already on a model they do not own, and nothing about whose model
 * or which one.
 */

const ME = 7;
const OTHER = 8;
const MODEL_ID = 100;
const H1 = 'A'.repeat(64);
const H2 = 'B'.repeat(64);

const VIEWERS = {
  anon: undefined,
  me: { id: ME, isModerator: false },
  moderator: { id: 1, isModerator: true },
} as const;

function caller(viewer: keyof typeof VIEWERS) {
  const user = VIEWERS[viewer];
  return modelRouter.createCaller({
    user,
    acceptableOrigin: true,
    tokenScope: TokenScope.Full,
    apiKeyId: null,
    req: { headers: {} },
    res: { setHeader: () => undefined, removeHeader: () => undefined },
    cache: { edgeTTL: user ? 0 : 60 },
    features: {},
    track: {},
  } as never);
}

/** Rows as the hash query returns them, one per matching model, model id included. */
function matches(...rows: { userId: number; hash: string }[]) {
  dbMock.dbRead.$queryRaw.mockResolvedValue(rows.map((row) => ({ ...row, id: MODEL_ID })));
}

beforeEach(() => {
  dbMock.dbRead.$queryRaw.mockReset();
});

describe('model.getModelsByHash', () => {
  it("a hash on another user's model is flagged without naming the model or its owner", async () => {
    matches({ userId: OTHER, hash: H1 });
    expect(await caller('me').getModelsByHash({ hashes: [H1] })).toStrictEqual([
      { hash: H1, ownedByOther: true },
    ]);
  });

  it('moderators get the same answer, without ids', async () => {
    matches({ userId: OTHER, hash: H1 });
    expect(await caller('moderator').getModelsByHash({ hashes: [H1] })).toStrictEqual([
      { hash: H1, ownedByOther: true },
    ]);
  });

  it('a hash only on my own models is not flagged', async () => {
    matches({ userId: ME, hash: H1 });
    expect(await caller('me').getModelsByHash({ hashes: [H1] })).toStrictEqual([
      { hash: H1, ownedByOther: false },
    ]);
  });

  it("a hash on both my model and another user's is flagged, whichever row comes first", async () => {
    matches({ userId: OTHER, hash: H1 }, { userId: ME, hash: H1 });
    expect(await caller('me').getModelsByHash({ hashes: [H1] })).toStrictEqual([
      { hash: H1, ownedByOther: true },
    ]);
    matches({ userId: ME, hash: H1 }, { userId: OTHER, hash: H1 });
    expect(await caller('me').getModelsByHash({ hashes: [H1] })).toStrictEqual([
      { hash: H1, ownedByOther: true },
    ]);
  });

  it('each hash is answered on its own', async () => {
    matches({ userId: OTHER, hash: H1 }, { userId: ME, hash: H2 });
    expect(await caller('me').getModelsByHash({ hashes: [H1, H2] })).toStrictEqual([
      { hash: H1, ownedByOther: true },
      { hash: H2, ownedByOther: false },
    ]);
  });

  it('needs a signed-in caller', async () => {
    matches({ userId: OTHER, hash: H1 });
    await expect(caller('anon').getModelsByHash({ hashes: [H1] })).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
    });
    expect(dbMock.dbRead.$queryRaw).not.toHaveBeenCalled();
  });
});
