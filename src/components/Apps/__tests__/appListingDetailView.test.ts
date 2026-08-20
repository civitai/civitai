import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';
import {
  canOwnerEditListing,
  getDetailPrimaryAction,
  getOwnerEditHref,
  isEditableListingStatus,
  shouldShowConnectCapability,
  shouldShowOffsiteDisclosure,
} from '~/components/Apps/appListingDetailView';
import type { ListingDetail } from '~/server/schema/blocks/app-listing-read.schema';

/**
 * App Store Listings (W13) — P2c detail view-model unit tests (node `unit`
 * project — the fast, deterministic suite; CI runs it `continue-on-error`, and
 * the browser component suites are not run by CI at all, so this is where the
 * correctness coverage belongs even though nothing here BLOCKS a merge).
 * Pin the kind × hasPage × destination primary-action matrix incl.
 * the appBlocksPages gate, https guard, and slug encoding, so a regression in
 * the detail action routing FAILS here.
 *
 * 🔴 There is no "connect stub" arm any more — #4208 deleted that CTA. What is
 * pinned instead is its ABSENCE, and the fact that the OAuth capability no
 * longer changes the action at all.
 */

function onsiteDetail(
  over: Partial<ListingDetail> & { hasPage: boolean; appBlockId?: string | null; liveUrl?: string }
): ListingDetail {
  const { hasPage, appBlockId = 'blk-1', liveUrl = 'https://my-app.civit.ai', ...rest } = over;
  return {
    id: 'l1',
    serialId: 1,
    slug: 'my-app',
    kind: 'onsite',
    name: 'My App',
    tagline: null,
    description: null,
    category: null,
    contentRating: null,
    iconUrl: null,
    coverUrl: null,
    creator: null,
    recommend: { recommendedCount: 0, notRecommendedCount: 0, recommendPct: null },
    reviewCount: 0,
    screenshots: [],
    kindData: { kind: 'onsite', appBlockId, hasPage, liveUrl },
    ...rest,
  };
}

/**
 * 🔴 The `subKind` positional argument is GONE. It used to be passed
 * INDEPENDENTLY of `connectClientId`, so a fixture could declare
 * `('external-link', { connectClientId: 'c1' })` — a shape the real projection
 * can never produce, since the sub-kind was derived from that very field. One
 * input now, so a fixture cannot describe an impossible listing.
 */
function offsiteDetail(
  over: { externalUrl?: string | null; connectClientId?: string | null; slug?: string } = {}
): ListingDetail {
  const { externalUrl = null, connectClientId = null, slug = 'ext-app' } = over;
  return {
    id: 'l2',
    serialId: 2,
    slug,
    kind: 'offsite',
    name: 'Ext App',
    tagline: null,
    description: null,
    category: null,
    contentRating: null,
    iconUrl: null,
    coverUrl: null,
    creator: null,
    recommend: { recommendedCount: 0, notRecommendedCount: 0, recommendPct: null },
    reviewCount: 0,
    screenshots: [],
    kindData: { kind: 'offsite', externalUrl, connectClientId },
  };
}

