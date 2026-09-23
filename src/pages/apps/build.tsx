import { AppsPageLayout } from '~/components/Apps/AppsPageLayout';
import { AppsBuildBody } from '~/components/Apps/AppsBuildBody';
import { resolveBuildPageAccess } from '~/components/Apps/resolveBuildPageAccess';
import { Meta } from '~/components/Meta/Meta';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { createServerSideProps } from '~/server/utils/server-side-helpers';
import { isAppDeveloper } from '~/shared/utils/app-blocks-access';

/**
 * `/apps/build` — the single BUILD surface, replacing `/apps/get-started` (301) and
 * `/apps/mine` (301) and absorbing the on-platform half of `/apps/submit`.
 *
 * Three states behind one route — see `~/components/Apps/appsBuildState`:
 *   A · pitch     (not an author)                   — recruit
 *   B · first-app (author, nothing yet)             — quickstart + create
 *   C · workbench (author, has apps or submissions) — the app list + `New app`
 *
 * 🔴 THE GATE IS `canAccessAppsBuild`, WHICH THE SUB-NAV ROW ALSO CALLS. That sharing is
 * the point of the consolidation, not an implementation detail: the three routes this
 * replaced each wrote their page gate and their tab gate separately, and they
 * disagreed — a store-visible non-author was offered tabs into two 404s (PR #4668,
 * #3899). Do not add a second flag check to this file.
 *
 * 🔴 NO `useSession`-DRIVEN LOGIN REDIRECT, unlike `/apps/mine` and `/apps/submit`.
 * State A needs no user; a login wall in front of a recruiting page is the opposite of
 * what a funnel wants. See `resolveBuildPageAccess`.
 */
export const getServerSideProps = createServerSideProps({
  useSession: true,
  resolver: async ({ features, session }) =>
    resolveBuildPageAccess({ features, user: session?.user }),
});

export default function AppsBuildPage() {
  const currentUser = useCurrentUser();
  const features = useFeatureFlags();

  /**
   * 🔴 `deIndex` IS PER-STATE, AND IT IS THE AUTHOR TERM THAT DECIDES IT — deliberately
   * NOT the full state machine. `/apps/get-started` carried a blanket `deIndex` with a
   * `TODO(launch): drop deIndex to make indexable when comms is ready`. That decision is
   * made here: state A is a recruiting page and SHOULD be indexable, states B and C
   * render a named viewer's own app list and submission history and must never be.
   *
   * The condition is `isAuthor` rather than `resolveAppsBuildState(...) === 'pitch'`
   * because the B↔C split rides `getNavSummary`, which is client-only — so a
   * state-machine-driven `deIndex` would be computed from an all-false summary in the
   * SSR HTML, i.e. exactly the render a crawler reads, and would be racing a value that
   * cannot exist yet. `isAuthor` is SSR-frozen, so the tag a crawler receives is the
   * tag we meant. A non-author is state A by definition; an author is B or C, both
   * private.
   *
   * 🔴 AND THE HONEST SCOPE: this changes NOTHING observable today. An anonymous crawler
   * holds no store flag, so `canAccessAppsBuild` answers `notFound` and there is no page
   * to index in the first place. This is a correctness property held ready for the flag
   * widening, not a live SEO change — do not read a traffic change into it.
   */
  const isAuthor = currentUser
    ? isAppDeveloper(currentUser, { appBlocksAuthor: features.appBlocksAuthor })
    : false;

  return (
    <>
      <Meta
        title="Build on Civitai"
        description="Build small web apps that run inside Civitai. Install the Civitai CLI and runtime SDK, scaffold an app, and publish it to the app store."
        deIndex={isAuthor}
      />
      {/*
        NO `measure` — `/apps/build` takes the FULL container, and it is listed in
        `APPS_FULL_MEASURE_PAGES` for that reason. The binding constraint is state C,
        which renders `MyAppsBody`'s table against a measured `SUBMISSIONS_TABLE_MIN_WIDTH`
        scroll floor of 1424px; `APPS_READABLE_MEASURE` tops out at 1368, so the readable
        class would re-create the exact clip the wide width was introduced to fix on
        `/apps/mine`. A route-keyed registry can hold ONE measure, so it has to be the
        widest state's. See the note on that list in `~/components/Apps/appsPageWidths`.
      */}
      <AppsPageLayout title="Build">
        <AppsBuildBody />
      </AppsPageLayout>
    </>
  );
}
