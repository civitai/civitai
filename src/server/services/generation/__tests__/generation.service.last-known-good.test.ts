import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The generation kill switch and the gate rules are MODERATION controls read from sysRedis. A
 * failed read must never turn an operator's "generation disabled" or "model hidden" back on:
 *   - last value known in this process  → serve it;
 *   - nothing known                     → fail CLOSED (kill switch: disabled with a clear message;
 *                                          gate rules: refused with SERVICE_UNAVAILABLE).
 * Fault injection: sysRedis reads that reject, and one that never settles while the read deadline
 * rejects. The service module is re-imported per test, so "known" never leaks between tests.
 */

import { redisMock } from '~/__tests__/mocks/redis.mock';
import { loggingMock } from '~/__tests__/mocks/logging.mock';
import { resetSharedMocks } from '~/__tests__/mocks';

// The canonical sysRedis mock (src/__tests__/setup.ts); only the commands these reads use.
const mockHGet = redisMock.sysRedis.hGet;
const mockGet = redisMock.sysRedis.get;
const mockHGetAll = redisMock.sysRedis.hGetAll;
const mockWithSysReadDeadline = redisMock.withSysReadDeadline;

/** The `served` field of the sysredis-fail-open warnings logged so far. */
const servedLogs = () =>
  loggingMock.logToAxiom.mock.calls
    .map(([payload]: [Record<string, unknown>]) => payload)
    .filter((payload) => payload?.name === 'sysredis-fail-open')
    .map((payload) => payload.served);

vi.mock('~/server/clickhouse/client', () => ({ clickhouse: {} }));
vi.mock('~/server/db/db-lag-helpers', () => ({
  getDbWithoutLag: vi.fn(),
  getDbWithoutLagBatch: vi.fn(),
}));
vi.mock('~/server/search-index', () => ({ modelsSearchIndex: {} }));
vi.mock('~/server/services/common.service', () => ({ hasEntityAccess: vi.fn() }));
vi.mock('~/server/services/model-file.service', () => ({ getFilesForModelVersionCache: vi.fn() }));
vi.mock('~/server/redis/resource-data.redis', () => ({ resourceDataCache: {} }));
vi.mock('~/server/services/model.service', () => ({ getFeaturedModels: vi.fn() }));
vi.mock('~/server/services/model-version.service', () => ({ getLinkedVaeIds: vi.fn() }));
vi.mock('~/server/services/image.service', () => ({ imagesForModelVersionsCache: {} }));
vi.mock('~/server/services/generation/version-generation-state.service', () => ({
  getVisibleSystemWildcardSetIdsByVersionId: vi.fn(),
}));
vi.mock('~/server/utils/otel-helpers', () => ({
  withSpan: (_name: string, fn: () => unknown) => fn(),
}));
// NB: leave ~/server/services/feature-flags.service REAL — it exports `userTiers`
// (a constant consumed by user.schema at module load). resolveTestingAccess only
// reaches its isFlipt at runtime for a NON-empty user; the tests pass `{}`, so the
// flag call is short-circuited and never opens a connection.

type Service = typeof import('~/server/services/generation/generation.service');
let svc: Service;

beforeEach(async () => {
  resetSharedMocks();
  mockWithSysReadDeadline.mockImplementation((p: Promise<unknown>) => p);
  vi.resetModules();
  svc = await import('~/server/services/generation/generation.service');
});

const status = (value: object) => JSON.stringify(value);

