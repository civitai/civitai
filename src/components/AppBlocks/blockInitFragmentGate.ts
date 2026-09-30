// App Blocks — the GATE on the iframe init-fragment fast path.
//
// WHY THIS EXISTS
// ---------------
// The fragment fast path (see `blockIframeUrl.ts`) appends
// `#civitai-block=v1&…` to a third-party block's iframe URL. A live-block
// enumeration on 2026-08-05 established two facts that together make an
// UNCONDITIONAL append the wrong default:
//
//   1. 🔴 NO DEPLOYED BLOCK CAN DECODE IT. Across all 20 DEPLOYED bundles — the
//      full `app_blocks` deployed set (21 rows), which is the right population
//      for a "nobody can decode this" claim since a suspension is reversible,
//      rather than the 9 currently `approved` (and `approved` is itself only a
//      CEILING on what serves — see the population note above
//      `BlockInitPayload` in types.ts) —
//      `civitai-block=v1` x0 and `BLOCK_HELLO` x0. The SDK half is merged but
//      NOT published (npm latest is still `@civitai/app-sdk@0.30.0`). So the
//      fast path currently buys exactly nothing, and "zero benefit" is the
//      decisive argument, not the risk level.
//
//      🔴 THE `BLOCK_HELLO` HALF OF THAT COUNT IS STALE — RE-MEASURED
//      2026-08-31 AGAINST THE DEPLOYED FLEET: 4 of 23 deployed blocks now ship
//      the accelerator (`custom-generators`, `df-qwen-canvas`,
//      `model-benchmarking`, `sensei`). It is no longer x0. Read the 2026-08-05
//      line above as a dated historical measurement, not as current state.
//
//      🔴 THIS DOES NOT REOPEN THE FRAGMENT FAST PATH. The two counts are
//      independent: `BLOCK_HELLO` is a runtime postMessage the SDK sends, while
//      `civitai-block=v1` is a URL-fragment payload a block must DECODE, and
//      nothing there re-measured the fragment half. The gate stays a per-block
//      opt-in, and an entry is earned only by measuring THAT half for THAT
//      block — which is what was done for the one entry now in the ALLOWLIST.
//
//      🔴 AND IT IS A DATED MEASUREMENT, NOT A FACT. Blocks are rebuilt and
//      re-approved continuously, so both numbers move on their own. The reason
//      it is worth stating: 19 of 23 blocks still lack the accelerator, and
//      closing that gap is 19 rebuild-and-moderator-approve cycles — which is
//      why the host-side re-post cadence (`INIT_RETRY_BACKOFF_MS` in
//      `iframeInitController.ts`) is the only launch-latency lever that reaches
//      every deployed app at once.
//   2. 🔴 THE `iframe.src` NO-STOMP GUARD PROTECTS AN EMPTY SET.
//      `stampCanonicalIframeSrc` (server-side) UNCONDITIONALLY overwrites
//      `manifest.iframe.src` with `https://<slug>.<appsDomain>/`, and the
//      manifest schema independently rejects a dev-set `iframe.src`. So no
//      production block's src can ever arrive carrying a fragment, and the
//      no-stomp branch in `buildBlockIframeSrc` cannot fire for one. It is
//      retained as a cheap correctness property, NOT counted as a mitigation.
//
// So the fast path is OFF by default, everywhere, and turns on per block only
// once that block ships an SDK that decodes it.
//
// 🔴 THIS IS AN OPT-IN ALLOWLIST, NOT A RUNTIME KILL SWITCH. Enabling or
// disabling a block is a deploy. That is an honest limitation and it is stated
// here rather than in a commit message. 🔴 IT NOW HAS TEETH: the allowlist is
// no longer empty, so "there is nothing to revoke in a hurry" — true while the
// set was empty — NO LONGER HOLDS. Backing a block out is a code change and a
// deploy, at deploy latency. If a faster revocation path is wanted the right
// home is a feature flag in the flags service — outside this module and
// deliberately not added here.

