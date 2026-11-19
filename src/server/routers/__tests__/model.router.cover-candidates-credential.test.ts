import { beforeEach, describe, expect, it, vi } from 'vitest';
import '~/__tests__/mocks/logging.mock';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { TokenScope } from '~/shared/constants/token-scope.constants';
import { ApiKeyType } from '~/shared/utils/prisma/enums';

import { modelRouter } from '~/server/routers/model.router';

/** model.getCoverCandidates lists every showcase image of a model to its owner and moderators. */

const OWNER = { id: 7, isModerator: false };
const MODERATOR = { id: 1, isModerator: true };
const session = { apiKeyId: null };
const key = (tokenScope: bigint) => ({
  apiKeyId: 9,
  apiKeyType: ApiKeyType.User,
  subject: { type: 'apiKey', id: 9 },
  tokenScope,
});
const oauth = {
  apiKeyId: 9,
  apiKeyType: ApiKeyType.Access,
  subject: { type: 'oauth', id: 'client' },
  tokenScope: TokenScope.ModelsRead,
};

function call(user: { id: number; isModerator: boolean }, credential: object) {
  return modelRouter
    .createCaller({
      user,
      acceptableOrigin: true,
      tokenScope: TokenScope.Full,
      req: { headers: {} },
      res: { setHeader: () => undefined, removeHeader: () => undefined },
      cache: { edgeTTL: 0 },
      features: {},
      track: {},
      ...credential,
    } as never)
    .getCoverCandidates({ id: 1 })
    .then(
      () => 'served',
      (error: { code?: string }) => error.code ?? 'error'
    );
}

beforeEach(() => {
  vi.clearAllMocks();
  dbMock.dbRead.model.findUnique.mockResolvedValue({ userId: OWNER.id } as never);
  dbMock.dbRead.modelVersion.findMany.mockResolvedValue([]);
});

describe('model.getCoverCandidates', () => {
  it.each([
    ['the owner on a session', OWNER, session],
    ['the owner on a full-access key', OWNER, key(TokenScope.Full)],
    ['a moderator on a session', MODERATOR, session],
    ['a moderator on a full-access key', MODERATOR, key(TokenScope.Full)],
  ])('serves %s', async (_label, user, credential) => {
    expect(await call(user, credential)).toBe('served');
    expect(dbMock.dbRead.modelVersion.findMany).toHaveBeenCalled();
  });

  it.each([
    ['the owner on a ModelsRead key', OWNER, key(TokenScope.ModelsRead)],
    ['a moderator on a ModelsRead key', MODERATOR, key(TokenScope.ModelsRead)],
    ['the owner on an app token', OWNER, oauth],
    ['a moderator on an app token', MODERATOR, oauth],
  ])('refuses %s', async (_label, user, credential) => {
    expect(await call(user, credential)).toBe('FORBIDDEN');
    expect(dbMock.dbRead.modelVersion.findMany).not.toHaveBeenCalled();
  });
});