describe('generation kill switch on a sysRedis failure', () => {
  it('stays DISABLED when the last value this process read was disabled', async () => {
    mockHGet.mockResolvedValueOnce(status({ mode: 'disabled', message: 'maintenance' }));
    expect((await svc.getGenerationStatus()).mode).toBe('disabled');

    mockHGet.mockRejectedValue(new Error('sysRedis connection is down'));
    const result = await svc.getGenerationStatus();

    expect(result.mode).toBe('disabled');
    expect(result.available).toBe(false);
    expect(result.message).toBe('maintenance');
    expect(servedLogs()).toEqual(['last-known-good']);
  });

  it('stays MEMBER-ONLY for self-hosted when that is what was last read', async () => {
    mockHGet.mockResolvedValueOnce(status({ mode: 'enabled', selfHostedMode: 'memberOnly' }));
    await svc.getGenerationStatus();
    mockHGet.mockRejectedValue(new Error('ECONNRESET'));

    expect((await svc.getGenerationStatus()).selfHostedMode).toBe('memberOnly');
  });

  it('with nothing known, fails CLOSED: disabled, with a clear message', async () => {
    mockHGet.mockRejectedValue(new Error('sysRedis connection is down'));

    const result = await svc.getGenerationStatus();

    expect(result.mode).toBe('disabled');
    expect(result.selfHostedMode).toBe('disabled');
    expect(result.available).toBe(false);
    expect(result.message).toBe(
      'Generation is temporarily unavailable. Please try again in a few minutes.'
    );
    expect(servedLogs()).toEqual(['fail-closed']);
  });

  it('with nothing known and a read that never settles, the deadline fails it CLOSED', async () => {
    mockHGet.mockReturnValue(new Promise(() => undefined));
    mockWithSysReadDeadline.mockRejectedValue(new Error('sysRedis read timed out after 2000ms'));

    expect((await svc.getGenerationStatus()).mode).toBe('disabled');
  });

  it('a later successful read replaces the last-known value (re-enable is seen)', async () => {
    mockHGet.mockResolvedValueOnce(status({ mode: 'disabled' }));
    await svc.getGenerationStatus();
    mockHGet.mockResolvedValueOnce(status({ mode: 'enabled' }));

    expect((await svc.getGenerationStatus()).mode).toBe('enabled');
    mockHGet.mockRejectedValue(new Error('down'));
    expect((await svc.getGenerationStatus()).mode).toBe('enabled');
  });

  it('a key that is simply absent is a successful read: schema defaults, enabled', async () => {
    mockHGet.mockResolvedValue(null);
    expect((await svc.getGenerationStatus()).mode).toBe('enabled');
    expect(servedLogs()).toEqual([]);
  });
});

const hiddenRule = {
  id: 'r1',
  name: 'pre-launch',
  availableTo: 'moderators',
  presentation: 'hidden',
  ecosystems: ['Ideogram'],
  workflows: [],
  modelVersionIds: [123],
};

describe('gate rules on a sysRedis failure', () => {
  it('keeps the last rules this process read (a hidden model stays hidden)', async () => {
    mockGet.mockResolvedValue('1');
    mockHGetAll.mockResolvedValueOnce({ r1: JSON.stringify(hiddenRule) });
    expect((await svc.getGateRules()).map((r) => r.id)).toEqual(['r1']);

    mockHGetAll.mockRejectedValue(new Error('ECONNREFUSED'));
    const rules = await svc.getGateRules();

    expect(rules.map((r) => r.id)).toEqual(['r1']);
    expect(rules[0].modelVersionIds).toEqual([123]);
  });

  it('with nothing known, refuses with SERVICE_UNAVAILABLE instead of "no rules"', async () => {
    mockGet.mockResolvedValue('1');
    mockHGetAll.mockRejectedValue(new Error('ECONNREFUSED'));

    await expect(svc.getGateRules()).rejects.toMatchObject({
      code: 'SERVICE_UNAVAILABLE',
      message: 'Generation is temporarily unavailable. Please try again in a few minutes.',
    });
  });

  it('the model-page canGenerate view does not throw while the rules are unknown', async () => {
    mockGet.mockResolvedValue('1');
    mockHGetAll.mockRejectedValue(new Error('ECONNREFUSED'));

    const blocked = await svc.getCanGenerateHiddenGates({});
    expect([...blocked.versionIds]).toEqual([]);
  });

  it('the model-page canGenerate view keeps hiding a last-known hidden model', async () => {
    mockGet.mockResolvedValue('1');
    mockHGetAll.mockResolvedValueOnce({ r1: JSON.stringify(hiddenRule) });
    await svc.getGateRules();
    mockHGetAll.mockRejectedValue(new Error('ECONNREFUSED'));

    const blocked = await svc.getCanGenerateHiddenGates({});
    expect([...blocked.versionIds]).toEqual([123]);
  });
});
