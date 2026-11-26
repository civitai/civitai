import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as FeatureFlags from '~/server/services/feature-flags.service';
import type * as Upload from '~/server/services/image-search-upload.service';
import type * as SemanticSearch from '~/server/services/semantic-image-search.service';
import { TokenScope } from '~/shared/constants/token-scope.constants';
import { redisMock } from '~/__tests__/mocks/redis.mock';

const h = vi.hoisted(() => ({
  flags: { imageSearchUpload: true, moreLikeThis: true },
  status: vi.fn(),
  prepare: vi.fn(),
  anchor: vi.fn(),
  claimDay: vi.fn(),
  searchSlot: vi.fn(),
  search: vi.fn(),
}));

vi.mock('~/server/services/feature-flags.service', async (importOriginal) => ({
  ...(await importOriginal<typeof FeatureFlags>()),
  getFeatureFlags: () => h.flags,
}));
vi.mock('~/server/services/image-search-upload.service', async (importOriginal) => ({
  ...(await importOriginal<typeof Upload>()),
  getSearchUploadStatus: h.status,
  prepareSearchUpload: h.prepare,
  resolveSearchUploadAnchor: h.anchor,
  claimSearchUploadUserDay: h.claimDay,
  claimSearchUploadSearchSlot: h.searchSlot,
}));
vi.mock('~/server/services/semantic-image-search.service', async (importOriginal) => ({
  ...(await importOriginal<typeof SemanticSearch>()),
  searchSemanticImages: h.search,
}));

import { imageSearchUploadRouter } from '~/server/routers/image-search-upload.router';

const USER = { id: 7, username: 'Fox', isModerator: false, muted: false, onboarding: 0x1f };
const MOD = { ...USER, id: 8, isModerator: true };
const UPLOAD = '3f6c2b91-0d84-4a15-9e70-c2b8a4d15e33';
const BLOB = 'https://orchestration.civitai.com/v2/consumer/blobs/b1';
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
  caller(user, credential).status({ uploadId: UPLOAD });

beforeEach(() => {
  h.flags = { imageSearchUpload: true, moreLikeThis: true };
  h.status.mockReset().mockResolvedValue({ status: 'pending' });
  h.prepare.mockReset().mockResolvedValue({ uploadId: UPLOAD });
  h.anchor.mockReset().mockResolvedValue(ANCHOR);
  h.claimDay.mockReset().mockResolvedValue(undefined);
  h.searchSlot.mockReset().mockResolvedValue(undefined);
  h.search.mockReset().mockResolvedValue({ items: [], nextCursor: undefined });
});

const ANCHOR = { nsfwLevel: 1, imageUrl: 'https://image.test/u.jpeg' };
const search = (user: typeof USER, credential?: object) =>
  caller(user, credential).search({ uploadId: UPLOAD, uploadUrl: BLOB, browsingLevel: 1 });

