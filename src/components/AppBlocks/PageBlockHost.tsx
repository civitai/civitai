import { Avatar, Box, Center, Skeleton, Stack, Text } from '@mantine/core';
import { useReducedMotion } from '@mantine/hooks';
import dynamic from 'next/dynamic';
import { useRouter } from 'next/router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { sanitizeAppChromeName } from './appChromeName';
import { BlockFallback } from './BlockFallback';
import { failureSnapshot } from './failureSnapshot';
import { AppBlockChrome } from './IframeHost';
import { IframeInitController, shouldStartInit } from './iframeInitController';
import { blockInitFragmentEnabled, type BlockHostSurface } from './blockInitFragmentGate';
import { useBlockIframeSrc } from './useBlockIframeSrc';
import { resolveBuzzPurchaseRequest } from './openBuzzPurchaseGate';
import {
  BLOCK_READY_TIMEOUT_MS,
  TOKEN_WAIT_TIMEOUT_MS,
  decideAutoRetry,
  advanceReviewConsentLatch,
  buildReviewConsentNotification,
  grantedPageScopes,
  INITIAL_REVIEW_CONSENT_LATCH,
  MID_SESSION_LOSS_ERROR_CLASS,
  pageFallbackReason,
  resolveCheckpointPickerRequest,
  resolveGetImagesByIdsRequest,
  resolveImageUploadRequest,
  resolvePublishGenerationOutputsRequest,
  resolveResourcePickerRequest,
  resolveReviewConsentNotice,
  resolveUngrantableConsentNotice,
  shouldEmitMidSessionLossBeacon,
  toHostGateStatus,
} from './pageBlockHostLogic';
import ConfirmDialog from '~/components/Dialog/Common/ConfirmDialog';
import {
  buildCollectionFollowConsentCopy,
  resolveCollectionFollowRequest,
} from './collectionFollowGate';
import { projectSafeGenerationResource } from '~/server/schema/blocks/generation-resource-projection';
import type { BlockUploadedImageInfo } from './BlockImageUploadModal';
import type { BlockSourceImageInfo } from './BlockGenerationSourceUploadModal';
import { BlockImageScanPoller } from './BlockImageScanPoller';
import type { BlockImageScanResult } from './blockImageScanLogic';
import { projectBlockInitMaturity, withSignedInFlag } from './projectBlockInit';
import { sendBlockRender } from './sendBlockRender';
import {
  computeLaunchTimings,
  createLaunchMarks,
  isDocumentHidden,
  nowMs,
  resetLaunchMarks,
  shouldResetLaunchMarks,
  type LaunchMarks,
} from './launchTimings';
import {
  classifyWildcardPackError,
  exceedsPreDownloadCap,
  resolveGetWildcardPackRequest,
  WILDCARD_MAX_CONCURRENT,
  type WildcardPackErrorCode,
} from './wildcardPackParse';
import { resolveRequestConsent } from './requestConsentGate';
import { resolveRequestSignIn } from './requestSignInGate';
import {
  downloadUrlAsBlob,
  isAllowedSaveImageUrl,
  resolveSaveImageRequest,
  sanitizeDownloadFilename,
  SAVE_IMAGE_MAX_CONCURRENT,
} from './saveImageDownload';
import { env } from '~/env/client';
import { effectiveSandboxIsOpaque, intersectSandbox } from './sandbox';
import { PAGE_SLOT_ID } from '~/shared/constants/slot-registry';
import { HEADER_HEIGHT_PX } from '~/shared/constants/app-layout.constants';
import { usePostMessage } from './usePostMessage';
import type { BlockInitPayload, PageContext } from './types';
import { dialogStore } from '~/components/Dialog/dialogStore';
import { hideNotification, showNotification } from '@mantine/notifications';
import { openLoginPopup } from '~/utils/auth-helpers';
import type { BuyBuzzModalProps } from '~/components/Modals/BuyBuzzModal';
import { openResourceSelectModal } from '~/components/Dialog/triggers/resource-select';
import { getBaseModelGroup, getBaseModelsByGroup } from '~/shared/constants/basemodel.constants';
import { deriveScopeFromInstanceId } from '~/server/schema/blocks/attribution.schema';
import { trpc } from '~/utils/trpc';
import {
  BLOCK_STORAGE_READ_OPTS,
  invalidatePrivateStorageReads,
  invalidateSharedStorageReads,
} from '~/components/AppBlocks/blockStorageCache';

// Lazy-consent UI (REQUEST_CONSENT). Opened on demand when a logged-in viewer
// clicks an action whose consent-gated scope the page token is missing. Mirrors
// IframeHost's dynamic import (SSR-disabled).
const BlockConsentModal = dynamic(() => import('./BlockConsentModal'), { ssr: false });

// Buy-Buzz modal for the page money path's OPEN_BUZZ_PURCHASE handler (the
// insufficient-Buzz top-up CTA). Mirrors IframeHost's dynamic import.
const BuyBuzzModal = dynamic(() => import('~/components/Modals/BuyBuzzModal'));

// Host-mediated image-upload modal for the OPEN_IMAGE_UPLOAD bridge. A block asks
// the host to let the user upload an image; the bytes flow through civitai's
// session-authed upload + REAL scan, and the iframe only ever gets back a
// moderated, SFW-ceiling'd, unflagged image id.
const BlockImageUploadModal = dynamic(() => import('./BlockImageUploadModal'), {
  ssr: false,
});

// Sibling of BlockImageUploadModal for the OPEN_IMAGE_UPLOAD bridge's
// `purpose: 'generationSource'` mode: an UNSCANNED private generation input (an
// img2img source), uploaded through the SAME consumer-blob util the generator
// uses (uploadConsumerBlob) — no createImage/scan/gate. The orchestrator scans
// the generation OUTPUT. Returns only { url, width, height }.
const BlockGenerationSourceUploadModal = dynamic(
  () => import('./BlockGenerationSourceUploadModal'),
  { ssr: false }
);

// Login flow for anonymous-conversion (REQUEST_SIGN_IN). The page route renders
// for logged-out viewers (the BLOCK_INIT context is viewer-scoped, viewer:null),
// so a block can ask the host to start the civitai login flow when the user
// clicks an action that needs auth/money. Login is now hub-driven (a popup to
// auth.civitai.com) — see openLoginPopup; the old in-page LoginModal was removed
// in the auth cutover.

// Normalise a thrown storage error into a string the block can surface. Mirrors
// IframeHost.storageErrorMessage EXACTLY — the apps.storage.* procs throw
// TRPCErrors with explicit code+message strings (UNAUTHORIZED, PAYLOAD_TOO_LARGE,
// quota_exceeded, …); we forward the message and never throw upward, so the
// block's host-mediated storage request rejects cleanly instead of hanging to
// the SDK's 30s timeout.
function storageErrorMessage(err: unknown): string {
  if (err && typeof err === 'object' && 'message' in err) {
    const message = (err as { message?: unknown }).message;
    if (typeof message === 'string' && message.length > 0) return message;
  }
  return 'storage request failed';
}

/**
 * W10 — full-page App Block host. Renders a block as a FULL-VIEWPORT surface
 * (not a model-column panel) under the same W7 trust chrome, driving the same
 * BLOCK_INIT / postMessage handshake the model IframeHost uses — but with a
 * PAGE context (entity=none, viewer-scoped, NO money scopes) and a deep-link
 * bridge (subPath forwarding + block-requested navigation).
 *
 * Deliberately a SEPARATE component from IframeHost (which is model-coupled:
 * checkpoint / showcase queries gated on modelId, model-only chrome) so the
 * behavior-preserving gate on the model path is not at risk. It reuses the
 * shared primitives: usePostMessage (origin-pinned transport),
 * IframeInitController (retry-until-BLOCK_READY), AppBlockChrome (spoof-proof
 * trust frame), intersectSandbox (client-side sandbox allowlist).
 *
 * Security posture (mirrors IframeHost):
 *   - BLOCK_INIT is posted to `new URL(iframeSrc).origin` (explicit target,
 *     never "*"); incoming messages from other origins are dropped.
 *   - Sandbox is the manifest ∩ trust-tier allowlist (client-side belt).
 *   - referrerPolicy=no-referrer; the page never carries a model/money scope.
 *   - Block-requested navigation (NAVIGATE) is constrained to the page's own
 *     sub-path space and uses shallow routing — a block can deep-link WITHIN
 *     its page but can't push the host off to an arbitrary route.
 */

/**
 * How long the host waits for the block to ack `BLOCK_READY` before settling on
 * the `timeout` terminal, and how long it waits for a token before settling on
 * `no_token`.
 *
 * 🔴 EXPORTED for the browser tests, which drive these windows on a VIRTUAL clock
 * (`vi.useFakeTimers`) instead of sleeping through them in real time. Waiting them
 * out for real cost ~99s in one file and was the single largest contributor to the
 * component suite overrunning its CI budget; importing the real constants keeps the
 * tests pinned to the host's actual windows rather than to copies that can drift.
 *
 * 🔴 They now LIVE in `pageBlockHostLogic` and are re-exported here. That module
 * is plain TS with no React graph, so a NODE test can import them — which is what
 * lets `worstReachableLaunchMs()` derive the launch-sample cap from the real
 * windows instead of from a hard-coded literal in a comment. Importing them from
 * this file would drag the whole component graph into the `unit` project.
 */
export { BLOCK_READY_TIMEOUT_MS, TOKEN_WAIT_TIMEOUT_MS };

/**
 * LAUNCH REVEAL (feedback #3: "launching an app should feel magical … subtly
 * animated"). How long the branded launch overlay cross-fades out while the block
 * fades in, once the block signals BLOCK_READY.
 *
 * 🔴 This is a PURELY COSMETIC, ready-path-only window. It can never delay, mask
 * or swallow an error, because every terminal state (`timeout` / `fatal` /
 * `no_token` / `error`) flips `showIframe` to false, which unmounts the entire
 * iframe+overlay branch and renders `BlockFallback` in the SAME commit — the
 * fade-out timer below is simply cleaned up. Nothing about the fallback render is
 * gated on animation state. (Regression-tested: see the "the reveal must NOT gate
 * the error path" cases in PageBlockHostLaunchReveal.browser.test.tsx, which
 * assert every terminal state still reaches BlockFallback — promptly, and still
 * wrapped in AppBlockChrome.)
 *
 * Implemented with a plain CSS opacity/transform transition rather than the
 * `motion` package: `motion` is NOT in the `/apps` route graph today (its only
 * importers are `src/components/Chat/*` + `src/utils/lazy-motion.ts`, reached via
 * a `next/dynamic` ChatWindow chunk), so importing it here would pull a new
 * animation runtime into the run-page bundle for one cross-fade.
 */
export const LAUNCH_REVEAL_MS = 260;

// Hard cap on a block-suggested Buy-Buzz amount (mirrors IframeHost) — clamps a
// malicious/huge `suggestedAmount` so the spend modal can't be pre-seeded with
// an absurd value. The user still picks freely.
const BUZZ_PURCHASE_AMOUNT_CAP = 50_000;

type Status = 'loading' | 'ready' | 'timeout' | 'fatal' | 'no_token' | 'error';

// MOD REVIEW SANDBOX (#2831): the reason string every reviewMode NACK carries — a
// clear, block-surfaced message so the mod (and the block's own error UI)
// understands why a side-effect refused, rather than the block silently hanging
// (gotcha #73). Module-scope so referencing it in a handler adds no effect dep.
const REVIEW_NACK_MESSAGE = 'not available in review preview';

// 🔴 The ONE reviewMode NACK that must NOT use REVIEW_NACK_MESSAGE.
// WILDCARD_PACK_RESULT's `error` is a DISCRIMINATED ENUM, not free text: the
// block-side `isValidWildcardPackResult` rejects any value outside
// not-found | forbidden | too-large | parse-failed | busy, and a rejected reply
// is DROPPED by the SDK transport (console.warn only) — so a free-text NACK here
// never settles the block's pending request and the caller hangs until the
// transport timeout, the exact opposite of the fail-fast the handler promises.
// `forbidden` is the in-set code: review preview genuinely is a permission
// context, and it is the closest member semantically.
//
// The annotation is the GUARD — `WildcardPackErrorCode` is the repo's local
// mirror of the SDK's `BlockWildcardPackErrorCode` (see wildcardPackParse.ts;
// the pinned @civitai/app-sdk dist does not export the wildcard union yet), so
// tsc rejects any future edit that swaps in a non-member string.
const WILDCARD_REVIEW_NACK_CODE: WildcardPackErrorCode = 'forbidden';

/**
 * The floor a `fit="fill"` host will not shrink below, in px.
 *
 * 🔴 WHY A FLOOR EXISTS AT ALL. `fit="fill"` is only correct under a
 * `Page(…, { scrollable: false })` layout, where EVERY ancestor is
 * `overflow-hidden`. That is what removes the double scrollbar — and it also
 * means the page is the only thing left that can offer a scrollbar. The site's
 * fixed chrome cannot shrink, so with a bare `min-height: 0` the app absorbed
 * the ENTIRE shortfall on a short viewport and the overflow was simply clipped
 * away with nothing to scroll. Measured before this floor existed: 153px of host
 * at a ~360px-tall SHORT DESKTOP window (the 90px ad; a phone in landscape gets
 * the 50px one and lands at 193 — see the table below), and 0px at 250px, with
 * `outerScrollbar = false` at every step. That is WCAG 1.4.4 / 1.4.10 — strictly worse than the cosmetic spare
 * scrollbar `fill` mode was introduced to remove.
 *
 * 🔴 THE FLOOR IS A TRADE, NOT A FREE WIN, AND ITS VALUE IS THE WHOLE TRADE.
 * When `available < FILL_MIN_HEIGHT_PX` the host overflows the page wrapper and
 * that wrapper grows a scrollbar — beside the block's own, i.e. THIS PR'S BUG in
 * a narrower window. Below the floor that is the right call (a scrollbar beats
 * unreachable content), so the number's only job is to make the band as small as
 * it can be while still catching the degenerate case. Raising it widens the
 * population that sees two scrollbars, so the value is bounded on BOTH sides —
 * in `__tests__/pageRunScrollContract.test.ts` (the node `unit` suite, which
 * renders a real verdict on a push to `main`) and again in
 * `PageBlockHostScrollFit.browser.test.tsx` (the report-only browser tier, which
 * is why it is not the only one). NEITHER TIER BLOCKS A MERGE: `main` requires
 * no status check at all in this repo, so both are signals a reviewer must read,
 * not doors that stay shut. The NUMBERS deliberately live in those tests, not here: a band
 * declared beside the value it bounds can be moved in the same edit. What lives
 * here is the ARITHMETIC that justifies them.
 *
 * THE ARITHMETIC, which decides who lands in the band:
 *
 *   available = innerHeight − 60 (header) − 57 (AppFooter 45 + its mt-3 12)
 *                           − AdhesiveAd (90 desktop / 50 mobile / 0 for paid)
 *                           − RewardsBonusBanner (~32 when active)
 *
 * 🔴 `innerHeight`, NOT the screen height — an earlier version of this comment
 * justified 400 with "a 768px laptop has 561px after chrome, so the floor never
 * fires there". That subtracted chrome from the PANEL height. A maximised
 * browser on a 768px screen has `innerHeight ≈ 650` once the OS taskbar, tab
 * strip, omnibox and bookmarks bar are gone, so the real margin was ~43px, not
 * 161 — one bookmarks bar or 110% zoom would have eaten it.
 *
 * At 300, the floor fires below roughly `innerHeight < 467` (logged-out mobile)
 * / `< 507` (logged-out desktop). That clears the mainstream portrait phones a
 * 400 floor caught — 375×667-class Safari (`innerHeight ≈ 553`, available ≈ 386)
 * and 360×640 Android (`≈ 560`, available ≈ 393) — while still protecting phone
 * LANDSCAPE (~360 tall → available ≈ 193) and heavy desktop zoom, which is where
 * the unreachable-content case actually lives.
 *
 * It is deliberately NOT derived from `100dvh` — that arithmetic is exactly what
 * this PR removed. Note the block's own area is `floor − AppBlockChrome`, so the
 * usable figure is meaningfully smaller than the constant.
 *
 * The floor only helps if something can scroll once it binds, so the run page's
 * wrapper carries `overflowY: 'auto'` as the scroll container of last resort.
 */
export const FILL_MIN_HEIGHT_PX = 300;

/**
 * The width a full-page App Block stops growing at, in px. Above it the host is
 * a CENTRED column with a neutral gutter either side; below it the cap is inert.
 *
 * 🔴 THIS IS THE `var()` FALLBACK, NOT THE SOURCE. The value the host actually
 * uses comes from `--app-page-max-width`, declared once on `:root` in
 * `src/styles/globals.css`, because that is the only spelling a per-app opt-out
 * rule can override (an inline custom property on this element would beat every
 * stylesheet rule and make the documented opt-out inert). CSS cannot import a TS
 * constant, so the number exists twice; `__tests__/pageBlockHostMaxWidth.test.ts`
 * asserts the two agree, exactly as the `--header-height`/`HEADER_HEIGHT_PX`
 * guard in `__tests__/pageRunScrollContract.test.ts` does. The fallback is not
 * decorative: it is what caps a host rendered in a context that has not loaded
 * the app stylesheet, and it is exercised by a case in the browser suite.
 *
 * 🔴 WHY A CAP EXISTS AT ALL. The host sized the iframe `width: 100%` with no
 * bound anywhere in the chain — the run page's wrapper is `width: '100%'`, the
 * host root was `width: '100%'`, the iframe is `width: '100%'` — so on a 2560px
 * display an app rendered as a single ~2500px column. An App Block is a
 * cross-origin guest that is handed a viewport and told nothing about the
 * display, so the defence has to be here.
 *
 * 🔴 WHO IS ACTUALLY UNDEFENDED — enumerated, because the obvious premise ("apps
 * do not cap themselves") is only half true, and the half that is false is what
 * decides where this value sits.
 *
 * ⚠️ THE CENSUS BELOW IS A CROSS-REPO READING, NOT SOMETHING THIS REPO CAN CHECK, AND
 * NOTHING ASSERTS IT. It was taken by reading 13 separate first-party App Block repos
 * at whatever refs they were at when the cap was chosen; no ref is recorded, no
 * fixture reproduces it, and every number in it (13 repos, 11 page surfaces, the nine
 * wells, median 860, max 1100) would silently rot as those repos change. Treat it as
 * the RATIONALE that was in front of whoever picked 1600, not as a live measurement —
 * and re-take it, recording refs, before leaning on it to move the cap. Across those
 * 13 repos as read then — 11 with a `page` surface; the other two are
 * `model.sidebar_top` slot blocks and a PAGE cap cannot reach them:
 *
 *   · NINE of the eleven page apps DO cap themselves, at 640 / 720 / 720 / 760 /
 *     820 / 880 / 900 / 960 / 1100 px — a hand-copied `contentStyle` well; median
 *     860, max 1100. None renders content wider than 1100px, so this cap is a
 *     no-op for their layout: it changes which background paints the far gutter
 *     and nothing else.
 *   · TWO do not cap at all — Notepad and Sensei, both `100dvh` two-pane app
 *     shells (a fixed 280 / 240px sidebar beside an unbounded `flex: 1` pane).
 *     Those are the shipped apps that genuinely stretched to the monitor.
 *   · THE LONG TAIL IS UNBOUNDED BY CONSTRUCTION, which is the real reason for a
 *     DEFAULT rather than a per-app fix. `@civitai/blocks-react` exports no
 *     Container / AppShell / Page and declares no container width — its only
 *     max-widths are modal-scoped (340 / 440 / 620) plus a 420px sign-in gate
 *     card — and the official starter templates contain zero width declarations.
 *     An app scaffolded today inherits whatever the host gives it. Nine
 *     independently hand-picked numbers with nothing to coordinate on is the
 *     argument for making the decision here instead of asking every app to make
 *     it again.
 *
 * WHY 1600, AGAINST THOSE SURFACES. Two in-repo anchors bound the choice, and the
 * number sits between them on purpose:
 *
 *   1288  the widest ORDINARY civitai content measure — Mantine `xl` (1320
 *         border-box) is the widest container size in use across `src/pages`,
 *         and `APPS_TWO_COLUMN_DETAIL_MEASURE` (the store-preview page an app is
 *         usually launched FROM) starts there. An app capped below this would
 *         render narrower than the page that linked to it, which reads as a
 *         downgrade rather than a frame.
 *         ⚠️ THAT CONSTANT IS NO LONGER A SINGLE NUMBER, and the sentence above used
 *         to say "is exactly it". It is a BAND now — `{min: 1288, max: 1600}` — so on
 *         a wide screen the store-preview page reaches 1600, which is EXACTLY this
 *         cap rather than 312px below it. The conclusion survives (an app is never
 *         narrower than the page that launched it) but the MARGIN this paragraph
 *         implied is gone: at the top of that band the two are equal. If the
 *         store-preview band is ever raised again, this cap stops being a ceiling
 *         over it and the reasoning here has to be re-made rather than re-read.
 *   2560  `APPS_PAGE_CONTAINER_WIDTH` — the deliberate outlier, and it is an
 *         outlier for a reason that does NOT transfer: it exists for card GRIDS
 *         and wide TABLES (`appsPageWidths.ts` records the measurements), which
 *         genuinely spend the space. An app block may be a grid, but it may just
 *         as easily be a single form, and the host cannot tell which.
 *         ⚠️ IT WAS 1920 WHEN THIS BAND WAS CHOSEN and the ultrawide pass moved it
 *         to 2560. The gap between the cap and the outlier therefore WIDENED, which
 *         does not by itself justify widening the cap — see below.
 *
 * 1600 is at-or-above every ordinary content measure on the site and below the grid
 * container, i.e. no app is ever narrower than a civitai page. ⚠️ "AT-OR-ABOVE" IS THE
 * CORRECTION: this read "above every ordinary content measure" while
 * `APPS_TWO_COLUMN_DETAIL_MEASURE` was the fixed 1288. It is a band now, topping out at
 * exactly 1600, so on a wide screen the store-preview page and this cap are the SAME
 * width. The claim that matters — no app renders narrower than the page that launched it
 * — still holds at equality; the headroom it used to have does not. It also clears the
 * widest app-imposed well (1100) by ~45%, so the cap can never letterbox an app
 * that has already thought about its own width, while leaving a two-pane shell
 * like Notepad or Sensei a ~1350px content pane — the case the cap exists for.
 * Concretely it holds five columns of a `minmax(300px, 1fr)` grid (1288 holds
 * four, 2560 holds eight).
 *
 * 🔴 DO NOT RE-DERIVE THIS CAP FROM "THE WIDEST FIRST-PARTY SURFACE". That phrasing
 * used to appear here and it is a moving target: the apps container has taken three
 * values over time — 1600 → 1920 → 2560 — without any of them being a statement about
 * how wide a THIRD-PARTY app should be. The cap's real justification is the two bounds above
 * it does control — at-or-above every ordinary content measure, and comfortably clear of
 * the widest app-imposed well — neither of which moves when the apps CONTAINER does.
 * (The store-preview band's ceiling does sit exactly on the first of those two, so it is
 * a bound this cap now touches rather than clears; raising that band again would invert
 * it, and this reasoning would have to be re-made.) Widening 1600 is a separate decision with its own evidence.
 *
 * 🔴 THE APP THIS IS PROBABLY WRONG FOR, and why the opt-out ships WITH the cap
 * rather than after it: Playable Collections. Re-read at its DEPLOYED ref
 * (`sync/deployed-0.2.2`, manifest `blockId: "playable-collections"`), because an
 * earlier reading of this — that only its "player mode" is affected, the rest
 * being governed by the app's own 960px well — is WRONG, and wrong in the
 * direction that makes the opt-out look smaller than it is:
 *
 *   · the 960 well is `contentStyle` in `App.tsx:972`, applied at `App.tsx:789`
 *     to the BROWSE shell only;
 *   · opening a collection early-returns at `App.tsx:733` past that wrapper into
 *     `CollectionViewer`, whose root (`CollectionViewer.tsx:582`) is
 *     `width: 100%; min-height: 100dvh` with NO max-width;
 *   · and that root serves THREE view modes — classic (`Player`), plus
 *     continuous-horizontal and continuous-vertical (`ContinuousView`) — with an
 *     ambient "cast" state on top. None of them is capped by the app.
 *
 * So an opt-out here is per-APP and would unbound all three modes, not tidy up
 * one. That may well be right — a ticker and a wall want width, and the player's
 * media is `object-fit: contain` so a centred column simply shrinks it — but it
 * is a bigger product call than "the app already governs this", and it is not
 * mine to make. NO LEDGER ENTRY IS WRITTEN TODAY, and the ledger's expected set
 * in `__tests__/pageBlockHostMaxWidth.test.ts` is `[]` so that the first one has
 * to be added deliberately.
 *
 * 🔴 STATE THE COST HONESTLY: this binds on a maximised browser on a 1080p
 * monitor (~1905 CSS px of viewport), not only on ultrawides — that is a common
 * desktop, and it gets a ~150px gutter either side. That is the deliberate
 * trade. It does NOT bind on any laptop class (1280/1366/1440/1536), on any
 * tablet, or on any phone in either orientation, which is where the traffic is
 * and where the rendered geometry is unchanged to the pixel.
 *
 * The BAND this value may move in lives in the tests, not here — a band declared
 * beside the value it bounds can be moved in the same edit (the lesson
 * `FILL_MIN_HEIGHT_PX` records). The ARITHMETIC that justifies it is what lives
 * here.
 */
