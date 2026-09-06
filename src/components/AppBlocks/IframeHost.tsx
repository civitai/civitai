import dynamic from 'next/dynamic';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { ActionIcon, Anchor, Avatar, Box, Group, Text } from '@mantine/core';
import {
  IconApps,
  IconBuildingStore,
  IconChevronLeft,
  IconDots,
  IconEyeOff,
  IconGavel,
  IconPlugConnected,
  IconShieldLock,
} from '@tabler/icons-react';
import { NextLink as Link } from '~/components/NextLink/NextLink';
import { getRecentlyOpenedApps, type RecentApp } from '~/components/Apps/recentlyOpenedAppsStore';
import { selectChromeRecentApps } from '~/components/Apps/recentAppsRail';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { isAppReviewer } from '~/shared/utils/app-blocks-access';
import { AppNameCrumb } from './AppNameCrumb';
import {
  ChromeSurface,
  ChromeSurfaceGroup,
  ChromeSurfaceItem,
  ChromeSurfaceLabel,
} from './ChromeSurface';
import type { ChromeSurfaceControl } from './ChromeSurface';
import { ChromeReviewMenuItem } from './ChromeReviewEntry';
import { ReviewListingModal } from '~/components/Apps/ReviewListingButton';
import { AppPermissionsActivityDrawer } from './AppPermissionsActivityDrawer';
import { BlockFallback } from './BlockFallback';
import { failureSnapshot } from './failureSnapshot';
import { hostRenderDecision } from './hostRenderDecision';
import { resolveBuzzPurchaseRequest } from './openBuzzPurchaseGate';
import { resolveRequestSignIn } from './requestSignInGate';
import { resolveRequestConsent } from './requestConsentGate';
import { hideBlock } from './hiddenBlocks';
import { isPageSlot } from '~/shared/constants/slot-registry';
import { sanitizeAppChromeName } from './appChromeName';
import { resolveChromeGeometry } from './chromeGeometry';
import type { ChromeGeometry } from './chromeGeometry';
import { useResizeObserver } from '~/hooks/useResizeObserver';
import { sendBlockRender } from './sendBlockRender';
import { effectiveSandboxIsOpaque, intersectSandbox } from './sandbox';
import {
  projectBlockInitContext,
  projectBlockInitMaturity,
  projectBlockInitViewer,
} from './projectBlockInit';
import { IframeInitController, shouldStartInit } from './iframeInitController';
import { useIframeAwareMenu } from './useIframeAwareMenu';
import { blockInitFragmentEnabled } from './blockInitFragmentGate';
import { useBlockIframeSrc } from './useBlockIframeSrc';
import { usePostMessage } from './usePostMessage';
import type { BlockInitPayload, BlockInstall, ModelSlotContext, SlotContext } from './types';
import { dialogStore } from '~/components/Dialog/dialogStore';
import ConfirmDialog from '~/components/Dialog/Common/ConfirmDialog';
import {
  buildCollectionFollowConsentCopy,
  resolveCollectionFollowRequest,
} from './collectionFollowGate';
import type { BuyBuzzModalProps } from '~/components/Modals/BuyBuzzModal';
import { openResourceSelectModal } from '~/components/Dialog/triggers/resource-select';
import { getBaseModelGroup, getBaseModelsByGroup } from '~/shared/constants/basemodel.constants';
import { trpc } from '~/utils/trpc';
import {
  BLOCK_STORAGE_READ_OPTS,
  invalidatePrivateStorageReads,
  invalidateSharedStorageReads,
} from '~/components/AppBlocks/blockStorageCache';
import { deriveScopeFromInstanceId } from '~/server/schema/blocks/attribution.schema';
import { useBrowsingLevelDebounced } from '~/components/BrowsingLevel/BrowsingLevelProvider';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { openLoginPopup } from '~/utils/auth-helpers';

const BuyBuzzModal = dynamic(() => import('~/components/Modals/BuyBuzzModal'));
// Lazy-consent UI (REQUEST_CONSENT). Opened on demand when a logged-in viewer
// clicks an action whose consent-gated scope the token is missing.
const BlockConsentModal = dynamic(() => import('./BlockConsentModal'), { ssr: false });

// Hard cap on the suggested top-up amount a block can pre-fill in the
// BuyBuzzModal (security audit #10). Without this a malicious block could
// trick the user into a 10M-buzz purchase by sending `{suggestedAmount: 1e7}`.
const BUZZ_PURCHASE_AMOUNT_CAP = 50_000;

interface IframeHostProps {
  install: BlockInstall;
  context: SlotContext;
  token: string;
  /** ISO-8601 — surfaces in BLOCK_INIT.token.expiresAt for the iframe. */
  expiresAt: string;
  /** A6 lazy consent: consent-gated scopes the app's approved manifest declares
   *  but the viewer hasn't granted, so they were WITHHELD from `token`. The
   *  block sees a token without them and fires REQUEST_CONSENT on the action;
   *  we also trim them from the wrapped `token.scopes` we send the iframe so
   *  the block's "do I have this capability?" check is accurate. */
  missingScopes?: string[];
  /** Advisory color-domain maturity signal (BLOCK_INIT). Server-authoritative
   *  values mirrored from the token mint — the host forwards, never derives. */
  domain?: 'green' | 'blue' | 'red' | null;
  maxBrowsingLevel?: number;
  /** Re-mint the block token after a consent grant so it carries the newly
   *  granted scopes (pushed to the iframe via TOKEN_REFRESH). */
  onConsentGranted?: () => void;
}

const BLOCK_READY_TIMEOUT_MS = 10_000;
// If the token never arrives within this window, surface a token_error so the
// user isn't stuck behind an indefinite skeleton.
const TOKEN_WAIT_TIMEOUT_MS = 15_000;
// Hard ceiling on iframe height — independent of the manifest's maxHeight.
// A malicious or buggy block sending {height: 1e9} on RESIZE_IFRAME would
// otherwise OOM the tab. 8000px is well above any legitimate block.
const HARD_HEIGHT_CEILING = 8_000;

/**
 * The viewer's viewport height in CSS pixels, or `null` when there is nothing
 * usable to measure — no `window` (SSR / a prerender pass), or an `innerHeight`
 * that is not a positive finite number.
 *
 * 🔴 `null` means "DO NOT CLAMP", never "clamp to zero". A failed measurement
 * must degrade to the pre-existing three-layer behaviour: collapsing a block to
 * a 0px iframe because we could not read the viewport is a worse outcome than
 * the over-tall iframe the clamp exists to prevent.
 *
 * `window.innerHeight` deliberately, not `visualViewport.height` — nothing else
 * in `src/` reads `visualViewport`, and the pinch-zoom/keyboard-inset precision
 * it would add buys nothing for a bound whose whole job is "roughly one screen".
 */
function viewportHeightPx(): number | null {
  if (typeof window === 'undefined') return null;
  const h = window.innerHeight;
  return typeof h === 'number' && Number.isFinite(h) && h > 0 ? h : null;
}

/**
 * Everything inside the host frame that is NOT the iframe — the `AppBlockChrome`
 * bar, plus the frame's own borders — measured live rather than assumed.
 *
 * 🔴 THE IFRAME IS NOT THE WIDGET. `framed()` renders the chrome ABOVE the
 * iframe inside one bordered box, so a viewport-sized iframe produces a
 * `viewport + chrome + borders` widget. Measured at 390x640 with the real
 * cascade loaded: chrome 31 (matching the `CHROME_BAR_PX` sibling's pin of
 * 22 + 8 + 1) and 1px on each frame border, so the overhead is 33 — a 673px
 * widget on a 640px screen for a block reporting 640, i.e. layer 4 bounding
 * exactly the wrong box. The clamp's budget is therefore `viewport - overhead`.
 *
 * MEASURED, NEVER HARDCODED — and the 33 above is an OBSERVATION, not a
 * constant this code may assume. `CHROME_BAR_PX` is a *resting* contract for one
 * row at one breakpoint; the real bar wraps, changes with theme and Mantine
 * sizing, and has already gone stale once in this arc. Reading
 * `frame.offsetHeight - iframe.offsetHeight` is invariant to whatever height the
 * iframe currently has, so it measures the overhead itself — borders included —
 * and it stays correct if the frame ever gains another sibling.
 *
 * Returns 0 (i.e. no overhead, plain viewport clamp) whenever the difference is
 * not a usable positive number. Same degradation rule as `viewportHeightPx`: a
 * failed measurement must never make the budget SMALLER than the honest
 * fallback. (Whether a pre-layout read — both boxes still 0 — is reachable is
 * NOT established either way here: every caller runs after the block has stated
 * a height, which implies a laid-out iframe. Instrumentation never reached it.
 * Stated as unknown rather than asserted in either direction.)
 *
 * 🔴 THE `!frame || !iframe` LINE IS REACHABLE, AND IT IS LOAD-BEARING. It is a
 * TYPE NARROWING in the sense that the branch is behaviourally inert — but do
 * NOT read that as "dead code" and replace it with `frame!.offsetHeight`. The
 * path, measured by instrumenting the branch and driving it (hit count 1):
 *
 *   1. the re-clamp effect's deps are the manifest min/max heights — `status` is
 *      deliberately NOT among them (see `readGateStatus`), so its window
 *      `resize` listener SURVIVES a status change;
 *   2. a `BLOCK_ERROR {fatal:true}` sets status 'fatal', `hostRenderDecision`
 *      returns 'collapse', and the component `return null`s — unmounting the
 *      frame Box and the iframe, so React nulls BOTH refs while the component
 *      itself stays mounted and the listener stays registered;
 *   3. `reportedHeightRef.current` still holds the last stated height, so the
 *      `reported === null` early-out below does NOT fire;
 *   4. the next viewport change calls this function with (null, null).
 *
 * It produces no wrong output today only because 'fatal' is terminal and the
 * host renders null, so the recomputed height is unobservable. Delete the check
 * and that same path throws a TypeError out of a `resize` listener for every
 * viewer who rotates after any block reported a fatal error.
 *
 * (An earlier revision of this comment asserted the opposite — "neither is null
 * on any path that reaches this function", reasoning from commit ordering. The
 * reasoning was wrong in exactly the way the deps array above makes possible,
 * and it is recorded here because a false safety comment is what licenses
 * deleting the guard it describes.)
 *
 * KNOWN LIMIT, stated rather than implied: this is re-measured when the clamp
 * RUNS — on a RESIZE_IFRAME and on a window `resize`. A chrome bar that changes
 * height with no viewport change (a menu opening, a late font swap) does not
 * itself re-trigger the clamp, so the widget can be off by that delta until the
 * next event. Closing that would need a ResizeObserver on the chrome, which is
 * not warranted for a bound whose job is "roughly one screen".
 */
function frameOverheadPx(frame: HTMLElement | null, iframe: HTMLElement | null): number {
  if (!frame || !iframe) return 0;
  const overhead = frame.offsetHeight - iframe.offsetHeight;
  return Number.isFinite(overhead) && overhead > 0 ? overhead : 0;
}

/**
 * The height layers 2–4, as one pure function of a height the block has already
 * stated, the manifest's declared bounds, and the measured frame overhead. Layer
 * 1 (the `isFinite`/positive value guard) stays at the call site, because it
 * decides whether there is a stated height at all.
 *
 * Kept out of the component so the RESIZE_IFRAME path and the viewport-change
 * re-clamp cannot drift apart — they are the same four rules applied to the same
 * stashed number, differing only in what triggered them.
 *
 * 🔴 WHAT LAYER 4 DOES AND DOES NOT GUARANTEE. It bounds every height the BLOCK
 * can state: whatever a block reports over RESIZE_IFRAME, the framed widget ends
 * up no taller than the viewport. It does NOT bound the PUBLISHER's declared
 * `iframe.minHeight`, which deliberately still wins — `Math.max(min, budget)`,
 * not a bare `budget`, so the manifest's own reserve is not silently undone and
 * a short/failed block keeps the space it asked for.
 *
 * 🔴 THAT FLOOR IS UNBOUNDED BY ANYTHING HERE, AND IS A REAL RESIDUE, NOT A
 * THEORETICAL ONE. `HEIGHT_MAX_CEILING` in
 * `src/server/services/block-manifest-validator.service.ts` lets a manifest
 * declare `minHeight` up to 4000, and at that value a single schema-legal field
 * reproduces this defect in full — a 4000px slot on a 640px screen, measured,
 * with this clamp present. Even without an extreme value: measured against the
 * complete approved population (11 of 11 blocks) the declared floors are
 * 400 x1, 600 x5, 640 x3, 700 x2, so at a 640px viewport — where the budget
 * after 33px of overhead is 607 — the 640-tier (x3) and 700-tier (x2) are bound
 * by their OWN floor and overflow by 33px and 93px. That is 5 of 11; the 400-
 * and 600-tiers fit. At an 844px viewport (budget 811) all 11 fit.
 *
 * Capping `minHeight` at the validator is a manifest-CONTRACT change with
 * byte-mirrors outside this repo, so it is deliberately NOT bundled with this
 * host-side fix; it is tracked on its own branch. And note that a cap at 800
 * would not close the residue either — 640 and 700 are modest values, well
 * under any plausible cap, that still exceed the 607px budget. Shrinking it is
 * a per-publisher change or a change to which of floor/viewport wins, not a
 * constant.
 */
function clampBlockHeight(
  h: number,
  min: number,
  max: number | null | undefined,
  overhead: number
): number {
  let next = Math.max(h, min);
  if (typeof max === 'number') next = Math.min(next, max);
  next = Math.min(next, HARD_HEIGHT_CEILING);
  const viewport = viewportHeightPx();
  // Layer 4. The budget is the viewport MINUS the chrome the host renders above
  // the iframe, so it is the whole widget that fits the screen rather than the
  // iframe alone. `Math.max(min, …)` for the publisher-floor reason in the
  // docblock above.
  if (viewport !== null) next = Math.min(next, Math.max(min, viewport - overhead));
  return next;
}

// Max "Recently run" entries shown in the app-chrome platform-nav dropdown.
// Kept short so the compact menu doesn't grow unbounded (the store itself caps
// at MAX_RECENTS PER KIND; this is the additional display cap after excluding
// the current app). The per-kind store budget is what guarantees this menu is
// never starved by off-site traffic it can't render.
const RECENTLY_RUN_LIMIT = 5;

type Status = 'loading' | 'ready' | 'timeout' | 'fatal' | 'no_token';

// Reduce a thrown tRPC error to a single short string the block can surface.
// TRPCClientError exposes `.message` which is already the server message
// (apps.storage.* throws with explicit code + message strings); everything
// else gets a generic fallback. Keep this conservative — the iframe is
// untrusted and we don't want to leak server stack traces.
function storageErrorMessage(err: unknown): string {
  if (err && typeof err === 'object' && 'message' in err) {
    const message = (err as { message?: unknown }).message;
    if (typeof message === 'string' && message.length > 0) return message;
  }
  return 'storage request failed';
}

/**
 * Renders a block inside a sandboxed iframe and drives the postMessage
 * lifecycle. Implements the @civitai/app-sdk/blocks v1 contract — see
 * docs/features/app-blocks.md "BLOCK_INIT contract" for the payload shape.
 *
 *   1. Once token is present AND the effective-checkpoint query has resolved,
 *      POST BLOCK_INIT immediately and RE-POST it on a short interval until
 *      the block acks with BLOCK_READY (or the readiness timeout fires). This
 *      is NOT gated on the iframe's `load` event — on prod the cached block
 *      bundle's `load` fires before React attaches `onLoad`, so a load-gated
 *      single-shot init was being missed and the block sat blank forever
 *      ("timed out waiting for BLOCK_INIT"). Repeated init is safe: the
 *      block's IframeTransport origin-checks and dedupes BLOCK_INIT
 *      (`if (!this.initResolved)`). See iframeInitController.ts.
 *   2. Wait for BLOCK_READY (≤10s). Timeout shows BlockFallback("timeout").
 *   3. BLOCK_ERROR with `fatal: true` shows BlockFallback("fatal_block_error").
 *   4. RESIZE_IFRAME updates the iframe height, clamped to manifest bounds and
 *      sized so the FRAMED WIDGET (chrome + iframe) fits the viewer's viewport
 *      (see `clampBlockHeight`).
 *   5. Page-visibility change drives SUSPEND / RESUME.
 *   6. Token rotation triggers TOKEN_REFRESH (host-pushed) with the new
 *      wrapped token. A block-initiated REQUEST_TOKEN is answered CONDITIONALLY:
 *      one carrying a STRING requestId (`''` included) gets a
 *      TOKEN_REFRESH_RESPONSE echoing that id; one with no usable requestId gets
 *      a TOKEN_REFRESH PUSH, because the SDK correlates strictly by requestId
 *      and an uncorrelated response can never resolve a caller's refresh(). See
 *      the handler's own comment for the full rationale.
 *   7. Unmount sends SUSPEND and removes listeners.
 *
 * Origin security: BLOCK_INIT is posted to `new URL(manifest.iframe.src).origin`
 * (explicit target, never "*"). Incoming messages from other origins are dropped.
 */
/**
 * Host-rendered trust frame around an app block. This lives in civitai-web
 * (the parent document), NOT inside the block iframe — so a third-party
 * block can't fake, restyle, or hide it. It's the user-facing safety
 * signal that says "this is a sandboxed app block, not native Civitai UI":
 * a thin top bar with the Civitai app-block badge plus a menu whose
 * "Manage apps" item routes to /apps/installed and a "Hide app" item
 * that locally hides this install for the viewer (a model owner's block shows
 * to every viewer; this lets a viewer dismiss one without affecting the
 * publisher or anyone else). Rendering it here (vs in the sandboxed iframe) is
 * the whole point — the trust boundary belongs to the host. (Roadmap W7.)
 *
 * SURFACE-AWARE: on the full-page run surface (`/apps/run/<slug>`, slot kind
 * `page`) the "Hide app" action is meaningless — there is no model-page
 * slot to dismiss the block FROM; the page IS the block. So the host passes the
 * rendering `slotId` and we drop the "Hide" item when `isPageSlot(slotId)` is
 * true. "Manage apps" + the provenance badge stay on every surface. (Mirrors PR
 * #2747's `isPageSlot` page-vs-model distinction.) When `slotId` is omitted the
 * chrome defaults to the model surface (shows Hide) — back-compat for any caller
 * that hasn't threaded a slot.
 */
