import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * `blockImageUpload.persist` — the VIEWER-PICKED upload behind `OPEN_IMAGE_UPLOAD`. PRIVATE by
 * default: the row is stamped `blockSharedUploadAppId` with the block token's VERIFIED appId only
 * when the request carries `share: true`, and only when the token's subject is the session user
 * doing the upload. Without `share: true` the token is ignored and the row is unstamped, as before. The
 * appId never comes from the request.
 *
 * The fakes sit at the token verifier and the persist service, so the assertions read exactly
 * which app (if any) the router asked the service to stamp.
 */

const VIEWER = 42;
const OTHER_USER = 7;
const TOKEN_APP = 'appblk-alpha';
const KEY = '33333333-3333-4333-8333-333333333333';

const h = vi.hoisted(() => ({ authorize: vi.fn(), persist: vi.fn() }));

vi.mock('~/server/services/blocks/block-bridge-auth.service', () => ({
  authorizeBlockBridgeToken: (...a: unknown[]) => h.authorize(...a),
}));
vi.mock('~/server/services/blocks/block-image-upload.service', () => ({
  persistBlockUploadImage: (...a: unknown[]) => h.persist(...a),
}));
vi.mock('~/server/middleware.trpc', async () => {
  const { middleware } = await import('~/server/trpc');
  return { rateLimit: () => middleware(({ next }) => next()) };
});

import { blockImageUploadRouter } from '../block-image-upload.router';
import { TokenScope } from '~/shared/constants/token-scope.constants';

function caller(user: { id: number }) {
  return blockImageUploadRouter.createCaller({
    acceptableOrigin: true,
    user,
    apiKeyId: null,
    tokenScope: TokenScope.Full,
    req: { headers: {} } as never,
    res: { setHeader: () => undefined } as never,
    cache: { edgeTTL: 0 },
    features: {} as never,
    track: undefined,
  } as never);
}

/** A fresh request body per call: the tRPC middleware chain annotates the object it is handed. */
const upload = () => ({ url: KEY, name: 'a.png', width: 640, height: 480 });
/** What the service must receive: the schema's fields, never the token. */
const PERSISTED = { url: KEY, name: 'a.png', width: 640, height: 480 };

beforeEach(() => {
  h.authorize.mockReset();
  h.persist.mockReset();
  h.persist.mockResolvedValue({ imageId: 9_301 });
  h.authorize.mockImplementation(async (token: string) => ({
    appId: TOKEN_APP,
    sub:
      token === 'tok_viewer'
        ? `user:${VIEWER}`
        : token === 'tok_anon'
        ? 'anon'
        : token === 'tok_malformed'
        ? 'user:abc'
        : `user:${OTHER_USER}`,
  }));
});

describe('blockImageUpload.persist — the provenance stamp is opt-in per upload', () => {
  it('without share or a token: unstamped, and no token is verified (unchanged behaviour)', async () => {
    await expect(caller({ id: VIEWER }).persist(upload())).resolves.toEqual({
      imageId: 9_301,
      shared: false,
    });
    expect(h.authorize).not.toHaveBeenCalled();
    expect(h.persist.mock.calls).toEqual([
      [{ input: PERSISTED, userId: VIEWER, sharedWithAppId: undefined }],
    ]);
  });

  it.each([
    ['absent', undefined],
    ['false', false],
  ])(
    '🔴 share %s: a valid token is IGNORED and the row stays private (unstamped)',
    async (_label, share) => {
      await expect(
        caller({ id: VIEWER }).persist({ ...upload(), blockToken: 'tok_viewer', share })
      ).resolves.toEqual({ imageId: 9_301, shared: false });
      expect(h.authorize).not.toHaveBeenCalled();
      expect(h.persist.mock.calls).toEqual([
        [{ input: PERSISTED, userId: VIEWER, sharedWithAppId: undefined }],
      ]);
    }
  );

  it('rejects a share value that is not a boolean at the schema', async () => {
    await expect(
      caller({ id: VIEWER }).persist({
        ...upload(),
        blockToken: 'tok_viewer',
        share: 'true',
      } as never)
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(h.persist).not.toHaveBeenCalled();
  });

  it('🔴 share with the viewer’s own verified token: stamped with the TOKEN’s appId, never a body field', async () => {
    await expect(
      caller({ id: VIEWER }).persist({
        ...upload(),
        share: true,
        blockToken: 'tok_viewer',
        // Not in the schema: a request cannot name the app to stamp.
        appId: 'appblk-forged',
      } as never)
    ).resolves.toEqual({ imageId: 9_301, shared: true });
    expect(h.authorize.mock.calls).toEqual([['tok_viewer']]);
    expect(h.persist.mock.calls).toEqual([
      [{ input: PERSISTED, userId: VIEWER, sharedWithAppId: TOKEN_APP }],
    ]);
  });

  it('🔴 share with NO token is refused, not stored private, and writes nothing', async () => {
    await expect(
      caller({ id: VIEWER }).persist({ ...upload(), share: true })
    ).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      message: 'sharing an upload requires a block token',
    });
    expect(h.authorize).not.toHaveBeenCalled();
    expect(h.persist).not.toHaveBeenCalled();
  });

  it.each([
    ['another user’s token', 'tok_other'],
    ['an anonymous token', 'tok_anon'],
    ['a token with a malformed subject', 'tok_malformed'],
  ])('🔴 share with %s is refused and writes nothing', async (_label, blockToken) => {
    await expect(
      caller({ id: VIEWER }).persist({ ...upload(), share: true, blockToken })
    ).rejects.toMatchObject({ code: 'FORBIDDEN', message: 'block token is not for this viewer' });
    expect(h.persist).not.toHaveBeenCalled();
  });

  it('share with a token the bridge verifier refuses is that refusal, and writes nothing', async () => {
    h.authorize.mockRejectedValue(
      Object.assign(new Error('block instance revoked'), { code: 'FORBIDDEN' })
    );
    await expect(
      caller({ id: VIEWER }).persist({ ...upload(), share: true, blockToken: 'tok_viewer' })
    ).rejects.toMatchObject({ message: 'block instance revoked' });
    expect(h.persist).not.toHaveBeenCalled();
  });

  it('rejects an empty block token at the schema', async () => {
    await expect(
      caller({ id: VIEWER }).persist({ ...upload(), share: true, blockToken: '' })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(h.authorize).not.toHaveBeenCalled();
    expect(h.persist).not.toHaveBeenCalled();
  });
});