/**
 * The surfaces that can mount an iframe block host. Passed explicitly by each
 * `PageBlockHost` call site rather than inferred, so that adding a new PAGE
 * host is a type error until someone decides what it should do.
 *
 * ⚠️ That type-error guarantee covers `PageBlockHost` ONLY. `IframeHost`
 * hard-codes `surface: 'model-slot'` internally, so a new MODEL-slot host would
 * inherit that literal silently rather than being forced to choose.
 */
export type BlockHostSurface =
  /** `IframeHost` in a model-page slot (`model.sidebar_top`, …). */
  | 'model-slot'
  /** The full-page run host, `/apps/run/<slug>`. */
  | 'page-run'
  /** The author's dev tunnel, `/apps/dev/<blockId>`. 🔴 Never eligible. */
  | 'dev-tunnel'
  /** Moderator review surfaces (review modal + full-page preview). */
  | 'review-preview'
  /**
   * The PRIVATE RUN of a DELISTED / SUSPENDED app, served by `/apps/run/<slug>`'s own
   * fallback (the dedicated `/apps/private-run/<slug>` route was removed), for its
   * owner, an accepted listing collaborator, or a moderator. 🔴 Never eligible — see
   * the unconditional refusal in `blockInitFragmentEnabledWith`.
   */
  | 'private-run';

/**
 * Where a block's own client router may push an APP-SCOPED sub-path, per surface.
 *
 * 🔴 SCOPE, since #5209: this map governs the APP-SCOPED half of `NAVIGATE` only —
 * a payload with `scope: 'app'`, which is the default. A `scope: 'site'` request
 * does not pass through a base at all; whether a surface may serve one is a
 * SEPARATE per-surface capability, `BLOCK_HOST_SITE_NAVIGATION` below. One
 * concern each: this map answers "where does an in-app sub-path go?", that one
 * answers "may a block move the viewer off the app?". They are deliberately not
 * folded together — `private-run` says yes to the first and no to the second.
 *
 * 🔴 A TOTAL `Record`, NOT A TERNARY, AND THAT IS THE WHOLE VALUE OF IT. `PageBlockHost`
 * handles a block's `NAVIGATE` request by pushing `<base>/<slug>/<path>`, and the base
 * was originally derived with `surface === 'private-run' ? … : '/apps/run'`. A default
 * branch on a surface union silently gives every FUTURE surface the public run route —
 * which for a non-public surface is a route that 404s, i.e. a block's first in-app
 * navigation makes the app vanish. As a total record, adding a member to
 * `BlockHostSurface` is a COMPILE ERROR here until someone decides where that surface's
 * deep links belong, which is the same guarantee the union's own docblock claims for
 * `PageBlockHost` call sites.
 *
 * ⚠️ `dev-tunnel` MAPS TO THE PUBLIC RUN ROUTE, AND THAT IS PRE-EXISTING RATHER THAN
 * INTENDED. Only `reviewMode` returns early from that handler, so a dev-tunnel host does
 * reach it and does push `/apps/run/<slug>` — pushing the author off their tunnel onto
 * the public route. Recorded as `'/apps/run'` here because that IS today's behaviour and
 * this change must not alter it; naming it is what makes it fixable. `null` is reserved
 * for a surface that should drop the navigation instead — which is what the REVIEW
 * PREVIEW now does (see its entry below). The dev tunnel probably wants the same and
 * still does not have it; that is a separate, load-bearing decision about the author's
 * own surface, not a tidy-up to fold into this one.
 *
 * ⚠️ `model-slot` IS `null` AND THAT IS NOT A BEHAVIOUR CHANGE — verified rather than
 * assumed, because the ternary this replaced gave every non-private surface
 * `/apps/run`. `PageBlockHost` is never mounted with `surface: 'model-slot'` in
 * production: its THREE production mount sites pass FOUR surfaces between them —
 * `src/pages/apps/run/[slug]/[[...path]].tsx` passes `hostSurfaceFor(audience)`, which
 * is `page-run` OR `private-run`; `src/pages/apps/dev/[blockId].tsx` passes
 * `dev-tunnel`; and `~/components/Apps/ReviewBlockPreviewHost` passes `review-preview`
 * — the moderator's live preview, which the paragraph above names and which this
 * enumeration used to omit.
 * ⚠️ IT SAID "FOUR PRODUCTION MOUNTS … the private run route (`private-run`)" AND BOTH
 * HALVES WERE FALSIFIED BY #5255, which deleted `/apps/private-run/<slug>` and moved
 * the private run onto the run route's own fallback. Re-measured by enumerating every
 * non-test `surface=` / `surface:` site: three mounts, four surfaces. The distinction
 * is not pedantic here — this enumeration IS the evidence for the no-behaviour-change
 * claim below, so a reader auditing which mounts reach this map would go looking for a
 * route file that no longer exists.
 * ⚠️ That omission mattered in the direction that weakens the argument: this list IS the
 * evidence for the no-behaviour-change claim, and `review-preview` is one of the surfaces
 * whose base is now LOOKED UP rather than defaulted. ⚠️ It mapped to `/apps/run` when this
 * paragraph was written, and since #5209 it maps to `null` — for a reason recorded at its
 * own entry, and STILL without a behaviour change, because the value was never reachable.
 * The model slot is `IframeHost`, a SEPARATE component
 * with its own message handlers, which uses the string only to call
 * `blockInitFragmentEnabled` directly. So this entry is unreachable today, and `null` is
 * the honest value — a model slot has no page route to deep-link into, so inheriting the
 * public run base would have been meaningless rather than merely unused.
 */