export function AppBlockChrome({
  blockInstanceId,
  appBlockId,
  appName,
  slug,
  modelId,
  modelName,
  slotId,
  canOpenPage = false,
}: {
  blockInstanceId: string;
  /** The approved AppBlock id of the running app. When present, the ⋯ menu
   *  gains a "Permissions & activity" item that opens a per-app transparency
   *  drawer (granted scopes + action audit). Omitted → the item is not shown
   *  (a caller that hasn't threaded the id gets the pre-existing chrome). */
  appBlockId?: string;
  appName?: string;
  /** The app's STORE slug — for an on-site app the `AppBlock.block_id`, which is
   *  also what `AppListing.slug` holds, so one value keys both `/apps/run/<slug>`
   *  and `appListings.getAppDetail`. Threaded by the full-page host, which has it
   *  as its own route param. Drives the breadcrumb crumb's store popover
   *  (`AppNameCrumb`); omitted → that crumb stays the static text it was, which is
   *  why the model surface (no slug, and no breadcrumb either) is unaffected.
   *
   *  🔴 NOT `appBlockId`. That prop is the internal `AppBlock.id` row key and
   *  matches NEITHER selector of `getAppDetail` (which takes a listing `slug` or an
   *  `apl_<ULID>` listing `id`); passing it would 404 every lookup. */
  slug?: string;
  modelId?: number;
  modelName?: string;
  /** The slot this chrome renders in. Drives the page-vs-model surface
   *  distinction — the "Hide" item is hidden on the full-page (`app.page`)
   *  surface. Omitted → treated as a model surface (Hide shown). */
  slotId?: string;
  /** Mirrors the viewer's `appBlocksPages` flag: may this viewer actually open
   *  `/apps/run/<blockId>`? Gates the "Recently run" section, whose ONLY link
   *  shape is that route — it 404s fail-closed without the flag, and the writers
   *  that feed the recents store record flag-blind.
   *
   *  🔴 THE PREDICATE IS UNIFORM ACROSS SURFACES — do not hardcode it per
   *  mount. What gates the *surface* (`appBlocksPages` on `/apps/run`,
   *  `appBlocksAuthor` on the dev tunnel, the reviewer gate on mod review) is a
   *  different question from what gates the *link target*, and only the latter
   *  matters here: the menu always points at `/apps/run/<blockId>`, whose
   *  `getServerSideProps` 404s on `appBlocks && appBlocksPages` for every
   *  viewer regardless of where they came from. So every mounter passes
   *  `!!features.appBlocksPages`, exactly like `AppListingCard`,
   *  `AppListingDetailBody`, `MySubmissionsList` and `MarketplaceBody` do.
   *  Pinned by the source-level guard in `recentAppsRail.test.ts`.
   *
   *  🔴 DEFAULTS TO FALSE (no dead links) so a NEW mounter that forgets the
   *  prop hides the menu rather than offering guaranteed-404 links.
   */
  canOpenPage?: boolean;
}) {
  // Gate the platform-nav "Review" item with the SAME greppable predicate the
  // /apps/review page + its server gate use (isAppReviewer), so the run-nav
  // shortcut can't drift from the real reviewer gate — this stays moderator-only
  // even after external-dev submission (W11) widens isAppDeveloper. useCurrentUser
  // returns null for anon → not a reviewer.
  const currentUser = useCurrentUser();
  const isModerator = isAppReviewer(currentUser);
  // Per-app "Permissions & activity" drawer open state (only reachable when
  // appBlockId was threaded through).
  const [permsOpen, setPermsOpen] = useState(false);
  // F4 — the review modal's target listing, `null` while closed.
  //
  // 🔴 THE CHROME OWNS THIS STATE BECAUSE NEITHER ENTRY POINT CAN. Both triggers
  // live inside a floating surface Mantine UNMOUNTS on close (a `Menu.Dropdown` and
  // a `Popover.Dropdown`), so a modal rendered beside either one would be destroyed
  // by the click that opens it — it could never appear. Hoisting the state here is
  // the same shape `AppListingDetailBody` uses for the same reason, and it is why
  // `ReviewListingModal` takes `opened` from its caller instead of owning it.
  //
  // Storing the LISTING ID rather than a boolean is what lets the modal be mounted
  // only when there is something to review: an id is what the entry point resolved
  // and handed up, so there is no window in which the modal exists without one.
  const [reviewListingId, setReviewListingId] = useState<string | null>(null);

  // Recently-run apps (client-only personalisation from localStorage). Seeded
  // empty so SSR + the first client render match (no hydration mismatch); the
  // real list loads in an effect after mount AND is refreshed every time the
  // menu opens (see `platformNavMenu` below) so a within-session client-nav
  // (app A → app B) shows the CURRENT list, not the list as of first mount.
  // Excludes the app currently being viewed (matched by appBlockId — the store's
  // stable id) and is capped to a short list for the compact dropdown.
  const [recents, setRecents] = useState<RecentApp[]>([]);
  // 🔴 Keyed by ACCOUNT (#4048) — localStorage is per browser profile, so the
  // store hands back only what the CURRENT viewer recorded (`null` = signed
  // out, its own bucket). In the dep list so an in-SPA account change re-reads.
  const recentsOwnerId = currentUser?.id ?? null;
  useEffect(() => {
    setRecents(getRecentlyOpenedApps(recentsOwnerId));
  }, [recentsOwnerId]);
  // Which of those entries this menu may offer. The rules (off-site exclusion,
  // the `appBlocksPages` gate that keeps a dark-flag viewer off guaranteed-404
  // `/apps/run/` links, self-exclusion, the cap) live in the pure
  // `selectChromeRecentApps` so the node `unit` project covers them — the
  // browser suites are not run in CI. The store's PER-KIND cap is what stops
  // off-site entries from evicting the on-site ones this menu needs.
  const recentApps = selectChromeRecentApps(recents, {
    canOpenPage,
    currentAppBlockId: appBlockId,
    limit: RECENTLY_RUN_LIMIT,
  });

  // 🔴 EVERY `<Menu>` IN THIS CHROME GOES THROUGH `useIframeAwareMenu`. That is a
  // rule about the SURFACE, not about one menu: the chrome sits directly on top
  // of a cross-origin app iframe, which swallows the `mousedown` of a click into
  // the app, so Mantine's `closeOnClickOutside` never fires and a dropdown is
  // left floating over the app the user just clicked into. The hook supplies
  // controlled open state plus the one signal that DOES fire (window `blur`) and
  // leaves every other close path (item click, Escape, same-document outside
  // click) on Mantine's untouched defaults.
  //
  // It is SHARED, not copied. The behaviour was originally inline here for the
  // platform-nav menu, and the ⋮ overflow menu — same component, same iframe —
  // silently shipped without it and was stuck open for exactly that reason. A
  // predicate open-coded at one site is how the second site is born wrong; the
  // ledger in `__tests__/iframeAwareMenu.test.ts` now fails if a floating surface
  // appears in this chrome that is not on the hook.
  //
  // 🔴 F3 MOVED THE ACTUAL `<Menu>` / `<Popover>` / `<Drawer>` INTO
  // `ChromeSurface`, AND THE HOOK STAYED HERE. That split is deliberate: the
  // primitive owns the RENDERING (which of the three a given bar width gets), the
  // chrome owns the STATE (one control per trigger). Keeping the hook at the call
  // site is what stops two surfaces from sharing one `opened` flag, which is the
  // failure a primitive that owned its own state would make easy. Below `sm` the
  // platform-nav control is simply unused — its trigger is not rendered, because
  // the nav folds into the ⋮ sheet — and calling the hook unconditionally is the
  // rules-of-hooks-legal way to say that.
  //
  // The platform-nav menu's own extra: on the transition to OPEN it re-reads the
  // recents store, so the "Recently run" list is fresh within an SPA session.
  // Still SSR-safe — the read only happens on a user-driven open (never during
  // render) and `getRecentlyOpenedApps()` self-guards `isClient`.
  const platformNavMenu = useIframeAwareMenu(() =>
    setRecents(getRecentlyOpenedApps(recentsOwnerId))
  );
  // The ⋮ overflow menu. No open-time side effect — its items are static — but
  // it needs the identical iframe-aware close, which is the whole point of the
  // shared hook.
  const overflowMenu = useIframeAwareMenu();
  // The full-page run surface (`app.page`) has no model-page slot to hide the
  // block from — the page IS the block — so suppress the "Hide" item there.
  const isPage = slotId != null && isPageSlot(slotId);
  const showHide = !isPage;
  // The host-rendered name of the running app. (H2) Naming the app in the host
  // chrome — not just the iframe `title` — lets the user tell WHICH sandboxed
  // app is running and trust its provenance; the iframe can't fake it. The name
  // is publisher-controlled, so sanitize it (strip bidi/control/zero-width chars,
  // collapse whitespace, bound length) before rendering it in the trust label.
  const sanitizedName = sanitizeAppChromeName(appName);
  const hasName = sanitizedName !== null;
  // Falls back to the literal "App" so the trust label is never blank.
  const label = sanitizedName ?? 'App';
  // De-dup the app name on the page surface. The breadcrumb's trailing crumb
  // (`app-block-breadcrumb-name`) already carries the app name there, so the
  // standalone badge name `Text` would render the SAME name a second time
  // (`[icon] <name>  /  Apps  /  <name>`). Suppress the badge name `Text` when
  // the breadcrumb is shown (page surface) and let the crumb be the sole
  // app-name; the provenance ICON stays (see the icon aria-label below) so the
  // trust signal is preserved. On the model surface (no breadcrumb) the badge
  // name renders exactly as before.
  const showBadgeName = !isPage;
  // The icon must carry the "App" provenance aria-label whenever there is
  // no adjacent visible Text saying "App" — i.e. when a real name shows
  // (so the icon + name read as "App, <name>") OR when the badge name Text
  // is suppressed on the page surface (so the provenance signal isn't lost with
  // the dropped Text). It's marked decorative (aria-hidden) ONLY when the
  // visible fallback "App" Text is present to carry provenance itself —
  // avoiding an unlabeled SVG / a double-reading "App".
  const iconProvenance = hasName || !showBadgeName;

  // 🔴 RESPONSIVE GEOMETRY IS DRIVEN BY THE CHROME'S OWN INLINE SIZE — see
  // `chromeGeometry.ts` for the full rationale and the breakpoint scale. Short
  // version: this bar renders both in a ~320px model sidebar and as the header of
  // a 2560px full-page app frame, so neither the viewport nor the page's `main`
  // ContainerProvider (which DOES exist on both surfaces, via BaseLayout, and is
  // therefore not the reason we don't use it) describes the space this row
  // actually has. `useResizeObserver` is the same primitive `ContainerProvider`
  // itself uses; we just point it at this element.
  //
  // Before the observer fires — SSR, and the first client render — the width is 0,
  // which resolves to the `base` tier whose values ARE the pre-change hard-coded
  // ones. So the server HTML and the first client paint are unchanged and there is
  // no hydration mismatch to guard with `useIsClient`.
  const [chromeWidth, setChromeWidth] = useState(0);
  const chromeRef = useResizeObserver<HTMLDivElement>((entry) => {
    const next = entry.borderBoxSize?.[0]?.inlineSize ?? entry.contentRect.width;
    setChromeWidth((prev) => (prev === next ? prev : next));
  });
  const geometry = resolveChromeGeometry(chromeWidth);

  // 🔴 F3 — THE MOBILE SHELL, AND THE `isPage` TERM IS NOT A HEDGE. Below the `sm`
  // breakpoint the page-surface chrome stops being a breadcrumb bar and becomes a
  // native mobile shell: a back chevron to the Marketplace, the app name centered and
  // tappable, and a ⋮ that carries the platform nav folded into it. It is gated on the
  // PAGE surface because that is the only surface that HAS a breadcrumb to replace —
  // the model-slot chrome is a badge and a ⋮ menu with no trail, and "back to the
  // Marketplace" is not a meaningful action from a model page you did not arrive at
  // through the store. A narrow model sidebar therefore resolves `geometry.compact`
  // TRUE (it is genuinely narrow) and still renders exactly the chrome it always has.
  const compact = isPage && geometry.compact;
  // The platform-nav destinations, authored ONCE and rendered into whichever surface
  // is carrying them: their own dropdown on a desktop-width bar, the ⋮ sheet below
  // `sm`. `ChromeSurfaceItem` is what makes one authoring serve both — see its header
  // for why a `Menu.Item` cannot simply be re-parented into a Drawer.
  //
  // 🔴 DEFINED BEFORE `appMenuItems` ON PURPOSE. `__tests__/chromeNavAlignsWithSubNav.ts`
  // slices this section out by anchoring on the `Civitai Apps` label and stopping at the
  // NEXT `<ChromeSurfaceLabel>`, so that the ⋮ menu's own `/apps/installed` item is not
  // keyed onto the platform nav's. Reordering these two consts silently widens that
  // slice.
  const platformNavItems = (
    <>
      <ChromeSurfaceLabel>Civitai Apps</ChromeSurfaceLabel>
      {/* 🔴 THE ICONS AND THE "Marketplace" LABEL ARE MIRRORED FROM THE STORE
          SUBNAV, WHICH IS THE SOURCE OF TRUTH — `SUB_NAV_LINKS` in
          `~/components/Apps/AppsSubNav`. This section and that tab bar are two
          renderings of ONE platform navigation: a user who opens an app from the
          store and then reaches for this menu is looking for the same four
          destinations they just left, and until now every shared concept was drawn
          with a DIFFERENT glyph here (grid vs storefront, apps vs plug, upload vs
          apps, shield vs gavel) — four out of four, so the disagreement was the
          rule rather than an oversight.

          When you add or re-icon an entry here, change `SUB_NAV_LINKS` first (or
          confirm it already says what you are about to write) and follow it. The
          alignment is pinned by `__tests__/chromeNavAlignsWithSubNav.test.ts`,
          which reads BOTH tables and fails when they drift — including when the
          subnav changes and this menu does not.

          The LABELS are deliberately NOT all identical: the subnav's tabs sit under
          an "Apps" heading and can afford one-word labels ("Installed", "Review"),
          whereas these items stand alone over a running app and need the noun
          ("Installed apps"). "Marketplace" is the one label that is shared verbatim,
          because "Apps home" named a destination the store itself stopped calling
          that. */}
      <ChromeSurfaceItem href="/apps" leftSection={<IconBuildingStore size={14} stroke={1.5} />}>
        Marketplace
      </ChromeSurfaceItem>
      <ChromeSurfaceItem
        href="/apps/installed"
        leftSection={<IconPlugConnected size={14} stroke={1.5} />}
      >
        Installed apps
      </ChromeSurfaceItem>
      <ChromeSurfaceItem href="/apps/mine" leftSection={<IconApps size={14} stroke={1.5} />}>
        My apps
      </ChromeSurfaceItem>
      {isModerator && (
        <ChromeSurfaceItem href="/apps/review" leftSection={<IconGavel size={14} stroke={1.5} />}>
          Review
        </ChromeSurfaceItem>
      )}
      {/* "Recently run" — a 1-click return to apps the viewer recently ran,
          sourced from the client-only localStorage recents store (read
          after mount so SSR + first client render match). Excludes the app
          currently being viewed and the whole label+section is omitted when
          there's nothing else to show (a first-time / single-app viewer).
          Each item shows the app icon (persisted `iconUrl`, else a generic
          app icon) + name, linking to the full-page run route. */}
      {recentApps.length > 0 && (
        <ChromeSurfaceGroup data-testid="app-recently-run">
          <ChromeSurfaceLabel>Recently run</ChromeSurfaceLabel>
          {recentApps.map((r) => (
            <ChromeSurfaceItem
              key={r.id}
              // Non-null by `selectChromeRecentApps` (ChromeRecentApp).
              href={`/apps/run/${r.blockId}`}
              data-testid="app-recently-run-item"
              // 🔴 THE ONE PUBLISHER-CONTROLLED LABEL IN EITHER SURFACE, so the one
              // that must be held to a single line. Its five siblings above are
              // host-authored and deliberately do NOT carry this — see the `clamp`
              // note in `ChromeSurface.tsx` for why it is opt-in rather than
              // universal.
              clamp
              leftSection={
                r.iconUrl ? (
                  <Avatar src={r.iconUrl} size={16} radius="sm" alt="" />
                ) : (
                  <IconApps size={14} stroke={1.5} />
                )
              }
            >
              {/* The persisted `name` is the SAME publisher-controlled string
                  the trust label above laundered through localStorage — so
                  route it through the identical sanitizer (strips bidi
                  RLO/LRO overrides, zero-width/format + control chars, caps
                  Zalgo combining runs, bounds length). `||` (not `??`) so an
                  empty/whitespace sanitized result falls back to the blockId
                  handle. */}
              {sanitizeAppChromeName(r.name) || r.blockId}
            </ChromeSurfaceItem>
          ))}
        </ChromeSurfaceGroup>
      )}
    </>
  );
  // The ⋮ overflow's own items — the actions that are about the RUNNING app rather
  // than about the platform. Unchanged in content from what shipped; only the element
  // that renders them moved.
  const appMenuItems = (
    <>
      <ChromeSurfaceLabel>App</ChromeSurfaceLabel>
      {/* 🔴 SAME ROUTE ⇒ SAME ICON, ACROSS BOTH SURFACES. This item and the
          platform nav's "Installed apps" are different WORDS for the same
          destination (`/apps/installed`), so they must not be different
          PICTURES: on a desktop bar the two dropdowns open a few pixels apart, and
          below `sm` they are literally rows of ONE sheet — a user who sees a plug in
          one and a grid in the other has to work out whether they lead to the same
          place. The glyph comes from the store subnav's row for this route
          (`SUB_NAV_LINKS`), exactly as the platform nav's does — the labels stay
          different on purpose ("Manage apps" is the action from inside a running app;
          "Installed apps" is the destination), because the rule is about the ROUTE,
          not the copy.

          Pinned by `__tests__/chromeNavAlignsWithSubNav.test.ts`, which checks
          EVERY literal-href item in the whole chrome, not just the platform-nav
          section — this item is the reason that check is repo-wide rather than
          scoped, since scoping it to one dropdown is what let this site drift. */}
      <ChromeSurfaceItem
        href="/apps/installed"
        leftSection={<IconPlugConnected size={14} stroke={1.5} />}
      >
        Manage apps
      </ChromeSurfaceItem>
      {/* F4 — the permanent review entry point. An ACTION, not a route link:
          it carries no `href`, so the ONE ROUTE, ONE ICON guard in
          `__tests__/chromeNavAlignsWithSubNav.test.ts` (which extracts only
          literal-href items) correctly does not treat it as a destination the
          store subnav must also list.

          Placed directly under "Manage apps" so the two whole-app actions that
          are ALWAYS about the running app ("rate it", "see what it can do") sit
          together above the dismissal, and "Hide app" stays last.

          🔴 THE ITEM RENDERS ITS OWN GATES AND MAY RETURN NULL. It is offered
          only to a viewer the server would accept: signed in, not the owner,
          holding a store scope that admits this listing's kind, and with store
          access at all (`hasAppsStoreAccess`). Offering a control whose submit
          403s is the anti-goal `useCanReviewListing` exists to prevent, so the
          gate is IMPORTED from the review module rather than re-derived here.
          The query behind it is mounted only while this surface is open — in a
          dropdown AND in the sheet, since Mantine unmounts a closed `Drawer`'s
          children exactly as it unmounts a closed `Menu.Dropdown`'s. */}
      <ChromeReviewMenuItem slug={slug} onOpenReview={setReviewListingId} />
      {appBlockId && (
        <ChromeSurfaceItem
          leftSection={<IconShieldLock size={14} stroke={1.5} />}
          onClick={() => setPermsOpen(true)}
        >
          Permissions & activity
        </ChromeSurfaceItem>
      )}
      {showHide && (
        <ChromeSurfaceItem
          leftSection={<IconEyeOff size={14} stroke={1.5} />}
          onClick={() =>
            hideBlock({
              blockInstanceId,
              appName,
              modelId,
              modelName,
              hiddenAt: Date.now(),
            })
          }
        >
          Hide app
        </ChromeSurfaceItem>
      )}
    </>
  );

  return (
    <>
      <Group
        ref={chromeRef}
        justify="space-between"
        gap="xs"
        px="xs"
        py={4}
        // 🔴 `nowrap` STAYS, and it is not the breakpoint-blind bit. The bar's
        // resting height is a pinned contract — `CHROME_BAR_PX = 35` in
        // `slotReservation.ts`, the model slot's CLS reservation — and letting this
        // row wrap to a second line at a narrow width would break it on exactly the
        // surface the reservation exists for. The fix for narrow widths is that both
        // flex children can SHRINK (`minWidth: 0` on the growing side, an explicit
        // `flexShrink: 0` on each icon button so the controls are never crushed),
        // which keeps the row one line tall at every width. This change is
        // width-only; `CHROME_BAR_PX` is unchanged.
        wrap="nowrap"
        data-testid="app-block-chrome"
        // Machine-readable resolved tier, so a test can assert the decision rather
        // than re-deriving it from pixels.
        data-chrome-tier={geometry.tier}
        // …and the F3 shell decision, for the same reason. `compact` is NOT derivable
        // from the tier alone (a model sidebar is `base` and never compact), so a test
        // that read the tier would be asserting a different question.
        data-chrome-compact={compact ? 'true' : 'false'}
        style={{
          borderBottom: '1px solid var(--mantine-color-default-border)',
          background: 'var(--mantine-color-default-hover)',
        }}
      >
        {compact ? (
          <>
            {/* F3 — the back affordance. It REPLACES the breadcrumb rather than
              shrinking it: a two-crumb trail costs ~90px of a 360px bar to say one
              thing, and the thing it says ("up to the Marketplace") is exactly what a
              back chevron says in a third of the space. It is a real anchor
              (`NextLink`), so middle-click / long-press / keyboard all behave, and it
              points at the SAME `/apps` the crumb did — the destination did not move,
              only its rendering.

              `ActionIcon size="sm"` is not a style choice here: it is what keeps the
              row at its pinned 31px resting height (`CHROME_BAR_PX`), the same as the
              icon buttons the desktop bar has always used. */}
            <ActionIcon
              component={Link}
              href="/apps"
              variant="subtle"
              color="gray"
              size="sm"
              aria-label="Back to Marketplace"
              data-testid="app-block-back"
              style={{ flexShrink: 0 }}
            >
              <IconChevronLeft size={16} stroke={1.5} />
            </ActionIcon>
            {/* The centered app name. `flex: 1 1 auto` between two 22px icon buttons is
              what centers it, and `minWidth: 0` is what lets the name truncate rather
              than push a control off the row.

              The provenance icon rides along rather than being dropped with the
              platform-nav trigger it used to live in. That trigger is GONE on this
              surface (the nav folded into ⋮), and it was the only thing carrying the
              "App" accessible name — losing it would have quietly removed the
              spoof-proof signal this whole bar exists for. */}
            <Group gap={6} wrap="nowrap" justify="center" style={{ minWidth: 0, flex: '1 1 auto' }}>
              <IconApps
                size={14}
                stroke={1.5}
                role="img"
                aria-label="App"
                style={{ flexShrink: 0 }}
              />
              <AppNameCrumb
                name={label}
                slug={slug}
                maxWidth={geometry.nameMaxWidth}
                onOpenReview={setReviewListingId}
                compact
              />
            </Group>
          </>
        ) : (
          <ChromeDesktopLeadingGroup
            geometry={geometry}
            platformNavMenu={platformNavMenu}
            platformNavItems={platformNavItems}
            iconProvenance={iconProvenance}
            showBadgeName={showBadgeName}
            label={label}
            isPage={isPage}
            slug={slug}
            onOpenReview={setReviewListingId}
          />
        )}
        {/* The ⋮ overflow. On a desktop-width bar it is the same dropdown it always
          was. Below `sm` it becomes a bottom sheet AND absorbs the platform nav,
          because the mobile bar has no second trigger to hang that behind — the
          operator's call, and the reason `platformNavItems` is authored as a fragment
          rather than inline in its own dropdown.

          Order: the running app's own actions first (that is what ⋮ has always
          meant), then the platform destinations. The back chevron already covers the
          most common of those, so the folded-in nav is the secondary half of the
          sheet, not its headline. */}
        <ChromeSurface
          compact={compact}
          kind="menu"
          control={overflowMenu}
          title="App menu"
          width={180}
          position="bottom-end"
          dropdownTestId="app-block-menu-dropdown"
          target={
            /* `data-testid` alongside the accessible name: the sibling controls in
             this chrome (`app-block-back`, `app-block-name`, `app-block-breadcrumb*`)
             are all addressable that way, and a test reaching this trigger by
             accessible name alone breaks on a copy change that is not a behaviour
             change. */
            <ActionIcon
              variant="subtle"
              color="gray"
              size="sm"
              aria-label="App menu"
              data-testid="app-block-menu-trigger"
              // The row is `wrap="nowrap"` (it must stay one line — CHROME_BAR_PX).
              // Without this the ⋯ trigger is a shrinkable flex item and a long name
              // at a narrow width can squeeze it below its resting `ActionIcon
              // size="sm"` (22px in @mantine/core 7.17.8); its sibling on the left
              // has carried `flexShrink: 0` all along.
              style={{ flexShrink: 0 }}
            >
              <IconDots size={16} stroke={1.5} />
            </ActionIcon>
          }
        >
          {appMenuItems}
          {compact && platformNavItems}
        </ChromeSurface>
      </Group>
      {/* Per-app transparency drawer (Part B). Rendered only when the caller
        threaded an appBlockId; the body's queries fire only once opened. */}
      {appBlockId && (
        <AppPermissionsActivityDrawer
          appBlockId={appBlockId}
          appName={sanitizedName ?? undefined}
          opened={permsOpen}
          onClose={() => setPermsOpen(false)}
        />
      )}
      {/* F4 — the review form, mounted OUTSIDE every floating surface (see
        `reviewListingId` above for why that is forced rather than tidy). Mounted only
        once an entry point has handed up a listing id, so a chrome nobody has asked
        to review issues no `getMyReview` and renders no modal DOM. The modal applies
        no eligibility gate of its own by design — the entry points did, and
        duplicating the rule would put it in two places.

        🔴 IT ALREADY GOES FULL-SCREEN ON A PHONE AND THAT IS NOT THIS COMPONENT'S
        DECISION: `ReviewListingModal` sets `fullScreen={isMobile}` from a VIEWPORT
        media query of its own. That is the right box for a modal (a modal IS the
        viewport, unlike this bar, which can be 320px wide inside a 2560px window), so
        it is deliberately NOT re-derived from `geometry.compact` here — two mechanisms
        answering one question is how they come to disagree. */}
      {reviewListingId && (
        <ReviewListingModal
          appListingId={reviewListingId}
          opened
          onClose={() => setReviewListingId(null)}
        />
      )}
    </>
  );
}

