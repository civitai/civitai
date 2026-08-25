import { describe, it, expect, vi, beforeEach } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { redisMock } from '~/__tests__/mocks/redis.mock';

/**
 * F-E E4 — service tests for curation:
 *   - `BlockRegistry.getFeaturedBlocks` (anon-capable featured rail).
 *   - `BlockRegistry.setMarketplaceMeta` (MOD-ONLY curation write).
 *   - `BlockRegistry.getMarketplaceMeta` (MOD-ONLY seed read).
 *
 * The featured rail is anon-CAPABLE (dark today behind the mod-segmented flag),
 * so its exposure protections are pinned the same way E1/E2/E3 pin theirs — the
 * tests FAIL if the projection widens or the approved+featured filter regresses.
 *
 * setMarketplaceMeta is mod-only at the ROUTER (covered by the router test); the
 * SERVICE tests pin the data-integrity rules it enforces regardless of caller:
 * off-taxonomy categories are rejected, featuring is approved-only, and only the
 * provided fields are written (a patch, not a full overwrite).
 *
 * No DB in unit tests: dbRead/dbWrite are mocked. We capture the featured SQL +
 * the write `data` to assert the SHAPE.
 */

// One local served both clients, and the three entry points here do NOT agree on which one:
// getFeaturedBlocks reads `dbRead.$queryRaw` (block-registry.service:3465), getMarketplaceMeta
// reads `dbRead.appBlock.findUnique` (:3534), and setMarketplaceMeta uses `dbWrite` for both its
// findUnique (:3588) and its update (:3613). So this file splits per CASE, not per path — it is
// the one file where `appBlock.findUnique` genuinely appears on both clients.
//
// 🔴 The three `expect(...appBlock.update).not.toHaveBeenCalled()` are safe to route
// mechanically: `update` is dbWrite-only, so there is no client a mis-route could hide behind.
const mockDbRead = dbMock.dbRead;
const mockDbWrite = dbMock.dbWrite;
const mockRedis = redisMock.redis;

// `scanIterator` is consumed with `for await`; a vivified spy returns undefined, which throws
// rather than iterating.
mockRedis.scanIterator.mockImplementation(async function* () {});
vi.mock('~/env/server', () => ({ env: { APPS_DOMAIN: 'civit.ai', LOGGING: '' } }));

function capturedSql(): string {
  expect(mockDbRead.$queryRaw).toHaveBeenCalled();
  const lastCall = mockDbRead.$queryRaw.mock.calls.at(-1);
  if (!lastCall) return '';
  const first = lastCall[0] as unknown;
  if (first && typeof first === 'object' && typeof (first as { sql?: unknown }).sql === 'string') {
    return (first as { sql: string }).sql;
  }
  const strings = first as unknown as TemplateStringsArray;
  const values = lastCall.slice(1);
  let sql = '';
  for (let i = 0; i < strings.length; i++) {
    sql += strings[i];
    if (i < values.length) sql += `$${i + 1}`;
  }
  return sql;
}

/** One raw featured-rail row (snake_case), carrying private manifest fields the
 * projection must strip. */
function featuredRow(over: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'ab_1',
    block_id: 'cool-block',
    app_id: 'app_1',
    app_name: 'Cool App',
    install_count: 9n,
    category: 'games',
    approved_scopes: ['ai:write:budgeted', 'models:read:self', 'buzz:read:self', 'social:tip:self'],
    avg_rating: 4.7,
    review_count: 21n,
    manifest: {
      name: 'Cool Block',
      description: 'Does cool things',
      targets: [{ slotId: 'model.sidebar_top', secretCfg: 'leak-me' }],
      trustTier: 'internal',
      iframe: { src: 'https://cool-block.internal.example/' },
      renderMode: 'iframe',
      scopes: ['INTERNAL_secret_scope'],
      settings: { apiKey: 'super-secret' },
    },
    ...over,
  };
}

