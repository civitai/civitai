import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The three `OPEN_MEDIA_UPLOAD_BATCH` procedures' shared ladder, and what each hands the service.
 * The service is a mock here (its quota, row and presign are `media-upload-batch.service.test.ts`);
 * these cases pin who is asking, which app is recorded, and that the presign is minted with the
 * token SUBJECT's own orchestrator token. Every refusal also asserts the service never ran, so it
 * cannot be credited to a later gate.
 */

const h = vi.hoisted(() => ({
  authorize: vi.fn(),
  parseSubject: vi.fn(),
  isAppBlocksEnabled: vi.fn(),
  isBatchEnabled: vi.fn(),
  getSessionUser: vi.fn(),
  getOrchestratorToken: vi.fn(),
  start: vi.fn(),
  presign: vi.fn(),
  record: vi.fn(),
}));

vi.mock('~/server/services/blocks/block-bridge-auth.service', () => ({
  authorizeBlockBridgeToken: (...a: unknown[]) => h.authorize(...a),
}));
vi.mock('~/server/middleware/block-scope.middleware', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return { ...actual, parseSubjectUserId: (...a: unknown[]) => h.parseSubject(...a) };
});
vi.mock('~/server/services/app-blocks-flag', () => ({
  isAppBlocksEnabled: (...a: unknown[]) => h.isAppBlocksEnabled(...a),
  isAppBlocksAuthorEnabled: vi.fn(),
  isAppBlocksBatchMediaUploadEnabled: (...a: unknown[]) => h.isBatchEnabled(...a),
}));
vi.mock('~/server/auth/session-client', () => ({
  sessionClient: { getSessionUserById: (...a: unknown[]) => h.getSessionUser(...a) },
}));
vi.mock('~/server/orchestrator/get-orchestrator-token', () => ({
  getOrchestratorToken: (...a: unknown[]) => h.getOrchestratorToken(...a),
}));
vi.mock('~/server/services/blocks/media-upload-batch.service', () => ({
  startMediaUploadBatch: (...a: unknown[]) => h.start(...a),
  presignMediaUploadBatchItem: (...a: unknown[]) => h.presign(...a),
  recordMediaUploadBatchItem: (...a: unknown[]) => h.record(...a),
}));
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
const EXPIRES = new Date('2026-12-11T10:00:00.000Z');

