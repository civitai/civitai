/**
 * Go-live ACTIONABILITY gate — correctness coverage.
 *
 * The invariant under test: an OFF-SITE listing may not go live while the store
 * would render it a primary CTA the viewer cannot click. The gate delegates its
 * verdict to the real `getDetailPrimaryAction` view-model, so these tests pin the
 * CONTRACT ("blocked ⟺ the rendered action has no href") rather than any
 * particular CTA copy — the copy is #3585's business and must be free to move
 * without touching this file.
 */
import { TRPCError } from '@trpc/server';
import { describe, expect, it } from 'vitest';

import { getDetailPrimaryAction } from '~/components/Apps/appListingDetailView';
import {
  assertOffsiteListingActionable,
  buildActionabilityError,
  checkOffsiteListingActionable,
  type ListingActionabilitySource,
} from '~/server/services/blocks/app-listing-actionable.service';

const offsite = (over: Partial<ListingActionabilitySource> = {}): ListingActionabilitySource => ({
  kind: 'offsite',
  slug: 'demo-app',
  externalUrl: 'https://demo.app',
  connectClientId: null,
  ...over,
});

/** Every way an off-site listing can end up with no reachable destination. */
const NO_DESTINATION: { name: string; url: string | null }[] = [
  { name: 'null', url: null },
  { name: 'empty string', url: '' },
  { name: 'http (not https)', url: 'http://insecure.app' },
  { name: 'javascript: scheme', url: 'javascript:alert(1)' },
];

describe('checkOffsiteListingActionable — the verdict', () => {
  it('passes an off-site external-link listing with an https destination', () => {
    const result = checkOffsiteListingActionable(offsite());
    expect(result.ok).toBe(true);
    expect(result.skipped).toBe(false);
    expect(result.action?.href).toBe('https://demo.app');
  });

  for (const { name, url } of NO_DESTINATION) {
    it(`BLOCKS an off-site external-link listing whose externalUrl is ${name}`, () => {
      const result = checkOffsiteListingActionable(offsite({ externalUrl: url }));
      expect(result.ok).toBe(false);
      expect(result.action?.href).toBeUndefined();
    });
  }

  for (const { name, url } of NO_DESTINATION) {
    it(`BLOCKS an off-site CONNECT listing whose externalUrl is ${name}`, () => {
      // client_id present → `resolveOffsiteSubKind` routes this to the connect arm.
      const result = checkOffsiteListingActionable(
        offsite({ externalUrl: url, connectClientId: 'client-123' })
      );
      expect(result.ok).toBe(false);
      expect(result.action?.href).toBeUndefined();
    });
  }

  it('treats an ABSENT externalUrl the same as an explicit null (Prisma create input)', () => {
    const { externalUrl: _drop, ...withoutUrl } = offsite();
    expect(checkOffsiteListingActionable(withoutUrl).ok).toBe(false);
  });

  it('is uppercase-scheme strict — HTTPS:// is not accepted as a destination', () => {
    // 🔴 Deliberate, and a real divergence worth pinning: the server projection's
    // `safeExternalUrl` is case-INsensitive (/^https:\/\//i) while the render
    // boundary's `safeExternalHref` is case-SENSITIVE. The gate must agree with
    // what the USER's browser is handed — the render boundary — so such a row is
    // correctly refused rather than published to a button that renders no anchor.
    expect(checkOffsiteListingActionable(offsite({ externalUrl: 'HTTPS://demo.app' })).ok).toBe(
      false
    );
  });
});

