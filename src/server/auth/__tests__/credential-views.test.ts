import { describe, expect, it } from 'vitest';
import { credentialViews } from '~/server/auth/full-user-credential';
import { TokenScope } from '~/shared/constants/token-scope.constants';
import { ApiKeyType } from '~/shared/utils/prisma/enums';

const moderator = { id: 5, isModerator: true };
const member = { id: 6, isModerator: false };
const userKey = (tokenScope: bigint) => ({
  apiKeyId: 9,
  apiKeyType: ApiKeyType.User,
  subject: { type: 'apiKey' as const, id: 9 },
  tokenScope,
});

describe('credentialViews', () => {
  it.each([
    ['a session', {}, moderator, { asModerator: true, asOwner: true }],
    [
      'a full-access key',
      userKey(TokenScope.Full),
      moderator,
      { asModerator: true, asOwner: true },
    ],
    [
      'a scoped key',
      userKey(TokenScope.MediaRead),
      moderator,
      { asModerator: false, asOwner: false },
    ],
    [
      'an app token',
      { subject: { type: 'oauth' as const, id: 'app' } },
      moderator,
      { asModerator: false, asOwner: false },
    ],
    ['a session of a member', {}, member, { asModerator: false, asOwner: true }],
    ['a signed-out request', {}, undefined, { asModerator: false, asOwner: true }],
  ])('%s', (_, credential, user, views) => {
    expect(credentialViews({ ...credential, user } as never)).toEqual(views);
  });
});
