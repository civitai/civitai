import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * F-E E2 — anon-exposure security tests for the per-app detail
 * (`BlockRegistry.getAppDetail`, served by the anon-capable
 * `blocks.getAppDetail` publicProcedure that backs `/apps/<appBlockId>`).
 *
 * The detail page is anon-CAPABLE (dark today behind the mod-segmented flag,
 * lit at launch by widening the segment). These tests pin the exposure
 * protections so they FAIL if any regresses:
 *
 *   1. APPROVED-ONLY — a non-approved (pending/rejected/withdrawn) OR missing
 *      app returns `null` (→ the router maps null to NOT_FOUND). A non-approved
 *      app's data can never be enumerated by id.
 *   2. PUBLIC MANIFEST ALLOWLIST — the raw stored `manifest` jsonb is arbitrary
 *      publisher JSON + server-SET internal fields (`trustTier`, internal
 *      `iframe.src`, `renderMode`, `settings`, raw `scopes`, …). The detail
 *      must project ONLY the vetted public subset (name/description/
 *      targets[].slotId) — never the raw manifest.
 *   3. SCOPES are the APPROVED scope ids (the permission-disclosure list), NOT
 *      the manifest's internal declaration.
 *   4. liveUrl is the already-public standalone origin (`<slug>.<APPS_DOMAIN>`),
 *      built from blockId + APPS_DOMAIN — no token / secret.
 *
 * We don't run the query (no DB in unit tests). We mock dbRead.$queryRaw to
 * capture the SQL + return seeded rows so we can assert the projected SHAPE.
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
    scanIterator: async function* () {},
  },
  sysRedis: { sMembers: vi.fn(async () => []) },
  REDIS_KEYS: {
    BLOCKS: { REGISTRY: 'packed:caches:block-registry', TOKEN_RATE_LIMIT: 'rl', REVOKED_INSTANCE: 'rev' },
  },
  REDIS_SYS_KEYS: { BLOCKS: { EMERGENCY_KILL_LIST: 'kill' } },
}));
// getAppDetail builds liveUrl from `env.APPS_DOMAIN` via a dynamic import of
// `~/env/server` — stub it so the test doesn't pull the real env schema.
// LOGGING is read by cache-helpers' createLogger at module-eval (the service
// now imports cache-helpers for the review-aggregate queryCache); '' = no-op
// logger.
vi.mock('~/env/server', () => ({ env: { APPS_DOMAIN: 'civit.ai', LOGGING: '' } }));

/** Reconstructs the SQL string from the tagged-template args Prisma received. */
function capturedSql(): string {
  expect(mockDbRead.$queryRaw).toHaveBeenCalled();
  const lastCall = mockDbRead.$queryRaw.mock.calls.at(-1);
  if (!lastCall) return '';
  const strings = lastCall[0] as unknown as TemplateStringsArray;
  const values = lastCall.slice(1);
  let sql = '';
  for (let i = 0; i < strings.length; i++) {
    sql += strings[i];
    if (i < values.length) sql += `$${i + 1}`;
  }
  return sql;
}

/**
 * One raw DB row (snake_case, as returned by $queryRaw). The `manifest`
 * deliberately carries private/internal fields a malicious/careless publisher
 * (or the server's own trustTier stamp) could put there — the projection must
 * strip every one. `approved_scopes` is the SEPARATE approved-scope column.
 */
function rawRow(over: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'ab_1',
    block_id: 'cool-block',
    app_id: 'app_1',
    app_name: 'Cool App',
    status: 'approved',
    content_rating: 'PG',
    version: '1.2.3',
    approved_scopes: ['ai:write:budgeted', 'models:read:self'],
    install_count: 7n,
    avg_rating: 4.5,
    review_count: 12n,
    // F-E E5 stored screenshot records (jsonb). The projection must expose ONLY
    // a public DISPLAY URL + index + content-type — NEVER the underlying MinIO
    // `key`. Index/ext build the opaque gated app route.
    screenshots: [
      { key: 'screenshots/ab_1/0.png', index: 0, ext: 'png', contentType: 'image/png' },
      { key: 'screenshots/ab_1/1.jpg', index: 1, ext: 'jpg', contentType: 'image/jpeg' },
    ],
    manifest: {
      name: 'Cool Block',
      description: 'Does cool things',
      targets: [{ slotId: 'model.sidebar_top', secretCfg: 'leak-me' }],
      // --- private / internal fields that MUST NOT leak to anon ---
      trustTier: 'internal',
      iframe: { src: 'https://cool-block.internal.example/', sandbox: 'allow-scripts' },
      renderMode: 'iframe',
      // The manifest's OWN scopes declaration — distinct from approved_scopes;
      // it must not leak (we surface approved_scopes instead).
      scopes: ['ai:write:budgeted', 'social:tip:self', 'INTERNAL_secret_scope'],
      settings: { apiKey: 'super-secret' },
      arbitraryPublisherField: { nested: 'secret' },
    },
    ...over,
  };
}