export const BLOCK_HOST_DEEP_LINK_BASE: Record<BlockHostSurface, string | null> = {
  'model-slot': null,
  'page-run': '/apps/run',
  'dev-tunnel': '/apps/run',
  // 🔴 `null` SINCE #5209, AND IT IS STILL NOT A BEHAVIOUR CHANGE. It read
  // `'/apps/run'` to preserve the ternary this map replaced — but that value was
  // never reachable: the NAVIGATE handler returns early on the `reviewMode` prop,
  // and the ONE mount that passes `surface: 'review-preview'`
  // (`~/components/Apps/ReviewBlockPreviewHost`) also passes `reviewMode`. So the
  // two were a single condition expressed twice, coupled only by that mount
  // remembering to pass both props.
  //
  // What changed is the STAKE on that coupling, not the coupling. Before #5209 a
  // forgotten `reviewMode` let unreviewed code push the moderator to a sub-path
  // of the app they were already looking at. With a site-absolute contract it
  // would let unreviewed code move the moderator's tab to ANY page route. `null`
  // makes the refusal structural — a second mount of this surface cannot
  // re-open it by omission.
  'review-preview': null,
  // 🔴 `/apps/run`, NOT a private path — the dedicated `/apps/private-run/<slug>` route
  // was REMOVED and a private run is now served by the public route's fallback, so this
  // is the base a private run's own deep links must push to. The SURFACE stays distinct
  // (it still carries the unconditional fragment refusal below); only its route moved.
  // Pointing this at the deleted path would make a block's first in-app navigation 404 —
  // the exact failure this total record's docblock exists to prevent.
  'private-run': '/apps/run',
};

