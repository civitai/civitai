import { Alert, Box, useComputedColorScheme } from '@mantine/core';
import Head from 'next/head';
import { useEffect, useMemo } from 'react';
import { blockPreconnectHint } from '~/components/AppBlocks/blockPreconnect';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { recordRecentlyOpenedApp } from '~/components/Apps/recentlyOpenedAppsStore';
import { Meta } from '~/components/Meta/Meta';
import { PageBlockHost } from '~/components/AppBlocks/PageBlockHost';
import { useBlockToken } from '~/components/AppBlocks/useBlockToken';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import type { BlockInstall, PageContext } from '~/components/AppBlocks/types';
import { IconFlask } from '@tabler/icons-react';
import { dbRead } from '~/server/db/client';
import { BlockRegistry } from '~/server/services/block-registry.service';
import { readListingBetaBySlugForRender } from '~/server/services/blocks/app-listing-beta.service';
import { readListingIconBySlugForRender } from '~/server/services/blocks/app-listing-icon.service';
import { recordAppListingOpen } from '~/server/services/blocks/app-listing-open.service';
import { createServerSideProps } from '~/server/utils/server-side-helpers';
import { ratingAllowedOnHost } from '~/server/utils/server-domain';
import { Page } from '~/components/AppLayout/Page';

/**
 * W10 — full-page App Block route: `/apps/run/<slug>` (+ optional sub-path).
 *
 * Route is `[slug]/[[...path]]` (NOT `[appBlockId]`) to avoid colliding with
 * the sibling `/apps/[appBlockId]` detail route under `/apps`. `<slug>` is the
 * app's `block_id` (the same value that builds `<slug>.civit.ai`).
 *
 * DARK / FLAG-GATED: the page requires BOTH `features.appBlocks` AND
 * `features.appBlocksPages` (the W10 flag). When either is off for the viewer,
 * SSR returns a Next 404 (fail-closed) — merging this changes nothing
 * user-visible. The token mint enforces the same two-flag gate independently.
 *
 * STATELESS (Decision 2): no `block_user_subscriptions` row, no migration. The
 * page resolves the approved AppBlock by slug; the token is minted from a
 * synthetic `page_<appBlockId>` id. The page is pure viewer-scoped (entity=none)
 * and carries NO money scopes.
 */

interface PageProps {
  appBlockId: string;
  blockId: string;
  appId: string;
  appName: string;
  pageTitle: string;
  iframeSrc: string;
  /** manifest.bootSkeleton — the app paints its own boot state; the host stands back. */
  bootSkeleton: boolean;
  sandbox: string;
  trustTier: 'unverified' | 'verified' | 'internal';
  slug: string;
  /** #3/#6: the page manifest's declared scopes, used to compute the actual
   *  granted set (declared − missingScopes) for BLOCK_INIT. */
  scopes: string[];
  /**
   * The author's beta declaration for this app's store listing.
   *
   * 🔴 FROM `app_listings`, NOT FROM THE BLOCK — this page otherwise touches only
   * `app_blocks`. Resolved by a guarded, concurrent, slug-keyed read in the resolver above;
   * `false` / `null` both for "not in beta" and for any state the read could not see, so
   * this can only ever fail to show the notice, never invent one.
   */
  isBeta: boolean;
  betaMessage: string | null;
  /**
   * The store listing's icon, for the "recently opened apps" entry this page writes.
   *
   * 🔴 THE LISTING'S ICON, NOT THE MANIFEST'S — and that is a TRUST choice, not a
   * convenience one. The chrome that renders this is the spoof-proof surface: it exists
   * to tell a viewer which app they are actually inside, and it already launders the
   * app NAME through `sanitizeAppChromeName` for exactly that reason. A manifest-supplied
   * image is publisher-controlled with no review step, so putting one in the trust chrome
   * would hand a publisher a picture next to a name we deliberately sanitize. The listing
   * icon is a moderator-approved asset, and it is the same one `toRecentAppFromListing`
   * already writes from the store — so both writers now agree.
   *
   * `null` for a listing with no icon, and for any read that failed — see
   * `readListingIconBySlugForRender`, which fails open rather than 500ing the launch path.
   */
  iconUrl: string | null;
}

