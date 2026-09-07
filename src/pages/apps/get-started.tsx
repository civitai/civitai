import { APPS_PAGE_MEASURES } from '~/components/Apps/appsPageWidths';
import { NotFound } from '~/components/AppLayout/NotFound';
import { AppsPageLayout } from '~/components/Apps/AppsPageLayout';
import { GetStartedBody } from '~/components/Apps/GetStartedBody';
import { resolveGetStartedAccess } from '~/components/Apps/resolveGetStartedAccess';
import { Meta } from '~/components/Meta/Meta';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { createServerSideProps } from '~/server/utils/server-side-helpers';

/**
 * "App builders" get-started landing page — Scope A soft launch.
 *
 * Gating (deliberately DIFFERENT from every other `/apps/*` page): this page
 * gates ONLY on the dedicated `appBlocksGetStarted` flag. It does NOT call
 * `resolveAppsPageAccess` and does NOT gate on the mod-only `appBlocks` flag —
 * that flag (and `resolveAppsPageAccess`) keep guarding all the other `/apps/*`
 * surfaces (marketplace, submit, installed, review, …) exactly as before. This
 * page is purely additive; nothing else's gating changes.
 *
 * `appBlocksGetStarted` is STAGED MOD-ONLY today (`['mod']`, like `appBlocks` /
 * `appBlocksPages`) so it deploys dark-to-public: it resolves for moderators
 * only, who can review the page + its nav entry live on prod. It's widened to
 * `['public']` (a one-line flag change in feature-flags.service.ts) when launch
 * copy + the real Request-access link land. The Flipt key stays the kill-switch
 * / future-widen lever — flip it off to drop this page + its nav entry without a
 * deploy. The runtime gate below is on `appBlocksGetStarted` REGARDLESS of the
 * flag's availability value, so widening to public needs no page change.
 *
 * deIndexed for now (private-beta funnel; not ready for organic search).
 * TODO(launch): drop `deIndex` to make indexable when comms is ready.
 */
export const getServerSideProps = createServerSideProps({
  useSession: true,
  resolver: async ({ features }) =>
    resolveGetStartedAccess({ features: { appBlocksGetStarted: features?.appBlocksGetStarted } }),
});

export default function AppsGetStartedPage() {
  const features = useFeatureFlags();

  // Belt-and-suspenders: the SSR resolver already 404s when the flag is off, but
  // guard client-side too (mirrors /apps/index.tsx) so a stale client render
  // can't flash the page.
  if (!features.appBlocksGetStarted) return <NotFound />;

  return (
    <>
      {/* deIndexed initially — private-beta funnel, not for organic search yet.
          TODO(launch): drop `deIndex` to make indexable when comms is ready. */}
      <Meta
        title="Build on Civitai"
        description="Build small web apps that run inside Civitai. Install the Civitai CLI and runtime SDK, scaffold an app, and test it locally."
        deIndex
      />
      {/*
        THE GATE MISMATCH THIS NOTE USED TO DESCRIBE IS CLOSED *FOR THIS PAGE*.
        `AppsSubNav`'s whole-bar gate is now
        `hasAppsStoreAccess(features) || features.appBlocksGetStarted` — the union of the
        two pages' own gates — and the bar carries a "Build apps" tab pointing here,
        gated on that same flag (`context.canGetStarted`). So a viewer admitted to THIS
        page is admitted to the bar AND to the tab by construction, and that tab plus the
        unconditional Marketplace clear the `< 2` collapse without depending on
        `appBlocksAuthor` or any summary flag. The empty-band case the old TODO(launch)
        asked someone to resolve before a Flipt widening no longer exists here, and the
        widening no longer needs a paired code change.

        🔴 IT IS NOT CLOSED FOR THE OTHER `/apps/*` PAGES, and the same tab gate is why:
        a viewer holding a STORE flag without `appBlocksGetStarted` gets no "Build apps"
        tab, so a non-author with no installs is still back to Marketplace alone and an
        empty band on `/apps/[appBlockId]/edit` etc. That is `main`'s behaviour, unchanged
        — see the notes on those two pages, which point back here.

        🔴 WHAT IS STILL TRUE, AND IS THE REASON THIS COMMENT SURVIVES AT ALL: the
        Marketplace tab in that bar is unconditional, and `/apps` gates on
        `resolveAppsPageAccess`. A viewer holding `appBlocksGetStarted` WITHOUT a store
        flag therefore sees a tab that answers `notFound`. Not reachable today — the flag
        is staged mod-only and a moderator holds the store flags too — but the trigger is
        a RUNTIME TOGGLE, not a deploy: `appBlocksGetStarted` is
        `{ availability: ['mod'], fliptKey: 'app-blocks-get-started' }`, and
        `getFeatureFlags` returns the Flipt answer BEFORE it evaluates `availability`
        ("Flipt overrides role checks (both enable AND disable)"), so `availability` is
        only the Flipt-DOWN fallback. All four App-Blocks flags are shaped this way
        (`appBlocks`, `appListings`, `appBlocksAuthor`, `appBlocksGetStarted`). Flipping
        `app-blocks-get-started` public without `app-listings` makes that 404 reachable
        with no PR and no deploy. Gating the Marketplace tab is NOT the fix — it drops
        such a viewer to one tab and the collapse hides the whole bar, deleting the
        "Build apps" tab for the only cohort it exists for. See the note on that entry in
        `~/components/Apps/AppsSubNav`.
      */}
      <AppsPageLayout measure={APPS_PAGE_MEASURES['/apps/get-started']}>
        <GetStartedBody />
      </AppsPageLayout>
    </>
  );
}
