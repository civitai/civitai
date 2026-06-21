import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * F-E E1 — anon-exposure security tests for the marketplace listing
 * (`BlockRegistry.listAvailable`, served by the anon-capable
 * `blocks.listAvailable` publicProcedure).
 *
 * The marketplace is anon-CAPABLE (dark today behind the mod-segmented flag,
 * lit at launch by widening the segment). These tests pin the two exposure
 * protections so they FAIL if either regresses:
 *
 *   1. APPROVED-ONLY — the SQL hard-filters `ab.status = 'approved'`, so
 *      pending / rejected / withdrawn apps can never reach an anon caller.
 *      Belt-and-suspenders, we also seed a pending row into the (mocked) DB
 *      result and assert the projection carries no status/secret fields.
 *   2. PUBLIC FIELD ALLOWLIST — the raw stored `manifest` jsonb is arbitrary
 *      publisher JSON plus server-SET internal fields (`trustTier`, the
 *      internal `iframe.src` host, `renderMode`, `scopes`, …). The listing
 *      must project ONLY the vetted public subset
 *      (name / description / targets[].slotId) — never the raw manifest.
 *
 * We don't run the query (no DB in unit tests). We mock dbRead.$queryRaw to:
 *   - capture the SQL template (assert the status='approved' filter), and
 *   - return seeded rows so we can assert the SHAPE of the projected output.
 */

const { mockDbRead } = vi.hoisted(() => ({
  mockDbRead: {
    $queryRaw: vi.fn(async (..._a: unknown[]): Promise<unknown[]> => []),
    blockUserSubscription: { findUnique: vi.fn(async (..._a: unknown[]): Promise<unknown> => null) },
    appBlock: { findUnique: vi.fn(async (..._a: unknown[]): Promise<unknown> => null) },
    modelVersion: { findMany: vi.fn(async (..._a: unknown[]): Promise<unknown[]> => []) },
  },
}));

vi.mock('~/server/db/client', () => ({ dbRead: mockDbRead, dbWrite: mockDbRead }));
vi.mock('~/server/redis/client', () => ({
  redis: {
    packed: { get: vi.fn(async () => null), set: vi.fn(async () => undefined) },
    get: vi.fn(async () => null),
    set: vi.fn(async () => undefined),
    del: vi.fn(async () => 0),
    // sAdd: used by cache-helpers tagCacheKey — the `rating` sort caches the
    // global-mean scalar through queryCache, which tags the key.
    sAdd: vi.fn(async () => 0),
    scanIterator: async function* () {},
  },
  sysRedis: { sMembers: vi.fn(async () => []) },
  REDIS_KEYS: {
    TAG: 'cache:tag',
    BLOCKS: { REGISTRY: 'packed:caches:block-registry', TOKEN_RATE_LIMIT: 'rl', REVOKED_INSTANCE: 'rev' },
  },
  REDIS_SYS_KEYS: { BLOCKS: { EMERGENCY_KILL_LIST: 'kill' } },
}));

/**
 * Reconstructs the SQL string Prisma received. listAvailable composes the
 * query with `Prisma.sql` and calls `$queryRaw(Prisma.sql\`…\`)` (a single
 * Sql-object argument, NOT a tagged template) so the per-sort fragments + the
 * keyset can be conditional. A Prisma.Sql exposes `.sql` (the assembled string
 * with `?` placeholders), so we read that directly; we still fall back to the
 * tagged-template reconstruction for any caller that used the literal form.
 */
function capturedSql(): string {
  expect(mockDbRead.$queryRaw).toHaveBeenCalled();
  const lastCall = mockDbRead.$queryRaw.mock.calls.at(-1);
  if (!lastCall) return '';
  const first = lastCall[0] as unknown;
  // Prisma.Sql object form: it carries the assembled `.sql` string.
  if (first && typeof first === 'object' && typeof (first as { sql?: unknown }).sql === 'string') {
    return (first as { sql: string }).sql;
  }
  // Tagged-template form (legacy callers): rebuild from strings + values.
  const strings = first as unknown as TemplateStringsArray;
  const values = lastCall.slice(1);
  let sql = '';
  for (let i = 0; i < strings.length; i++) {
    sql += strings[i];
    if (i < values.length) sql += `$${i + 1}`;
  }
  return sql;
}

