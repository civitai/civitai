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
        🔴 ONE OF THREE ADOPTED PAGES WHOSE GATE DOES NOT IMPLY THE SUB-NAV'S. This page
        gates on `appBlocksGetStarted` ALONE (see the docstring above), while
        `AppsSubNav` renders only for `hasAppsStoreAccess` (`appListings || appBlocks`)
        AND hides itself below two qualifying tabs. Those are independent flags, so a
        viewer can hold this page's flag and not the nav's — and then the chrome band
        renders empty (the sub-nav returns `null`), costing the `Stack gap="xl"` above
        the body and nothing else. The other two are `/apps/[appBlockId]/edit` and
        `/apps/listing/[appListingId]/edit`, which gate on `appBlocks` alone; see the
        matching note in each. (`/apps/[appBlockId]/revenue` is NOT affected — it gates
        on `appBlocksAuthor` + `isAppDeveloper`, which guarantees the Create tab and so
        clears the two-tab floor.)

        NOT REACHABLE TODAY: `appBlocksGetStarted` is staged mod-only, and a moderator
        holds `appBlocks` (hence the store predicate) and is an `isAppDeveloper`, so the
        bar clears its floor with Marketplace + Create.

        🔴 BUT THE TRIGGER IS A RUNTIME TOGGLE, NOT A DEPLOY. An earlier version of this
        note said it becomes reachable "the moment this flag widens to ['public'] — a
        one-line change in feature-flags.service.ts". That is wrong, and wrong in the
        dangerous direction: it pins the hazard to an event a reviewer would see in a
        diff. `appBlocksGetStarted` is `{ availability: ['mod'], fliptKey:
        'app-blocks-get-started' }`, and `getFeatureFlags` returns the Flipt answer
        BEFORE it ever evaluates `availability` ("Flipt overrides role checks (both
        enable AND disable)"). So `availability` is only the Flipt-DOWN fallback: this
        page can widen to the public by flipping `app-blocks-get-started` in Flipt, with
        no code change, no PR and no deploy. All four App-Blocks flags are shaped this
        way (`appBlocks`, `appListings`, `appBlocksAuthor`, `appBlocksGetStarted`).
        TODO(launch): before any Flipt widening, either widen the sub-nav's gate with it
        or keep this page off the shared chrome.
      */}
      <AppsPageLayout measure={APPS_PAGE_MEASURES['/apps/get-started']}>
        <GetStartedBody />
      </AppsPageLayout>
    </>
  );
}