describe('BlockRegistry.getFeaturedBlocks — featured rail exposure (F-E E4)', () => {
  beforeEach(() => {
    mockDbRead.$queryRaw.mockClear();
    mockDbRead.$queryRaw.mockResolvedValue([featuredRow()]);
  });

  it('SQL hard-filters status=approved AND featured=true (only curated approved apps)', async () => {
    const { BlockRegistry } = await import('../block-registry.service');
    await BlockRegistry.getFeaturedBlocks(12);
    const sql = capturedSql();
    expect(sql).toMatch(/ab\.status\s*=\s*'approved'/);
    expect(sql).toMatch(/ab\.featured\s*=\s*true/);
  });

  it('orders by featured_order ASC NULLS LAST then a deterministic tiebreak', async () => {
    const { BlockRegistry } = await import('../block-registry.service');
    await BlockRegistry.getFeaturedBlocks(12);
    const sql = capturedSql();
    expect(sql).toMatch(/ORDER BY\s+ab\.featured_order\s+ASC\s+NULLS\s+LAST/i);
    // install_count is the tiebreak, ab.id the final total order.
    expect(sql).toMatch(/install_count\s+DESC/i);
    expect(sql).toMatch(/ab\.id\s+ASC/i);
  });

  it('projects ONLY the public AvailableBlock allowlist — no private/internal leak', async () => {
    const { BlockRegistry } = await import('../block-registry.service');
    const items = await BlockRegistry.getFeaturedBlocks(12);
    expect(items).toHaveLength(1);
    const item = items[0];
    expect(Object.keys(item).sort()).toEqual(
      [
        'appId',
        'appName',
        'avgRating',
        'blockId',
        'category',
        'coverUrl',
        'externalUrl',
        'id',
        'installCount',
        'manifest',
        'reviewCount',
        'scopesSummary',
      ].sort()
    );
    const manifest = item.manifest as Record<string, unknown>;
    expect(manifest.name).toBe('Cool Block');
    expect(manifest.description).toBe('Does cool things');
    expect(manifest.targets).toEqual([{ slotId: 'model.sidebar_top' }]);
    for (const forbidden of ['trustTier', 'iframe', 'renderMode', 'scopes', 'settings']) {
      expect(manifest, `manifest leaked "${forbidden}"`).not.toHaveProperty(forbidden);
    }
    // The whole serialized rail carries no secret value (mutation-test).
    const serialized = JSON.stringify(items);
    expect(serialized).not.toContain('super-secret');
    expect(serialized).not.toContain('internal.example');
    expect(serialized).not.toContain('leak-me');
    expect(serialized).not.toContain('INTERNAL_secret_scope');
  });

  it('scopesSummary comes from approved_scopes (capped), category passes through', async () => {
    const { BlockRegistry, MARKETPLACE_SCOPES_SUMMARY_LIMIT } = await import(
      '../block-registry.service'
    );
    const items = await BlockRegistry.getFeaturedBlocks(12);
    expect(items[0].scopesSummary).toEqual(
      ['ai:write:budgeted', 'models:read:self', 'buzz:read:self', 'social:tip:self'].slice(
        0,
        MARKETPLACE_SCOPES_SUMMARY_LIMIT
      )
    );
    expect(items[0].category).toBe('games');
  });

  it('a NULL approved_scopes / malformed manifest do not crash or leak', async () => {
    mockDbRead.$queryRaw.mockResolvedValueOnce([
      featuredRow({ approved_scopes: null, manifest: null }),
    ]);
    const { BlockRegistry } = await import('../block-registry.service');
    const items = await BlockRegistry.getFeaturedBlocks(12);
    expect(items[0].scopesSummary).toEqual([]);
    expect(items[0].manifest).toEqual({});
  });
});