export const getServerSideProps = createServerSideProps<PageProps>({
  useSession: true,
  resolver: async ({ features, ctx, session }) => {
    // GATE FIRST, fail-closed. Both flags required. A viewer without them gets
    // a 404 — the page is invisible/un-enumerable until W10 launch widens the
    // `app-blocks-pages-enabled` segment.
    if (!features?.appBlocks || !features?.appBlocksPages) {
      return { notFound: true };
    }
    const rawSlug = ctx.params?.slug;
    const slug = typeof rawSlug === 'string' ? rawSlug : Array.isArray(rawSlug) ? rawSlug[0] : '';
    if (!slug) return { notFound: true };

    // Resolve the approved page app by slug (== block_id). Returns null for a
    // missing / non-approved / non-page app → 404 (never leaks which).
    //
    // 🔴 THE BETA READ RUNS **CONCURRENTLY**, NOT AFTER, AND THAT IS THE WHOLE DESIGN OF IT.
    // This is the app-LAUNCH critical path, so a serial second round trip here would be
    // added latency on every run of every app. Keying the beta lookup on the SLUG — rather
    // than on the `appBlockId` this resolve returns — is what removes the dependency: it
    // needs nothing from the block resolve, so the two issue together and the page waits for
    // the slower of the two instead of their sum. The key is sound because for an ON-SITE
    // app the `AppListing.slug` IS the AppBlock's `block_id` (single source:
    // `app-listing-mapper.ts` → `slug: ab.blockId`, the same fact the recents store below
    // already relies on), and `AppListing.slug` is `@unique`, so it is one indexed
    // single-row read.
    //
    // 🔴 IT FAILS OPEN TO "NOT BETA" ON **EVERY** ERROR, AND IT MUST. This page's SSR 404s or
    // 500s the APP LAUNCH — a failure here does not degrade a badge, it takes the app away,
    // and `createServerSideProps` has no try/catch above it. So the call below is
    // `readListingBetaBySlugForRender`, the CATCH-ALL variant, and deliberately NOT the
    // narrow `readListingBetaBySlug` that every write-gating path uses: that one propagates a
    // timeout / deadlock / `42P01` by design, which here would be an HTTP 500 on the page
    // that runs the app. Do not "consolidate" the two — the ForRender reader's own docstring
    // names this call site as the reason it exists. A listing row that does not exist
    // resolves to `isBeta: false` the same way, and a degraded read is logged rather than
    // silently swallowed.
    // 🔴 THE ICON READ JOINS THIS `Promise.all` RATHER THAN FOLLOWING IT, for the reason
    // the beta read is already here: this is the app-LAUNCH critical path, so the page
    // must wait for the SLOWEST of these, never their sum. It is keyed on the SLUG — the
    // value we already hold — so like the beta read it depends on nothing the block
    // resolve returns and can be issued in the same tick. Both `app_listings` reads fail
    // open; see `readListingIconBySlugForRender` for why a rejection here must never
    // become a 500 on the page that runs the app.
    const [page, beta, iconUrl] = await Promise.all([
      BlockRegistry.resolvePageBlockBySlug(slug, { db: 'read' }),
      readListingBetaBySlugForRender(slug, dbRead),
      readListingIconBySlugForRender(slug, dbRead),
    ]);
    if (!page || !page.iframeSrc) return { notFound: true };

    // NSFW-APP-RED-ONLY: a mature (r/x) page app is usable ONLY on a red-capable
    // host (civitai.red). On civitai.com (or any non-red host) it is
    // indistinguishable from a missing app — return the SAME fail-closed 404 the
    // flag gate above produces, so mature content can never render off .red and
    // the app can't be enumerated by slug. SFW apps render anywhere. The host is
    // read from the request (the same authority the token mint uses).
    const host = ctx.req.headers.host ?? '';
    if (!ratingAllowedOnHost(page.contentRating, host)) {
      return { notFound: true };
    }

    // ── RECORD THE PLAY ────────────────────────────────────────────────────────
    // 🔴 AFTER EVERY FAIL-CLOSED GATE, DELIBERATELY. A launch that 404s — flags off,
    // no such approved page app, or a mature app on a non-red host — is not a play,
    // and recording before these returns would make the count include requests that
    // never rendered an app. This is the first line that can only be reached by a
    // launch that actually succeeds.
    //
    // 🔴 NOT AWAITED, and the `void` is load-bearing rather than stylistic: this is the
    // app-launch critical path that the whole `Promise.all` above exists to keep short,
    // so a ClickHouse insert must never sit in front of the page. `recordAppListingOpen`
    // swallows its own errors for the same reason — see its docstring.
    // `?? null` is an assertion, not a shrug: this route is `useSession: true`, so
    // `createServerSideProps` has already resolved the session before calling this
    // resolver — the `undefined` is only in the type. Passing an explicit `null` tells the
    // Tracker "known anonymous" so it skips a second JWE decrypt, which is precisely the
    // anonymous case its constructor note calls out.
    void recordAppListingOpen({ appBlockId: page.appBlockId, session: session ?? null, ctx });

    return {
      props: {
        appBlockId: page.appBlockId,
        blockId: page.blockId,
        appId: page.appId,
        appName: page.name,
        pageTitle: page.pageTitle,
        iframeSrc: page.iframeSrc,
        bootSkeleton: page.bootSkeleton,
        sandbox: page.sandbox,
        trustTier: page.trustTier,
        slug: page.blockId,
        scopes: page.scopes,
        isBeta: beta.isBeta,
        // Only carried when the flag is set — the same rule every other projection of these
        // columns applies, so a stale note cannot reach a page through this one.
        betaMessage: beta.isBeta ? beta.betaMessage : null,
        iconUrl,
      },
    };
  },
});

