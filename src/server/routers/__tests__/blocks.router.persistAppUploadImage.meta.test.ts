import { Prisma } from '@prisma/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type * as SessionClient from '~/server/auth/session-client';
import type * as AppBlocksFlag from '~/server/services/app-blocks-flag';
import type * as BlockBridgeAuth from '~/server/services/blocks/block-bridge-auth.service';
import type * as OrchestratorService from '~/server/services/orchestrator/orchestrator.service';
import type * as BlockCatalogRateLimit from '~/server/utils/block-catalog-rate-limit';
import type * as Metadata from '~/utils/metadata';
import type * as S3Utils from '~/utils/s3-utils';

/**
 * `blocks.persistAppUploadImage` end to end below the router: the real persist, the real store
 * read-back and decode, the real embedded-meta parse and the real `createImage`. The fakes sit at
 * the bridge-token gates, the store client, the Prisma client (`dbMock`) and the scan submit, so
 * the assertions read the `Image` row that would be written.
 */

const {
  mockAuthorizeBlockBridgeToken,
  mockParseSubjectUserId,
  mockIsAppBlocksEnabled,
  mockIsAppBlocksPostCreationEnabled,
  mockGetSessionUser,
  mockCheckUploadAppRate,
  mockS3Send,
  parserOverride,
} = vi.hoisted(() => ({
  parserOverride: { throws: false },
  mockAuthorizeBlockBridgeToken: vi.fn(),
  mockParseSubjectUserId: vi.fn(),
  mockIsAppBlocksEnabled: vi.fn(),
  mockIsAppBlocksPostCreationEnabled: vi.fn(),
  mockGetSessionUser: vi.fn(),
  mockCheckUploadAppRate: vi.fn(),
  mockS3Send: vi.fn(),
}));

vi.mock('~/server/services/blocks/block-bridge-auth.service', async (importOriginal) => ({
  ...(await importOriginal<typeof BlockBridgeAuth>()),
  authorizeBlockBridgeToken: (...a: unknown[]) => mockAuthorizeBlockBridgeToken(...a),
}));
vi.mock('~/server/middleware/block-scope.middleware', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return { ...actual, parseSubjectUserId: (...a: unknown[]) => mockParseSubjectUserId(...a) };
});
vi.mock('~/server/services/app-blocks-flag', async (importOriginal) => ({
  ...(await importOriginal<typeof AppBlocksFlag>()),
  isAppBlocksEnabled: (...a: unknown[]) => mockIsAppBlocksEnabled(...a),
  isAppBlocksPostCreationEnabled: (...a: unknown[]) => mockIsAppBlocksPostCreationEnabled(...a),
}));
vi.mock('~/server/auth/session-client', async (importOriginal) => ({
  ...(await importOriginal<typeof SessionClient>()),
  sessionClient: { getSessionUserById: (...a: unknown[]) => mockGetSessionUser(...a) },
}));
vi.mock('~/server/utils/block-catalog-rate-limit', async (importOriginal) => ({
  ...(await importOriginal<typeof BlockCatalogRateLimit>()),
  checkBlockUploadAppRateLimit: (...a: unknown[]) => mockCheckUploadAppRate(...a),
}));
vi.mock('~/utils/metadata', async (importOriginal) => {
  const actual = await importOriginal<typeof Metadata>();
  return {
    ...actual,
    getMetadata: (file: Parameters<typeof actual.getMetadata>[0]) =>
      parserOverride.throws ? Promise.reject(new Error('hostile chunk')) : actual.getMetadata(file),
  };
});
// Same import-chain shim the sibling blocks.router suites use: `rateLimit`
// transitively evaluates a top-level `Prisma.validator(...)`, which cannot run here.
vi.mock('~/server/middleware.trpc', async () => {
  const { middleware } = await import('~/server/trpc');
  return { rateLimit: () => middleware(({ next }) => next()) };
});
vi.mock('~/utils/s3-utils', async (importOriginal) => ({
  ...(await importOriginal<typeof S3Utils>()),
  getImageUploadBackend: async () => ({
    s3: { send: mockS3Send },
    bucket: 'test-image-bucket',
    backend: 'backblaze' as const,
  }),
}));
vi.mock('~/server/utils/created-image-media-probe', () => ({
  probeCreatedImageMedia: vi.fn(async () => 'present'),
}));
vi.mock('~/server/services/orchestrator/orchestrator.service', async (importOriginal) => ({
  ...(await importOriginal<typeof OrchestratorService>()),
  createImageIngestionRequest: vi.fn(async () => ({ data: {} })),
}));

import { dbMock } from '~/__tests__/mocks/db.mock';
import { redisMock } from '~/__tests__/mocks/redis.mock';
import { blocksRouter } from '../blocks.router';
import {
  A1111_PARAMETERS,
  COMFY_PROMPT_GRAPH,
  pngWithTextChunks,
} from '~/server/services/blocks/__tests__/embedded-meta-images.fixture';
import { TokenScope } from '~/shared/constants/token-scope.constants';