/**
 * The desktop bar's leading cluster: the platform-nav trigger, the badge app name and
 * the `Marketplace / <app name>` breadcrumb.
 *
 * 🔴 EXTRACTED PURELY TO KEEP THE COMPACT/DESKTOP BRANCH READABLE — every element
 * inside it is byte-for-byte what shipped, including the testids, the ARIA and the
 * responsive caps. F3 changes what renders BELOW `sm` on the page surface; above it,
 * and on the model surface at every width, this is the whole chrome and it is
 * untouched.
 */
function ChromeDesktopLeadingGroup({
  geometry,
  platformNavMenu,
  platformNavItems,
  iconProvenance,
  showBadgeName,
  label,
  isPage,
  slug,
  onOpenReview,
}: {
  geometry: ChromeGeometry;
  platformNavMenu: ChromeSurfaceControl;
  platformNavItems: ReactNode;
  iconProvenance: boolean;
  showBadgeName: boolean;
  label: string;
  isPage: boolean;
  slug: string | undefined;
  onOpenReview: (appListingId: string) => void;
}) {
  return (
    <>
      {/* minWidth:0 lets the truncating name shrink instead of pushing the
          ⋯ menu out of the narrow sidebar layout; `flex: 1 1 auto` lets it CLAIM
          the row's slack on a wide surface, which is what makes an uncapped name
          at the `xl` tier actually use the space instead of sitting at its
          content width. */}
      <Group gap={6} wrap="nowrap" style={{ minWidth: 0, flex: '1 1 auto' }}>
        {/* The provenance app icon doubles as a quick-nav Menu of the Civitai
            App PLATFORM's own pages (NOT the sandboxed app's internal routes —
            apps self-route as SPAs inside the iframe; the host has no list of
            those). The IconApps keeps its screen-reader provenance semantics
            (role="img" + aria-label "App") — required so a bare tabler <svg>'s
            label is announced; on the fallback the visible "App" Text carries
            provenance instead, so the icon is marked decorative there. */}
        <ChromeSurface
          compact={false}
          kind="menu"
          control={platformNavMenu}
          // Never reached: this surface renders only on the non-compact branch, so
          // `compact` is hard-false and the sheet's header text is dead. Passed
          // because the prop is required — one primitive, one contract.
          title="Civitai Apps"
          // Responsive: this dropdown renders publisher-controlled app names in
          // its "Recently run" section, so its useful width tracks the surface.
          // (The ⋮ overflow keeps a fixed width on purpose — every label in it is
          // short, fixed and host-authored.)
          width={geometry.navMenuWidth}
          position="bottom-start"
          dropdownTestId="app-platform-nav-dropdown"
          target={
            <ActionIcon
              variant="subtle"
              color="gray"
              size="sm"
              aria-label="Apps menu"
              data-testid="app-platform-nav-trigger"
              style={{ flexShrink: 0 }}
            >
              <IconApps
                size={14}
                stroke={1.5}
                role={iconProvenance ? 'img' : undefined}
                aria-label={iconProvenance ? 'App' : undefined}
                aria-hidden={iconProvenance ? undefined : true}
              />
            </ActionIcon>
          }
        >
          {platformNavItems}
        </ChromeSurface>
        {/* Host-rendered (spoof-proof) app-name label. Truncates with an
            ellipsis so a long name never wraps or shoves the menu off the row in
            the narrow model.sidebar_top slot. The cap is now RESPONSIVE to the
            bar's own width (`chromeGeometry.ts`) instead of a fixed 160px: 160 in
            a narrow sidebar / on a phone exactly as before, wider as the bar gets
            wider, and uncapped once the bar is `xl`. On the page surface this is
            suppressed (the breadcrumb crumb below carries the name once) — see
            `showBadgeName`. */}
        {showBadgeName && (
          <Text
            size="xs"
            c="dimmed"
            truncate
            maw={geometry.nameMaxWidth}
            data-testid="app-block-name"
          >
            {label}
          </Text>
        )}
        {/* Page-surface breadcrumb: `Apps / <app name>`. Only on the full-page
            run surface (`app.page`) — the page IS the block, so an "up to the
            apps list" trail is meaningful there; the compact model-slot chrome
            (badge + ⋯ menu) gets nothing extra. "Apps" links back to /apps; the
            app name reuses the SAME sanitized (spoof-proof) chrome name as the
            provenance badge — never a raw/untrusted manifest string. */}
        {isPage && (
          <Group
            gap={4}
            wrap="nowrap"
            style={{ minWidth: 0 }}
            data-testid="app-block-breadcrumb"
            aria-label="Breadcrumb"
          >
            <Text size="xs" c="dimmed" aria-hidden>
              /
            </Text>
            {/* Link affordance: the SITE'S OWN `Anchor`, not a hand-styled `Text`. This
                crumb used to carry `c="blue.6" td="underline"` — a hand-rolled colour and
                decoration, which is what made the chrome read as foreign inside its own page.

                🔴 THE COLOUR IS NOW THEMED, AND THAT IS THE HALF THAT MATTERS. Mantine 7.17.8
                resolves `--mantine-color-anchor` per COLOR SCHEME (`@mantine/core/styles.css`):
                  light → `--mantine-primary-color-filled` → `--mantine-color-blue-filled`
                          → `--mantine-color-blue-6`   ← identical to the old hard-coded value
                  dark  → `--mantine-color-blue-4`
                So light is unchanged to the pixel, and DARK improves: measured against this
                bar's own background (`--mantine-color-default-hover` → dark-5 `#2c2e33`) the
                link goes 3.82:1 → 5.49:1, i.e. from FAILING WCAG AA to passing it. The old
                fixed shade was only ever reasoned about against the light background.

                🔴 DO NOT RESTATE THE OLD "blue.6 CLEARS AA ON THE LIGHT CHROME" CLAIM — IT IS
                FALSE, AND IT WAS FALSE BEFORE THIS CHANGE TOO. Measured: blue-6 `#228be6` on
                this bar's light background (gray-0 `#f8f9fa`) is **3.37:1**, against the 4.5:1
                AA needs for the crumb's 12px (`size="xs"`) text. An audit did bump the shade
                from `blue.4`, which improved it, but it did not reach AA and no comment should
                say it did. That shortfall is PRE-EXISTING and untouched here — this change
                neither causes nor fixes it — and it is recorded so the next reader measures
                instead of inheriting the claim.

                🔴 `underline="always"` IS NOT A RE-FORK — IT IS THE SITE'S OWN PROP, USED THE
                WAY THE SITE ALREADY USES IT. `Anchor`'s default is `underline="hover"`, and
                that default is wrong HERE specifically: this crumb's neighbours are the two
                dimmed `/` separators and the dimmed app-name crumb, so at rest the ONLY thing
                distinguishing the link from them would be hue — measured at **1.07:1** on
                light (blue-6 vs gray-6) and 1.29:1 on dark. That is WCAG 1.4.1 failure F73:
                colour as the sole differentiator is permitted only above 3:1, and Mantine
                emits its underline for `:hover`/`:active` only — there is no `:focus-visible`
                rule to fall back on. Five other call sites in this repo reach for the same
                prop for the same reason (`ShopItem`, the Sticker hover cards, `StickerBook`).
                What this change removes is the hand-rolled `c=`/`td=` pair, not the resting
                cue the crumb has always had.

                Real anchor semantics (a Next `<Link>`) are unchanged: keyboard, middle-click
                and long-press all still behave. */}
            <Anchor
              component={Link}
              href="/apps"
              size="xs"
              underline="always"
              style={{ flexShrink: 0 }}
              data-testid="app-block-breadcrumb-apps"
              data-clickable="true"
            >
              {/* Reads "Marketplace", not "Apps" — the destination `/apps` is what the
                  store's own subnav calls its first tab (`SUB_NAV_LINKS[0].label`), and a
                  crumb that names the page differently from the page's own tab makes the
                  trail look like it leads somewhere else. The testid deliberately keeps
                  its `-apps` spelling: it addresses the crumb by its ROUTE, which has not
                  moved, so a future copy change does not churn every test that reaches
                  for it. */}
              Marketplace
            </Anchor>
            <Text size="xs" c="dimmed" aria-hidden>
              /
            </Text>
            {/* The trailing crumb is a CONTROL, not a label — see `AppNameCrumb`.
                It keeps the same responsive cap as the badge name (it is the same
                publisher-controlled string, just on the page surface, so one tier
                table serves both) and the same testid; what it adds is a popover
                with the app's full name, the store's recommend rollup and a "View
                in App Store" action. The whole cluster is gated on
                `hasAppsStoreAccess` INSIDE that component — a viewer without store
                access gets the static text this used to be. */}
            <AppNameCrumb
              name={label}
              slug={slug}
              maxWidth={geometry.nameMaxWidth}
              onOpenReview={onOpenReview}
              compact={false}
            />
          </Group>
        )}
      </Group>
    </>
  );
}