/**
 * May a block on this surface ask the host to leave the app — a `NAVIGATE` with
 * `scope: 'site'`?
 *
 * 🔴 A SEPARATE RECORD FROM `BLOCK_HOST_DEEP_LINK_BASE` ON PURPOSE. The two
 * questions are independent and a surface can answer them differently, so folding
 * site navigation into a `null` base would force them to move together and make
 * each refusal untraceable to a decision. Total over `BlockHostSurface` for the
 * same reason as the base map: a new surface is a COMPILE ERROR here until
 * someone decides whether it may move the viewer off the app, rather than
 * inheriting an answer from a default branch.
 *
 * 🔴 `private-run` IS THE CASE THAT MOTIVATED SPLITTING THEM, and the refusal is
 * load-bearing rather than tidy. That surface resolves an audience that includes
 * `moderator`, it exists precisely to serve `suspended` and delisted apps, and it
 * passes NO `reviewMode` — so the review surface's two refusals do not cover it.
 * Without this entry a suspended app could move a moderator's tab to any page
 * route on the site, which is the same hazard `review-preview` is closed against,
 * on a surface that reaches the same viewer. APP-scoped deep-linking inside the
 * owner's own private preview stays working (its base above is non-null) — that
 * is what the surface is for, and it reaches no site route.
 *
 * ⚠️ IT USED TO NAME A ROUTE, `/apps/private-run/<slug>`, AND THAT ROUTE IS GONE
 * (#5255 folded the private run into `/apps/run/<slug>`'s own fallback behind the
 * approved-only resolver). None of the three facts above moved with it — the
 * audience, the suspended-app population and the absent `reviewMode` are
 * properties of the SURFACE, which is still distinct. What DID move is the
 * argument's cheapest support: `private-run`'s base is now `'/apps/run'`, BYTE-
 * IDENTICAL to `page-run`'s, so the base can no longer tell the two surfaces
 * apart and "it keeps its own route" is no longer a true sentence about either.
 * 🔴 Read that as strengthening the split, not weakening it: this record is now
 * the ONLY thing in the host that distinguishes a private run from a public one,
 * so folding it into the base map would silently grant a suspended app the public
 * surface's site capability.
 *
 * `review-preview` and `model-slot` are `false` as well, but they are not the
 * interesting entries: both already have a `null` base, so they perform no
 * app-scoped navigation either. `false` here states the site half explicitly
 * instead of leaving it to be inferred from the other map.
 */
export const BLOCK_HOST_SITE_NAVIGATION: Record<BlockHostSurface, boolean> = {
  'model-slot': false,
  'page-run': true,
  'dev-tunnel': true,
  'review-preview': false,
  // 🔴 See the docblock above — a suspended app must not be able to move a
  // moderator's tab off the run route it is being served on. App scope stays
  // enabled, and since #5255 that base is `'/apps/run'`, the same string
  // `page-run` carries: this `false` is the only difference between the two
  // surfaces that the navigate handler can still see.
  'private-run': false,
};

/**
 * Blocks permitted the fragment fast path, keyed by `blockId` OR `slug`
 * (whichever the surface knows — the model slot has a `blockId`, the page host
 * has both).
 *
 * 🔴 KEYING ASYMMETRY — READ BEFORE ADDING AN ENTRY. The page host knows BOTH
 * a `blockId` and a `slug`; the MODEL SLOT knows only a `blockId` (`BlockInstall`
 * has no `slug` field at all). So an entry written as a slug silently does
 * NOTHING on the model slot. When enabling a block, add its `blockId` — or add
 * both — and verify on the surface you actually care about.
 *
 * 🔴 NO LONGER EMPTY — but the bar for an entry is unchanged. Adding one is a
 * deliberate, per-block decision that should be made only once THAT block is
 * known to ship a decoding SDK: the fragment is inert to a block that does not
 * read it, but a block that reads `location.hash` for its OWN purposes can be
 * perturbed by it (see DENYLIST).
 */
