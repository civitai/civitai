import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * W10 — BlockRegistry.resolvePageBlockBySlug (the SSR page resolver).
 *
 * Pins the security-critical sourcing of the iframe sandbox's TRUST TIER:
 * it MUST come from the authoritative, mod-controlled `AppBlock.trustTier`
 * COLUMN — NOT `manifest.trustTier`, which is a publisher-self-declared field.
 * Sourcing the tier from the manifest reintroduces the C1 trust-tier
 * self-escalation class for the page sandbox (a publisher could declare
 * `internal` to widen its own sandbox). Mirrors the model render path, which
 * treats the column as authoritative (resolveRenderMode reads the column).
 *
 * Also covers the #7 nit (sandbox extracted independently of `iframe.src`'s
 * type) and the #3/#6 scope surfacing (declared scopes returned for the host's
 * granted-scope computation).
 */

import { BlockRegistry } from '~/server/services/block-registry.service';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { redisMock } from '~/__tests__/mocks/redis.mock';
const mockDbRead = dbMock.dbRead;
const mockDbWrite = dbMock.dbWrite;
const mockRedis = redisMock.redis;
const mockSysRedis = redisMock.sysRedis;
redisMock.redis.packed.set.mockImplementation(async () => undefined);
redisMock.redis.set.mockImplementation(async () => undefined);
redisMock.redis.scanIterator.mockImplementation(async function* () {});

/** A valid approved page AppBlock row as Prisma would return it from the
 *  resolvePageBlockBySlug select (id/blockId/appId/manifest/trustTier). */
function pageRow(opts: { manifest: Record<string, unknown>; trustTier: string }) {
  return {
    id: 'apb_page',
    blockId: 'hello-page',
    appId: 'appblk-hello-page',
    manifest: opts.manifest,
    trustTier: opts.trustTier,
  };
}

const PAGE_MANIFEST = (overrides: Record<string, unknown> = {}) => ({
  name: 'Hello Page',
  page: { path: '/', title: 'Hello' },
  iframe: { src: 'https://hello-page.civit.ai', sandbox: 'allow-scripts allow-forms' },
  ...overrides,
});

describe('BlockRegistry.resolvePageBlockBySlug — trust tier sourcing (#2)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('uses the authoritative trustTier COLUMN, not manifest.trustTier (column=unverified wins over manifest=internal → restrictive sandbox)', async () => {
    // The publisher SELF-DECLARES `internal` in the manifest (the widest tier),
    // but the mod-controlled COLUMN says `unverified`. The column MUST win.
    mockDbRead.appBlock.findFirst.mockResolvedValue(
      pageRow({
        manifest: PAGE_MANIFEST({ trustTier: 'internal' }),
        trustTier: 'unverified',
      })
    );
    const res = await BlockRegistry.resolvePageBlockBySlug('hello-page', { db: 'read' });
    expect(res).not.toBeNull();
    // The COLUMN value wins — a self-declared `internal` manifest does NOT
    // escalate the page sandbox's trust tier.
    expect(res?.trustTier).toBe('unverified');
  });

  it('honours a column value of internal even when manifest declares unverified', async () => {
    // The inverse: a mod has GRANTED `internal` in the column; a stale/cautious
    // manifest says `unverified`. The column is still authoritative.
    mockDbRead.appBlock.findFirst.mockResolvedValue(
      pageRow({
        manifest: PAGE_MANIFEST({ trustTier: 'unverified' }),
        trustTier: 'internal',
      })
    );
    const res = await BlockRegistry.resolvePageBlockBySlug('hello-page', { db: 'read' });
    expect(res?.trustTier).toBe('internal');
  });

  it('maps an unknown/garbage column value to unverified (fail-closed)', async () => {
    mockDbRead.appBlock.findFirst.mockResolvedValue(
      pageRow({ manifest: PAGE_MANIFEST(), trustTier: 'totally-bogus' })
    );
    const res = await BlockRegistry.resolvePageBlockBySlug('hello-page', { db: 'read' });
    expect(res?.trustTier).toBe('unverified');
  });

  it('the select requests the trustTier column (so the column is actually read)', async () => {
    mockDbRead.appBlock.findFirst.mockResolvedValue(
      pageRow({ manifest: PAGE_MANIFEST(), trustTier: 'verified' })
    );
    await BlockRegistry.resolvePageBlockBySlug('hello-page', { db: 'read' });
    const call = mockDbRead.appBlock.findFirst.mock.calls.at(-1)?.[0] as {
      select?: Record<string, unknown>;
    };
    expect(call?.select?.trustTier).toBe(true);
  });
});