describe('the gate is scoped to off-site, and delegates rather than re-deriving', () => {
  it('SKIPS an on-site listing entirely — a model-slot app is legitimately non-navigable', () => {
    // An on-site listing with no backing page renders "Runs on model pages":
    // informational, no href, and a perfectly valid live listing. Gating it would
    // fire on a valid shape, so the check must not evaluate on-site at all.
    const result = checkOffsiteListingActionable({
      kind: 'onsite',
      slug: 'slot-app',
      externalUrl: null,
      connectClientId: null,
    });
    expect(result).toEqual({ ok: true, skipped: true, action: null });
  });

  it('verdict === "the real view-model produced no href", for every off-site shape', () => {
    // 🔴 The structural restatement of the contract. This is what makes the gate
    // track #3585 (and any later re-branch) with no edit here: it never asserts a
    // label, a mode, or a sub-kind — only that the gate agrees with the view-model
    // the detail page actually renders.
    let blocked = 0;
    let allowed = 0;
    for (const externalUrl of [
      'https://demo.app',
      'http://insecure.app',
      '',
      null,
      'javascript:alert(1)',
    ]) {
      for (const connectClientId of [null, 'client-123']) {
        const listing = offsite({ externalUrl, connectClientId });
        const action = getDetailPrimaryAction(
          { slug: listing.slug, kind: 'offsite', kindData: expectedKindData(listing) },
          { canOpenPage: true }
        );
        const result = checkOffsiteListingActionable(listing);
        expect(result.ok).toBe(!!action.href);
        if (result.ok) allowed += 1;
        else blocked += 1;
      }
    }
    // 🔴 ANTI-VACUITY: without these the loop passes if the gate blocked
    // everything, or nothing. 10 cases = 5 URL shapes x 2 client values.
    expect(blocked + allowed).toBe(10);
    expect(allowed).toBeGreaterThanOrEqual(1);
    // The 4 no-destination URL shapes x 2 client values are non-actionable under
    // ANY version of the view-model — a listing with no reachable address cannot
    // become navigable. Bounded rather than pinned exactly because the connect +
    // https case is the one #3585 moves (see the dedicated test below); pinning
    // `allowed` to today's value would turn this suite red the moment that lands.
    expect(blocked).toBeGreaterThanOrEqual(8);
  });

  it('connect + https: the gate agrees with the view-model in BOTH #3585 worlds', () => {
    // 🔴 The case the CTA fix (#3585) changes, and the reason this suite asserts a
    // relationship instead of a value.
    //   - pre-#3585  the connect arm returns the stub unconditionally → no href →
    //                the gate BLOCKS, which is correct: on this code such a listing
    //                genuinely renders a dead button, exactly the three that shipped.
    //   - post-#3585 the destination decides → Visit ↗ → the gate ALLOWS.
    // Either way the gate must return whatever the store would actually render, so
    // that is what is asserted. This test is deliberately version-agnostic and must
    // stay green across the merge in both orders.
    const listing = offsite({ externalUrl: 'https://demo.app', connectClientId: 'client-123' });
    const action = getDetailPrimaryAction(
      { slug: listing.slug, kind: 'offsite', kindData: expectedKindData(listing) },
      { canOpenPage: true }
    );
    expect(checkOffsiteListingActionable(listing).ok).toBe(!!action.href);
  });

  it('canOpenPage is unread on every off-site branch, so the gate may hardcode it', () => {
    // The gate passes `canOpenPage: true`. That is only safe while no off-site
    // branch consults it — assert that against the view-model directly, since the
    // gate itself gives no way to vary the flag. If a future re-branch makes an
    // off-site action depend on it, this fails and the hardcode must be revisited.
    for (const externalUrl of ['https://demo.app', 'http://insecure.app', null]) {
      for (const connectClientId of [null, 'client-123']) {
        const listing = offsite({ externalUrl, connectClientId });
        const args = {
          slug: listing.slug,
          kind: 'offsite' as const,
          kindData: expectedKindData(listing),
        };
        expect(getDetailPrimaryAction(args, { canOpenPage: true })).toEqual(
          getDetailPrimaryAction(args, { canOpenPage: false })
        );
      }
    }
  });
});

describe('assertOffsiteListingActionable — fails CLOSED with mod-actionable copy', () => {
  it('does not throw for a navigable off-site listing', () => {
    expect(() => assertOffsiteListingActionable(offsite())).not.toThrow();
  });

  it('does not throw for an on-site listing', () => {
    expect(() =>
      assertOffsiteListingActionable({
        kind: 'onsite',
        slug: 'slot-app',
        externalUrl: null,
        connectClientId: null,
      })
    ).not.toThrow();
  });

  it('throws BAD_REQUEST naming the listing, the rendered button, and the fix', () => {
    let thrown: unknown;
    try {
      assertOffsiteListingActionable(offsite({ externalUrl: null, connectClientId: 'client-123' }));
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(TRPCError);
    const trpc = thrown as TRPCError;
    expect(trpc.code).toBe('BAD_REQUEST');
    // Names the listing…
    expect(trpc.message).toContain('demo-app');
    // …quotes what the moderator would have seen on the button…
    expect(trpc.message).toContain('Connecting this app will be available soon.');
    // …and states the remedy.
    expect(trpc.message).toContain('https external URL');
  });

  it('quotes the OTHER non-actionable shape too (no valid link), not just the connect stub', () => {
    let message = '';
    try {
      assertOffsiteListingActionable(offsite({ externalUrl: 'http://insecure.app' }));
    } catch (err) {
      message = (err as TRPCError).message;
    }
    expect(message).toContain('This app has no valid external link.');
  });
});

describe('buildActionabilityError', () => {
  it('omits the em-dash note clause when the action carries no note', () => {
    const msg = buildActionabilityError('some-app', {
      label: 'Nowhere',
      mode: 'info',
      external: false,
    });
    expect(msg).toContain('"Nowhere"');
    expect(msg).not.toContain('—');
  });
});

/**
 * Local restatement of the off-site projection, used ONLY as the oracle in the
 * structural test above. Deliberately NOT imported from the gate: an oracle that
 * shares the code under test cannot discriminate.
 */
function expectedKindData(listing: ListingActionabilitySource) {
  const subKind = listing.connectClientId ? ('connect' as const) : ('external-link' as const);
  return {
    kind: 'offsite' as const,
    subKind,
    externalUrl:
      listing.externalUrl && /^https:\/\//i.test(listing.externalUrl) ? listing.externalUrl : null,
    connectClientId: subKind === 'connect' ? listing.connectClientId ?? null : null,
  };
}
