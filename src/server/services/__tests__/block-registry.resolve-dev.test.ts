import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * APP DEV TUNNEL — BlockRegistry.resolveDevPageBlockForAuthor.
 *
 * The dev route resolver: resolves the caller's OWN app by blockId at ANY status,
 * ownership-scoped. Foreign / absent → null (no oracle). Pins the two invariants
 * that keep the dev path disjoint from the public run path:
 *   - it never requires status:approved (a draft/pending own app resolves), and
 *   - it carries NO iframeSrc (the route derives the host from the tunnel only).
 */

const { mockDbRead, mockDbWrite, mockRedis, mockSysRedis } = vi.hoisted(() => {
  const ab = () => ({
    findUnique: vi.fn(async (): Promise<unknown> => null),
    findFirst: vi.fn(async (): Promise<unknown> => null),
  });
  const pubreq = () => ({ findFirst: vi.fn(async (): Promise<unknown> => null) });
  return {
    mockDbRead: {
      $queryRaw: vi.fn(async () => []),
      appBlock: ab(),
      appBlockPublishRequest: pubreq(),
    },
    mockDbWrite: { appBlock: ab(), appBlockPublishRequest: pubreq() },
    mockRedis: {
      packed: { get: vi.fn(async () => null), set: vi.fn(async () => undefined) },
      get: vi.fn(async () => null),
      set: vi.fn(async () => undefined),
      del: vi.fn(async () => 0),
      scanIterator: async function* () {},
    },
    mockSysRedis: { sMembers: vi.fn(async () => []) },
  };
});

vi.mock('~/server/db/client', () => ({ dbRead: mockDbRead, dbWrite: mockDbWrite }));
vi.mock('~/server/redis/client', () => ({
  redis: mockRedis,
  sysRedis: mockSysRedis,
  REDIS_KEYS: { BLOCKS: { REGISTRY: 'r', TOKEN_RATE_LIMIT: 'rl', REVOKED_INSTANCE: 'rev' } },
  REDIS_SYS_KEYS: { BLOCKS: { EMERGENCY_KILL_LIST: 'kill' } },
}));

import { BlockRegistry } from '~/server/services/block-registry.service';

function ownRow(status: string) {
  return {
    id: 'apb_dev',
    blockId: 'my-app',
    appId: 'appblk-my-app',
    status,
    manifest: { name: 'My App', scopes: ['ai:write:budgeted'], iframe: { sandbox: 'allow-scripts' } },
    trustTier: 'unverified',
    contentRating: null,
  };
}