export const APP_PAGE_MAX_WIDTH_PX = 1600;

export interface PageBlockHostProps {
  /** AppBlock id (`apb_*`) — used to build the BLOCK_INIT ids + trust chrome. */
  appBlockId: string;
  blockId: string;
  appId: string;
  /** The synthetic `page_<appBlockId>` instance id the token was minted for. */
  blockInstanceId: string;
  appName: string;
  /** The `<slug>.civit.ai` bundle URL (manifest.iframe.src), server-resolved. */
  iframeSrc: string;
  /**
   * `manifest.bootSkeleton` — the app declares that its OWN shipped `index.html`
   * paints its own boot state (THEMED only if the app is also enabled for the
   * BLOCK_INIT fragment and reads it before first paint; otherwise it is
   * guessing from prefers-color-scheme), so the host must stand back and let it show.
   *
   * 🔴 This does three things, not one, and all three are required: without any
   * of them the app's boot state is invisible and the declaration is a lie.
   *   1. no branded veil (it is opaque, `inset: 0`, until BLOCK_READY);
   *   2. the iframe is visible from mount rather than `opacity: 0` until ready;
   *   3. no `translateY` settle on reveal — that IS a layout shift, and the
   *      point of an app-painted skeleton is that hydration moves nothing.
   *
   * The host's own skeleton stays the default for every app that does NOT
   * declare this: an app with an empty `#root` and no veil is a blank white
   * iframe for 300-1200ms, which is worse than what we had.
   *
   * 🔴 IT ALSO WIDENS WHAT AN APP CAN PAINT, AND WHEN. Without this the block
   * could put no pixels on screen before BLOCK_READY (opacity 0 + an opaque
   * veil); with it, publisher-controlled content is visible from mount, before
   * the host holds a token. `pointerEvents` still blocks the mouse and
   * AppBlockChrome still sits above, and an app can already paint freely once
   * ready — so the change is to TIMING, not capability. It is named here
   * because the surrounding comments discuss anti-spoof posture and this is
   * part of it.
   *
   * 🔴 NOTHING VALIDATES THE DECLARATION TODAY — do not rest a safety argument
   * on a build gate that does not exist yet. An app may set this over an empty
   * `#root` and the result is that blank iframe, with no rejection anywhere in
   * submit, approve or build. A platform-build check is planned (talos-infra);
   * until it lands, the only thing standing between a false declaration and a
   * blank run page is the author looking at their own app.
   */
  // REQUIRED, and passed explicitly by every call site — the same shape
  // `surface` above uses, for the same reason. An optional prop with a
  // `= false` default made the DEV route and the MODERATOR REVIEW preview
  // silently render the veil: the author checking their own app and the
  // moderator approving it both saw the pre-feature presentation, and the
  // first person to see the real one would have been a user. Required means
  // a new host is a type error until someone decides what it should do.
  bootSkeleton: boolean;
  /**
   * Which surface mounted this host. REQUIRED, and passed explicitly by each
   * call site rather than inferred, because it is one of the two axes the
   * init-fragment gate keys on — and the axis that refuses the DEV TUNNEL
   * unconditionally, which an allowlist keyed on blockId/slug structurally
   * cannot do (the tunnel serves the same blockId the author will publish).
   */
  surface: BlockHostSurface;
  /** manifest.iframe.sandbox, server-resolved. */
  sandbox: string;
  trustTier: 'unverified' | 'verified' | 'internal';
  /** The page slug (== blockId). Forwarded in context for the block. */
  slug: string;
  /** The minted, viewer-scoped page token (no money scopes). */
  token: string | null;
  expiresAt: string | null;
  /** #3/#6: the page manifest's declared scopes. The host posts the ACTUAL
   *  granted set (declared − missingScopes) in BLOCK_INIT so the block sees the
   *  scopes the JWT actually carries (e.g. `apps:storage:*`), not `[]`. */
  declaredScopes: string[];
  /** #3/#6: consent-gated scopes withheld from the token (reported by the mint).
   *  Trimmed from the wrapped `token.scopes` so the block's capability check is
   *  accurate, and used to surface a consent-needed terminal state. */
  missingScopes?: string[];
  /** #3/#6: true when the app's approved manifest declares scopes the viewer has
   *  not granted (the token still mints with the granted subset). */
  needsConsent?: boolean;
  /** #3/#6: the token mint errored. Surface an error state instead of hanging at
   *  `no_token`. Only escalates a host still in `loading` — see `tokenTerminal`
   *  for the mid-session case. */
  tokenError?: boolean;
  /**
   * The mint has PERMANENTLY failed: no usable token remains AND the upstream
   * hook's bounded automatic re-mints are exhausted (`useBlockToken.terminal`).
   *
   * 🔴 THIS IS THE ONLY THING THAT MAY TEAR DOWN A `ready` PAGE. Before it, the
   * `tokenError` effect below transitioned out of `loading` ONLY — so a token
   * that died mid-session left the host sitting at `ready` on a dead credential
   * with `TOKEN_REFRESH` early-returning on `!token`, and the block just silently
   * 401'd forever with no signal to the user or the platform. Gating on the
   * SETTLED signal (rather than a bare `tokenError`) is what keeps a merely
   * TRANSIENT refresh blip from ripping a working app out from under the user
   * while it is still being recovered.
   *
   * Optional + default false → every existing caller is byte-identical.
   */
  tokenTerminal?: boolean;
  /** Advisory color-domain maturity signal (BLOCK_INIT). Server-authoritative
   *  values from the token mint — forwarded, never derived client-side. */
  domain?: 'green' | 'blue' | 'red' | null;
  maxBrowsingLevel?: number;
  viewer: { id: number; username: string | null } | null;
  theme: 'light' | 'dark';
  /** Re-mint the page token after a consent grant so it carries the newly
   *  granted scopes (pushed to the iframe via TOKEN_REFRESH). Mirrors
   *  IframeHost.onConsentGranted → useBlockToken.refresh. */
  onConsentGranted?: () => void;
  /** Re-mint the page token on a Retry from an AUTH-failure terminal state
   *  (`error` / `no_token`). The token is a PROP minted by useBlockToken in the
   *  route; `handleRetry`'s local reset alone can never clear an auth failure
   *  because `token`/`tokenError` are owned upstream — only re-minting can. Wired
   *  to the same useBlockToken.refresh as onConsentGranted (it aborts any
   *  in-flight mint; the endpoint is rate-limited 60/min). Omitted → Retry on an
   *  auth error only remounts (the pre-fix dead-end), so the route MUST pass it. */
  onRetryToken?: () => void;
  /**
   * MOD REVIEW SANDBOX (#2831) read-only gate. Default false → prod behavior is
   * BYTE-IDENTICAL. When true (the mod review preview host only), EVERY
   * side-effecting / money / private / cross-user handler replies with a
   * KNOWN-SHAPE NACK (fail-fast, never a hang — gotcha #73) instead of doing the
   * work, and the render-safe read handlers (BLOCK_INIT / BLOCK_READY / the
   * resource+checkpoint pickers / self-viewer / shared reads / sign-in) stay live.
   * This is a REQUIRED defense layer that holds even if the review token were ever
   * mis-scoped — no single layer is load-bearing.
   */
  reviewMode?: boolean;
  /**
   * MOD REVIEW SANDBOX "run for real" (#2831). Meaningful ONLY when `reviewMode`
   * is also true. Default false → the render-only sandbox (every side-effect
   * NACKs, unchanged). When true, the mod has EXPLICITLY opted in (consent-gated)
   * to run the unapproved app FOR REAL against their OWN account: the SELF-BOUND /
   * money-IN / own-Buzz side-effect handlers (submit / estimate / poll / cancel /
   * app-workflows / buzz balance+transactions+accounts+comp / per-user storage /
   * buy-buzz) run the REAL mutation because the token now carries the scopes +
   * budget. CROSS-USER shared-datastore WRITES and money-OUT stay NACKed even in
   * run-for-real (they are never granted). The persistent banner is rendered by
   * the preview surface, not here.
   */
  reviewRunForReal?: boolean;
  /**
   * May this viewer open `/apps/run/<blockId>`? Forwarded to `AppBlockChrome`,
   * where it gates the "Recently run" menu — that section's ONLY link shape is
   * that route, which 404s fail-closed unless the viewer holds BOTH `appBlocks`
   * and `appBlocksPages`.
   *
   * 🔴 IT IS THE SAME PREDICATE ON EVERY MOUNTER:
   * `!!(features.appBlocks && features.appBlocksPages)` — the exact conjunction
   * `/apps/run/[slug]`'s own `getServerSideProps` checks, no more and no less.
   * Two ways to get it wrong, both of which have been written here:
   *
   *   - A PER-SURFACE CONSTANT, justified with "the surfaces gate on DIFFERENT
   *     flags". That conflates what gates the SURFACE with what gates the LINK
   *     TARGET. The dev tunnel's own gate and mod review's reviewer check say
   *     nothing about whether the menu's links resolve. Hardcoding it per
   *     surface is what silently killed the menu for mods on three of four
   *     surfaces.
   *   - HALF THE CONJUNCTION (`!!features.appBlocksPages`). `appBlocks` is the
   *     block-runtime kill-switch and a Flipt override can disable as well as
   *     enable, so pages-on/blocks-off is a reachable state in which every one
   *     of these links 404s. All four surfaces happen to sit behind their own
   *     `appBlocks` check today, so the one-flag form is not currently a live
   *     bug — but that makes the menu gate depend on an invariant held in four
   *     other functions, which is exactly the kind of distant coupling that
   *     produced the original defect. Encode the target route's predicate here.
   *
   * All three mounters (`/apps/run/[slug]`, `/apps/dev/[blockId]`,
   * `ReviewBlockPreviewHost`) read the conjunction; the source-level guard in
   * `recentAppsRail.test.ts` enumerates them by scanning the tree, so a NEW
   * mounter cannot quietly omit it or downgrade it to one flag.
   *
   * Default false → a mounter that hasn't wired it shows no dead links.
   */
  canOpenPage?: boolean;
  /**
   * How the host sizes itself VERTICALLY. This is the double-scrollbar axis, so
   * it is spelled out rather than inferred from `surface`.
   *
   *   'viewport' (DEFAULT, the historical behaviour) — the host claims
   *     `min-height: calc(100dvh - HEADER_HEIGHT_PX)` and lets whatever is above
   *     it scroll.
   *     Correct ONLY for a mounter sitting inside a SCROLLING ancestor that does
   *     not otherwise bound its height: the dev tunnel (`/apps/dev/<blockId>`,
   *     default `AppLayout` → `ScrollArea`). Without it that host would be sized
   *     only by `FILL_MIN_HEIGHT_PX` — measured 300px of host, 31px of chrome,
   *     269px of iframe, regardless of how much room the page actually has.
   *     Usable, but no longer FILLING anything.
   *
   *     ⚠️ This used to name the mod-review preview here too, and that was the
   *     WRONG diagnosis of that surface: it is not in an unbounded scrolling
   *     ancestor, it is in a box that bounds its height and CLIPS
   *     (`height: 420; overflow: hidden` in the review modal;
   *     `100dvh − header` on the full-page preview). Claiming
   *     `100dvh − HEADER_HEIGHT_PX` inside a 420px panel put roughly 600px of app
   *     out of reach on a 1080px screen, with nothing to scroll to it — and it
   *     got worse the taller the viewport, because the claim grows while the
   *     panel does not. `ReviewBlockPreviewHost` is on `'fill'` as of that fix.
   *
   *   'fill' — the host fills its parent (`flex: 1`, floored at
   *     `FILL_MIN_HEIGHT_PX`) and
   *     claims no viewport-derived height of its own. Requires the mounter's
   *     ancestor chain to already bound the height — i.e. a page declared
   *     `Page(…, { scrollable: false })`, whose `AppLayout` branch is
   *     `flex-1 overflow-hidden` all the way down.
   *
   * 🔴 WHY THE DEFAULT IS WRONG FOR A FULL-PAGE APP, and why 'fill' exists.
   * `calc(100dvh - HEADER_HEIGHT_PX)` subtracts ONLY the site header. Inside the default
   * scrolling layout the actual space left to the page is
   * `100dvh − header − subNav − its mb-3 − RewardsBonusBanner − AppFooter −
   * AdhesiveAd`, every term of which is ≥ 0 and several of which are > 0 on a
   * normal render. So the host is UNCONDITIONALLY taller than its scroll
   * viewport: the layout's `ScrollArea` grows a vertical scrollbar it can only
   * ever scroll by that residue, while the block's own document scrolls inside
   * the iframe — two scrollbars, side by side, for one scrollable thing. It is
   * arithmetic, not a race: there is no viewport size at which the two heights
   * agree. `'fill'` removes the magic number instead of re-tuning it.
   *
   * The header term is `HEADER_HEIGHT_PX` from
   * `~/shared/constants/app-layout.constants`, which `AppHeader` also sets itself
   * from — it used to be a private `HEADER_HEIGHT = 60` there and a bare `60`
   * here, so a header resize re-opened this bug on any surface still on
   * `'viewport'`. One source now, and a guard in `pageRunScrollContract.test.ts`
   * binds it to the `--header-height` custom property that CSS call sites use.
   *
   * ⚠️ This used to carry a prohibition on rewriting the calc to
   * `calc(100dvh - var(--header-height))`, because the component-test harness
   * loaded no global stylesheet and the custom property read as `""` there — an
   * invalid declaration, so the host laid out differently under test than in
   * production. **That is fixed**: `test/component-setup.tsx` now injects the
   * `:root` custom properties from `globals.css`. Interpolating `HEADER_HEIGHT_PX`
   * here is kept deliberately (see the constant's own comment), not because the
   * var is unsafe.
   *
   * Still prefer moving a mounter to `'fill'` over re-tuning this calc.
   */
  fit?: 'viewport' | 'fill';
}

