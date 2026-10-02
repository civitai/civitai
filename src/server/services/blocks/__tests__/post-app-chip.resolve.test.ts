/**
 * The ORDERING and the COST of the post-detail app-chip resolution.
 *
 * `resolvePostAppChip` takes both database reads as arguments, and that is the
 * point of the shape rather than a testing convenience: the properties that
 * matter here are about which reads happen AT ALL, and no assertion over a
 * return value can see them.
 *
 *  - the store-visibility gate runs BEFORE either read (a disclosure property —
 *    a viewer without store visibility must learn nothing and cost nothing),
 *  - the marker must resolve before the app is looked up (a cost property — the
 *    overwhelming majority of posts carry no marker and must pay no extra query).
 *
 * Both are asserted with spies and call COUNTS, not by inspecting output: a post
 * with no marker and a post whose app does not resolve both produce a `null`
 * chip, so output cannot distinguish "took no query" from "took one and threw it
 * away". The `outcome` discriminator makes them tellable apart on the wire too —
 * it is what the fail-open counter labels, so each branch is asserted here.
 *
 * ⚠️ WHAT THIS FILE CANNOT SEE, stated so it is not mistaken for complete: every
 * test here injects `storeScope` and both reads directly. Replacing the real
 * `resolveStoreVisibilityScope({ user })` with the literal `'full'` at the CALL
 * SITE, or dropping the allowlisted `select`, leaves all of this green —
 * measured. `post-app-chip.service.test.ts` is the file that covers the wiring.
 */
import { describe, expect, it, vi } from 'vitest';
import type { StoreVisibilityScope } from '~/shared/utils/store-visibility-scope';
import { resolvePostAppChip } from '~/server/services/blocks/post-app-chip.logic';

const POST_ID = 31107522;
const MARKER = 'appblk-custom-generators';
const HOST = 'civitai.com';

const approvedRow = {
  name: 'Custom Generators Client',
  appBlocks: [
    {
      status: 'approved',
      currentVersionDeployedAt: new Date('2026-09-01T00:00:00.000Z'),
      appListing: {
        slug: 'custom-generators',
        name: 'Custom Generators',
        status: 'approved',
        kind: 'onsite',
        contentRating: 'pg',
        revisionOfId: null,
        icon: null,
      },
    },
  ],
};

function harness(opts: { storeScope: StoreVisibilityScope; metadata?: unknown; app?: unknown }) {
  const readPostMetadata = vi.fn(async () => opts.metadata ?? null);
  const readApp = vi.fn(async () => (opts.app ?? null) as never);
  return {
    readPostMetadata,
    readApp,
    run: () =>
      resolvePostAppChip({
        postId: POST_ID,
        storeScope: opts.storeScope,
        host: HOST,
        readPostMetadata,
        readApp,
      }),
  };
}

describe('the store-visibility gate runs first and short-circuits both reads', () => {
  // The App Store detail surface is not public yet, so an ungated chip would
  // publish app names — and the existence of App Blocks — onto public post pages
  // ahead of the launch, and hand out links the destination refuses to serve.
  for (const scope of ['none', 'public-external'] as StoreVisibilityScope[]) {
    it(`renders nothing and issues NO query at scope "${scope}"`, async () => {
      const h = harness({
        storeScope: scope,
        metadata: { blockPublishedAppId: MARKER },
        app: approvedRow,
      });
      await expect(h.run()).resolves.toEqual({ chip: null, outcome: 'gated' });
      // 🔴 Not "returns null" — returns null WITHOUT READING ANYTHING. Move the
      // gate below the marker read and this is the assertion that fails.
      expect(h.readPostMetadata).toHaveBeenCalledTimes(0);
      expect(h.readApp).toHaveBeenCalledTimes(0);
    });
  }

  it('is an allowlist, so an unrecognised scope is refused rather than admitted', async () => {
    // 🔴 The cast is load-bearing, not a smell. The scope union is CLOSED at
    // compile time, so a denylist (`scope === 'none' || scope === 'public-external'`)
    // type-checks and passes every other test in this file — measured, it kills
    // only this one. A fourth scope is exactly the thing that grows, and the
    // shared `scopeAdmitsListingKind` switch is what makes adding one a compile
    // error rather than a silent open.
    const h = harness({
      storeScope: 'partner-preview' as StoreVisibilityScope,
      metadata: { blockPublishedAppId: MARKER },
      app: approvedRow,
    });
    await expect(h.run()).resolves.toEqual({ chip: null, outcome: 'gated' });
    expect(h.readPostMetadata).toHaveBeenCalledTimes(0);
  });

  it('proceeds at scope "full" — the positive control for every zero above', async () => {
    // Without this, each "0 queries" assertion above is indistinguishable from a
    // harness wired to nothing.
    const h = harness({
      storeScope: 'full',
      metadata: { blockPublishedAppId: MARKER },
      app: approvedRow,
    });
    await expect(h.run()).resolves.toEqual({
      chip: { slug: 'custom-generators', name: 'Custom Generators', iconUrl: null },
      outcome: 'chip',
    });
    expect(h.readPostMetadata).toHaveBeenCalledTimes(1);
    expect(h.readPostMetadata).toHaveBeenCalledWith(POST_ID);
    expect(h.readApp).toHaveBeenCalledTimes(1);
    expect(h.readApp).toHaveBeenCalledWith(MARKER);
  });
});

