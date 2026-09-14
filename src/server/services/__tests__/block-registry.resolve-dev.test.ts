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

import { BlockRegistry } from '~/server/services/block-registry.service';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { redisMock } from '~/__tests__/mocks/redis.mock';
const mockDbRead = dbMock.dbRead;
const mockDbWrite = dbMock.dbWrite;
const mockRedis = redisMock.redis;
const mockSysRedis = redisMock.sysRedis;

function ownRow(status: string) {
  return {
    id: 'apb_dev',
    blockId: 'my-app',
    appId: 'appblk-my-app',
    status,
    manifest: {
      name: 'My App',
      scopes: ['ai:write:budgeted'],
      iframe: { sandbox: 'allow-scripts' },
    },
    trustTier: 'unverified',
    contentRating: null,
  };
}

/**
 * An OWNED AppBlock row whose manifest carries an arbitrary extra shape — the
 * owned dev projection reads `manifest.page`, which `ownRow` does not declare at
 * all, so a `page.*` claim needs a row that can express one.
 */
function ownRowWithManifest(manifest: Record<string, unknown>) {
  return { ...ownRow('approved'), manifest: { name: 'My App', scopes: [], ...manifest } };
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

  it('(d3) an owned-pending app surfaces its bootSkeleton so the DEV TUNNEL matches production', async () => {
    // The dev tunnel is where an author checks their own app BEFORE approval —
    // so hardcoding `false` here made the one surface built to show them the
    // feature the one surface that could not. `pending.manifest` is already
    // selected and already read for `scopes`; there was nothing to fetch.
    mockDbRead.appBlock.findFirst.mockResolvedValue(null);
    mockDbRead.appBlock.findUnique.mockResolvedValue(null);
    mockDbRead.appBlockPublishRequest.findFirst.mockResolvedValue({
      submittedByUserId: 555,
      manifest: { scopes: [], bootSkeleton: true },
    });
    const res = await BlockRegistry.resolveDevPageBlockForAuthor('my-pending', 555);
    expect(res?.bootSkeleton).toBe(true);
  });

  it('(d4) the dev tunnel applies the SAME strict === true coercion', async () => {
    // Publisher JSON. A truthy non-boolean must not switch a host behaviour on
    // here either — the second coercion site the first round left untested.
    for (const value of ['true', 1, {}, 'yes']) {
      mockDbRead.appBlock.findFirst.mockResolvedValue(null);
      mockDbRead.appBlock.findUnique.mockResolvedValue(null);
      mockDbRead.appBlockPublishRequest.findFirst.mockResolvedValue({
        submittedByUserId: 555,
        manifest: { scopes: [], bootSkeleton: value },
      });
      const res = await BlockRegistry.resolveDevPageBlockForAuthor('my-pending', 555);
      expect(res?.bootSkeleton).toBe(false);
    }
  });

  it('(d5) a brand-new (unclaimed) slug has no manifest, so it stays false', async () => {
    // Control for d3: without it, d3 passing would not prove the manifest is
    // what moved the value.
    mockDbRead.appBlock.findFirst.mockResolvedValue(null);
    mockDbRead.appBlock.findUnique.mockResolvedValue(null);
    mockDbRead.appBlockPublishRequest.findFirst.mockResolvedValue(null);
    const res = await BlockRegistry.resolveDevPageBlockForAuthor('brand-new', 555);
    expect(res?.ephemeralSource).toBe('brand-new');
    expect(res?.bootSkeleton).toBe(false);
  });

  // ── `page.fullBleed` ON BOTH DEV-TUNNEL PROJECTIONS ──────────────────────
  //
  // 🔴 THESE TWO READS SHIPPED WITH NO TEST AT ALL, WHICH IS THE SAME HOLE
  // `bootSkeleton` (d3–d5 above) was dug out of, one field later. The dev tunnel
  // is where an author checks their OWN app before approval, so a projection
  // hardcoded to `false` here makes the one surface that exists to show them the
  // feature the one surface that cannot — they declare `page.fullBleed`, open
  // /apps/dev/<blockId>, see the capped column and conclude the field does
  // nothing. Nothing else in the suite reaches either read: the approved/run
  // projection is covered by `block-registry.resolve-page.test.ts` and the review
  // mint by `publish-request.mintReviewToken.test.ts`, and neither executes this
  // function.
  //
  // EVERY CASE BELOW IS TWO-POINT ON PURPOSE. A single `declares true → true`
  // assertion is equally satisfied by a projection hardcoded to `true`, so each
  // test drives a declaring AND a non-declaring manifest through the SAME call and
  // asserts the results DIFFER. The depth arm matters for the same reason it does
  // on the run path: `bootSkeleton` sits at the manifest ROOT while `fullBleed`
  // sits under `page`, so a read at the wrong depth is the plausible mistake and it
  // fails silently (always `false`).

  it('(fb1) OWNED path: `page.fullBleed` travels, and an app that declares nothing stays capped', async () => {
    mockDbRead.appBlock.findFirst.mockResolvedValue(
      ownRowWithManifest({ page: { path: '/', title: 'Bleed', fullBleed: true } })
    );
    const declared = await BlockRegistry.resolveDevPageBlockForAuthor('my-app', 555);
    expect(
      declared?.fullBleed,
      'an OWNED app declaring `page.fullBleed: true` resolves to `fullBleed: false` on the dev ' +
        'tunnel. The author checking their own app before approval is shown the capped column ' +
        'the run page will NOT give them.'
    ).toBe(true);

    mockDbRead.appBlock.findFirst.mockResolvedValue(
      ownRowWithManifest({ page: { path: '/', title: 'Bleed' } })
    );
    const undeclared = await BlockRegistry.resolveDevPageBlockForAuthor('my-app', 555);
    expect(
      undeclared?.fullBleed,
      'an OWNED app that declares NOTHING resolves to `fullBleed: true` on the dev tunnel — the ' +
        'projection is hardcoded or inverted, and the cap is no longer the default.'
    ).toBe(false);

    expect(
      declared?.fullBleed === undeclared?.fullBleed,
      'both arms resolved to the same value, so the manifest is not what moved it'
    ).toBe(false);
  });

  it('(fb2) OWNED path: strict `=== true`, and the field is read at `page.` depth only', async () => {
    // Publisher JSON. The approve-time validator rejects a non-boolean, but the
    // projection must not depend on that having run — an older snapshot predates it.
    for (const value of ['true', 1, {}, 'yes', [], 'false']) {
      mockDbRead.appBlock.findFirst.mockResolvedValue(
        ownRowWithManifest({ page: { path: '/', title: 'x', fullBleed: value } })
      );
      const res = await BlockRegistry.resolveDevPageBlockForAuthor('my-app', 555);
      expect(res?.fullBleed, `page.fullBleed=${JSON.stringify(value)}`).toBe(false);
    }
    // DEPTH. `bootSkeleton` is a manifest-ROOT boolean and `fullBleed` is not;
    // accepting both spellings would make the documented field ambiguous and would
    // let a `page`-less manifest opt out of the cap.
    mockDbRead.appBlock.findFirst.mockResolvedValue(ownRowWithManifest({ fullBleed: true }));
    const topLevel = await BlockRegistry.resolveDevPageBlockForAuthor('my-app', 555);
    expect(
      topLevel?.fullBleed,
      'a TOP-LEVEL `fullBleed` enabled full bleed on the dev tunnel. The documented field is ' +
        '`page.fullBleed`; a second accepted spelling here would disagree with the run page and ' +
        'with the approve-time validator.'
    ).toBe(false);
  });

  it('(fb3) EPHEMERAL path: the PENDING manifest’s `page.fullBleed` travels, and its absence does not', async () => {
    const pending = (page: unknown) => {
      mockDbRead.appBlock.findFirst.mockResolvedValue(null);
      mockDbRead.appBlock.findUnique.mockResolvedValue(null);
      mockDbRead.appBlockPublishRequest.findFirst.mockResolvedValue({
        submittedByUserId: 555,
        manifest: { scopes: [], page },
      });
    };

    pending({ path: '/', title: 'Bleed', fullBleed: true });
    const declared = await BlockRegistry.resolveDevPageBlockForAuthor('my-pending', 555);
    expect(declared?.ephemeralSource).toBe('pending');
    expect(
      declared?.fullBleed,
      'an owned-PENDING app declaring `page.fullBleed: true` resolves to false on the dev ' +
        'tunnel. This is the pre-approval surface, i.e. the only place the author can see the ' +
        'declaration they just wrote take effect.'
    ).toBe(true);

    pending({ path: '/', title: 'Bleed' });
    const undeclared = await BlockRegistry.resolveDevPageBlockForAuthor('my-pending', 555);
    expect(
      undeclared?.fullBleed,
      'an owned-PENDING app that declares nothing resolved to full bleed — `ephemeralFullBleed` ' +
        'is hardcoded or inverted.'
    ).toBe(false);

    expect(
      declared?.fullBleed === undeclared?.fullBleed,
      'both arms resolved to the same value, so the pending manifest is not what moved it'
    ).toBe(false);
  });

  it('(fb4) EPHEMERAL path: strict `=== true`, page depth, and a brand-new slug stays capped', async () => {
    for (const value of ['true', 1, {}, 'yes', 'false']) {
      mockDbRead.appBlock.findFirst.mockResolvedValue(null);
      mockDbRead.appBlock.findUnique.mockResolvedValue(null);
      mockDbRead.appBlockPublishRequest.findFirst.mockResolvedValue({
        submittedByUserId: 555,
        manifest: { scopes: [], page: { fullBleed: value } },
      });
      const res = await BlockRegistry.resolveDevPageBlockForAuthor('my-pending', 555);
      expect(res?.fullBleed, `pending page.fullBleed=${JSON.stringify(value)}`).toBe(false);
    }

    // DEPTH on the pending manifest too.
    mockDbRead.appBlock.findFirst.mockResolvedValue(null);
    mockDbRead.appBlock.findUnique.mockResolvedValue(null);
    mockDbRead.appBlockPublishRequest.findFirst.mockResolvedValue({
      submittedByUserId: 555,
      manifest: { scopes: [], fullBleed: true },
    });
    const topLevel = await BlockRegistry.resolveDevPageBlockForAuthor('my-pending', 555);
    expect(
      topLevel?.fullBleed,
      'a TOP-LEVEL `fullBleed` on the PENDING manifest enabled full bleed on the dev tunnel'
    ).toBe(false);

    // The brand-new control: no manifest exists at all, so the value can only be
    // the safe default. Without this arm, fb3's positive would not prove the
    // pending manifest is the source rather than the ephemeral branch itself.
    mockDbRead.appBlock.findFirst.mockResolvedValue(null);
    mockDbRead.appBlock.findUnique.mockResolvedValue(null);
    mockDbRead.appBlockPublishRequest.findFirst.mockResolvedValue(null);
    const brandNew = await BlockRegistry.resolveDevPageBlockForAuthor('brand-new', 555);
    expect(brandNew?.ephemeralSource).toBe('brand-new');
    expect(brandNew?.fullBleed).toBe(false);
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
      sessionGrantedScopes: [
        'ai:write:budgeted',
        'apps:storage:write',
        'social:tip:self',
        'not:a:scope',
      ],
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
