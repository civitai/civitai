import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';
import {
  canOwnerEditListing,
  getDetailPrimaryAction,
  getOwnerEditHref,
  isEditableListingStatus,
} from '~/components/Apps/appListingDetailView';
import type { ListingDetail } from '~/server/schema/blocks/app-listing-read.schema';

/**
 * App Store Listings (W13) — P2c detail view-model unit tests (node `unit`
 * project — the fast, deterministic suite; CI runs it `continue-on-error`, and
 * the browser component suites are not run by CI at all, so this is where the
 * correctness coverage belongs even though nothing here BLOCKS a merge).
 * Pin the kind × hasPage × subKind primary-action matrix incl.
 * the appBlocksPages gate, https guard, connect stub, and slug encoding, so a
 * regression in the detail action routing FAILS here.
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

function offsiteDetail(
  subKind: 'connect' | 'external-link',
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
    kindData: { kind: 'offsite', subKind, externalUrl, connectClientId },
  };
}

describe('getDetailPrimaryAction — on-site', () => {
  it('hasPage + canOpenPage → Open → /apps/run/<slug>', () => {
    expect(getDetailPrimaryAction(onsiteDetail({ hasPage: true, slug: 'gen' }), { canOpenPage: true })).toEqual({
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
      getDetailPrimaryAction(onsiteDetail({ hasPage: true, slug: 'a b/c' }), { canOpenPage: true }).href
    ).toBe('/apps/run/a%20b%2Fc');
  });
});

describe('getDetailPrimaryAction — off-site', () => {
  it('external-link https → Visit ↗ (external)', () => {
    expect(
      getDetailPrimaryAction(offsiteDetail('external-link', { externalUrl: 'https://foo.app' }), {
        canOpenPage: true,
      })
    ).toEqual({ label: 'Visit', mode: 'visit', href: 'https://foo.app', external: true });
  });
  it('external-link non-https → info Unavailable (guard drops it, no target)', () => {
    const action = getDetailPrimaryAction(
      offsiteDetail('external-link', { externalUrl: 'http://foo.app' }),
      { canOpenPage: true }
    );
    expect(action).toEqual({
      label: 'Unavailable',
      mode: 'info',
      external: false,
      note: 'This app has no valid external link.',
    });
  });
  it('external-link null url → info Unavailable', () => {
    expect(getDetailPrimaryAction(offsiteDetail('external-link', { externalUrl: null }), { canOpenPage: true }).mode).toBe(
      'info'
    );
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
   * What this case adds is the shape nothing covered: connect WITH a valid
   * https address. `resolveOffsiteSubKind` flips the sub-kind on
   * `connectClientId != null` alone, so linking an OAuth client was the sole
   * cause of the dead CTA on three approved, live listings. The destination
   * decides now — the sub-kind does not.
   */
  it('🔴 connect + https externalUrl → Visit ↗ (a client_id no longer kills the CTA)', () => {
    const action = getDetailPrimaryAction(
      offsiteDetail('connect', {
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

  it('🔴 connect and external-link with the SAME url produce the SAME action', () => {
    // Structural restatement of the rule, independent of the literals above: if
    // a future change re-branches on sub-kind before the href guard, these two
    // diverge and this fails — even if it picks copy that satisfies the pins.
    const url = 'https://same-target.app';
    expect(
      getDetailPrimaryAction(
        offsiteDetail('connect', { connectClientId: 'c1', externalUrl: url }),
        {
          canOpenPage: true,
        }
      )
    ).toEqual(
      getDetailPrimaryAction(offsiteDetail('external-link', { externalUrl: url }), {
        canOpenPage: true,
      })
    );
  });

  it('🔴 connect with NO usable destination → the stub still fails safe', () => {
    // The stub must stay REACHABLE and must stay hrefless. Enumerated over every
    // way a destination can be absent, with the client_id present in each — so
    // this cannot pass by accident of the sub-kind being mis-resolved.
    // (`undefined` is deliberately absent: the DTO types `externalUrl` as
    // `string | null`, and the fixture's destructuring default would silently
    // rewrite it to `null` anyway — a row whose label lied about its input.)
    for (const externalUrl of [null, '', 'http://insecure.app', 'javascript:alert(1)']) {
      const key = `externalUrl=${String(externalUrl)}`;
      const action = getDetailPrimaryAction(
        offsiteDetail('connect', { connectClientId: 'client-123', externalUrl }),
        { canOpenPage: true }
      );
      expect(action.mode, key).toBe('connect');
      expect(action.label, key).toBe('Connect');
      expect(action.href, key).toBeUndefined();
      expect(action.external, key).toBe(false);
      expect(action.note, key).toBeTruthy();
    }
  });

  it('🔴 no off-site listing with an https target is ever left un-navigable', () => {
    // The off-site analogue of the on-site "no state strands the viewer" matrix.
    // Anti-vacuity is explicit: count the rows that MUST be navigable and assert
    // the count, so a change that stopped producing hrefs everywhere cannot make
    // this green by having nothing to check.
    const stranded: string[] = [];
    let navigable = 0;
    for (const subKind of ['connect', 'external-link'] as const) {
      for (const externalUrl of ['https://ok.app', 'http://insecure.app', null]) {
        for (const connectClientId of ['client-123', null]) {
          const key = `subKind=${subKind} url=${String(externalUrl)} client=${
            connectClientId ?? 'null'
          }`;
          const action = getDetailPrimaryAction(
            offsiteDetail(subKind, { externalUrl, connectClientId }),
            { canOpenPage: true }
          );
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
    }
    expect(stranded).toEqual([]);
    // 2 sub-kinds × 2 client values, all with the https url → 4 navigable rows.
    expect(navigable).toBe(4);
  });
});

/**
 * 🔴 SOURCE-LEVEL GATE — no raw `<iframe>` may return to the store detail.
 *
 * `AppListingDetailBody`'s docstring states this in 🔴 terms, and the ONLY other
 * check on it is an absence assertion in `AppListingDetailBody.browser.test.tsx`
 * — which lives in the browser `component` project, **which CI does not run**
 * (see this file's header and `recentAppsRail.test.ts`). Without the check
 * below, re-adding `<iframe src={liveUrl}>` would pass every gate that runs.
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
    expect(getOwnerEditHref(onsiteDetail({ hasPage: false, appBlockId: null }).kindData, 'l1')).toBeNull();
  });
  it('off-site detail kindData → the submit editor keyed on the listing id', () => {
    expect(getOwnerEditHref(offsiteDetail('external-link', { externalUrl: 'https://x' }).kindData, 'l2')).toBe(
      '/apps/submit?edit=l2'
    );
    expect(getOwnerEditHref(offsiteDetail('connect').kindData, 'l2')).toBe('/apps/submit?edit=l2');
  });

  it('owner + editable → show; non-owner → hide; mod-removed → hide', () => {
    expect(canOwnerEditListing({ isOwner: true })).toBe(true);
    expect(canOwnerEditListing({ isOwner: false })).toBe(false);
    expect(canOwnerEditListing({ isOwner: true, status: 'removed' })).toBe(false);
    expect(isEditableListingStatus('approved')).toBe(true);
    expect(isEditableListingStatus('removed')).toBe(false);
  });
});