export const BLOCK_INIT_FRAGMENT_ALLOWLIST: ReadonlySet<string> = new Set<string>([
  // 🔴 ONE STRING COVERS BOTH LOOKUPS **ONLY BECAUSE THIS BLOCK IS PAGE-MOUNTED**
  // — do not copy this shape to a slot-mounted block without re-reading the
  // KEYING ASYMMETRY note above. `app-requests` declares `"blockId":
  // "app-requests"` and a `page` with NO slots, and on the page-run surface
  // `slug === blockId`, so the single entry below matches whichever key the
  // host happens to pass. A block that mounts in a MODEL SLOT is the dangerous
  // case: that surface knows only a `blockId`, so an entry written as a slug
  // there is silently inert.
  //
  // Both halves of the bar are met: it ships the decoding reader (an inline
  // pre-paint fragment reader in its `index.html`, which records the resolved
  // theme on `data-civitai-boot-theme` for React to read back), and it reads
  // `location.hash` nowhere at runtime — the only textual mentions in its
  // source are doc comments warning against exactly that, since the SDK's
  // transport strips the fragment during init. That hash-reading hazard is
  // what put `playable-collections` on the DENYLIST; this block is clear of it.
  'app-requests',

  // The three below were added together and each was checked against BOTH halves
  // of the bar above, per block — not inherited from `app-requests` because they
  // shipped in the same batch.
  //
  // (a) SHIPS A DECODING READER. Each now serves an inline pre-paint fragment
  //     reader in its own `index.html` that records the resolved theme on
  //     `data-civitai-boot-theme`, and each declares `bootSkeleton: true`, so the
  //     host stands its veil down and the block's own boot paint is what a viewer
  //     actually sees. Verified against the SERVED artifact, not the repo.
  //
  // (b) READS `location.hash` NOWHERE AT RUNTIME. Measured per block over its
  //     shipped `src/`: the only occurrences are inside each block's own
  //     `bootFragment.test.tsx`, which SETS the hash to drive its reader. This is
  //     the check `playable-collections` fails — it reads AND writes the hash for
  //     its own routing.
  //
  //     🔴 BUT `grep location.hash` IS NOT ENOUGH ON ITS OWN, and reading it as the
  //     whole test is how the next block gets admitted wrongly. `custom-generators`
  //     rewrites the URL through `location.href` + `history.replaceState` (its
  //     `App.tsx`, via `stripDeeplinkParam`, which strips only `?g=` and PRESERVES
  //     the fragment) — invisible to a hash-shaped grep. So apply a SECOND check
  //     ALONGSIDE the read one, never instead of it: nothing may RE-INSTATE the
  //     fragment. Grep `location.href` / `replaceState` / `pushState` as well.
  //
  //     🔴 A HIT ON THAT SECOND CHECK IS NOT AUTOMATICALLY A DISQUALIFICATION, and
  //     `custom-generators` IS such a hit — so read this before concluding the entry
  //     below is wrong. What separates safe from unsafe is LIVE versus CAPTURED:
  //     its `getHref: () => window.location.href` is read at call time, so whatever
  //     it writes back carries the CURRENT fragment and the write is a no-op with
  //     respect to it. The unsafe shape is a block that CAPTURES an href early
  //     (at mount, in a ref, in state) and writes that stale copy back later — that
  //     one really can re-instate a fragment the transport had removed, and it
  //     passes a `location.hash` grep exactly as this one does. So the second check
  //     is a prompt to go LOOK at each hit, not a filter that rejects on sight.
  //
  //     The read half stays because the two checks catch different things: a block
  //     can re-instate nothing and still be disqualified for reading the fragment
  //     for its own routing. `playable-collections` is not a clean illustration of
  //     that — it happens to fail BOTH halves (it reads the hash AND calls
  //     `replaceState`), so it is evidence for neither half being independently
  //     necessary. Keep the read half on the principle, not on that example.
  //
  //     🔴 AND DO NOT REST THAT ON THE SDK'S STRIP — IT DOES NOT RUN FOR ANY BLOCK
  //     LISTED HERE. An earlier revision of this comment said `custom-generators` is
  //     safe "only because `seedFromFragment` strips synchronously at transport
  //     start". Measured, that premise is false in production: every block above is
  //     `trust_tier: 'unverified'` with `sandbox: "allow-scripts allow-forms"`, and
  //     `sandbox.ts` adds `allow-same-origin` only for `TRUSTED_TIERS`
  //     (`internal`/`verified`). The frame therefore runs at an OPAQUE ORIGIN, the
  //     `history.replaceState` inside `seedFromFragment` throws, and that throw is
  //     swallowed by a `catch` documented as "nothing depends on this" — so the
  //     fragment is NOT stripped and persists in `location.hash` for the session.
  //     These three are safe on their own terms, not because of a strip that never
  //     executes: none of them CONSUMES the fragment — none branches on it, routes
  //     on it, or stores it — and the one URL write among them (`custom-generators`,
  //     above) is built from a LIVE href read, so it cannot re-instate anything.
  //
  //     🔴 "Consumes", not "reads", and the difference is not pedantry:
  //     `location.href` CONTAINS the fragment, so `custom-generators` does read it,
  //     incidentally, every time `getHref()` runs. An earlier draft of this line
  //     said "none of them READS the fragment", which is false for exactly that
  //     block and would have sent the next maintainer looking for a contradiction
  //     that is really just imprecision. Criterion (b) is about a block that reads
  //     the fragment TO USE IT; an href round-trip that passes it through untouched
  //     is not that, and a grep for `location.hash` alone will not tell you which
  //     kind you are looking at.
  //
  //     Why that distinction is worth the words: the strip DOES start working if a
  //     block is later promoted to `verified`/`internal`. A maintainer who admitted
  //     a block on "the transport already stripped it, so a captured href is clean"
  //     would have been right at `unverified` only by accident (that block's own
  //     write throws too), and wrong the moment the tier changes — reaching the
  //     exact hazard along a path this comment would have declared closed.
  //
  // KEYING: all three are page-mounted — `page` declared, no `slots` key at all,
  // and each `blockId` equals its store slug — so, exactly as for `app-requests`
  // above, one string covers whichever key the surface passes.
  //
  // 🔴 AN ENTRY IS PER-BLOCK, NOT PER-SURFACE, so it PRE-AUTHORISES the model slot.
  // The KEYING ASYMMETRY note above warns about the inert direction (a slug-only
  // entry doing nothing on a slot); this is the opposite one and it is the one that
  // widens. `IframeHost` calls the gate with `surface: 'model-slot'` and the
  // `blockId` alone, and these entries ARE blockIds — so if any of these three
  // later adds a `slots` entry in ITS OWN repo and clears App-Block moderation, the
  // fragment starts being appended on model pages with no change here, no reviewer
  // ON THIS REPO involved and no test going red. Low impact (the fragment carries only
  // theme/renderMode/blockInstanceId, all of which BLOCK_INIT already delivers) but
  // the decision widens without anyone taking it. If a block here goes slot-mounted,
  // re-evaluate the entry for that surface rather than inheriting this one.
  'custom-generators',
  'model-benchmarking',
  'sensei',
]);

