import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * `blocks.persistAppUploadImage` — the server half of `OPEN_IMAGE_UPLOAD { bytes }`. It persists
 * an app's own upload with the `blockUploadedAppId` stamp, so it is gated as a post: the shared
 * post preamble and page tokens only. It also takes the upload's one upload-bucket charge, keyed
 * per (install, viewer), before the persist, so a refused upload creates no Image row.
 *
 * The limiter is a mock here, so these cases see only WHICH bucket is charged and with what.
 * That two viewers really get separate allowances is driven through the real limiter in
 * `blocks.router.persistAppUploadImage.perViewer.test.ts`.
 *
 * Every refusal also asserts the persist never ran, so it cannot be credited to a later gate.
 */

const {
  mockAuthorizeBlockBridgeToken,
  mockParseSubjectUserId,
  mockIsAppBlocksEnabled,
  mockIsAppBlocksPostCreationEnabled,
  mockGetSessionUser,
  mockCheckUploadRate,
  mockCheckPublishRate,
  mockCheckCatalogRate,
  mockPersistUpload,
} = vi.hoisted(() => ({
  mockAuthorizeBlockBridgeToken: vi.fn(),
  mockParseSubjectUserId: vi.fn(),
  mockIsAppBlocksEnabled: vi.fn(),
  mockIsAppBlocksPostCreationEnabled: vi.fn(),
  mockGetSessionUser: vi.fn(),
  mockCheckUploadRate: vi.fn(),
  mockCheckPublishRate: vi.fn(),
  mockCheckCatalogRate: vi.fn(),
  mockPersistUpload: vi.fn(),
}));

vi.mock('~/server/services/blocks/block-bridge-auth.service', () => ({
  authorizeBlockBridgeToken: (...a: unknown[]) => mockAuthorizeBlockBridgeToken(...a),
}));
vi.mock('~/server/middleware/block-scope.middleware', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return { ...actual, parseSubjectUserId: (...a: unknown[]) => mockParseSubjectUserId(...a) };
});
vi.mock('~/server/services/app-blocks-flag', () => ({
  isAppBlocksEnabled: (...a: unknown[]) => mockIsAppBlocksEnabled(...a),
  isAppBlocksAuthorEnabled: vi.fn(),
  isAppBlocksPostCreationEnabled: (...a: unknown[]) => mockIsAppBlocksPostCreationEnabled(...a),
}));
vi.mock('~/server/auth/session-client', () => ({
  sessionClient: { getSessionUserById: (...a: unknown[]) => mockGetSessionUser(...a) },
}));
vi.mock('~/server/utils/block-catalog-rate-limit', () => ({
  checkBlockCatalogRateLimit: (...a: unknown[]) => mockCheckCatalogRate(...a),
  checkBlockPostRateLimit: vi.fn(),
  checkBlockPostAppRateLimit: vi.fn(),
  checkBlockPublishRateLimit: (...a: unknown[]) => mockCheckPublishRate(...a),
  checkBlockUploadRateLimit: (...a: unknown[]) => mockCheckUploadRate(...a),
}));
vi.mock('~/server/services/blocks/block-image-upload.service', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return { ...actual, persistBlockUploadImage: (...a: unknown[]) => mockPersistUpload(...a) };
});
// Same import-chain shim the sibling blocks.router suites use: `rateLimit`
// transitively evaluates a top-level `Prisma.validator(...)`, which cannot run here.
vi.mock('~/server/middleware.trpc', async () => {
  const { middleware } = await import('~/server/trpc');
  return { rateLimit: () => middleware(({ next }) => next()) };
});

import { blocksRouter } from '../blocks.router';
import { TokenScope } from '~/shared/constants/token-scope.constants';

const VIEWER_ID = 42;
const OTHER_USER_ID = 7;
const KEY = '33333333-3333-4333-8333-333333333333';

function claims(over: Record<string, unknown> = {}) {
  return {
    sub: `user:${VIEWER_ID}`,
    scopes: ['posts:write:self'],
    appId: 'appblk-alpha',
    appBlockId: 'apb_alpha',
    blockInstanceId: 'page_apb_alpha',
    blockId: 'my-app',
    maxBrowsingLevel: 1,
    ctx: { slotId: 'page', entityType: 'none' },
    ...over,
  };
}

function ctx(user: { id: number } = { id: VIEWER_ID }) {
  return {
    acceptableOrigin: true,
    user,
    apiKeyId: null,
    tokenScope: TokenScope.Full,
    ip: '203.0.113.9',
    req: { headers: {} } as never,
    res: { setHeader: () => undefined } as never,
    cache: { edgeTTL: 0 },
    features: {} as never,
    track: { post: vi.fn(async () => undefined) },
  };
}

const call = (input: Record<string, unknown> = {}, c = ctx()) =>
  blocksRouter
    .createCaller(c as never)
    .persistAppUploadImage({ blockToken: 'tok', url: KEY, name: 'fixed.png', ...input } as never);

