import { describe, expect, it, vi } from 'vitest';

/**
 * Regression guard for the moderator-only 'Scheduled' generation gate.
 *
 * A scheduled version is covered by `GenerationCoverage` the moment it lands in
 * `EcosystemCheckpoints` (that branch of the view has no status condition), so
 * the ONLY thing keeping it out of the generator is the status check here. This
 * matrix pins both halves: moderators can exercise a scheduled release before
 * its publish time, and nobody else can - including the owner.
 */

// Collapse the heavy sibling-service graph - `getResourceCanGenerate` is pure,
// but importing generation.service pulls in DB / search-index / image infra.
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
vi.mock('~/server/db/client', () => ({ dbRead: {}, dbWrite: {} }));
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

import { getResourceCanGenerate } from '~/server/services/generation/generation.service';
import { ModelVersionFlag } from '~/shared/constants/model-version-flags.constants';

const noHiddenGates = { ecosystems: new Set<string>(), versionIds: new Set<number>() };

const OWNER_ID = 999;

/** Covered and public, owned by OWNER_ID - generatable except for its status. */
const baseResource = {
  id: 1,
  availability: 'Public',
  baseModel: 'SD 1.5',
  covered: true,
  modelUserId: OWNER_ID,
  flags: ModelVersionFlag.None,
};

const canGenerate = (status: string, user: { id?: number; isModerator?: boolean }) =>
  getResourceCanGenerate({
    resource: { ...baseResource, status },
    user,
    hiddenGates: noHiddenGates,
  });

const mod = { id: 123, isModerator: true };
const normalUser = { id: 123, isModerator: false };
const owner = { id: OWNER_ID, isModerator: false };

describe('getResourceCanGenerate — Scheduled status', () => {
  it('lets a moderator generate with a scheduled version', () => {
    expect(canGenerate('Scheduled', mod)).toBe(true);
  });

  it('BLOCKS a normal user on a scheduled version', () => {
    expect(canGenerate('Scheduled', normalUser)).toBe(false);
  });

  it('blocks the owner too — this is a moderator gate, not an ownership one', () => {
    expect(canGenerate('Scheduled', owner)).toBe(false);
  });

  it('blocks an anonymous viewer on a scheduled version', () => {
    expect(canGenerate('Scheduled', {})).toBe(false);
  });

  it('does not widen any other non-generatable status for moderators', () => {
    expect(canGenerate('Unpublished', mod)).toBe(false);
    expect(canGenerate('UnpublishedViolation', mod)).toBe(false);
    expect(canGenerate('Deleted', mod)).toBe(false);
  });

  it('leaves the already-valid statuses alone', () => {
    for (const status of ['Published', 'Draft', 'Training']) {
      expect(canGenerate(status, mod)).toBe(true);
    }
    // Draft/Training are private, so a non-owner non-mod still cannot use them.
    expect(canGenerate('Published', normalUser)).toBe(true);
    expect(canGenerate('Draft', normalUser)).toBe(false);
  });

  it('still respects the GenerationDisabled flag on a scheduled version', () => {
    const result = getResourceCanGenerate({
      resource: {
        ...baseResource,
        status: 'Scheduled',
        flags: ModelVersionFlag.GenerationDisabled,
      },
      user: mod,
      hiddenGates: noHiddenGates,
    });
    expect(result).toBe(false);
  });

  it('still respects coverage on a scheduled version', () => {
    const result = getResourceCanGenerate({
      resource: { ...baseResource, status: 'Scheduled', covered: false },
      user: mod,
      hiddenGates: noHiddenGates,
    });
    expect(result).toBe(false);
  });
});
