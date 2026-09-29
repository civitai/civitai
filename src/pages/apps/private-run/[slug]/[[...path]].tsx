import { Alert, Box, useComputedColorScheme } from '@mantine/core';
import Head from 'next/head';
import { IconEyeOff } from '@tabler/icons-react';
import { useMemo } from 'react';
import { blockPreconnectHint } from '~/components/AppBlocks/blockPreconnect';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { Meta } from '~/components/Meta/Meta';
import { PageBlockHost } from '~/components/AppBlocks/PageBlockHost';
import { useBlockToken } from '~/components/AppBlocks/useBlockToken';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import type { BlockInstall, PageContext } from '~/components/AppBlocks/types';
import { isAppBlocksPrivateRunEnabled } from '~/server/services/app-blocks-flag';
import { resolvePrivateRunAccess } from '~/server/services/blocks/private-run-access.service';
import { createServerSideProps } from '~/server/utils/server-side-helpers';
import { ratingAllowedOnHost } from '~/server/utils/server-domain';
import { Page } from '~/components/AppLayout/Page';
import type { PrivateRunAudience } from '~/shared/constants/block-scope.constants';

/**
 * PRIVATE RUN — `/apps/private-run/<slug>` (+ optional sub-path).
 *
 * Serves a DELISTED / SUSPENDED app's ALREADY-DEPLOYED bundle to its OWNER, an
 * ACCEPTED listing collaborator, or a MODERATOR. Never publicly, and never a listing:
 * `/apps` stays hidden and the public run route is untouched.
 *
 * ── WHY A SEPARATE ROUTE RATHER THAN A FLAG ON `/apps/run/<slug>` ────────────────
 *  1. The public route's resolver must stay `status: 'approved'`-only. A branch inside
 *     it would have to SKIP that resolver on some requests — which is exactly the
 *     shape that produced the SSR↔mint asymmetry this feature is built to avoid.
 *  2. It mirrors the reviewed `/apps/dev/<blockId>` precedent and keeps the public
 *     route's fail-closed gate order byte-identical, so its four existing test files
 *     stay green unmodified.
 *  3. It gives the private surface its own place to NOT do things the public one does
 *     — see `recordAppListingOpen` below.
 *
 * 🔴 THE PATH IS A PREFIX, NOT A SUFFIX, AND THAT IS FORCED. `/apps/run/<slug>/private`
 * would collide with the `[[...path]]` catch-all that apps use for their OWN client
 * routing: any app that happened to push `/private` would shadow the surface.
 *
 * The `[[...path]]` catch-all is KEPT, because an app's client router pushes sub-paths
 * and dropping it would break deep links on the private surface only. `PageBlockHost`
 * derives the deep-link base from its `surface` prop for the same reason.
 *
 * ── WHAT THIS ROUTE DELIBERATELY DOES NOT DO ────────────────────────────────────
 * 🔴 IT DOES NOT CALL `recordAppListingOpen`. A private review run is not a PLAY.
 * Recording it would move a suspended app's play count, and a moderator quietly
 * reviewing a takedown should not appear in the publisher's dashboard at all — that is
 * both wrong as a number and a signal to a bad actor that review is happening right
 * now. The audit trail for a private run is the mint's internal
 * `app-blocks.private-run.mint` line, which the owner cannot see.
 *
 * ⚠️ BUT THIS OMISSION DOES NOT BY ITSELF MAKE A PRIVATE RUN INVISIBLE, AND AN EARLIER
 * VERSION OF THIS PARAGRAPH IMPLIED IT DID. The play count is closed here; the
 * ANALYTICS half is not. Two other writers still feed the owner-visible panel — the
 * voided `block_spend_attribution` row (whose owner-visible reads carry no `status`
 * predicate) and every `block_scope_invocations` row `withBlockScope` writes for a
 * scoped call, which is read into the engagement count and a `count(DISTINCT
 * user_id)`. Neither is reachable while the flag is off, and both are a documented
 * PRECONDITION on widening it (stated at `isAppBlocksPrivateRunEnabled`). Saying so
 * here matters because this is the comment a reader would otherwise cite as evidence
 * that the invisibility decision is delivered.
 *
 * It also omits the beta and listing-icon reads the public route performs: both are
 * store-listing chrome, and this app's listing is `removed`.
 *
 * ── WHAT IT MUST INHERIT, AND DOES ──────────────────────────────────────────────
 * The fail-closed gate ORDER (flag → access → maturity, every one returning the same
 * bare `notFound`), `ratingAllowedOnHost(contentRating, host)`, `trustTier` from the
 * COLUMN (never `manifest.trustTier`), `sandbox` from `iframe.sandbox`, and `iframeSrc`
 * from the manifest. It renders through `PageBlockHost` — never a bare `<iframe>`,
 * which cannot boot at a block's own origin at all.
 */