describe('a post with no marker costs no app lookup', () => {
  it('reads the marker, finds none, and NEVER looks up an OauthClient', async () => {
    // 🔴 Criterion 4. This is the common path — almost every post on the site —
    // so the assertion that matters is the call count, not the output.
    const h = harness({ storeScope: 'full', metadata: { imageNsfwLevel: 1, imageNsfw: false } });
    await expect(h.run()).resolves.toEqual({ chip: null, outcome: 'no-marker' });
    expect(h.readPostMetadata).toHaveBeenCalledTimes(1);
    expect(h.readApp).toHaveBeenCalledTimes(0);
  });

  it('takes the same path when metadata is absent entirely', async () => {
    const h = harness({ storeScope: 'full', metadata: null });
    await expect(h.run()).resolves.toEqual({ chip: null, outcome: 'no-marker' });
    expect(h.readApp).toHaveBeenCalledTimes(0);
  });

  it('takes the same path for a blank marker', async () => {
    const h = harness({ storeScope: 'full', metadata: { blockPublishedAppId: '  ' } });
    await expect(h.run()).resolves.toEqual({ chip: null, outcome: 'no-marker' });
    expect(h.readApp).toHaveBeenCalledTimes(0);
  });
});

describe('the three resolve branches', () => {
  it('(a) an UNRESOLVABLE marker renders no chip', async () => {
    // Reachable by design: the dev-scoped mint path carries `posts:write:self`
    // and mints a deliberately synthetic appId that matches no OauthClient. No
    // live instance exists, so this is a fixture.
    const h = harness({
      storeScope: 'full',
      metadata: { blockPublishedAppId: 'devblk-synthetic-nonresolving' },
      app: null,
    });
    // 🔴 `unresolved`, NOT `no-marker` — the two are the same `null` on the wire
    // and the counter is the only thing that can tell them apart in production.
    await expect(h.run()).resolves.toEqual({ chip: null, outcome: 'unresolved' });
    // It still LOOKED the app up — the marker is never string-munged into a link.
    expect(h.readApp).toHaveBeenCalledTimes(1);
    expect(h.readApp).toHaveBeenCalledWith('devblk-synthetic-nonresolving');
  });

  it('(b) a resolvable but NOT-VIEWABLE app renders the name with no link', async () => {
    const h = harness({
      storeScope: 'full',
      metadata: { blockPublishedAppId: 'appblk-ab-img-poster' },
      app: {
        name: 'Ab Img Poster',
        appBlocks: [
          {
            status: 'suspended',
            currentVersionDeployedAt: null,
            appListing: {
              slug: 'ab-img-poster',
              name: 'Ab Img Poster',
              status: 'removed',
              kind: 'onsite',
              contentRating: 'pg',
              revisionOfId: null,
              icon: null,
            },
          },
        ],
      },
    });
    await expect(h.run()).resolves.toEqual({
      chip: { slug: null, name: 'Ab Img Poster', iconUrl: null },
      // A chip WAS produced — the name is the chip. Only the link is withheld.
      outcome: 'chip',
    });
  });

  it('(c) a VIEWABLE app renders a linkable chip', async () => {
    const h = harness({
      storeScope: 'full',
      metadata: { blockPublishedAppId: MARKER },
      app: approvedRow,
    });
    const { chip, outcome } = await h.run();
    expect(chip).toMatchObject({ slug: 'custom-generators' });
    expect(outcome).toBe('chip');
  });
});