describe('imageSearchUpload', () => {
  it('refuses every procedure to a non-moderator, whatever the flags say', async () => {
    await expect(status(USER)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(search(USER)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(
      caller(USER).prepare({ uploadUrl: BLOB, source: { kind: 'image', id: 9 } })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(h.status).not.toHaveBeenCalled();
    expect(h.anchor).not.toHaveBeenCalled();
    expect(h.prepare).not.toHaveBeenCalled();
  });

  it("refuses a moderator's scoped app credential, which carries no moderator view", async () => {
    await expect(status(MOD, { subject: 'app-1', tokenScope: BigInt(1) })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    expect(h.status).not.toHaveBeenCalled();
  });

  it("passes the moderator's session and view", async () => {
    await status(MOD);
    expect(h.status).toHaveBeenCalledWith({ userId: 8, uploadId: UPLOAD, isModerator: true });
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
    await expect(status(MOD)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(h.status).not.toHaveBeenCalled();
  });

  it('searches as the session user with the moderator view', async () => {
    await search(MOD);
    expect(h.anchor.mock.calls.map(([args]) => args)).toEqual([
      { userId: 8, uploadId: UPLOAD, url: BLOB, isModerator: true },
    ]);
    expect(h.search).toHaveBeenCalledWith(expect.objectContaining({ uploadAnchor: ANCHOR }));
  });

  it("refuses a search by API key, a moderator's included", async () => {
    await expect(search(MOD, { apiKeyId: 1, apiKeyType: 'User' })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    expect(h.anchor).not.toHaveBeenCalled();
  });

  it('prepares an upload for the session user', async () => {
    await caller(MOD).prepare({
      uploadUrl: 'https://orchestration.civitai.com/v2/consumer/blobs/b1',
      source: { kind: 'image', id: 9 },
    });
    expect(h.prepare).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 8,
        url: 'https://orchestration.civitai.com/v2/consumer/blobs/b1',
        source: { kind: 'image', id: 9 },
      })
    );
  });

  it('refuses a search sent as GET, before counting or searching', async () => {
    const get = imageSearchUploadRouter.createCaller({
      acceptableOrigin: true,
      user: MOD,
      tokenScope: TokenScope.Full,
      req: { headers: {}, method: 'GET' },
      features: {},
      track: {},
    } as never);
    await expect(
      get.search({ uploadId: UPLOAD, uploadUrl: BLOB, browsingLevel: 1 })
    ).rejects.toMatchObject({ code: 'METHOD_NOT_SUPPORTED' });
    expect(h.claimDay).not.toHaveBeenCalled();
    expect(h.anchor).not.toHaveBeenCalled();
  });

  it("counts each search page against the moderator's daily limit, and stops when it is spent", async () => {
    await search(MOD);
    expect(h.claimDay).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 8, action: 'search' })
    );
    h.claimDay.mockRejectedValue(Object.assign(new Error('full'), { code: 'TOO_MANY_REQUESTS' }));
    h.anchor.mockClear();
    await expect(search(MOD)).rejects.toThrow('full');
    expect(h.anchor).not.toHaveBeenCalled();
  });

  it("runs one of a moderator's searches at a time: a second is refused before it counts", async () => {
    const holds = new Map<string, unknown>();
    const isHold = (key: string) => key.includes('search-upload-searching');
    redisMock.redis.set.mockImplementation(
      async (key: string, value: unknown, opts?: { NX?: boolean }) => {
        if (!isHold(key)) return 'OK';
        if (opts?.NX && holds.has(key)) return null;
        holds.set(key, value);
        return 'OK';
      }
    );
    redisMock.redis.eval.mockImplementation(
      async (_script: string, { keys, arguments: args }: { keys: string[]; arguments: string[] }) =>
        holds.get(keys[0]) === args[0] && holds.delete(keys[0]) ? 1 : 0
    );
    let finish!: () => void;
    h.claimDay.mockImplementationOnce(() => new Promise<void>((r) => (finish = r)));
    const first = search(MOD);
    await vi.waitFor(() => expect(h.claimDay).toHaveBeenCalledTimes(1));
    await expect(search(MOD)).rejects.toMatchObject({ code: 'TOO_MANY_REQUESTS' });
    expect(h.claimDay).toHaveBeenCalledTimes(1);
    finish();
    await first;
    await expect(search(MOD)).resolves.toBeDefined();
  });

  it('counts each search page against the site-wide daily cap, after the per-user count and the upload check', async () => {
    await search(MOD);
    expect(h.searchSlot).toHaveBeenCalledTimes(1);
    const [day, anchor, slot] = [h.claimDay, h.anchor, h.searchSlot].map(
      (fn) => fn.mock.invocationCallOrder[0]
    );
    expect(day).toBeLessThan(anchor);
    expect(anchor).toBeLessThan(slot);
  });

  it('stops before searching when the site-wide cap is spent', async () => {
    h.searchSlot.mockRejectedValue(Object.assign(new Error('busy'), { code: 'TOO_MANY_REQUESTS' }));
    await expect(search(MOD)).rejects.toThrow('busy');
    expect(h.search).not.toHaveBeenCalled();
  });

  it('spends no site-wide page on an upload the gate refuses', async () => {
    h.anchor.mockRejectedValue(Object.assign(new Error('refused'), { code: 'FORBIDDEN' }));
    await expect(search(MOD)).rejects.toThrow('refused');
    expect(h.searchSlot).not.toHaveBeenCalled();
  });

  it('stops before searching when the gate refuses the upload', async () => {
    h.anchor.mockRejectedValue(Object.assign(new Error('refused'), { code: 'FORBIDDEN' }));
    await expect(search(MOD)).rejects.toThrow();
    expect(h.search).not.toHaveBeenCalled();
  });
});