interface PageProps {
  appBlockId: string;
  blockId: string;
  appId: string;
  appName: string;
  pageTitle: string;
  iframeSrc: string;
  bootSkeleton: boolean;
  sandbox: string;
  trustTier: 'unverified' | 'verified' | 'internal';
  slug: string;
  scopes: string[];
  /**
   * Which audience the viewer was admitted as, for the chrome copy only.
   *
   * ⚠️ NOT AN AUTHORISATION INPUT ON THE CLIENT, and nothing may branch on it for
   * access. The authority is the signed `privateRunAudience` claim, which the mint
   * stamps independently from the same predicate; this prop exists so the banner can
   * say something true about why the viewer is here.
   */
  audience: PrivateRunAudience;
  /**
   * The block's status, for the chrome copy.
   *
   * 🔴 THE `pending` CASE IS THE ONE THE BANNER EXISTS FOR. A re-submitted app is
   * `pending`, and what this route serves is whatever is DEPLOYED — which for a pending
   * re-submission is the PREVIOUSLY APPROVED build, not the submitted one. Scopes come
   * from the prior approval snapshot too, so there is no widening. Saying so is the
   * difference between a reviewer diagnosing the right bytes and one silently reviewing
   * the wrong ones; someone who wants to run the NEW code wants the dev tunnel.
   */
  status: string;
}

export const getServerSideProps = createServerSideProps<PageProps>({
  useSession: true,
  resolver: async ({ features, ctx, session }) => {
    // GATE 1 — the two flags the public page surface requires, fail-closed and first.
    // A viewer without them gets a 404 indistinguishable from a missing app.
    if (!features?.appBlocks || !features?.appBlocksPages) {
      return { notFound: true };
    }
    const rawSlug = ctx.params?.slug;
    const slug = typeof rawSlug === 'string' ? rawSlug : Array.isArray(rawSlug) ? rawSlug[0] : '';
    if (!slug) return { notFound: true };

    const viewer = session?.user;
    // GATE 2 — the private-run kill-switch, evaluated FOR THIS CALLER.
    //
    // 🔴 EVALUATED HERE AND PASSED IN, rather than read inside the predicate. The
    // predicate takes `privateRunEnabled` as a REQUIRED parameter precisely so that
    // "did you evaluate the flag for this caller?" is a type error rather than a review
    // question — both surfaces hold the session already. `isAppBlocksPrivateRunEnabled`
    // REQUIRES a user, so an anonymous caller cannot reach a global evaluation (which
    // would return the flag's BASE value rather than denying).
    const privateRunEnabled = viewer ? await isAppBlocksPrivateRunEnabled({ user: viewer }) : false;

    // GATE 3 — ACCESS. The ONE predicate the PHASE 3 mint also calls, so the page and
    // the token can never disagree about who may run this app. Reads the replica: this
    // is a render path, and the mint re-resolves against the primary before issuing any
    // authority.
    const access = await resolvePrivateRunAccess({
      by: { slug },
      viewer,
      db: 'read',
      privateRunEnabled,
    });
    // 🔴 EVERY refusal is the SAME bare `notFound`. The predicate's `reason` is rich for
    // the audit line and the tests and MUST NOT reach the response: a 403 for
    // `no-role` and a 404 for `no-app` would tell any signed-in prober which delisted
    // slugs exist. Not logged here either — the mint's audit line is the record, and a
    // per-SSR-request line on an enumerable route is a log-volume surface.
    if (!access.allowed) return { notFound: true };

    const block = access.block;
    // 🔴 NO `iframeSrc` CHECK HERE ANY MORE — the predicate owns it (`no-iframe-src`).
    // It used to live here, AFTER the predicate, while the mint applied no equivalent —
    // so the two callers could disagree and the mint could issue a token for a page this
    // route 404s. Moving it into the shared predicate is the whole point of there being
    // one; re-adding it here would not be wrong, but it would start the drift again.
    if (!block.iframeSrc) {
      // Unreachable: the predicate refuses `no-iframe-src` above. Kept as a typed
      // narrowing for the `iframeSrc: string` prop rather than a cast, and NOT counted
      // as a gate — the seam test asserts the predicate is the thing that refuses.
      return { notFound: true };
    }

    // GATE 4 — MATURITY. Unchanged from the public route, deliberately: the forced-SFW
    // token ceiling plus this host gate. Today every suspended block is `g` except one
    // `pg`, so mature handling is vacuous — revisit only when an `r`/`x` app is actually
    // delisted. The failure mode is discoverable ("a mod can't review it on .com"), not
    // silent.
    const host = ctx.req.headers.host ?? '';
    if (!ratingAllowedOnHost(block.contentRating, host)) {
      return { notFound: true };
    }

    // 🔴 NO `recordAppListingOpen` HERE. See the module docblock — this is the first
    // line that could only be reached by a launch that actually succeeded, which is
    // exactly where the public route records its play, and the omission is the point.

    return {
      props: {
        appBlockId: block.appBlockId,
        blockId: block.blockId,
        appId: block.appId,
        appName: block.name,
        pageTitle: block.pageTitle,
        iframeSrc: block.iframeSrc,
        bootSkeleton: block.bootSkeleton,
        sandbox: block.sandbox,
        trustTier: block.trustTier,
        slug: block.blockId,
        scopes: block.scopes,
        audience: access.audience,
        status: block.status,
      },
    };
  },
});