describe('BlockRegistry.resolveDevPageBlockForAuthor', () => {
  beforeEach(() => vi.clearAllMocks());

  it.each(['draft', 'pending', 'approved', 'rejected'])(
    'resolves the caller’s OWN app at status=%s (status-agnostic)',
    async (status) => {
      mockDbRead.appBlock.findFirst.mockResolvedValue(ownRow(status));
      const res = await BlockRegistry.resolveDevPageBlockForAuthor('my-app', 555);
      expect(res).not.toBeNull();
      expect(res?.status).toBe(status);
      expect(res?.appBlockId).toBe('apb_dev');
      expect(res?.scopes).toEqual(['ai:write:budgeted']);
      // The query is OWNERSHIP-scoped: blockId + app.userId.
      expect(mockDbRead.appBlock.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({ where: { blockId: 'my-app', app: { userId: 555 } } })
      );
      // NO iframeSrc field exists on the dev resolution — it can never serve a
      // deployed <slug>.civit.ai bundle.
      expect((res as Record<string, unknown>).iframeSrc).toBeUndefined();
    }
  );

  // ── EPHEMERAL PRE-SUBMIT FALLBACK (Phase 1) ──────────────────────────────

  it('(a) resolves an EPHEMERAL synthetic for an UNCLAIMED slug the caller owns no row for', async () => {
    // No owned AppBlock row (owned findFirst → null), no foreign AppBlock row
    // (findUnique → null), no pending request (pubreq findFirst → null).
    mockDbRead.appBlock.findFirst.mockResolvedValue(null);
    mockDbRead.appBlock.findUnique.mockResolvedValue(null);
    mockDbRead.appBlockPublishRequest.findFirst.mockResolvedValue(null);
    const res = await BlockRegistry.resolveDevPageBlockForAuthor('brand-new', 555);
    expect(res).not.toBeNull();
    expect(res?.status).toBe('ephemeral');
    expect(res?.trustTier).toBe('unverified');
    // Brand-new with NO tunnel session (opts omitted) → clampTunnelDeclaredScopes([])
    // force-adds only the self-bound read scope; no spend without a declared session.
    expect(res?.scopes).toEqual(['user:read:self']);
    expect(res?.ephemeralSource).toBe('brand-new');
    expect(res?.contentRating).toBeNull(); // SFW default
    expect(res?.sandbox).toBe('allow-scripts allow-forms');
    expect(res?.blockId).toBe('brand-new');
    // Synthetic, non-resolving ids — never an `appblk-`/UUID that could FK-resolve.
    expect(res?.appBlockId).toBe('ephemeral-brand-new');
    expect(res?.appId).toBe('ephemeral-brand-new');
    // No iframeSrc — the route derives the host from the tunnel only.
    expect((res as Record<string, unknown>).iframeSrc).toBeUndefined();
    // Anti-shadow guard queries: indexed unique lookup + pending lookup on the slug.
    expect(mockDbRead.appBlock.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { blockId: 'brand-new' } })
    );
    expect(mockDbRead.appBlockPublishRequest.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { slug: 'brand-new', status: 'pending' } })
    );
  });

  it('(b) REFUSES (→ null, no oracle) a slug with a FOREIGN AppBlock row (approved, other owner)', async () => {
    // The owned findFirst returns null (not the caller's), but a row EXISTS for
    // the slug globally (@@unique) — so it belongs to someone else. Bare null.
    mockDbRead.appBlock.findFirst.mockResolvedValue(null);
    mockDbRead.appBlock.findUnique.mockResolvedValue({ id: 'apb_someone_else' });
    expect(await BlockRegistry.resolveDevPageBlockForAuthor('their-app', 555)).toBeNull();
    // Refused at guard (A) — never even reaches the pending lookup.
    expect(mockDbRead.appBlockPublishRequest.findFirst).not.toHaveBeenCalled();
  });

  it('(c) REFUSES (→ null, no oracle) a slug with a FOREIGN pending publish request', async () => {
    mockDbRead.appBlock.findFirst.mockResolvedValue(null);
    mockDbRead.appBlock.findUnique.mockResolvedValue(null);
    mockDbRead.appBlockPublishRequest.findFirst.mockResolvedValue({ submittedByUserId: 999 });
    expect(await BlockRegistry.resolveDevPageBlockForAuthor('someone-pending', 555)).toBeNull();
  });

  it('(d) ALLOWS an ephemeral resolution when the caller OWNS the pending publish request', async () => {
    mockDbRead.appBlock.findFirst.mockResolvedValue(null);
    mockDbRead.appBlock.findUnique.mockResolvedValue(null);
    mockDbRead.appBlockPublishRequest.findFirst.mockResolvedValue({
      submittedByUserId: 555,
      manifest: { scopes: ['ai:write:budgeted'] },
    });
    const res = await BlockRegistry.resolveDevPageBlockForAuthor('my-pending', 555);
    expect(res).not.toBeNull();
    expect(res?.status).toBe('ephemeral');
    expect(res?.blockId).toBe('my-pending');
    // The pending select must pull the manifest (the scope source).
    expect(mockDbRead.appBlockPublishRequest.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ select: { submittedByUserId: true, manifest: true } })
    );
  });

  it('(d2) THE FIX: an owned-pending money app surfaces its budgeted scope (not the stale []) so the dev-page Generate gate is not falsely empty', async () => {
    // Regression guard for the "Grant access to generate" hang: pre-Phase-2 this
    // resolver hardcoded scopes:[], so the dev-page host told the block it had NO
    // scopes (declaredScopes → grantedScopes empty) and Generate hung — while the
    // block-token mint's JWT already carried ai:write:budgeted. The resolver now
    // mirrors the mint's clamp exactly, so the declared set matches the JWT.
    mockDbRead.appBlock.findFirst.mockResolvedValue(null);
    mockDbRead.appBlock.findUnique.mockResolvedValue(null);
    mockDbRead.appBlockPublishRequest.findFirst.mockResolvedValue({
      submittedByUserId: 555,
      // Includes a non-tunnel-allowlisted + an unknown scope — the clamp strips them.
      manifest: {
        scopes: ['ai:write:budgeted', 'buzz:read:self', 'social:tip:self', 'not:a:scope'],
      },
    });
    const res = await BlockRegistry.resolveDevPageBlockForAuthor('money-pending', 555);
    // Clamp = TUNNEL allowlist ∩ known − PAGE_FORBIDDEN, + force-granted user:read:self, sorted.
    // PAGE_FORBIDDEN_SCOPES is now empty (#3103): buzz:read:self is a page-safe,
    // low-sensitivity self-balance read and IS in the tunnel allowlist, so it
    // survives. social:tip:self is NOT in the tunnel allowlist; not:a:scope is unknown.
    expect(res?.scopes).toEqual(['ai:write:budgeted', 'buzz:read:self', 'user:read:self']);
    expect(res?.ephemeralSource).toBe('pending');
  });

  it('(f) BRAND-NEW + session grantedScopes + unsubmittedSpendAllowed → surfaces the budgeted scope', async () => {
    mockDbRead.appBlock.findFirst.mockResolvedValue(null);
    mockDbRead.appBlock.findUnique.mockResolvedValue(null);
    mockDbRead.appBlockPublishRequest.findFirst.mockResolvedValue(null);
    const res = await BlockRegistry.resolveDevPageBlockForAuthor('brand-new', 555, {
      sessionGrantedScopes: ['ai:write:budgeted'],
      unsubmittedSpendAllowed: true,
    });
    expect(res?.scopes).toEqual(['ai:write:budgeted', 'user:read:self']);
    expect(res?.ephemeralSource).toBe('brand-new');
  });

  it('(g) BRAND-NEW + session scopes but the unsubmitted-spend FLAG OFF → strips ai:write:budgeted (read-only)', async () => {
    mockDbRead.appBlock.findFirst.mockResolvedValue(null);
    mockDbRead.appBlock.findUnique.mockResolvedValue(null);
    mockDbRead.appBlockPublishRequest.findFirst.mockResolvedValue(null);
    const res = await BlockRegistry.resolveDevPageBlockForAuthor('brand-new', 555, {
      sessionGrantedScopes: ['ai:write:budgeted'],
      unsubmittedSpendAllowed: false,
    });
    expect(res?.scopes).toEqual(['user:read:self']);
    expect(res?.scopes).not.toContain('ai:write:budgeted');
    expect(res?.ephemeralSource).toBe('brand-new');
  });

  it('(h) BRAND-NEW clamps forbidden / non-allowlisted / unknown scopes out of the session set', async () => {
    mockDbRead.appBlock.findFirst.mockResolvedValue(null);
    mockDbRead.appBlock.findUnique.mockResolvedValue(null);
    mockDbRead.appBlockPublishRequest.findFirst.mockResolvedValue(null);
    const res = await BlockRegistry.resolveDevPageBlockForAuthor('brand-new', 555, {
      sessionGrantedScopes: ['ai:write:budgeted', 'apps:storage:write', 'social:tip:self', 'not:a:scope'],
      unsubmittedSpendAllowed: true,
    });
    // apps:storage:* not in the tunnel allowlist; social:tip:self page-forbidden;
    // not:a:scope unknown — all stripped, self-read force-added.
    expect(res?.scopes).toEqual(['ai:write:budgeted', 'user:read:self']);
  });

  it('(i) SECURITY: a FOREIGN CLAIMED slug returns null EVEN WITH session spend scopes (ownership precedes scopes)', async () => {
    mockDbRead.appBlock.findFirst.mockResolvedValue(null);
    mockDbRead.appBlock.findUnique.mockResolvedValue({ id: 'apb_someone_else' });
    const res = await BlockRegistry.resolveDevPageBlockForAuthor('their-app', 555, {
      sessionGrantedScopes: ['ai:write:budgeted'],
      unsubmittedSpendAllowed: true,
    });
    expect(res).toBeNull();
    // Refused at guard (A) — session scopes can NEVER cause a foreign slug to resolve.
    expect(mockDbRead.appBlockPublishRequest.findFirst).not.toHaveBeenCalled();
  });

  it('(j) SECURITY: a FOREIGN PENDING slug returns null even with session spend scopes', async () => {
    mockDbRead.appBlock.findFirst.mockResolvedValue(null);
    mockDbRead.appBlock.findUnique.mockResolvedValue(null);
    mockDbRead.appBlockPublishRequest.findFirst.mockResolvedValue({ submittedByUserId: 999 });
    const res = await BlockRegistry.resolveDevPageBlockForAuthor('someone-pending', 555, {
      sessionGrantedScopes: ['ai:write:budgeted'],
      unsubmittedSpendAllowed: true,
    });
    expect(res).toBeNull();
  });

  it('(k) a PENDING app IGNORES the session scopes AND the unsubmitted-spend flag (grants from its OWN manifest)', async () => {
    mockDbRead.appBlock.findFirst.mockResolvedValue(null);
    mockDbRead.appBlock.findUnique.mockResolvedValue(null);
    mockDbRead.appBlockPublishRequest.findFirst.mockResolvedValue({
      submittedByUserId: 555,
      manifest: { scopes: ['ai:write:budgeted'] },
    });
    const res = await BlockRegistry.resolveDevPageBlockForAuthor('my-pending', 555, {
      // Both IGNORED for the pending path — an app that IS submitted is not gated by
      // the unsubmitted-spend flag, and its scope source is the pending manifest.
      sessionGrantedScopes: ['models:read:self'],
      unsubmittedSpendAllowed: false,
    });
    expect(res?.scopes).toEqual(['ai:write:budgeted', 'user:read:self']);
    expect(res?.scopes).not.toContain('models:read:self');
    expect(res?.ephemeralSource).toBe('pending');
  });

  it('(d3) an owned-pending app that declares NO money scope stays read-only (no over-grant)', async () => {
    mockDbRead.appBlock.findFirst.mockResolvedValue(null);
    mockDbRead.appBlock.findUnique.mockResolvedValue(null);
    mockDbRead.appBlockPublishRequest.findFirst.mockResolvedValue({
      submittedByUserId: 555,
      manifest: { scopes: ['models:read:self'] },
    });
    const res = await BlockRegistry.resolveDevPageBlockForAuthor('read-pending', 555);
    // No ai:write:budgeted (not declared) — only the declared read scope + self-read.
    expect(res?.scopes).toEqual(['models:read:self', 'user:read:self']);
    expect(res?.scopes).not.toContain('ai:write:budgeted');
  });

  it.each([
    ['UpperCase', 'uppercase letters'],
    ['my.app', 'a dot'],
    ['my:app', 'a colon'],
    ['1leading', 'a leading digit'],
    ['-leading', 'a leading hyphen'],
    ['trailing-', 'a trailing hyphen'],
    ['ab', 'under the 3-char minimum'],
    ['a'.repeat(41), 'over the 40-char maximum'],
  ])(
    '(e) REFUSES (→ null, no oracle) a NON-CANONICAL slug %s (%s) WITHOUT any ephemeral DB lookup',
    async (badSlug) => {
      // No owned row for the (non-canonical) slug → falls into the ephemeral path,
      // where guard (C) rejects it BEFORE the anti-shadow DB reads. Same bare null
      // a claimed slug returns — a non-canonical slug can never match a real row
      // (every stored blockId/pending slug is canonical), so this only burns a
      // rate-limited host-pool allocation if allowed through.
      mockDbRead.appBlock.findFirst.mockResolvedValue(null);
      expect(await BlockRegistry.resolveDevPageBlockForAuthor(badSlug, 555)).toBeNull();
      // Rejected up-front — neither anti-shadow lookup runs.
      expect(mockDbRead.appBlock.findUnique).not.toHaveBeenCalled();
      expect(mockDbRead.appBlockPublishRequest.findFirst).not.toHaveBeenCalled();
    }
  );

  it('returns null on empty inputs (fail-closed)', async () => {
    expect(await BlockRegistry.resolveDevPageBlockForAuthor('', 555)).toBeNull();
    expect(await BlockRegistry.resolveDevPageBlockForAuthor('my-app', 0)).toBeNull();
    expect(mockDbRead.appBlock.findFirst).not.toHaveBeenCalled();
  });

  it('INVARIANT: the public resolvePageBlockBySlug requires status:approved (never a dev/draft app)', async () => {
    // The public run path only ever resolves an APPROVED app (its WHERE pins
    // status:'approved') — so a draft/pending dev app is invisible to it, keeping
    // the two paths disjoint. A non-approved row → the findFirst below returns null.
    mockDbRead.appBlock.findFirst.mockResolvedValue(null); // no approved row for a draft slug
    expect(await BlockRegistry.resolvePageBlockBySlug('my-app', { db: 'read' })).toBeNull();
    expect(mockDbRead.appBlock.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { blockId: 'my-app', status: 'approved' } })
    );
  });
});