function AppPage(props: PageProps) {
  const {
    appBlockId,
    blockId,
    appId,
    appName,
    iframeSrc,
    bootSkeleton,
    sandbox,
    trustTier,
    slug,
    scopes,
    isBeta,
    betaMessage,
    iconUrl,
  } = props;
  const currentUser = useCurrentUser();
  const features = useFeatureFlags();
  const colorScheme = useComputedColorScheme('dark');
  const theme: 'light' | 'dark' = colorScheme === 'dark' ? 'dark' : 'light';

  // Record this ACTUAL run in the client-only recents store (localStorage), so
  // both the shared app-chrome "Recently run" menu AND the `/apps` store's
  // "Recently opened" rail can offer a 1-click return. Keyed by appBlockId (the
  // store's stable de-dup id).
  //
  // Fields, and why each is written:
  //  - `blockId` — backs `/apps/run/<blockId>` (the chrome menu's link).
  //  - `slug`    — backs `/apps/store-preview/<slug>` (the store rail's fallback
  //    link). For an on-site app the AppListing slug IS the AppBlock `block_id`
  //    (server-side single source: `app-listing-mapper.ts` → `slug: ab.blockId`),
  //    which is also why this page's own `slug` prop is `page.blockId`.
  //  - `kind`/`hasPage` — reaching THIS page means the app declares a full-page
  //    surface, so `hasPage` is true by construction; the rail uses it to decide
  //    between re-opening the run route and the detail page.
  //  - `iconUrl` — the store listing's moderator-approved icon, resolved in
  //    `getServerSideProps`. 🔴 THIS USED TO BE OMITTED, AND ITS ABSENCE WAS THE
  //    DEFECT, not a default: this is the ONE writer that means "the viewer actually
  //    RAN this app", so the apps a viewer uses most were precisely the ones whose
  //    chrome entry fell back to a generic glyph, while apps merely OPENED from the
  //    store (via `toRecentAppFromListing`, which has always carried an icon) showed
  //    the real one. `undefined` when the listing has no icon or the read failed —
  //    `recordRecentlyOpenedApp` stores the field only when truthy, so a null must not
  //    be passed through as one; consumers keep their generic-icon fallback for that
  //    case exactly as before.
  // Fires once per mount; the store dedups, so revisiting just moves the entry to the
  // front.
  //
  // 🔴 STAMPED WITH THE VIEWER'S ACCOUNT (#4048). localStorage is per browser
  // PROFILE, so without an owner the next account to use this browser inherits
  // these entries — which is how a rail of apps that 404 for the viewer got
  // rendered. `ownerId` is `null` for a signed-out run, which is its own bucket.
  const recentsOwnerId = currentUser?.id ?? null;
  useEffect(() => {
    recordRecentlyOpenedApp(
      {
        id: appBlockId,
        blockId,
        slug: blockId,
        kind: 'onsite',
        hasPage: true,
        name: appName,
        // Spread-when-truthy, matching the shape the store's own writers use
        // (`...(entry.iconUrl ? { iconUrl: entry.iconUrl } : {})`) so an absent icon leaves
        // the key off the persisted object. `RecentApp.iconUrl` is an OPTIONAL string.
        //
        // ⚠️ CONSISTENCY, NOT SAFETY — do not restate this as a hazard it is not. Writing
        // `iconUrl: undefined` here would be harmless: `coerce` in the store keeps the field
        // only when `typeof === 'string'`, and `JSON.stringify` drops an undefined value
        // anyway. An earlier version of this comment claimed the explicit-undefined form
        // would defeat an upgrade in `resolveRecentApp`; it would not, and `resolveRecentApp`
        // does no such upgrade — the icon preference lives in `upgradeRecentFromCard`, which
        // is reached only through `reconcileRecentApps` on the store page.
        //
        // 🔴 THE REAL SECOND-ORDER, WHICH IS THE OPPOSITE OF WHAT THAT CLAIMED:
        // `recordRecentlyOpenedApp` REPLACES the entry wholesale and has no icon ratchet, so
        // a run while the icon read is degraded (`null` → key omitted) DROPS an icon a store
        // visit had previously recorded, until the next successful run or reconcile. Net this
        // is still a large improvement — before this change EVERY run cleared a store-written
        // icon, because the run page never sent one — so it is a residual, not a regression,
        // and it is recorded here rather than fixed because adding a ratchet would change
        // `recordRecentlyOpenedApp`'s semantics for all five of its callers.
        ...(iconUrl ? { iconUrl } : {}),
      },
      recentsOwnerId
    );
  }, [appBlockId, blockId, appName, iconUrl, recentsOwnerId]);

  // Synthetic page instance id — the mint resolves `page_<appBlockId>` directly
  // from the approved AppBlock (no install row).
  const blockInstanceId = `page_${appBlockId}`;

  // A synthetic BlockInstall so we can reuse useBlockToken (it only reads
  // `install.blockInstanceId` and posts the context through). The manifest /
  // settings fields are unused on the page mint path.
  const install = useMemo<BlockInstall>(
    () => ({
      blockInstanceId,
      blockId,
      appId,
      appBlockId,
      manifest: {
        name: appName,
        scopes,
        iframe: { src: iframeSrc, minHeight: 200, maxHeight: null, resizable: true, sandbox },
      },
      publisherSettings: {},
      enabled: true,
      renderMode: 'iframe',
      trustTier,
    }),
    [appBlockId, appId, appName, blockId, blockInstanceId, iframeSrc, sandbox, scopes, trustTier]
  );

  // The slotContext POSTed to /api/v1/block-tokens. entityType:'none' selects
  // the page mint path server-side.
  const context = useMemo<PageContext>(
    () => ({
      slotId: 'app.page',
      entityType: 'none',
      slug,
      subPath: '',
      viewerUserId: currentUser?.id ?? null,
      viewerUsername: currentUser?.username ?? null,
      theme,
    }),
    [slug, currentUser, theme]
  );

  // #3/#6: take the consent signal + error from the mint, not just token/expiry.
  // `missingScopes` lets PageBlockHost compute the REAL granted set (declared −
  // missing) for BLOCK_INIT; `needsConsent`/`error` let it surface a terminal
  // state instead of hanging at `no_token`.
  // `refresh` re-mints the page token after a consent grant so the new scopes
  // flow to the block via TOKEN_REFRESH (wired to PageBlockHost.onConsentGranted,
  // mirroring how IframeHost re-mints on REQUEST_CONSENT). The rotated token's
  // TOKEN_REFRESH push delivers the granted scopes and the block retries.
  const {
    token,
    expiresAt,
    needsConsent,
    missingScopes,
    domain,
    maxBrowsingLevel,
    error,
    // `terminal` = the mint failed, nothing usable is left, AND the hook's
    // bounded automatic re-mints are spent. A bare `error` is NOT enough to tear
    // down a running page — a transient refresh blip sets it while recovery is
    // still under way — so the mid-session escalation keys on this instead.
    terminal,
    refresh,
  } = useBlockToken(install, context);

  const viewer = currentUser
    ? { id: currentUser.id, username: currentUser.username ?? null }
    : null;

  return (
    <>
      {/* 🔴 SSR RESOURCE HINT — and its VALUE comes entirely from being HERE.
          The block iframe mounts on the first client render AFTER hydration,
          hundreds of ms after this head is parsed; that gap is the head start
          the DNS/TCP/TLS handshake gets. The same link emitted from
          `PageBlockHost` would fire on the render that mounts the iframe, i.e.
          exactly when the browser would have connected anyway — shipped-looking
          and inert.

          It is a SEPARATE `<Head>` from `<Meta>` on purpose: `Meta` implements a
          stacking context in which only the topmost mounted instance renders its
          tags, so a dialog mounting its own `Meta` would suppress this hint too.
          The hint has nothing to do with document metadata precedence.

          `crossorigin` is load-bearing, not decoration — see `blockPreconnect.tsx`.
          The origin is derived from the `iframeSrc` prop this page already
          resolved in `getServerSideProps`, never rebuilt from the slug. */}
      <Head>{blockPreconnectHint(iframeSrc)}</Head>
      <Meta title={`${appName} — Civitai Apps`} deIndex />
      {/* AUTHOR-DECLARED BETA NOTICE, in the page CHROME.
          🔴 A SIBLING **ABOVE** THE HOST WRAPPER, never inside it. That wrapper is the third
          leg of this page's layout contract and its style object is pinned verbatim by
          `pageRunScrollContract.test.ts`; putting a second child inside it would leave
          `PageBlockHost`'s `flex: 1` sharing a container it is documented to own alone. As a
          preceding sibling the banner simply takes its own height out of the non-scrolling
          `<main>` and the host's `flex: 1` resolves against the remainder — no new scroll
          container, nothing clipped.
          🔴 PLAIN TEXT, for the same reason as the store detail page: `betaMessage` is
          unreviewed author copy, so it is rendered as a text node and never as markdown.
          A dropdown-only notice (`useChromeListingDetail`) would have been cheaper, but it
          only mounts once a user opens a menu — this has to be visible on arrival. */}
      {isBeta && (
        <Alert
          variant="light"
          color="violet"
          icon={<IconFlask size={16} />}
          radius={0}
          py="xs"
          data-testid="apps-run-beta-notice"
        >
          {betaMessage ?? 'The developer has marked this app as still in development.'}
        </Alert>
      )}
      {/* 🔴 THE THIRD LEG OF THE LAYOUT CONTRACT — not incidental styling. Pinned
          by `pageRunScrollContract.test.ts`, because reverting it passes every
          other assertion in this PR while breaking the page.

          `display/flexDirection/flex/minHeight` — the host is a FLEX ITEM of
          `AppLayout`'s non-scrolling `<main>` (this page declares
          `scrollable: false` below), so this wrapper has to GROW rather than sit
          at its content height. A plain block would leave `PageBlockHost`'s
          `flex: 1` resolving against an auto-height parent, leaving the host
          sized only by `FILL_MIN_HEIGHT_PX` — measured 300px of host, 31px of
          chrome, 269px of iframe, at every viewport width.
          `minHeight: 0` defeats the flex `min-height: auto` floor so the chain
          can shrink to the viewport instead of pushing past it.

          `overflowY: auto` — the SCROLL CONTAINER OF LAST RESORT, and the reason
          `FILL_MIN_HEIGHT_PX` is safe. Every ancestor above is `overflow-hidden`
          under `scrollable: false`, so without this the host's floor would be
          clipped rather than scrolled and a short viewport (phone landscape, or
          200% zoom) would put content permanently out of reach. It costs nothing
          at ordinary sizes: above the floor `flex: 1` fills the parent exactly,
          so there is no overflow and no scrollbar. */}
      <Box
        style={{
          display: 'flex',
          flexDirection: 'column',
          flex: 1,
          minHeight: 0,
          overflowY: 'auto',
          width: '100%',
        }}
      >
        <PageBlockHost
          appBlockId={appBlockId}
          blockId={blockId}
          appId={appId}
          blockInstanceId={blockInstanceId}
          appName={appName}
          iframeSrc={iframeSrc}
          bootSkeleton={bootSkeleton}
          // The public full-page run surface.
          surface="page-run"
          // 🔴 THE DOUBLE-SCROLLBAR FIX, and it is only half of one — it is
          // correct ONLY in combination with `scrollable: false` on the `Page`
          // options below. `fit="fill"` makes the host claim no height of its
          // own, which needs an ancestor chain that already bounds it; the
          // default scrolling layout does not, so shipping either half alone
          // regresses this page, in OPPOSITE directions. Both measured, not
          // reasoned — this comment has now been wrong in BOTH directions, once
          // by guessing and once by "correcting" a claim that was already right:
          //
          //   Drop `fill` → the host claims `100dvh - 60px` again. The
          //   `overflow-hidden` chain sits ABOVE this wrapper, and this wrapper
          //   is `overflowY: 'auto'`, so the excess is SCROLLED, not clipped:
          //   a page scrollbar beside the block's own — the exact bug this PR
          //   removes. (Measured 708px of host in a 600px wrapper,
          //   `USER_SCROLLABLE=true`.)
          //
          //   Drop `scrollable: false` → the `ScrollArea` branch bounds nothing,
          //   so `flex: 1` has nothing to resolve against and the host is sized
          //   only by `FILL_MIN_HEIGHT_PX` — a fixed slab, whatever the viewport.
          //
          // Neither is clipping. Nothing in this layout clips, because this
          // wrapper can always scroll.
          fit="fill"
          sandbox={sandbox}
          trustTier={trustTier}
          slug={slug}
          token={token}
          expiresAt={expiresAt}
          declaredScopes={scopes}
          missingScopes={missingScopes}
          needsConsent={needsConsent}
          domain={domain}
          maxBrowsingLevel={maxBrowsingLevel}
          tokenError={error != null}
          tokenTerminal={terminal}
          viewer={viewer}
          theme={theme}
          onConsentGranted={refresh}
          onRetryToken={refresh}
          // The chrome's "Recently run" shortcuts point at this very route, so
          // what decides whether they resolve is exactly this route's own
          // `getServerSideProps` predicate — which requires BOTH flags (see the
          // 404 above). `appBlocksPages` alone is NOT it: `appBlocks` is the
          // block-runtime kill-switch and Flipt can disable as well as enable,
          // so pages-on/blocks-off is reachable and would render guaranteed-404
          // links. (Both are redundantly true here, since we already passed that
          // gate; it is written out anyway so all four chrome mounters carry ONE
          // greppable shape and a future surface can't justify a per-surface
          // constant.)
          canOpenPage={!!(features.appBlocks && features.appBlocksPages)}
        />
      </Box>
    </>
  );
}

