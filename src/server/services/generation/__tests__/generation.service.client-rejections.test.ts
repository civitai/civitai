import { describe, expect, it, vi } from 'vitest';

/**
 * civitai#3845 TIER 1, the half of the fix that does NOT live in the route.
 *
 * `/api/generation/data` used to answer its entire catch with `400 { message:
 * e.message }`. That made every failure a 400 BY ACCIDENT — including the two
 * places where this service rejects the caller with a message we wrote, thrown as
 * a plain `Error`. Now that the route delegates to `handleEndpointError`, a plain
 * `Error` is classified as a server fault and collapses into a generic 500, which
 * would silently downgrade real client feedback into "An unexpected error
 * occurred".
 *
 * 🔴 The `default:` arm is REACHABLE, not theoretical: `getGenerationDataSchema`
 * accepts `type: 'audio'` and `getGenerationData`'s switch has no arm for it, so
 * `GET /api/generation/data?type=audio&id=1` lands there on the public,
 * unauthenticated surface. This suite pins that both sites now raise a
 * `BAD_REQUEST` TRPCError carrying their original text — which is what
 * `handleEndpointError` passes through byte-identically as `400 { message }`.
 *
 * Observed RED on the base branch: `code` was `undefined` (a plain `Error`) at
 * both sites.
 */

// Collapse the heavy sibling-service graph — the arms under test are pure control
// flow, but importing generation.service pulls in DB / search-index / image infra.
vi.mock('~/server/redis/client', () => {
  const make = (): any => new Proxy(() => 'k', { get: () => make() });
  const keyProxy = make();
  return {
    redis: { packed: { get: vi.fn(), set: vi.fn(), mGet: vi.fn() }, get: vi.fn(), set: vi.fn() },
    sysRedis: { hGet: vi.fn() },
    REDIS_KEYS: keyProxy,
    REDIS_SYS_KEYS: keyProxy,
    REDIS_SUB_KEYS: keyProxy,
    withSysReadDeadline: vi.fn((p: Promise<unknown>) => p),
  };
});
vi.mock('~/server/redis/fail-open-log', () => ({ logSysRedisFailOpen: vi.fn() }));
const imageFindUnique = dbMock.dbRead.image.findUnique;
vi.mock('~/server/clickhouse/client', () => ({ clickhouse: {} }));
vi.mock('~/server/db/db-lag-helpers', () => ({
  getDbWithoutLag: vi.fn(),
  getDbWithoutLagBatch: vi.fn(),
}));
vi.mock('~/server/services/orchestrator/ecosystems/wan.handler', () => ({
  wanBaseModelGroupIdMap: {},
}));
vi.mock('~/server/search-index', () => ({ modelsSearchIndex: {} }));
vi.mock('~/server/services/common.service', () => ({ hasEntityAccess: vi.fn() }));
vi.mock('~/server/services/model-file.service', () => ({ getFilesForModelVersionCache: vi.fn() }));
vi.mock('~/server/redis/resource-data.redis', () => ({ resourceDataCache: {} }));
vi.mock('~/server/services/model.service', () => ({ getFeaturedModels: vi.fn() }));
vi.mock('~/server/services/model-version.service', () => ({
  getLinkedVaeIds: vi.fn(),
  bustMvCache: vi.fn(),
}));
vi.mock('~/server/services/image.service', () => ({ imagesForModelVersionsCache: {} }));
vi.mock('~/server/services/generation/version-generation-state.service', () => ({
  getVisibleSystemWildcardSetIdsByVersionId: vi.fn(),
}));
vi.mock('~/server/utils/otel-helpers', () => ({
  withSpan: (_name: string, fn: () => unknown) => fn(),
}));

import { TRPCError } from '@trpc/server';
import { getHTTPStatusCodeFromError } from '@trpc/server/http';
import { getGenerationData } from '~/server/services/generation/generation.service';
import type { GetGenerationDataSchema } from '~/server/schema/generation.schema';
import { dbMock } from '~/__tests__/mocks/db.mock';

describe('generation.service — caller rejections are TRPCErrors, not plain Errors', () => {
  it('an unsupported generation data type raises BAD_REQUEST with its own text', async () => {
    const query = { type: 'audio', id: 1 } as unknown as GetGenerationDataSchema;

    const thrown = await getGenerationData({ query }).then(
      () => undefined,
      (e: unknown) => e
    );

    // 🔴 Asserted as an instance AND by code AND by mapped status. `instanceof`
    // alone passes for any TRPCError — including an INTERNAL_SERVER_ERROR, which
    // is exactly the 500 this test exists to rule out.
    expect(thrown, 'the unsupported-type arm must still throw').toBeInstanceOf(TRPCError);
    expect((thrown as TRPCError).code).toBe('BAD_REQUEST');
    expect(getHTTPStatusCodeFromError(thrown as TRPCError)).toBe(400);
    // The text is client feedback and must survive verbatim — `handleEndpointError`
    // passes a non-JSON 4xx message through as `{ message: <this> }`.
    expect((thrown as TRPCError).message).toBe('unsupported generation data type');
  });

  it('an audio MEDIA item raises BAD_REQUEST with its own text', async () => {
    // 🔴 The SECOND converted throw, in `getMediaGenerationData`. The blind audit
    // found this arm was a MUTATION SURVIVOR: reverting it to `throw new Error(…)`
    // left the entire 15.4k-test suite green, because the sibling arm at the top
    // of `getGenerationData` was the only one with coverage. The two are converted
    // for the same reason and must be pinned the same way.
    //
    // Reached the way production reaches it: `?type=image&id=…` pointing at a
    // media row whose OWN type is audio. `type` is derived as
    // `baseModel ? getBaseModelMediaType(baseModel) ?? media.type : media.type`,
    // and with no resource rows there is no baseModel — so it is `media.type`.
    imageFindUnique.mockResolvedValue({
      id: 7,
      type: 'audio',
      url: 'some-url',
      meta: {},
      hideMeta: false,
      userId: 555,
      height: 0,
      width: 0,
      createdAt: new Date('2026-01-01'),
    });
    const query = { type: 'image', id: 7, generation: false } as unknown as GetGenerationDataSchema;

    const thrown = await getGenerationData({ query }).then(
      () => undefined,
      (e: unknown) => e
    );

    expect(thrown, 'the audio-media arm must still throw').toBeInstanceOf(TRPCError);
    expect((thrown as TRPCError).code).toBe('BAD_REQUEST');
    expect(getHTTPStatusCodeFromError(thrown as TRPCError)).toBe(400);
    expect((thrown as TRPCError).message).toBe('not implemented');
  });

  it('INVARIANT: it is not a driver-authored message, so it is never genericized', async () => {
    // `isDriverAuthoredMessage` genericizes a 4xx whose text IS a driver error's
    // own. This message is ours, and no driver error is in the cause chain, so the
    // 400 keeps its detail. Green on both sides of the fix — recorded because the
    // "keeps its exact text" claim above depends on it.
    const { isDriverAuthoredMessage } = await import('~/server/utils/errorHandling');
    const query = { type: 'audio', id: 1 } as unknown as GetGenerationDataSchema;
    const thrown = (await getGenerationData({ query }).then(
      () => undefined,
      (e: unknown) => e
    )) as TRPCError;

    expect(isDriverAuthoredMessage(thrown.message, thrown)).toBe(false);
  });
});