beforeEach(() => {
  vi.clearAllMocks();
  mockAuthorizeBlockBridgeToken.mockResolvedValue(claims());
  mockParseSubjectUserId.mockImplementation((sub: string) =>
    sub === 'anon' ? null : Number(sub.slice('user:'.length))
  );
  mockIsAppBlocksEnabled.mockResolvedValue(true);
  mockIsAppBlocksPostCreationEnabled.mockResolvedValue(true);
  mockGetSessionUser.mockResolvedValue({ id: VIEWER_ID });
  mockCheckUploadRate.mockResolvedValue({ allowed: true });
  mockCheckPublishRate.mockResolvedValue({ allowed: true });
  mockCheckCatalogRate.mockResolvedValue({ allowed: true });
  mockPersistUpload.mockResolvedValue({ imageId: 777 });
});

describe('blocks.persistAppUploadImage', () => {
  it('persists through the picked-upload persist, stamped with the TOKEN’s appId, for the token’s viewer', async () => {
    await expect(call()).resolves.toEqual({ imageId: 777 });
    expect(mockPersistUpload).toHaveBeenCalledWith({
      input: { url: KEY, name: 'fixed.png' },
      userId: VIEWER_ID,
      uploadedByAppId: 'appblk-alpha',
    });
  });

  it('charges the upload bucket exactly once, for this install AND this viewer, and not the publish or catalog bucket', async () => {
    await call();
    expect(mockCheckUploadRate.mock.calls).toEqual([['page_apb_alpha', VIEWER_ID]]);
    // Per install, so shared by every viewer of a page app.
    expect(mockCheckPublishRate).not.toHaveBeenCalled();
    expect(mockCheckCatalogRate).not.toHaveBeenCalled();
  });

  it('the charge follows the request’s viewer and install, not a fixed pair', async () => {
    mockAuthorizeBlockBridgeToken.mockResolvedValue(
      claims({ sub: `user:${OTHER_USER_ID}`, blockInstanceId: 'page_apb_beta' })
    );
    mockGetSessionUser.mockResolvedValue({ id: OTHER_USER_ID });
    await call({}, ctx({ id: OTHER_USER_ID }));
    expect(mockCheckUploadRate.mock.calls).toEqual([['page_apb_beta', OTHER_USER_ID]]);
  });

  it('an upload-bucket refusal returns TOO_MANY_REQUESTS and creates no Image row', async () => {
    mockCheckUploadRate.mockResolvedValue({ allowed: false });
    await expect(call()).rejects.toMatchObject({
      code: 'TOO_MANY_REQUESTS',
      message: 'Rate limit exceeded, please retry shortly.',
    });
    // `persistBlockUploadImage` is what calls `createImage`; it never ran.
    expect(mockPersistUpload).not.toHaveBeenCalled();
  });

  it('charges the bucket BEFORE the persist, never after', async () => {
    await call();
    expect(mockCheckUploadRate.mock.invocationCallOrder[0]).toBeLessThan(
      mockPersistUpload.mock.invocationCallOrder[0]
    );
  });

  it('a non-page token is refused BEFORE the upload bucket is charged', async () => {
    mockAuthorizeBlockBridgeToken.mockResolvedValue(
      claims({ blockInstanceId: 'bki_alpha', ctx: { slotId: 'model.sidebar_top', modelId: 5 } })
    );
    await call().catch(() => undefined);
    expect(mockCheckUploadRate).not.toHaveBeenCalled();
  });

  it('never takes the stamped appId from the request body', async () => {
    await call({ appId: 'appblk-evil', uploadedByAppId: 'appblk-evil' });
    expect(mockPersistUpload.mock.calls[0][0].uploadedByAppId).toBe('appblk-alpha');
  });

  it.each([
    [
      'an app without posts:write:self',
      () =>
        mockAuthorizeBlockBridgeToken.mockResolvedValue(claims({ scopes: ['ai:write:budgeted'] })),
      { code: 'FORBIDDEN', message: 'block lacks posts:write:self scope' },
    ],
    [
      'an anonymous token subject',
      () => mockAuthorizeBlockBridgeToken.mockResolvedValue(claims({ sub: 'anon' })),
      { code: 'UNAUTHORIZED', message: 'posting requires an authenticated viewer' },
    ],
    [
      'post creation switched off',
      () => mockIsAppBlocksPostCreationEnabled.mockResolvedValue(false),
      { code: 'FORBIDDEN', message: 'posting from apps is not enabled' },
    ],
    [
      'a model-slot (non-page) token',
      () =>
        mockAuthorizeBlockBridgeToken.mockResolvedValue(
          claims({ blockInstanceId: 'bki_alpha', ctx: { slotId: 'model.sidebar_top', modelId: 5 } })
        ),
      { code: 'FORBIDDEN', message: 'image byte uploads are available to page apps only' },
    ],
  ])('refuses %s, and never charges the bucket or persists', async (_label, arrange, expected) => {
    arrange();
    await expect(call()).rejects.toMatchObject(expected);
    expect(mockCheckUploadRate).not.toHaveBeenCalled();
    expect(mockPersistUpload).not.toHaveBeenCalled();
  });

  it('refuses a session that is not the token subject, and never charges the bucket or persists', async () => {
    await expect(call({}, ctx({ id: OTHER_USER_ID }))).rejects.toMatchObject({
      code: 'FORBIDDEN',
      message: 'this app session belongs to a different account; reload the page to continue',
    });
    expect(mockCheckUploadRate).not.toHaveBeenCalled();
    expect(mockPersistUpload).not.toHaveBeenCalled();
  });
});