describe('BlockRegistry.resolvePageBlockBySlug — sandbox + scopes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('#7: extracts the sandbox independently of iframe.src being a string', async () => {
    mockDbRead.appBlock.findFirst.mockResolvedValue(
      pageRow({ manifest: PAGE_MANIFEST(), trustTier: 'verified' })
    );
    const res = await BlockRegistry.resolvePageBlockBySlug('hello-page', { db: 'read' });
    expect(res?.sandbox).toBe('allow-scripts allow-forms');
    expect(res?.iframeSrc).toBe('https://hello-page.civit.ai');
  });

  it('#3/#6: surfaces the page manifest declared scopes for the host', async () => {
    mockDbRead.appBlock.findFirst.mockResolvedValue(
      pageRow({
        manifest: PAGE_MANIFEST({ scopes: ['apps:storage:read', 'apps:storage:write', 42] }),
        trustTier: 'verified',
      })
    );
    const res = await BlockRegistry.resolvePageBlockBySlug('hello-page', { db: 'read' });
    // Non-string entries are filtered out.
    expect(res?.scopes).toEqual(['apps:storage:read', 'apps:storage:write']);
  });

  // `bootSkeleton` makes the run host stand its branded veil down and show the
  // iframe from mount. It is PUBLISHER-CONTROLLED JSON, so the coercion has to
  // be strict — a truthy-but-not-boolean value must not switch a host behaviour
  // on. These live in the UNIT tier deliberately: the browser suite that covers
  // the rendering half is not run by CI (lint.yml excludes *.browser.test.tsx),
  // so the coercion claim was previously untested in the only tier that gates.
  it('bootSkeleton: true only for a literal boolean true', async () => {
    mockDbRead.appBlock.findFirst.mockResolvedValue(
      pageRow({ manifest: PAGE_MANIFEST({ bootSkeleton: true }), trustTier: 'verified' })
    );
    const res = await BlockRegistry.resolvePageBlockBySlug('hello-page', { db: 'read' });
    expect(res?.bootSkeleton).toBe(true);
  });

  it('bootSkeleton: false when absent — the safe default', async () => {
    mockDbRead.appBlock.findFirst.mockResolvedValue(
      pageRow({ manifest: PAGE_MANIFEST(), trustTier: 'verified' })
    );
    const res = await BlockRegistry.resolvePageBlockBySlug('hello-page', { db: 'read' });
    expect(res?.bootSkeleton).toBe(false);
  });

  it('bootSkeleton: a TRUTHY non-boolean does NOT enable it', async () => {
    // The whole point of `=== true`. Each of these is truthy in JS, and each
    // would otherwise let publisher JSON suppress the host's loading state.
    for (const value of ['true', 'false', 1, {}, [], 'yes']) {
      mockDbRead.appBlock.findFirst.mockResolvedValue(
        pageRow({ manifest: PAGE_MANIFEST({ bootSkeleton: value }), trustTier: 'verified' })
      );
      const res = await BlockRegistry.resolvePageBlockBySlug('hello-page', { db: 'read' });
      expect(res?.bootSkeleton).toBe(false);
    }
  });

  it('returns scopes:[] when the manifest declares none', async () => {
    mockDbRead.appBlock.findFirst.mockResolvedValue(
      pageRow({ manifest: PAGE_MANIFEST(), trustTier: 'verified' })
    );
    const res = await BlockRegistry.resolvePageBlockBySlug('hello-page', { db: 'read' });
    expect(res?.scopes).toEqual([]);
  });

  it('returns null for a non-page manifest (no page descriptor)', async () => {
    mockDbRead.appBlock.findFirst.mockResolvedValue(
      pageRow({
        manifest: { name: 'x', iframe: { src: 'https://x.civit.ai' } },
        trustTier: 'verified',
      })
    );
    const res = await BlockRegistry.resolvePageBlockBySlug('hello-page', { db: 'read' });
    expect(res).toBeNull();
  });

  it('returns null when no approved row owns the slug', async () => {
    mockDbRead.appBlock.findFirst.mockResolvedValue(null);
    const res = await BlockRegistry.resolvePageBlockBySlug('missing', { db: 'read' });
    expect(res).toBeNull();
  });
});