describe('getDetailPrimaryAction — on-site', () => {
  it('hasPage + canOpenPage → Open → /apps/run/<slug>', () => {
    expect(
      getDetailPrimaryAction(onsiteDetail({ hasPage: true, slug: 'gen' }), { canOpenPage: true })
    ).toEqual({
      label: 'Open',
      mode: 'open',
      href: '/apps/run/gen',
      external: false,
    });
  });
  it('🔴 hasPage + !canOpenPage → the raw-origin "Open live" ESCAPE HATCH is KEPT', () => {
    const action = getDetailPrimaryAction(
      onsiteDetail({ hasPage: true, liveUrl: 'https://my-app.civit.ai' }),
      { canOpenPage: false }
    );
    // With appBlocksPages dark this raw-origin link is the ONLY way to run the
    // app from the store — the in-page `<iframe>` preview that used to sit below
    // it has been removed (it was bridge-less: nothing posted the block
    // `BLOCK_INIT`, so it only ever painted the pre-init light-theme shell). The
    // legacy /apps/[appBlockId] page kept this escape hatch; the canonical page
    // must not be strictly less capable.
    //
    // The note copy is pinned VERBATIM: its previous value promised "…You can
    // also run it in the live preview below", which now points at nothing.
    expect(action).toEqual({
      label: 'Open live',
      mode: 'visit',
      href: 'https://my-app.civit.ai',
      external: true,
      note: 'Opens the app at its own address.',
    });
  });

  it('hasPage + canOpenPage → the escape hatch is HIDDEN (the app opens in-page)', () => {
    // The redundancy the removal was actually about: when /apps/run works, a
    // second button shipping the viewer to the raw origin is noise.
    const action = getDetailPrimaryAction(onsiteDetail({ hasPage: true }), { canOpenPage: true });
    expect(action.mode).toBe('open');
    expect(action.label).not.toBe('Open live');
    expect(action.external).toBe(false);
    expect(action.href).toBe('/apps/run/my-app');
  });

  it('🔴 no on-site state strands the viewer (full matrix, no note-shaped escape)', () => {
    // The invariant the whole action matrix rests on: for every combination of
    // hasPage × canOpenPage × liveUrl-validity × appBlockId-presence, does the
    // page offer a REAL navigable route?
    //
    // "usable" deliberately does NOT count `action.note`. Every branch of
    // getDetailPrimaryAction sets an href OR a note, so allowing a note to
    // satisfy this made the assertion true by construction — it could not fail.
    // A note is prose; it is not a way to use the app.
    //
    // It no longer counts an in-page preview either: that surface was removed
    // (a bridge-less `<iframe src={liveUrl}>` that never sent the block
    // `BLOCK_INIT` and only painted its pre-init light-theme shell). Counting a
    // dead-on-arrival iframe as "a way to use the app" was the same false-usable
    // this matrix exists to catch, one level up.
    const stranded: string[] = [];
    for (const hasPage of [true, false]) {
      for (const canOpenPage of [true, false]) {
        for (const liveUrl of ['https://my-app.civit.ai', 'http://insecure.example']) {
          for (const appBlockId of ['blk-1', null]) {
            const key = `hasPage=${hasPage} canOpenPage=${canOpenPage} liveUrl=${
              liveUrl.startsWith('https') ? 'https' : 'http'
            } appBlockId=${appBlockId ?? 'null'}`;
            const detail = onsiteDetail({ hasPage, liveUrl, appBlockId });
            const action = getDetailPrimaryAction(detail, { canOpenPage });

            // Integrity of the action itself, asserted for EVERY combination.
            if (action.href !== undefined) expect(action.href, key).not.toBe('');
            // `visit` is the only external mode, and it may only ever carry an
            // https target (the safeExternalHref guard).
            expect(action.external, key).toBe(action.mode === 'visit');
            if (action.mode === 'visit') expect(action.href, key).toMatch(/^https:\/\//);
            // 🔴 No copy may point the viewer at an in-page live preview — there
            // is no such surface on `AppListingDetailBody` any more. Reachable
            // and non-vacuous: this arm sees the real "Open live" note, which
            // carried exactly that sentence until it was removed here.
            expect(action.note ?? '', key).not.toMatch(/live preview/i);

            const usable =
              (action.mode === 'open' && !!action.href) ||
              (action.mode === 'visit' && !!action.href) ||
              (action.mode === 'info' && !!action.href);
            if (!usable) stranded.push(key);
          }
        }
      }
    }

    // The dead-end set, pinned EXACTLY. Any behaviour change either keeps this
    // set identical or fails here — that is the point of enumerating it instead
    // of hiding it behind an `|| !!action.note`.
    //
    // 🔴 History of this set: 3 → 6 when the model-slot `info` href was removed
    // (#3493 retired `/apps/[appBlockId]`, so that href had become a redirect
    // back onto this very page — a circular self-link is not a way to use the
    // app). 6 → 10 now that the in-page `<iframe>` preview is gone. The four
    // added entries are the `hasPage=false` × https-`liveUrl` rows that the
    // preview used to "rescue" — and it never rescued them in reality: the
    // frame was bridge-less, so it rendered the block's pre-init shell and
    // nothing else. Removing it does not make a single listing less usable; it
    // makes the count HONEST.
    //
    // The remaining dead ends have exactly two shapes, and nothing else:
    //   (a) a non-https `liveUrl` — `safeExternalHref` drops the "Open live"
    //       escape hatch. Unreachable with real data: `liveUrl` is
    //       server-computed as `https://<slug>.<APPS_DOMAIN>`.
    //   (b) `hasPage=false` (a model-slot app) — it has no launch page by
    //       definition, and this body has no INSTALL surface to send it to.
    //       That is the gap #3493 tracks, deliberately not invented here.
    expect(stranded).toEqual([
      'hasPage=true canOpenPage=false liveUrl=http appBlockId=blk-1',
      'hasPage=true canOpenPage=false liveUrl=http appBlockId=null',
      'hasPage=false canOpenPage=true liveUrl=https appBlockId=blk-1',
      'hasPage=false canOpenPage=true liveUrl=https appBlockId=null',
      'hasPage=false canOpenPage=true liveUrl=http appBlockId=blk-1',
      'hasPage=false canOpenPage=true liveUrl=http appBlockId=null',
      'hasPage=false canOpenPage=false liveUrl=https appBlockId=blk-1',
      'hasPage=false canOpenPage=false liveUrl=https appBlockId=null',
      'hasPage=false canOpenPage=false liveUrl=http appBlockId=blk-1',
      'hasPage=false canOpenPage=false liveUrl=http appBlockId=null',
    ]);
    // Structural restatement of (a)/(b) so the list above cannot silently
    // acquire an entry of a THIRD shape — e.g. an `hasPage=true` + https row,
    // which would be a real regression rather than a known gap.
    for (const key of stranded) {
      expect(key, key).toMatch(/liveUrl=http |hasPage=false /);
    }
    // Anti-vacuity: a `hasPage=true` app with an https liveUrl is ALWAYS usable,
    // in both canOpenPage postures. That is the row the product actually ships.
    expect(stranded.filter((k) => k.startsWith('hasPage=true canOpenPage=true'))).toEqual([]);
    expect(stranded).not.toContain('hasPage=true canOpenPage=false liveUrl=https appBlockId=blk-1');
  });
  it('hasPage + !canOpenPage + non-https liveUrl → info fallback (guard drops it)', () => {
    const action = getDetailPrimaryAction(
      onsiteDetail({ hasPage: true, liveUrl: 'http://insecure.example' }),
      { canOpenPage: false }
    );
    expect(action.mode).toBe('info');
    expect(action.label).toBe('Runs on model pages');
  });
  it('🔴 !hasPage (model-slot) → info TEXT ONLY — never links to the retired /apps/<appBlockId>', () => {
    // #3493 retired `/apps/[appBlockId]`: it is now getServerSideProps-only and
    // 302s to `/apps/store-preview/<slug>` (the page the store detail viewer is
    // ALREADY on — a circular self-link) or 404s for an app with no approved
    // listing. There is no install surface on `AppListingDetailBody` to retarget
    // to, so the affordance is informational copy with NO href. This must hold
    // whether or not the app has an appBlockId — the id is exactly what the old
    // href was built from, so a regression would resurface only in this arm.
    for (const appBlockId of ['blk-9', null]) {
      for (const canOpenPage of [true, false]) {
        const action = getDetailPrimaryAction(onsiteDetail({ hasPage: false, appBlockId }), {
          canOpenPage,
        });
        const key = `appBlockId=${appBlockId ?? 'null'} canOpenPage=${canOpenPage}`;
        expect(action.mode, key).toBe('info');
        expect(action.label, key).toBe('Runs on model pages');
        // The honest signal survives: the viewer is told WHY it can't be opened.
        expect(action.note, key).toBeTruthy();
        expect(action.href, key).toBeUndefined();
        expect(action.external, key).toBe(false);
      }
    }
  });
  it('🔴 NO action of any kind can target the retired /apps/<appBlockId> route', () => {
    // Route-shape guard, independent of the branch above: `/apps/run/<slug>` and
    // `/apps/<id>/edit` are live siblings, but a bare `/apps/<segment>` is the
    // retired route. Pinned across the whole on-site matrix so a future branch
    // cannot reintroduce the redirect loop somewhere else in this function.
    const retired = /^\/apps\/[^/]+$/;
    // 🔴 Anti-vacuity counter. The assertion below is inside `if (action.href)`,
    // so if a future change stripped the href from EVERY branch the loop would
    // run 16 times, assert nothing, and stay green — the exact "cannot fail"
    // class this PR exists to kill. Count the hrefs actually produced and
    // require the guard to have had something to guard.
    let hrefsSeen = 0;
    for (const hasPage of [true, false]) {
      for (const canOpenPage of [true, false]) {
        for (const liveUrl of ['https://my-app.civit.ai', 'http://insecure.example']) {
          for (const appBlockId of ['blk-1', null]) {
            const action = getDetailPrimaryAction(onsiteDetail({ hasPage, liveUrl, appBlockId }), {
              canOpenPage,
            });
            const key = `hasPage=${hasPage} canOpenPage=${canOpenPage} liveUrl=${liveUrl} appBlockId=${
              appBlockId ?? 'null'
            }`;
            if (action.href) {
              hrefsSeen++;
              expect(action.href, key).not.toMatch(retired);
            }
          }
        }
      }
    }
    // Half the matrix (`hasPage` with an https liveUrl) yields an href — 8 of
    // the 16 combinations today. Assert the guard saw real targets rather than
    // an all-text matrix.
    expect(hrefsSeen).toBeGreaterThan(0);
  });
  it('encodes an odd slug on the Open run link', () => {
    expect(
      getDetailPrimaryAction(onsiteDetail({ hasPage: true, slug: 'a b/c' }), { canOpenPage: true })
        .href
    ).toBe('/apps/run/a%20b%2Fc');
  });
});

describe('getDetailPrimaryAction — off-site', () => {
  /**
   * 🔴 THE GRANDFATHERED LISTING drives this whole block. Production carries
   * exactly one approved off-site row with `connect_client_id IS NULL`
   * (measured 2026-08-19); `ExternalSubmitForm` requires a client on create, so
   * nothing new can be minted into that shape. Every `connectClientId: null`
   * fixture below IS that listing.
   */
  it('🔴 GRANDFATHERED (no OAuth client) + https → Visit ↗ (external)', () => {
    expect(
      getDetailPrimaryAction(
        offsiteDetail({ externalUrl: 'https://foo.app', connectClientId: null }),
        { canOpenPage: true }
      )
    ).toEqual({ label: 'Visit', mode: 'visit', href: 'https://foo.app', external: true });
  });
  it('🔴 GRANDFATHERED + non-https → info Unavailable (guard drops it, no target)', () => {
    const action = getDetailPrimaryAction(
      offsiteDetail({ externalUrl: 'http://foo.app', connectClientId: null }),
      { canOpenPage: true }
    );
    expect(action).toEqual({
      label: 'Unavailable',
      mode: 'info',
      external: false,
      note: 'This app has no valid external link.',
    });
  });
  it('🔴 GRANDFATHERED + null url → info Unavailable (never a dead Connect stub)', () => {
    const action = getDetailPrimaryAction(
      offsiteDetail({ externalUrl: null, connectClientId: null }),
      { canOpenPage: true }
    );
    expect(action.mode).toBe('info');
    expect(action.label).toBe('Unavailable');
  });
  /**
   * COVERAGE ADDED, NOTHING REVERSED — and the distinction matters, because an
   * earlier version of this comment claimed the opposite and was wrong.
   *
   * The test replaced here passed `connectClientId: 'client-123'` and asserted
   * `href` was undefined. It read like "even with a client_id, produce
   * nothing", but the fixture defaults `externalUrl` to `null`, so what it
   * actually pinned was the destination-LESS case: connect + no address → stub.
   * That behaviour is UNCHANGED — every one of its assertions still holds, and
   * they are re-pinned below over four absence shapes instead of one.
   *
   * What this case adds is the shape nothing covered: an OAuth-connected
   * listing WITH a valid https address. The removed sub-kind flipped on
   * `connectClientId != null` alone, so linking an OAuth client was the sole
   * cause of the dead CTA on three approved, live listings. The destination
   * decides now.
   */
  it('🔴 OAuth client + https externalUrl → Visit ↗ (a client_id no longer kills the CTA)', () => {
    const action = getDetailPrimaryAction(
      offsiteDetail({
        connectClientId: 'client-123',
        externalUrl: 'https://connect.app',
      }),
      { canOpenPage: true }
    );
    // Byte-identical to the external-link result for the same URL — the point of
    // the fix is that connect REUSES that path rather than growing a second one.
    expect(action).toEqual({
      label: 'Visit',
      mode: 'visit',
      href: 'https://connect.app',
      external: true,
    });
  });

  it('🔴 an OAuth-connected and a grandfathered listing with the SAME url produce the SAME action', () => {
    // Structural restatement of the rule, independent of the literals above: if
    // a future change re-branches on the OAuth capability before the href guard,
    // these two diverge and this fails — even if it picks copy that satisfies
    // the pins. This is the assertion a revert of the collapse must survive.
    const url = 'https://same-target.app';
    expect(
      getDetailPrimaryAction(offsiteDetail({ connectClientId: 'c1', externalUrl: url }), {
        canOpenPage: true,
      })
    ).toEqual(
      getDetailPrimaryAction(offsiteDetail({ connectClientId: null, externalUrl: url }), {
        canOpenPage: true,
      })
    );
  });

  /**
   * 🔴 #4208 — THE DEAD "Connect" CTA IS GONE, AND MUST NOT COME BACK.
   *
   * With no usable destination there is nothing to navigate to. This used to
   * fork on the OAuth capability: no client → "Unavailable", a client → a
   * disabled "Connect" button reading "Connecting this app will be available
   * soon." Nothing was behind it, so it cost a click and returned nowhere.
   *
   * Measured against production before removal: ZERO listings sat in the state
   * (all five off-site rows, every status, carry an https destination), so no
   * live listing changed. The state remains REACHABLE —
   * `submitExternalListingSchema` (`src/server/schema/blocks/offsite-listing.schema.ts`)
   * requires `connectClientId` but leaves `externalUrl` optional — which is why
   * the fallthrough still has to be honest rather than absent.
   *
   * 🔴 NEW-BEHAVIOUR GUARD, not regression coverage: it pins an outcome this
   * commit introduces. Its value is forward-looking — reintroducing the fork
   * fails here.
   */
  it('🔴 OAuth-connected with NO usable destination → Unavailable (no Connect stub)', () => {
    // Enumerated over every way a destination can be absent, client_id present
    // in each. (`undefined` is deliberately absent: the DTO types `externalUrl`
    // as `string | null`, and the fixture's destructuring default would silently
    // rewrite it to `null` anyway — a row whose label lied about its input.)
    for (const externalUrl of [null, '', 'http://insecure.app', 'javascript:alert(1)']) {
      const key = `externalUrl=${String(externalUrl)}`;
      const action = getDetailPrimaryAction(
        offsiteDetail({ connectClientId: 'client-123', externalUrl }),
        { canOpenPage: true }
      );
      expect(action.mode, key).toBe('info');
      expect(action.label, key).toBe('Unavailable');
      expect(action.href, key).toBeUndefined();
      expect(action.external, key).toBe(false);
      // 🔴 Pin the WHOLE note, not "is truthy" — the defect was a specific
      // sentence promising a flow, and a truthiness check is satisfied by it.
      expect(action.note, key).toBe('This app has no valid external link.');
      expect(action.label, key).not.toBe('Connect');
    }
  });

  /**
   * 🔴 THE CAPABILITY NO LONGER CHANGES THE ACTION — assert the EQUALITY, not
   * two separate constants.
   *
   * The grandfathered (no-OAuth) arm was already "Unavailable" before #4208, so
   * asserting it alone is unchanged behaviour and could not detect the fork
   * being restored. What is new is that the two arms are now IDENTICAL, so that
   * is what this pins: same object, both capability states, every absence shape.
   * A restored `connectClientId` branch makes these differ and fails here.
   */
  it('🔴 with no destination, the action is IDENTICAL with and without OAuth', () => {
    let compared = 0;
    for (const externalUrl of [null, '', 'http://insecure.app', 'javascript:alert(1)']) {
      const key = `externalUrl=${String(externalUrl)}`;
      const withOauth = getDetailPrimaryAction(
        offsiteDetail({ connectClientId: 'client-123', externalUrl }),
        { canOpenPage: true }
      );
      const grandfathered = getDetailPrimaryAction(
        offsiteDetail({ connectClientId: null, externalUrl }),
        { canOpenPage: true }
      );
      expect(withOauth, key).toEqual(grandfathered);
      // Anti-vacuity: both being some empty/undefined value would also compare
      // equal. Pin the shared value too.
      expect(grandfathered.label, key).toBe('Unavailable');
      compared++;
    }
    expect(compared).toBe(4);
  });

  /**
   * 🔴 INVARIANT GUARD, NOT A CAPABILITY TEST — and its title used to claim
   * otherwise, which is why it is relabelled rather than left alone.
   *
   * Before #4208 this pinned TRUTHINESS: an empty-string client id is falsy,
   * which is what the deleted `resolveOffsiteSubKind` tested, so it took the
   * "no client" arm instead of the Connect stub. **That arm no longer exists.**
   * `getDetailPrimaryAction` does not read `connectClientId` at all now, so
   * `''`, `'client-123'` and `null` are indistinguishable here BY CONSTRUCTION
   * and this fixture exercises the no-destination path and nothing else. Left
   * as-is it would have read as capability coverage while being unable to fail
   * for any capability reason.
   *
   * Kept and widened to assert what is actually true now: the action does not
   * vary with the capability, empty string included.
   *
   * The truthiness contract still matters and still has a real test — it moved
   * to `shouldShowOffsiteDisclosure`, which does still read the field. The
   * callers that reach this view-model directly with a raw row
   * (`app-listing-actionable.service`; and the mod-review preview builder via
   * `buildListingDetailPreview` → `AppListingDetailBody`, which uses `?? null`)
   * are documented in that predicate's docstring. (`MySubmissionsList` also
   * calls it directly but hardcodes `kind: 'onsite'` and never reaches this
   * branch — it is NOT an off-site caller.)
   */
  it('🔴 the action ignores connectClientId entirely, empty string included', () => {
    const baseline = getDetailPrimaryAction(
      offsiteDetail({ connectClientId: '', externalUrl: null }),
      { canOpenPage: true }
    );
    expect(baseline.label).toBe('Unavailable');

    // The invariant, stated as one: every capability shape yields the SAME
    // action. Anti-vacuity — the loop must actually compare all three.
    let compared = 0;
    for (const connectClientId of [null, '', 'client-123']) {
      expect(
        getDetailPrimaryAction(offsiteDetail({ connectClientId, externalUrl: null }), {
          canOpenPage: true,
        }),
        `client=${String(connectClientId)}`
      ).toEqual(baseline);
      compared++;
    }
    expect(compared).toBe(3);
  });

  it('🔴 no off-site listing with an https target is ever left un-navigable', () => {
    // The off-site analogue of the on-site "no state strands the viewer" matrix.
    // Anti-vacuity is explicit: count the rows that MUST be navigable and assert
    // the count, so a change that stopped producing hrefs everywhere cannot make
    // this green by having nothing to check.
    const stranded: string[] = [];
    let navigable = 0;
    for (const externalUrl of ['https://ok.app', 'http://insecure.app', null]) {
      for (const connectClientId of ['client-123', null]) {
        const key = `url=${String(externalUrl)} client=${connectClientId ?? 'null'}`;
        const action = getDetailPrimaryAction(offsiteDetail({ externalUrl, connectClientId }), {
          canOpenPage: true,
        });
        // `visit` is the only external mode and may only carry an https target.
        expect(action.external, key).toBe(action.mode === 'visit');
        if (action.mode === 'visit') {
          expect(action.href, key).toMatch(/^https:\/\//);
          navigable++;
        } else if (externalUrl?.startsWith('https://')) {
          stranded.push(key);
        }
      }
    }
    expect(stranded).toEqual([]);
    // 2 client values with the https url → 2 navigable rows. (Was 4 while the
    // matrix also crossed a sub-kind that no longer exists; the DROP is the
    // point — the removed dimension was never independent of `connectClientId`.)
    expect(navigable).toBe(2);
  });
});

/**
 * 🔴 #4208 SOURCE-LEVEL GATE — the dead Connect affordance must not return to the
 * renderer.
 *
 * The type guard (`DetailActionMode` has no `'connect'`) already makes the
 * VIEW-MODEL unable to emit it. This closes the other half: a hand-rolled button
 * in the JSX, which no type would catch, and which the browser suite — run only
 * by the PR preview pipeline, report-only and not a required check — would not
 * block either. Same technique and same positive-control discipline as the
 * disclosure gate below.
 *
 * 🔴 NEW-BEHAVIOUR GUARD, not regression coverage.
 */
describe('🔴 the removed Connect CTA cannot silently return', () => {
  const body = fs.readFileSync(path.resolve(__dirname, '../AppListingDetailBody.tsx'), 'utf8');

  /**
   * 🔴 ASSERT THE STATE, NOT THE WORDING.
   *
   * An earlier version of this gate checked three strings. Two of them —
   * `action.mode === 'connect'` and `glyphFor('connect')` — were VACUOUS BY
   * CONSTRUCTION: with `'connect'` removed from `DetailActionMode`, writing
   * either is a `TS2367`/`TS2345`, so no compiling tree can contain them and
   * neither assertion could ever fire. The third was a SPELLED guard, walkable
   * by rewording the sentence.
   *
   * Measured: a stub restored under a DIFFERENT mode with REWORDED copy —
   *
   *   if (action.mode === 'info' && detail.kindData.kind === 'offsite' &&
   *       detail.kindData.connectClientId) { …disabled "Connect" button… }
   *
   * — typechecked with 0 errors and SURVIVED the whole blocking suite.
   *
   * So gate the STATE the mutant cannot avoid needing: the CTA renderer routes
   * on the view-model's `action` ONLY. It must not read listing kind data at
   * all, because re-deriving the OAuth capability there is exactly how the dead
   * button comes back — under any mode name, behind any wording.
   */
  it('🔴 the CTA renderer never re-derives the capability (state, not wording)', () => {
    const start = body.indexOf('function PrimaryAction(');
    expect(start, 'PrimaryAction not found — did the component get renamed?').toBeGreaterThan(-1);
    const end = body.indexOf('\n}\n', start);
    expect(end, 'PrimaryAction end not found').toBeGreaterThan(start);
    const cta = body.slice(start, end);

    // POSITIVE CONTROLS — prove we sliced the real function BODY, not an empty
    // string or just its signature. Without these the absences below would pass
    // against a mis-slice, which is the failure mode of every region gate.
    expect(cta).toMatch(/getDetailPrimaryAction\(detail/);
    expect(cta).toMatch(/action\.mode === 'visit'/);
    expect(cta.length).toBeGreaterThan(500);

    // 🔴 THE GATE. The CTA branches on `action` and nothing else.
    expect(cta, 'the CTA must not read the OAuth capability').not.toMatch(/connectClientId/);
    expect(cta, 'the CTA must not branch on listing kind data').not.toMatch(/kindData/);
  });

  it('the renderer no longer carries the stub copy', () => {
    // POSITIVE CONTROL first: prove the read returned this component's source,
    // so the absence below is about the file and not about an empty string.
    expect(body).toMatch(/shouldShowOffsiteDisclosure\(detail\.kindData\)/);

    // The exact promise the CTA made. Kept as a cheap catch for a VERBATIM
    // restore — but it is a spelled guard, so the state gate above is the one
    // doing the real work.
    expect(body).not.toMatch(/Connecting this app will be available soon/);
  });

  it('the view-model no longer emits the mode or its copy', () => {
    const view = fs.readFileSync(path.resolve(__dirname, '../appListingDetailView.ts'), 'utf8');
    // POSITIVE CONTROL: the read really returned the view-model.
    expect(view).toMatch(/export function getDetailPrimaryAction/);

    // 🔴 Match a `mode:` ASSIGNMENT, not the bare word — the docstrings discuss
    // the removal at length and name `'connect'` repeatedly, so a bare-word
    // check would fail on the prose explaining why the code is gone.
    expect(view).not.toMatch(/mode:\s*['"]connect['"]/);
    expect(view).not.toMatch(/Connecting this app will be available soon/);
  });
});

/**
 * 🔴 THE OFF-SITE ACCOUNT-ACCESS DISCLOSURE.
 *
 * "This app runs entirely off-platform — no Civitai install, account access, or
 * permissions." That is a SECURITY CLAIM, and it is FALSE of a listing with an
 * OAuth app connected. Until this PR the condition lived inline in
 * `AppListingDetailBody`'s JSX, where the blocking `unit` project could not see
 * it and the report-only browser suite asserted it NOWHERE — so removing the
 * condition, and printing "no account access" over every off-site listing
 * including the OAuth-connected ones, was a change no test could catch.
 *
 * It was gated on `subKind === 'external-link'`. Since the sub-kind was
 * `connectClientId ? … : …` and nothing else, collapsing the taxonomy would have
 * silently deleted this gate if it were treated as "just another sub-kind
 * branch" — hence the extraction, and hence a full 2×3 truth table rather than
 * one happy case.
 */
describe('shouldShowOffsiteDisclosure — the "no account access" claim', () => {
  /** The three off-site destination shapes × the two OAuth capability states. */
  const URLS = ['https://ext.app', 'https://other.example/path', null] as const;

  it('🔴 GRANDFATHERED (no OAuth client) + a destination → SHOWN', () => {
    // Production's one approved `connect_client_id IS NULL` off-site listing.
    // Two distinct URLs so a mutant hardcoding either literal still moves one.
    for (const externalUrl of ['https://ext.app', 'https://other.example/path']) {
      expect(
        shouldShowOffsiteDisclosure({ kind: 'offsite', externalUrl, connectClientId: null }),
        externalUrl
      ).toBe(true);
    }
  });

  it('🔴 an OAuth-connected listing → NOT shown (the sentence would be a lie)', () => {
    for (const externalUrl of URLS) {
      expect(
        shouldShowOffsiteDisclosure({
          kind: 'offsite',
          externalUrl,
          connectClientId: 'oauth_abc',
        }),
        String(externalUrl)
      ).toBe(false);
    }
  });

  it('an off-site listing with no destination → NOT shown (nothing runs off-platform)', () => {
    expect(
      shouldShowOffsiteDisclosure({ kind: 'offsite', externalUrl: null, connectClientId: null })
    ).toBe(false);
  });

  it('🔴 an ON-SITE listing → NOT shown (it runs ON platform)', () => {
    expect(
      shouldShowOffsiteDisclosure({
        kind: 'onsite',
        appBlockId: 'blk-1',
        hasPage: true,
        liveUrl: 'https://blk-1.civit.ai',
      })
    ).toBe(false);
  });

  it('an empty-string connectClientId does NOT suppress it (truthiness, not nullish)', () => {
    // Matches `app-listing.service`'s `|| null` projection — so BOTH remaining
    // readers agree that an empty string is not a connected OAuth app.
    //
    // 🔴 This used to say "and `getDetailPrimaryAction`'s test, so all three read
    // the capability the same way". #4208 deleted that reader: the primary action
    // no longer branches on `connectClientId` at all, so this predicate is the
    // only place in this module that does. Count the readers, don't restate the
    // number — the sibling branch that adds `shouldShowConnectCapability` takes
    // it back up.
    expect(
      shouldShowOffsiteDisclosure({
        kind: 'offsite',
        externalUrl: 'https://ext.app',
        connectClientId: '',
      })
    ).toBe(true);
  });

  /**
   * 🔴 THE `kind === 'offsite'` CONJUNCT IS A RUNTIME GUARD, NOT TYPE NOISE —
   * and this fixture exists because the ordinary on-site case CANNOT SEE IT.
   *
   * Measured: deleting that conjunct leaves the whole suite GREEN. The on-site
   * case above still returns `false`, but for the WRONG reason — an on-site
   * `kindData` has no `externalUrl` at all, so the third conjunct carries the
   * verdict and the deleted one is never the deciding term. The mutant RAN; the
   * assertion just could not observe it. (Reachable-but-unasserted and
   * never-executed are different findings; this was the former.)
   *
   * The shape that discriminates is a CAST producer handing over an object with
   * BOTH `kind: 'onsite'` and an `externalUrl` — impossible per the DTO union,
   * routine at runtime. `appListingDetailRows` already carries a 🔴 note about
   * exactly this: the moderator combined-review surface builds
   * `ListingDetail`-shaped objects through a cast, and a required field being
   * absent there once blanked the whole review modal. An on-site listing must
   * never claim it "runs entirely off-platform" no matter what a producer
   * attaches to it.
   */
  it('🔴 an ON-SITE kindData carrying an externalUrl (cast producer) → still NOT shown', () => {
    const cast = {
      kind: 'onsite',
      appBlockId: 'blk-1',
      hasPage: true,
      liveUrl: 'https://blk-1.civit.ai',
      externalUrl: 'https://smuggled.example/app',
      connectClientId: null,
    } as unknown as ListingDetail['kindData'];
    // POSITIVE CONTROL: the same object with `kind: 'offsite'` IS shown, so the
    // `false` below is about the kind term and not about an inert function.
    expect(shouldShowOffsiteDisclosure({ ...cast, kind: 'offsite' })).toBe(true);
    expect(shouldShowOffsiteDisclosure(cast)).toBe(false);
  });

  /**
   * The RENDERER must not re-implement the predicate. A structural check on the
   * source, because the JSX itself is invisible to this project — the same
   * technique the iframe gate below uses, with its positive control.
   */
  it('🔴 AppListingDetailBody calls this predicate and does not re-derive it', () => {
    // 🔴 `__dirname`, never `process.cwd()`. The runner's cwd is whatever
    // directory `vitest` was invoked from, so a cwd-relative read passes in CI
    // (where it is the repo root) and ENOENTs locally — a test whose verdict is
    // about the caller's shell. Same idiom as the iframe gate below.
    const body = fs.readFileSync(path.resolve(__dirname, '../AppListingDetailBody.tsx'), 'utf8');
    // POSITIVE CONTROL first: the read really returned this component's source.
    expect(body).toMatch(/This app runs entirely off-platform/);
    expect(body).toMatch(/shouldShowOffsiteDisclosure\(detail\.kindData\)/);
    // …and the same for the positive counterpart (#4207): the renderer must call
    // it, not re-derive `connectClientId` inline. A second inline copy is exactly
    // how the two signals would drift into contradicting each other.
    expect(body).toMatch(/shouldShowConnectCapability\(detail\.kindData\)/);
  });

  /**
   * 🔴 THE SECURITY DOCSTRING MUST STILL DOCUMENT THIS FUNCTION.
   *
   * A JSDoc block attaches to whatever declaration FOLLOWS it, so inserting a
   * helper between this docstring and its function silently re-points ~46 lines
   * of security rationale at the helper and leaves `shouldShowOffsiteDisclosure`
   * with no docs at all — hover shows nothing. That happened once during #4207
   * and is invisible in a diff, which is why it is pinned rather than just fixed.
   *
   * This is the docstring `AppListingDetailBody`'s JSX comment tells readers to
   * consult before changing what the sentence says.
   */
  it('🔴 the security docstring is still attached to the disclosure predicate', () => {
    const view = fs.readFileSync(path.resolve(__dirname, '../appListingDetailView.ts'), 'utf8');
    // POSITIVE CONTROL: the docstring exists and we really read this module.
    const marker = 'EXTRACTED FROM THE JSX ON PURPOSE';
    expect(view).toContain(marker);

    // Whatever declaration follows that docstring's terminator must be the
    // disclosure itself — not a helper that drifted in between.
    const close = view.indexOf('\n */\n', view.indexOf(marker));
    expect(close, 'docstring terminator not found').toBeGreaterThan(-1);
    const following = view.slice(close + '\n */\n'.length).split('\n')[0];
    expect(following).toMatch(/^export function shouldShowOffsiteDisclosure\b/);
  });
});

/**
 * 🔴 #4207 — THE TWO PERMISSION SIGNALS ARE ONE STATEMENT WITH TWO SIDES.
 *
 * The off-platform disclosure ("no Civitai install, account access, or
 * permissions") and the connect indicator ("can connect to your Civitai
 * account") are the negative and positive halves of the SAME permission claim.
 * The failure mode that matters is not either one being wrong on its own — it is
 * the two DISAGREEING: showing both (the page contradicts itself about account
 * access) or showing neither (the state that made #4207 worth filing, where the
 * capability was communicated only by an absence).
 *
 * 🔴 So this is asserted as a RELATIONSHIP, in one test, over both states.
 * Testing each predicate in isolation — which the suite above already does — is
 * exactly how a contradiction between them would be missed: both files stay
 * green while the page says two things at once.
 *
 * 🔴 XOR ALONE IS NOT ENOUGH, and that is why the table below pins WHICH signal
 * shows for WHICH state. Swapping the two predicates preserves XOR perfectly:
 * every listing would still show exactly one signal, and a test that only
 * checked "exactly one" would stay green while every OAuth app was labelled
 * "no account access" — the worst possible inversion of a security claim.
 */
describe('🔴 the disclosure and the connect indicator, as a relationship', () => {
  /**
   * Distinct, non-default values on every axis, and pairwise distinct from each
   * other — so a mutant that hardcodes any single literal still moves a row.
   */
  const DESTINATIONS = ['https://ext.app', 'https://other.example/path'] as const;
  /** Truthy client ids (capability PRESENT) — two distinct, neither a default. */
  const OAUTH_IDS = ['oauth_abc', 'oauth_zzz'] as const;
  /** Falsy client ids (capability ABSENT) — the grandfathered shapes. */
  const NO_OAUTH = [null, '', undefined] as const;

  it('🔴 for a listing WITH a destination, EXACTLY ONE renders — and it is the right one', () => {
    let disclosureRows = 0;
    let indicatorRows = 0;

    for (const externalUrl of DESTINATIONS) {
      for (const connectClientId of OAUTH_IDS) {
        const key = `url=${externalUrl} client=${String(connectClientId)}`;
        const kindData = { kind: 'offsite', externalUrl, connectClientId } as const;
        const disclosure = shouldShowOffsiteDisclosure(kindData);
        const indicator = shouldShowConnectCapability(kindData);

        // The relationship: never both, never neither.
        expect(disclosure !== indicator, `XOR ${key}`).toBe(true);
        // …and the DIRECTION, which XOR cannot see. An OAuth app must never be
        // told it has "no account access".
        expect(disclosure, `disclosure ${key}`).toBe(false);
        expect(indicator, `indicator ${key}`).toBe(true);
        indicatorRows++;
      }

      for (const connectClientId of NO_OAUTH) {
        const key = `url=${externalUrl} client=${String(connectClientId)}`;
        const kindData = { kind: 'offsite', externalUrl, connectClientId } as unknown as Parameters<
          typeof shouldShowOffsiteDisclosure
        >[0];
        const disclosure = shouldShowOffsiteDisclosure(kindData);
        const indicator = shouldShowConnectCapability(kindData);

        expect(disclosure !== indicator, `XOR ${key}`).toBe(true);
        expect(disclosure, `disclosure ${key}`).toBe(true);
        expect(indicator, `indicator ${key}`).toBe(false);
        disclosureRows++;
      }
    }

    // 🔴 ANTI-VACUITY. Without these the test passes if the loops ran zero times,
    // and — more importantly — it proves BOTH arms were actually exercised, so
    // the XOR assertions above are not all coming from one side of the fork.
    expect(indicatorRows).toBe(4); // 2 destinations x 2 truthy client ids
    expect(disclosureRows).toBe(6); // 2 destinations x 3 falsy client ids
  });

  it('🔴 outside the domain, NEITHER renders (no destination, and on-site)', () => {
    // The one state where "both hidden" is correct: there is no claim to make
    // about where an app runs when it has nowhere to run. Pinned so a future
    // change that makes the indicator unconditional on `connectClientId` — the
    // obvious naive implementation — fails here rather than printing a
    // permission claim over a listing with no destination.
    let checked = 0;
    // 🔴 `'http://insecure.app'` is deliberately NOT in this list — see the
    // dedicated test below. The domain is TRUTHINESS on `externalUrl`, not an
    // https check, so a non-https URL is INSIDE it.
    for (const externalUrl of [null, '']) {
      for (const connectClientId of ['oauth_abc', null]) {
        const key = `url=${String(externalUrl)} client=${String(connectClientId)}`;
        const kindData = { kind: 'offsite', externalUrl, connectClientId } as unknown as Parameters<
          typeof shouldShowOffsiteDisclosure
        >[0];
        expect(shouldShowOffsiteDisclosure(kindData), `disclosure ${key}`).toBe(false);
        expect(shouldShowConnectCapability(kindData), `indicator ${key}`).toBe(false);
        checked++;
      }
    }
    expect(checked).toBe(4);

    // An on-site listing, including the cast-producer shape that smuggles in an
    // externalUrl — the same fixture the disclosure suite uses, applied to both.
    const onsite = {
      kind: 'onsite',
      appBlockId: 'blk-1',
      hasPage: true,
      liveUrl: 'https://blk-1.civit.ai',
    } as unknown as Parameters<typeof shouldShowOffsiteDisclosure>[0];
    expect(shouldShowOffsiteDisclosure(onsite)).toBe(false);
    expect(shouldShowConnectCapability(onsite)).toBe(false);

    const smuggled = {
      ...onsite,
      externalUrl: 'https://smuggled.example/app',
      connectClientId: 'oauth_abc',
    } as unknown as Parameters<typeof shouldShowOffsiteDisclosure>[0];
    // POSITIVE CONTROL: the same object as OFF-SITE does light the indicator, so
    // the two `false`s below are about the kind term and not an inert function.
    expect(shouldShowConnectCapability({ ...smuggled, kind: 'offsite' })).toBe(true);
    expect(shouldShowOffsiteDisclosure(smuggled)).toBe(false);
    expect(shouldShowConnectCapability(smuggled)).toBe(false);
  });

  /**
   * 🔴 A NON-HTTPS URL IS INSIDE THE DOMAIN, AND THAT IS PRE-EXISTING.
   *
   * `shouldShowOffsiteDisclosure` has always tested `!!externalUrl` — plain
   * truthiness, not an https guard. The connect indicator MIRRORS that rather
   * than narrowing it: tightening the domain to https would silently change when
   * an existing SECURITY claim is displayed, which is a behaviour change #4207
   * did not ask for and which belongs in its own change if it is wanted.
   *
   * 🔴 SCOPE — WHICH PRODUCER CAN ACTUALLY REACH THESE CELLS. Not the public
   * store detail. `app-listing.service` applies `safeExternalUrl()` (https-only)
   * to BOTH projections (`:255` card, `:315` detail), so a non-https column
   * arrives at this predicate as `null`, never as `http://…`; and the submit path
   * validates https whenever a URL is present. The ONLY producer that can deliver
   * these values is the moderator review preview — `reviewListingPreview.ts:98`
   * passes `row.appListing?.externalUrl ?? null` through UNGUARDED — and then
   * only for a legacy row that already holds one.
   *
   * An earlier version of this note stated the divergence unconditionally, which
   * over-warned: it read as though a public listing could show an off-platform
   * sentence with no way to go there. It cannot. The moderator-preview path can,
   * which is a much narrower and less alarming claim.
   *
   * ⚠️ Still worth knowing, NOT fixed here: on that preview path the predicates
   * and the CTA disagree — the CTA's `safeExternalHref` treats a non-https URL as
   * NO destination while these predicates count it as one. Predates both #4207
   * and #4200.
   *
   * What this test pins is the part that IS this change's business: whatever the
   * domain turns out to be, the two signals agree about it and still XOR.
   */
  it('🔴 a non-https destination stays INSIDE the domain, and the two still XOR', () => {
    let rows = 0;
    for (const externalUrl of ['http://insecure.app', 'javascript:alert(1)']) {
      for (const connectClientId of ['oauth_abc', null]) {
        const key = `url=${externalUrl} client=${String(connectClientId)}`;
        const kindData = { kind: 'offsite', externalUrl, connectClientId } as unknown as Parameters<
          typeof shouldShowOffsiteDisclosure
        >[0];
        const disclosure = shouldShowOffsiteDisclosure(kindData);
        const indicator = shouldShowConnectCapability(kindData);
        expect(disclosure !== indicator, `XOR ${key}`).toBe(true);
        // Direction, as everywhere else: the capability decides which one.
        expect(indicator, `indicator ${key}`).toBe(!!connectClientId);
        expect(disclosure, `disclosure ${key}`).toBe(!connectClientId);
        rows++;
      }
    }
    expect(rows).toBe(4);
  });

  it('🔴 the GRANDFATHERED production listing and an OAuth one, side by side', () => {
    // The two real shapes, asserted against each other in one place. Production
    // (measured): `vitrine` is the single approved off-site listing with no OAuth
    // client; `comfy`, `cosmetic-studio` and `radio` all carry one. Both arms of
    // this test therefore describe listings that actually exist.
    const grandfathered = {
      kind: 'offsite',
      externalUrl: 'https://vitrine.civitai.com/',
      connectClientId: null,
    } as const;
    const oauth = {
      kind: 'offsite',
      externalUrl: 'https://comfy.civitai.com/',
      connectClientId: 'oauth_comfy',
    } as const;

    expect(shouldShowOffsiteDisclosure(grandfathered)).toBe(true);
    expect(shouldShowConnectCapability(grandfathered)).toBe(false);

    expect(shouldShowOffsiteDisclosure(oauth)).toBe(false);
    expect(shouldShowConnectCapability(oauth)).toBe(true);

    // Stated as the relationship rather than four constants: the two listings
    // must disagree on BOTH signals, in opposite directions.
    expect(shouldShowOffsiteDisclosure(grandfathered)).not.toBe(shouldShowOffsiteDisclosure(oauth));
    expect(shouldShowConnectCapability(grandfathered)).not.toBe(shouldShowConnectCapability(oauth));
  });
});

/**
 * 🔴 SOURCE-LEVEL GATE — no raw `<iframe>` may return to the store detail.
 *
 * `AppListingDetailBody`'s docstring states this in 🔴 terms, and the ONLY other
 * check on it is an absence assertion in `AppListingDetailBody.browser.test.tsx`
 * — which lives in the browser `component` project, **run only by the PR preview
 * pipeline, report-only and not a required check** (see this file's header and
 * `recentAppsRail.test.ts`). Without the check below, re-adding
 * `<iframe src={liveUrl}>` would pass every gate that actually blocks.
 *
 * This replaces the equivalent gate that lived in the now-deleted
 * `appListingPreview.test.ts` — that one pinned the frame's hardening
 * attributes; this one pins that there is no frame at all.
 *
 * Structural, not behavioural, and deliberately so: rendering the component in
 * the node project would mean booting Mantine + next/link + tRPC to count
 * elements. The repo already uses source-level unit gates for this shape of
 * invariant (`no-io-in-transaction`, `no-wholesale-module-mock`, and the
 * `AppBlockChrome is actually WIRED to this gate` block in
 * `recentAppsRail.test.ts`).
 *
 * SCOPE, honestly — every clause below was MEASURED by mutating the component,
 * not reasoned about:
 *   - CAUGHT: a literal `<iframe` anywhere in the JSX.
 *   - CAUGHT: a literal `<iframe` in a SINGLE-LINE template literal passed to
 *     `dangerouslySetInnerHTML`. (An earlier draft said this form was NOT
 *     caught — wrong; the token is still in the source text. It also said it
 *     unqualified, which was also wrong: see the multi-line cases below.)
 *   - CAUGHT: a `/*` inside a string literal placed before the frame. This DID
 *     evade the stripped-source count (the non-greedy comment regex runs from
 *     that `/*` up to the next block-comment terminator and swallows the frame),
 *     which is why the strip-free positional assertion exists; that assertion is
 *     what kills it.
 *   - CAUGHT (only after narrowing the tolerated prefix to `*`): a MULTI-LINE
 *     `dangerouslySetInnerHTML` template whose `<iframe` line begins with `//`
 *     or `/*`. While those prefixes were tolerated, the positional check was
 *     correlated with `stripComments` — which deletes exactly those two — so
 *     both assertions went green on a real rendering frame.
 *   - 🔴 NOT caught, KNOWN AND ACCEPTED: a `/*` inside a string literal combined
 *     with a `*`-led `<iframe` line inside a multi-line template literal. The
 *     over-strip hides it from (a) and the `*` prefix is tolerated by (b).
 *     Irreducible without a string-literal-aware tokenizer, which is declined
 *     deliberately: a hand-rolled scanner desyncs on regex literals and on
 *     apostrophes in JSX text, and those failures point toward false GREEN —
 *     trading a named, documented leak for unnamed ones.
 *   - NOT caught: HTML assembled so the token never appears literally
 *     (`'<' + 'iframe'`), a frame rendered by a wrapper component, or
 *     `document.createElement('iframe')`.
 */
describe('🔴 AppListingDetailBody mounts NO raw <iframe>', () => {
  const SOURCE = path.resolve(__dirname, '../AppListingDetailBody.tsx');

  /** Strip block + line comments. Load-bearing, not cosmetic: the component's
   *  own docstring names `<iframe src={liveUrl}>` verbatim (that is the whole
   *  point of the note), so an unstripped match would report the DOC, not the
   *  code — a permanent false red that would get this gate deleted. */
  const stripComments = (s: string) =>
    s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');

  const countIframes = (s: string) => [...s.matchAll(/<iframe\b/g)].length;

  /**
   * Lines holding `<iframe` that do NOT begin with a block-comment continuation
   * marker (` * `).
   *
   * 🔴 STRIPS NOTHING — that is the entire point. The count above depends on
   * `stripComments`, so it inherits every way that regex can remove too much;
   * this one only asks where the token sits, and so fails differently.
   *
   * 🔴 `*` IS THE ONLY TOLERATED PREFIX, DELIBERATELY. An earlier version also
   * allowed `//` and `/*` — which are exactly the two things `stripComments`
   * already deletes, so for those prefixes the two assertions were CORRELATED,
   * not independent, and a frame on a `//`- or `/*`-led line went green on both.
   * Measured, with a real rendering frame: a multi-line `dangerouslySetInnerHTML`
   * template whose `<iframe` line started with `//` or `/*` evaded the whole
   * gate. Narrowing to `*` alone closed those. Do not re-widen this list.
   *
   * FAILURE MODES, measured rather than assumed:
   *   - FALSE RED (safe): a legitimate line comment or trailing block comment
   *     that names an iframe. Move it into the ` * ` docstring; the file's two
   *     real occurrences already are.
   *   - FALSE GREEN (the residual leak): the token sits on a line starting with
   *     `*` AND `stripComments` over-strips it, so (a) misses it too. "JSX never
   *     starts a line with `*`" is true of JSX — but NOT of template-literal
   *     CONTENT, which is where the leak lives. Reachable only by combining a
   *     `/*` inside a string literal with a `*`-led line inside a template
   *     literal; see SCOPE. Closing it needs a string-literal-aware tokenizer,
   *     which is declined on purpose (see SCOPE).
   */
  const uncommentedIframeLines = (s: string) =>
    s
      .split('\n')
      .filter((l) => l.includes('<iframe'))
      .filter((l) => !l.trimStart().startsWith('*'));

  const WHY =
    'A raw <iframe> is back in AppListingDetailBody.tsx. A block at ' +
    '<slug>.civit.ai does not boot from its URL — it needs a host to post ' +
    'BLOCK_INIT — so a bare frame renders the pre-init light-theme shell ' +
    'and nothing else. See the file docstring; ReviewBlockPreviewHost is ' +
    'the bridged reference.';

  it('the matcher and BOTH directions of the stripper work (positive control)', () => {
    // Without this, a `countIframes` that can never match anything — a typo'd
    // regex, say — would make the real assertion below a green that means
    // nothing. Drive every helper through a fixture whose answer is known.
    expect(countIframes('<div>\n  <iframe src={x} />\n</div>')).toBe(1);
    const commented = '/* <iframe src={liveUrl}> */\nconst a = 1;\n';
    expect(countIframes(commented)).toBe(1); // …unstripped, the DOC matches,
    expect(countIframes(stripComments(commented))).toBe(0); // …stripped, it doesn't.

    // 🔴 The OTHER direction — "removes enough" is only half of it; the stripper
    // must also not remove CODE. Every assertion above is satisfied by
    // `stripComments = () => ''`, so without this line the control cannot see
    // an over-strip at all — and an over-strip is exactly how the `/*`-in-a-
    // string mutant evaded the count (see SCOPE).
    expect(stripComments('const a = 1;')).toContain('const a = 1;');

    // The strip-free positional check must be able to SEE a frame, and must not
    // fire on the ONE shape it exists to tolerate (the file's own docstring).
    expect(uncommentedIframeLines('  <iframe src={x} />')).toHaveLength(1);
    expect(uncommentedIframeLines(' * <iframe src={liveUrl}> — in a docstring')).toHaveLength(0);

    // 🔴 ANTI-RE-WIDENING. `//` and `/*` must stay INTOLERATED: they are exactly
    // what `stripComments` deletes, so tolerating them makes this check
    // correlated with the count instead of independent of it — and a frame on
    // such a line inside a template literal then passes BOTH assertions. That
    // was a real, measured hole. These two lines are what stop it coming back.
    expect(uncommentedIframeLines('  // <iframe src={x} />')).toHaveLength(1);
    expect(uncommentedIframeLines('  /* <iframe src={x} /> */')).toHaveLength(1);
  });

  it('🔴 the component source contains no <iframe> element', () => {
    const raw = fs.readFileSync(SOURCE, 'utf8');
    // (a) nothing survives comment-stripping…
    expect(countIframes(stripComments(raw)), WHY).toBe(0);
    // (b) …and, independently and WITHOUT stripping, every `<iframe` in the file
    // sits on a comment line. (a) alone is evadable by a `/*` inside a string
    // literal before the frame; (b) is what kills that.
    expect(uncommentedIframeLines(raw), WHY).toEqual([]);
  });

  /**
   * 🔴 INVARIANT GUARD, NOT REGRESSION COVERAGE — say so rather than let it read as
   * a fix. The body has never linked to `/apps/<appBlockId>` since #3493 retired that
   * route, so this assertion has always been green and could not have caught the
   * defect it documents. It exists because the two-column rewrite moved every href in
   * the file, and a hand-built `/apps/${appBlockId}` is the single most tempting thing
   * to reach for when adding a rail link — and it would be a REDIRECT LOOP: that route
   * 302s to `/apps/store-preview/<slug>`, which is the page the viewer is reading.
   *
   * The rule enforced is stronger and simpler than "no `/apps/<appBlockId>`": this
   * file may build NO `/apps/…` URL by string interpolation at all. Every app URL it
   * renders comes from a pure view-model (`getDetailPrimaryAction`, `getOwnerEditHref`,
   * `getListingDetailHref`), which is where the routing decisions are already tested.
   */
  it('🔴 the body builds no /apps/ URL by interpolation (invariant guard)', () => {
    // Positive control FIRST — the matcher must be able to SEE such a link, or the
    // `not.toMatch` below is a zero from a regex wired to nothing.
    const planted = 'const href = `/apps/${detail.kindData.appBlockId}`;';
    expect(planted).toMatch(/\/apps\/\$\{/);

    const raw = fs.readFileSync(SOURCE, 'utf8');
    expect(
      stripComments(raw),
      'AppListingDetailBody.tsx is building an /apps/ URL by hand. Route decisions ' +
        'belong in the pure view-models (getDetailPrimaryAction / getOwnerEditHref / ' +
        'getListingDetailHref) — and `/apps/<appBlockId>` in particular redirects to ' +
        'this very page, so linking it is a loop. See #3493.'
    ).not.toMatch(/\/apps\/\$\{/);
  });

  it('the deleted preview view-model is not imported back', () => {
    // Positive control FIRST: `not.toMatch` is zero-shaped and passes against an
    // empty string, so on its own it proves nothing about the read or the regex.
    expect(
      stripComments("import { getListingPreview } from '~/components/Apps/appListingPreview';")
    ).toMatch(/appListingPreview/);

    expect(stripComments(fs.readFileSync(SOURCE, 'utf8'))).not.toMatch(/appListingPreview/);
  });
});

describe('owner Edit deep-link + gating (on the detail view-model)', () => {
  it('on-site detail kindData → the unified /edit editor (extra fields ignored)', () => {
    expect(
      getOwnerEditHref(onsiteDetail({ hasPage: true, appBlockId: 'blk-7' }).kindData, 'l1')
    ).toBe('/apps/blk-7/edit');
  });
  it('on-site with no appBlockId → null (no editable target → hide)', () => {
    expect(
      getOwnerEditHref(onsiteDetail({ hasPage: false, appBlockId: null }).kindData, 'l1')
    ).toBeNull();
  });
  it('off-site detail kindData → the submit editor keyed on the listing id', () => {
    expect(getOwnerEditHref(offsiteDetail({ externalUrl: 'https://x' }).kindData, 'l2')).toBe(
      '/apps/submit?edit=l2'
    );
    expect(getOwnerEditHref(offsiteDetail({ connectClientId: 'c1' }).kindData, 'l2')).toBe(
      '/apps/submit?edit=l2'
    );
  });

  it('owner + editable → show; non-owner → hide; mod-removed → hide', () => {
    expect(canOwnerEditListing({ isOwner: true })).toBe(true);
    expect(canOwnerEditListing({ isOwner: false })).toBe(false);
    expect(canOwnerEditListing({ isOwner: true, status: 'removed' })).toBe(false);
    expect(isEditableListingStatus('approved')).toBe(true);
    expect(isEditableListingStatus('removed')).toBe(false);
  });
});