describe('BlockRegistry.getAppDetail — anon-exposure protections (F-E E2)', () => {
  beforeEach(() => {
    mockDbRead.$queryRaw.mockClear();
    mockDbRead.$queryRaw.mockResolvedValue([rawRow()]);
  });

  it('returns the public projection for an approved app', async () => {
    const { BlockRegistry } = await import('../block-registry.service');
    const detail = await BlockRegistry.getAppDetail('ab_1');
    expect(detail).not.toBeNull();
    expect(detail).toMatchObject({
      id: 'ab_1',
      blockId: 'cool-block',
      appId: 'app_1',
      appName: 'Cool App',
      contentRating: 'PG',
      version: '1.2.3',
      installCount: 7,
      avgRating: 4.5,
      reviewCount: 12,
      liveUrl: 'https://cool-block.civit.ai',
    });
    expect(detail!.manifest.name).toBe('Cool Block');
    expect(detail!.manifest.description).toBe('Does cool things');
    expect(detail!.manifest.targets).toEqual([{ slotId: 'model.sidebar_top' }]);
  });

  it('scopes come from approved_scopes (the disclosure list), not the manifest', async () => {
    const { BlockRegistry } = await import('../block-registry.service');
    const detail = await BlockRegistry.getAppDetail('ab_1');
    expect(detail!.scopes).toEqual(['ai:write:budgeted', 'models:read:self']);
    // Manifest-declared scopes (incl. an internal one) are NOT surfaced.
    expect(detail!.scopes).not.toContain('social:tip:self');
    expect(detail!.scopes).not.toContain('INTERNAL_secret_scope');
  });

  it('returns null for a NON-APPROVED app — never its data (no id-enumeration)', async () => {
    for (const status of ['pending', 'rejected', 'withdrawn', 'disabled']) {
      mockDbRead.$queryRaw.mockResolvedValueOnce([rawRow({ status })]);
      const { BlockRegistry } = await import('../block-registry.service');
      const detail = await BlockRegistry.getAppDetail('ab_1');
      expect(detail, `status="${status}" must not return data`).toBeNull();
    }
  });

  it('returns null for a missing app', async () => {
    mockDbRead.$queryRaw.mockResolvedValueOnce([]);
    const { BlockRegistry } = await import('../block-registry.service');
    expect(await BlockRegistry.getAppDetail('ab_missing')).toBeNull();
  });

  it('projects ONLY the public allowlist — no private/internal manifest field leaks', async () => {
    const { BlockRegistry } = await import('../block-registry.service');
    const detail = await BlockRegistry.getAppDetail('ab_1');
    const manifest = detail!.manifest as Record<string, unknown>;

    for (const forbidden of [
      'trustTier',
      'iframe',
      'renderMode',
      'scopes',
      'settings',
      'arbitraryPublisherField',
    ]) {
      expect(manifest, `manifest leaked "${forbidden}"`).not.toHaveProperty(forbidden);
    }
    // Per-target fields beyond slotId are dropped (no nested config leak).
    const target0 = (manifest.targets as Array<Record<string, unknown>>)[0];
    expect(Object.keys(target0)).toEqual(['slotId']);
  });

  it('the serialized result contains NO secret value (mutation-test the projection)', async () => {
    const { BlockRegistry } = await import('../block-registry.service');
    const detail = await BlockRegistry.getAppDetail('ab_1');
    const serialized = JSON.stringify(detail);
    for (const secret of [
      'super-secret', // manifest.settings.apiKey
      'internal.example', // manifest.iframe.src host
      'leak-me', // manifest.targets[0].secretCfg
      'INTERNAL_secret_scope', // manifest.scopes internal entry
    ]) {
      expect(serialized, `serialized output leaked "${secret}"`).not.toContain(secret);
    }
  });

  it('top-level shape is the PublicAppDetail allowlist only (no status/raw leak)', async () => {
    const { BlockRegistry } = await import('../block-registry.service');
    const detail = await BlockRegistry.getAppDetail('ab_1');
    expect(Object.keys(detail!).sort()).toEqual(
      [
        'appId',
        'appName',
        'avgRating',
        'blockId',
        'contentRating',
        'externalUrl',
        'id',
        'installCount',
        'liveUrl',
        'manifest',
        'reviewCount',
        'scopes',
        'screenshots',
        'version',
      ].sort()
    );
    // `status` is a DB-internal field; it must never appear on the wire shape.
    expect(detail!).not.toHaveProperty('status');
    // The raw manifest internals (re-checked at the top level just in case).
    expect(detail!).not.toHaveProperty('trustTier');
  });

  it('liveUrl is the already-public standalone origin (no token/secret)', async () => {
    const { BlockRegistry } = await import('../block-registry.service');
    const detail = await BlockRegistry.getAppDetail('ab_1');
    expect(detail!.liveUrl).toBe('https://cool-block.civit.ai');
    expect(detail!.liveUrl).not.toMatch(/token|jwt|secret|\?/i);
  });

  it('screenshots are PUBLIC display URLs only — the stored MinIO key never leaks (F-E E5)', async () => {
    const { BlockRegistry } = await import('../block-registry.service');
    const detail = await BlockRegistry.getAppDetail('ab_1');
    expect(detail!.screenshots).toEqual([
      { index: 0, url: '/api/blocks/screenshot/ab_1/0.png', contentType: 'image/png' },
      { index: 1, url: '/api/blocks/screenshot/ab_1/1.jpg', contentType: 'image/jpeg' },
    ]);
    // The opaque app route only — never the underlying MinIO key.
    const serialized = JSON.stringify(detail!.screenshots);
    expect(serialized).not.toContain('screenshots/ab_1/0.png'); // the raw stored key
    expect(serialized).not.toContain('"key"');
    for (const shot of detail!.screenshots) {
      expect(shot.url.startsWith('/api/blocks/screenshot/')).toBe(true);
      expect(shot.url).not.toMatch(/token|jwt|secret|\?/i);
    }
  });

  it('a NULL screenshots column yields an empty gallery (no crash) (F-E E5)', async () => {
    mockDbRead.$queryRaw.mockResolvedValueOnce([rawRow({ screenshots: null })]);
    const { BlockRegistry } = await import('../block-registry.service');
    const detail = await BlockRegistry.getAppDetail('ab_1');
    expect(detail!.screenshots).toEqual([]);
  });

  it('a non-image content-type in a stored screenshot record is DROPPED (F-E E5)', async () => {
    mockDbRead.$queryRaw.mockResolvedValueOnce([
      rawRow({
        screenshots: [
          { key: 'screenshots/ab_1/0.png', index: 0, ext: 'png', contentType: 'image/png' },
          // tampered/legacy entry — must be dropped, not surfaced to the client.
          { key: 'screenshots/ab_1/1.html', index: 1, ext: 'html', contentType: 'text/html' },
        ],
      }),
    ]);
    const { BlockRegistry } = await import('../block-registry.service');
    const detail = await BlockRegistry.getAppDetail('ab_1');
    expect(detail!.screenshots).toHaveLength(1);
    expect(detail!.screenshots[0].contentType).toBe('image/png');
  });

  it('a VALID image extension paired with a non-image content-type is DROPPED (content-type allowlist is independent of the ext check, F-E E5 Low-3)', async () => {
    mockDbRead.$queryRaw.mockResolvedValueOnce([
      rawRow({
        screenshots: [
          // ext is an allowlisted image ext (png) but the recorded content-type
          // is text/html — the content-type allowlist must drop it on its OWN
          // (the ext check alone would let this through). Exercises the
          // content-type belt independently of the ext belt.
          { key: 'screenshots/ab_1/0.png', index: 0, ext: 'png', contentType: 'text/html' },
        ],
      }),
    ]);
    const { BlockRegistry } = await import('../block-registry.service');
    const detail = await BlockRegistry.getAppDetail('ab_1');
    expect(detail!.screenshots).toHaveLength(0);
  });

  it('SELECTs the screenshots column (so getAppDetail can render the gallery)', async () => {
    const { BlockRegistry } = await import('../block-registry.service');
    await BlockRegistry.getAppDetail('ab_1');
    const sql = capturedSql();
    expect(sql).toMatch(/ab\.screenshots/);
  });

  it('a NULL approved_scopes column yields an empty scope list (no crash)', async () => {
    mockDbRead.$queryRaw.mockResolvedValueOnce([rawRow({ approved_scopes: null })]);
    const { BlockRegistry } = await import('../block-registry.service');
    const detail = await BlockRegistry.getAppDetail('ab_1');
    expect(detail!.scopes).toEqual([]);
  });

  it('a malformed/missing manifest yields an empty public manifest (no crash, no leak)', async () => {
    mockDbRead.$queryRaw.mockResolvedValueOnce([
      rawRow({ manifest: null }),
    ]);
    const { BlockRegistry } = await import('../block-registry.service');
    const detail = await BlockRegistry.getAppDetail('ab_1');
    expect(detail!.manifest).not.toHaveProperty('trustTier');
    expect(detail!.manifest).toEqual({});
  });

  it('looks up by id (single approved row by appBlockId)', async () => {
    const { BlockRegistry } = await import('../block-registry.service');
    await BlockRegistry.getAppDetail('ab_1');
    const sql = capturedSql();
    expect(sql).toMatch(/FROM app_blocks ab/);
    expect(sql).toMatch(/WHERE ab\.id =/);
  });
});
