import { describe, it, expect, vi, beforeEach } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { redisMock } from '~/__tests__/mocks/redis.mock';
redisMock.redis.packed.set.mockImplementation(async () => undefined);
redisMock.redis.set.mockImplementation(async () => undefined);
redisMock.redis.sAdd.mockImplementation(async () => 0);
redisMock.redis.scanIterator.mockImplementation(async function* () {});
const mockDbRead = dbMock.dbRead;

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
 * The BOUND VALUES Prisma received, in bind order. `capturedSql()` above returns
 * the assembled string with `?` placeholders — the placeholders are literally
 * where the values are NOT — so a SQL-shape regex can never observe what a
 * decoder/parser actually produced. Anything asserting a *parsed* value (the
 * keyset cursor's `(sortKey, id)`, a filter argument) must read `.values`, or
 * the assertion is a claim about the query template rather than about the code
 * under test.
 */
function capturedValues(): unknown[] {
  expect(mockDbRead.$queryRaw).toHaveBeenCalled();
  const lastCall = mockDbRead.$queryRaw.mock.calls.at(-1);
  const first = lastCall?.[0] as unknown;
  if (first && typeof first === 'object' && Array.isArray((first as { values?: unknown }).values)) {
    return (first as { values: unknown[] }).values;
  }
  // Tagged-template form (legacy callers): the interpolations are the rest args.
  return (lastCall ?? []).slice(1) as unknown[];
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
    // Publisher screenshots jsonb (the cover comes from the first one). Default
    // null = an app that shipped no screenshots → coverUrl null.
    screenshots: null,
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
        // Off-site (external-link) app target — display/navigation-only.
        'externalUrl',
        'id',
        'installCount',
        'manifest',
        'scopesSummary',
        // F-E marketplace reviews — display-safe aggregates.
        // Card cover image — first public screenshot URL (or null).
        'coverUrl',
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
  // The 5-star `rating` sort and its Bayesian-shrinkage sort key are GONE (the
  // whole `AppBlockReview` system was removed). Its drift guard and pinned-mean
  // tests went with it; this pair is what survives — a standing assertion that
  // nothing re-introduces the Bayesian fragment or the 3-field pinned-mean
  // cursor on this code path.
  // ---------------------------------------------------------------------------

  it('NO sort emits a Bayesian rating fragment or reads app_block_reviews', async () => {
    const { BlockRegistry } = await import('../block-registry.service');
    for (const sort of ['popular', 'newest', 'name'] as const) {
      mockDbRead.$queryRaw.mockClear();
      await BlockRegistry.listAvailable({ limit: 20, sort });
      const sql = capturedSql();
      expect(sql).not.toMatch(/lpad\(round\(/i);
      expect(sql).not.toMatch(/app_block_reviews/i);
      expect(sql).not.toMatch(/avg_rating|review_count/i);
    }
  });

  it('nextCursor is the 2-field `sortKey|id` form — no pinned mean', async () => {
    const { BlockRegistry } = await import('../block-registry.service');
    // limit+1 rows so a nextCursor is emitted. ONE $queryRaw is queued: if the
    // service still tried to read a global mean first it would consume this and
    // the list query would get [] (and no cursor).
    mockDbRead.$queryRaw.mockResolvedValueOnce([
      rawRow({ id: 'ab_0', sort_key: '00000000000000000003' }),
      rawRow({ id: 'ab_1', sort_key: '00000000000000000002' }),
      rawRow({ id: 'ab_2', sort_key: '00000000000000000001' }),
    ]);
    const { nextCursor } = await BlockRegistry.listAvailable({ limit: 2, sort: 'popular' });
    expect(mockDbRead.$queryRaw).toHaveBeenCalledTimes(1);
    expect(nextCursor).toBeDefined();
    const sep = String.fromCharCode(31);
    const decoded = Buffer.from(nextCursor as string, 'base64url').toString('utf8');
    expect(decoded).toBe(`00000000000000000002${sep}ab_1`);
    // Positive control on the split: exactly one separator, i.e. two fields.
    expect(decoded.split(sep)).toHaveLength(2);
  });

  it('a LEGACY 3-field cursor (sortKey|id|mean) still resumes — the mean is ignored', async () => {
    const { BlockRegistry } = await import('../block-registry.service');
    const sep = String.fromCharCode(31);
    const cursor = Buffer.from(`00000000000000000005${sep}ab_5${sep}4.25`, 'utf8').toString(
      'base64url'
    );
    mockDbRead.$queryRaw.mockResolvedValueOnce([rawRow({ id: 'ab_9', sort_key: '4' })]);
    const { items } = await BlockRegistry.listAvailable({ limit: 20, sort: 'popular', cursor });
    expect(items).toHaveLength(1);
    const sql = capturedSql();
    // The keyset WHERE is still parameterised on (sortKey, id).
    expect(sql).toMatch(/,\s*ab\.id\)\s*<\s*\(/);
    // …and THIS is what pins "the mean is ignored". The SQL shape above holds
    // no matter what the decoder produced (the values sit behind `?`
    // placeholders), so the resume tuple has to be read off the BOUND VALUES.
    // `toContain` is strict equality, so a decoder that concatenated the stale
    // third field onto the id would bind `ab_5\x1f4.25` and fail here.
    const values = capturedValues();
    expect(values).toContain('00000000000000000005');
    expect(values).toContain('ab_5');
    // Defence in depth on the same claim from the other side: the dead mean
    // reached NO bound parameter, under any field split.
    for (const v of values) {
      if (typeof v !== 'string') continue;
      expect(v).not.toContain(sep);
      expect(v).not.toContain('4.25');
    }
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
        'blockId',
        'category',
        'coverUrl',
        'externalUrl',
        'id',
        'installCount',
        'manifest',
        'scopesSummary',
      ].sort()
    );
    expect(items[0]).not.toHaveProperty('status');
    expect(items[0]).not.toHaveProperty('approved_scopes');
  });

  // ---------------------------------------------------------------------------
  // Card cover image — the FIRST public screenshot URL (or null), projected via
  // the SAME toPublicScreenshots helper the detail page uses (opaque gated
  // route, never the raw MinIO key).
  // ---------------------------------------------------------------------------

  it('coverUrl = the FIRST public screenshot URL when the app shipped screenshots', async () => {
    mockDbRead.$queryRaw.mockResolvedValueOnce([
      rawRow({
        id: 'ab_cover',
        screenshots: [
          // Out-of-order on purpose — toPublicScreenshots sorts by index, so the
          // cover is index 0 regardless of array order.
          { key: 'blocks/ab_cover/1.webp', index: 1, ext: 'webp', contentType: 'image/webp' },
          { key: 'blocks/ab_cover/0.png', index: 0, ext: 'png', contentType: 'image/png' },
        ],
      }),
    ]);
    const { BlockRegistry } = await import('../block-registry.service');
    const { items } = await BlockRegistry.listAvailable({ limit: 20, sort: 'popular' });
    // Opaque gated app route built server-side from id+index+ext — NOT the key.
    expect(items[0].coverUrl).toBe('/api/blocks/screenshot/ab_cover/0.png');
    // The raw MinIO key must never appear on the wire.
    expect(JSON.stringify(items)).not.toContain('blocks/ab_cover/0.png');
  });

  it('coverUrl is null when the app shipped no screenshots (empty / NULL column)', async () => {
    mockDbRead.$queryRaw.mockResolvedValueOnce([
      rawRow({ id: 'ab_empty', screenshots: [] }),
      rawRow({ id: 'ab_null', screenshots: null }),
    ]);
    const { BlockRegistry } = await import('../block-registry.service');
    const { items } = await BlockRegistry.listAvailable({ limit: 20, sort: 'popular' });
    expect(items[0].coverUrl).toBeNull();
    expect(items[1].coverUrl).toBeNull();
  });
});