export function IframeHost({
  install,
  context,
  token,
  expiresAt,
  missingScopes,
  domain,
  maxBrowsingLevel,
  onConsentGranted,
}: IframeHostProps) {
  // Treat the slot context as ModelSlotContext when the optional viewer/theme
  // fields are present; otherwise default conservatively. ModelSlotContext is
  // the only producer in v1 (ModelVersionDetails); other surfaces use the
  // base SlotContext shape.
  const modelCtx = context as Partial<ModelSlotContext>;
  // The chrome's "Recently run" menu links ONLY to `/apps/run/<blockId>`, and
  // that route 404s unless the viewer has BOTH `appBlocks` AND `appBlocksPages`
  // — on EVERY surface, because the gate is on the viewer, not on where the
  // link was clicked from. So the predicate mirrors the route's own
  // `getServerSideProps` conjunction, not just the pages flag.
  const features = useFeatureFlags();
  // The AUTHORITATIVE signed-in signal for this host. Deliberately not
  // `context.viewerUserId`: that is a slot-context field the producing page fills
  // in, so it describes the render context rather than the live session, and the
  // SET_COLLECTION_FOLLOW handler below refuses an anonymous viewer on it (the
  // property the HTTP endpoint enforced with a 403 on an anonymous block token).
  // `AppBlockChrome` already calls this hook, so it costs nothing new here.
  const currentUser = useCurrentUser();
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  // The host trust frame (`framed()` below) — the box the VIEWER sees, which is
  // the chrome bar plus the iframe. Needed so layer 4 of the height clamp can
  // measure its own overhead rather than assume it; see `frameOverheadPx`.
  const frameRef = useRef<HTMLDivElement | null>(null);
  const [status, setStatus] = useState<Status>('loading');
  // Mirror of `status`, read by the four status-gated message handlers
  // (RESIZE_IFRAME, REQUEST_SIGN_IN, REQUEST_CONSENT, OPEN_BUZZ_PURCHASE) via
  // `readGateStatus` below.
  //
  // 🔴 ASSIGNED IN THE RENDER BODY, NOT IN AN EFFECT — that placement IS the fix,
  // and an effect here is the bug. React writes the `data-block-ready` DOM
  // attribute (and every other commit-time output) during the COMMIT, but flushes
  // PASSIVE effects in a LATER scheduler task whenever the commit exhausts the 5ms
  // frame budget (scheduler 0.23.2, MessageChannel transport, `frameYieldMs = 5`).
  // So an effect-updated mirror is stale for exactly the window in which the host
  // has already publicly announced readiness. A render-body assignment happens
  // BEFORE the commit, so by the time anything observable says "ready" the mirror
  // already is. This is the same defect, and the same fix, as PageBlockHost's —
  // see the 🔴 note on its own `statusRef` for the measurement.
  //
  // CONCURRENT-RENDERING SAFETY. Writing a ref during render is impure, so the
  // three ways that bites were each checked rather than assumed:
  //   • StrictMode double-render writes the SAME value twice — idempotent.
  //   • An interrupted/discarded concurrent render can leave the ref holding a
  //     status that never committed. It converges: React always eventually renders
  //     the latest state, and that render overwrites the ref.
  //   • It is only ever written from `status` (component state), never derived
  //     from props or anything a parent can change mid-render.
  //
  // 🔴 WHICH DIRECTION THAT TRANSIENT DISAGREEMENT RUNS IN — read this before
  // pointing a NEW gate at the ref. "Ref ahead of the DOM" is NOT always the
  // permissive direction; it inherits the direction of the transition in flight,
  // and this component has transitions BOTH ways:
  //   • loading → ready is PERMISSIVE. The ref says ready while `data-block-ready`
  //     still reads "false", so a gate can open a beat before the host has publicly
  //     announced readiness. Harmless, and it is the whole point of the fix.
  //   • ready → fatal (`BLOCK_ERROR{fatal:true}`, the handler below) is
  //     RESTRICTIVE. A concurrent render writes `statusRef.current = 'fatal'`,
  //     yields before commit, and a queued OPEN_BUZZ_PURCHASE arriving in that gap
  //     is REFUSED while `data-block-ready` still reads "true".
  // The restrictive case is deliberate and is the safer side of the trade: the ref
  // is the host's freshest knowledge of its own state, so refusing a spend on a
  // host that has already decided it is broken is correct, and the DOM attribute is
  // the thing lagging. A gate that must NOT tighten early (there is none today)
  // would have to key off the committed `status`, not this ref.
  //
  // RESIDUAL WINDOW, stated rather than hidden: this closes the commit→passive-
  // effect gap, NOT the larger message-received→render gap. `status` becomes
  // 'ready' only as a RESULT of the block's own BLOCK_READY being processed
  // (setStatus → render → commit), so a block that posts a gated request in the
  // SAME turn as BLOCK_READY still meets a 'loading' mirror — React has not
  // rendered yet. The NACK on OPEN_BUZZ_PURCHASE (the one repliable gate here) is
  // what covers that remainder — a drop there fails FAST instead of hanging.
  const statusRef = useRef<Status>('loading');
  statusRef.current = status;
  /**
   * The ONE way a message handler asks "is the host ready?".
   *
   * Reads the RENDER-BODY-updated `statusRef` rather than closing over `status`,
   * so the answer is current the moment the render that made the host ready is
   * committed — not one scheduler task later, when React gets around to flushing
   * passive effects and re-registering the listener with a fresh closure.
   *
   * No `'error' → 'no_token'` shim, unlike PageBlockHost's version: this host's
   * local `Status` union is byte-identical to the shared gates' `HostStatus`
   * (`openBuzzPurchaseGate.ts`), so the value passes straight through. Deliberately
   * NOT imported from `pageBlockHostLogic` — the page host is a sibling surface,
   * not a dependency of this one, and there is nothing to share but an identity fn.
   *
   * Stable identity (`[]` deps, ref read only) is load-bearing in its own right:
   * it lets the four gated effects DROP `status` from their dependency arrays, so
   * they now subscribe ONCE per mount instead of tearing down and re-registering
   * on every status transition. The window this fix is about cannot exist if the
   * listener never needs replacing.
   */
  const readGateStatus = useCallback((): Status => statusRef.current, []);
  const [iframeHeight, setIframeHeight] = useState<number>(
    install.manifest.iframe?.minHeight ?? 200
  );
  // The iframe's `load` event is kept as a best-effort EARLY signal (it can
  // win the race on fresh/slow loads) but is NO LONGER the trigger for init.
  // The prod bug was that on cached bundles `load` fires before React attaches
  // `onLoad`, so a load-gated single-shot init was silently missed and the
  // block sat blank forever. Init is now driven by IframeInitController
  // (retry-until-BLOCK_READY), keyed only on token + checkpoint readiness.
  const initSentRef = useRef<boolean>(false);
  // One controller per mount; owns the BLOCK_INIT retry interval + the
  // readiness timeout. Created lazily in the init effect.
  const controllerRef = useRef<IframeInitController | null>(null);
  // Stable holder for the latest init payload so the controller's interval
  // always posts the freshest BLOCK_INIT (token/checkpoint can resolve after
  // the controller started — the next tick picks up the new payload) without
  // re-creating the controller and resetting its timers.
  const buildInitPayloadRef = useRef<() => BlockInitPayload>();
  // Analytics Phase 2: emit-once guard for the block-render beacon, SHARED with
  // the render-FAILURE beacon below so `ok` and `error` are mutually exclusive
  // per mount. The committed-`status` effects are the primary dedup; this ref
  // makes the per-mount emit deterministic even if duplicate BLOCK_READY acks
  // land before React commits the 'ready' state.
  const blockRenderEmittedRef = useRef<boolean>(false);
  // The height the block offered in its BLOCK_READY ack, stashed for the
  // ready-transition effect to apply once React has COMMITTED 'ready'.
  //
  // 🔴 A ref, not state, and read ONLY from the `status === 'ready'` effect. That
  // makes H-11 STRUCTURAL rather than a timing observation: a late ack that
  // arrives after the host already landed on 'timeout' / 'fatal' / 'no_token'
  // still writes here, but `status` can never become 'ready' again from a
  // terminal state (BLOCK_READY only transitions FROM 'loading'), so the stashed
  // value is simply never read and the height is never applied.
  const pendingReadyHeightRef = useRef<unknown>(undefined);
  // Run the loading→ready side effects (height + `ok` beacon) exactly once per
  // mount. Without this, an identity change of the `applyHeight` callback (its
  // deps are manifest min/max height) would re-run the effect while `status` is
  // still 'ready' and re-apply the handshake height, clobbering a height the
  // block had since negotiated via RESIZE_IFRAME.
  const readyTransitionAppliedRef = useRef<boolean>(false);

  // App Blocks Analytics Phase 2 — fire-and-forget block render/impression,
  // emitted exactly once per mount on the COMMITTED loading→ready transition
  // (see the ready-transition effect below) via the /api/track/block-render beacon
  // (NOT a tRPC mutation — this fires per model-page-with-a-block view, so at GA
  // it must skip the full tRPC middleware chain; mirrors the #2680 addView ->
  // beacon move). The client passes only the three identifiers; `isAnon`/`userId`
  // are derived/stamped server-side in the route. This host only mounts via the
  // `appBlocks`-flag-gated BlockSlot → BlockSlotClient → BlockHost path, so the
  // event is dark behind the same flag as the rest of App Blocks.
  // Slot the block rendered in (e.g. 'model.sidebar_top'). Mirrors the default
  // used everywhere else modelCtx.slotId is read in this component.
  const slotId = modelCtx.slotId ?? 'model.sidebar_top';

  // The viewer's ACTIVE color scheme, as one value.
  //
  // 🔴 ONE PLACE, on purpose. This used to be `modelCtx.theme ?? 'light'`
  // open-coded at each of its two readers (the init-fragment fields and the
  // BLOCK_INIT payload); the THEME_CHANGE push below is a THIRD reader, and
  // three copies of a defaulting expression is how they drift. It is a plain
  // derived value (ModelVersionDetails threads a live `useComputedColorScheme`
  // down through the slot context), so it re-renders this component on a toggle
  // — which is exactly what makes the effect below fire.
  const activeTheme: 'light' | 'dark' = modelCtx.theme ?? 'light';

  // The publisher's declared src. The rendered `src` adds the init-fragment
  // fast path on top ONLY when this block is gated on for it (see
  // blockInitFragmentGate.ts — off by default for every block). The ORIGIN is
  // derived from the BASE so the postMessage target can never be affected by
  // the fragment.
  const baseIframeSrc = install.manifest.iframe?.src ?? '';
  const iframeSrc = useBlockIframeSrc(
    baseIframeSrc,
    {
      theme: activeTheme,
      renderMode: install.renderMode,
      blockInstanceId: install.blockInstanceId,
    },
    blockInitFragmentEnabled({ surface: 'model-slot', blockId: install.blockId })
  );
  const expectedOrigin = useMemo(() => {
    try {
      return new URL(baseIframeSrc).origin;
    } catch {
      return '';
    }
  }, [baseIframeSrc]);

  // The EFFECTIVE sandbox handed to the iframe attribute below. Derive the
  // transport's opaque-origin mode from the SAME string so they can never
  // drift: unverified (no allow-same-origin) → opaque frame → opaque transport;
  // internal/verified (has allow-same-origin) → real origin → pinned transport.
  const effectiveSandbox = useMemo(
    () => intersectSandbox(install.manifest.iframe?.sandbox, install.trustTier),
    [install.manifest.iframe?.sandbox, install.trustTier]
  );
  const opaqueOrigin = useMemo(
    () => effectiveSandboxIsOpaque(effectiveSandbox),
    [effectiveSandbox]
  );

  const { send, onMessage } = usePostMessage({ iframeRef, expectedOrigin, opaqueOrigin });

  // The last height the BLOCK ITSELF stated, before any clamping — stashed so a
  // viewport change can re-run the clamp against the new bound. The block is
  // never asked to re-measure (RESIZE_IFRAME is one-way, block → host), so
  // without this the host would have nothing but its OWN already-clamped value
  // and could only ever ratchet downward: a block that stated 3000 at a 640px
  // viewport would stay pinned at 640 after the viewer rotated to a 900px one.
  const reportedHeightRef = useRef<number | null>(null);

  // applyHeight is wrapped so the postMessage subscribers keep a stable
  // reference even though install.manifest is stable across renders.
  //
  // Four layers of height defense:
  //   1. isFinite + positive guard — rejects NaN, Infinity, negatives.
  //   2. manifest.maxHeight (publisher's stated ceiling), if set.
  //   3. HARD_HEIGHT_CEILING — independent backstop in case maxHeight is
  //      null (allowed by the manifest validator) and the block sends a
  //      huge number. This is the OOM guard.
  //   4. The viewer's viewport height, MINUS the host chrome rendered above the
  //      iframe — the layer that binds the COMMON case, and it bounds the framed
  //      WIDGET rather than the iframe alone. `iframe.maxHeight` is
  //      `["integer","null"]` in the manifest schema and `iframe` requires no
  //      fields at all, so a manifest that simply omits it is bounded only by
  //      layer 3: a block self-reporting 3000px got a 3000px iframe inside a
  //      ~640px phone viewport. The block scrolls internally instead, which is
  //      the intended outcome. Both the viewport AND the chrome overhead are
  //      read at CALL time, never captured at mount — either value stashed at
  //      mount is stale after a rotate, a browser-chrome resize, or a chrome bar
  //      that re-wraps. What it does NOT bound is the publisher's `minHeight`;
  //      see `clampBlockHeight`.
  const applyHeight = useCallback(
    (h: unknown) => {
      if (typeof h !== 'number' || !Number.isFinite(h) || h <= 0) return;
      const min = install.manifest.iframe?.minHeight ?? 200;
      const max = install.manifest.iframe?.maxHeight;
      reportedHeightRef.current = h;
      setIframeHeight(
        clampBlockHeight(h, min, max, frameOverheadPx(frameRef.current, iframeRef.current))
      );
    },
    [install.manifest.iframe?.minHeight, install.manifest.iframe?.maxHeight]
  );

  // Layer 4 is only a bound if it MOVES with the viewport. A block that reported
  // 3000px while the viewport was 900px tall must shrink when the viewer rotates
  // to a 640px one — otherwise the clamp is a one-shot decided by whatever the
  // viewport happened to be at handshake time.
  //
  // Host-side only: nothing is posted back to the block. The re-clamp reads the
  // block's own last stated height out of the ref and re-applies the same four
  // rules, so a viewport change can shrink AND re-grow within the bounds the
  // block already asked for. The chrome overhead is re-measured on each event
  // too, so a bar that re-wraps at the new width is accounted for.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const min = install.manifest.iframe?.minHeight ?? 200;
    const max = install.manifest.iframe?.maxHeight;
    const onViewportChange = () => {
      const reported = reportedHeightRef.current;
      // 🔴 A TYPE NARROWING, NOT A COVERED BRANCH — labelled so nobody reads it
      // as a guard that is tested. It is behaviourally INERT on every reachable
      // input: the ref is null only pre-handshake, when `iframeHeight` is already
      // `min`, and the clamp of any value against `Math.max(min, …)` returns
      // `min` there anyway. It exists because `reportedHeightRef.current` is
      // `number | null` and `clampBlockHeight` takes a `number`. The suite's
      // pre-handshake case is an INVARIANT guard on that equivalence, not
      // regression coverage for this line.
      if (reported === null) return;
      setIframeHeight(
        clampBlockHeight(reported, min, max, frameOverheadPx(frameRef.current, iframeRef.current))
      );
    };
    window.addEventListener('resize', onViewportChange);
    return () => window.removeEventListener('resize', onViewportChange);
  }, [install.manifest.iframe?.minHeight, install.manifest.iframe?.maxHeight]);

  // A6 lazy consent: the scopes ACTUALLY carried by the minted token — the
  // manifest scopes minus the consent-gated ones the viewer hasn't granted yet
  // (`missingScopes`, reported by the mint). The server signs exactly this set
  // into the JWT; sending the full manifest scopes in the wrapped token would
  // lie to the block (it would think it has `ai:write:budgeted` when the JWT
  // doesn't), defeating the block's Generate-time consent check. For anon and
  // fully-granted viewers `missingScopes` is empty, so this equals the manifest
  // scopes — no behavior change. (Anon is gated block-side by `viewer === null`,
  // not by scopes.)
  const grantedScopes = useMemo<string[]>(() => {
    const declared = install.manifest.scopes ?? [];
    if (!missingScopes || missingScopes.length === 0) return declared;
    const withheld = new Set(missingScopes);
    return declared.filter((s) => !withheld.has(s));
  }, [install.manifest.scopes, missingScopes]);

  // Mirror the server's buzzBudget resolution (publisher's
  // buzz_budget_per_gen → manifest default → 10, capped at 1000) so blocks
  // can display the budget without a JWT decode. Only present when the token
  // actually carries ai:write:budgeted (i.e. after consent); absent otherwise —
  // a budget cap is meaningless without the spend scope it bounds.
  //
  // Must stay in lockstep with the server's `resolveBuzzBudget`
  // (src/pages/api/v1/block-tokens/index.ts): require an INTEGER (not merely a
  // finite number) so a fractional / Infinity / NaN value falls back to the
  // default here exactly as the server mints it — otherwise the UI would show a
  // per-gen budget the server never signed.
  const buzzBudget = useMemo<number | undefined>(() => {
    if (!grantedScopes.includes('ai:write:budgeted')) return undefined;
    const raw = install.publisherSettings?.buzz_budget_per_gen;
    const candidate = typeof raw === 'number' && Number.isInteger(raw) ? raw : 10;
    if (candidate <= 0) return undefined;
    return Math.min(candidate, 1000);
  }, [grantedScopes, install.publisherSettings]);

  // Effective Checkpoint after publisher-default ∪ viewer-override merge.
  // Anon viewers see publisher default; authenticated viewers see their
  // override if set. We wait for this to resolve before sending BLOCK_INIT
  // so the block never sees a stale `context.checkpoint`. Cached
  // server-side via the query's React Query layer.
  const effectiveCheckpointQuery = trpc.blocks.getEffectiveCheckpoint.useQuery(
    {
      blockInstanceId: install.blockInstanceId,
      // The resolver re-validates synthetic ids against (modelId, slotId).
      // modelCtx is partial-typed but in practice both fields are required
      // by the slot context shape ModelSlotContext mandates them.
      modelId: modelCtx.modelId ?? 0,
      slotId: (modelCtx.slotId ?? 'model.sidebar_top') as
        | 'model.sidebar_top'
        | 'model.below_images'
        | 'model.actions_extra',
    },
    {
      enabled: typeof modelCtx.modelId === 'number' && !!modelCtx.slotId,
      staleTime: 60_000,
    }
  );
  const effectiveCheckpoint = effectiveCheckpointQuery.data?.checkpoint ?? null;

  // Top showcase images for the bound model version. Used by the block to
  // render a carousel + auto-populate gen params from the user's pick.
  // Skip when context doesn't carry a modelVersionId (non-model slots);
  // a 5-min staleTime is fine since reactions move slowly within a session.
  const modelVersionId =
    typeof modelCtx.modelVersionId === 'number' ? modelCtx.modelVersionId : null;
  // Send the viewer's current browsing level so the server only returns
  // showcase images (URLs + gen-meta) the viewer is allowed to see. The
  // server forces anon viewers to public (PG) and never trusts this to widen
  // an anon view — this just lets a logged-in NSFW-opted-in viewer see the
  // same NSFW showcase the model-page gallery would show them.
  const browsingLevel = useBrowsingLevelDebounced();
  const showcaseQuery = trpc.blocks.getShowcaseImages.useQuery(
    { modelVersionId: modelVersionId ?? 0, browsingLevel },
    { enabled: modelVersionId != null, staleTime: 5 * 60_000 }
  );
  const showcaseImages = showcaseQuery.data ?? [];

  const buildInitPayload = (): BlockInitPayload => ({
    blockInstanceId: install.blockInstanceId,
    blockId: install.blockId,
    appId: install.appId,
    token: {
      raw: token,
      scopes: grantedScopes,
      expiresAt,
      ...(buzzBudget !== undefined ? { buzzBudget } : {}),
    },
    // Data-minimization (security audit — MEDIUM): project the slot context
    // to an explicit contract allowlist before posting it to the untrusted
    // publisher iframe, instead of spreading the whole context. This drops
    // PII / internal fields no block needs — viewerNsfwEnabled, creatorUserId,
    // and the viewer id/status/username that are duplicated (intentionally) in
    // the `viewer` object below. projectBlockInitContext also layers in the
    // host-resolved checkpoint + showcase images. See projectBlockInit.ts.
    context: projectBlockInitContext(context, {
      // Merge in the resolved checkpoint so the block can render its
      // header ("Generating with: NAME") without an extra round-trip.
      checkpoint: effectiveCheckpoint,
      // Showcase images for the carousel — empty array when the query
      // returns no images or hasn't loaded yet (we don't block init on
      // showcase the way we do on checkpoint; the carousel can re-render
      // later when the query lands).
      showcaseImages,
    }),
    settings: {
      publisherSettings: install.publisherSettings,
      // v1 has no per-viewer settings yet (Phase 2 wires the
      // block_user_settings table); ship empty so the SDK contract is
      // stable across versions.
      userSettings: {},
    },
    // Contract `viewer` object (null for anon) — the only place viewer
    // id/username/status are exposed to the iframe. Built via the same pure
    // projection module so the allowlist lives in one tested place.
    viewer: projectBlockInitViewer(context),
    theme: activeTheme,
    renderMode: install.renderMode,
    // Advisory maturity signal — server-authoritative values from the mint.
    ...projectBlockInitMaturity({ domain, maxBrowsingLevel }),
  });

  // Keep the controller's interval posting the freshest payload. buildInitPayload
  // closes over query results that can resolve AFTER the controller started; we
  // re-point this ref every render so the next retry tick uses the latest data
  // without resetting the controller's timers.
  buildInitPayloadRef.current = buildInitPayload;

  // Post a single BLOCK_INIT. The IframeInitController calls this immediately
  // on start() and then on each retry tick until BLOCK_READY. It is safe to
  // call repeatedly: the block's IframeTransport origin-checks and dedupes
  // BLOCK_INIT (`if (!this.initResolved)`), so extra posts are ignored
  // block-side. `initSentRef` is flipped on the first post so the dependent
  // flows (TOKEN_REFRESH push, REQUEST_TOKEN reply, SUSPEND-on-unmount) that
  // key off "have we begun initing?" still fire.
  const sendInitOnce = useCallback(() => {
    initSentRef.current = true;
    send('BLOCK_INIT', (buildInitPayloadRef.current ?? (() => undefined as never))());
  }, [send]);

  // H-3: when the token rotates after BLOCK_INIT (every ~13min), send a
  // TOKEN_REFRESH message so the iframe can pick up the new credential
  // without us tearing down the element. useBlockToken now keeps the
  // iframe mounted across refreshes; this hook pushes the new value.
  //
  // Payload mirrors the BLOCK_INIT.token wrapped shape so the iframe can
  // replace its `token` reference with one call. Subsequent calls reuse
  // the same SDK schema.
  useEffect(() => {
    if (!initSentRef.current || !token) return;
    send('TOKEN_REFRESH', {
      token: {
        raw: token,
        scopes: grantedScopes,
        expiresAt,
        ...(buzzBudget !== undefined ? { buzzBudget } : {}),
      },
    });
  }, [token, expiresAt, buzzBudget, grantedScopes, send]);

  // 🔴 DECLARED BEFORE THE INIT-HANDSHAKE EFFECT ON PURPOSE, and PageBlockHost
  // places it the same way. React runs effects in declaration order, so on the
  // FIRST commit this must run while `initSentRef` is still false — otherwise
  // the gate in it is INERT on mount and the host emits a redundant
  // THEME_CHANGE immediately after its own BLOCK_INIT (measured on the page
  // host, where this effect originally sat after the init effect). Reordering
  // silently re-creates that, which is why
  // `IframeHostThemeChange.browser.test.tsx` asserts the mount sequence.
  // Push a THEME_CHANGE when the viewer toggles light/dark WHILE the block is
  // mounted. Without it the block keeps its mount-time theme until reloaded:
  // BLOCK_INIT is deduped SDK-side (only the first is honored) and
  // `useBlockIframeSrc` deliberately FREEZES the URL fragment at mount, so
  // neither existing channel can carry a later value.
  //
  // 🔴 THE SAME WIRING MUST EXIST IN PageBlockHost.tsx. The two hosts do NOT
  // share a bridge — each registers its own postMessage handlers by hand (the
  // gotcha-#73 class `hostHandlerParity.ts` documents) — so wiring one surface
  // and not the other leaves half the blocks stuck. `hostHandlerParity` cannot
  // catch this one: its INVENTORY covers block→host messages, and this is a
  // host→block push. The per-surface browser tests are the coverage.
  //
  // Gated on `initSentRef` for the same reason TOKEN_REFRESH is: before the FIRST
  // BLOCK_INIT post there is nothing to talk to. (Note the guard flips on that
  // POST, not on BLOCK_READY — so a toggle between the post and the ack does
  // push, into a frame that may not be listening yet. That is harmless and NOT
  // the safety net: `buildInitPayload` reads `activeTheme` fresh on every retry
  // tick, so the BLOCK_INIT the block finally accepts carries the current theme
  // regardless of whether any push was heard.) Deps are [activeTheme, send] only
  // — this must fire on a THEME change, never on an unrelated re-render.
  useEffect(() => {
    if (!initSentRef.current) return;
    send('THEME_CHANGE', { theme: activeTheme });
  }, [activeTheme, send]);

  // SDK request-driven flow: iframe asks for the current token (e.g. right
  // before an expensive call) and we reply with the latest wrapped value.
  // Pairs with the push flow above — both produce the same payload shape.
  //
  // 🔴 A `TOKEN_REFRESH_RESPONSE` WITHOUT A `requestId` IS NOT A REPLY. The
  // block side's `refresh()` awaits a response correlated STRICTLY by
  // `requestId` — it resolves the pending promise for that id and nothing else —
  // so an uncorrelated reply has never resolved anyone's `refresh()`. Where it
  // appeared to work at all it was via the SDK's incidental side effect of
  // snapshotting whatever token rides on any `TOKEN_REFRESH_RESPONSE`, while the
  // caller's promise sat there until its own timeout.
  //
  // The old code spread `...(requestId ? { requestId } : {})` — a TRUTHINESS
  // test, so it ALSO dropped an empty-string requestId, which a block can
  // legitimately have minted and be waiting on. Now: whatever STRING the block
  // sent is echoed back verbatim (`''` included), so a reply always correlates.
  //
  // And when the inbound message carried no usable requestId at all, we send a
  // `TOKEN_REFRESH` PUSH instead of a fabricated-id reply — because that is
  // exactly what the message semantically is: a host-initiated token rotation
  // with nothing to correlate to. It reaches the block through the same handler
  // as the H-3 rotation push above (which is the only path that ever actually
  // delivered a token in this case), and it does not put an unanswerable
  // `TOKEN_REFRESH_RESPONSE` on the wire for the SDK to discard.
  //
  // 🔴 PageBlockHost.tsx CARRIES THE SAME LOGIC AND MUST STAY IN STEP. The two
  // hosts register their postMessage handlers by hand and share no bridge, so
  // fixing one leaves half the fleet on the broken shape — each surface has its
  // own browser test for this.
  useEffect(() => {
    const off = onMessage<{ requestId?: string } | undefined>('REQUEST_TOKEN', (raw) => {
      if (!token || !initSentRef.current) return;
      const requestId =
        raw && typeof raw === 'object' && typeof raw.requestId === 'string'
          ? raw.requestId
          : undefined;
      const wrapped = {
        raw: token,
        scopes: grantedScopes,
        expiresAt,
        ...(buzzBudget !== undefined ? { buzzBudget } : {}),
      };
      if (requestId === undefined) {
        send('TOKEN_REFRESH', { token: wrapped });
        return;
      }
      send('TOKEN_REFRESH_RESPONSE', { requestId, token: wrapped });
    });
    return off;
  }, [token, expiresAt, buzzBudget, grantedScopes, send, onMessage]);

  // Init handshake. Start the moment we're ALLOWED to init — token present and
  // the effective-checkpoint query resolved (`isLoading` false; the error path
  // also resolves to false and inits with checkpoint: null, as before). NOT
  // gated on the iframe `load` event: the controller posts BLOCK_INIT
  // immediately and re-posts every INIT_RETRY_INTERVAL_MS until BLOCK_READY,
  // which survives the cached-bundle race where `load` fires before React
  // attaches `onLoad`. The readiness timeout is armed by the controller on
  // start() (NOT inside an `iframeLoaded` gate), so a block that never acks
  // surfaces a `timeout` fallback instead of a silent indefinite skeleton.
  useEffect(() => {
    if (
      !shouldStartInit({
        status,
        hasToken: !!token,
        checkpointLoading: effectiveCheckpointQuery.isLoading,
      })
    ) {
      return;
    }
    if (controllerRef.current) return; // already initing — don't restart timers

    const controller = new IframeInitController({
      sendInit: sendInitOnce,
      readyTimeoutMs: BLOCK_READY_TIMEOUT_MS,
      onReadyTimeout: () => {
        setStatus((current) => (current === 'loading' ? 'timeout' : current));
      },
    });
    controllerRef.current = controller;
    controller.start();

    return () => {
      controller.dispose();
      controllerRef.current = null;
    };
    // sendInitOnce is stable (useCallback over `send`); buildInitPayloadRef
    // carries the freshest payload so we intentionally do NOT re-run on
    // payload-input changes — restarting would reset the readiness timeout.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, status, effectiveCheckpointQuery.isLoading, sendInitOnce]);

  // Independent token-wait timer: catches the case where the iframe loads but
  // the token never resolves (e.g. /api/v1/block-tokens repeatedly 5xx-ing).
  useEffect(() => {
    if (status !== 'loading' || token) return;
    const t = setTimeout(() => {
      setStatus((current) => (current === 'loading' && !token ? 'no_token' : current));
    }, TOKEN_WAIT_TIMEOUT_MS);
    return () => clearTimeout(t);
  }, [status, token]);

  // INVERTED HANDSHAKE: the block announces that its message listener is
  // attached (`BLOCK_HELLO`) and we push BLOCK_INIT in response, instead of
  // relying purely on the blind retry tick to eventually land after the
  // listener exists.
  //
  // 🔴 PURELY ADDITIVE. `IframeInitController` still posts init immediately on
  // start() and re-posts every INIT_RETRY_INTERVAL_MS until BLOCK_READY, and
  // still arms the readiness timeout. A block on an older SDK never sends this
  // message and is served exactly as it is today; a block that announces but
  // never acks still times out. `notifyHello()` is a once-per-controller
  // accelerator (see its doc comment), and a hello arriving before the
  // controller exists is a no-op because `start()` posts init immediately
  // anyway.
  //
  // 🔴 THE RETRY LOOP IS NOT REMOVED AND MUST NOT BE. As of 2026-08-05 NO
  // deployed block sends BLOCK_HELLO (a full enumeration of the 20 live bundles
  // found `BLOCK_HELLO` x0) because the SDK half is merged but unpublished, so
  // the retry loop is currently doing 100% of the work. It stays as the bounded
  // fallback for every block that never announces.
  useEffect(() => {
    const off = onMessage<unknown>('BLOCK_HELLO', () => {
      controllerRef.current?.notifyHello();
    });
    return off;
  }, [onMessage]);

  useEffect(() => {
    const off = onMessage<unknown>('BLOCK_READY', (raw) => {
      // Validate the shape — payload comes from cross-origin iframe code and
      // is functionally untyped. Reject anything that isn't {height?:number}.
      // (`applyHeight` is the value guard: it drops anything non-finite/≤0 and
      // clamps to manifest min/max + HARD_HEIGHT_CEILING + the viewport
      // budget left over after the host chrome.)
      const payload =
        raw && typeof raw === 'object' && 'height' in raw ? (raw as { height?: unknown }) : {};
      // Record the offered height for the ready-transition effect below to apply
      // once React has COMMITTED 'ready'. NOT gated on the current status: H-11 is
      // enforced by that effect's `status === 'ready'` guard, not here (see the
      // ref's comment).
      //
      // When several acks land in one batch the LAST one that CARRIES a height
      // wins — the block's most recent statement of its own handshake height. The
      // `!== undefined` check matters: without it a `BLOCK_READY {height: 640}`
      // followed in the same batch by a bare `BLOCK_READY {}` (or one whose height
      // fails the shape guard) would reset the ref to `undefined` and LOSE a height
      // the old code applied, turning this fix into a regression in that direction.
      if (payload.height !== undefined) pendingReadyHeightRef.current = payload.height;
      setStatus((current) => (current === 'loading' ? 'ready' : current));
      // Block acked — stop re-posting BLOCK_INIT and cancel the readiness
      // timeout. Called UNCONDITIONALLY, not behind a "did this ack win the
      // transition" flag, because that flag is exactly what could not be read
      // reliably (see the effect below). Safe in every state:
      //   - `notifyReady()` is documented-idempotent (→ `stop()`, a no-op once
      //     stopped), so repeat/duplicate acks cost nothing;
      //   - after 'timeout' the controller already stopped itself — no-op;
      //   - after 'no_token' the controller was never created (`shouldStartInit`
      //     requires a token) — the optional chain no-ops;
      //   - after 'fatal' it cancels the retry interval and the readiness
      //     timeout, which is what we WANT while terminal, and it cannot revive
      //     `status`: the only writer here is the guarded updater above, and
      //     `onReadyTimeout` is itself `current === 'loading'`-guarded.
      // So this cannot weaken H-11: the observable content of "don't notify
      // ready" (no height, no `ok` beacon, no status change) is still enforced,
      // and is regression-tested per terminal state.
      //
      // NB this is the FAST path, not the only one: `status` is in the init
      // effect's dep array, so the loading→ready commit re-runs that effect and
      // its cleanup `dispose()`s the controller regardless. Calling notifyReady
      // here just stops the retry loop one render earlier.
      controllerRef.current?.notifyReady();
    });
    return off;
  }, [onMessage]);

  // Analytics Phase 2 + the acked iframe height — the loading→ready COMMIT.
  // Fires once per mount; the `ok` beacon is mutually exclusive with the
  // render-FAILURE beacon below (shared `blockRenderEmittedRef`).
  //
  // 🔴 WHY THIS IS AN EFFECT AND NOT A SIDE EFFECT INSIDE THE BLOCK_READY
  // HANDLER (a real bug this fixes, not a refactor): it used to live inside the
  // handler behind an `appliedReady` flag that the `setStatus` UPDATER set —
  //     let appliedReady = false;
  //     setStatus((current) => { if (current === 'loading') { appliedReady = true; … } });
  //     if (appliedReady) { …notifyReady + applyHeight + sendBlockRender… }
  // — and the in-code comment claimed it could read the transition out of the
  // updater. It cannot. That only works because React *eagerly* evaluates an
  // updater when the fiber has no other pending update (the bail-out
  // optimisation in `dispatchSetState`). As soon as ANY unrelated state update is
  // already queued on THIS component when BLOCK_READY lands, React skips the
  // eager path, the updater runs later during render, `appliedReady` is still
  // false at the `if`, and the WHOLE branch is skipped: the acked height is never
  // applied (the iframe stays pinned at `minHeight` → clipped content or a dead
  // gap) and the impression beacon is silently dropped. This host has such
  // updates in flight in the real world (the `getEffectiveCheckpoint` /
  // `getShowcaseImages` react-query subscriptions resolving, `iframeHeight`
  // itself). Keying off the COMMITTED `status` is immune to batching. Mirrors
  // both the failure-beacon effect below and PR #3457's fix to the sibling
  // PageBlockHost — one problem, one solution, in both hosts.
  useEffect(() => {
    if (status !== 'ready') return;
    if (readyTransitionAppliedRef.current) return;
    readyTransitionAppliedRef.current = true;
    applyHeight(pendingReadyHeightRef.current);
    if (blockRenderEmittedRef.current) return;
    blockRenderEmittedRef.current = true;
    // Fire-and-forget beacon — failures are a no-op (and a harmless no-op until
    // the `blockRenders` ClickHouse table exists).
    sendBlockRender({
      appBlockId: install.appBlockId,
      blockInstanceId: install.blockInstanceId,
      slotId,
    });
  }, [status, applyHeight, install.appBlockId, install.blockInstanceId, slotId]);

  // App Blocks runtime observability — render-FAILURE beacon. The success
  // beacon fires from the loading→ready commit effect above (both guarded by the
  // shared `blockRenderEmittedRef`). Here
  // we fire the mutually-exclusive `error` beacon when the host lands on a
  // terminal-failure state — the iframe never reached BLOCK_READY in time
  // ('timeout'), the block reported a fatal error ('fatal'), or its token never
  // resolved ('no_token'). Sharing the SAME emit-once ref makes ok/error
  // mutually exclusive per mount. Fire-and-forget (beacon swallows failures).
  useEffect(() => {
    if (status !== 'timeout' && status !== 'fatal' && status !== 'no_token') return;
    if (blockRenderEmittedRef.current) return;
    blockRenderEmittedRef.current = true;
    sendBlockRender({
      appBlockId: install.appBlockId,
      blockInstanceId: install.blockInstanceId,
      slotId,
      status: 'error',
      errorClass: status,
    });
  }, [status, install.appBlockId, install.blockInstanceId, slotId]);

  useEffect(() => {
    const off = onMessage<unknown>('RESIZE_IFRAME', (raw) => {
      if (!raw || typeof raw !== 'object' || !('height' in raw)) return;
      // M-7: only honor RESIZE_IFRAME once BLOCK_READY has landed. The iframe
      // is visible-but-non-interactive (pointerEvents:none) before ready and
      // pinned at minHeight, so an early RESIZE would let a pre-ready block
      // push the slot height around before the handshake completes.
      //
      // `readGateStatus()` (not a closed-over `status`) — see its definition: it
      // reads the render-body-updated mirror, so it is current at COMMIT rather
      // than one scheduler task later.
      //
      // NO NACK HERE, deliberately. RESIZE_IFRAME is fire-and-forget: it carries
      // no requestId and there is no host→block reply message for it, so there is
      // nothing to reply TO and no promise to fail fast. Dropping it costs the
      // block one un-honoured height, not a hang.
      if (readGateStatus() !== 'ready') return;
      applyHeight((raw as { height?: unknown }).height);
    });
    return off;
    // `status` is deliberately ABSENT: the handler reads it through
    // `readGateStatus` (a render-body-updated ref) instead of closing over it, so
    // this subscribes ONCE per mount. Re-registering on every status transition is
    // what opened the commit→passive-effect window in the first place.
  }, [onMessage, applyHeight, readGateStatus]);

  useEffect(() => {
    const off = onMessage<unknown>('BLOCK_ERROR', (raw) => {
      if (raw && typeof raw === 'object' && (raw as { fatal?: unknown }).fatal === true) {
        setStatus((current) => (current === 'loading' || current === 'ready' ? 'fatal' : current));
      }
    });
    return off;
  }, [onMessage]);

  // Anonymous conversion: the block (rendered for a logged-out viewer from the
  // scope-free BLOCK_INIT context) asks the host to start the civitai login
  // flow when the user clicks an action that needs auth/money (e.g. Generate).
  // usePostMessage already pins origin + event.source; we additionally gate on
  // status === 'ready' (post-BLOCK_READY) so a pre-handshake block can't pop a
  // login popup before any interaction, matching the OPEN_BUZZ_PURCHASE posture.
  //
  // returnUrl: an untrusted same-origin path the block may supply (must begin
  // with a single '/', no protocol-relative '//', so it can't redirect off-site
  // after login). When absent or unsafe we fall through to the current page.
  useEffect(() => {
    const off = onMessage<{ returnUrl?: unknown } | undefined>('REQUEST_SIGN_IN', (raw) => {
      // `readGateStatus()` (not a closed-over `status`) — see its definition.
      const resolved = resolveRequestSignIn(readGateStatus(), raw);
      // NO NACK HERE, deliberately. REQUEST_SIGN_IN is fire-and-forget: the SDK
      // sends it with `dispatch` (blocks-react 0.39.0 `useRequestSignIn`), the
      // payload is `{ returnUrl? }` with NO requestId, and there is no host→block
      // reply message for it. Nothing to reply to; a drop cannot hang the block —
      // it just silently does nothing, which is precisely why the ROOT-CAUSE half
      // of this fix has to hold for this handler.
      if (resolved == null) return; // not ready — drop (gate centralises the rules)
      // Open the hub login in a popup (replaces the old in-page LoginModal). The host runs at TOP level — not
      // inside the sandboxed block iframe — so the popup works here; on completion it navigates back.
      const here = window.location.pathname + window.location.search + window.location.hash;
      openLoginPopup(resolved.returnUrl ?? here, 'image-gen');
    });
    return off;
    // `status` deliberately absent — see the RESIZE_IFRAME deps note.
  }, [onMessage, readGateStatus]);

  // Lazy consent (A6): the block (rendered in full for a logged-in viewer whose
  // token is missing a consent-gated scope) asks the host to open the consent UI
  // when the user clicks an action that needs that capability (e.g. Generate),
  // instead of a prompt on load. We grant the missing set the MINT computed
  // (`missingScopes` — server-known truth), NOT any scopes the block claims; the
  // gate also pins status === 'ready' so a pre-handshake block can't pop a
  // permission modal before any interaction (same posture as REQUEST_SIGN_IN /
  // OPEN_BUZZ_PURCHASE). On grant we re-mint the token (onConsentGranted →
  // useBlockToken.refresh); the new scopes flow to the iframe via TOKEN_REFRESH
  // and the block retries — there is no host→block reply (fire-and-forget).
  useEffect(() => {
    const off = onMessage<{ scopes?: unknown } | undefined>('REQUEST_CONSENT', () => {
      // `readGateStatus()` (not a closed-over `status`) — see its definition.
      //
      // NO NACK HERE, deliberately. REQUEST_CONSENT is fire-and-forget in both
      // directions: the SDK sends it with `dispatch` (blocks-react 0.39.0
      // `useRequestConsent`), its payload is `{ scopes? }` with NO requestId, and
      // there is no host→block reply message for it — so there is nothing to
      // reply TO and no promise to fail fast. Dropping it cannot hang the block.
      const scopesToGrant = resolveRequestConsent(readGateStatus(), missingScopes ?? []);
      if (scopesToGrant == null) return; // not ready, or nothing missing — drop
      dialogStore.trigger({
        component: BlockConsentModal,
        props: {
          appBlockId: install.appBlockId,
          blockName: install.manifest.name,
          missingScopes: scopesToGrant,
          onGranted: () => {
            onConsentGranted?.();
          },
        },
      });
    });
    return off;
    // `status` deliberately absent — see the RESIZE_IFRAME deps note.
  }, [
    onMessage,
    readGateStatus,
    missingScopes,
    install.appBlockId,
    install.manifest.name,
    onConsentGranted,
  ]);

  // SDK workflow bridge: receive SUBMIT/ESTIMATE/POLL requests from the block,
  // forward to blocks.* tRPC, echo the response back with matching requestId.
  // The block's transport (`sendTypedRequest`) correlates by requestId and
  // 30s-timeouts if we never reply — so every error path MUST still post a
  // response (failure-shape snapshot), not throw upward.
  const submitWorkflowMutation = trpc.blocks.submitWorkflow.useMutation();
  const estimateWorkflowMutation = trpc.blocks.estimateWorkflow.useMutation();
  const pollWorkflowMutation = trpc.blocks.pollWorkflow.useMutation();
  const cancelWorkflowMutation = trpc.blocks.cancelWorkflow.useMutation();
  const getMyBuzzBalanceMutation = trpc.blocks.getMyBuzzBalance.useMutation();

  useEffect(() => {
    const off = onMessage<
      { requestId?: unknown; body?: unknown; idempotencyKey?: unknown } | undefined
    >('SUBMIT_WORKFLOW', async (raw) => {
      if (!raw || typeof raw.requestId !== 'string') return;
      const requestId = raw.requestId;
      // Idempotency (item 2, gen half): forward the OPTIONAL client key so a
      // lost-response retry collapses to one Buzz charge. Host-first: accept it
      // defensively (only a non-empty string) — older SDKs never send it.
      const idempotencyKey =
        typeof raw.idempotencyKey === 'string' && raw.idempotencyKey.length > 0
          ? raw.idempotencyKey
          : undefined;
      try {
        const { snapshot } = await submitWorkflowMutation.mutateAsync({
          blockToken: token,
          // Schema-validated server-side; the host never trusts this shape.
          body: raw.body as never,
          ...(idempotencyKey ? { idempotencyKey } : {}),
        });
        send('WORKFLOW_SUBMITTED', { requestId, snapshot });
      } catch (err) {
        send('WORKFLOW_SUBMITTED', {
          requestId,
          snapshot: failureSnapshot(err),
        });
      }
    });
    return off;
  }, [onMessage, send, token, submitWorkflowMutation]);

  useEffect(() => {
    const off = onMessage<{ requestId?: unknown; body?: unknown } | undefined>(
      'ESTIMATE_WORKFLOW',
      async (raw) => {
        if (!raw || typeof raw.requestId !== 'string') return;
        const requestId = raw.requestId;
        try {
          const { snapshot } = await estimateWorkflowMutation.mutateAsync({
            blockToken: token,
            body: raw.body as never,
          });
          send('ESTIMATE_RESULT', { requestId, snapshot });
        } catch (err) {
          send('ESTIMATE_RESULT', {
            requestId,
            snapshot: failureSnapshot(err),
          });
        }
      }
    );
    return off;
  }, [onMessage, send, token, estimateWorkflowMutation]);

  useEffect(() => {
    const off = onMessage<{ requestId?: unknown; suggestedAmount?: unknown } | undefined>(
      'OPEN_BUZZ_PURCHASE',
      (raw) => {
        // M-BUZZMODAL: gate on BLOCK_READY (+ payload validity). A block can
        // post the instant the iframe loads — before the handshake, while it's
        // still visible-but-non-interactive (pointerEvents:none). Summoning the
        // money-spend modal pre-ready would let an untrusted block nag the user
        // before any interaction. resolveBuzzPurchaseRequest returns null
        // when status !== 'ready' or the payload is bad.
        //
        // `readGateStatus()` (not a closed-over `status`) — see its definition.
        const requestId = resolveBuzzPurchaseRequest(readGateStatus(), raw);
        if (requestId == null || !raw) {
          // NEVER HANG. `resolveBuzzPurchaseRequest` returns null for TWO
          // different reasons, and they need different answers:
          //
          //   • malformed payload (no string requestId) — UNREPLIABLE. There is
          //     no id to thread a reply back on, so it can only be dropped.
          //   • host not ready — REPLIABLE, and it must be replied to. The block
          //     is awaiting BUZZ_PURCHASE_RESULT on a promise that rejects only
          //     at the SDK's 30s default request timeout (blocks-react 0.39.0,
          //     `DEFAULT_REQUEST_TIMEOUT_MS`), so a silent drop costs the user's
          //     click plus half a minute of nothing happening.
          //
          // `purchased: false` is exactly what the modal's own onClose sends for
          // a dismissed purchase below, and exactly what the SDK's
          // `useBuzzPurchase` reads as "no purchase happened". Refusing is
          // unchanged — no modal opens, nothing is charged; the block just finds
          // out now instead of in 30 seconds.
          //
          // 🔴 NOT AN UNCONDITIONAL IMPROVEMENT, AND THE HONEST VERSION IS
          // WORTH THE THREE LINES. `usePostMessage` dedups INBOUND messages by
          // `payload.requestId` for DEDUP_WINDOW_MS = 5000 (usePostMessage.ts),
          // and it does so BEFORE any handler runs. So a block that reacts to
          // this `purchased: false` by retrying with the SAME requestId inside
          // five seconds is swallowed by the transport and hangs exactly as it
          // did before — the NACK converts a guaranteed hang into a fast
          // failure only for a block that retries with a FRESH id (or after the
          // window). Deliberately not changed here: the dedup is a replay
          // defense, and relaxing it for one message type would be a wider
          // change than this fix earns.
          //
          // The "30 seconds" above is the SDK-side request timeout carried over
          // from #3680's reasoning. It is NOT verifiable in this repo:
          // `@civitai/blocks-react` is not a dependency (0 hits in
          // pnpm-lock.yaml; the installed SDK is `@civitai/app-sdk@0.14.0`,
          // which implements neither OPEN_BUZZ_PURCHASE nor a request timeout).
          // Treat it as the reasonable inference it is, not a measurement.
          //
          // `!raw` is implied by requestId != null; the compound condition also
          // narrows for TS.
          if (raw && typeof raw.requestId === 'string' && raw.requestId.length > 0) {
            send('BUZZ_PURCHASE_RESULT', { requestId: raw.requestId, purchased: false });
          }
          return;
        }
        const rawAmount =
          typeof raw.suggestedAmount === 'number' && Number.isFinite(raw.suggestedAmount)
            ? raw.suggestedAmount
            : undefined;
        // Floor + clamp into [0, cap]; reject NaN/negative implicitly via
        // Number.isFinite above. The modal accepts undefined for "no
        // suggestion" so the user picks freely.
        const amount =
          rawAmount != null
            ? Math.min(Math.max(Math.floor(rawAmount), 0), BUZZ_PURCHASE_AMOUNT_CAP)
            : undefined;
        // Mutable flag flipped by onPurchaseSuccess; onClose reads it to
        // decide which result to post. The modal calls dialog.onClose first
        // and then onPurchaseSuccess after a successful purchase — but our
        // onClose fires last because it's tied to the dialog teardown, so
        // by the time it runs the flag reflects the final state.
        let purchased = false;
        // Derive attribution from the install context. The iframe never
        // supplies these fields itself — fabricating them server-side
        // (via props) is the only attribution path a malicious block
        // can't forge. Scope is resolved from the blockInstanceId
        // prefix; null means the substrate handed us an instanceId we
        // don't recognise, in which case we skip attribution and the
        // webhook treats it as a regular buzz purchase. Defensive — no
        // observed mints today produce an unknown prefix.
        const scope = deriveScopeFromInstanceId(install.blockInstanceId);
        const attribution = scope
          ? {
              appId: install.appId,
              appBlockId: install.appBlockId,
              blockInstanceId: install.blockInstanceId,
              scope,
              modelId: typeof modelCtx.modelId === 'number' ? modelCtx.modelId : undefined,
              // FIN-1: carry the slot so the server can re-validate the
              // instance via resolveBlockInstance (needs modelId + slotId).
              // Client-supplied + untrusted — a wrong slot just fails to
              // resolve server-side and the attribution is stripped.
              slotId: typeof modelCtx.slotId === 'string' ? modelCtx.slotId : undefined,
            }
          : undefined;
        dialogStore.trigger<BuyBuzzModalProps>({
          // Per-request id so multiple OPEN_BUZZ_PURCHASE calls don't dedup
          // against each other in the dialog store's exists-check.
          id: `block-buy-buzz-${requestId}`,
          component: BuyBuzzModal,
          props: {
            minBuzzAmount: amount,
            attribution,
            onPurchaseSuccess: () => {
              purchased = true;
            },
          },
          options: {
            onClose: () => {
              send('BUZZ_PURCHASE_RESULT', { requestId, purchased });
            },
          },
        });
      }
    );
    return off;
    // `status` deliberately absent — see the RESIZE_IFRAME deps note.
    //
    // `modelCtx.slotId` IS present, and it was NOT before: the attribution branch
    // above reads it, so omitting it was a stale-closure bug of the same family as
    // the one this change is about. Unreachable today — BlockSlot re-keys this
    // subtree on (slotId, entityType, entityId), so a slotId change remounts the
    // host rather than re-rendering it — but the omission was not load-bearing and
    // silently preserving it while rewriting this array would be inheriting a bug
    // on purpose.
  }, [
    onMessage,
    send,
    readGateStatus,
    install.appId,
    install.appBlockId,
    install.blockInstanceId,
    modelCtx.modelId,
    modelCtx.slotId,
  ]);

  // Checkpoint picker: the block fires OPEN_CHECKPOINT_PICKER with the
  // ecosystem group (e.g. 'Flux1') it wants restricted to. We open the
  // platform's existing ResourceSelectModal filtered to Checkpoints in that
  // family, then post the selection back via CHECKPOINT_PICKER_RESULT.
  // Empty `selected` means the user closed without picking — the block's
  // SDK promise resolves to `{ selected: undefined }`.
  useEffect(() => {
    const off = onMessage<
      { requestId?: unknown; baseModelGroup?: unknown; currentVersionId?: unknown } | undefined
    >('OPEN_CHECKPOINT_PICKER', (raw) => {
      if (!raw || typeof raw.requestId !== 'string') return;
      const requestId = raw.requestId;
      // The block may send either an ecosystem key ('Flux1') or a baseModel
      // name ('Flux.1 D'). Normalize through getBaseModelGroup — it accepts
      // both forms and returns the ecosystem key, which is what
      // getBaseModelsByGroup expects. Empty filter → no checkpoints at all
      // rather than all checkpoints, since "all" includes incompatible
      // families that would 400 at submit.
      const groupKey =
        typeof raw.baseModelGroup === 'string' ? getBaseModelGroup(raw.baseModelGroup) : null;
      const baseModels = groupKey ? getBaseModelsByGroup(groupKey) : [];
      let answered = false;
      // MEDIUM-2 (deferred — see PageBlockHost OPEN_RESOURCE_PICKER for the full
      // rationale): the modal's NSFW filtering inherits the SITE-WIDE browsing
      // level (blue = mature), so on a SFW (blue/green) block the picker UI can
      // still surface mature checkpoints even though generation is SFW-clamped.
      // Not an iframe leak (CHECKPOINT_PICKER_RESULT is name/id-only and every
      // pick is re-gated SFW server-side at submit). `ResourceSelectOptions`
      // exposes no browsing-level/sfwOnly constraint; wiring one would mean
      // modifying the shared ResourceSelectModal internals — deferred follow-up.
      openResourceSelectModal({
        title: 'Choose a checkpoint',
        options: {
          canGenerate: true,
          resources: [{ type: 'Checkpoint', baseModels }],
        },
        onSelect: (resource) => {
          answered = true;
          send('CHECKPOINT_PICKER_RESULT', {
            requestId,
            selected: {
              // GenerationResource.id is the modelVersionId at the wire.
              versionId: resource.id,
              modelId: resource.model.id,
              modelName: resource.model.name,
              versionName: resource.name,
              baseModel: resource.baseModel,
            },
          });
        },
        onClose: () => {
          // Dialog dismiss fires after onSelect when the user picks (the
          // modal closes itself); only emit the "closed without picking"
          // result if onSelect never ran. The 30s SDK timeout otherwise
          // races us either way — answered=true short-circuits.
          if (answered) return;
          send('CHECKPOINT_PICKER_RESULT', { requestId });
        },
      });
    });
    return off;
  }, [onMessage, send]);

  // Persist the viewer's chosen checkpoint via blocks.updateUserSettings.
  // The host owns the auth — the block never touches the block_user_settings
  // row directly. Setting versionId: null clears the override.
  const updateUserSettingsMutation = trpc.blocks.updateUserSettings.useMutation();
  useEffect(() => {
    const off = onMessage<{ requestId?: unknown; versionId?: unknown } | undefined>(
      'SET_USER_CHECKPOINT',
      async (raw) => {
        if (!raw || typeof raw.requestId !== 'string') return;
        const requestId = raw.requestId;
        const versionId =
          raw.versionId === null
            ? null
            : typeof raw.versionId === 'number'
            ? raw.versionId
            : undefined;
        if (versionId === undefined) {
          send('USER_CHECKPOINT_SET', {
            requestId,
            ok: false,
            error: 'versionId must be a number or null',
          });
          return;
        }
        try {
          await updateUserSettingsMutation.mutateAsync({
            blockToken: token,
            settings: { checkpoint_version_id: versionId },
          });
          // Refetch the effective checkpoint so a subsequent BLOCK_INIT
          // (after a hot remount) reflects the new value without a hard
          // page reload.
          effectiveCheckpointQuery.refetch();
          send('USER_CHECKPOINT_SET', { requestId, ok: true });
        } catch (err) {
          send('USER_CHECKPOINT_SET', {
            requestId,
            ok: false,
            error: err instanceof Error ? err.message : 'unknown',
          });
        }
      }
    );
    return off;
  }, [onMessage, send, token, updateUserSettingsMutation, effectiveCheckpointQuery]);

  useEffect(() => {
    const off = onMessage<{ requestId?: unknown; workflowId?: unknown } | undefined>(
      'POLL_WORKFLOW',
      async (raw) => {
        if (
          !raw ||
          typeof raw.requestId !== 'string' ||
          typeof raw.workflowId !== 'string' ||
          raw.workflowId.length === 0
        ) {
          return;
        }
        const requestId = raw.requestId;
        try {
          const { snapshot } = await pollWorkflowMutation.mutateAsync({
            blockToken: token,
            workflowId: raw.workflowId,
          });
          send('WORKFLOW_STATUS', { requestId, snapshot });
        } catch (err) {
          send('WORKFLOW_STATUS', {
            requestId,
            snapshot: failureSnapshot(err),
          });
        }
      }
    );
    return off;
  }, [onMessage, send, token, pollWorkflowMutation]);

  // CANCEL_WORKFLOW → blocks.cancelWorkflow (real server-side cancel on the
  // orchestrator). Mirrors the POLL_WORKFLOW handler; ownership is enforced
  // server-side by the viewer's orchestrator token. Echo back the canceled
  // snapshot (or a failure snapshot) on the matching requestId.
  useEffect(() => {
    const off = onMessage<{ requestId?: unknown; workflowId?: unknown } | undefined>(
      'CANCEL_WORKFLOW',
      async (raw) => {
        if (
          !raw ||
          typeof raw.requestId !== 'string' ||
          typeof raw.workflowId !== 'string' ||
          raw.workflowId.length === 0
        ) {
          return;
        }
        const requestId = raw.requestId;
        try {
          const { snapshot } = await cancelWorkflowMutation.mutateAsync({
            blockToken: token,
            workflowId: raw.workflowId,
          });
          send('WORKFLOW_CANCELED', { requestId, snapshot });
        } catch (err) {
          send('WORKFLOW_CANCELED', {
            requestId,
            snapshot: failureSnapshot(err),
          });
        }
      }
    );
    return off;
  }, [onMessage, send, token, cancelWorkflowMutation]);

  // GET_BUZZ_BALANCE → blocks.getMyBuzzBalance → BUZZ_BALANCE_RESULT. Backs the
  // SDK `useBuzzBalance()` hook + the account-picker so a money block can show
  // which wallet (blue/green/yellow) a generation draws from. Host-MEDIATED: the
  // balance is derived from the token's SELF-BOUND `sub` server-side, never
  // client input. MUTATION (not query) so the block JWT rides in the POST body,
  // not a replayable ?input=… URL. REQUEST-style ⇒ every path MUST reply or the
  // block hangs; errors come back as `error: <string>` (mirrors the storage
  // handlers) rather than thrown upward.
  useEffect(() => {
    const off = onMessage<{ requestId?: unknown } | undefined>('GET_BUZZ_BALANCE', async (raw) => {
      if (!raw || typeof raw.requestId !== 'string') return;
      const requestId = raw.requestId;
      // NB: unlike PageBlockHost's `token: string | null`, IframeHost's `token` is non-null, so there is deliberately no explicit null-token guard here — an empty token just falls through to the router's `z.string().min(1)` reject → the `catch` → error reply (still no hang).
      try {
        const balance = await getMyBuzzBalanceMutation.mutateAsync({ blockToken: token });
        send('BUZZ_BALANCE_RESULT', { requestId, balance });
      } catch (err) {
        send('BUZZ_BALANCE_RESULT', {
          requestId,
          error: err instanceof Error ? err.message : 'unknown',
        });
      }
    });
    return off;
  }, [onMessage, send, token, getMyBuzzBalanceMutation]);

  // App Blocks KV datastore (W4-v0). Five host-mediated handlers; the
  // iframe never sees the apps DB credentials. Every reply MUST come
  // back with the same requestId — the block-side hook times out at
  // 30s otherwise. Errors are reported as `error: <string>` on the
  // result payload so the hook can reject; we never throw upward and
  // strand the bridge.
  const trpcUtils = trpc.useUtils();
  const storageSetMutation = trpc.apps.storage.set.useMutation();
  const storageDeleteMutation = trpc.apps.storage.delete.useMutation();

  useEffect(() => {
    const off = onMessage<{ requestId?: unknown; key?: unknown } | undefined>(
      'APP_STORAGE_GET',
      async (raw) => {
        if (!raw || typeof raw.requestId !== 'string' || typeof raw.key !== 'string') return;
        const requestId = raw.requestId;
        try {
          const result = await trpcUtils.apps.storage.get.fetch(
            {
              blockToken: token,
              key: raw.key,
            },
            BLOCK_STORAGE_READ_OPTS
          );
          send('APP_STORAGE_GET_RESULT', { requestId, value: result.value });
        } catch (err) {
          send('APP_STORAGE_GET_RESULT', {
            requestId,
            value: null,
            error: storageErrorMessage(err),
          });
        }
      }
    );
    return off;
  }, [onMessage, send, token, trpcUtils]);

  useEffect(() => {
    const off = onMessage<{ requestId?: unknown; key?: unknown; value?: unknown } | undefined>(
      'APP_STORAGE_SET',
      async (raw) => {
        if (!raw || typeof raw.requestId !== 'string' || typeof raw.key !== 'string') return;
        const requestId = raw.requestId;
        try {
          const result = await storageSetMutation.mutateAsync({
            blockToken: token,
            key: raw.key,
            value: raw.value,
          });
          // Invalidate BEFORE replying: the block may re-read the moment this
          // reply resolves. See blockStorageCache.ts (ordering is load-bearing).
          await invalidatePrivateStorageReads(trpcUtils);
          send('APP_STORAGE_SET_RESULT', {
            requestId,
            ok: true,
            sizeBytes: result.sizeBytes,
          });
        } catch (err) {
          send('APP_STORAGE_SET_RESULT', {
            requestId,
            ok: false,
            error: storageErrorMessage(err),
          });
        }
      }
    );
    return off;
  }, [onMessage, send, token, trpcUtils, storageSetMutation]);

  useEffect(() => {
    const off = onMessage<{ requestId?: unknown; key?: unknown } | undefined>(
      'APP_STORAGE_DELETE',
      async (raw) => {
        if (!raw || typeof raw.requestId !== 'string' || typeof raw.key !== 'string') return;
        const requestId = raw.requestId;
        try {
          const result = await storageDeleteMutation.mutateAsync({
            blockToken: token,
            key: raw.key,
          });
          // Invalidate BEFORE replying: the block may re-read the moment this
          // reply resolves. See blockStorageCache.ts (ordering is load-bearing).
          await invalidatePrivateStorageReads(trpcUtils);
          send('APP_STORAGE_DELETE_RESULT', {
            requestId,
            ok: true,
            deleted: result.deleted,
          });
        } catch (err) {
          send('APP_STORAGE_DELETE_RESULT', {
            requestId,
            ok: false,
            deleted: false,
            error: storageErrorMessage(err),
          });
        }
      }
    );
    return off;
  }, [onMessage, send, token, trpcUtils, storageDeleteMutation]);

  useEffect(() => {
    const off = onMessage<
      | {
          requestId?: unknown;
          prefix?: unknown;
          limit?: unknown;
          cursor?: unknown;
        }
      | undefined
    >('APP_STORAGE_LIST', async (raw) => {
      if (!raw || typeof raw.requestId !== 'string') return;
      const requestId = raw.requestId;
      try {
        const prefix = typeof raw.prefix === 'string' ? raw.prefix : undefined;
        const limit =
          typeof raw.limit === 'number' && Number.isFinite(raw.limit)
            ? Math.min(Math.max(Math.floor(raw.limit), 1), 200)
            : 50;
        const cursor = typeof raw.cursor === 'string' ? raw.cursor : undefined;
        const result = await trpcUtils.apps.storage.list.fetch(
          {
            blockToken: token,
            prefix,
            limit,
            cursor,
          },
          BLOCK_STORAGE_READ_OPTS
        );
        send('APP_STORAGE_LIST_RESULT', {
          requestId,
          keys: result.keys.map((k) => ({
            key: k.key,
            updatedAt:
              k.updatedAt instanceof Date ? k.updatedAt.toISOString() : String(k.updatedAt),
          })),
          nextCursor: result.nextCursor,
        });
      } catch (err) {
        send('APP_STORAGE_LIST_RESULT', {
          requestId,
          keys: [],
          error: storageErrorMessage(err),
        });
      }
    });
    return off;
  }, [onMessage, send, token, trpcUtils]);

  useEffect(() => {
    const off = onMessage<{ requestId?: unknown } | undefined>('APP_STORAGE_QUOTA', async (raw) => {
      if (!raw || typeof raw.requestId !== 'string') return;
      const requestId = raw.requestId;
      try {
        const result = await trpcUtils.apps.storage.getQuota.fetch(
          { blockToken: token },
          BLOCK_STORAGE_READ_OPTS
        );
        send('APP_STORAGE_QUOTA_RESULT', {
          requestId,
          usedBytes: result.usedBytes,
          rowCount: result.rowCount,
          limitBytes: result.limitBytes,
          limitRows: result.limitRows,
        });
      } catch (err) {
        send('APP_STORAGE_QUOTA_RESULT', {
          requestId,
          usedBytes: 0,
          rowCount: 0,
          limitBytes: 0,
          limitRows: 0,
          error: storageErrorMessage(err),
        });
      }
    });
    return off;
  }, [onMessage, send, token, trpcUtils]);

  // App Blocks SHARED (cross-user / app-global) storage bridge (Phase 2b). The
  // public-write sibling of the per-user KV handlers above — a block token that
  // carries `apps:storage:shared:*` drives the shared datastore via the SDK
  // shared-storage hook (SHARED_LIST / GET_COUNT / GET_COUNTS / APPEND / VOTE /
  // UNVOTE / WITHDRAW → SHARED_*_RESULT). The host injects the `token` it holds as
  // `blockToken` (never trusts a message token); reads go through
  // trpc.useUtils().apps.shared.*.fetch, writes through the useMutation hooks; the
  // server enforces scope + flag + trust gate (resolveSharedContext). Every reply
  // carries the same requestId on success AND error so the block never hangs.
  const sharedAppendMutation = trpc.apps.shared.append.useMutation();
  const sharedUpdateMutation = trpc.apps.shared.update.useMutation();
  const sharedVoteMutation = trpc.apps.shared.vote.useMutation();
  const sharedUnvoteMutation = trpc.apps.shared.unvote.useMutation();
  const sharedWithdrawMutation = trpc.apps.shared.withdraw.useMutation();
  const sharedReportMutation = trpc.apps.shared.report.useMutation();
  // Collection follow/unfollow bridge (SET_COLLECTION_FOLLOW). SESSION-authed
  // (protectedProcedure) — these are the SAME procedures the site's own follow
  // button calls, so the handler self-binds to `ctx.user.id` server-side and
  // reuses `addContributorToCollection` / `removeContributorFromCollection`
  // verbatim. The block token is deliberately NOT involved: the point of this
  // bridge is that a block needs no `collections:write:self` scope.
  const followCollectionMutation = trpc.collection.follow.useMutation();
  const unfollowCollectionMutation = trpc.collection.unfollow.useMutation();

  useEffect(() => {
    const off = onMessage<
      | {
          requestId?: unknown;
          prefix?: unknown;
          limit?: unknown;
          cursor?: unknown;
        }
      | undefined
    >('SHARED_LIST', async (raw) => {
      if (!raw || typeof raw.requestId !== 'string') return;
      const requestId = raw.requestId;
      try {
        const prefix = typeof raw.prefix === 'string' ? raw.prefix : undefined;
        const limit =
          typeof raw.limit === 'number' && Number.isFinite(raw.limit)
            ? Math.min(Math.max(Math.floor(raw.limit), 1), 100)
            : 50;
        const cursor = typeof raw.cursor === 'string' ? raw.cursor : undefined;
        const result = await trpcUtils.apps.shared.list.fetch(
          {
            blockToken: token,
            prefix,
            limit,
            cursor,
          },
          BLOCK_STORAGE_READ_OPTS
        );
        send('SHARED_LIST_RESULT', {
          requestId,
          items: result.items.map((it) => ({
            key: it.key,
            authorUserId: it.authorUserId,
            value: it.value,
            count: it.count,
            createdAt:
              it.createdAt instanceof Date ? it.createdAt.toISOString() : String(it.createdAt),
            updatedAt:
              it.updatedAt instanceof Date ? it.updatedAt.toISOString() : String(it.updatedAt),
            // item 3: pass the per-viewer vote flag straight through (no logic).
            viewerVoted: it.viewerVoted,
          })),
          nextCursor: result.nextCursor,
        });
      } catch (err) {
        send('SHARED_LIST_RESULT', { requestId, error: storageErrorMessage(err) });
      }
    });
    return off;
  }, [onMessage, send, token, trpcUtils]);

  useEffect(() => {
    const off = onMessage<{ requestId?: unknown; key?: unknown } | undefined>(
      'SHARED_GET_COUNT',
      async (raw) => {
        if (!raw || typeof raw.requestId !== 'string' || typeof raw.key !== 'string') return;
        const requestId = raw.requestId;
        try {
          const result = await trpcUtils.apps.shared.getCount.fetch(
            {
              blockToken: token,
              key: raw.key,
            },
            BLOCK_STORAGE_READ_OPTS
          );
          send('SHARED_GET_COUNT_RESULT', { requestId, count: result.count });
        } catch (err) {
          send('SHARED_GET_COUNT_RESULT', { requestId, error: storageErrorMessage(err) });
        }
      }
    );
    return off;
  }, [onMessage, send, token, trpcUtils]);

  useEffect(() => {
    const off = onMessage<{ requestId?: unknown; keys?: unknown } | undefined>(
      'SHARED_GET_COUNTS',
      async (raw) => {
        if (!raw || typeof raw.requestId !== 'string' || !Array.isArray(raw.keys)) return;
        const requestId = raw.requestId;
        try {
          const result = await trpcUtils.apps.shared.getCounts.fetch(
            {
              blockToken: token,
              keys: raw.keys as string[],
            },
            BLOCK_STORAGE_READ_OPTS
          );
          send('SHARED_GET_COUNTS_RESULT', { requestId, counts: result.counts });
        } catch (err) {
          send('SHARED_GET_COUNTS_RESULT', { requestId, error: storageErrorMessage(err) });
        }
      }
    );
    return off;
  }, [onMessage, send, token, trpcUtils]);

  useEffect(() => {
    const off = onMessage<{ requestId?: unknown; value?: unknown } | undefined>(
      'SHARED_APPEND',
      async (raw) => {
        if (
          !raw ||
          typeof raw.requestId !== 'string' ||
          typeof raw.value !== 'object' ||
          raw.value === null
        )
          return;
        const requestId = raw.requestId;
        try {
          const result = await sharedAppendMutation.mutateAsync({
            blockToken: token,
            value: raw.value as { title: string; body?: string },
          });
          // Invalidate BEFORE replying: the block may re-read the moment this
          // reply resolves. See blockStorageCache.ts (ordering is load-bearing).
          await invalidateSharedStorageReads(trpcUtils);
          send('SHARED_APPEND_RESULT', { requestId, key: result.key });
        } catch (err) {
          send('SHARED_APPEND_RESULT', { requestId, error: storageErrorMessage(err) });
        }
      }
    );
    return off;
  }, [onMessage, send, token, trpcUtils, sharedAppendMutation]);

  // SHARED_UPDATE → apps.shared.update → SHARED_UPDATE_RESULT (author-scoped
  // in-place edit; #3146). Reply is `{ ok, error? }` (SHARED_WITHDRAW-style, NOT
  // SHARED_APPEND's `{ key }`) — the SDK hook rejects on `!ok || error !== undefined`
  // and isValidSharedUpdateResult accepts an error reply whether or not it carries
  // `ok` (every `{ ok, error }` validator early-accepts on a PRESENT `error`), so
  // an error reply is never dropped. Both paths still send `ok` because it is the
  // clearer signal, NOT because omitting it would hang.
  useEffect(() => {
    const off = onMessage<{ requestId?: unknown; key?: unknown; value?: unknown } | undefined>(
      'SHARED_UPDATE',
      async (raw) => {
        if (
          !raw ||
          typeof raw.requestId !== 'string' ||
          typeof raw.key !== 'string' ||
          typeof raw.value !== 'object' ||
          raw.value === null
        )
          return;
        const requestId = raw.requestId;
        try {
          await sharedUpdateMutation.mutateAsync({
            blockToken: token,
            key: raw.key,
            value: raw.value as { title: string; body?: string },
          });
          // Invalidate BEFORE replying: the block may re-read the moment this
          // reply resolves. See blockStorageCache.ts (ordering is load-bearing).
          await invalidateSharedStorageReads(trpcUtils);
          send('SHARED_UPDATE_RESULT', { requestId, ok: true });
        } catch (err) {
          send('SHARED_UPDATE_RESULT', { requestId, ok: false, error: storageErrorMessage(err) });
        }
      }
    );
    return off;
  }, [onMessage, send, token, trpcUtils, sharedUpdateMutation]);

  useEffect(() => {
    const off = onMessage<{ requestId?: unknown; key?: unknown } | undefined>(
      'SHARED_VOTE',
      async (raw) => {
        if (!raw || typeof raw.requestId !== 'string' || typeof raw.key !== 'string') return;
        const requestId = raw.requestId;
        try {
          const result = await sharedVoteMutation.mutateAsync({ blockToken: token, key: raw.key });
          // Invalidate BEFORE replying: the block may re-read the moment this
          // reply resolves. See blockStorageCache.ts (ordering is load-bearing).
          await invalidateSharedStorageReads(trpcUtils);
          send('SHARED_VOTE_RESULT', { requestId, count: result.count });
        } catch (err) {
          send('SHARED_VOTE_RESULT', { requestId, error: storageErrorMessage(err) });
        }
      }
    );
    return off;
  }, [onMessage, send, token, trpcUtils, sharedVoteMutation]);

  useEffect(() => {
    const off = onMessage<{ requestId?: unknown; key?: unknown } | undefined>(
      'SHARED_UNVOTE',
      async (raw) => {
        if (!raw || typeof raw.requestId !== 'string' || typeof raw.key !== 'string') return;
        const requestId = raw.requestId;
        try {
          const result = await sharedUnvoteMutation.mutateAsync({
            blockToken: token,
            key: raw.key,
          });
          // Invalidate BEFORE replying: the block may re-read the moment this
          // reply resolves. See blockStorageCache.ts (ordering is load-bearing).
          await invalidateSharedStorageReads(trpcUtils);
          send('SHARED_UNVOTE_RESULT', { requestId, count: result.count });
        } catch (err) {
          send('SHARED_UNVOTE_RESULT', { requestId, error: storageErrorMessage(err) });
        }
      }
    );
    return off;
  }, [onMessage, send, token, trpcUtils, sharedUnvoteMutation]);

  useEffect(() => {
    const off = onMessage<{ requestId?: unknown; key?: unknown } | undefined>(
      'SHARED_WITHDRAW',
      async (raw) => {
        if (!raw || typeof raw.requestId !== 'string' || typeof raw.key !== 'string') return;
        const requestId = raw.requestId;
        try {
          const result = await sharedWithdrawMutation.mutateAsync({
            blockToken: token,
            key: raw.key,
          });
          // Invalidate BEFORE replying: the block may re-read the moment this
          // reply resolves. See blockStorageCache.ts (ordering is load-bearing).
          await invalidateSharedStorageReads(trpcUtils);
          send('SHARED_WITHDRAW_RESULT', { requestId, ok: result.ok, deleted: result.deleted });
        } catch (err) {
          send('SHARED_WITHDRAW_RESULT', { requestId, error: storageErrorMessage(err) });
        }
      }
    );
    return off;
  }, [onMessage, send, token, trpcUtils, sharedWithdrawMutation]);

  // SHARED_GET → apps.shared.get → SHARED_GET_RESULT (single-row deep-link fetch).
  // Mirrors SHARED_LIST's item mapping (createdAt/updatedAt → ISO; additive
  // viewerVoted passes through); a missing/hidden row comes back `item: null`.
  useEffect(() => {
    const off = onMessage<{ requestId?: unknown; key?: unknown } | undefined>(
      'SHARED_GET',
      async (raw) => {
        if (!raw || typeof raw.requestId !== 'string' || typeof raw.key !== 'string') return;
        const requestId = raw.requestId;
        try {
          const result = await trpcUtils.apps.shared.get.fetch(
            { blockToken: token, key: raw.key },
            BLOCK_STORAGE_READ_OPTS
          );
          const it = result.item;
          send('SHARED_GET_RESULT', {
            requestId,
            item: it
              ? {
                  key: it.key,
                  authorUserId: it.authorUserId,
                  value: it.value,
                  count: it.count,
                  createdAt:
                    it.createdAt instanceof Date
                      ? it.createdAt.toISOString()
                      : String(it.createdAt),
                  updatedAt:
                    it.updatedAt instanceof Date
                      ? it.updatedAt.toISOString()
                      : String(it.updatedAt),
                  viewerVoted: it.viewerVoted,
                }
              : null,
          });
        } catch (err) {
          send('SHARED_GET_RESULT', { requestId, item: null, error: storageErrorMessage(err) });
        }
      }
    );
    return off;
  }, [onMessage, send, token, trpcUtils]);

  // SHARED_REPORT → apps.shared.report → SHARED_REPORT_RESULT. User reports a
  // posted row for mod review (server trust-gates + rate-limits + files it).
  // Reply is SHARED_WITHDRAW-style `{ ok, error? }`. The SDK accepts an error reply
  // whether or not it carries `ok` (every `{ ok, error }` validator early-accepts on
  // a PRESENT `error`), so we send `ok: false` because it is the clearer signal, NOT
  // because omitting it would hang.
  useEffect(() => {
    const off = onMessage<{ requestId?: unknown; key?: unknown; reason?: unknown } | undefined>(
      'SHARED_REPORT',
      async (raw) => {
        if (!raw || typeof raw.requestId !== 'string' || typeof raw.key !== 'string') return;
        const requestId = raw.requestId;
        const reason = typeof raw.reason === 'string' ? raw.reason : undefined;
        try {
          await sharedReportMutation.mutateAsync({ blockToken: token, key: raw.key, reason });
          // Invalidate BEFORE replying: the block may re-read the moment this
          // reply resolves. See blockStorageCache.ts (ordering is load-bearing).
          await invalidateSharedStorageReads(trpcUtils);
          send('SHARED_REPORT_RESULT', { requestId, ok: true });
        } catch (err) {
          send('SHARED_REPORT_RESULT', { requestId, ok: false, error: storageErrorMessage(err) });
        }
      }
    );
    return off;
  }, [onMessage, send, token, trpcUtils, sharedReportMutation]);

  // ── SET_COLLECTION_FOLLOW → COLLECTION_FOLLOW_RESULT ────────────────────────
  //
  // A block asks the host to follow / unfollow a collection for the viewer. The
  // decision layer is SHARED with PageBlockHost (`collectionFollowGate.ts`) and
  // carries the full rationale; the only thing this host contributes is its own
  // signed-in signal (`currentUser`). There is no mod-review sandbox on the model
  // slot, so `reviewNack` is constant false here.
  //
  // 🔴 THE CONSENT BOUNDARY IS THE CONFIRM CLICK. This bridge exists so a block
  // no longer needs the `collections:write:self` scope, which was the viewer's
  // consent step on the HTTP path. The replacement is host chrome the sandboxed
  // iframe cannot fake or restyle: NOTHING is written until the viewer clicks
  // through `ConfirmDialog`. Do not "simplify" this by calling the mutation
  // directly — that silently converts a consented action into an unconsented one.
  //
  // REQUEST-style ⇒ every terminal path (refusal / cancel / success / error)
  // MUST reply exactly once or the block hangs to its SDK timeout; the `settled`
  // latch guards a double-reply. Only a payload with no usable requestId is
  // dropped — there is nothing to reply to.
  useEffect(() => {
    const off = onMessage<unknown>('SET_COLLECTION_FOLLOW', (raw) => {
      const gate = resolveCollectionFollowRequest({
        raw,
        signedIn: currentUser?.id != null,
        // The model slot has no review sandbox (pending apps are reviewed on the
        // page host), so there is nothing to NACK for here.
        reviewNack: false,
      });
      if (gate.kind === 'drop') return;
      if (gate.kind === 'refuse') {
        send('COLLECTION_FOLLOW_RESULT', { requestId: gate.requestId, error: gate.error });
        return;
      }
      const { requestId, collectionId, follow } = gate.request;
      let settled = false;
      const reply = (payload: Record<string, unknown>) => {
        if (settled) return;
        settled = true;
        send('COLLECTION_FOLLOW_RESULT', { requestId, ...payload });
      };
      const copy = buildCollectionFollowConsentCopy({ follow, appName: install.manifest.name });
      dialogStore.trigger({
        component: ConfirmDialog,
        props: {
          title: copy.title,
          message: copy.message,
          labels: { confirm: copy.confirmLabel, cancel: 'Cancel' },
          confirmProps: { color: 'blue' },
          onConfirm: async () => {
            try {
              // Self-bound server-side: the handlers pass `ctx.user.id` as BOTH
              // actor and target, so `collectionId` is the ONLY thing the block
              // influences.
              if (follow) await followCollectionMutation.mutateAsync({ collectionId });
              else await unfollowCollectionMutation.mutateAsync({ collectionId });
              reply({ result: { collectionId, followed: follow } });
            } catch (err) {
              // FORBIDDEN from the collection services (e.g. a private
              // collection this viewer may not follow) lands here as a message,
              // never as a hang.
              reply({ error: err instanceof Error ? err.message : 'unknown' });
            }
          },
          // Dismiss (Cancel / X / escape) = consent DECLINED. Settle the block's
          // promise explicitly rather than leaving it to time out.
          onCancel: () => reply({ error: 'declined' }),
        },
      });
    });
    return off;
  }, [
    onMessage,
    send,
    currentUser,
    install.manifest.name,
    followCollectionMutation,
    unfollowCollectionMutation,
  ]);

  useEffect(() => {
    if (status !== 'ready') return;
    const handler = () => {
      if (document.visibilityState === 'visible') send('RESUME');
      else send('SUSPEND');
    };
    document.addEventListener('visibilitychange', handler);
    return () => document.removeEventListener('visibilitychange', handler);
  }, [status, send]);

  useEffect(() => {
    return () => {
      if (initSentRef.current) send('SUSPEND');
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // W7 host trust frame: wraps the LOADING + READY states (rendered here,
  // around the iframe, not inside it — so a block can't fake/restyle/hide the
  // "App block" provenance chrome). Terminal-FAILURE states no longer render
  // a framed fallback card; they collapse to null (see hostRenderDecision
  // above). Rendering null shows no content at all, so a failed block can't
  // masquerade as anything — the FRAME-1 anti-spoofing property holds without
  // a visible frame on failure.
  const framed = (children: ReactNode) => (
    <Box
      ref={frameRef}
      data-testid="app-block-frame"
      data-block-instance-id={install.blockInstanceId}
      style={{
        border: '1px solid var(--mantine-color-default-border)',
        borderRadius: 'var(--mantine-radius-md)',
        overflow: 'hidden',
      }}
    >
      <AppBlockChrome
        blockInstanceId={install.blockInstanceId}
        appBlockId={install.appBlockId}
        appName={install.manifest.name}
        modelId={modelCtx.modelId}
        modelName={modelCtx.modelName}
        slotId={slotId}
        canOpenPage={!!(features.appBlocks && features.appBlocksPages)}
      />
      {children}
    </Box>
  );

  // Terminal-failure collapse: a block that fails to load shows NOTHING
  // (render null → the slot takes no space) rather than a visible broken
  // card. Covers malformed manifest (empty iframe.src / invalid origin, the
  // old H-7 fatal), 'timeout' (no BLOCK_READY within 10s), 'fatal'
  // (BLOCK_ERROR{fatal:true}), and 'no_token' (token never resolved → the old
  // token_error). Rendering null shows no content at all, so the W7
  // anti-spoofing property (FRAME-1) is NOT weakened: there's nothing for a
  // block to masquerade as. The trust chrome is preserved only on the READY
  // (rendered) state below; the brief loading skeleton is also preserved.
  // Decision logic lives in the pure, unit-tested `hostRenderDecision` helper.
  const render = hostRenderDecision({ iframeSrc, expectedOrigin, status });
  if (render === 'collapse') {
    return null;
  }

  // CLS fix (Source B): collapse the hidden→shown iframe swap. The iframe is
  // rendered VISIBLE from the start, sized at `iframeHeight` (which starts at
  // the manifest minHeight — same as the loading skeleton), with
  // pointerEvents disabled until BLOCK_READY so a pre-ready block can't be
  // interacted with. The loading skeleton is overlaid ON TOP of the iframe at
  // the SAME minHeight (absolute-positioned), so there's exactly one
  // minHeight-tall box while loading and zero height delta when the skeleton
  // unmounts on ready. On READY the iframe grows from minHeight to the
  // reported content height — one bounded change (minHeight → content), not a
  // 0 → content jump.
  const isReady = status === 'ready';
  return framed(
    <div style={{ position: 'relative', width: '100%' }}>
      <iframe
        ref={iframeRef}
        src={iframeSrc}
        // H-6: client-side sandbox allowlist intersection — defense in depth
        // against a future server-side bypass that lets a dangerous token
        // reach the iframe attribute.
        sandbox={effectiveSandbox}
        // H-6: no-referrer keeps the model page URL out of the publisher's
        // server logs.
        referrerPolicy="no-referrer"
        title={install.manifest.name ?? install.blockId}
        data-testid="block-iframe"
        data-block-instance-id={install.blockInstanceId}
        data-block-ready={isReady ? 'true' : 'false'}
        style={{
          display: 'block',
          width: '100%',
          height: iframeHeight,
          border: 0,
          // Block interaction until the block reports ready. Visual-only
          // change — the iframe already occupies its minHeight reserve so
          // there's no layout shift when it becomes interactive.
          pointerEvents: isReady ? 'auto' : 'none',
        }}
        // NOTE: no `onLoad`-driven init. The iframe `load` event is
        // unreliable as the init trigger — on prod the cached block bundle's
        // `load` fires before React attaches the handler, so a load-gated
        // single-shot BLOCK_INIT was silently missed and the block sat blank
        // ("timed out waiting for BLOCK_INIT"). Init is driven entirely by
        // IframeInitController (retry-until-BLOCK_READY), keyed on token +
        // checkpoint readiness. See the init effect above.
      />
      {status === 'loading' && (
        <div style={{ position: 'absolute', inset: 0 }}>
          <BlockFallback
            reason="loading"
            blockName={install.manifest.name}
            minHeight={install.manifest.iframe?.minHeight ?? 200}
          />
        </div>
      )}
    </div>
  );
}