describe('BlockRegistry.resolvePageBlockBySlug — NSFW-app-red-only contentRating', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('the select requests the contentRating column (so the run-page gate can read it)', async () => {
    mockDbRead.appBlock.findFirst.mockResolvedValue({
      ...pageRow({ manifest: PAGE_MANIFEST(), trustTier: 'verified' }),
      contentRating: 'g',
    });
    await BlockRegistry.resolvePageBlockBySlug('hello-page', { db: 'read' });
    const call = mockDbRead.appBlock.findFirst.mock.calls.at(-1)?.[0] as {
      select?: Record<string, unknown>;
    };
    expect(call?.select?.contentRating).toBe(true);
  });

  it('surfaces the contentRating column value (mature)', async () => {
    mockDbRead.appBlock.findFirst.mockResolvedValue({
      ...pageRow({ manifest: PAGE_MANIFEST(), trustTier: 'verified' }),
      contentRating: 'x',
    });
    const res = await BlockRegistry.resolvePageBlockBySlug('hello-page', { db: 'read' });
    expect(res?.contentRating).toBe('x');
  });

  it('null-safe: a missing/non-string column → null (treated as SFW by the gate)', async () => {
    mockDbRead.appBlock.findFirst.mockResolvedValue({
      ...pageRow({ manifest: PAGE_MANIFEST(), trustTier: 'verified' }),
      contentRating: undefined,
    });
    const res = await BlockRegistry.resolvePageBlockBySlug('hello-page', { db: 'read' });
    expect(res?.contentRating).toBeNull();
  });
});

/**
 * 🔴 THE MINT-SIDE MIRROR OF THE SSR INVARIANT — and its ABSENCE is what created
 * `tryDevTunnelOwnedNonApprovedMint`.
 *
 * `block-registry.resolve-dev.test.ts` pins one half:
 * "INVARIANT: the public resolvePageBlockBySlug requires status:approved". That is the
 * SSR resolver. The MINT resolver, `resolvePageBlock`, had no equivalent — and the
 * asymmetry between the two sides of exactly this seam is the whole reason a rescue
 * branch had to be written after the fact. Pinning the invariant on ONE side of a seam
 * is how you discover the other side disagreed.
 *
 * With the private-run surface added, these two resolvers are no longer the only ways to
 * reach a page app, so the property they guarantee has to be stated rather than assumed:
 * they remain APPROVED-ONLY, and the non-approved surface is reached exclusively through
 * `resolvePrivateRunPageBlock` behind `resolvePrivateRunAccess`.
 */
describe('BlockRegistry.resolvePageBlock — the MINT-side approved-only invariant [INV]', () => {
  beforeEach(() => {
    // 🔴 `clearAllMocks` AS WELL AS the targeted reset, matching this file's three other
    // describes. The canonical db mock is shared per WORKER under `isolate: false`, and
    // the last test in this block asserts `mockDbRead.appBlock.findUnique` was NOT
    // called — the assertion shape most exposed to a call inherited from a previous
    // file. Resetting only the one handle left that assertion reading a dirty spy.
    vi.clearAllMocks();
    mockDbWrite.appBlock.findUnique.mockReset();
    mockDbRead.appBlock.findUnique.mockReset();
  });

  it('INVARIANT: a NON-APPROVED row resolves to null, whatever its status', async () => {
    // The status gate is POST-query here (unlike `resolvePageBlockBySlug`, which pins it
    // in the WHERE), so a row IS returned by Prisma and the refusal is the branch. That
    // makes this the more important of the two to pin behaviourally: there is no WHERE
    // clause to read, only a branch that could be deleted.
    for (const status of ['suspended', 'pending', 'deprecated', 'removed', 'draft', '']) {
      mockDbWrite.appBlock.findUnique.mockResolvedValue({
        id: 'apb_1',
        blockId: 'hello-page',
        appId: 'app_1',
        status,
        manifest: PAGE_MANIFEST(),
        approvedScopes: [],
        currentVersionDeployedAt: new Date('2026-09-01'),
        app: { allowedScopes: 0 },
      });
      expect(
        await BlockRegistry.resolvePageBlock('apb_1'),
        `status=${JSON.stringify(status)} must not resolve through the production mint`
      ).toBeNull();
    }
  });

  it('POSITIVE CONTROL: an APPROVED row DOES resolve — the refusal above is not vacuous', async () => {
    // Without this the loop above would pass against a resolver that returned null for
    // everything, including a healthy approved app.
    mockDbWrite.appBlock.findUnique.mockResolvedValue({
      id: 'apb_1',
      blockId: 'hello-page',
      appId: 'app_1',
      status: 'approved',
      manifest: PAGE_MANIFEST(),
      approvedScopes: ['models:read:self'],
      currentVersionDeployedAt: new Date('2026-09-01'),
      app: { allowedScopes: 0 },
    });
    const res = await BlockRegistry.resolvePageBlock('apb_1');
    expect(res?.appBlock.id).toBe('apb_1');
    expect(res?.appBlock.status).toBe('approved');
  });

  it('reads the PRIMARY by default, so a freshly-suspended block cannot slip a lag window', async () => {
    mockDbWrite.appBlock.findUnique.mockResolvedValue(null);
    await BlockRegistry.resolvePageBlock('apb_1');
    expect(mockDbWrite.appBlock.findUnique).toHaveBeenCalled();
    expect(mockDbRead.appBlock.findUnique).not.toHaveBeenCalled();
  });
});