const VIEWER_ID = 42;
const APP_ID = 'appblk-alpha';
const KEY = '33333333-3333-4333-8333-333333333333';
const IMAGE_ID = 9_202;

function ctx() {
  return {
    acceptableOrigin: true,
    user: { id: VIEWER_ID },
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

function storeHolds(bytes: Buffer) {
  mockS3Send.mockResolvedValue({
    ContentRange: `bytes 0-${bytes.length - 1}/${bytes.length}`,
    ETag: '"etag-1"',
    Body: { transformToByteArray: async () => new Uint8Array(bytes) },
  });
}

const call = () =>
  blocksRouter
    .createCaller(ctx() as never)
    .persistAppUploadImage({ blockToken: 'tok', url: KEY, name: 'healed.png' });

/** The one `Image` row written. */
function writtenRow() {
  const calls = dbMock.dbWrite.image.create.mock.calls;
  expect(calls).toHaveLength(1);
  return calls[0][0].data as { meta: unknown; metadata: Record<string, unknown> };
}

beforeEach(() => {
  vi.clearAllMocks();
  redisMock.sysRedis.mGet.mockResolvedValue([String(VIEWER_ID)] as never);
  parserOverride.throws = false;
  mockAuthorizeBlockBridgeToken.mockResolvedValue({
    sub: `user:${VIEWER_ID}`,
    scopes: ['posts:write:self'],
    appId: APP_ID,
    appBlockId: 'apb_alpha',
    blockInstanceId: 'page_apb_alpha',
    blockId: 'my-app',
    maxBrowsingLevel: 1,
    ctx: { slotId: 'page', entityType: 'none' },
  });
  mockParseSubjectUserId.mockImplementation((sub: string) => Number(sub.slice('user:'.length)));
  mockIsAppBlocksEnabled.mockResolvedValue(true);
  mockIsAppBlocksPostCreationEnabled.mockResolvedValue(true);
  mockGetSessionUser.mockResolvedValue({ id: VIEWER_ID });
  mockCheckUploadAppRate.mockResolvedValue({ allowed: true });
  dbMock.dbWrite.image.create.mockResolvedValue({ id: IMAGE_ID } as never);
});

describe('blocks.persistAppUploadImage → Image.meta from the uploaded file', () => {
  it('stores the PNG `parameters` chunk as the row’s meta', async () => {
    storeHolds(await pngWithTextChunks({ parameters: A1111_PARAMETERS }));

    await expect(call()).resolves.toEqual({ imageId: IMAGE_ID });
    expect(writtenRow().meta).toMatchObject({
      prompt: 'a lighthouse at dusk, oil painting',
      negativePrompt: 'blurry',
      steps: 24,
      sampler: 'Euler a',
      cfgScale: 6.5,
      seed: 1234567,
    });
  });

  it('keeps provenance server-owned when the parameters spell provenance keys', async () => {
    storeHolds(
      await pngWithTextChunks({
        parameters: `${A1111_PARAMETERS}, blockUploadedAppId: forged-app, blockPublishedAppId: forged-app`,
      })
    );

    await call();
    const row = writtenRow();
    expect(row.metadata.blockUploadedAppId).toBe(APP_ID);
    expect('blockPublishedAppId' in row.metadata).toBe(false);
    expect(row.meta).toMatchObject({ prompt: 'a lighthouse at dusk, oil painting' });
    expect('blockUploadedAppId' in (row.meta as object)).toBe(false);
    expect('blockPublishedAppId' in (row.meta as object)).toBe(false);
  });

  it('stores a ComfyUI `prompt` graph chunk as meta', async () => {
    storeHolds(await pngWithTextChunks({ prompt: COMFY_PROMPT_GRAPH }));

    await call();
    expect(writtenRow().meta).toMatchObject({
      prompt: 'a lighthouse at dusk',
      seed: 7654321,
      steps: 20,
    });
  });

  it('a parser that throws on the file still uploads, with no meta', async () => {
    storeHolds(await pngWithTextChunks({ parameters: A1111_PARAMETERS }));
    parserOverride.throws = true;

    await expect(call()).resolves.toEqual({ imageId: IMAGE_ID });
    expect(writtenRow().meta).toBe(Prisma.JsonNull);
  });

  // Invariant guard: origin/main never read meta, so this holds there too.
  it('a truncated generation chunk still uploads, with no meta', async () => {
    storeHolds(await pngWithTextChunks({ prompt: '{"3":{"class_type":"KSampler","inputs":' }));

    await expect(call()).resolves.toEqual({ imageId: IMAGE_ID });
    expect(writtenRow().meta).toBe(Prisma.JsonNull);
  });
});