function claims(over: Record<string, unknown> = {}) {
  return {
    sub: `user:${VIEWER_ID}`,
    scopes: [],
    appId: 'app_alpha',
    appBlockId: 'apb_alpha',
    blockInstanceId: 'page_apb_alpha',
    blockId: 'alpha-app',
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

const caller = (c = ctx()) => blocksRouter.createCaller(c as never);
const ITEMS = [
  { kind: 'image', sizeBytes: 1000 },
  { kind: 'audio', sizeBytes: 2000 },
];
const calls = {
  start: (c = ctx()) =>
    caller(c).startMediaUploadBatch({ blockToken: 'tok', items: ITEMS } as never),
  presign: (c = ctx()) =>
    caller(c).presignMediaUploadBatchItem({ blockToken: 'tok', batchId: 91, index: 0 }),
  record: (c = ctx()) =>
    caller(c).recordMediaUploadBatchItem({
      blockToken: 'tok',
      batchId: 91,
      blobKey: `${'a'.repeat(32)}.jpeg`,
    }),
};
const services = () => [h.start, h.presign, h.record];

beforeEach(() => {
  vi.clearAllMocks();
  h.authorize.mockResolvedValue(claims());
  h.parseSubject.mockImplementation((sub: string) =>
    sub === 'anon' ? null : Number(sub.slice('user:'.length))
  );
  h.isAppBlocksEnabled.mockResolvedValue(true);
  h.isBatchEnabled.mockResolvedValue(true);
  h.getSessionUser.mockImplementation(async (id: number) => ({ id }));
  h.getOrchestratorToken.mockImplementation(async (id: number) => `orch-token-for-${id}`);
  h.start.mockResolvedValue({ batchId: 91, expiresAt: EXPIRES });
  h.presign.mockResolvedValue({ uploadUrl: 'u', expiresAt: 'e', extra: 'not returned' });
  h.record.mockResolvedValue({ expiresAt: EXPIRES });
});

describe('blocks.*MediaUploadBatch*', () => {
  it('start records the TOKEN’s app identity and the token subject', async () => {
    await expect(calls.start()).resolves.toEqual({
      batchId: 91,
      expiresAt: '2026-12-11T10:00:00.000Z',
    });
    expect(h.start).toHaveBeenCalledWith({
      actor: {
        userId: VIEWER_ID,
        appBlockId: 'apb_alpha',
        appId: 'app_alpha',
        blockId: 'alpha-app',
      },
      items: ITEMS,
    });
  });

  it('presign mints with the token subject’s OWN orchestrator token', async () => {
    await expect(calls.presign()).resolves.toEqual({ uploadUrl: 'u', expiresAt: 'e' });
    expect(h.getOrchestratorToken.mock.calls[0][0]).toBe(VIEWER_ID);
    expect(h.presign).toHaveBeenCalledWith({
      actor: { userId: VIEWER_ID, appBlockId: 'apb_alpha' },
      batchId: 91,
      index: 0,
      token: `orch-token-for-${VIEWER_ID}`,
    });
  });

  it('record appends to this viewer’s batch for this app', async () => {
    await expect(calls.record()).resolves.toEqual({ expiresAt: '2026-12-11T10:00:00.000Z' });
    expect(h.record).toHaveBeenCalledWith({
      actor: { userId: VIEWER_ID, appBlockId: 'apb_alpha' },
      batchId: 91,
      blobKey: `${'a'.repeat(32)}.jpeg`,
    });
  });

  it('start refuses more than 1,200 files at the schema, before any service', async () => {
    const many = Array.from({ length: 1201 }, () => ({ kind: 'image', sizeBytes: 1 }));
    await expect(
      caller().startMediaUploadBatch({ blockToken: 'tok', items: many } as never)
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(h.start).not.toHaveBeenCalled();
  });

  describe.each(Object.entries(calls))('%s', (_name, call) => {
    it.each([
      [
        'the batch-upload flag off for the subject',
        () => h.isBatchEnabled.mockResolvedValue(false),
        { code: 'FORBIDDEN', message: 'batch media upload is not available' },
      ],
      [
        'an anonymous token subject',
        () => h.authorize.mockResolvedValue(claims({ sub: 'anon' })),
        { code: 'UNAUTHORIZED', message: 'uploading requires a signed-in viewer' },
      ],
      [
        'a model-slot (non-page) token',
        () =>
          h.authorize.mockResolvedValue(
            claims({
              blockInstanceId: 'bki_alpha',
              ctx: { slotId: 'model.sidebar_top', modelId: 5 },
            })
          ),
        { code: 'FORBIDDEN', message: 'batch media upload is available to page apps only' },
      ],
      [
        // The runtime gate hydrates the subject first, so a subject that never resolves is
        // refused there, before this ladder's own read.
        'a subject that does not hydrate at all',
        () => h.getSessionUser.mockResolvedValue(null),
        { code: 'UNAUTHORIZED', message: 'runtime block token subject could not be resolved' },
      ],
      [
        // The narrow window: the gate's read resolved, this ladder's second read did not (a user
        // deleted between the two). Refused with its own message, never evaluated flag-less.
        'a subject that stops resolving between the two reads',
        () => h.getSessionUser.mockResolvedValueOnce({ id: VIEWER_ID }).mockResolvedValueOnce(null),
        {
          code: 'UNAUTHORIZED',
          message: 'uploading subject could not be resolved, please try again',
        },
      ],
    ])('refuses %s, and the service never runs', async (_label, arrange, expected) => {
      arrange();
      await expect(call()).rejects.toMatchObject(expected);
      for (const s of services()) expect(s).not.toHaveBeenCalled();
      expect(h.getOrchestratorToken).not.toHaveBeenCalled();
    });

    it('refuses a session that is not the token subject', async () => {
      await expect(call(ctx({ id: OTHER_USER_ID }))).rejects.toMatchObject({
        code: 'FORBIDDEN',
        message: 'this app session belongs to a different account; reload the page to continue',
      });
      for (const s of services()) expect(s).not.toHaveBeenCalled();
    });

    it('evaluates the batch flag on the token subject’s hydrated user', async () => {
      await call();
      expect(h.isBatchEnabled).toHaveBeenCalledWith({ user: { id: VIEWER_ID } });
    });
  });
});