/**
 * One raw DB row shape (snake_case, as returned by the $queryRaw). The
 * `manifest` deliberately carries private/internal fields a malicious or
 * careless publisher (or the server's own trustTier stamp) could put there —
 * the projection must strip them.
 */
function rawRow(over: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'ab_1',
    block_id: 'cool-block',
    app_id: 'app_1',
    app_name: 'Cool App',
    install_count: 5n,
    // F-E E3 columns the listing now projects. category is mod-assigned (NULL
    // until the migration + a mod sets it); approved_scopes is the public
    // permission-disclosure list; sort_key is the projected text sort key the
    // service uses to build the keyset cursor.
    category: 'utility',
    approved_scopes: ['ai:write:budgeted', 'models:read:self', 'buzz:read:self', 'social:tip:self'],
    avg_rating: 4.2,
    review_count: 8n,
    sort_key: '00000000000000000005',
    manifest: {
      name: 'Cool Block',
      description: 'Does cool things',
      targets: [{ slotId: 'model.sidebar_top', secretCfg: 'leak-me' }],
      // --- private / internal fields that MUST NOT leak to anon ---
      trustTier: 'internal',
      iframe: { src: 'https://cool-block.internal.example/', sandbox: 'allow-scripts' },
      renderMode: 'iframe',
      scopes: ['ai:write:budgeted', 'models:read:self'],
      settings: { apiKey: 'super-secret' },
      json: 'whatever-internal',
      arbitraryPublisherField: { nested: 'secret' },
    },
    ...over,
  };
}

