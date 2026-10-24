import { describe, it, expect, vi, beforeEach } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { redisMock } from '~/__tests__/mocks/redis.mock';
redisMock.redis.packed.set.mockImplementation(async () => undefined);
redisMock.redis.set.mockImplementation(async () => undefined);
redisMock.redis.scanIterator.mockImplementation(async function* () {});
const mockDbRead = dbMock.dbRead;

vi.mock('~/env/server', () => ({ env: { APPS_DOMAIN: 'civit.ai', LOGGING: '' } }));

/** Reconstructs the SQL string from the tagged-template OR Prisma.sql args. */
function capturedSql(): string {
  expect(mockDbRead.$queryRaw).toHaveBeenCalled();
  const lastCall = mockDbRead.$queryRaw.mock.calls.at(-1);
  if (!lastCall) return '';
  const first = lastCall[0] as { sql?: string } | TemplateStringsArray;
  // Prisma.sql form (listAvailable/getFeaturedBlocks build with Prisma.sql).
  if (first && typeof (first as { sql?: string }).sql === 'string') {
    return (first as { sql: string }).sql;
  }
  // Raw tagged-template form (getAppDetail/listForModel).
  const strings = first as unknown as TemplateStringsArray;
  const values = lastCall.slice(1);
  let sql = '';
  for (let i = 0; i < strings.length; i++) {
    sql += strings[i];
    if (i < values.length) sql += `$${i + 1}`;
  }
  return sql;
}

/** One raw detail row (snake_case) as getAppDetail's $queryRaw returns it. */
function detailRow(over: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'ab_1',
    block_id: 'cool-block',
    app_id: 'app_1',
    app_name: 'Cool App',
    status: 'approved',
    content_rating: 'g',
    version: '1.0.0',
    approved_scopes: [],
    external_url: null,
    current_version_deployed_at: new Date('2026-01-01T00:00:00Z'),
    install_count: 0n,
    avg_rating: null,
    review_count: 0n,
    screenshots: null,
    manifest: { name: 'Cool Block', description: 'does things' },
    ...over,
  };
}

const DEPLOY_GATE_CLAUSE =
  /ab\.external_url IS NOT NULL OR ab\.current_version_deployed_at IS NOT NULL/i;

describe('BlockRegistry.listAvailable — DEPLOY-GATE WHERE clause', () => {
  beforeEach(() => {
    mockDbRead.$queryRaw.mockClear();
    mockDbRead.$queryRaw.mockResolvedValue([]);
  });

  it('WHERE requires a deployed on-platform app (or an external one)', async () => {
    const { BlockRegistry } = await import('../block-registry.service');
    await BlockRegistry.listAvailable({ sort: 'newest', limit: 20 });
    expect(capturedSql()).toMatch(DEPLOY_GATE_CLAUSE);
  });
});

describe('BlockRegistry.getFeaturedBlocks — DEPLOY-GATE WHERE clause', () => {
  beforeEach(() => {
    mockDbRead.$queryRaw.mockClear();
    mockDbRead.$queryRaw.mockResolvedValue([]);
  });

  it('WHERE requires a deployed on-platform app (or an external one)', async () => {
    const { BlockRegistry } = await import('../block-registry.service');
    await BlockRegistry.getFeaturedBlocks(10);
    expect(capturedSql()).toMatch(DEPLOY_GATE_CLAUSE);
  });
});

describe('BlockRegistry.listForModel — DEPLOY-GATE WHERE clause (model slots)', () => {
  beforeEach(() => {
    mockDbRead.$queryRaw.mockClear();
    mockDbRead.$queryRaw.mockResolvedValue([]);
  });

  it('every install/subscription/default branch requires a deployed origin', async () => {
    const { BlockRegistry } = await import('../block-registry.service');
    await BlockRegistry.listForModel({
      modelId: 123,
      slotId: 'model.sidebar_top',
      modelType: 'Checkpoint',
      modelNsfwLevel: 1,
      viewerUserId: 7,
      redCapable: false,
    });
    const sql = capturedSql();
    // One clause per UNION branch (rank 1-4).
    const matches = sql.match(new RegExp(DEPLOY_GATE_CLAUSE.source, 'gi')) ?? [];
    expect(matches.length).toBe(4);
  });
});

describe('BlockRegistry.getAppDetail — DEPLOY-GATE (app-layer)', () => {
  beforeEach(() => {
    mockDbRead.$queryRaw.mockClear();
  });

  it('HIDES (null) an approved on-platform app that has NEVER deployed', async () => {
    mockDbRead.$queryRaw.mockResolvedValue([
      detailRow({ external_url: null, current_version_deployed_at: null }),
    ]);
    const { BlockRegistry } = await import('../block-registry.service');
    expect(await BlockRegistry.getAppDetail('ab_1')).toBeNull();
  });

  it('SHOWS a deployed on-platform app', async () => {
    mockDbRead.$queryRaw.mockResolvedValue([
      detailRow({ current_version_deployed_at: new Date('2026-01-01T00:00:00Z') }),
    ]);
    const { BlockRegistry } = await import('../block-registry.service');
    const detail = await BlockRegistry.getAppDetail('ab_1');
    expect(detail).not.toBeNull();
    expect(detail!.id).toBe('ab_1');
  });

  it('SHOWS a RE-DEPLOYING app (timestamp stays set while a new version rebuilds)', async () => {
    mockDbRead.$queryRaw.mockResolvedValue([
      detailRow({ current_version_deployed_at: new Date('2025-06-01T00:00:00Z') }),
    ]);
    const { BlockRegistry } = await import('../block-registry.service');
    expect(await BlockRegistry.getAppDetail('ab_1')).not.toBeNull();
  });

  it('SHOWS an OFF-SITE (external-link) app even though it never deploys (exempt)', async () => {
    mockDbRead.$queryRaw.mockResolvedValue([
      detailRow({ external_url: 'https://example.com/app', current_version_deployed_at: null }),
    ]);
    const { BlockRegistry } = await import('../block-registry.service');
    const detail = await BlockRegistry.getAppDetail('ab_1');
    expect(detail).not.toBeNull();
    expect(detail!.externalUrl).toBe('https://example.com/app');
  });
});