/**
 * 🔴 `scrollable: false` IS PART OF THE RENDER CONTRACT, not a cosmetic choice.
 *
 * The default (`scrollable: true`) wraps the page in `AppLayout`'s `ScrollArea`
 * — a bounded, `overflow-y: auto` viewport. A full-page App Block already owns a
 * scroll surface: the block's own document inside the iframe. Nesting one inside
 * the other is what produces the double scrollbar, because the host's height and
 * the scroll viewport's height are computed from different terms and cannot
 * agree (see `PageBlockHost`'s `fit` prop for the arithmetic).
 *
 * `scrollable: false` selects `MainContent`'s `no-scroll` branch — `flex-1
 * overflow-hidden` from the layout root down — so the outer surface has exactly
 * one height, no scrollbar of its own, and the block scrolls internally. The
 * footer is built for this mode (`AppFooter` carries `group-[.no-scroll]:`
 * variants), so it and the adhesive ad rail are deliberately left at their
 * defaults rather than nulled — this changes layout mechanics, not what the page
 * contains.
 *
 * `subNav: null` IS A PRODUCT DECISION, not just layout — DECIDED: keep it.
 * `SubNav2` renders `<HomeTabs />`, the row of top-level section pills, so this
 * removes that second-level navigation row from the route for every viewer. Four
 * reasons, written down so the call can be overturned on its merits rather than
 * rediscovered as an open question:
 *
 *   1. TOP-LEVEL NAVIGATION IS NOT LOST. `header` stays at its default, and
 *      `AppHeader` was confirmed present on the live preview — logo, search,
 *      Create, Buzz balance, account menu. Only the SECOND-level tab row goes,
 *      and its destinations stay reachable from the header.
 *   2. There IS precedent, but it is SPLIT — do not read it as a repo rule.
 *      Complete enumeration of `scrollable: false` in `src/pages` (6 routes
 *      besides this one), not a sample:
 *        pass `subNav: null` — `generate/index.tsx`, `research/rater.tsx`,
 *          `images/[imageId].tsx`
 *        keep the sub-nav — `comics/project/[id]/read.tsx`,
 *          `comics/project/[id]/iterate.tsx`, `images/iterate.tsx`
 *      3-for / 3-against. `images/iterate.tsx` is the sharpest counter-example:
 *      it nulls MORE chrome than this route does (`header: null`,
 *      `footer: null`) and still keeps the sub-nav. So this reason establishes
 *      that dropping it is a normal, precedented choice here — not that it is
 *      the convention. The weight sits on 1, 3 and 4.
 *
 *      🔴 An earlier version of this bullet said "the precedent is exact" and
 *      named two files. That was a SAMPLE generalised into an enumeration: it
 *      missed a third supporting case and all three counter-examples. Enumerate
 *      before claiming a convention.
 *   3. It is ~52px (h-8 pills + `py-1` + `mb-3`) of the vertical budget this
 *      route is tightest on; a 375×667 phone leaves the page ~386px total.
 *   4. Two chrome bars over a THIRD-PARTY app reads badly — the route already
 *      renders `AppBlockChrome` (the "Apps / <name>" breadcrumb).
 *
 * The counter-argument is consistency with the rest of the site, and (2) shows
 * this repo genuinely splits on it. The case for dropping it here rests on (1)
 * — nothing is unreachable — and on (4): unlike every route in either list
 * above, this one embeds a THIRD-PARTY app, so a second civitai nav strip sits
 * over someone else's UI. The scrollbar fix does not depend on this, so
 * restoring the tabs is a safe one-word reversal.
 *
 * Note `RewardsBonusBanner` still renders regardless (`AppLayout` shows it in
 * the `{!subNav && …}` branch), so it is NOT removed by this.
 */
export default Page(AppPage, {
  scrollable: false,
  subNav: null,
});