describe('BlockRegistry.listAvailable — anon-exposure protections (F-E E1)', () => {
  beforeEach(() => {
    mockDbRead.$queryRaw.mockClear();
    mockDbRead.$queryRaw.mockResolvedValue([rawRow()]);
  });

  it('SQL hard-filters status = approved (pending/rejected never returned)', async () => {
    const { BlockRegistry } = await import('../block-registry.service');
    await BlockRegistry.listAvailable({ limit: 20 });
    expect(capturedSql()).toMatch(/ab\.status\s*=\s*'approved'/);
  });

  it('projects ONLY the public manifest allowlist — no private/internal field leaks', async () => {
    const { BlockRegistry } = await import('../block-registry.service');
    const { items } = await BlockRegistry.listAvailable({ limit: 20 });
    expect(items).toHaveLength(1);
    const manifest = items[0].manifest as Record<string, unknown>;

    // Allowlisted, display-safe fields survive.
    expect(manifest.name).toBe('Cool Block');
    expect(manifest.description).toBe('Does cool things');
    expect(manifest.targets).toEqual([{ slotId: 'model.sidebar_top' }]);

    // Private / internal fields are absent.
    for (const forbidden of [
      'trustTier',
      'iframe',
      'renderMode',
      'scopes',
      'settings',
      'json',
      'arbitraryPublisherField',
    ]) {
      expect(manifest, `manifest leaked "${forbidden}"`).not.toHaveProperty(forbidden);
    }

    // Per-target fields beyond slotId are dropped (no nested config leak).
    const target0 = (manifest.targets as Array<Record<string, unknown>>)[0];
    expect(target0).not.toHaveProperty('secretCfg');
    expect(Object.keys(target0)).toEqual(['slotId']);

    // The whole serialized listing must not contain any secret value.
    const serialized = JSON.stringify(items);
    expect(serialized).not.toContain('super-secret');
    expect(serialized).not.toContain('internal.example');
    expect(serialized).not.toContain('leak-me');
  });

  it('returned top-level shape is the public allowlist only (no status/raw leak)', async () => {
    const { BlockRegistry } = await import('../block-registry.service');
    const { items } = await BlockRegistry.listAvailable({ limit: 20 });
    expect(Object.keys(items[0]).sort()).toEqual(
      [
        'appId',
        'appName',
        'blockId',
        // F-E E3 additions — both public/display-safe.
        'category',
        'id',
        'installCount',
        'manifest',
        'scopesSummary',
        // F-E marketplace reviews — display-safe aggregates.
        'avgRating',
        'reviewCount',
      ].sort()
    );
    // status is a DB-internal field; it must never appear on the wire shape.
    expect(items[0]).not.toHaveProperty('status');
  });

  it('a malformed/missing manifest yields an empty public manifest (no crash, no leak)', async () => {
    mockDbRead.$queryRaw.mockResolvedValueOnce([
      rawRow({ manifest: null }),
      rawRow({ id: 'ab_2', manifest: 'a string, not an object' }),
      rawRow({ id: 'ab_3', manifest: { targets: 'not-an-array', trustTier: 'internal' } }),
    ]);
    const { BlockRegistry } = await import('../block-registry.service');
    const { items } = await BlockRegistry.listAvailable({ limit: 20 });
    expect(items).toHaveLength(3);
    for (const it of items) {
      expect(it.manifest).not.toHaveProperty('trustTier');
      // targets, when not a valid array, is simply omitted.
      if ('targets' in it.manifest) {
        expect(Array.isArray((it.manifest as { targets?: unknown }).targets)).toBe(true);
      }
    }
  });

  it('query + slot filter + cursor are threaded into the SQL (anon browse still works)', async () => {
    const { BlockRegistry } = await import('../block-registry.service');
    await BlockRegistry.listAvailable({
      limit: 20,
      sort: 'popular',
      query: 'cool',
      slotId: 'model.sidebar_top',
      // A real opaque cursor (base64url of `sortKey␟id`); any prior page's
      // nextCursor is this shape.
      cursor: Buffer.from(`00000000000000000005${String.fromCharCode(31)}ab_0`, 'utf8').toString(
        'base64url'
      ),
    });
    const sql = capturedSql();
    // ILIKE name/blockId filter, slot @> jsonb filter, and the (sort_key, id)
    // keyset tuple comparison for pagination.
    expect(sql).toMatch(/LIKE/i);
    expect(sql).toMatch(/@>/);
    // Keyset tuple comparison `(<sortKeyExpr>, ab.id) < (?, ?)`.
    expect(sql).toMatch(/,\s*ab\.id\)\s*<\s*\(/);
  });

  it('emits nextCursor only when a full page+1 is returned (pagination contract)', async () => {
    // Return limit+1 rows so the service trims to `limit` and sets nextCursor.
    const rows = Array.from({ length: 3 }, (_v, i) =>
      rawRow({ id: `ab_${i}`, sort_key: `0000000000000000000${i}` })
    );
    mockDbRead.$queryRaw.mockResolvedValueOnce(rows);
    const { BlockRegistry } = await import('../block-registry.service');
    const { items, nextCursor } = await BlockRegistry.listAvailable({ limit: 2 });
    expect(items).toHaveLength(2);
    // The cursor is opaque (base64url of `sortKey␟id` of the LAST returned row,
    // ab_1). Decode it to assert it points at the right keyset position so the
    // next page resumes correctly — and is NOT just the bare id (it must carry
    // the sort key too, or a paged scan over tied sort values breaks).
    expect(nextCursor).toBeDefined();
    const decoded = Buffer.from(nextCursor as string, 'base64url').toString('utf8');
    expect(decoded).toBe(`00000000000000000001${String.fromCharCode(31)}ab_1`);
  });

  // ---------------------------------------------------------------------------
  // F-E E3 — sort, category filter, scopes-summary.
  // ---------------------------------------------------------------------------

  it('sort=popular orders by install count DESC', async () => {
    const { BlockRegistry } = await import('../block-registry.service');
    await BlockRegistry.listAvailable({ limit: 20, sort: 'popular' });
    const sql = capturedSql();
    // Sort key = zero-padded distinct-user install count; ordered DESC.
    expect(sql).toMatch(/COUNT\(DISTINCT bus\.user_id\)/);
    expect(sql).toMatch(/lpad/i);
    expect(sql).toMatch(/ORDER BY\s+sort_key\s+DESC/i);
  });

  it('sort=newest orders by current_version_deployed_at (fallback created_at) DESC', async () => {
    const { BlockRegistry } = await import('../block-registry.service');
    await BlockRegistry.listAvailable({ limit: 20, sort: 'newest' });
    const sql = capturedSql();
    expect(sql).toMatch(/COALESCE\(ab\.current_version_deployed_at,\s*ab\.created_at\)/i);
    expect(sql).toMatch(/ORDER BY\s+sort_key\s+DESC/i);
  });

  it('sort=name orders by manifest name ASC (case-insensitive)', async () => {
    const { BlockRegistry } = await import('../block-registry.service');
    await BlockRegistry.listAvailable({ limit: 20, sort: 'name' });
    const sql = capturedSql();
    expect(sql).toMatch(/LOWER\(COALESCE\(ab\.manifest->>'name',\s*ab\.block_id\)\)/i);
    expect(sql).toMatch(/ORDER BY\s+sort_key\s+ASC/i);
    // ASC sort resumes with `>` (not `<`) on the keyset tuple.
    expect(sql).toMatch(/,\s*ab\.id\)\s*>\s*\(/);
  });

  // ---------------------------------------------------------------------------
  // F-E marketplace REVIEWS — Bayesian `rating` sort DRIFT GUARD.
  // The rating sort key text MUST be reused identically in the SELECT (AS
  // sort_key) and the keyset WHERE — if it drifts, keyset pagination silently
  // skips rows. The Bayesian-score ordering + keyset-completeness PROPERTIES are
  // pinned in block-registry.rating-sort.test.ts (pure-JS mirror of the SQL).
  // ---------------------------------------------------------------------------

  it('sort=rating (the schema DEFAULT) emits the Bayesian key in SELECT + keyset WHERE (no drift)', async () => {
    const { BlockRegistry } = await import('../block-registry.service');
    // `rating` is the marketplaceSortSchema default; the service takes the parsed
    // input so we pass it explicitly here (the zod default applies at the router).
    await BlockRegistry.listAvailable({ limit: 20, sort: 'rating' });
    const sql = capturedSql();
    // The Bayesian encoding fragment (round(score*scale) zero-padded, concat the
    // install-count) is unique to the rating key.
    const occurrences = sql.match(/lpad\(round\(/gi)?.length ?? 0;
    // Emitted once in SELECT (AS sort_key) and once in the keyset WHERE tuple.
    expect(occurrences).toBeGreaterThanOrEqual(2);
    expect(sql).toMatch(/AS sort_key/i);
    expect(sql).toMatch(/ORDER BY\s+sort_key\s+DESC/i);
    expect(sql).toMatch(/,\s*ab\.id\)\s*<\s*\(/); // DESC keyset resumes with `<`
  });

  it('a NON-rating sort does NOT emit the Bayesian fragment', async () => {
    const { BlockRegistry } = await import('../block-registry.service');
    await BlockRegistry.listAvailable({ limit: 20, sort: 'popular' });
    expect(capturedSql()).not.toMatch(/lpad\(round\(/i);
  });

  // FIX 2 — PIN the Bayesian mean `m` into the rating-sort cursor so a paging
  // session stays stable when the 1h global-mean cache expires/busts mid-page.
  it('sort=rating: page 1 PINS the global mean into nextCursor', async () => {
    const { BlockRegistry } = await import('../block-registry.service');
    // Call 1 = getGlobalMeanRating (via queryCache → $queryRaw): return m=4.25.
    mockDbRead.$queryRaw.mockResolvedValueOnce([{ mean: 4.25 }]);
    // Call 2 = the list query: limit+1 rows so nextCursor is emitted.
    mockDbRead.$queryRaw.mockResolvedValueOnce([
      rawRow({ id: 'ab_0', sort_key: '00000004250000' }),
      rawRow({ id: 'ab_1', sort_key: '00000004240000' }),
      rawRow({ id: 'ab_2', sort_key: '00000004230000' }),
    ]);
    const { nextCursor } = await BlockRegistry.listAvailable({ limit: 2, sort: 'rating' });
    expect(nextCursor).toBeDefined();
    const decoded = Buffer.from(nextCursor as string, 'base64url').toString('utf8');
    const sep = String.fromCharCode(31);
    // sortKey␟id␟mean — the third field is the pinned mean (4.25).
    expect(decoded).toBe(`00000004240000${sep}ab_1${sep}4.25`);
  });

  it('sort=rating: a cursor with a pinned mean REUSES it (no global-mean re-read)', async () => {
    const { BlockRegistry } = await import('../block-registry.service');
    const sep = String.fromCharCode(31);
    // A page-2 cursor pinning m=2.5 (a value the live cache would NOT return —
    // proving the pinned value is what flows into the SQL, not a fresh read).
    const cursor = Buffer.from(`00000002500000${sep}ab_5${sep}2.5`, 'utf8').toString('base64url');
    // ONLY ONE $queryRaw is queued (the list query). If the service re-read the
    // global mean it would consume this and the list query would get []; instead
    // the pinned mean short-circuits the read so this feeds the list query.
    mockDbRead.$queryRaw.mockResolvedValueOnce([rawRow({ id: 'ab_9', sort_key: '00000002400000' })]);
    const { items } = await BlockRegistry.listAvailable({ limit: 20, sort: 'rating', cursor });
    // The list query ran and projected the row → the pinned mean fed it directly.
    expect(items).toHaveLength(1);
    // Exactly ONE $queryRaw call total (the list) — the mean re-read was skipped.
    expect(mockDbRead.$queryRaw).toHaveBeenCalledTimes(1);
    // The pinned mean 2.5 is bound into the Bayesian sort key (C*m term = 10*2.5).
    const sql = capturedSql();
    expect(sql).toMatch(/lpad\(round\(/i); // rating key present
  });

  it('category filter is threaded into the SQL (only the requested category)', async () => {
    const { BlockRegistry } = await import('../block-registry.service');
    await BlockRegistry.listAvailable({ limit: 20, sort: 'popular', category: 'games' });
    const sql = capturedSql();
    // The category predicate compares ab.category to the bound param; null param
    // (no category) makes it a no-op. The approved-only filter still stands.
    expect(sql).toMatch(/ab\.category\s*=/);
    expect(sql).toMatch(/ab\.status\s*=\s*'approved'/);
  });

  it('projects scopesSummary from approved_scopes (public disclosure), capped at the summary limit', async () => {
    const { BlockRegistry, MARKETPLACE_SCOPES_SUMMARY_LIMIT } = await import(
      '../block-registry.service'
    );
    const { items } = await BlockRegistry.listAvailable({ limit: 20, sort: 'popular' });
    expect(items).toHaveLength(1);
    // The seeded row has 4 approved scopes; the card summary takes the first N.
    expect(items[0].scopesSummary).toEqual(
      ['ai:write:budgeted', 'models:read:self', 'buzz:read:self', 'social:tip:self'].slice(
        0,
        MARKETPLACE_SCOPES_SUMMARY_LIMIT
      )
    );
    // category passes through.
    expect(items[0].category).toBe('utility');
  });

  it('scopesSummary contains ONLY public approved scopes — never the raw manifest scope declaration', async () => {
    // The manifest carries its OWN `scopes` array incl. an internal-looking
    // entry; scopesSummary must come from approved_scopes, NOT the manifest.
    mockDbRead.$queryRaw.mockResolvedValueOnce([
      rawRow({
        approved_scopes: ['user:read:self'],
        manifest: {
          name: 'X',
          scopes: ['INTERNAL_secret_scope', 'ai:write:budgeted'],
          settings: { apiKey: 'super-secret' },
        },
      }),
    ]);
    const { BlockRegistry } = await import('../block-registry.service');
    const { items } = await BlockRegistry.listAvailable({ limit: 20, sort: 'popular' });
    expect(items[0].scopesSummary).toEqual(['user:read:self']);
    const serialized = JSON.stringify(items);
    expect(serialized).not.toContain('INTERNAL_secret_scope');
    expect(serialized).not.toContain('super-secret');
  });

  it('a NULL approved_scopes column yields an empty scopesSummary (no crash)', async () => {
    mockDbRead.$queryRaw.mockResolvedValueOnce([rawRow({ approved_scopes: null })]);
    const { BlockRegistry } = await import('../block-registry.service');
    const { items } = await BlockRegistry.listAvailable({ limit: 20, sort: 'popular' });
    expect(items[0].scopesSummary).toEqual([]);
  });

  it('listing wire shape is the public allowlist incl. E3 fields (no status/raw leak)', async () => {
    const { BlockRegistry } = await import('../block-registry.service');
    const { items } = await BlockRegistry.listAvailable({ limit: 20, sort: 'popular' });
    expect(Object.keys(items[0]).sort()).toEqual(
      [
        'appId',
        'appName',
        'avgRating',
        'blockId',
        'category',
        'id',
        'installCount',
        'manifest',
        'reviewCount',
        'scopesSummary',
      ].sort()
    );
    expect(items[0]).not.toHaveProperty('status');
    expect(items[0]).not.toHaveProperty('approved_scopes');
  });
});