/**
 * The chrome copy. Extracted so the route test can assert the `pending` sentence
 * without rendering Mantine, and so the two facts it must convey stay in one place.
 */
export function privateRunNotice(args: { audience: PrivateRunAudience; status: string }): string {
  const why =
    args.audience === 'moderator'
      ? 'You are viewing this app as a moderator.'
      : args.audience === 'editor'
      ? 'You are viewing this app as a collaborator. Generation is disabled for collaborators.'
      : 'You are viewing your own app.';
  // 🔴 THE SECOND SENTENCE IS THE LOAD-BEARING ONE FOR A RE-SUBMITTED APP. `pending`
  // means the owner has re-submitted; what is DEPLOYED — and therefore what is running
  // here — is still the last APPROVED build. A reviewer who assumes otherwise reviews
  // the wrong bytes and either clears or rejects a submission they never saw.
  const which =
    args.status === 'pending'
      ? 'This app has been re-submitted for review, and this page is serving the last approved build — not the submitted one.'
      : 'It is not publicly listed or publicly runnable, and this page is serving its last approved build.';
  return `${why} ${which}`;
}

function PrivateRunPage(props: PageProps) {
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
    audience,
    status,
  } = props;
  const currentUser = useCurrentUser();
  const features = useFeatureFlags();
  const colorScheme = useComputedColorScheme('dark');
  const theme: 'light' | 'dark' = colorScheme === 'dark' ? 'dark' : 'light';

  // 🔴 NO `recordRecentlyOpenedApp`. The recents store backs the chrome's "Recently
  // run" menu and the store's "Recently opened" rail, and BOTH link at
  // `/apps/run/<blockId>` or `/apps/store-preview/<slug>` — routes that 404 for a
  // suspended app. Writing an entry here would plant a permanent dead link in the
  // viewer's own chrome, which is the same dead-end shape as linking the bare
  // subdomain. A private run is also not something to resurface casually.

  // The synthetic page instance id — identical to the public page path, so the
  // private-run token inherits the `page_<appBlockId>` namespace and with it the
  // publisher-ban revocation markers for free.
  const blockInstanceId = `page_${appBlockId}`;

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

  const {
    token,
    expiresAt,
    kind,
    needsConsent,
    missingScopes,
    domain,
    maxBrowsingLevel,
    effectiveBrowsingLevel,
    error,
    terminal,
    refresh,
  } = useBlockToken(install, context);

  const viewer = currentUser
    ? { id: currentUser.id, username: currentUser.username ?? null }
    : null;

  return (
    <>
      {/* SSR resource hint — valuable only from HERE, before hydration mounts the
          iframe. Origin derived from the resolved `iframeSrc`, never rebuilt from the
          slug. Separate `<Head>` from `<Meta>` on purpose (see the public route). */}
      <Head>{blockPreconnectHint(iframeSrc)}</Head>
      {/* 🔴 `deIndex` IS NOT OPTIONAL HERE, unlike on the public route where it is
          merely correct. This page renders an app the platform has TAKEN DOWN; letting
          a crawler index it would re-publish, under a civitai.com URL, the very thing a
          delist removed. The route 404s for anyone unauthorised, so an indexed URL
          would also be a permanent soft-404 in the index. */}
      <Meta title={`${appName} — Private run`} deIndex />
      {/* THE PRIVATE-RUN BANNER. A preceding SIBLING of the host wrapper, never inside
          it: that wrapper is the third leg of the layout contract and `PageBlockHost`'s
          `flex: 1` is documented to own it alone. As a sibling the banner takes its own
          height out of the non-scrolling `<main>` and the host resolves against the
          remainder — no new scroll container.

          Unconditional, unlike the public route's beta notice. There is no state of
          this page in which the viewer should not be told they are looking at a
          non-public app, and for a `pending` app the copy is the only thing standing
          between a reviewer and reviewing the wrong build. */}
      <Alert
        variant="light"
        color="yellow"
        icon={<IconEyeOff size={16} />}
        radius={0}
        py="xs"
        data-testid="apps-private-run-notice"
      >
        {privateRunNotice({ audience, status })}
      </Alert>
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
          // 🔴 THE PRIVATE-RUN SURFACE. This one value drives the deep-link base (so a
          // block's own client router pushes to `/apps/private-run/...` rather than the
          // public route, which 404s for a suspended app) AND the BLOCK_INIT fragment
          // refusal. Passing `'page-run'` here would reintroduce both.
          surface="private-run"
          // 🔴 `reviewMode` IS DELIBERATELY NOT SET, and that is a decision rather than
          // an omission. `reviewMode` gates ~11 handlers on the BARE flag — every
          // cross-user shared-datastore write, SHARED_REPORT, OPEN_IMAGE_UPLOAD,
          // GET_WILDCARD_PACK, NAVIGATE, and the consent notice — which stay NACKed even
          // in `reviewRunForReal`. A private run is full-parity by decision (capped
          // spend for owners and moderators), so inheriting those suppressions would
          // make the app non-functional in ways unrelated to its takedown, and the
          // moderator would be diagnosing the sandbox rather than the app. Containment
          // here is the TOKEN — self-bound `sub`, scopes clamped to the last approved
          // snapshot with the tip rail stripped, per-call and per-(viewer, app) budget
          // ceilings — not a host-side handler mute.
          fit="fill"
          sandbox={sandbox}
          trustTier={trustTier}
          slug={slug}
          token={token}
          expiresAt={expiresAt}
          tokenKind={kind}
          declaredScopes={scopes}
          missingScopes={missingScopes}
          needsConsent={needsConsent}
          domain={domain}
          maxBrowsingLevel={maxBrowsingLevel}
          effectiveBrowsingLevel={effectiveBrowsingLevel}
          tokenError={error != null}
          tokenTerminal={terminal}
          viewer={viewer}
          theme={theme}
          onConsentGranted={refresh}
          onRetryToken={refresh}
          // The chrome's "Recently run" shortcuts link at the PUBLIC run route, which
          // 404s for a suspended app. Gating on the public flags alone would render
          // guaranteed-dead links in the chrome of the one surface whose whole problem
          // is that the public route refuses this app.
          canOpenPage={!!(features.appBlocks && features.appBlocksPages)}
        />
      </Box>
    </>
  );
}

/**
 * `scrollable: false` + `subNav: null` — identical to the public run route, and for the
 * identical reasons (a full-page block owns its own scroll surface; two chrome bars
 * over a third-party app reads badly). Deliberately NOT re-argued here: divergence
 * between the two run surfaces' layout contracts would be a bug, not a feature, and
 * `pageRunScrollContract` pins the public one.
 */
export default Page(PrivateRunPage, {
  scrollable: false,
  subNav: null,
});