describe('BlockRegistry.setMarketplaceMeta — data-integrity rules (F-E E4)', () => {
  beforeEach(() => {
    mockDbWrite.appBlock.findUnique.mockReset();
    mockDbWrite.appBlock.update.mockReset();
    mockDbWrite.appBlock.update.mockResolvedValue({
      id: 'ab_1',
      status: 'approved',
      category: 'games',
      featured: true,
      featuredOrder: 3,
    });
  });

  it('rejects an off-taxonomy category before any write (defense-in-depth)', async () => {
    const { BlockRegistry } = await import('../block-registry.service');
    await expect(
      BlockRegistry.setMarketplaceMeta({
        appBlockId: 'ab_1',
        // @ts-expect-error — deliberately invalid; the service belt must reject.
        category: 'totally-made-up',
      })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(mockDbWrite.appBlock.update).not.toHaveBeenCalled();
  });

  it('throws NOT_FOUND for a missing app (no write)', async () => {
    mockDbWrite.appBlock.findUnique.mockResolvedValueOnce(null);
    const { BlockRegistry } = await import('../block-registry.service');
    await expect(
      BlockRegistry.setMarketplaceMeta({ appBlockId: 'missing', featured: false })
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(mockDbWrite.appBlock.update).not.toHaveBeenCalled();
  });

  it('REFUSES to feature a non-approved app (no write)', async () => {
    for (const status of ['pending', 'rejected', 'withdrawn', 'disabled']) {
      mockDbWrite.appBlock.findUnique.mockResolvedValueOnce({ id: 'ab_1', status });
      const { BlockRegistry } = await import('../block-registry.service');
      await expect(
        BlockRegistry.setMarketplaceMeta({ appBlockId: 'ab_1', featured: true }),
        `status="${status}" must not be featurable`
      ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    }
    expect(mockDbWrite.appBlock.update).not.toHaveBeenCalled();
  });

  it('ALLOWS featuring an approved app, writing the expected fields', async () => {
    mockDbWrite.appBlock.findUnique.mockResolvedValueOnce({ id: 'ab_1', status: 'approved' });
    const { BlockRegistry } = await import('../block-registry.service');
    const result = await BlockRegistry.setMarketplaceMeta({
      appBlockId: 'ab_1',
      category: 'games',
      featured: true,
      featuredOrder: 3,
    });
    expect(mockDbWrite.appBlock.update).toHaveBeenCalledTimes(1);
    const call = mockDbWrite.appBlock.update.mock.calls[0][0] as {
      where: { id: string };
      data: Record<string, unknown>;
    };
    expect(call.where).toEqual({ id: 'ab_1' });
    expect(call.data).toEqual({ category: 'games', featured: true, featuredOrder: 3 });
    expect(result).toMatchObject({ appBlockId: 'ab_1', featured: true, category: 'games' });
  });

  it('is a PATCH — only the provided fields are written (omitted = unchanged)', async () => {
    mockDbWrite.appBlock.findUnique.mockResolvedValueOnce({ id: 'ab_1', status: 'approved' });
    const { BlockRegistry } = await import('../block-registry.service');
    await BlockRegistry.setMarketplaceMeta({ appBlockId: 'ab_1', featured: false });
    const call = mockDbWrite.appBlock.update.mock.calls[0][0] as { data: Record<string, unknown> };
    // category + featuredOrder were NOT provided → not in the write data.
    expect(call.data).toEqual({ featured: false });
    expect(call.data).not.toHaveProperty('category');
    expect(call.data).not.toHaveProperty('featuredOrder');
  });

  it('allows explicitly CLEARING category/order with null (a non-approved app can be un-featured/edited)', async () => {
    mockDbWrite.appBlock.findUnique.mockResolvedValueOnce({ id: 'ab_1', status: 'pending' });
    const { BlockRegistry } = await import('../block-registry.service');
    await BlockRegistry.setMarketplaceMeta({
      appBlockId: 'ab_1',
      category: null,
      featuredOrder: null,
      featured: false, // un-feature is allowed on a non-approved app
    });
    const call = mockDbWrite.appBlock.update.mock.calls[0][0] as { data: Record<string, unknown> };
    expect(call.data).toEqual({ category: null, featuredOrder: null, featured: false });
  });

  it('E4 Low-2: the service writes ONLY its allowlisted fields even if extra keys reach it (mass-assignment guard, independent of the router zod strip)', async () => {
    mockDbWrite.appBlock.findUnique.mockResolvedValueOnce({ id: 'ab_1', status: 'approved' });
    const { BlockRegistry } = await import('../block-registry.service');
    // Call the service DIRECTLY (bypassing the router's zod object that would
    // strip unknown keys) with attacker-controlled protected columns. The
    // service's own `data` allowlist must drop them — only `featured` is written.
    await BlockRegistry.setMarketplaceMeta({
      appBlockId: 'ab_1',
      featured: true,
      status: 'rejected',
      trustTier: 'internal',
      manifest: { evil: true },
      approvedScopes: ['*'],
    } as never);
    const call = mockDbWrite.appBlock.update.mock.calls[0][0] as { data: Record<string, unknown> };
    expect(call.data).toEqual({ featured: true });
    for (const k of ['status', 'trustTier', 'manifest', 'approvedScopes', 'appBlockId']) {
      expect(call.data).not.toHaveProperty(k);
    }
  });
});

describe('BlockRegistry.getMarketplaceMeta — mod seed read (F-E E4)', () => {
  beforeEach(() => {
    mockDbRead.appBlock.findUnique.mockReset();
  });

  it('returns the current meta for an existing app', async () => {
    mockDbRead.appBlock.findUnique.mockResolvedValueOnce({
      id: 'ab_1',
      status: 'approved',
      category: 'utility',
      featured: true,
      featuredOrder: 2,
    });
    const { BlockRegistry } = await import('../block-registry.service');
    expect(await BlockRegistry.getMarketplaceMeta('ab_1')).toEqual({
      appBlockId: 'ab_1',
      status: 'approved',
      category: 'utility',
      featured: true,
      featuredOrder: 2,
    });
  });

  it('returns null for a missing app', async () => {
    mockDbRead.appBlock.findUnique.mockResolvedValueOnce(null);
    const { BlockRegistry } = await import('../block-registry.service');
    expect(await BlockRegistry.getMarketplaceMeta('missing')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The curation/advisory SEAM: curation writes the BLOCK, never the LISTING.
// ---------------------------------------------------------------------------

/**
 * 🔴 THIS PINS A FACT ANOTHER MODULE'S USER-FACING COPY IS DERIVED FROM.
 * `computeListingProblems` (`listing-problems.ts`) tells an on-site author how to clear
 * `empty-category`, and its wording depends entirely on WHERE a curated category lands.
 *
 * `setMarketplaceMeta` writes `AppBlock.category` and nothing else — it never touches
 * `app_listings`. That is what makes this state reachable by DESIGN, not by accident:
 *
 *   author omits `category`      → listing minted with `category: null`
 *   moderator curates            → `AppBlock.category` set, `AppListing.category` STILL null
 *   ⇒ the advisory fires, and the store card genuinely shows no category
 *
 * The listing column is only rewritten at an APPROVE — `mapAppBlockToListing` (first
 * approve / backfill) and `buildListingScalarSync` (3b-sync, subsequent-version), both
 * of which read `AppBlock.category`. So the remedy that ALWAYS clears the problem is
 * "get a new version approved"; editing the manifest is inert once a moderator has
 * curated, because (3a)'s null-gate no longer fires. The advisory's label says exactly
 * that, in that order.
 *
 * 🔴 IF THIS TEST EVER GOES RED because curation started writing the listing row too,
 * the divergence is CLOSED and `listing-problems.ts`'s `empty-category` label should be
 * revisited — the manifest-first wording would become correct again. That is the whole
 * reason this guard is here rather than a comment: a comment claiming a relationship
 * cannot notice when the relationship stops holding.
 *
 * 🔴 THIS IS AN INVARIANT GUARD, NOT REGRESSION COVERAGE — it passes at `origin/main`
 * and always has, because `setMarketplaceMeta` never wrote the listing row. It is not
 * evidence that anything was fixed. Its job is to make a fact that USER-FACING COPY IN
 * ANOTHER MODULE depends on fail loudly if it ever stops being true, so label it as
 * such rather than counting it toward the bug's coverage.
 */
describe('🔴 setMarketplaceMeta writes the BLOCK only — the listing row is untouched', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDbWrite.appBlock.findUnique.mockResolvedValue({ id: 'ab_c', status: 'approved' });
    mockDbWrite.appBlock.update.mockResolvedValue({
      id: 'ab_c',
      status: 'approved',
      category: 'utility',
      featured: false,
      featuredOrder: null,
    });
  });

  it('curating a category updates appBlock and NEVER appListing', async () => {
    const { BlockRegistry } = await import('../block-registry.service');
    await BlockRegistry.setMarketplaceMeta({ appBlockId: 'ab_c', category: 'utility' });

    // POSITIVE CONTROL FIRST: the write we DO expect actually happened, and carried the
    // category. Without this, the two `not.toHaveBeenCalled()` below would pass just as
    // well against a method that wrote nothing at all.
    expect(mockDbWrite.appBlock.update).toHaveBeenCalledTimes(1);
    const data = mockDbWrite.appBlock.update.mock.calls[0][0].data as { category?: unknown };
    expect(data.category).toBe('utility');

    // The claim itself: no listing write, on EITHER client. `dbRead`/`dbWrite` are
    // distinct in the canonical mock, so this cannot be satisfied by checking one.
    for (const client of [mockDbWrite, mockDbRead]) {
      expect(client.appListing.update).not.toHaveBeenCalled();
      expect(client.appListing.updateMany).not.toHaveBeenCalled();
      expect(client.appListing.create).not.toHaveBeenCalled();
      expect(client.appListing.upsert).not.toHaveBeenCalled();
    }
  });
});