/**
 * Blocks that must NEVER receive the fragment, whatever the allowlist says.
 *
 * `playable-collections` reads `location.hash` on first load and strips it
 * afterwards. It fails closed against our fragment only BY LUCK — it looks for
 * a `c` key that `civitai-block=v1&theme=…` does not carry. That is a
 * coincidence, not a contract, and it would be silently re-broken by any future
 * change to either side's key set. The denylist is checked BEFORE the
 * allowlist so that whoever eventually widens the allowlist cannot
 * accidentally re-enable it.
 */
export const BLOCK_INIT_FRAGMENT_DENYLIST: ReadonlySet<string> = new Set<string>([
  'playable-collections',
]);

/**
 * May this host append the init fragment to its iframe URL?
 *
 * Order is load-bearing:
 *   1. `dev-tunnel` is refused UNCONDITIONALLY — see below.
 *   2. DENYLIST beats the allowlist.
 *   3. Otherwise, the block must be explicitly allowlisted.
 * Anything unrecognised falls through to `false`.
 *
 * 🔴 WHY `dev-tunnel` AND `review-preview` ARE REFUSED BY CONSTRUCTION.
 *
 * Both mount code that has NOT been reviewed, under an identity an allowlist
 * cannot distinguish from the reviewed one:
 *
 *   - `review-preview` mints `page_<pubreq_…>` for a PENDING, UN-APPROVED
 *     publish request (`publish-request.service.ts`), i.e. a moderator opening
 *     the next unreviewed submission of an app — with a moderator's session, on
 *     a surface every other layer treats as maximum-hazard. And on page-run
 *     `slug === blockId`, so allowlisting a PUBLISHED app would necessarily
 *     enable the fragment on the moderator's preview of that same app's next
 *     unreviewed submission. The dev-tunnel argument transfers wholesale; there
 *     is no version of it that stops at the tunnel.
 *
 * `resolveDevPageBlockForAuthor` applies NO status filter at all — deliberately,
 * so an author can iterate on a draft. The repo says so itself in
 * `src/pages/api/v1/block-tokens/index.ts`: the SSR dev route "mounts an OWNED
 * app at ANY status". It mounts the same real `PageBlockHost` as production, so
 * the fragment would reach ARBITRARY UNPUBLISHED CODE that no query can
 * enumerate — and the PWA starters' own docs (`starters/{react,svelte}-pwa`
 * README / AGENTS.md / `.claude/commands/add-route.md`, five places) steer
 * authors toward exactly the `location.hash` routing this would perturb. It is
 * the one surface where the hazard is live today and structurally unmeasurable.
 *
 * An allowlist keyed on blockId/slug CANNOT cover that case: a block whose id
 * is allowlisted for production is the SAME id the author iterates on through
 * the tunnel. So the surface is a second, independent axis, and it is checked
 * first.
 */
