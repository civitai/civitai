import { describe, it, expect, vi, beforeEach } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { redisMock } from '~/__tests__/mocks/redis.mock';
redisMock.redis.packed.set.mockImplementation(async () => undefined);
redisMock.redis.set.mockImplementation(async () => undefined);
redisMock.redis.scanIterator.mockImplementation(async function* () {});
const mockDbRead = dbMock.dbRead;

vi.mock('~/env/server', () => ({ env: { APPS_DOMAIN: 'civit.ai', LOGGING: '' } }));

/**
 * Reconstructs the SQL string from the args Prisma received. Two shapes:
 *   - getAppDetail uses a raw tagged template: `$queryRaw\`…\`` → arg[0] is a
 *     TemplateStringsArray.
 *   - listAvailable / getFeaturedBlocks build with `Prisma.sql` and call
 *     `$queryRaw(Prisma.sql\`…\`)` → arg[0] is a Prisma.Sql object carrying the
 *     assembled `.sql` string.
 */
function capturedSql(): string {
  expect(mockDbRead.$queryRaw).toHaveBeenCalled();
  const lastCall = mockDbRead.$queryRaw.mock.calls.at(-1);
  if (!lastCall) return '';
  const first = lastCall[0];
  // Prisma.Sql object form.
  if (first && typeof first === 'object' && typeof (first as { sql?: unknown }).sql === 'string') {
    return (first as { sql: string }).sql;
  }
  // Tagged-template form.
  const strings = first as unknown as TemplateStringsArray;
  const values = lastCall.slice(1);
  let sql = '';
  for (let i = 0; i < strings.length; i++) {
    sql += strings[i];
    if (i < values.length) sql += `$${i + 1}`;
  }
  return sql;
}

function detailRow(over: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'ab_1',
    block_id: 'cool-block',
    app_id: 'app_1',
    app_name: 'Cool App',
    status: 'approved',
    content_rating: 'g',
    version: '0.0.0',
    approved_scopes: [],
    external_url: 'https://example.com/cool',
    // DEPLOY-GATE: deployed so the detail read returns its projection even for the
    // on-platform (external_url:null) variant of this fixture (a NULL timestamp on
    // a NULL external_url would be treated as never-deployed → NOT_FOUND).
    current_version_deployed_at: new Date('2026-01-01T00:00:00Z'),
    install_count: 0n,
    avg_rating: null,
    review_count: 0n,
    screenshots: null,
    manifest: { name: 'Cool Block', description: 'Does cool things' },
    ...over,
  };
}

function listRow(over: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'ab_1',
    block_id: 'cool-block',
    app_id: 'app_1',
    app_name: 'Cool App',
    manifest: { name: 'Cool Block' },
    install_count: 0n,
    category: null,
    external_url: 'https://example.com/cool',
    approved_scopes: [],
    avg_rating: null,
    review_count: 0n,
    screenshots: null,
    sort_key: '0',
    ...over,
  };
}

describe('BlockRegistry.getAppDetail — externalUrl projection', () => {
  beforeEach(() => {
    mockDbRead.$queryRaw.mockClear();
    mockDbRead.$queryRaw.mockResolvedValue([detailRow()]);
  });

  it('SELECTs the external_url column', async () => {
    const { BlockRegistry } = await import('../block-registry.service');
    await BlockRegistry.getAppDetail('ab_1');
    expect(capturedSql()).toMatch(/ab\.external_url/);
  });

  it('projects external_url onto the public detail', async () => {
    const { BlockRegistry } = await import('../block-registry.service');
    const detail = await BlockRegistry.getAppDetail('ab_1');
    expect(detail!.externalUrl).toBe('https://example.com/cool');
  });

  it('a NULL external_url (on-platform app) projects null', async () => {
    mockDbRead.$queryRaw.mockResolvedValueOnce([detailRow({ external_url: null })]);
    const { BlockRegistry } = await import('../block-registry.service');
    const detail = await BlockRegistry.getAppDetail('ab_1');
    expect(detail!.externalUrl).toBeNull();
  });

  it('externalUrl is part of the PublicAppDetail allowlist shape', async () => {
    const { BlockRegistry } = await import('../block-registry.service');
    const detail = await BlockRegistry.getAppDetail('ab_1');
    expect(Object.keys(detail!)).toContain('externalUrl');
  });
});

