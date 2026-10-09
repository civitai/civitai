import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * `blocks.persistAppUploadImage` — the server half of `OPEN_IMAGE_UPLOAD { bytes }`. It persists
 * an app's own upload with the `blockUploadedAppId` stamp, so it is gated as a post: the shared
 * post preamble and page tokens only. `blocks.authorizeAppUploadImage`, which the host calls
 * before the store upload, runs the same gates and takes the upload's publish-bucket charge.
 *
 * Every refusal also asserts the persist never ran, so it cannot be credited to a later gate.
 */

const {
  mockAuthorizeBlockBridgeToken,
  mockParseSubjectUserId,
  mockIsAppBlocksEnabled,
  mockIsAppBlocksPostCreationEnabled,
  mockGetSessionUser,
  mockCheckPublishRate,
  mockCheckCatalogRate,
  mockPersistUpload,
} = vi.hoisted(() => ({
  mockAuthorizeBlockBridgeToken: vi.fn(),
  mockParseSubjectUserId: vi.fn(),
  mockIsAppBlocksEnabled: vi.fn(),
  mockIsAppBlocksPostCreationEnabled: vi.fn(),
  mockGetSessionUser: vi.fn(),
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

  it('charges NO block bucket: the preflight took the charge before the bytes were stored', async () => {
    // Charging here too refused uploads AFTER storage whenever the preflight's own increment
    // landed on the fixed window's last slot.
    mockCheckPublishRate.mockResolvedValue({ allowed: false });
    await expect(call()).resolves.toEqual({ imageId: 777 });
    expect(mockCheckPublishRate).not.toHaveBeenCalled();
    expect(mockCheckCatalogRate).not.toHaveBeenCalled();
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
  ])('refuses %s, and never persists', async (_label, arrange, expected) => {
    arrange();
    await expect(call()).rejects.toMatchObject(expected);
    expect(mockPersistUpload).not.toHaveBeenCalled();
  });

  it('refuses a session that is not the token subject, and never persists', async () => {
    await expect(call({}, ctx({ id: OTHER_USER_ID }))).rejects.toMatchObject({
      code: 'FORBIDDEN',
      message: 'this app session belongs to a different account; reload the page to continue',
    });
    expect(mockPersistUpload).not.toHaveBeenCalled();
  });
});

describe('blocks.authorizeAppUploadImage — the gate the host runs BEFORE any bytes reach the store', () => {
  const authorize = (c = ctx()) =>
    blocksRouter.createCaller(c as never).authorizeAppUploadImage({ blockToken: 'tok' });

  it('admits a page app holding posts:write:self, taking the upload’s one publish-bucket charge', async () => {
    await expect(authorize()).resolves.toEqual({ ok: true });
    expect(mockCheckPublishRate).toHaveBeenCalledWith('page_apb_alpha', 1);
    expect(mockCheckCatalogRate).not.toHaveBeenCalled();
    expect(mockPersistUpload).not.toHaveBeenCalled();
  });

  it.each([
    [
      'an app without posts:write:self',
      () => mockAuthorizeBlockBridgeToken.mockResolvedValue(claims({ scopes: [] })),
      { code: 'FORBIDDEN', message: 'block lacks posts:write:self scope' },
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
    [
      'the publish bucket refusing (before any bytes are stored)',
      () => mockCheckPublishRate.mockResolvedValue({ allowed: false }),
      { code: 'TOO_MANY_REQUESTS', message: 'Rate limit exceeded, please retry shortly.' },
    ],
  ])('refuses %s', async (_label, arrange, expected) => {
    arrange();
    await expect(authorize()).rejects.toMatchObject(expected);
  });

  it('a non-page token is refused BEFORE the publish bucket is charged', async () => {
    mockAuthorizeBlockBridgeToken.mockResolvedValue(
      claims({ blockInstanceId: 'bki_alpha', ctx: { slotId: 'model.sidebar_top', modelId: 5 } })
    );
    await authorize().catch(() => undefined);
    expect(mockCheckPublishRate).not.toHaveBeenCalled();
  });

  it('refuses a session that is not the token subject', async () => {
    await expect(authorize(ctx({ id: OTHER_USER_ID }))).rejects.toMatchObject({
      code: 'FORBIDDEN',
      message: 'this app session belongs to a different account; reload the page to continue',
    });
  });
});
