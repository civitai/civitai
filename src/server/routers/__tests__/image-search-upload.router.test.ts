import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as FeatureFlags from '~/server/services/feature-flags.service';
import type * as Upload from '~/server/services/image-search-upload.service';
import { TokenScope } from '~/shared/constants/token-scope.constants';

const h = vi.hoisted(() => ({
  flags: { imageSearchUpload: true, moreLikeThis: true },
  status: vi.fn(),
}));

vi.mock('~/server/services/feature-flags.service', async (importOriginal) => ({
  ...(await importOriginal<typeof FeatureFlags>()),
  getFeatureFlags: () => h.flags,
}));
vi.mock('~/server/services/image-search-upload.service', async (importOriginal) => ({
  ...(await importOriginal<typeof Upload>()),
  getSearchUploadStatus: h.status,
}));

import { imageSearchUploadRouter } from '~/server/routers/image-search-upload.router';

const USER = { id: 7, username: 'Fox', isModerator: false, muted: false, onboarding: 0x1f };
const MOD = { ...USER, id: 8, isModerator: true };
const caller = (user: typeof USER | undefined, credential: object = {}) =>
  imageSearchUploadRouter.createCaller({
    acceptableOrigin: true,
    user,
    tokenScope: TokenScope.Full,
    ...credential,
    req: { headers: {} },
    features: {},
    track: {},
  } as never);
const status = (user: typeof USER | undefined, credential?: object) =>
  caller(user, credential).status({ uploadId: 40 });

beforeEach(() => {
  h.flags = { imageSearchUpload: true, moreLikeThis: true };
  h.status.mockReset().mockResolvedValue({ status: 'pending' });
});

describe('imageSearchUpload', () => {
  it("passes the moderator view only for a moderator's session", async () => {
    await status(USER);
    await status(MOD);
    expect(h.status.mock.calls.map(([args]) => args.isModerator)).toEqual([false, true]);
    expect(h.status).toHaveBeenCalledWith({ userId: 8, uploadId: 40, isModerator: true });
  });

  it("refuses an API key, a moderator's included", async () => {
    await expect(status(MOD, { apiKeyId: 1, apiKeyType: 'User' })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    expect(h.status).not.toHaveBeenCalled();
  });

  it('refuses a signed-out caller', async () => {
    await expect(status(undefined)).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
  });

  it.each([
    ['its own flag', { imageSearchUpload: false, moreLikeThis: true }],
    ['"More like this"', { imageSearchUpload: true, moreLikeThis: false }],
  ])('refuses without %s', async (_name, flags) => {
    h.flags = flags;
    await expect(status(USER)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(h.status).not.toHaveBeenCalled();
  });
});