describe('BlockRegistry.listAvailable — externalUrl projection', () => {
  beforeEach(() => {
    mockDbRead.$queryRaw.mockClear();
    mockDbRead.$queryRaw.mockResolvedValue([listRow()]);
  });

  it('SELECTs the external_url column', async () => {
    const { BlockRegistry } = await import('../block-registry.service');
    await BlockRegistry.listAvailable({ sort: 'newest', limit: 20 });
    expect(capturedSql()).toMatch(/ab\.external_url/);
  });

  it('projects external_url onto each listing item', async () => {
    const { BlockRegistry } = await import('../block-registry.service');
    const res = await BlockRegistry.listAvailable({ sort: 'newest', limit: 20 });
    expect(res.items[0].externalUrl).toBe('https://example.com/cool');
  });

  it('a NULL external_url projects null on the listing item', async () => {
    mockDbRead.$queryRaw.mockResolvedValueOnce([listRow({ external_url: null })]);
    const { BlockRegistry } = await import('../block-registry.service');
    const res = await BlockRegistry.listAvailable({ sort: 'newest', limit: 20 });
    expect(res.items[0].externalUrl).toBeNull();
  });
});

describe('BlockRegistry.getFeaturedBlocks — externalUrl projection', () => {
  beforeEach(() => {
    mockDbRead.$queryRaw.mockClear();
    mockDbRead.$queryRaw.mockResolvedValue([listRow()]);
  });

  it('SELECTs the external_url column', async () => {
    const { BlockRegistry } = await import('../block-registry.service');
    await BlockRegistry.getFeaturedBlocks(10);
    expect(capturedSql()).toMatch(/ab\.external_url/);
  });

  it('projects external_url onto each featured item', async () => {
    const { BlockRegistry } = await import('../block-registry.service');
    const items = await BlockRegistry.getFeaturedBlocks(10);
    expect(items[0].externalUrl).toBe('https://example.com/cool');
  });
});

describe('BlockRegistry.getFeaturedBlocks — coverUrl projection', () => {
  beforeEach(() => {
    mockDbRead.$queryRaw.mockClear();
    mockDbRead.$queryRaw.mockResolvedValue([listRow()]);
  });

  it('SELECTs the screenshots column', async () => {
    const { BlockRegistry } = await import('../block-registry.service');
    await BlockRegistry.getFeaturedBlocks(10);
    expect(capturedSql()).toMatch(/ab\.screenshots/);
  });

  it('coverUrl = the FIRST public screenshot URL when screenshots exist', async () => {
    mockDbRead.$queryRaw.mockResolvedValueOnce([
      listRow({
        id: 'ab_cover',
        screenshots: [
          { key: 'blocks/ab_cover/0.png', index: 0, ext: 'png', contentType: 'image/png' },
        ],
      }),
    ]);
    const { BlockRegistry } = await import('../block-registry.service');
    const items = await BlockRegistry.getFeaturedBlocks(10);
    expect(items[0].coverUrl).toBe('/api/blocks/screenshot/ab_cover/0.png');
    // The raw MinIO key must never appear on the wire.
    expect(JSON.stringify(items)).not.toContain('blocks/ab_cover/0.png');
  });

  it('coverUrl is null when the app shipped no screenshots', async () => {
    mockDbRead.$queryRaw.mockResolvedValueOnce([listRow({ screenshots: null })]);
    const { BlockRegistry } = await import('../block-registry.service');
    const items = await BlockRegistry.getFeaturedBlocks(10);
    expect(items[0].coverUrl).toBeNull();
  });
});