export function PageBlockHost({
  appBlockId,
  blockId,
  appId,
  blockInstanceId,
  appName,
  iframeSrc,
  bootSkeleton,
  surface,
  sandbox,
  trustTier,
  slug,
  token,
  expiresAt,
  declaredScopes,
  missingScopes,
  needsConsent,
  tokenError,
  tokenTerminal = false,
  domain,
  maxBrowsingLevel,
  viewer,
  theme,
  onConsentGranted,
  onRetryToken,
  reviewMode = false,
  reviewRunForReal = false,
  canOpenPage = false,
  fit = 'viewport',
}: PageBlockHostProps) {
  const router = useRouter();
  // MOD REVIEW SANDBOX (#2831): the side-effect NACK gate. Side-effecting handlers
  // NACK when in review mode UNLESS the mod opted in to run-for-real (in which case
  // the token carries the scopes + budget and the REAL mutation runs). Handlers
  // that must ALWAYS refuse in review (cross-user shared WRITES, money-OUT) keep
  // gating on `reviewMode` directly, NOT this. Default (`reviewMode:false`) →
  // reviewNack is false → prod path is byte-identical.
  const reviewNack = reviewMode && !reviewRunForReal;
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const [status, setStatus] = useState<Status>('loading');
  // Mirror of `status`, read by the Retry handler (for the prior terminal state,
  // WITHOUT putting a side-effect (onRetryToken) inside the setStatus updater —
  // which React may double-invoke under StrictMode → a double re-mint) AND by the
  // four status-gated message handlers via `readGateStatus` below.
  //
  // 🔴 ASSIGNED IN THE RENDER BODY, NOT IN AN EFFECT — that placement IS the fix,
  // and an effect here is the bug. React writes the `data-block-ready` DOM
  // attribute (and every other commit-time output) during the COMMIT, but flushes
  // PASSIVE effects in a LATER scheduler task whenever the commit exhausts the 5ms
  // frame budget (scheduler 0.23.2, MessageChannel transport, `frameYieldMs = 5`).
  // So an effect-updated mirror is stale for exactly the window in which the host
  // has already publicly announced readiness — measured with a MutationObserver on
  // the attribute: at the instant it flips to "true" the gated handlers still drop
  // the message, 6 runs out of 6. A render-body assignment happens BEFORE the
  // commit, so by the time anything observable says "ready" the mirror already is.
  // Updating it from an effect would have precisely the deferral being fixed.
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
  //   • ready → error (the mid-session token loss at the `setStatus` below) and
  //     ready → fatal (`BLOCK_ERROR{fatal:true}`) are RESTRICTIVE. A concurrent
  //     render writes `statusRef.current = 'error'`, yields before commit, and a
  //     queued OPEN_BUZZ_PURCHASE arriving in that gap is REFUSED while
  //     `data-block-ready` still reads "true".
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
  // rendered yet. Mirroring the ready transition into the ref from inside the
  // BLOCK_READY handler was considered and REJECTED: the handler would have to
  // re-implement the updater's `current === 'loading'` predicate against the ref,
  // which disagrees with React's own resolution whenever another setStatus is
  // already queued (the exact eager-updater hazard the impression-beacon comment
  // below documents at length). The NACKs on the two repliable gates are what
  // cover that remainder — a drop there fails FAST instead of hanging.
  const statusRef = useRef<Status>('loading');
  statusRef.current = status;
  // #4 Retry: bumped by the terminal-fallback Retry button to re-key the
  // <iframe> below. Re-keying forces React to unmount + remount the iframe (a
  // fresh `contentWindow`), so the re-armed init handshake talks to a clean
  // frame instead of a wedged one. See `handleRetry`.
  const [reloadNonce, setReloadNonce] = useState<number>(0);
  // BOUNDED AUTO-RETRY budget for this mount. State (not a ref) because the
  // scheduling effect AND the render-failure beacon both derive from it, so it
  // has to drive re-renders. `attempts` counts every automatic attempt;
  // `reminted` counts the subset that spent a token re-mint (the rate-limit cap).
  // A MANUAL Retry deliberately touches NEITHER — see handleRetry.
  const [autoRetryBudget, setAutoRetryBudget] = useState<{
    attempts: number;
    reminted: number;
  }>({ attempts: 0, reminted: 0 });
  // Active async cosmetic-image scan pollers (non-blocking OPEN_IMAGE_UPLOAD).
  // Keyed by the OPEN_IMAGE_UPLOAD requestId; each entry mounts one
  // BlockImageScanPoller (below) that survives the upload modal's close, polls
  // the authoritative scan gate, and on a verdict fires IMAGE_SCAN_RESOLVED then
  // removes itself. See the OPEN_IMAGE_UPLOAD handler + the render block.
  const [imageScanPollers, setImageScanPollers] = useState<
    Array<{ requestId: string; imageId: number }>
  >([]);
  const initSentRef = useRef<boolean>(false);
  const controllerRef = useRef<IframeInitController | null>(null);
  const buildInitPayloadRef = useRef<() => BlockInitPayload>();
  // Analytics Phase 2: emit-once guard for the block-render beacon. The
  // status-transition gate ('loading' → 'ready') is the primary dedup, but a
  // burst of duplicate BLOCK_READY acks arriving before React commits the
  // 'ready' state could each still observe `current === 'loading'`. This ref
  // makes the per-mount emit deterministic regardless of ack timing.
  const blockRenderEmittedRef = useRef<boolean>(false);

  // 🔴 A SEPARATE at-most-once latch for the MID-SESSION credential-loss beacon,
  // and it MUST NOT be `blockRenderEmittedRef`.
  //
  // `blockRenderEmittedRef` encodes an ANALYTICS invariant — exactly ONE
  // impression per host mount — that the `blockRenders` denominator and the
  // BlockRenderFailureRate alert both depend on. Reusing it here would be wrong
  // in both directions: a `ready` host has already consumed it (so the beacon
  // would never fire — the precise reason a real prod revocation recorded zero
  // error beacons on 2026-07-31), and clearing/relaxing it to make room would
  // retroactively change what the already-sent `ok` impression means.
  //
  // The teardown is a genuinely DIFFERENT event from the page load, so it gets a
  // different latch. Net effect on the wire for a revoked session: `ok` (the load
  // really did succeed) followed by ONE
  // `error{error_class="token_lost_midsession"}` (it was later revoked). Bounded
  // per mount by this ref; the impression accounting above is untouched.
  const midSessionLossEmittedRef = useRef<boolean>(false);
  // Latches on the first committed `ready`. This is what tells a `ready → error`
  // teardown apart from a `loading → error` launch failure — `status === 'error'`
  // alone cannot (both transitions land on it). A ref, not state: it must not
  // cause a render, and `handleRetry` deliberately does not clear it (a mount
  // that ever launched has launched).
  const reachedReadyRef = useRef<boolean>(false);

  // ── LAUNCH LATENCY marks ────────────────────────────────────────────────────
  // Four `performance.now()` stamps + a sticky hidden-tab flag. All the math
  // (and every correctness rule) lives in the pure, node-tested `launchTimings`
  // module; the host only records.
  //
  // 🔴 t0 IS THE FIRST CLIENT RENDER, not a mount effect. The `<iframe src>` is
  // an SSR prop rendered inside `showIframe` (true while status === 'loading',
  // which is the INITIAL status), so the cross-origin frame load starts in this
  // very commit — before any token exists. A t0 taken in a post-mount effect
  // would start the clock after the thing it is timing. The lazy-ref pattern
  // below is the React-blessed way to do once-per-instance work at render time,
  // and it is SSR-safe (`performance` is undefined there → `mountedAt: null` →
  // `computeLaunchTimings` returns null and nothing is reported).
  const launchMarksRef = useRef<LaunchMarks | null>(null);
  if (launchMarksRef.current === null)
    launchMarksRef.current = createLaunchMarks(nowMs(), isDocumentHidden());
  // Which instance the marks above currently describe. Seeded at RENDER time
  // with the first `blockInstanceId`, so the `[blockInstanceId]` effect below can
  // tell "first mount" (no reset — that would throw away the render-time t0)
  // from "soft nav to another app" (reset).
  const launchInstanceRef = useRef<string | null>(null);
  if (launchInstanceRef.current === null) launchInstanceRef.current = blockInstanceId;

  // 🔴 BOTH REFS ABOVE ARE PER-MOUNT, BUT THIS HOST IS NOT ALWAYS REMOUNTED.
  //
  // `/apps/run/[slug]/[[...path]]` renders <PageBlockHost> with NO `key`, and
  // `_app.tsx` renders <Component> with no key either — so a SOFT navigation
  // between two apps (appA → appB, e.g. via the "Recently run" menu) reuses this
  // component instance: same mount, different `blockInstanceId`.
  //
  // Left alone, app A's latches would leak onto app B and produce a WRONG,
  // MISATTRIBUTED signal: B's launch failure would inherit `reachedReady === true`
  // and be reported as `token_lost_midsession` for an app that never launched —
  // exactly the launch-vs-teardown confusion this whole feature exists to avoid.
  // (Conversely a spent emit-latch would silently swallow B's genuine loss.)
  //
  // So the latches are scoped to the block INSTANCE, not the React mount.
  //
  // 🔴 Deliberately conservative: this resets to `false` rather than re-deriving
  // from `status`, because under host reuse `status` is itself STALE (it is still
  // app A's 'ready'). Re-deriving would re-create the misattribution this fixes.
  //
  // Be precise about the cost, because it is NOT an edge case. `status` inherited
  // from app A can still move FORWARD out of 'ready' (→ 'error' on a terminal
  // token, → 'fatal' on BLOCK_ERROR) — it is not frozen. What it cannot do is go
  // BACK: every `setStatus` here is gated on the current value, and the only
  // unconditional reset to 'loading' is `performRetry`. Since re-reaching 'ready'
  // requires passing through 'loading', app B can never earn a genuine `ready`
  // after a soft nav, so the latch re-arms only via a manual or automatic Retry.
  //
  // That costs nothing real TODAY, because on the same path app B never gets a
  // working session to lose: `shouldStartInit` returns false for any non-'loading'
  // status, so BLOCK_INIT is never sent and app B cannot reach a genuine ready
  // state. The missed beacon is therefore unreachable — it describes a state the
  // pre-existing host-reuse bug already prevents. Net vs. before this reset:
  // strictly better (we traded a FALSE POSITIVE on app B's launch failure for a
  // beacon that could not have fired anyway). Under-reporting, never
  // mis-reporting — the right side to err on for an alerting signal.
  //
  // 🔴 The DECLARATION ORDER below is load-bearing: this effect must be declared
  // BEFORE the reachedReady-latch effect, so that a commit changing both
  // `blockInstanceId` and `status` resets first and latches second. (That effect
  // used to sync `statusRef` too; the mirror now lives in the render body — see
  // its 🔴 note — but the reset/latch ordering constraint is unchanged.)
  // No current test detects a swap (no reachable case distinguishes them today) —
  // so if you reorder these, reason it through rather than trusting the suite.
  //
  // NOTE: the wider host-reuse problem is PRE-EXISTING and NOT fixed here — stale
  // `status` and the leaked `blockRenderEmittedRef` (so app B loses its `ok`
  // impression) both predate this change. The real fix is `key={blockInstanceId}`
  // on the run page, which would also change impression COUNTS, so it belongs in
  // its own PR rather than riding along on an observability change.
  useEffect(() => {
    reachedReadyRef.current = false;
    midSessionLossEmittedRef.current = false;
    // Same reasoning for the launch marks: under host reuse app A's `mountedAt`
    // would be attributed to app B's launch, producing a `total` that includes
    // however long the user spent in app A. (Today app B can never earn a
    // genuine `ready` after a soft nav — `shouldStartInit` refuses a non-'loading'
    // status — so this is belt-and-braces against the pre-existing host-reuse
    // bug being fixed later, not a live defect.)
    //
    // 🔴 BUT NOT ON FIRST MOUNT. This effect runs on mount as well as on change,
    // and `mountedAt` was deliberately taken at RENDER time — the commit in which
    // the iframe actually mounts. Resetting here unconditionally would overwrite
    // it with a post-commit timestamp and silently shorten EVERY `total` by the
    // render->effect gap, discarding exactly the window t0 exists to capture, in
    // the flattering direction. `shouldResetLaunchMarks` is unit-tested.
    if (shouldResetLaunchMarks(launchInstanceRef.current, blockInstanceId)) {
      if (launchMarksRef.current)
        resetLaunchMarks(launchMarksRef.current, nowMs(), isDocumentHidden());
    }
    launchInstanceRef.current = blockInstanceId;
  }, [blockInstanceId]);

  // 🔴 HIDDEN-TAB LATCH — sticky from mount until the beacon reads it.
  //
  // A run page opened in a background tab (cmd-click, session restore, a tab
  // group reopened) gets throttled timers and reports a BLOCK_READY seconds late
  // at ZERO user-felt cost. Without this the p95 measures tab-switching.
  //
  // Deliberately NOT the existing visibilitychange listener further down: that
  // one is gated on `status === 'ready'`, i.e. it starts listening only AFTER
  // the launch window it would need to observe has closed. This one is
  // unconditional and mount-scoped.
  useEffect(() => {
    const marks = launchMarksRef.current;
    if (!marks) return;
    const handler = () => {
      if (isDocumentHidden()) marks.wasHidden = true;
    };
    document.addEventListener('visibilitychange', handler);
    return () => document.removeEventListener('visibilitychange', handler);
  }, []);

  // Launch mark: the END of the token-mint leg (first non-null token). The leg
  // races the frame load; it does not precede it.
  useEffect(() => {
    const marks = launchMarksRef.current;
    if (!marks || !token || marks.tokenAt !== null) return;
    marks.tokenAt = nowMs();
  }, [token]);

  // `statusRef` is kept current in the RENDER BODY above (see the 🔴 note there —
  // an effect is exactly the deferral this component was losing messages to).
  // This effect keeps ONLY the reachedReady latch, which deliberately wants the
  // COMMITTED status: for the same reason the impression beacon does (see its
  // comment), keying off a setStatus updater's side effect silently drops the
  // observation whenever another state update is already queued on this component.
  useEffect(() => {
    if (status === 'ready') reachedReadyRef.current = true;
  }, [status]);

  /**
   * The ONE way a message handler asks "is the host ready?".
   *
   * Reads the RENDER-BODY-updated `statusRef` rather than closing over `status`,
   * so the answer is current the moment the render that made the host ready is
   * committed — not one scheduler task later, when React gets around to flushing
   * passive effects and re-registering the listener with a fresh closure.
   *
   * Stable identity (`[]` deps, ref read only) is load-bearing in its own right:
   * it lets the four gated effects DROP `status` from their dependency arrays, so
   * they now subscribe ONCE per mount instead of tearing down and re-registering
   * on every status transition. The window this fix is about cannot exist if the
   * listener never needs replacing.
   */
  const readGateStatus = useCallback(() => toHostGateStatus(statusRef.current), []);

  // BOUNDED AUTO-RETRY — the single decision both consumers read (the scheduling
  // effect near `handleRetry`, and the render-FAILURE beacon below), so they can
  // never disagree about whether the host has SETTLED on this terminal state.
  // `canRemint` is whether a token re-mint is even wired: without it an auth
  // terminal can never be recovered, so we must not burn an attempt on it.
  const canRemint = onRetryToken != null;
  const autoRetry = useMemo(
    () =>
      decideAutoRetry({
        status,
        attempts: autoRetryBudget.attempts,
        reminted: autoRetryBudget.reminted,
        canRemint,
      }),
    [status, autoRetryBudget.attempts, autoRetryBudget.reminted, canRemint]
  );
  /** True once the host has stopped auto-recovering: this terminal state is final. */
  const autoRetrySettled = autoRetry.kind === 'none';

  // LAUNCH REVEAL — `prefers-reduced-motion: reduce` collapses the whole thing to
  // 0ms: no transition is ever emitted, and the overlay is dropped on the effect
  // tick right after the block turns ready rather than being held for a fade.
  // (Not literally the same commit as the status flip — but with `opacity: 0` and
  // no transition it is already invisible, so there is nothing to perceive.)
  // `initialValue: true` is deliberate and fail-SAFE: `useMediaQuery` commits the
  // real value in a post-mount effect, so render 1 has to assume something.
  // Assuming "reduced" means a viewer who opted out of motion never gets a single
  // frame with a transition/transform applied; a viewer who didn't loses nothing,
  // because the reveal only runs on BLOCK_READY, long after that first commit.
  const reduceMotion = useReducedMotion(true);
  const revealMs = reduceMotion ? 0 : LAUNCH_REVEAL_MS;
  // The branded launch overlay stays mounted for ONE fade-out after BLOCK_READY,
  // then unmounts. It is only ever rendered inside the `showIframe` branch, so
  // every terminal state removes it structurally regardless of this flag — this
  // state exists solely to give the ready path something to fade.
  const [overlayMounted, setOverlayMounted] = useState<boolean>(true);
  useEffect(() => {
    if (status === 'loading') {
      setOverlayMounted(true);
      return;
    }
    // Terminal states (or reduced motion) → drop it immediately, no timer.
    if (status !== 'ready' || revealMs === 0) {
      setOverlayMounted(false);
      return;
    }
    const t = setTimeout(() => setOverlayMounted(false), revealMs);
    return () => clearTimeout(t);
  }, [status, revealMs]);

  const expectedOrigin = useMemo(() => {
    try {
      return new URL(iframeSrc).origin;
    } catch {
      return '';
    }
  }, [iframeSrc]);

  // The `src` actually rendered: the publisher's src plus the init-fragment
  // fast path, but ONLY when this block+surface is gated on for it. Off by
  // default for every block, and unconditionally off for `dev-tunnel`.
  // `expectedOrigin` above is deliberately derived from the BASE src so the
  // postMessage target can never be influenced by the fragment.
  //
  // The page host's render mode is `'iframe'` by construction — the literal
  // this component already puts in its BLOCK_INIT payload below.
  const renderedIframeSrc = useBlockIframeSrc(
    iframeSrc,
    { theme, renderMode: 'iframe', blockInstanceId },
    blockInitFragmentEnabled({ surface, blockId, slug })
  );

  // The EFFECTIVE sandbox handed to the iframe attribute below. Derive the
  // transport's opaque-origin mode from the SAME string so the two can never
  // drift: unverified (no allow-same-origin) → opaque frame → opaque transport;
  // internal/verified (has allow-same-origin) → real origin → pinned transport.
  const effectiveSandbox = useMemo(
    () => intersectSandbox(sandbox, trustTier),
    [sandbox, trustTier]
  );
  const opaqueOrigin = useMemo(
    () => effectiveSandboxIsOpaque(effectiveSandbox),
    [effectiveSandbox]
  );

  const { send, onMessage } = usePostMessage({ iframeRef, expectedOrigin, opaqueOrigin });

  // App Blocks Analytics Phase 2 — fire-and-forget block render/impression.
  // Emitted exactly once per mount at the BLOCK_READY transition (see the
  // BLOCK_READY effect below) via the lightweight /api/track/block-render beacon
  // (NOT a tRPC mutation — this fires per model-page-with-a-block view and per
  // /apps/run load, so at GA it must skip the full tRPC middleware chain; mirrors
  // the #2680 addView -> beacon move). `isAnon`/`userId` are derived/stamped
  // server-side in the route; the client only passes the three identifiers. This
  // host only mounts behind the `appBlocks` (+ `appBlocksPages`) gate (SSR
  // fail-closed in [[...path]].tsx), so the event is dark behind the same flag as
  // the rest of App Blocks.

  // #3/#6: the scopes the minted JWT ACTUALLY carries (declared − missing).
  // See pageBlockHostLogic.grantedPageScopes. Posting `[]` (the old hardcode)
  // lied to the block about its capabilities.
  const grantedScopes = useMemo<string[]>(
    () => grantedPageScopes(declaredScopes, missingScopes),
    [declaredScopes, missingScopes]
  );

  // Current sub-path under /apps/run/<slug>/<...path> (no leading slash). Read
  // from the router so a popstate / back-forward reflects into the block.
  const subPath = useMemo(() => {
    const raw = router.query.path;
    if (Array.isArray(raw)) return raw.join('/');
    if (typeof raw === 'string') return raw;
    return '';
  }, [router.query.path]);

  // 🔴 THIS CONTEXT IS NOT PROJECTED, AND THAT IS THE SECOND IDENTITY CHANNEL.
  // `IframeHost` runs its slot context through `projectBlockInitContext`, whose
  // allowlist DROPS `viewerUserId` / `viewerUsername`; this host emits them
  // verbatim. So the `@deprecated` markers on `BlockInitPayload.viewer.id` /
  // `.username` reduce unconditional identity disclosure on the model slot and by
  // ZERO here — a full-page block learns who is looking at it from `context`
  // whether or not it ever touches `viewer`.
  //
  // Deliberately left in place rather than quietly dropped: these are published
  // SDK contract fields on `PageContext`, and the deployed-population enumeration
  // that justifies every other keep/drop call in this payload was run for the
  // `viewer` object, NOT for `context.viewerUserId`. Removing them needs a
  // PAGE-SHAPED allowlist (the model allowlist would strip `slug` / `subPath` /
  // `entityType` and break deep-linking) plus that enumeration. Tracked on the
  // `PageContext.viewerUserId` @deprecated note; pinned as present-today by
  // PageBlockHostInitContractV2.browser.test.tsx so the removal cannot be silent.
  const buildContext = useCallback(
    (): PageContext => ({
      slotId: 'app.page',
      entityType: 'none',
      slug,
      subPath,
      viewerUserId: viewer?.id ?? null,
      viewerUsername: viewer?.username ?? null,
      theme,
    }),
    [slug, subPath, viewer, theme]
  );

  const buildInitPayload = useCallback(
    (): BlockInitPayload => ({
      blockInstanceId,
      blockId,
      appId,
      token: {
        // initSent only fires after token is present (gated below); the
        // controller posts the freshest payload via the ref.
        raw: token ?? '',
        // #3/#6: the REAL granted scopes the JWT carries (page = viewer-scoped
        // ambient `apps:storage:*`; never money). Posting `[]` lied to the block
        // about the capabilities it holds.
        scopes: grantedScopes,
        expiresAt: expiresAt ?? '',
      },
      context: buildContext(),
      settings: { publisherSettings: {}, userSettings: {} },
      // 🔴 THE SECOND PRODUCER OF THE BLOCK_INIT `viewer` OBJECT. Unlike
      // IframeHost — which derives it from the slot context via
      // `projectBlockInitViewer` — this host receives an ALREADY-RESOLVED
      // `viewer` prop from the /apps/run/[slug] route and used to pass it
      // straight through. So the v2 `signedIn` flag added inside
      // `projectBlockInitViewer` would have reached the model-slot surface only,
      // and every full-page app would have shipped a viewer object without it —
      // the classic half-fleet miss this file's THEME_CHANGE comment describes.
      // Routing through the SHARED `withSignedInFlag` helper is what makes the
      // two surfaces incapable of drifting: neither host stamps the object by
      // hand. `null` (anonymous) passes through as `null`.
      viewer: withSignedInFlag(viewer),
      theme,
      renderMode: 'iframe',
      // Advisory maturity signal — server-authoritative values from the mint.
      ...projectBlockInitMaturity({ domain, maxBrowsingLevel }),
    }),
    [
      appId,
      blockId,
      blockInstanceId,
      buildContext,
      expiresAt,
      grantedScopes,
      token,
      viewer,
      theme,
      domain,
      maxBrowsingLevel,
    ]
  );
  buildInitPayloadRef.current = buildInitPayload;

  const sendInitOnce = useCallback(() => {
    initSentRef.current = true;
    // Launch mark: the FIRST BLOCK_INIT post. The controller re-posts every
    // INIT_RETRY_INTERVAL_MS until acked, so only the first stamp is kept —
    // `init_wait` is meant to include the re-post quantization, not exclude it.
    const marks = launchMarksRef.current;
    if (marks && marks.initSentAt === null) marks.initSentAt = nowMs();
    // 🔴 COUNT EVERY POST, not just the first — this is the whole point of the
    // field. `initSentAt` above is stamped once because `init_wait` must span
    // the re-post quantization; `initPosts` counts the posts INSIDE that span,
    // which is what tells a quantized wait apart from a slow-booting block.
    //
    // Counted HERE rather than read off `controller.postCount()` at ack time
    // because the auto-retry path builds a fresh controller per attempt while
    // these marks persist across the whole launch — see `LaunchMarks.initPosts`.
    if (marks) marks.initPosts += 1;
    send('BLOCK_INIT', (buildInitPayloadRef.current ?? (() => undefined as never))());
  }, [send]);

  // 🔴 DECLARED BEFORE THE INIT-HANDSHAKE EFFECT ON PURPOSE, and IframeHost
  // places it the same way. React runs effects in declaration order, so on the
  // FIRST commit this must run while `initSentRef` is still false — otherwise
  // the gate in it is INERT on mount and the host emits a redundant
  // THEME_CHANGE immediately after its own BLOCK_INIT. Measured: with this
  // effect declared after the init effect the mount sequence was
  // BLOCK_INIT → TOKEN_REFRESH → THEME_CHANGE. (The TOKEN_REFRESH in that
  // sequence is pre-existing and out of scope here.) Moving this effect below
  // the init effect silently re-creates that, which is why
  // `PageBlockHostThemeChange.browser.test.tsx` asserts the mount sequence.
  // Push a THEME_CHANGE when the viewer toggles light/dark WHILE the block is
  // mounted. `theme` is a PROP — the route computes it from
  // `useComputedColorScheme`, so it changes on a toggle and re-renders us.
  //
  // Without this the block keeps its mount-time theme until reloaded: BLOCK_INIT
  // is deduped SDK-side (only the first is honored) and `useBlockIframeSrc`
  // deliberately FREEZES the URL fragment at mount, so neither existing channel
  // can carry a later value.
  //
  // 🔴 THE SAME WIRING MUST EXIST IN IframeHost.tsx (the model-slot surface).
  // The two hosts do NOT share a bridge — each registers its own postMessage
  // handlers by hand (the gotcha-#73 class `hostHandlerParity.ts` documents) —
  // so wiring one and not the other leaves half the blocks stuck.
  // `hostHandlerParity` cannot catch this one: its INVENTORY covers block→host
  // messages, and this is a host→block push. The per-surface browser tests are
  // the coverage.
  //
  // Gated on `initSentRef` for the same reason TOKEN_REFRESH is: before the FIRST
  // BLOCK_INIT post there is nothing to talk to. (Note the guard flips on that
  // POST, not on BLOCK_READY — so a toggle between the post and the ack does
  // push, into a frame that may not be listening yet. That is harmless and NOT
  // the safety net: `buildInitPayload` reads `theme` fresh on every retry tick,
  // so the BLOCK_INIT the block finally accepts carries the current theme
  // regardless of whether any push was heard.)
  // Deliberately NOT gated on `reviewMode`: the theme is neither
  // side-effecting nor private, and the review sandbox should render in the
  // moderator's own color scheme like every other surface.
  useEffect(() => {
    if (!initSentRef.current) return;
    send('THEME_CHANGE', { theme });
  }, [theme, send]);

  // Init handshake — start once token is present (no checkpoint dependency for
  // a page). Retry-until-BLOCK_READY via the shared controller.
  useEffect(() => {
    if (!shouldStartInit({ status, hasToken: !!token, checkpointLoading: false })) return;
    if (controllerRef.current) return;
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
  }, [token, status, sendInitOnce]);

  // #3/#6: the mint errored (no token will arrive). Surface an `error` state
  // immediately rather than waiting out the no_token timeout — a hard mint
  // failure is terminal. (`needsConsent` is NOT terminal: the token still mints
  // with the granted subset, so the block loads; we only thread the consent
  // signal into the wrapped scopes above.)
  useEffect(() => {
    if (!tokenError || token) return;
    setStatus((current) => (current === 'loading' ? 'error' : current));
  }, [tokenError, token]);

  // MID-SESSION credential loss. The effect above only escalates a host still in
  // `loading`, so a token that died AFTER the block went `ready` left the host
  // parked on `ready` holding nothing: the `TOKEN_REFRESH` push early-returns on
  // `!token`, so the block kept its now-dead credential and silently 401'd every
  // call — no signal to the user, none to the platform.
  //
  // 🔴 GATED ON `tokenTerminal`, NOT `tokenError`. The upstream hook now retries a
  // failed refresh on a bounded backoff and KEEPS a still-valid token while it
  // does, so a transient blip never reaches here at all. Only once recovery has
  // provably settled with nothing usable left do we replace the running app with
  // the real terminal state — which also re-arms the bounded auto-retry below
  // (an `error` status is an AUTH terminal, so its one automatic attempt spends a
  // re-mint) and surfaces the prominent manual Retry once that settles too.
  //
  // 🔴 THE IMPRESSION BEACON IS STILL EXACTLY ONE. A host that reached `ready`
  // already fired its ONE `ok` impression, and `blockRenderEmittedRef` is
  // per-mount — so the launch-failure beacon below remains inert here by
  // construction, and the `ok` already sent still means what it always meant
  // (the page load succeeded — which it did). The teardown is reported by the
  // SEPARATE mid-session beacon effect immediately after this one, on its own
  // latch, so observability is gained without touching impression accounting.
  useEffect(() => {
    if (!tokenTerminal || token) return;
    setStatus((current) => (current === 'ready' ? 'error' : current));
  }, [tokenTerminal, token]);

  // MID-SESSION credential-loss render beacon — the observability half of the
  // teardown above.
  //
  // 🔴 WHY THIS EXISTS AT ALL (measured on production 2026-07-31): a real
  // revocation teardown was driven end-to-end against a live app and the
  // platform recorded ZERO error beacons for it. The only trace of the incident
  // was the earlier successful `ok` impression, so every render metric said the
  // app was healthy while it was dead in the viewer's tab. A mid-session
  // teardown is exactly the failure mode a third-party app platform must be able
  // to see — it is what a delist/suspend/revoke looks like from the runtime.
  //
  // Keys off the COMMITTED `status` (not a setStatus updater's side effect) for
  // the same batching reason documented on the impression beacon below. The full
  // decision — including WHY it is gated on `reachedReady` and on the settled
  // `tokenTerminal` rather than a bare `tokenError` — lives in the pure,
  // unit-tested `shouldEmitMidSessionLossBeacon`.
  useEffect(() => {
    if (
      !shouldEmitMidSessionLossBeacon({
        status,
        reachedReady: reachedReadyRef.current,
        tokenTerminal,
        hasToken: !!token,
        alreadyEmitted: midSessionLossEmittedRef.current,
      })
    )
      return;
    midSessionLossEmittedRef.current = true;
    // Fire-and-forget beacon — failures are a no-op. `errorClass` is a member of
    // the server-side KNOWN_ERROR_CLASSES allowlist, so it survives as a real
    // `error_class` prom label instead of collapsing into 'other'.
    //
    // 🔴 `secondary: true` is REQUIRED here, not decorative. This mount already
    // sent its `ok` impression, and the `blockRenders` CH row carries no status —
    // so without this flag the follow-up would write a SECOND byte-identical row
    // for one mount, un-de-duplicatable, inflating every CH-derived impression
    // figure for exactly the sessions that were revoked. The flag keeps the prom
    // counter firing (that is what the alert reads) while skipping the insert.
    sendBlockRender({
      appBlockId,
      blockInstanceId,
      slotId: 'app.page',
      status: 'error',
      errorClass: MID_SESSION_LOSS_ERROR_CLASS,
      secondary: true,
    });
  }, [status, tokenTerminal, token, appBlockId, blockInstanceId]);

  // Token never resolves → surface a no_token state instead of an endless
  // skeleton.
  useEffect(() => {
    if (status !== 'loading' || token) return;
    const t = setTimeout(() => {
      setStatus((current) => (current === 'loading' && !token ? 'no_token' : current));
    }, TOKEN_WAIT_TIMEOUT_MS);
    return () => clearTimeout(t);
  }, [status, token]);

  // Push a TOKEN_REFRESH when the token rotates after init.
  useEffect(() => {
    if (!initSentRef.current || !token) return;
    send('TOKEN_REFRESH', {
      token: { raw: token, scopes: grantedScopes, expiresAt: expiresAt ?? '' },
    });
  }, [token, expiresAt, grantedScopes, send]);

  // Answer a block-initiated REQUEST_TOKEN.
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
  // as the rotation push above (which is the only path that ever actually
  // delivered a token in this case), and it does not put an unanswerable
  // `TOKEN_REFRESH_RESPONSE` on the wire for the SDK to discard.
  //
  // 🔴 IframeHost.tsx CARRIES THE SAME LOGIC AND MUST STAY IN STEP. The two
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
      const wrapped = { raw: token, scopes: grantedScopes, expiresAt: expiresAt ?? '' };
      if (requestId === undefined) {
        send('TOKEN_REFRESH', { token: wrapped });
        return;
      }
      send('TOKEN_REFRESH_RESPONSE', { requestId, token: wrapped });
    });
    return off;
  }, [token, expiresAt, grantedScopes, send, onMessage]);

  // INVERTED HANDSHAKE: the block announces that its message listener is
  // attached (`BLOCK_HELLO`) and we push BLOCK_INIT in response rather than
  // waiting out the current retry tick.
  //
  // 🔴 PURELY ADDITIVE — see `IframeInitController.notifyHello`. The immediate
  // post on start(), the retry interval and the readiness timeout are all
  // unchanged, so a block that never announces (older SDK) behaves exactly as
  // today and a block that announces but never acks still times out.
  //
  // 🔴 THE RETRY LOOP IS STILL DOING ALMOST ALL OF THE WORK, and the number
  // behind that claim was re-measured. An earlier revision of this comment said
  // "as of 2026-08-05 no deployed block sends BLOCK_HELLO"; that is now stale.
  // MEASURED 2026-08-31 against the deployed fleet: 4 of 23 deployed blocks
  // ship the accelerator — so 19 do not, including two hand-rolled
  // `civitai-host.js` shims and one inline-shell app.
  //
  // Treat that as a DATED MEASUREMENT, not a standing fact: it moves whenever a
  // block is rebuilt and re-approved. Its consequence is what matters here —
  // getting the remaining 19 onto the accelerator is 19 separate
  // rebuild-and-moderator-approve cycles, so the host-side re-post cadence
  // (`INIT_RETRY_BACKOFF_MS`) is the only lever that reaches every deployed app
  // immediately.
  useEffect(() => {
    const off = onMessage<unknown>('BLOCK_HELLO', () => {
      // 🔴 RECORDED BEFORE — AND INDEPENDENTLY OF — THE CONTROLLER, deliberately.
      // The label means "the guest announced during this launch", NOT "the
      // accelerator fired an extra post". `notifyHello()` is a no-op when the
      // controller has not started, has stopped, or has already handled a hello;
      // recording inside it would file those launches as `no` even though the
      // guest's listener was demonstrably attached and the host's next post was
      // heard. That is the wrong bucket, and it biases the comparison toward the
      // null. See `LaunchMarks.helloSeen` for the full argument.
      const marks = launchMarksRef.current;
      if (marks) marks.helloSeen = true;
      controllerRef.current?.notifyHello();
    });
    return off;
  }, [onMessage]);

  // BLOCK_READY → ready.
  useEffect(() => {
    const off = onMessage<unknown>('BLOCK_READY', () => {
      // Launch mark: stamped HERE, in the message handler, not in the beacon
      // effect. The beacon fires on the committed `status`, which is a React
      // commit later — timing it there would fold an arbitrary amount of React
      // scheduling into every sample.
      const marks = launchMarksRef.current;
      if (marks && marks.readyAt === null) marks.readyAt = nowMs();
      setStatus((current) => (current === 'loading' ? 'ready' : current));
      // Block acked — stop re-posting BLOCK_INIT and cancel the readiness
      // timeout. Called UNCONDITIONALLY (not behind a "did this ack win the
      // transition" flag): `notifyReady()` is documented-idempotent
      // (IframeInitController.notifyReady → stop(), a no-op once stopped), and
      // making it unconditional removes the only remaining dependence on
      // observing the updater's side effect (see the note below).
      controllerRef.current?.notifyReady();
    });
    return off;
  }, [onMessage]);

  // Analytics Phase 2 — render/impression beacon: ONE per host mount, fired on
  // the loading→ready transition and mutually exclusive with the render-FAILURE
  // beacon below (they share `blockRenderEmittedRef`).
  //
  // 🔴 WHY THIS IS AN EFFECT AND NOT A SIDE EFFECT INSIDE THE BLOCK_READY
  // HANDLER (a real bug this fixes, not a refactor): it used to live inside the
  // handler behind an `acked` flag that the `setStatus` UPDATER set —
  //     let acked = false;
  //     setStatus((current) => { if (current === 'loading') { acked = true; … } });
  //     if (acked) { …sendBlockRender… }
  // — which only works because React *eagerly* evaluates an updater when the
  // fiber has no other pending update. As soon as ANY unrelated state update is
  // already queued on this component when BLOCK_READY lands, React skips that
  // eager path, the updater runs later during render, `acked` is still false at
  // the `if`, and **the impression is silently dropped**. The host has plenty of
  // such updates in flight in the real world (token rotation, the image-scan
  // poller list, the launch-reveal state) — this was latent analytics loss, and
  // was reproduced deterministically the moment the launch-reveal work added one
  // more post-mount state update. Keying off the COMMITTED `status` is immune to
  // batching. Mirrors the failure-beacon effect immediately below.
  //
  // 🔴 LAUNCH TIMINGS RIDE THIS BEACON — no second beacon, no second call site,
  // no second ClickHouse row. `blockRenderEmittedRef` is untouched, `secondary`
  // is untouched, `error_class` is untouched, and the impression count is
  // provably unchanged: this is the same one-per-mount emit it always was, with
  // an optional field attached.
  //
  // `timings` is null (and omitted) whenever the sample must not be observed —
  // a hidden tab, a missing mark, an out-of-range delta. The launch is still
  // reported as an impression; only the latency observation is skipped. That is
  // the right asymmetry: an under-counted histogram is honest, a histogram
  // padded with zeros is not.
  useEffect(() => {
    if (status !== 'ready') return;
    if (blockRenderEmittedRef.current) return;
    blockRenderEmittedRef.current = true;
    const marks = launchMarksRef.current;
    const timings = marks ? computeLaunchTimings(marks) : null;
    // Fire-and-forget beacon — failures are a no-op.
    sendBlockRender({
      appBlockId,
      blockInstanceId,
      slotId: 'app.page',
      ...(timings ? { timings } : {}),
    });
  }, [status, appBlockId, blockInstanceId]);

  // BLOCK_ERROR{fatal:true} → fatal.
  useEffect(() => {
    const off = onMessage<unknown>('BLOCK_ERROR', (raw) => {
      if (raw && typeof raw === 'object' && (raw as { fatal?: unknown }).fatal === true) {
        setStatus((current) => (current === 'loading' || current === 'ready' ? 'fatal' : current));
      }
    });
    return off;
  }, [onMessage]);

  // App Blocks runtime observability — render-FAILURE beacon. The success beacon
  // fires at BLOCK_READY above (guarded by `blockRenderEmittedRef`). Here we fire
  // the mutually-exclusive `error` beacon when the page host lands on a terminal-
  // failure state: the iframe never reached BLOCK_READY ('timeout'), the block
  // reported a fatal error ('fatal'), its token never resolved ('no_token'), or
  // the mint hard-failed ('error'). Sharing the SAME emit-once ref makes ok/error
  // mutually exclusive per mount. Fire-and-forget (beacon swallows failures).
  //
  // 🔴 BEACON SEMANTICS UNDER AUTO-RETRY (deliberate, and what the alert on
  // `civitai_app_block_renders_total` measures):
  //   ONE beacon per host MOUNT, reporting the outcome the host SETTLES on. The
  //   whole bounded automatic retry sequence is ONE logical page load:
  //     - `ok`    — the first BLOCK_READY, whichever attempt produced it. A load
  //                 that succeeds on attempt 2 emits exactly one `ok`, never an
  //                 `error` first.
  //     - `error` — a terminal state reached with NO further automatic attempt
  //                 coming (`autoRetrySettled`). N failed automatic attempts
  //                 therefore emit ONE `error`, not N.
  //     - nothing — an intermediate terminal state that will be auto-retried.
  //   Once either fires, the mount never emits again: `handleRetry` (user-initiated,
  //   after the host already settled) deliberately does NOT reset the emit-once ref.
  //   So the metric's denominator stays "page loads" and its numerator stays "page
  //   loads the platform could not recover on its own" — which is the thing worth
  //   paging on. Manual user retries are a separate, currently-unmeasured signal.
  //
  // 🔴 TWO KNOWN COSTS OF THAT CHOICE, stated so they aren't rediscovered as bugs:
  //   1. UNMOUNT DURING THE SEQUENCE EMITS NOTHING. A user who navigates away
  //      while a retry is pending produces no beacon at all, where before they
  //      produced an `error`. The window grew from ~0s to the length of the whole
  //      bounded sequence. There is no unmount flush today (adding one is the
  //      obvious follow-up — `sendBlockRender` already sets `keepalive:true`
  //      precisely so a beacon survives unload).
  //   2. THE `error` NUMERATOR NOW MEANS SOMETHING NARROWER — "failures the
  //      platform could not self-recover", not "failures". A regression that only
  //      increases TRANSIENT launch failures is invisible to a ratio built on it.
  //      The `BlockRenderFailureRate` alert in datapacket-talos still describes it
  //      the old way; its wording needs a companion update.
  useEffect(() => {
    if (status !== 'timeout' && status !== 'fatal' && status !== 'no_token' && status !== 'error')
      return;
    // Another automatic attempt is scheduled — the host has NOT settled yet.
    if (!autoRetrySettled) return;
    if (blockRenderEmittedRef.current) return;
    blockRenderEmittedRef.current = true;
    sendBlockRender({
      appBlockId,
      blockInstanceId,
      slotId: 'app.page',
      status: 'error',
      // Kept within the server-side KNOWN_ERROR_CLASSES enum
      // (timeout|fatal|no_token|error) — the auto-retry adds no new class, so the
      // existing `error_class` prom label and its alert are unchanged.
      errorClass: status,
    });
  }, [status, autoRetrySettled, appBlockId, blockInstanceId]);

  // MOD REVIEW SANDBOX — anti-spam latch for the reduced-permissions notice in
  // the consent handler below. Bounded to at most TWO per host MOUNT (one generic
  // + one scope-named upgrade — see `advanceReviewConsentLatch`). The review
  // chrome remounts the host on a render-only ↔ run-for-real flip, so each mode
  // gets its own budget, and the notification ids are mode-specific to match.
  const reviewConsentLatchRef = useRef(INITIAL_REVIEW_CONSENT_LATCH);
  // Lazy consent (A6): the block (rendered in full for a logged-in viewer whose
  // page token is missing a consent-gated scope, e.g. `ai:write:budgeted` once
  // the page money scope is enabled) asks the host to open the consent UI when
  // the user clicks an action that needs that capability (e.g. Generate),
  // instead of a prompt on load. Mirrors IframeHost's REQUEST_CONSENT handler
  // exactly: we grant ONLY the missing set the MINT computed (`missingScopes` —
  // server-known truth), NOT any scopes the block claims; the gate also pins
  // status === 'ready' so a pre-handshake block can't pop a permission modal
  // before any interaction (same posture as NAVIGATE). On grant we re-mint the
  // token (onConsentGranted → useBlockToken.refresh); the new scopes flow to the
  // iframe via the TOKEN_REFRESH push above and the block retries — there is no
  // host→block reply (fire-and-forget).
  //
  // This was the W10 page-consent gap: the page surface (#2606) carried no money
  // scopes, so no consent handler was needed; #2612 enabled the page money scope
  // but never ported this handler from IframeHost, so REQUEST_CONSENT fired into
  // the void and the block hung on "confirm in the Civitai dialog".
  useEffect(() => {
    const off = onMessage<{ scopes?: unknown } | undefined>('REQUEST_CONSENT', (payload) => {
      // `readGateStatus()` (not a closed-over `status`) — see its definition: it
      // reads the render-body-updated mirror, so it is current at COMMIT rather
      // than one scheduler task later. The 'error' → 'no_token' collapse lives in
      // `toHostGateStatus`, one place for all four gates.
      const gateStatus = readGateStatus();
      // Only act on a post-handshake request; a pre-handshake block never gets a
      // modal OR a toast (same posture as the consent gate itself).
      //
      // NO NACK HERE, deliberately. REQUEST_CONSENT is fire-and-forget in both
      // directions: the SDK sends it with `dispatch` (blocks-react 0.39.0
      // `useRequestConsent`), its payload is `{ scopes? }` with NO requestId, and
      // there is no host→block reply message for it — so there is nothing to
      // reply TO and no promise to fail fast. Dropping it cannot hang the block.
      if (gateStatus !== 'ready') return;

      // reviewMode: a consent grant re-mints the token with WIDER scopes — never
      // let untrusted review code pop a permission modal at the mod. That stays
      // absolute; the request is still fire-and-forget (dropping the GRANT never
      // hangs the block). What changed: dropping it SILENTLY meant the reviewer
      // got nothing at all — no modal, no toast, no error — while the app parked
      // forever on its consent card, which reads as "this app is broken" rather
      // than "the preview deliberately withholds this permission". So review mode
      // now emits a PASSIVE, non-interactive notice (never a modal, nothing to
      // click, no scope is granted) pointing at the existing opt-in escape hatch.
      if (reviewMode) {
        const notice = resolveReviewConsentNotice(payload?.scopes, grantedScopes);
        if (!notice.notify) return;
        // 🔴 ANTI-SPAM (required, not a nicety): the reviewed app is UNTRUSTED
        // code and can post REQUEST_CONSENT in a loop, so one toast per message
        // would let a hostile submission carpet-bomb the reviewing mod's screen
        // (and bury the review chrome). The latch caps this at TWO notices per
        // host mount — one generic, plus at most one upgrade to the scope-NAMED
        // copy. It is NOT a plain "already notified" boolean: the SDK's `scopes`
        // hint is optional, so a hint-less request on load would otherwise win
        // the latch and permanently suppress the later, informative one.
        const { show, next } = advanceReviewConsentLatch(
          reviewConsentLatchRef.current,
          notice.scopes.length > 0
        );
        reviewConsentLatchRef.current = next;
        if (!show) return;
        // `notice.scopes` is filtered to the known block-scope vocabulary, so no
        // attacker-controlled text can reach this string; Mantine renders
        // `message` as React text (escaped) — never as HTML.
        const notification = buildReviewConsentNotification({
          appBlockId,
          runForReal: reviewRunForReal,
          scopes: notice.scopes,
        });
        // Upgrade path only: retire the generic notice this one replaces, so the
        // reviewer sees ONE notice, not a stack. A no-op when it already closed.
        if (notification.supersedesId) hideNotification(notification.supersedesId);
        showNotification({
          id: notification.id,
          color: 'yellow',
          title: notification.title,
          message: notification.message,
        });
        return;
      }

      const scopesToGrant = resolveRequestConsent(gateStatus, missingScopes ?? []);
      if (scopesToGrant != null) {
        dialogStore.trigger({
          component: BlockConsentModal,
          props: {
            appBlockId,
            // PageBlockHost surfaces the app name as `appName` (the model host
            // uses `install.manifest.name`).
            blockName: appName,
            missingScopes: scopesToGrant,
            onGranted: () => {
              onConsentGranted?.();
            },
          },
        });
        return;
      }
      // Issue B — nothing is grantable-via-consent. Distinguish the BENIGN case
      // (the block re-requested a scope it ALREADY holds → keep the silent no-op)
      // from the UN-GRANTABLE case (a requested scope was clamped/withheld at mint
      // and can never be added via consent here — e.g. a dev-tunnel preview token
      // that doesn't carry it). Only the latter, proven from the block's advisory
      // `scopes` hint, surfaces a message so the app doesn't silently look dead.
      const ungrantable = resolveUngrantableConsentNotice(
        payload?.scopes,
        grantedScopes,
        missingScopes
      );
      if (!ungrantable.notify) return; // already-granted or no hint — drop
      // 🔴 Tell the BLOCK, not just the viewer. The toast below renders in the
      // HOST frame; before this push nothing came back over the bridge, so the
      // block could not tell "the user hasn't confirmed the dialog yet" from
      // "this environment will never grant this scope" — and its own UI went on
      // telling the developer to retry an action that can never succeed, right
      // next to a host toast saying the opposite. This is a fire-and-forget PUSH
      // (REQUEST_CONSENT carries no `requestId`, so there is nothing to correlate
      // a `*_RESULT` reply to), matching the other uncorrelated host→block pushes
      // (`TOKEN_REFRESH`, `ROUTE_CHANGED`, `SUSPEND`/`RESUME`).
      //
      // It ADDS a channel — the toast is unchanged. The BENIGN already-granted
      // case returns above and stays silent in BOTH channels: a block that got a
      // message there would render a permission-unavailable state over a
      // permission that actually works.
      //
      // Sent BEFORE the toast so the block's signal cannot be lost to a throwing
      // notification layer. That ordering is pinned by
      // `PageBlockHost.browser.test.tsx` → "the CONSENT_UNAVAILABLE push happens
      // BEFORE the toast", which asserts the order of the SYNCHRONOUS calls; a
      // spy on the delivered message cannot see it (delivery is async).
      //
      // 🔴 WHAT `scopes` IS. It is NOT the block's raw hint. `notify` above is
      // decided on the full un-grantable set (requested − granted − missing), but
      // `ungrantable.scopes` is that set filtered to the known block-scope
      // vocabulary — the hint is untrusted block input and this payload is
      // rendered by block UI, so nothing outside the fixed vocabulary is echoed
      // back out of the host. The two are deliberately different sets: when every
      // requested scope is unrecognised this still sends, with `scopes: []`. The
      // refusal is the signal; the names are advisory. Delivered solely to the
      // frame that asked.
      send('CONSENT_UNAVAILABLE', { reason: 'ungrantable', scopes: ungrantable.scopes });
      showNotification({
        color: 'yellow',
        title: 'Permission unavailable',
        message: 'This app requested a permission that isn’t available in this preview.',
      });
    });
    return off;
    // `status` is deliberately ABSENT: the handler reads it through
    // `readGateStatus` (a render-body-updated ref) instead of closing over it, so
    // this subscribes ONCE per mount. Re-registering on every status transition is
    // what opened the commit→passive-effect window in the first place.
  }, [
    onMessage,
    send,
    readGateStatus,
    missingScopes,
    grantedScopes,
    appBlockId,
    appName,
    onConsentGranted,
    reviewMode,
    reviewRunForReal,
  ]);

  // Deep-link bridge — block requests in-page navigation. The block may push a
  // new sub-path WITHIN its own page space; we constrain it to the page route so
  // a block can't navigate the host off to an arbitrary path. `path` is an
  // untrusted same-origin sub-path: reject absolute URLs, protocol-relative
  // (`//`), and `..` traversal. Shallow routing keeps the page mounted (no SSR
  // round-trip) and the subPath change reflects back into the block via the
  // popstate handler below.
  useEffect(() => {
    const off = onMessage<{ path?: unknown } | undefined>('NAVIGATE', (raw) => {
      // reviewMode: the review host is a MODAL, not the `/apps/run/<slug>` page —
      // let a block yank the mod's router and it would navigate them off the
      // review flow (to a page a pending app doesn't even have). Fire-and-forget
      // ⇒ dropping it never hangs the block.
      if (reviewMode) return;
      // FIFTH status-gated handler (the four money/permission gates are the
      // others) — it reads the same render-body mirror for the same reason. No
      // NACK: NAVIGATE is fire-and-forget with no requestId, so a drop is
      // incapable of hanging the block.
      if (readGateStatus() !== 'ready') return; // pre-handshake blocks can't drive nav
      const rawPath = raw && typeof raw === 'object' ? (raw as { path?: unknown }).path : undefined;
      if (typeof rawPath !== 'string') return;
      // Normalize: strip a single leading slash; reject anything unsafe.
      const cleaned = rawPath.replace(/^\/+/, '');
      if (cleaned.startsWith('/') || cleaned.includes('//') || cleaned.split('/').includes('..')) {
        return;
      }
      const target = cleaned
        ? `/apps/run/${encodeURIComponent(slug)}/${cleaned}`
        : `/apps/run/${encodeURIComponent(slug)}`;
      void router.push(target, undefined, { shallow: true });
    });
    return off;
    // `status` deliberately absent — see the REQUEST_CONSENT deps note.
  }, [onMessage, readGateStatus, router, slug, reviewMode]);

  // Forward host-side navigation (back/forward, or our own shallow push) into
  // the block so it can re-render the right view. Fires whenever the resolved
  // subPath changes AFTER init.
  useEffect(() => {
    if (!initSentRef.current || status !== 'ready') return;
    send('ROUTE_CHANGED', { subPath });
  }, [subPath, status, send]);

  // #5: page-visibility SUSPEND / RESUME — tell the block to pause work when its
  // tab is hidden and resume when shown (mirrors IframeHost). Only wired once the
  // block is ready so a pre-handshake block isn't told to suspend/resume before
  // it can listen.
  useEffect(() => {
    if (status !== 'ready') return;
    const handler = () => {
      if (document.visibilityState === 'visible') send('RESUME');
      else send('SUSPEND');
    };
    document.addEventListener('visibilitychange', handler);
    return () => document.removeEventListener('visibilitychange', handler);
  }, [status, send]);

  // SUSPEND on unmount.
  useEffect(() => {
    return () => {
      if (initSentRef.current) send('SUSPEND');
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Money path: the @civitai/blocks-react useBuzzWorkflow bridge ───────────
  //
  // This was the SECOND W10 page gap (after consent). #2606 shipped pages with
  // NO money scopes, so the workflow bridge wasn't needed; #2612 added the
  // page-money server runtime + #2615 ported consent — but this host never
  // ported the workflow handlers from IframeHost. A page block calling
  // estimate/submit/poll/cancel (via useBuzzWorkflow) posts
  // ESTIMATE_WORKFLOW / SUBMIT_WORKFLOW / POLL_WORKFLOW / CANCEL_WORKFLOW into
  // the void → no blocks.* tRPC call → the SDK request hung to its 120s timeout
  // with no network call and no error. We mirror IframeHost EXACTLY: forward to
  // the same blocks.* mutations with the page `token` prop as `blockToken`, and
  // every path (success OR thrown) MUST post a reply (failure-shape snapshot via
  // failureSnapshot on throw) so the block's transport never hangs.
  //
  // Server-side blocks.{estimate,submit,poll,cancel}Workflow already enforce the
  // page token's scope + budget + entitlement gate (#2612); the host just
  // forwards the (untrusted, server-schema-validated) `body`/`workflowId` + the
  // token. No client-side gating is added here.
  //
  // token is a PROP here (string | null) — PageBlockHost does NOT use
  // useBlockToken (that's the page route). A null token means the block never
  // rendered a usable money surface; we drop such a request without a reply (the
  // block can't have legitimately fired a workflow without a token, and the mint
  // path surfaces no_token/error terminal states above). A missing requestId is
  // likewise dropped without replying — mirrors IframeHost.
  const submitWorkflowMutation = trpc.blocks.submitWorkflow.useMutation();
  const estimateWorkflowMutation = trpc.blocks.estimateWorkflow.useMutation();
  const pollWorkflowMutation = trpc.blocks.pollWorkflow.useMutation();
  const cancelWorkflowMutation = trpc.blocks.cancelWorkflow.useMutation();
  // getMyBuzzBalance is a MUTATION (not a query) DELIBERATELY: the block JWT is a
  // bearer credential a .query would leak into the ?input=… URL / logs / Referer
  // where it's replayable within its TTL. See blocks.router getMyBuzzBalance.
  const getMyBuzzBalanceMutation = trpc.blocks.getMyBuzzBalance.useMutation();
  // Buzz self-read bridges (a Buzz-dashboard page app): ledger / all-pool
  // balances / per-model earnings. MUTATIONS for the same bearer-token reason as
  // getMyBuzzBalance; each requires the `buzz:read:self` scope server-side.
  const getMyBuzzTransactionsMutation = trpc.blocks.getMyBuzzTransactions.useMutation();
  const getMyBuzzAccountsMutation = trpc.blocks.getMyBuzzAccounts.useMutation();
  const getMyDailyCompensationMutation = trpc.blocks.getMyDailyCompensation.useMutation();
  // Viewer self-read bridge (a page block reading "who am I") — backs the SDK
  // `useViewer()` hook and is the host-mediated successor to GET /blocks/me. A
  // MUTATION for the same bearer-token reason as getMyBuzzBalance; requires the
  // `user:read:self` scope server-side.
  const getMyViewerMutation = trpc.blocks.getMyViewer.useMutation();
  // App generator SUBQUEUE bridges (tag-scoped). queryAppWorkflows reads the
  // calling app's OWN slice of the viewer's generation queue (the SERVER forces
  // the per-app `app-block:<appId>` tag filter — a block can't widen it);
  // cancelAppWorkflow stops one, FAIL-CLOSED behind the server ownership+tag
  // guard. MUTATIONS for the same bearer-token-in-URL reason as the other
  // block-token bridges (a .query would leak the JWT into the ?input= URL).
  const queryAppWorkflowsMutation = trpc.blocks.queryAppWorkflows.useMutation();
  const cancelAppWorkflowMutation = trpc.blocks.cancelAppWorkflow.useMutation();
  // Model-Benchmarking shared-grid bridges. publishGenerationOutputs turns the
  // app's OWN workflow outputs into bare, real-scanned public images (FAIL-CLOSED
  // behind the server ownership+tag guard; host-chrome consent BEFORE the call);
  // getImagesByIds reads those ids back under the requesting viewer's browsing-
  // level clamp (the server never returns an unclamped url). MUTATIONS for the
  // same bearer-token-in-URL reason as the other block-token bridges.
  const publishGenerationOutputsMutation = trpc.blocks.publishGenerationOutputs.useMutation();
  const getImagesByIdsMutation = trpc.blocks.getImagesByIds.useMutation();

  // Wildcard-pack import (W13). SESSION-authed (protectedProcedure) — it does NOT
  // take a block token; the viewer's real cookie session authenticates, which is
  // the whole point (the real download gates apply). A MUTATION deliberately: the
  // response carries a short-lived signed URL (see the router comment).
  const resolveWildcardPackMutation = trpc.generation.resolveWildcardPack.useMutation();
  // Collection follow/unfollow bridge (SET_COLLECTION_FOLLOW). SESSION-authed
  // (protectedProcedure), like resolveWildcardPack above and for the same reason:
  // these are the SAME procedures the site's own follow button calls, so the
  // handler self-binds to `ctx.user.id` server-side and reuses
  // `addContributorToCollection` / `removeContributorFromCollection` verbatim.
  // The block token is deliberately NOT involved — the point of this bridge is
  // that a block needs no `collections:write:self` scope.
  const followCollectionMutation = trpc.collection.follow.useMutation();
  const unfollowCollectionMutation = trpc.collection.unfollow.useMutation();
  // In-flight fetch+parse count for the concurrency cap below. A ref (not state)
  // so incrementing/decrementing never re-renders and the count is read
  // synchronously in the message handler (JS is single-threaded, so the
  // check→increment before the first await is atomic per message).
  const wildcardInFlightRef = useRef<number>(0);

  // SUBMIT_WORKFLOW → blocks.submitWorkflow → WORKFLOW_SUBMITTED.
  useEffect(() => {
    const off = onMessage<
      { requestId?: unknown; body?: unknown; idempotencyKey?: unknown } | undefined
    >('SUBMIT_WORKFLOW', async (raw) => {
      if (reviewNack) {
        // Real Buzz spend — NACK with the failure snapshot the block awaits so
        // it fails fast (never a hang) and never reaches submitWorkflowMutation.
        if (raw && typeof raw.requestId === 'string') {
          send('WORKFLOW_SUBMITTED', {
            requestId: raw.requestId,
            snapshot: failureSnapshot(new Error(REVIEW_NACK_MESSAGE)),
          });
        }
        return;
      }
      if (!raw || typeof raw.requestId !== 'string' || !token) return;
      const requestId = raw.requestId;
      // Idempotency (item 2, gen half): forward the OPTIONAL client key to the
      // server so a lost-response retry collapses to one Buzz charge. Host-first:
      // accept it defensively (only when a non-empty string) so older SDKs that
      // never send it are unaffected and a garbage value is ignored.
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
        send('WORKFLOW_SUBMITTED', { requestId, snapshot: failureSnapshot(err) });
      }
    });
    return off;
  }, [onMessage, send, token, submitWorkflowMutation, reviewNack]);

  // ESTIMATE_WORKFLOW → blocks.estimateWorkflow → ESTIMATE_RESULT.
  useEffect(() => {
    const off = onMessage<{ requestId?: unknown; body?: unknown } | undefined>(
      'ESTIMATE_WORKFLOW',
      async (raw) => {
        if (reviewNack) {
          if (raw && typeof raw.requestId === 'string') {
            send('ESTIMATE_RESULT', {
              requestId: raw.requestId,
              snapshot: failureSnapshot(new Error(REVIEW_NACK_MESSAGE)),
            });
          }
          return;
        }
        if (!raw || typeof raw.requestId !== 'string' || !token) return;
        const requestId = raw.requestId;
        try {
          const { snapshot } = await estimateWorkflowMutation.mutateAsync({
            blockToken: token,
            body: raw.body as never,
          });
          send('ESTIMATE_RESULT', { requestId, snapshot });
        } catch (err) {
          send('ESTIMATE_RESULT', { requestId, snapshot: failureSnapshot(err) });
        }
      }
    );
    return off;
  }, [onMessage, send, token, estimateWorkflowMutation, reviewNack]);

  // POLL_WORKFLOW → blocks.pollWorkflow → WORKFLOW_STATUS.
  useEffect(() => {
    const off = onMessage<{ requestId?: unknown; workflowId?: unknown } | undefined>(
      'POLL_WORKFLOW',
      async (raw) => {
        if (reviewNack) {
          if (raw && typeof raw.requestId === 'string') {
            send('WORKFLOW_STATUS', {
              requestId: raw.requestId,
              snapshot: failureSnapshot(new Error(REVIEW_NACK_MESSAGE)),
            });
          }
          return;
        }
        if (
          !raw ||
          typeof raw.requestId !== 'string' ||
          typeof raw.workflowId !== 'string' ||
          raw.workflowId.length === 0 ||
          !token
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
          send('WORKFLOW_STATUS', { requestId, snapshot: failureSnapshot(err) });
        }
      }
    );
    return off;
  }, [onMessage, send, token, pollWorkflowMutation, reviewNack]);

  // CANCEL_WORKFLOW → blocks.cancelWorkflow → WORKFLOW_CANCELED. Ownership is
  // enforced server-side by the viewer's orchestrator token.
  useEffect(() => {
    const off = onMessage<{ requestId?: unknown; workflowId?: unknown } | undefined>(
      'CANCEL_WORKFLOW',
      async (raw) => {
        if (reviewNack) {
          if (raw && typeof raw.requestId === 'string') {
            send('WORKFLOW_CANCELED', {
              requestId: raw.requestId,
              snapshot: failureSnapshot(new Error(REVIEW_NACK_MESSAGE)),
            });
          }
          return;
        }
        if (
          !raw ||
          typeof raw.requestId !== 'string' ||
          typeof raw.workflowId !== 'string' ||
          raw.workflowId.length === 0 ||
          !token
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
          send('WORKFLOW_CANCELED', { requestId, snapshot: failureSnapshot(err) });
        }
      }
    );
    return off;
  }, [onMessage, send, token, cancelWorkflowMutation, reviewNack]);

  // QUERY_APP_WORKFLOWS → blocks.queryAppWorkflows → APP_WORKFLOWS_RESULT. The
  // app's OWN tag-scoped generation subqueue (host page token + SERVER-forced
  // per-app tag; a block can't widen the filter — the input has no `tags` field).
  // params are spread FIRST then blockToken LAST so a block-sent
  // `params.blockToken` can never override the authoritative page token (mirrors
  // GET_BUZZ_TRANSACTIONS). REQUEST-style ⇒ every path MUST reply or the block
  // hangs; on a null token we reply with the ERROR variant rather than dropping.
  useEffect(() => {
    const off = onMessage<{ requestId?: unknown; params?: unknown } | undefined>(
      'QUERY_APP_WORKFLOWS',
      async (raw) => {
        if (!raw || typeof raw.requestId !== 'string') return;
        const requestId = raw.requestId;
        if (reviewNack) {
          // The app's generation subqueue read — NACK (workflow family, and the
          // synthetic review appId has no queue anyway). Error-shape reply, no hang.
          send('APP_WORKFLOWS_RESULT', { requestId, error: REVIEW_NACK_MESSAGE });
          return;
        }
        if (!token) {
          send('APP_WORKFLOWS_RESULT', { requestId, error: 'no block token' });
          return;
        }
        try {
          // params (cursor/limit) are schema-validated server-side; the host never
          // trusts them. blockToken spread LAST — non-overridable page token.
          const result = await queryAppWorkflowsMutation.mutateAsync({
            ...((raw.params as Record<string, unknown>) ?? {}),
            blockToken: token,
          } as never);
          send('APP_WORKFLOWS_RESULT', { requestId, result });
        } catch (err) {
          send('APP_WORKFLOWS_RESULT', {
            requestId,
            error: err instanceof Error ? err.message : 'unknown',
          });
        }
      }
    );
    return off;
  }, [onMessage, send, token, queryAppWorkflowsMutation, reviewNack]);

  // CANCEL_APP_WORKFLOW → blocks.cancelAppWorkflow → CANCEL_APP_WORKFLOW_RESULT.
  // FAIL-CLOSED server-side (ownership + app-tag guard — the orchestrator by-id
  // endpoints don't check ownership, so the router compensates). The host just
  // forwards the (untrusted, server-validated) workflowId + the page token.
  // REQUEST-style ⇒ reply on every path; on a null token we reply with the ERROR
  // variant. A missing/empty workflowId is dropped without a reply (mirrors
  // CANCEL_WORKFLOW — there's nothing legitimate to cancel).
  useEffect(() => {
    const off = onMessage<{ requestId?: unknown; workflowId?: unknown } | undefined>(
      'CANCEL_APP_WORKFLOW',
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
        if (reviewNack) {
          send('CANCEL_APP_WORKFLOW_RESULT', { requestId, error: REVIEW_NACK_MESSAGE });
          return;
        }
        if (!token) {
          send('CANCEL_APP_WORKFLOW_RESULT', { requestId, error: 'no block token' });
          return;
        }
        try {
          const result = await cancelAppWorkflowMutation.mutateAsync({
            blockToken: token,
            workflowId: raw.workflowId,
          });
          send('CANCEL_APP_WORKFLOW_RESULT', { requestId, result });
        } catch (err) {
          send('CANCEL_APP_WORKFLOW_RESULT', {
            requestId,
            error: err instanceof Error ? err.message : 'unknown',
          });
        }
      }
    );
    return off;
  }, [onMessage, send, token, cancelAppWorkflowMutation, reviewNack]);

  // PUBLISH_GENERATION_OUTPUTS → blocks.publishGenerationOutputs → PUBLISH_RESULT.
  // Turn the app's OWN workflow outputs into bare, real-scanned public images.
  // 🔴 HOST-CHROME CONSENT: publishing is user content shown to OTHER viewers, so
  // the host opens its OWN confirm dialog and only calls the mutation on an
  // explicit click — that click IS the consent boundary (the iframe can't fake
  // it, like the resource picker). The block sends INDEXES not urls; the SERVER
  // resolves urls + is FAIL-CLOSED behind the ownership+app-tag guard. REQUEST-
  // style ⇒ every terminal path (no token / cancel / success / error) MUST reply
  // exactly once or the block hangs; a `settled` latch guards a double-reply.
  useEffect(() => {
    const off = onMessage<{ requestId?: unknown; workflowId?: unknown } | undefined>(
      'PUBLISH_GENERATION_OUTPUTS',
      (raw) => {
        const req = resolvePublishGenerationOutputsRequest(raw);
        if (!req) return; // missing requestId / workflowId — drop, nothing to publish
        const { requestId, workflowId, imageIndexes } = req;
        if (!token) {
          send('PUBLISH_RESULT', { requestId, error: 'no block token' });
          return;
        }
        let settled = false;
        const reply = (payload: Record<string, unknown>) => {
          if (settled) return;
          settled = true;
          send('PUBLISH_RESULT', { requestId, ...payload });
        };
        const count = imageIndexes?.length;
        const noun = count == null ? 'these results' : `${count} result${count === 1 ? '' : 's'}`;
        dialogStore.trigger({
          component: ConfirmDialog,
          props: {
            title: 'Publish to the shared grid?',
            message: `Publish ${noun} to ${
              appName ? `“${appName}”` : 'this app'
            }’s shared grid? Published images are scanned and become visible to other viewers of this app.`,
            labels: { confirm: 'Publish', cancel: 'Cancel' },
            confirmProps: { color: 'blue' },
            onConfirm: async () => {
              try {
                const result = await publishGenerationOutputsMutation.mutateAsync({
                  blockToken: token,
                  workflowId,
                  ...(imageIndexes ? { imageIndexes } : {}),
                });
                reply({ result });
              } catch (err) {
                reply({ error: err instanceof Error ? err.message : 'unknown' });
              }
            },
            // Dismiss (Cancel / X / escape) = consent declined → settle the
            // block's promise with an explicit signal rather than leaving it to time out.
            onCancel: () => reply({ error: 'publish canceled' }),
          },
        });
      }
    );
    return off;
  }, [onMessage, send, token, appName, publishGenerationOutputsMutation]);

  // GET_IMAGES_BY_IDS → blocks.getImagesByIds → IMAGES_RESULT. Per-viewer gated
  // read of the shared-grid image ids. The SERVER self-binds the viewer + applies
  // their browsing-level clamp (an above-ceiling / unscanned / flagged image comes
  // back `hidden` with NO url). An empty (post-sanitization) id list short-circuits
  // to an empty result — never hitting the server schema (which requires ≥1 id).
  // REQUEST-style ⇒ reply on every path; on a null token we reply with the error variant.
  useEffect(() => {
    const off = onMessage<{ requestId?: unknown; imageIds?: unknown } | undefined>(
      'GET_IMAGES_BY_IDS',
      async (raw) => {
        const req = resolveGetImagesByIdsRequest(raw);
        if (!req) return; // missing/non-string requestId — drop
        const { requestId, imageIds } = req;
        if (imageIds.length === 0) {
          send('IMAGES_RESULT', { requestId, result: { images: [] } });
          return;
        }
        if (!token) {
          send('IMAGES_RESULT', { requestId, error: 'no block token' });
          return;
        }
        try {
          const result = await getImagesByIdsMutation.mutateAsync({ blockToken: token, imageIds });
          send('IMAGES_RESULT', { requestId, result });
        } catch (err) {
          send('IMAGES_RESULT', {
            requestId,
            error: err instanceof Error ? err.message : 'unknown',
          });
        }
      }
    );
    return off;
  }, [onMessage, send, token, getImagesByIdsMutation]);

  // GET_BUZZ_BALANCE → blocks.getMyBuzzBalance → BUZZ_BALANCE_RESULT. The block's
  // per-account (blue/green/yellow) balance read that backs the SDK
  // `useBuzzBalance()` hook + the account-picker UI, so a money page block can
  // show the viewer which wallet a generation will draw from. Host-MEDIATED: the
  // iframe never sees a session; the balance is derived from the token's SELF-
  // BOUND `sub` server-side (never client input). REQUEST-style ⇒ every path MUST
  // post a reply or the block hangs to its SDK timeout.
  //
  // DEVIATION from the workflow handlers (which DROP a `!token` request silently):
  // a balance read is a pure UI affordance, not a spend — dropping it strands the
  // hook with no data and no error. So on a null token we reply with the ERROR
  // variant (`error: <message>`) instead of dropping, mirroring the storage
  // handlers' error-carrying result shape. A missing requestId is still dropped
  // without replying (mirrors every other handler — there's nothing to reply to).
  useEffect(() => {
    const off = onMessage<{ requestId?: unknown } | undefined>('GET_BUZZ_BALANCE', async (raw) => {
      if (!raw || typeof raw.requestId !== 'string') return;
      const requestId = raw.requestId;
      if (reviewNack) {
        // Private financial read — NACK (the review token has no buzz:read:self).
        send('BUZZ_BALANCE_RESULT', { requestId, error: REVIEW_NACK_MESSAGE });
        return;
      }
      if (!token) {
        send('BUZZ_BALANCE_RESULT', { requestId, error: 'no block token' });
        return;
      }
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
  }, [onMessage, send, token, getMyBuzzBalanceMutation, reviewNack]);

  // GET_BUZZ_TRANSACTIONS → blocks.getMyBuzzTransactions → BUZZ_TRANSACTIONS_RESULT.
  // The Buzz-dashboard ledger read. Host-MEDIATED (the iframe never holds the
  // scope-gated token's power directly); the server self-binds off the token
  // `sub` + requires `buzz:read:self`. REQUEST-style ⇒ every path MUST reply or
  // the block hangs; on a null token we reply with the ERROR variant (mirrors
  // GET_BUZZ_BALANCE) rather than dropping. A missing requestId is dropped.
  useEffect(() => {
    const off = onMessage<{ requestId?: unknown; params?: unknown } | undefined>(
      'GET_BUZZ_TRANSACTIONS',
      async (raw) => {
        if (!raw || typeof raw.requestId !== 'string') return;
        const requestId = raw.requestId;
        if (reviewNack) {
          send('BUZZ_TRANSACTIONS_RESULT', { requestId, error: REVIEW_NACK_MESSAGE });
          return;
        }
        if (!token) {
          send('BUZZ_TRANSACTIONS_RESULT', { requestId, error: 'no block token' });
          return;
        }
        try {
          // params are schema-validated server-side; the host never trusts them.
          // blockToken is spread LAST so a block-sent `params.blockToken` can never
          // override the host's authoritative page token (mirrors submitWorkflow's
          // non-overridable token). blockToken is host-injected only — no
          // legitimate input field shares that name.
          const result = await getMyBuzzTransactionsMutation.mutateAsync({
            ...((raw.params as Record<string, unknown>) ?? {}),
            blockToken: token,
          } as never);
          send('BUZZ_TRANSACTIONS_RESULT', { requestId, result });
        } catch (err) {
          send('BUZZ_TRANSACTIONS_RESULT', {
            requestId,
            error: err instanceof Error ? err.message : 'unknown',
          });
        }
      }
    );
    return off;
  }, [onMessage, send, token, getMyBuzzTransactionsMutation, reviewNack]);

  // GET_BUZZ_ACCOUNTS → blocks.getMyBuzzAccounts → BUZZ_ACCOUNTS_RESULT. All-pool
  // balances (spendable + creator payout pools). Same host-mediated + consent +
  // reply-always contract as GET_BUZZ_TRANSACTIONS.
  useEffect(() => {
    const off = onMessage<{ requestId?: unknown } | undefined>('GET_BUZZ_ACCOUNTS', async (raw) => {
      if (!raw || typeof raw.requestId !== 'string') return;
      const requestId = raw.requestId;
      if (reviewNack) {
        send('BUZZ_ACCOUNTS_RESULT', { requestId, error: REVIEW_NACK_MESSAGE });
        return;
      }
      if (!token) {
        send('BUZZ_ACCOUNTS_RESULT', { requestId, error: 'no block token' });
        return;
      }
      try {
        const result = await getMyBuzzAccountsMutation.mutateAsync({ blockToken: token });
        send('BUZZ_ACCOUNTS_RESULT', { requestId, result });
      } catch (err) {
        send('BUZZ_ACCOUNTS_RESULT', {
          requestId,
          error: err instanceof Error ? err.message : 'unknown',
        });
      }
    });
    return off;
  }, [onMessage, send, token, getMyBuzzAccountsMutation, reviewNack]);

  // GET_DAILY_COMPENSATION → blocks.getMyDailyCompensation → DAILY_COMPENSATION_RESULT.
  // Per-modelVersion generation earnings for the month of `date`. Same contract.
  useEffect(() => {
    const off = onMessage<{ requestId?: unknown; params?: unknown } | undefined>(
      'GET_DAILY_COMPENSATION',
      async (raw) => {
        if (!raw || typeof raw.requestId !== 'string') return;
        const requestId = raw.requestId;
        if (reviewNack) {
          // Private per-model earnings — NACK (buzz-read family; no scope granted).
          send('DAILY_COMPENSATION_RESULT', { requestId, error: REVIEW_NACK_MESSAGE });
          return;
        }
        if (!token) {
          send('DAILY_COMPENSATION_RESULT', { requestId, error: 'no block token' });
          return;
        }
        try {
          // blockToken spread LAST — host page token is authoritative, a block-sent
          // `params.blockToken` can never override it (see GET_BUZZ_TRANSACTIONS).
          const result = await getMyDailyCompensationMutation.mutateAsync({
            ...((raw.params as Record<string, unknown>) ?? {}),
            blockToken: token,
          } as never);
          send('DAILY_COMPENSATION_RESULT', { requestId, result });
        } catch (err) {
          send('DAILY_COMPENSATION_RESULT', {
            requestId,
            error: err instanceof Error ? err.message : 'unknown',
          });
        }
      }
    );
    return off;
  }, [onMessage, send, token, getMyDailyCompensationMutation, reviewNack]);

  // GET_VIEWER → blocks.getMyViewer → VIEWER_RESULT. The block's "who am I" read
  // that backs the SDK `useViewer()` hook — the host-mediated successor to the
  // GET /blocks/me REST call, so a page block can render the viewer's name /
  // gate write UI on their moderation status without holding the scope directly.
  // Host-MEDIATED: the iframe never sees a session; the identity is derived from
  // the token's SELF-BOUND `sub` server-side (never client input), gated on the
  // `user:read:self` scope. GET_VIEWER takes NO params, so only the host page
  // token is forwarded (a block-sent field can't override it). REQUEST-style ⇒
  // every path MUST reply or the block hangs to its SDK timeout: on a null token
  // we reply with the ERROR variant (mirrors GET_BUZZ_BALANCE) rather than
  // dropping. A missing requestId is still dropped without replying.
  useEffect(() => {
    const off = onMessage<{ requestId?: unknown } | undefined>('GET_VIEWER', async (raw) => {
      if (!raw || typeof raw.requestId !== 'string') return;
      const requestId = raw.requestId;
      if (!token) {
        send('VIEWER_RESULT', { requestId, error: 'no block token' });
        return;
      }
      try {
        const viewer = await getMyViewerMutation.mutateAsync({ blockToken: token });
        send('VIEWER_RESULT', { requestId, viewer });
      } catch (err) {
        send('VIEWER_RESULT', {
          requestId,
          error: err instanceof Error ? err.message : 'unknown',
        });
      }
    });
    return off;
  }, [onMessage, send, token, getMyViewerMutation]);

  // OPEN_BUZZ_PURCHASE → BUZZ_PURCHASE_RESULT. The generator's insufficient-Buzz
  // top-up CTA. Gate on BLOCK_READY (+ payload validity) via the shared
  // resolveBuzzPurchaseRequest predicate so a pre-handshake block can't summon
  // the spend modal before any interaction (same posture as the model host).
  //
  // DEVIATION from IframeHost (intentional, documented): the model host derives
  // earnings attribution from the install context (deriveScopeFromInstanceId on
  // the `mbi_*`/`bus_*`/`pdb_*` instanceId prefix + modelId/slotId). The PAGE
  // instanceId is `page_<appBlockId>`, which deriveScopeFromInstanceId does NOT
  // recognise → returns null → attribution is omitted, exactly as IframeHost
  // already handles an unknown prefix ("skip attribution; the webhook treats it
  // as a regular buzz purchase"). There is no page-scoped earnings bucket today,
  // so a page top-up is an unattributed purchase. We invent NO new attribution
  // behavior — when/if a page earnings scope exists, extend
  // deriveScopeFromInstanceId (the single client-side prefix→scope mapper) and
  // this falls through automatically.
  useEffect(() => {
    const off = onMessage<{ requestId?: unknown; suggestedAmount?: unknown } | undefined>(
      'OPEN_BUZZ_PURCHASE',
      (raw) => {
        if (reviewNack) {
          // Real-money top-up — never summon the Buy-Buzz modal at the mod. Reply
          // the not-purchased result the block awaits (fail-fast, no hang).
          if (raw && typeof raw.requestId === 'string') {
            send('BUZZ_PURCHASE_RESULT', { requestId: raw.requestId, purchased: false });
          }
          return;
        }
        // `readGateStatus()` (not a closed-over `status`) — see its definition.
        const gateStatus = readGateStatus();
        const requestId = resolveBuzzPurchaseRequest(gateStatus, raw);
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
          // `purchased: false` is exactly the reply the reviewMode branch above
          // already sends for its own refusal, and exactly what the SDK's
          // `useBuzzPurchase` reads as "no purchase happened". Refusing is
          // unchanged — no modal opens, nothing is charged; the block just finds
          // out now instead of in 30 seconds.
          if (raw && typeof raw.requestId === 'string' && raw.requestId.length > 0) {
            send('BUZZ_PURCHASE_RESULT', { requestId: raw.requestId, purchased: false });
          }
          return;
        }
        const rawAmount =
          typeof raw.suggestedAmount === 'number' && Number.isFinite(raw.suggestedAmount)
            ? raw.suggestedAmount
            : undefined;
        const amount =
          rawAmount != null
            ? Math.min(Math.max(Math.floor(rawAmount), 0), BUZZ_PURCHASE_AMOUNT_CAP)
            : undefined;
        // Page instanceId prefix is unrecognised → null → no attribution (see
        // the DEVIATION note above). Kept structurally identical to IframeHost
        // so a future page-scope only needs the prefix mapper extended.
        const scope = deriveScopeFromInstanceId(blockInstanceId);
        const attribution = scope
          ? {
              appId,
              appBlockId,
              blockInstanceId,
              scope,
            }
          : undefined;
        let purchased = false;
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
    // `status` deliberately absent — see the REQUEST_CONSENT deps note.
  }, [onMessage, send, readGateStatus, appId, appBlockId, blockInstanceId, reviewNack]);

  // ── Sign-in bridge: REQUEST_SIGN_IN (anonymous conversion) ─────────────────
  //
  // This was the THIRD W10 page gap. The page route renders for LOGGED-OUT
  // viewers (the BLOCK_INIT context is viewer-scoped with viewer:null when anon),
  // but PageBlockHost had no REQUEST_SIGN_IN handler — so a logged-out viewer who
  // clicks an action needing auth/money (e.g. Generate) dead-ended: the block
  // posted REQUEST_SIGN_IN into the void and the login modal never opened. We
  // mirror IframeHost EXACTLY: the shared resolveRequestSignIn gate pins
  // status === 'ready' (a pre-handshake block can't pop a login modal before any
  // interaction) and sanitises a block-supplied returnUrl to a same-origin in-app
  // path (absolute / protocol-relative values are dropped → LoginModal defaults
  // returnUrl to the current page). Fire-and-forget — there is no host→block
  // reply. The `'error' → 'no_token'` status shim is reused (PageBlockHost's local
  // Status carries the extra terminal 'error' variant the shared HostStatus union
  // doesn't model; the gate only ever opens when status === 'ready', so this is
  // semantics-preserving — same shim as the consent + buzz handlers).
  useEffect(() => {
    const off = onMessage<{ returnUrl?: unknown } | undefined>('REQUEST_SIGN_IN', (raw) => {
      // `readGateStatus()` (not a closed-over `status`) — see its definition.
      const gateStatus = readGateStatus();
      const resolved = resolveRequestSignIn(gateStatus, raw);
      // NO NACK HERE, deliberately — same reason as REQUEST_CONSENT. The SDK
      // sends this with `dispatch` (blocks-react 0.39.0 `useRequestSignIn`), the
      // payload is `{ returnUrl? }` with NO requestId, and there is no host→block
      // reply message for it. Nothing to reply to; a drop cannot hang the block.
      if (resolved == null) return; // not ready — drop (gate centralises the rules)
      // Hub-driven login (popup to auth.civitai.com). Falls back to the current page when the
      // block didn't supply a sanitised same-origin returnUrl. `reason` rides to the hub for the
      // LoginRedirect funnel analytics.
      const here = window.location.pathname + window.location.search + window.location.hash;
      openLoginPopup(resolved.returnUrl ?? here, 'image-gen');
    });
    return off;
    // `status` deliberately absent — see the REQUEST_CONSENT deps note.
  }, [onMessage, readGateStatus]);

  // ── App Blocks KV datastore bridge (W4-v0) ─────────────────────────────────
  //
  // This was the FOURTH W10 page gap (the next message-into-the-void after
  // consent + workflow). PageBlockHost advertises `apps:storage:*` in BLOCK_INIT
  // and the page mint signs `apps:storage:read/write`, but the host had NO
  // storage handlers — so a storage-using page block (e.g. the Notepad page)
  // posting APP_STORAGE_GET/SET/DELETE/LIST/QUOTA fired into the void and hung to
  // the SDK's 30s timeout. We mirror IframeHost EXACTLY: five host-mediated
  // handlers (the iframe never sees the apps DB credentials), each replying with
  // the SAME requestId on BOTH the success and the error path — errors are
  // reported as `error: <string>` on the result payload (never thrown upward) so
  // the block-side hook rejects instead of stranding the bridge.
  //
  // token is a PROP here (string | null) — PageBlockHost does NOT use
  // useBlockToken (that's the page route). apps.storage.* require a non-null
  // blockToken (z.string().min(1)); a null token means the block never rendered a
  // usable surface, so each handler drops a `!token` request without replying
  // (consistent with the #2618 workflow handlers — the mint path surfaces
  // no_token/error terminal states above). A missing requestId is likewise
  // dropped without replying (mirrors IframeHost).
  const trpcUtils = trpc.useUtils();
  const storageSetMutation = trpc.apps.storage.set.useMutation();
  const storageDeleteMutation = trpc.apps.storage.delete.useMutation();

  // APP_STORAGE_GET → apps.storage.get → APP_STORAGE_GET_RESULT.
  useEffect(() => {
    const off = onMessage<{ requestId?: unknown; key?: unknown } | undefined>(
      'APP_STORAGE_GET',
      async (raw) => {
        if (reviewNack) {
          // Per-user App Storage — NACK in render-only review. Under run-for-real
          // this runs the REAL op (the token carries apps:storage:* and the server
          // resolves a disposable per-preview namespace). Error-shape.
          if (raw && typeof raw.requestId === 'string') {
            send('APP_STORAGE_GET_RESULT', {
              requestId: raw.requestId,
              value: null,
              error: REVIEW_NACK_MESSAGE,
            });
          }
          return;
        }
        if (!raw || typeof raw.requestId !== 'string' || typeof raw.key !== 'string' || !token)
          return;
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
  }, [onMessage, send, token, trpcUtils, reviewNack]);

  // APP_STORAGE_SET → apps.storage.set → APP_STORAGE_SET_RESULT.
  useEffect(() => {
    const off = onMessage<{ requestId?: unknown; key?: unknown; value?: unknown } | undefined>(
      'APP_STORAGE_SET',
      async (raw) => {
        if (reviewNack) {
          if (raw && typeof raw.requestId === 'string') {
            send('APP_STORAGE_SET_RESULT', {
              requestId: raw.requestId,
              ok: false,
              error: REVIEW_NACK_MESSAGE,
            });
          }
          return;
        }
        if (!raw || typeof raw.requestId !== 'string' || typeof raw.key !== 'string' || !token)
          return;
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
  }, [onMessage, send, token, trpcUtils, storageSetMutation, reviewNack]);

  // APP_STORAGE_DELETE → apps.storage.delete → APP_STORAGE_DELETE_RESULT.
  useEffect(() => {
    const off = onMessage<{ requestId?: unknown; key?: unknown } | undefined>(
      'APP_STORAGE_DELETE',
      async (raw) => {
        if (reviewNack) {
          if (raw && typeof raw.requestId === 'string') {
            send('APP_STORAGE_DELETE_RESULT', {
              requestId: raw.requestId,
              ok: false,
              deleted: false,
              error: REVIEW_NACK_MESSAGE,
            });
          }
          return;
        }
        if (!raw || typeof raw.requestId !== 'string' || typeof raw.key !== 'string' || !token)
          return;
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
  }, [onMessage, send, token, trpcUtils, storageDeleteMutation, reviewNack]);

  // APP_STORAGE_LIST → apps.storage.list → APP_STORAGE_LIST_RESULT.
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
      if (reviewNack) {
        if (raw && typeof raw.requestId === 'string') {
          send('APP_STORAGE_LIST_RESULT', {
            requestId: raw.requestId,
            keys: [],
            error: REVIEW_NACK_MESSAGE,
          });
        }
        return;
      }
      if (!raw || typeof raw.requestId !== 'string' || !token) return;
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
  }, [onMessage, send, token, trpcUtils, reviewNack]);

  // APP_STORAGE_QUOTA → apps.storage.getQuota → APP_STORAGE_QUOTA_RESULT.
  useEffect(() => {
    const off = onMessage<{ requestId?: unknown } | undefined>('APP_STORAGE_QUOTA', async (raw) => {
      if (reviewNack) {
        if (raw && typeof raw.requestId === 'string') {
          send('APP_STORAGE_QUOTA_RESULT', {
            requestId: raw.requestId,
            usedBytes: 0,
            rowCount: 0,
            limitBytes: 0,
            limitRows: 0,
            error: REVIEW_NACK_MESSAGE,
          });
        }
        return;
      }
      if (!raw || typeof raw.requestId !== 'string' || !token) return;
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
  }, [onMessage, send, token, trpcUtils, reviewNack]);

  // ── App Blocks SHARED (cross-user / app-global) storage bridge (Phase 2b) ──
  //
  // The public-write sibling of the per-user KV bridge above. A page block
  // (e.g. a community "requests"/voting app, entity=none) drives the shared
  // datastore via the @civitai/app-sdk shared-storage hook, which posts
  // SHARED_LIST / GET_COUNT / GET_COUNTS / APPEND / VOTE / UNVOTE / WITHDRAW and
  // AWAITS the matching SHARED_*_RESULT. Unhandled ⇒ the block hangs to the SDK
  // 30s timeout (the gotcha-#73 "spins forever" class). We mirror the APP_STORAGE
  // handlers EXACTLY: the HOST injects the block `token` prop it already holds as
  // `blockToken` (NEVER trusts a token from the message), reads go through
  // trpc.useUtils().apps.shared.*.fetch, writes through the useMutation hooks, and
  // every reply comes back with the SAME requestId on BOTH the success path and
  // the error path (`error: <string>`, never thrown upward) so the block-side
  // hook rejects cleanly instead of stranding the bridge.
  //
  // NO client-side scope/flag gate here (mirrors APP_STORAGE): the block token
  // must carry `apps:storage:shared:*` and the dedicated fail-closed Flipt flag +
  // trust gate are enforced SERVER-side (resolveSharedContext). The only client
  // precondition is the same non-null `token` the storage handlers use — a null
  // token means the block never rendered a usable surface, so the request is
  // dropped without replying (the mint path surfaces no_token/error above).
  const sharedAppendMutation = trpc.apps.shared.append.useMutation();
  const sharedUpdateMutation = trpc.apps.shared.update.useMutation();
  const sharedVoteMutation = trpc.apps.shared.vote.useMutation();
  const sharedUnvoteMutation = trpc.apps.shared.unvote.useMutation();
  const sharedWithdrawMutation = trpc.apps.shared.withdraw.useMutation();
  const sharedReportMutation = trpc.apps.shared.report.useMutation();

  // SHARED_LIST → apps.shared.list → SHARED_LIST_RESULT (query).
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
      if (!raw || typeof raw.requestId !== 'string' || !token) return;
      const requestId = raw.requestId;
      try {
        const prefix = typeof raw.prefix === 'string' ? raw.prefix : undefined;
        // Server caps `limit` at 100; clamp client-side to match (mirrors the
        // APP_STORAGE_LIST 200-clamp against its own server max).
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

  // SHARED_GET_COUNT → apps.shared.getCount → SHARED_GET_COUNT_RESULT (query).
  useEffect(() => {
    const off = onMessage<{ requestId?: unknown; key?: unknown } | undefined>(
      'SHARED_GET_COUNT',
      async (raw) => {
        if (!raw || typeof raw.requestId !== 'string' || typeof raw.key !== 'string' || !token)
          return;
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

  // SHARED_GET_COUNTS → apps.shared.getCounts → SHARED_GET_COUNTS_RESULT (query).
  useEffect(() => {
    const off = onMessage<{ requestId?: unknown; keys?: unknown } | undefined>(
      'SHARED_GET_COUNTS',
      async (raw) => {
        if (!raw || typeof raw.requestId !== 'string' || !Array.isArray(raw.keys) || !token) return;
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

  // SHARED_APPEND → apps.shared.append → SHARED_APPEND_RESULT (mutation).
  useEffect(() => {
    const off = onMessage<{ requestId?: unknown; value?: unknown } | undefined>(
      'SHARED_APPEND',
      async (raw) => {
        if (reviewMode) {
          // Cross-user shared datastore WRITE — NACK even in run-for-real: cross-user
          // writes are NEVER granted (the run-for-real allowlist withholds
          // apps:storage:shared:write), and this host NACK is defense-in-depth on top
          // of the server resolveSharedContext 403. Shared READS stay live below.
          if (raw && typeof raw.requestId === 'string') {
            send('SHARED_APPEND_RESULT', { requestId: raw.requestId, error: REVIEW_NACK_MESSAGE });
          }
          return;
        }
        if (
          !raw ||
          typeof raw.requestId !== 'string' ||
          typeof raw.value !== 'object' ||
          raw.value === null ||
          !token
        )
          return;
        const requestId = raw.requestId;
        try {
          // Server zod-validates {title, body?}; a malformed value rejects
          // BAD_REQUEST → the error path below (never a hang).
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
  }, [onMessage, send, token, trpcUtils, sharedAppendMutation, reviewMode]);

  // SHARED_UPDATE → apps.shared.update → SHARED_UPDATE_RESULT (mutation).
  // Author-scoped in-place edit of an OWN row: the auth/author-gate/belt/quota all
  // live in apps.shared.update (server, #3146); the host only forwards {key, value}
  // and relays the result. Reply is `{ ok, error? }` (SHARED_WITHDRAW-style, NOT
  // SHARED_APPEND's `{ key }`) — the SDK hook treats `!ok || error` as reject.
  // isValidSharedUpdateResult now ACCEPTS an error reply with or without `ok`, so
  // omitting it would no longer be dropped; both paths still send `ok` because an
  // explicit `ok: false` is the clearer signal, not because it is required.
  useEffect(() => {
    const off = onMessage<{ requestId?: unknown; key?: unknown; value?: unknown } | undefined>(
      'SHARED_UPDATE',
      async (raw) => {
        if (reviewMode) {
          // Cross-user shared datastore WRITE (author-scoped edit) — NACK even in
          // run-for-real (never a cross-user write). The validator accepts an error
          // reply with or without `ok`; we send `ok: false` as the clearer signal.
          // See handler doc.
          if (raw && typeof raw.requestId === 'string') {
            send('SHARED_UPDATE_RESULT', {
              requestId: raw.requestId,
              ok: false,
              error: REVIEW_NACK_MESSAGE,
            });
          }
          return;
        }
        if (
          !raw ||
          typeof raw.requestId !== 'string' ||
          typeof raw.key !== 'string' ||
          typeof raw.value !== 'object' ||
          raw.value === null ||
          !token
        )
          return;
        const requestId = raw.requestId;
        try {
          // Server zod-validates {title, body?}; a malformed value rejects
          // BAD_REQUEST → the error path below (never a hang).
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
  }, [onMessage, send, token, trpcUtils, sharedUpdateMutation, reviewMode]);

  // SHARED_VOTE → apps.shared.vote → SHARED_VOTE_RESULT (mutation).
  useEffect(() => {
    const off = onMessage<{ requestId?: unknown; key?: unknown } | undefined>(
      'SHARED_VOTE',
      async (raw) => {
        if (reviewMode) {
          // Cross-user shared datastore WRITE (vote) — NACK even in run-for-real.
          if (raw && typeof raw.requestId === 'string') {
            send('SHARED_VOTE_RESULT', { requestId: raw.requestId, error: REVIEW_NACK_MESSAGE });
          }
          return;
        }
        if (!raw || typeof raw.requestId !== 'string' || typeof raw.key !== 'string' || !token)
          return;
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
  }, [onMessage, send, token, trpcUtils, sharedVoteMutation, reviewMode]);

  // SHARED_UNVOTE → apps.shared.unvote → SHARED_UNVOTE_RESULT (mutation).
  useEffect(() => {
    const off = onMessage<{ requestId?: unknown; key?: unknown } | undefined>(
      'SHARED_UNVOTE',
      async (raw) => {
        if (reviewMode) {
          // Cross-user shared datastore WRITE (unvote) — NACK even in run-for-real.
          if (raw && typeof raw.requestId === 'string') {
            send('SHARED_UNVOTE_RESULT', { requestId: raw.requestId, error: REVIEW_NACK_MESSAGE });
          }
          return;
        }
        if (!raw || typeof raw.requestId !== 'string' || typeof raw.key !== 'string' || !token)
          return;
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
  }, [onMessage, send, token, trpcUtils, sharedUnvoteMutation, reviewMode]);

  // SHARED_WITHDRAW → apps.shared.withdraw → SHARED_WITHDRAW_RESULT (mutation).
  useEffect(() => {
    const off = onMessage<{ requestId?: unknown; key?: unknown } | undefined>(
      'SHARED_WITHDRAW',
      async (raw) => {
        if (reviewMode) {
          // Cross-user shared datastore WRITE (withdraw) — NACK even in run-for-real.
          if (raw && typeof raw.requestId === 'string') {
            send('SHARED_WITHDRAW_RESULT', {
              requestId: raw.requestId,
              error: REVIEW_NACK_MESSAGE,
            });
          }
          return;
        }
        if (!raw || typeof raw.requestId !== 'string' || typeof raw.key !== 'string' || !token)
          return;
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
  }, [onMessage, send, token, trpcUtils, sharedWithdrawMutation, reviewMode]);

  // SHARED_GET → apps.shared.get → SHARED_GET_RESULT (query). Single-row deep-link
  // fetch-by-key. READ (anon-allowed server-side; no reviewMode NACK — reads stay
  // live). Maps the item exactly like SHARED_LIST (createdAt/updatedAt → ISO, and
  // the additive viewerVoted flows straight through). A missing/hidden row comes
  // back as `item: null` (the server applies the same hidden_at gate as list).
  useEffect(() => {
    const off = onMessage<{ requestId?: unknown; key?: unknown } | undefined>(
      'SHARED_GET',
      async (raw) => {
        if (!raw || typeof raw.requestId !== 'string' || typeof raw.key !== 'string' || !token)
          return;
        const requestId = raw.requestId;
        try {
          const result = await trpcUtils.apps.shared.get.fetch(
            {
              blockToken: token,
              key: raw.key,
            },
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

  // SHARED_REPORT → apps.shared.report → SHARED_REPORT_RESULT (mutation). A user
  // reports a posted row for mod review; the server already trust-gates + rate-
  // limits + files the report (endpoint pre-exists). Reply is SHARED_WITHDRAW-
  // style `{ ok, error? }`. The SDK accepts an error reply whether or not it
  // carries `ok` (every `{ ok, error }` validator early-accepts on a PRESENT
  // `error`), so we send `ok: false` because it is the clearer signal, NOT
  // because omitting it would hang. reviewMode NACK: report is a
  // shared:write-trust op, never granted
  // in run-for-real (mirrors the other shared writes).
  useEffect(() => {
    const off = onMessage<{ requestId?: unknown; key?: unknown; reason?: unknown } | undefined>(
      'SHARED_REPORT',
      async (raw) => {
        if (reviewMode) {
          if (raw && typeof raw.requestId === 'string') {
            send('SHARED_REPORT_RESULT', {
              requestId: raw.requestId,
              ok: false,
              error: REVIEW_NACK_MESSAGE,
            });
          }
          return;
        }
        if (!raw || typeof raw.requestId !== 'string' || typeof raw.key !== 'string' || !token)
          return;
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
  }, [onMessage, send, token, trpcUtils, sharedReportMutation, reviewMode]);

  // F2 concurrency-cap counter for SAVE_IMAGE (see the handler below). A ref (not
  // state) so increment/decrement never re-renders and the count is read
  // synchronously in the message handler (single-threaded ⇒ check→increment before
  // the first await is atomic per message), mirroring wildcardInFlightRef.
  const saveImageInFlightRef = useRef<number>(0);

  // SAVE_IMAGE → SAVE_IMAGE_RESULT (Batch-D item 1). The host downloads an image
  // the block already displays, in its UNSANDBOXED top frame (the block's sandbox
  // has no allow-downloads). TWO variants, each with its own security gate:
  //   • url  — the block's OWN output. MUST pass the civitai image/blob origin
  //            allowlist (isAllowedSaveImageUrl) — never a host-side fetch of an
  //            attacker origin (an opaque-origin block's url/data is untrusted).
  //   • id   — a cross-user grid image. Resolved through the SAME per-viewer
  //            gated read (blocks.getImagesByIds) that GET_IMAGES_BY_IDS uses, so
  //            a withheld/above-ceiling image (status !== 'visible', or omitted)
  //            can NEVER be saved.
  // A NON-download UI affordance, so NO reviewMode NACK (it saves what the viewer
  // already sees). REQUEST-style ⇒ every path replies (ok:false on any refusal)
  // so the block never hangs.
  useEffect(() => {
    const off = onMessage<unknown>('SAVE_IMAGE', async (raw) => {
      const req = resolveSaveImageRequest(raw);
      if (!req) return; // missing/invalid requestId — can't correlate, drop
      const { requestId } = req;
      if (req.kind === 'invalid') {
        send('SAVE_IMAGE_RESULT', { requestId, ok: false, error: 'invalid save-image request' });
        return;
      }
      // F2 concurrency cap (host-side backpressure): bound concurrent host-side
      // image downloads so a hostile block can't download-bomb the viewer's tab
      // (memory/bandwidth). check→increment runs synchronously before the first
      // await (single-threaded), so N concurrent SAVE_IMAGEs can't all pass the
      // gate; excess replies `busy` (the block retries) rather than fetching.
      if (saveImageInFlightRef.current >= SAVE_IMAGE_MAX_CONCURRENT) {
        send('SAVE_IMAGE_RESULT', { requestId, ok: false, error: 'busy' });
        return;
      }
      saveImageInFlightRef.current += 1;
      try {
        if (req.kind === 'url') {
          if (!isAllowedSaveImageUrl(req.url, env.NEXT_PUBLIC_IMAGE_LOCATION)) {
            send('SAVE_IMAGE_RESULT', { requestId, ok: false, error: 'image url is not allowed' });
            return;
          }
          await downloadUrlAsBlob(req.url, sanitizeDownloadFilename(req.filename, req.url));
          send('SAVE_IMAGE_RESULT', { requestId, ok: true });
          return;
        }
        // id variant — route through the gated per-viewer read.
        if (!token) {
          send('SAVE_IMAGE_RESULT', { requestId, ok: false, error: 'no block token' });
          return;
        }
        const result = await getImagesByIdsMutation.mutateAsync({
          blockToken: token,
          imageIds: [req.imageId],
        });
        const image = result.images.find((i) => i.imageId === req.imageId);
        if (!image || image.status !== 'visible') {
          // Withheld (hidden / above-ceiling / unscanned / flagged) or unresolvable
          // → never saveable. Do NOT leak which reason.
          send('SAVE_IMAGE_RESULT', { requestId, ok: false, error: 'image is not available' });
          return;
        }
        await downloadUrlAsBlob(image.url, sanitizeDownloadFilename(req.filename, image.url));
        send('SAVE_IMAGE_RESULT', { requestId, ok: true });
      } catch (err) {
        send('SAVE_IMAGE_RESULT', { requestId, ok: false, error: storageErrorMessage(err) });
      } finally {
        // Release the slot on EVERY exit that acquired one (success / refusal /
        // error) so the gate can't leak slots and wedge shut.
        saveImageInFlightRef.current -= 1;
      }
    });
    return off;
  }, [onMessage, send, token, getImagesByIdsMutation]);

  // ── OPEN_RESOURCE_PICKER → RESOURCE_PICKER_RESULT (Design 1 host-chrome) ────
  //
  // Generalizes the model-slot OPEN_CHECKPOINT_PICKER (IframeHost) to the page
  // surface and widens it from Checkpoint-only to a typed allowlist (Checkpoint
  // plus the generator's LoRA family: LORA, LoCon, DoRA — the exact set the
  // spend-time page-LoRA gate already accepts, so the picker offers nothing
  // submit would refuse). The block asks the HOST to open its OWN native
  // ResourceSelectModal as host chrome; the viewer searches in host chrome (NOT
  // the iframe); the host posts back ONLY the single chosen resource. The
  // untrusted iframe NEVER receives a list, the search API, or the catalog — it
  // only ever learns about the one resource the user physically picked.
  //
  // This feeds the merged page-LoRA `additionalResources` plumbing: the block
  // puts a Checkpoint pick into body.modelVersionId and each LoRA pick into
  // body.additionalResources. The picker is DISCOVERY ONLY — every chosen ID is
  // re-validated server-side at estimate/submit by the page gate
  // (assertViewerCanGeneratePageResources) + the orchestrator belt. Nothing the
  // iframe says about a resource is trusted at spend time.
  //
  // The picker reuses the host's native ResourceSelectModal UNMODIFIED. The
  // block never sees the catalog or the search API — it only ever receives the
  // ONE resource the user physically picked (host chrome can't be enumerated by
  // the iframe). The real authorization boundary is the SERVER gate
  // (assertViewerCanGeneratePageResources) at estimate/submit, NOT the picker UI.
  //  - `canGenerate: true` (UX floor) + the spend-time re-gate (authoritative).
  //  - resourceType allowlist enforced in resolveResourcePickerRequest (pure,
  //    unit-tested): an unsupported type is DROPPED and the modal never opens.
  // NSFW-by-domain is inherited from the native modal's existing parent-context
  // browsing-level handling, exactly as the model checkpoint picker already
  // relies on.
  //
  // MEDIUM-2 (deferred — documented, NOT wired): that inherited handling is the
  // SITE-WIDE browsing level, where `blue` is mature. So on a blue (or green)
  // block — which generation clamps to SFW via `domainBrowsingCeiling` — the
  // picker UI can still SURFACE mature resources, an inconsistent SFW
  // experience. This is NOT an iframe leak: the RESOURCE_PICKER_RESULT below is
  // name/id-only (no thumbnails/meta), and every picked id is re-gated SFW
  // server-side at estimate/submit (assertViewerCanGeneratePageResources +
  // domainBrowsingCeiling off the RAW request color) before any spend.
  //
  // Why not wired here: `openResourceSelectModal`'s `ResourceSelectOptions`
  // (resource-select.types.ts) exposes NO browsing-level / sfwOnly / nsfw
  // constraint — only `canGenerate`, `resources`, `excludeIds`. NSFW filtering
  // is done purely client-side in the SHARED `ResourceHitList` via
  // `useApplyHiddenPreferences`, which is passed NO `browsingLevel` override and
  // so defaults to the site-wide `useBrowsingLevelDebounced()` context (the
  // server-side list query behind it — the tRPC `model.getResourceSelect`
  // procedure, service `resource-select.service.ts` — doesn't filter by browsing
  // level at all; the older `useResourceSelectFilters` hook this note used to
  // name no longer exists). Passing a block-SFW ceiling in would require adding
  // a new option to
  // `ResourceSelectOptions`, threading it through `ResourceSelectProvider` /
  // `useResourceSelectContext`, and feeding it to that `useApplyHiddenPreferences`
  // call — i.e. modifying the shared modal's filtering internals (higher blast
  // radius, affects every generation-form picker), and even then the hook's
  // `isModerator && nsfwLevel===0` carve-out leaves gaps for the currently
  // mod-gated audience. Deferred as a follow-up in the same bucket as the
  // Phase-3 REST clamp; tracked in the PR body.
  //
  // requestId threads each pick so concurrent requests (e.g. a checkpoint pick
  // and a LoRA pick open back-to-back) never cross — the SDK hook resolves only
  // the RESOURCE_PICKER_RESULT whose requestId matches its own request.
  useEffect(() => {
    const off = onMessage<unknown>('OPEN_RESOURCE_PICKER', (raw) => {
      const req = resolveResourcePickerRequest(raw);
      if (!req) return; // invalid / unsupported type → drop, never open the modal
      const { requestId, resourceType, baseModelGroup } = req;

      // Normalize an optional family hint through getBaseModelGroup (accepts an
      // ecosystem key like 'Flux1' OR a baseModel name like 'Flux.1 D'). An
      // unresolved/empty baseModelGroup applies NO baseModel narrowing — the
      // modal emits the bare `type = <T>` clause, so it returns ALL resources of
      // that type (still gated by `canGenerate`), NOT a subset.
      // That's intentional and safe: the server is the authority on family
      // compatibility at spend (it family-checks the resources at submit), so an
      // incompatible pick is rejected there rather than being silently filtered
      // out of the picker here.
      const groupKey = baseModelGroup ? getBaseModelGroup(baseModelGroup) : null;
      const baseModels = groupKey ? getBaseModelsByGroup(groupKey) : [];

      let answered = false;
      openResourceSelectModal({
        title: resourceType === 'Checkpoint' ? 'Choose a checkpoint' : 'Choose a resource',
        options: {
          canGenerate: true,
          resources: [{ type: resourceType, baseModels }],
        },
        onSelect: (resource) => {
          answered = true;
          // Post back ONLY the narrow single-pick allowlist via the canonical
          // safe projector. Never spread the full GenerationResource — no
          // availability/hasAccess/early-access/usageControl/minor/poi/sfwOnly/
          // cover-image internals reach the iframe. The projection is WIDENED
          // (PR-C) to also carry the PUBLIC recommended settings a block needs —
          // strength + min/max clamp, trained words, clipSkip — so it can seed a
          // per-resource weight slider + trigger-word display. Shared with the GET
          // /api/v1/blocks/generation-resources rehydrate endpoint so the two can
          // never drift on which fields are public.
          send('RESOURCE_PICKER_RESULT', {
            requestId,
            selected: projectSafeGenerationResource(resource),
          });
        },
        onClose: () => {
          // Dialog dismiss fires after onSelect when the user picks (the modal
          // closes itself); only emit the "cancelled" result if onSelect never
          // ran. answered=true short-circuits so a pick isn't followed by a
          // spurious cancel.
          if (answered) return;
          send('RESOURCE_PICKER_RESULT', { requestId });
        },
      });
    });
    return off;
  }, [onMessage, send]);

  // ── OPEN_CHECKPOINT_PICKER → CHECKPOINT_PICKER_RESULT (dev:live↔prod parity) ─
  //
  // The SDK hook `useCheckpointPicker()` posts OPEN_CHECKPOINT_PICKER. The
  // model-slot host (IframeHost) handles it, AND the dev:live SDK host serves it
  // — but this PAGE host only ever handled the newer/wider OPEN_RESOURCE_PICKER,
  // so a page block calling `useCheckpointPicker()` had its request hit NO host
  // handler (gotcha-#73): the "Change model" button spun forever — no network
  // call, no error. Authors tested it working locally (dev:live serves it) then
  // it silently broke in prod. This handler MIRRORS IframeHost's so that hook
  // works identically on pages; it is purely additive (OPEN_RESOURCE_PICKER is
  // unchanged) and a deliberately narrow checkpoint-only superset of it.
  useEffect(() => {
    const off = onMessage<unknown>('OPEN_CHECKPOINT_PICKER', (raw) => {
      const req = resolveCheckpointPickerRequest(raw);
      if (!req) return; // missing / non-string requestId → drop, never open the modal
      const { requestId, baseModelGroup } = req;

      // Normalize the optional family hint through getBaseModelGroup (accepts an
      // ecosystem key like 'Flux1' OR a baseModel name like 'Flux.1 D'). Empty /
      // unresolved group → baseModels:[] → no checkpoints rather than all
      // families (matching IframeHost: "all" would include incompatible families
      // that 400 at submit).
      const groupKey = baseModelGroup ? getBaseModelGroup(baseModelGroup) : null;
      const baseModels = groupKey ? getBaseModelsByGroup(groupKey) : [];

      let answered = false;
      openResourceSelectModal({
        title: 'Choose a checkpoint',
        options: {
          canGenerate: true,
          resources: [{ type: 'Checkpoint', baseModels }],
        },
        onSelect: (resource) => {
          answered = true;
          // Same name/id-only projection IframeHost's CHECKPOINT_PICKER_RESULT
          // uses — the public display names of the user-picked resource plus the
          // body-building IDs; NO full GenerationResource spread, so no
          // availability/access/early-access/nsfw/poi/minor internals reach the
          // iframe.
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
          // Dialog dismiss fires after onSelect when the user picks (the modal
          // closes itself); only emit the "closed without picking" result if
          // onSelect never ran. answered=true short-circuits so a pick isn't
          // followed by a spurious cancel.
          if (answered) return;
          send('CHECKPOINT_PICKER_RESULT', { requestId });
        },
      });
    });
    return off;
  }, [onMessage, send]);

  // ── OPEN_IMAGE_UPLOAD → IMAGE_UPLOAD_RESULT (host-mediated block image upload) ─
  //
  // A block asks the host to let the viewer upload an image (the app decides what
  // it is for). Mirrors OPEN_RESOURCE_PICKER's host-chrome pattern: the host opens
  // its OWN upload modal, the iframe never handles the bytes. The request's
  // optional `purpose` (normalized by resolveImageUploadRequest — absent ⇒
  // 'display', so this stays byte-compatible with an SDK that sends none) selects
  // the mode:
  //
  //   • 'display' (DEFAULT — PUBLIC image, e.g. a cosmetic background): the upload
  //     routes through civitai's SESSION-AUTHED path → REAL createImage +
  //     ingestImage scan → server-side gate (blockImageUpload.persist + gate), and
  //     ONLY a moderated image id that is scanned-clean, within the SFW ceiling,
  //     and unflagged is returned. UNCHANGED behavior.
  //
  //   • 'generationSource' (PRIVATE generation input — an img2img source): the
  //     upload routes through the SAME lightweight consumer-blob util the generator
  //     uses (uploadConsumerBlob, in BlockGenerationSourceUploadModal) — NO
  //     createImage, NO scan, NO SFW gate, NO imageId/nsfwLevel. It returns only
  //     the source shape { url, width, height } (the blob's real dims). Platform
  //     safety is preserved because the ORCHESTRATOR scans the generation OUTPUT,
  //     exactly as civitai's own generator does for its img2img sources. The blob
  //     url is an `orchestration…civitai.com` host that passes the img2img
  //     blockSourceImageSchema allowlist (workflow.schema) unchanged.
  //
  // Gate on status 'ready' (a pre-handshake block can't summon the modal) via the
  // same 'error'→'no_token' shim the consent/buzz handlers use. requestId threads
  // the reply so concurrent uploads never cross. A successful upload posts the
  // minimal projection; closing without one posts a bare (cancelled) result.
  useEffect(() => {
    const off = onMessage<
      { requestId?: unknown; purpose?: unknown; asyncScan?: unknown } | undefined
    >('OPEN_IMAGE_UPLOAD', (raw) => {
      if (reviewMode) {
        // Host-mediated upload runs under the MOD's REAL session (createImage /
        // consumer blob) — never let untrusted review code open it. Reply the
        // bare (cancelled) result the block awaits so it fails fast (no hang).
        if (raw && typeof (raw as { requestId?: unknown }).requestId === 'string') {
          send('IMAGE_UPLOAD_RESULT', {
            requestId: (raw as { requestId: string }).requestId,
          });
        }
        return;
      }
      // `readGateStatus()` (not a closed-over `status`) — see its definition.
      const gateStatus = readGateStatus();
      if (gateStatus !== 'ready') {
        // NEVER HANG — pre-handshake block: refuse the modal (unchanged) but
        // REPLY, exactly as the reviewMode branch six lines above already does
        // for its own refusal ("so it fails fast (no hang)"). This branch is the
        // one that didn't, and it is the expensive one to get wrong: the SDK's
        // `useImageUpload` sends OPEN_IMAGE_UPLOAD with
        // `PICKER_REQUEST_TIMEOUT_MS` (blocks-react 0.39.0 — 10 MINUTES, not the
        // 30s default), so a silent drop strands the block's promise for ten
        // minutes with no error anywhere.
        //
        // A bare `{ requestId }` is the cancelled/dismissed shape the SDK
        // already handles (`if (!selected) return null; // dismissed`). Nothing
        // is uploaded and no modal opens — the refusal is unchanged.
        if (raw && typeof (raw as { requestId?: unknown }).requestId === 'string') {
          send('IMAGE_UPLOAD_RESULT', {
            requestId: (raw as { requestId: string }).requestId,
          });
        }
        return;
      }
      const req = resolveImageUploadRequest(raw);
      // Legitimately UNREPLIABLE: a missing / non-string requestId leaves no id
      // to thread a reply back on. Drop, never open the modal. (Not a hang risk
      // either — the SDK always mints a requestId, so a payload without one
      // never came from a promise anybody is awaiting.)
      if (!req) return;
      const { requestId, purpose, asyncScan } = req;

      // generationSource: UNSCANNED private img2img source (orchestrator scans
      // the OUTPUT). Reply carries the source shape { url, width, height }; the
      // moderated 'display' branch below is untouched.
      if (purpose === 'generationSource') {
        let resolvedSource: BlockSourceImageInfo | null = null;
        dialogStore.trigger({
          id: `block-generation-source-upload-${requestId}`,
          component: BlockGenerationSourceUploadModal,
          props: {
            onResolved: (result: BlockSourceImageInfo) => {
              resolvedSource = result;
            },
          },
          options: {
            onClose: () => {
              if (resolvedSource) {
                send('IMAGE_UPLOAD_RESULT', { requestId, selected: resolvedSource });
              } else {
                send('IMAGE_UPLOAD_RESULT', { requestId });
              }
            },
          },
        });
        return;
      }

      // display + asyncScan: NON-BLOCKING moderated path. The host modal resolves
      // EARLY on persist (returning a PENDING handle — the author's own preview
      // URL) and CLOSES; a host-mounted BlockImageScanPoller (registered below,
      // which SURVIVES this modal's unmount) polls the authoritative scan gate and
      // streams the verdict to the block via the parent→block IMAGE_SCAN_RESOLVED
      // push. The server gate is UNCHANGED — nothing cross-user is persisted until
      // the app sees a `scanned` verdict, and `gate` still only ever returns a
      // moderated projection on Scanned + within-SFW-ceiling + unflagged.
      if (asyncScan) {
        let accepted = false;
        dialogStore.trigger({
          id: `block-image-upload-${requestId}`,
          component: BlockImageUploadModal,
          props: {
            // BLOCKING-mode callback — unused in async mode (onAccepted drives the
            // early resolve); a no-op that satisfies the modal's required prop.
            onResolved: () => undefined,
            onAccepted: ({ imageId, url }: { imageId: number; url: string }) => {
              accepted = true;
              // Early-resolve: the upload is accepted (image persisted, scan still
              // in-flight). Hand the block the PENDING handle and register the
              // background poller keyed by requestId.
              send('IMAGE_UPLOAD_RESULT', {
                requestId,
                selected: { status: 'pending', imageId, url },
              });
              setImageScanPollers((prev) =>
                prev.some((p) => p.requestId === requestId)
                  ? prev
                  : [...prev, { requestId, imageId }]
              );
            },
          },
          options: {
            onClose: () => {
              // Dismissed WITHOUT accepting → bare (cancelled) result, no poller.
              // On accept, onClose fires AFTER onAccepted set `accepted`, so the
              // early-resolve reply is not followed by a spurious cancel.
              if (!accepted) send('IMAGE_UPLOAD_RESULT', { requestId });
            },
          },
        });
        return;
      }

      // display (default): moderated public-image path — UNCHANGED.
      let resolved: BlockUploadedImageInfo | null = null;
      dialogStore.trigger({
        // Per-request id so multiple OPEN_IMAGE_UPLOAD calls don't dedup against
        // each other in the dialog store's exists-check.
        id: `block-image-upload-${requestId}`,
        component: BlockImageUploadModal,
        props: {
          onResolved: (result: BlockUploadedImageInfo) => {
            resolved = result;
          },
        },
        options: {
          onClose: () => {
            // A successful upload set `resolved` before the modal closed itself;
            // otherwise the user cancelled → reply with a bare (cancelled) result.
            if (resolved) {
              send('IMAGE_UPLOAD_RESULT', { requestId, selected: resolved });
            } else {
              send('IMAGE_UPLOAD_RESULT', { requestId });
            }
          },
        },
      });
    });
    return off;
    // `status` deliberately absent — see the REQUEST_CONSENT deps note.
  }, [onMessage, send, readGateStatus, reviewMode]);

  // ── SET_USER_CHECKPOINT → USER_CHECKPOINT_SET (fail-fast NACK on a page) ──────
  //
  // `useCheckpointPicker().persist(versionId)` posts SET_USER_CHECKPOINT and
  // AWAITS USER_CHECKPOINT_SET (it's a request, not fire-and-forget). The
  // model-slot host (IframeHost) handles it by writing `checkpoint_version_id`
  // into `block_user_settings` for the (blockInstance, viewer) row, AND the
  // dev:live SDK host serves it — so a block author who calls `persist()` sees
  // it resolve locally, then (before this handler existed) had the SAME call
  // hit NO page-host handler in prod: the persist promise hung to the SDK's
  // request timeout (gotcha-#73, the "spins forever, no network call, no
  // console error" class). This handler closes that silent hang.
  //
  // CRUCIAL: a page CANNOT persist a checkpoint override the way the model slot
  // can. The server proc `blocks.updateUserSettings` HARD-REQUIRES `modelId`
  // in the block-token ctx (it resolves a model-bound install via
  // resolveBlockInstance({ modelId, slotId, ... })). A PAGE token's ctx is
  // `{ slotId, entityType:'none' }` with NO modelId (isPageToken) — a page is
  // stateless and binds to no model — so driving updateUserSettings with the
  // page token would throw BAD_REQUEST ("block token lacks modelId context").
  // There is no page-scoped user-settings row to write into today.
  //
  // So rather than INVENT a persistence target (a guess), this replies with an
  // explicit, KNOWN-shape NACK: `USER_CHECKPOINT_SET { ok:false, error }`. That
  // is the exact reply type+shape `persist()` awaits (it throws the `error`
  // string when `ok:false`), so the block fails FAST and surfaces a clear
  // message instead of hanging. The page's checkpoint flow is the in-memory
  // OPEN_CHECKPOINT_PICKER result (above), which the block already holds — it
  // does not need a persisted override.
  //
  // OPEN DECISION for a human (documented in
  // claudedocs/app-blocks-host-handler-parity-2026-06-29.md): if pages should
  // ever persist a viewer checkpoint preference, that needs a NEW page-scoped
  // storage target (e.g. via the app-storage KV the page token already
  // authorises) + a server proc that doesn't demand modelId — out of scope
  // here. Until then a NACK is the correct, non-guessing behavior.
  useEffect(() => {
    const off = onMessage<{ requestId?: unknown } | undefined>('SET_USER_CHECKPOINT', (raw) => {
      // NOTE: `payload.versionId` is intentionally NOT read or validated here —
      // the page path always NACKs regardless of which checkpoint was requested
      // (there is no page-scoped persistence target), so the versionId is moot.
      // Mirror IframeHost's drop rule: a missing / non-string requestId can't be
      // answered (no correlation id), so drop it silently rather than reply.
      if (!raw || typeof raw.requestId !== 'string' || raw.requestId.length === 0) return;
      send('USER_CHECKPOINT_SET', {
        requestId: raw.requestId,
        ok: false,
        error: 'page blocks cannot persist a checkpoint override (no model binding)',
      });
    });
    return off;
  }, [onMessage, send]);

  // ── GET_WILDCARD_PACK → WILDCARD_PACK_RESULT (W13 wildcard-pack import) ──────
  //
  // A page block posts GET_WILDCARD_PACK{ requestId, modelVersionId } to import a
  // wildcard pack's parsed prompt lists. The HOST — running in the civitai page
  // with the viewer's REAL authenticated session — resolves + fetches + unzips +
  // parses it AS THE USER, and posts only the parsed JSON back. The untrusted
  // iframe never sees the session, the signed URL, or the raw bytes.
  //
  // Why host-mediated (vs. a block-JWT REST endpoint that server-side fetches +
  // unzips, the #3130 alternative):
  //   1. `generation.resolveWildcardPack` runs as a protectedProcedure (session
  //      auth), so `getFileForModelVersion` enforces every REAL creator/user
  //      download gate authoritatively — requireAuth (satisfied by the session),
  //      usageControl/downloads-disabled, early-access/entitlement, the viewer's
  //      maturity ceiling — instead of a hand-rolled partial re-derivation.
  //   2. The fetch + unzip run in the USER'S BROWSER TAB (bounded, streamed
  //      inflate in wildcardPackHost), so a zip-bomb OOMs one tab, not a serving
  //      web pod. The bytes never touch a pod's heap.
  //
  // token-INDEPENDENT (unlike every other handler above): the resolve proc is
  // session-authed, not block-token-authed, so this does NOT gate on the page
  // `token` prop. A missing/invalid requestId is dropped (nothing to reply to);
  // every OTHER path posts a WILDCARD_PACK_RESULT (a `pack` or an `error`
  // discriminant) so the block's SDK request never hangs. The zip + fetch shell
  // (jszip/js-yaml) is dynamically imported so it never enters the page-block
  // bundle unless a pack is actually requested.
  useEffect(() => {
    const off = onMessage<unknown>('GET_WILDCARD_PACK', async (raw) => {
      const req = resolveGetWildcardPackRequest(raw);
      if (!req) return; // missing/invalid requestId or modelVersionId → drop
      const { requestId, modelVersionId } = req;
      if (reviewMode) {
        // 🔴 token-INDEPENDENT (session-cookie-authed) op — it does NOT go through
        // the scope-stripped review block token, so it is the ONE handler that
        // would otherwise bypass the review token defense entirely: an untrusted
        // pending block could drive the MOD's real download entitlements to
        // resolve+fetch+unzip+parse an arbitrary modelVersionId's wildcard pack and
        // read the contents into the sandboxed iframe. NACK before resolving or
        // downloading anything (fail-fast, never a hang) — with the ENUM code, not
        // REVIEW_NACK_MESSAGE: this reply's `error` is validated against a closed
        // set block-side, so free text would be dropped and hang. See
        // WILDCARD_REVIEW_NACK_CODE.
        send('WILDCARD_PACK_RESULT', { requestId, error: WILDCARD_REVIEW_NACK_CODE });
        return;
      }
      // Concurrency cap (host-side backpressure): bound the per-tab memory. The
      // check→increment runs synchronously before the first await (single-
      // threaded), so N concurrent GET_WILDCARD_PACKs can't all pass the gate.
      // Excess → `busy` (the block retries) rather than an unbounded queue.
      if (wildcardInFlightRef.current >= WILDCARD_MAX_CONCURRENT) {
        send('WILDCARD_PACK_RESULT', { requestId, error: 'busy' });
        return;
      }
      wildcardInFlightRef.current += 1;
      try {
        const resolved = await resolveWildcardPackMutation.mutateAsync({ modelVersionId });
        // 32 MB pre-download cap on the server-advertised size — reject BEFORE
        // fetching a byte.
        if (exceedsPreDownloadCap(resolved.sizeBytes)) {
          send('WILDCARD_PACK_RESULT', { requestId, error: 'too-large' });
          return;
        }
        const { fetchAndParseWildcardPack, WILDCARD_FETCH_TIMEOUT_MS } = await import(
          './wildcardPackHost'
        );
        const { lists, truncated, truncatedLists } = await fetchAndParseWildcardPack({
          signedUrl: resolved.signedUrl,
          sizeBytes: resolved.sizeBytes,
          signal: AbortSignal.timeout(WILDCARD_FETCH_TIMEOUT_MS),
        });
        send('WILDCARD_PACK_RESULT', {
          requestId,
          pack: { ...resolved.meta, lists, truncated, truncatedLists, maturity: resolved.maturity },
        });
      } catch (err) {
        // NOT_FOUND / FORBIDDEN (proc) · too-large · parse-failed (fetch/unzip/
        // abort) — a single error discriminant, never a hang.
        send('WILDCARD_PACK_RESULT', { requestId, error: classifyWildcardPackError(err) });
      } finally {
        // Release the in-flight slot on EVERY exit (success, too-large early
        // return, or error) so the concurrency gate can't leak slots and wedge
        // shut. Only decremented for a request that passed the gate + incremented.
        wildcardInFlightRef.current -= 1;
      }
    });
    return off;
  }, [onMessage, send, resolveWildcardPackMutation, reviewMode]);

  // ── SET_COLLECTION_FOLLOW → COLLECTION_FOLLOW_RESULT ────────────────────────
  //
  // A block asks the host to follow / unfollow a collection for the viewer. The
  // decision layer is SHARED with IframeHost (`collectionFollowGate.ts`) and
  // carries the full rationale; the two things this host contributes are its own
  // `viewer` prop (the signed-in signal) and `reviewNack`.
  //
  // 🔴 THE CONSENT BOUNDARY IS THE CONFIRM CLICK. This bridge exists so a block
  // no longer needs the `collections:write:self` scope, which was the viewer's
  // consent step on the HTTP path. The replacement is host chrome the sandboxed
  // iframe cannot fake or restyle: NOTHING is written until the viewer clicks
  // through `ConfirmDialog`, exactly as PUBLISH_GENERATION_OUTPUTS does. Do not
  // "simplify" this by calling the mutation directly — that silently converts a
  // consented action into an unconsented one.
  //
  // REQUEST-style ⇒ every terminal path (refusal / cancel / success / error)
  // MUST reply exactly once or the block hangs to its SDK timeout; the `settled`
  // latch guards a double-reply the way the publish handler's does. Only a
  // payload with no usable requestId is dropped — there is nothing to reply to.
  useEffect(() => {
    const off = onMessage<unknown>('SET_COLLECTION_FOLLOW', (raw) => {
      const gate = resolveCollectionFollowRequest({
        raw,
        // `viewer` is non-null ONLY for a signed-in viewer (the page route
        // renders for logged-out viewers too, with viewer: null).
        signedIn: viewer != null,
        reviewNack,
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
      const copy = buildCollectionFollowConsentCopy({ follow, appName });
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
    viewer,
    reviewNack,
    appName,
    followCollectionMutation,
    unfollowCollectionMutation,
  ]);

  // ONE sanitized label for the whole launch surface — the avatar initial, the
  // loading skeleton's accessible name and the visible "Starting …" copy all derive from
  // this, so they can never disagree about the fallback. Same sanitizer the
  // visible chrome uses (anti-spoof: strips control/bidi/zalgo from a
  // publisher-controlled name); 'app' when nothing legible remains.
  const launchName = sanitizeAppChromeName(appName) || 'app';

  const showIframe = status === 'loading' || status === 'ready';
  const isReady = status === 'ready';

  // #4: terminal-state fallback — render a BlockFallback message INSIDE the page
  // frame instead of a blank viewport. See pageBlockHostLogic.pageFallbackReason
  // for the status→reason mapping + the anti-spoof rationale.
  const fallbackReason = pageFallbackReason(status);

  // #4 Retry: re-attempt the load from a terminal fallback. The full re-arm in
  // one place so there's no stuck state and no timer leak across retries:
  //   1. Dispose any controller the terminal cleanup may not have torn down yet
  //      (defensive — the init effect's cleanup already disposes + nulls it when
  //      status left 'loading'; this guarantees no orphaned interval/timeout
  //      survives a retry).
  //   2. Reset the per-mount handshake guard so init re-fires.
  //   3. Bump `reloadNonce` → re-keys the <iframe> → React remounts it (fresh
  //      contentWindow), so the re-armed handshake talks to a clean frame.
  //   4. Flip status back to 'loading'. shouldStartInit then re-passes and the
  //      init effect (controllerRef now null) builds a NEW controller whose
  //      start() re-posts BLOCK_INIT and re-arms the readiness timeout — so a
  //      second failure routes back to the fallback (no stuck state), and a
  //      BLOCK_READY clears it (success-after-retry).
  // Only meaningful from a terminal state; a no-op while loading/ready (status
  // stays put, nonce churn is harmless but we still gate to avoid a spurious
  // iframe remount mid-handshake).
  //
  // AUTH-FAILURE branch (the HIGH this fix closes): the `error` (hard mint
  // failure) and `no_token` (token never arrived) terminals are AUTH failures —
  // the iframe never received a usable token. A local-only retry (reset +
  // reloadNonce) can NEVER recover them: the token is a PROP minted upstream by
  // useBlockToken (route), and `shouldStartInit` gates on `hasToken`. With
  // `token`/`tokenError` unchanged, the re-armed handshake just times out to the
  // SAME terminal again (the 15s dead-end). So for `error`/`no_token` we ALSO
  // call onRetryToken (= useBlockToken.refresh) to re-mint the token; the rotated
  // token flips the props, init re-fires, and a successful mint loads the block.
  // For `fatal`/`timeout` the token was fine — the block crashed or didn't ack —
  // so remount-only (no re-mint) is the right, unchanged behavior. refresh()
  // aborts any in-flight mint and the endpoint is rate-limited (60/min) — which is
  // why the AUTOMATIC re-mints are capped at MAX_AUTO_REMINTS. A manual Retry is
  // user-initiated and stays uncapped here (the double-click guard below plus that
  // server-side limit bound it).
  //
  // The re-arm itself is shared by the MANUAL button and the BOUNDED AUTO-RETRY
  // below — one recovery path, not two (a second path is how the two drift).
  //
  // 🔴 It deliberately no longer resets `blockRenderEmittedRef`. See the
  // BEACON-SEMANTICS block on the render-failure beacon: one beacon per mount
  // describing the outcome the host settles on.
  const performRetry = useCallback(
    ({ remint }: { remint: boolean }) => {
      if (remint) onRetryToken?.();
      controllerRef.current?.dispose();
      controllerRef.current = null;
      initSentRef.current = false;
      setReloadNonce((n) => n + 1);
      setStatus('loading');
    },
    [onRetryToken]
  );

  const handleRetry = useCallback(() => {
    const prior = statusRef.current;
    // Double-click no-op guard (mirrors the pre-fix gate): a Retry while the
    // status is already loading/ready does nothing — no re-mint, no remount.
    if (prior === 'loading' || prior === 'ready') return;
    // AUTH failures (`error`/`no_token`) need a token re-mint — the local reset
    // alone can't change the upstream `token`/`tokenError` props. `fatal`/`timeout`
    // are not auth failures → remount only.
    //
    // A manual Retry while an automatic one is still PENDING is coherent by
    // construction: `performRetry` flips the status back to 'loading', which makes
    // `decideAutoRetry` return 'none', which tears down the pending backoff timer
    // in the scheduling effect's cleanup — so exactly ONE attempt runs, the one
    // the user asked for. It also does NOT consume the automatic budget: the user
    // taking over shouldn't spend the platform's remaining recovery attempts.
    performRetry({ remint: prior === 'error' || prior === 'no_token' });
  }, [performRetry]);

  // 🔴 The backoff timer must NOT depend on `performRetry`'s IDENTITY. `performRetry`
  // is rebuilt whenever the `onRetryToken` PROP changes identity, and a caller is
  // free to pass an inline arrow (`onRetryToken={() => refresh()}`) — that makes it a
  // new function on every parent render. If the scheduling effect depended on it,
  // every such render would tear down and re-arm the pending timer, so the backoff
  // would never elapse and auto-retry would SILENTLY NEVER FIRE. Reading it through
  // a ref keeps the effect keyed on the DECISION alone.
  const performRetryRef = useRef(performRetry);
  useEffect(() => {
    performRetryRef.current = performRetry;
  }, [performRetry]);

  // BOUNDED AUTO-RETRY — arm the backoff timer for the next automatic attempt.
  //
  // Placed here (after `performRetry`) rather than beside the other status
  // effects purely for declaration order. `autoRetry` is the SAME memoized
  // decision the failure beacon reads, so a scheduled retry and a suppressed
  // beacon can never disagree.
  //
  // No timer leak: the cleanup clears the pending timeout on unmount AND whenever
  // the decision changes (a manual Retry, a recovery, a status change) — so at
  // most one backoff timer exists at a time and none survives the component.
  useEffect(() => {
    if (autoRetry.kind !== 'retry') return;
    const { delayMs, remint } = autoRetry;
    const t = setTimeout(() => {
      // Consume the budget FIRST so the decision recomputes to the next attempt
      // (or to 'none') even if the retry re-fails instantly.
      setAutoRetryBudget((b) => ({
        attempts: b.attempts + 1,
        reminted: b.reminted + (remint ? 1 : 0),
      }));
      performRetryRef.current({ remint });
    }, delayMs);
    return () => clearTimeout(t);
  }, [autoRetry]);

  return (
    <Box
      style={{
        display: 'flex',
        flexDirection: 'column',
        // 🔴 THE ROOT IS FULL-BLEED ON PURPOSE, AND THIS IS A REVERSAL — READ THE
        // NOTE BEFORE "RESTORING" A CAP HERE. The ultrawide cap used to live on
        // THIS element, so the trust chrome and the app took one measure. It now
        // lives on the CONTENT wrapper below, which holds the app and the failure
        // card but NOT `AppBlockChrome`.
        //
        // The argument the old placement made — that a breadcrumb vouching for the
        // app should not span a width the app does not occupy — is real, but it was
        // outweighed in practice: the chrome is site furniture, and stopping it at
        // 1600px made a full-page app look like a boxed widget dropped into the
        // page rather than a page of the site. Every other site-level bar spans the
        // viewport, so the capped one read as the odd element. Operator decision;
        // the cost is that on a very wide display the chrome is wider than the app
        // it labels, which is the same relationship the site header already has to
        // every page's content column.
        //
        // What did NOT change: the cap's VALUE, the `var()` read, the fallback, and
        // the `data-block-id` opt-out ledger — the custom property is still declared
        // once in globals.css and still overridden per-app on THIS element, from
        // which it INHERITS to the content wrapper. So a ledger entry keyed on
        // `[data-app-page-frame][data-block-id='…']` keeps working exactly as
        // documented, with no change to its selector.
        width: '100%',
        // See the `fit` prop for why these are the two modes and why the
        // viewport arithmetic can never agree with its own scroll viewport.
        ...(fit === 'fill'
          ? {
              // Fill the (already bounded) parent — but never below
              // `FILL_MIN_HEIGHT_PX`. See that constant for why a bare
              // `minHeight: 0` here was a WCAG regression rather than a tidier
              // fix. Above the floor `flex: 1` still resolves to exactly the
              // parent's height, so nothing overflows and no outer scrollbar
              // appears; the floor is inert at every ordinary viewport.
              flex: 1,
              minHeight: FILL_MIN_HEIGHT_PX,
            }
          : {
              // Full viewport under the global header. The host chrome sits on
              // top; the iframe fills the rest.
              height: '100%',
              minHeight: `calc(100dvh - ${HEADER_HEIGHT_PX}px)`,
            }),
      }}
      data-testid="app-page-frame"
      // 🔴 THE OPT-OUT LEDGER'S OTHER HALF, AND IT EXISTS BECAUSE `data-testid`
      // DOES NOT SHIP. `next.config.mjs` sets
      // `compiler.reactRemoveProperties: { properties: ['^data-testid$'] }` under
      // `NODE_ENV === 'production'`, so EVERY `data-testid` is compiled out of the
      // production DOM. The ledger in globals.css used to be keyed on
      // `[data-testid='app-page-frame'][data-block-id='…']`, which therefore
      // matched nothing on the live site while passing in every test tier (they
      // all run with `NODE_ENV !== 'production'`, where the testid is present) —
      // measured on civitai.com/apps/run/playable-collections: the rule shipped
      // verbatim in the CSS, 0 elements matched the compound selector, 1 matched
      // `[data-block-id='playable-collections']`, and the app was letterboxed at
      // the 1600px cap. This attribute is the production-surviving spelling of
      // "this is the page host", the same way `data-app-footer` and
      // `data-adhesive-ad` mark their elements for `globals.css` elsewhere.
      //
      // It carries no value on purpose: it is a presence marker, not data. Never
      // re-key the ledger onto `data-testid` (stripped) and never delete this —
      // both make every ledger rule inert with nothing visibly wrong. Guarded by
      // `__tests__/ledgerSelectorSurvivesProdStrip.test.ts`, which reads the strip
      // list out of `next.config.mjs` and the ledger selectors out of globals.css
      // and compares them, rather than restating either.
      data-app-page-frame=""
      // Observable sizing mode, so a regression test (and DevTools) can assert
      // WHICH branch a surface took rather than re-deriving it from computed
      // styles that jsdom does not resolve.
      data-fit={fit}
      // 🔴 THE OPT-OUT LEDGER'S ANCHOR, not decoration. The full-bleed escape
      // hatch documented on `--app-page-max-width` is a CSS rule keyed on this
      // attribute, so removing it does not merely lose an observability hook —
      // it makes every ledger rule match nothing, silently. `blockId` (the app's
      // slug, the same value that builds `<slug>.civit.ai`) is the identifier an
      // app author knows themselves by; `data-block-instance-id` below is the
      // per-install id and is NOT stable across surfaces.
      data-block-id={blockId}
      data-block-instance-id={blockInstanceId}
      // #3/#6: surface the consent signal as an observable attribute. The page
      // token still mints with the granted subset (so the block loads — consent
      // is NOT terminal here), but a block requesting an ungranted consent-gated
      // scope drives its own REQUEST_CONSENT against the missing set. This makes
      // the host-known signal visible to the block frame / debugging rather than
      // silently swallowed.
      data-needs-consent={needsConsent ? 'true' : 'false'}
    >
      <AppBlockChrome
        blockInstanceId={blockInstanceId}
        appBlockId={appBlockId}
        appName={appName}
        // The page's own route slug. For an on-site app it is the `AppBlock.block_id`,
        // which is exactly what `AppListing.slug` stores — so the chrome can key the
        // store lookup off it without a second identifier. This is the ONLY surface
        // that threads it: the model slot renders no breadcrumb, so it has nothing to
        // hang the store popover on.
        slug={slug}
        slotId={PAGE_SLOT_ID}
        canOpenPage={canOpenPage}
      />
      {/* Async cosmetic-image scan pollers (non-blocking OPEN_IMAGE_UPLOAD). Each
          renders nothing; it polls the authoritative scan gate in the background —
          SURVIVING the upload modal's close — and on a verdict fires
          IMAGE_SCAN_RESOLVED to the block then removes itself. Rendered here (not in
          the iframe/fallback branches) so a page that falls back mid-scan still
          resolves the pending upload. */}
      {imageScanPollers.map((p) => (
        <BlockImageScanPoller
          key={p.requestId}
          imageId={p.imageId}
          onResult={(result: BlockImageScanResult) => {
            send('IMAGE_SCAN_RESOLVED', { requestId: p.requestId, imageId: p.imageId, result });
            setImageScanPollers((prev) => prev.filter((x) => x.requestId !== p.requestId));
          }}
        />
      ))}
      {/* THE APP'S OWN COLUMN — everything the cap applies to, and nothing else.
          `AppBlockChrome` above is deliberately OUTSIDE it (see the root's note): the
          chrome spans the page like every other site-level bar, the app does not.

          🔴 ULTRAWIDE CAP — the app is a CENTRED column past `APP_PAGE_MAX_WIDTH_PX`,
          full width below it. See that constant for the value's justification and
          `--app-page-max-width` in globals.css for the per-app opt-out ledger.

          🔴 BOTH CAP DECLARATIONS ARE INERT BELOW THE CAP, WHICH IS THE REQUIREMENT.
          `width: 100%` already resolves narrower than the cap on any ordinary display,
          so `max-width` clamps nothing; and `margin-inline: auto` distributes the
          LEFTOVER inline space, of which there is none on a box that fills its parent,
          so both margins resolve to 0. Nothing about the rendered geometry moves until
          the parent is wider than the cap — measured in
          `PageBlockHostMaxWidth.browser.test.tsx`.

          🔴 READ THROUGH `var()` DELIBERATELY. An inline custom property here
          (`'--app-page-max-width': …`) would win over any stylesheet rule targeting the
          same element, which is precisely the rule shape the opt-out ledger uses — so
          writing the value inline would silently make the opt-out inert while looking
          tidier. The property is set on the ROOT and inherits down to here, so the
          ledger's existing `[data-app-page-frame][data-block-id='…']` selector
          is unchanged by the move.

          🔴 IT REPRODUCES THE VERTICAL CHAIN IT WAS INSERTED INTO, which is the only
          way this can be a width-only change. It was previously the iframe wrapper's
          `flex: 1` that consumed the space left by the chrome, as a direct child of the
          root's column; this box now takes that role and re-offers it, so it must be a
          column flex container AND a `flex: 1` item itself.

          🔴 `flex: 1` IS THE LOAD-BEARING ONE AND NOTHING RENDERED CATCHES ITS LOSS.
          Measured by mutation: dropping it leaves the FULL node suite and the FULL
          `AppBlocks` browser suite green while the app column collapses to ~150px at a
          900px content height — a running App Block reduced to a sliver, with every tier
          green. `__tests__/pageBlockHostMaxWidth.test.ts` therefore pins this style block
          verbatim in the node `unit` tier; that source pin is the only thing that CATCHES
          that mutation at all. It does not BLOCK it: `main` requires no status check in
          this repo, so what the pin buys is a red run a reviewer has to read (and an
          honest verdict on a push to `main`), not a door that stays shut.

          ⚠️ `minHeight: 0` IS DEFENCE, NOT A LOAD-BEARING PROPERTY — SAY SO RATHER THAN
          NAMING A TEST THAT DOES NOT COVER IT. Measured: removing it leaves the scroll-fit
          and max-width browser suites 20/20 green, because the child iframe wrapper already
          carries `overflow: hidden`, which per CSS Flexbox §4.5 gives it an automatic
          minimum size of 0 — so this box's content-based minimum is 0 with or without the
          declaration. It is kept because that reasoning depends on a property of a DIFFERENT
          element that nothing pins, and it costs nothing; an earlier version of this comment
          credited `PageBlockHostScrollFit.browser.test.tsx` with covering it, which would
          have misled anyone auditing whether it could go. */}
      <Box
        data-testid="app-page-content"
        style={{
          display: 'flex',
          flexDirection: 'column',
          flex: 1,
          minHeight: 0,
          width: '100%',
          maxWidth: `var(--app-page-max-width, ${APP_PAGE_MAX_WIDTH_PX}px)`,
          marginInline: 'auto',
        }}
      >
        {showIframe ? (
          // The iframe fills the remaining viewport. While the block is still
          // handshaking (status === 'loading', before BLOCK_READY), the surface
          // would otherwise be blank — the iframe is mounted but visually empty and
          // non-interactive (pointerEvents:none). Overlay a centered branded
          // launch state (app initial + a content-shaped skeleton) on top
          // so the user sees a loading state instead of a blank page. The overlay
          // is gated on `(!bootSkeleton || reloadNonce > 0) && overlayMounted`
          // inside `status === 'loading'`: it unmounts the instant the
          // status machine leaves loading — on BLOCK_READY (→ ready) AND on every
          // terminal path (timeout / fatal / no_token / error, which also flip
          // `showIframe` to false and render the BlockFallback below) — so it can
          // never spin forever.
          <Box
            style={{
              position: 'relative',
              flex: 1,
              display: 'flex',
              // 🔴 CONFINE THE LAUNCH-REVEAL TRANSFORM. While the block is still
              // handshaking the iframe carries `translateY(8px)`, and a transform
              // does not change layout but DOES extend the SCROLLABLE OVERFLOW
              // region — so those 8px pushed past this wrapper and asked the
              // nearest scrolling ancestor for a scrollbar. Measured, not
              // inferred: wrapper `bottom=716`, iframe `bottom=724`, container
              // `scrollHeight 724` vs `clientHeight 716`. Purely decorative
              // motion should never be able to do that. Clipping here is also
              // free — the iframe fills this box exactly, so nothing else can be
              // cut off. Covered by the GREEN ARM in
              // `PageBlockHostScrollFit.browser.test.tsx`, which asserts exact
              // equality precisely so an 8px leak cannot hide in a tolerance.
              overflow: 'hidden',
            }}
          >
            <iframe
              // #4 Retry: re-key on `reloadNonce` so a retry UNMOUNTS + REMOUNTS
              // the iframe (fresh contentWindow), not just reloads its src — the
              // re-armed init handshake then talks to a clean frame.
              key={reloadNonce}
              ref={iframeRef}
              src={renderedIframeSrc}
              sandbox={effectiveSandbox}
              referrerPolicy="no-referrer"
              // Sanitize the publisher-controlled appName for the iframe title too
              // (same sanitizer as the visible chrome + the loader aria-label), so
              // every appName-derived plain-text attribute is consistent. Falls
              // back to blockId when nothing legible remains.
              title={sanitizeAppChromeName(appName) || blockId}
              data-testid="app-page-iframe"
              data-block-instance-id={blockInstanceId}
              data-block-ready={isReady ? 'true' : 'false'}
              /* 🔴 A11Y. The veil is the host's ONLY loading announcement
                (role="status" + aria-busy). Standing it down for a bootSkeleton
                app removed it with nothing in its place — measured, ZERO
                elements matching [role="status"],[aria-busy],[role="alert"] —
                and the host cannot borrow the app's, because that boot state is
                inside a cross-origin frame it can never read. Marking the frame
                itself busy restores a machine-readable "still loading" without
                claiming to know what it says. `reloadNonce === 0` is what makes
                "only while the veil is absent" TRUE rather than merely stated:
                the retry path brings the veil (role="status") back, and without
                that term both were busy at once — measured, 2 regions. */
              aria-busy={bootSkeleton && reloadNonce === 0 && !isReady ? true : undefined}
              style={{
                flex: 1,
                display: 'block',
                width: '100%',
                border: 0,
                pointerEvents: isReady ? 'auto' : 'none',
                // LAUNCH REVEAL: the block fades + settles up as it becomes ready,
                // cross-fading with the branded overlay below. Under reduced motion
                // `revealMs` is 0 → no transition is emitted and the opacity flip is
                // instantaneous (the pre-animation behaviour).
                //
                // 🔴 `bootSkeleton` apps opt OUT of the whole reveal. They paint
                // their own boot state in the HTML they ship (themed only if they also
                // read the BLOCK_INIT fragment; otherwise a prefers-color-scheme
                // guess), so hiding the
                // iframe until BLOCK_READY would hide exactly that, and the
                // translateY settle would move it on arrival — a layout shift, at
                // the one moment the app is trying not to move. Visible from mount,
                // no transform, no transition: the app's skeleton is on screen at
                // first paint and its own React render replaces it in place.
                // `pointerEvents` is deliberately NOT opted out — a skeleton is not
                // interactive, and the block must stay inert until it has a token.
                opacity: bootSkeleton || isReady ? 1 : 0,
                transform: bootSkeleton || isReady || revealMs === 0 ? 'none' : 'translateY(8px)',
                transition:
                  bootSkeleton || revealMs === 0
                    ? undefined
                    : `opacity ${revealMs}ms ease-out, transform ${revealMs}ms ease-out`,
              }}
            />
            {/* 🔴 Suppressed for a `bootSkeleton` app. This veil is opaque and
              `inset: 0` until BLOCK_READY, so leaving it up would cover the very
              boot state the app ships — the declaration would be inert and the
              app author would have no way to tell. For every other app it stays
              exactly as it was, and it is the reason NOT declaring the field is
              the safe default: no veil plus an empty `#root` is a blank white
              iframe. */}
            {/* 🔴 `reloadNonce > 0` deliberately RE-ENABLES the veil for a
              bootSkeleton app. The opt-out is about FIRST boot, where the app's
              own skeleton is about to paint. A RETRY is the opposite situation:
              `key={reloadNonce}` remounts the iframe, so the app's document is
              being re-fetched and its skeleton is NOT on screen — and the
              "Retrying …" copy lives inside this veil, so suppressing it left
              the user with an empty region and no indication anything had
              happened, for the manual attempt and every automatic one.
              Measured: veil absent, iframe blank, the string "Retrying" nowhere
              in the document. */}
            {(!bootSkeleton || reloadNonce > 0) && overlayMounted && (
              <Center
                data-testid="app-page-loading"
                // Announce the loading state on the REGION: role="status" +
                // aria-busy mark the overlay container as a live busy region so a
                // screen reader announces it when it appears. The region is the
                // ONLY thing that announces — the skeleton group below is
                // aria-hidden and exposes nothing, deliberately (see its own
                // comment). Do not give that group a role to "restore" a labelled
                // graphic: its label would then be read as part of this region and
                // the app name would announce twice.
                // Once the block IS ready the overlay is a purely decorative
                // fading-out veil, so it drops the live-region roles and hides from
                // the a11y tree instead of announcing a stale "loading".
                {...(isReady
                  ? { 'aria-hidden': true }
                  : { role: 'status', 'aria-busy': true, 'aria-live': 'polite' as const })}
                // Observable reveal state (DevTools / manual QA): 'false' while the
                // block is still handshaking, 'true' for the one cross-fade after
                // BLOCK_READY, then the node unmounts.
                data-revealing={isReady ? 'true' : 'false'}
                style={{
                  position: 'absolute',
                  inset: 0,
                  background: 'var(--mantine-color-body)',
                  // Never intercept clicks: during loading the iframe is already
                  // pointer-inert, and during the fade-out the block is live
                  // underneath — the veil must not swallow that first click.
                  pointerEvents: 'none',
                  opacity: isReady ? 0 : 1,
                  transition: revealMs === 0 ? undefined : `opacity ${revealMs}ms ease-out`,
                }}
              >
                {/* Branded launch state. The app's initial in the same Avatar
                  treatment the store card uses gives a visual through-line from
                  card → run page, so opening an app feels continuous rather than
                  landing on a bare spinner. Purely presentational: every string is
                  run through the SAME sanitizer the visible chrome uses
                  (sanitizeAppChromeName) so the publisher-controlled appName can't
                  carry control/bidi/zalgo spoofing here either — consistency with
                  AppBlockChrome, not a new gate. Falls back to 'app' when nothing
                  legible remains. */}
                {/* 🔴 `w="100%"` is load-bearing, not decoration. Without it this
                  Stack is a shrink-to-fit flex item of the <Center>, so its
                  width is set by its widest CONTENT-sized child — the
                  "Starting {appName}…" text. A percentage width on the
                  skeleton group below then resolves against the APP NAME's
                  rendered width and its `maw` is never reached: measured, a
                  two-character app name gave an 82.5px group with 27.8px bars,
                  where a normal one gave 193px. Publisher-controlled, so the
                  loading state would look different for every app in the
                  store. Constraining the Stack instead makes the group's
                  100%/maw pair mean what it says. */}
                <Stack align="center" gap="sm" w="100%">
                  <Avatar radius="md" size={56} alt="" aria-hidden>
                    {/* `Array.from(...)[0]` not `charAt(0)`: charAt splits a
                      surrogate pair, so an emoji-leading app name would render a
                      broken half-glyph. Falls back to the SAME string as the
                      visible copy below so the two can't disagree. */}
                    {(Array.from(launchName)[0] ?? '').toUpperCase()}
                  </Avatar>
                  <Text size="sm" c="dimmed">
                    {/* IN-PROGRESS FEEDBACK. `reloadNonce` counts re-attempts
                      (manual AND automatic — both go through performRetry), so
                      a re-attempt reads as a retry-in-progress rather than an
                      identical "Starting …" that looks like nothing happened.
                      This is the half of the reported defect where pressing
                      Retry against a still-down host silently waited ~10s and
                      re-rendered the same error.

                      Deliberately NO "of N" here, and no attempt NUMBER: the
                      fallback's pending-retry line counts AUTOMATIC attempts
                      against a bounded ceiling, while this would count EVERY
                      re-attempt including manual ones. Showing both put two
                      counters on the same flow seconds apart, disagreeing —
                      the card's "attempt 1 of 2" followed by this saying
                      "attempt 2", and after a few manual clicks "attempt 7"
                      against a stated maximum of 2. The bounded count belongs to
                      the terminal card, where the budget is meaningful; this line
                      only has to say that something is happening again. */}
                    {reloadNonce > 0 ? `Retrying ${launchName}…` : `Starting ${launchName}…`}
                  </Text>
                  {/* CONTENT-SHAPED LOADING STATE, not a spinner.
                    A spinner says "busy"; a skeleton says "content is coming and
                    this is roughly its shape", which is what the sidebar slot
                    already gets for free — `IframeHost` renders BlockFallback's
                    <Skeleton> while its block is loading. This page was the only
                    block surface still showing a bare spinner, so the two hosts
                    disagreed about what a loading app looks like.

                    🔴 Why it lives HERE and not in the block's own index.html:
                    this overlay is `inset: 0` at `opacity: 1` over the entire
                    iframe until BLOCK_READY, so ANYTHING a block paints before
                    then — including a static skeleton shipped in its own HTML —
                    is behind an opaque veil and never seen. Putting it in the
                    host is also what makes it free for every app: no per-app
                    change, no rebuild, no SDK bump.

                    Deliberately GENERIC bars, not a mimic of any one app's
                    layout: this renders for every app in the store, so a shape
                    borrowed from one of them would be wrong for the rest.

                    🔴 `aria-hidden`, and NOT `role="img"`. These are decorative
                    placeholder boxes; the announcement is the container's
                    role="status" / aria-live copy ("Starting …") and always
                    was. Giving this group a role would expose its name inside
                    that live region — a region is announced from its
                    ACCESSIBLE-tree text, so an exposed labelled child is read
                    as part of it and the app name would announce twice
                    ("Starting Budgeted Generator… Loading Budgeted
                    Generator"). The <Loader> this replaces never did that:
                    Mantine renders it as a bare <span> with no role, so its
                    aria-label was not exposed either — this restores the
                    pre-change announcement rather than changing it.

                    Carries no aria-label: on an aria-hidden node it would be
                    permanently inert, and `data-testid` below is what the
                    suite queries. */}
                  <Box
                    aria-hidden
                    w="100%"
                    maw={420}
                    px="md"
                    data-testid="app-page-loading-skeleton"
                  >
                    <Stack gap="xs">
                      {/* `animate={!reduceMotion}` — same call the fallback makes.
                        Under prefers-reduced-motion the bars stay as static
                        placeholder boxes instead of shimmering. */}
                      <Skeleton h={12} w="55%" radius="sm" animate={!reduceMotion} />
                      <Skeleton h={12} w="35%" radius="sm" animate={!reduceMotion} />
                      <Skeleton h={32} radius="sm" animate={!reduceMotion} mt={6} />
                      <Skeleton h={40} radius="sm" animate={!reduceMotion} mt={4} />
                    </Stack>
                  </Box>
                </Stack>
              </Center>
            )}
          </Box>
        ) : fallbackReason ? (
          <Box
            style={{ flex: 1, padding: 'var(--mantine-spacing-md)' }}
            data-testid="app-page-fallback"
          >
            <BlockFallback
              reason={fallbackReason}
              blockName={sanitizeAppChromeName(appName) || blockId}
              onRetry={handleRetry}
              // 🔴 The REAL terminal message renders the instant the status goes
              // terminal — a pending automatic attempt is surfaced INSIDE it, never
              // instead of it. The user is never held in a loading state waiting on
              // a quiet retry (the silent-blank failure class), and the manual
              // affordance stays available the whole time.
              autoRetry={
                autoRetry.kind === 'retry'
                  ? {
                      attempt: autoRetry.attempt,
                      // The ceiling REACHABLE from here, not the raw attempt cap —
                      // an auth terminal is bounded by the lower re-mint budget, so
                      // showing MAX_AUTO_RETRIES would promise a retry that will
                      // never happen. Derived in decideAutoRetry.
                      maxAttempts: autoRetry.maxAttempts,
                      // prefers-reduced-motion: reduce → no spinner.
                      animate: !reduceMotion,
                    }
                  : undefined
              }
              autoRetriesSpent={autoRetryBudget.attempts}
              // Automatic recovery has settled (exhausted, or never applicable):
              // the button is now the only path forward, so make it unmissable.
              prominentRetry={autoRetrySettled}
            />
          </Box>
        ) : null}
      </Box>
    </Box>
  );
}