/**
 * 🔴 `resolvePrivateRunPageBlock` — THE PROJECTION, WHICH WAS COVERED NOWHERE.
 *
 * ⚠️ THIS DESCRIBE WAS ADDED BECAUSE REVIEW FOUND THE NEW RESOLVER'S OUTPUT ENTIRELY
 * UNTESTED. The predicate suite reaches only its three REFUSAL branches; the SSR page
 * test mocks the predicate away, so the projection never runs; the seam ledger only
 * counts its callers. The consequence was not theoretical: a mutant sourcing
 * `trustTier` from `manifest.trustTier` instead of the COLUMN survived the entire suite.
 *
 * That is the C1 trust-tier SELF-ESCALATION class — a publisher declaring `internal` in
 * their own manifest to widen the iframe sandbox — and this route passes the value
 * straight through to `PageBlockHost`. The public sibling `resolvePageBlockBySlug` has
 * two dedicated tests for exactly this, above; the new resolver copied the logic without
 * the tests, which is the specific way a copied projection goes wrong.
 */
describe('BlockRegistry.resolvePrivateRunPageBlock — the projection [REG]', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDbWrite.appBlock.findFirst.mockReset();
  });

  /** A suspended, deployed, page-declaring row as Prisma would return it. */
  const row = (over: Record<string, unknown> = {}) => ({
    id: 'apb_pr',
    blockId: 'hello-page',
    appId: 'app_pr',
    status: 'suspended',
    manifest: PAGE_MANIFEST(),
    approvedScopes: ['models:read:self'],
    trustTier: 'unverified',
    contentRating: 'g',
    currentVersionDeployedAt: new Date('2026-09-01'),
    app: { userId: 4001 },
    appListing: { status: 'removed' },
    ...over,
  });

  it('🔴 trustTier comes from the COLUMN — column=unverified WINS over manifest=internal', async () => {
    // The C1 self-escalation case, stated as the public sibling states it: a
    // publisher-declared `internal` must not widen the sandbox.
    mockDbWrite.appBlock.findFirst.mockResolvedValue(
      row({ manifest: PAGE_MANIFEST({ trustTier: 'internal' }), trustTier: 'unverified' })
    );
    const res = await BlockRegistry.resolvePrivateRunPageBlock({ appBlockId: 'apb_pr' });
    expect(res.ok).toBe(true);
    expect(res.ok && res.block.trustTier).toBe('unverified');
  });

  it('honours a COLUMN value of internal even when the manifest declares unverified', async () => {
    // The mirror image — without it, the row above passes against a resolver that
    // hardcodes `'unverified'`, which is the wrong reason to be safe.
    mockDbWrite.appBlock.findFirst.mockResolvedValue(
      row({ manifest: PAGE_MANIFEST({ trustTier: 'unverified' }), trustTier: 'internal' })
    );
    const res = await BlockRegistry.resolvePrivateRunPageBlock({ appBlockId: 'apb_pr' });
    expect(res.ok && res.block.trustTier).toBe('internal');
  });

  it('maps a garbage column value to unverified (fail-closed)', async () => {
    mockDbWrite.appBlock.findFirst.mockResolvedValue(row({ trustTier: 'super-trusted' }));
    const res = await BlockRegistry.resolvePrivateRunPageBlock({ appBlockId: 'apb_pr' });
    expect(res.ok && res.block.trustTier).toBe('unverified');
  });

  it('the select requests every column the private surface gates on', async () => {
    // The gates are only as good as the columns being read. A `select` that quietly
    // dropped `currentVersionDeployedAt` would make the deploy gate read `undefined` —
    // which is `== null`, so it would refuse EVERYTHING and look like a broken feature
    // rather than a hole; dropping `app` would make the ban gate skip silently, which is
    // the dangerous direction.
    mockDbWrite.appBlock.findFirst.mockResolvedValue(null);
    await BlockRegistry.resolvePrivateRunPageBlock({ appBlockId: 'apb_pr' });
    const call = mockDbWrite.appBlock.findFirst.mock.calls.at(-1)?.[0] as {
      select?: Record<string, unknown>;
    };
    expect(call?.select?.currentVersionDeployedAt).toBe(true);
    expect(call?.select?.trustTier).toBe(true);
    expect(call?.select?.contentRating).toBe(true);
    expect(call?.select?.approvedScopes).toBe(true);
    expect(call?.select?.status).toBe(true);
    expect(call?.select?.app).toBeTruthy();
  });

  it('projects the manifest fields the host needs, with the strict bootSkeleton rule', async () => {
    mockDbWrite.appBlock.findFirst.mockResolvedValue(row());
    const res = await BlockRegistry.resolvePrivateRunPageBlock({ appBlockId: 'apb_pr' });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.block.appBlockId).toBe('apb_pr');
    expect(res.block.blockId).toBe('hello-page');
    expect(res.block.appId).toBe('app_pr');
    expect(res.block.status).toBe('suspended');
    expect(res.block.approvedScopes).toEqual(['models:read:self']);
    expect(res.block.ownerUserId).toBe(4001);
    expect(res.block.listingStatus).toBe('removed');
    expect(res.block.currentVersionDeployedAt).toEqual(new Date('2026-09-01'));
    // STRICT `=== true`: publisher JSON must not flip a host behaviour with a
    // truthy-but-not-boolean value.
    expect(res.block.bootSkeleton).toBe(false);
  });

  it('bootSkeleton is true ONLY for a literal boolean true', async () => {
    for (const [value, expected] of [
      [true, true],
      ['true', false],
      [1, false],
      [{}, false],
      [undefined, false],
    ] as const) {
      mockDbWrite.appBlock.findFirst.mockResolvedValue(
        row({ manifest: PAGE_MANIFEST({ bootSkeleton: value }) })
      );
      const res = await BlockRegistry.resolvePrivateRunPageBlock({ appBlockId: 'apb_pr' });
      expect(res.ok && res.block.bootSkeleton, `bootSkeleton=${String(value)}`).toBe(expected);
    }
  });

  it('null-safe on the nullable columns, in the fail-closed direction', async () => {
    mockDbWrite.appBlock.findFirst.mockResolvedValue(
      row({ contentRating: undefined, currentVersionDeployedAt: null, app: null, appListing: null })
    );
    const res = await BlockRegistry.resolvePrivateRunPageBlock({ appBlockId: 'apb_pr' });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    // A missing/garbage rating is treated as SFW by the host gate, which is the safe
    // reading for a gate that refuses MATURE content.
    expect(res.block.contentRating).toBeNull();
    // `null` here is what the deploy gate refuses on — the fail-closed direction.
    expect(res.block.currentVersionDeployedAt).toBeNull();
    // A dangling owner becomes `null`, which the predicate can only pair with `no-role`.
    expect(res.block.ownerUserId).toBeNull();
    expect(res.block.listingStatus).toBeNull();
  });

  it('extracts sandbox independently of iframe.src being a string (#7 parity)', async () => {
    mockDbWrite.appBlock.findFirst.mockResolvedValue(
      row({
        manifest: {
          ...PAGE_MANIFEST(),
          iframe: { src: 12345, sandbox: 'allow-scripts allow-forms' },
        },
      })
    );
    const res = await BlockRegistry.resolvePrivateRunPageBlock({ appBlockId: 'apb_pr' });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.block.sandbox).toBe('allow-scripts allow-forms');
    // A non-string src projects to '' — which the SSR route refuses on.
    expect(res.block.iframeSrc).toBe('');
  });

  it('the three refusals are DISCRIMINATED, not one bare null', async () => {
    mockDbWrite.appBlock.findFirst.mockResolvedValue(null);
    expect(await BlockRegistry.resolvePrivateRunPageBlock({ appBlockId: 'apb_pr' })).toEqual({
      ok: false,
      reason: 'no-app',
    });

    mockDbWrite.appBlock.findFirst.mockResolvedValue(row({ status: 'approved' }));
    expect(await BlockRegistry.resolvePrivateRunPageBlock({ appBlockId: 'apb_pr' })).toEqual({
      ok: false,
      reason: 'approved',
    });

    mockDbWrite.appBlock.findFirst.mockResolvedValue(row({ manifest: { name: 'x', scopes: [] } }));
    expect(await BlockRegistry.resolvePrivateRunPageBlock({ appBlockId: 'apb_pr' })).toEqual({
      ok: false,
      reason: 'not-a-page',
    });
  });
});