export function blockInitFragmentEnabledWith(
  args: {
    surface: BlockHostSurface;
    blockId?: string | null;
    slug?: string | null;
  },
  allowlist: ReadonlySet<string>,
  denylist: ReadonlySet<string>
): boolean {
  const { surface, blockId, slug } = args;

  // (1) Unconditional: no allowlist entry can enable a surface that mounts
  //     UNREVIEWED code. See the doc comment above for why identity-keying
  //     cannot express this.
  //
  //     🔴 `private-run` IS IN THIS SET EVEN THOUGH IT SERVES A *REVIEWED* BUNDLE, and
  //     the reasoning is worth stating because it does not follow from the heading.
  //     A private run mounts the app's last APPROVED build — so unlike the two
  //     surfaces beside it, the code HAS been reviewed. What it has also been is TAKEN
  //     DOWN. An allowlist here is keyed on blockId/slug, and a block allowlisted for
  //     production is the SAME id that keeps running privately after a delist, so an
  //     identity-keyed entry cannot express "not while suspended" any more than it can
  //     express "not in the tunnel". Given the fast path perturbs `location.hash`
  //     routing and the reason the app is delisted may be the very behaviour under
  //     diagnosis, the reviewer should see the app on its ordinary boot path.
  if (surface === 'dev-tunnel' || surface === 'review-preview' || surface === 'private-run') {
    return false;
  }

  // (2) Denylist beats everything below it.
  if (blockId && denylist.has(blockId)) return false;
  if (slug && denylist.has(slug)) return false;

  // (3) Explicit opt-in only. Empty allowlist ⇒ false for every block.
  if (blockId && allowlist.has(blockId)) return true;
  if (slug && allowlist.has(slug)) return true;

  return false;
}

/**
 * Production binding of {@link blockInitFragmentEnabledWith} against the real
 * module constants. This is what the hosts call.
 *
 * The lists are injected in the `…With` form rather than read from module
 * scope so the ORDERING guarantees above can actually be TESTED. With the real
 * allowlist empty, every outcome is `false`, and a test written against it
 * cannot distinguish "the dev tunnel was refused first" from "nothing is
 * allowlisted" — a guard that can only ever be observed returning false is an
 * untested guard. See `__tests__/blockInitFragmentGate.test.ts`, which drives
 * the injectable form with a NON-EMPTY allowlist and includes a positive
 * control proving the predicate can return `true` at all.
 */
export function blockInitFragmentEnabled(args: {
  surface: BlockHostSurface;
  blockId?: string | null;
  slug?: string | null;
}): boolean {
  return blockInitFragmentEnabledWith(
    args,
    BLOCK_INIT_FRAGMENT_ALLOWLIST,
    BLOCK_INIT_FRAGMENT_DENYLIST
  );
}
