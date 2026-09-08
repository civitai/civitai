/**
 * The three states of the consolidated `/apps/build` surface, and the pure function
 * that picks one. React-free so the decision is unit-testable in the node-env project
 * without the page's Mantine/tRPC module graph.
 *
 * The page replaced THREE sub-nav items (`Build apps` → `/apps/get-started`, `Create` →
 * `/apps/submit`, `My apps` → `/apps/mine`) with one, so the branch that used to be
 * "which tab did they click" is now this function.
 *
 *   A · pitch     — not an author. The recruiting page: what you get, the toolkit, the
 *                   quickstart, and a request-access CTA. The only PUBLIC-facing state.
 *   B · first-app — an author with nothing yet. Short pitch + quickstart + a button into
 *                   the create flow.
 *   C · workbench — an author with apps or submission history. Their app list, a
 *                   `+ New app` button, and the pitch demoted to a resources strip.
 *
 * 🔴 `hasSubmissions` IS PART OF THE WORKBENCH TEST, NOT JUST `hasEditableApps`, and
 * dropping it is a data-loss bug rather than a cosmetic one. The two answer different
 * questions: `hasEditableApps` is "owns a listing or holds an accepted collaborator
 * seat", `hasSubmissions` is "has ever submitted". A submitter whose every listing was
 * deleted has the second and not the first, and their orphaned submissions are rendered
 * ONLY by the workbench (`MyAppsBody`'s orphan group). Sending them to `first-app`
 * would tell someone with a submission history that they have not started yet, and
 * would hide the only surface those records have. This is the same union
 * `/apps/mine`'s sub-nav row carried for the same reason — see the note on that entry
 * in `~/components/Apps/AppsSubNav`.
 *
 * 🔴 `pitch` IS THE DEFAULT, AND THAT ORDERING IS LOAD-BEARING FOR HYDRATION. The two
 * summary booleans come from `blocks.getNavSummary`, which is
 * `protectedProcedure.use(enforceAppBlocksFlag)` and runs CLIENT-ONLY (tRPC is
 * configured `ssr: false`), so on the server render and the first client paint they are
 * both `false`. `isAuthor` is SSR-frozen (see `canAccessAppsBuild`). So a non-author
 * resolves to `pitch` identically on both sides, and an author resolves to `first-app`
 * on both sides and may then move to `workbench` after mount. The state can only ever
 * settle FORWARD, never from workbench back to pitch.
 *
 * 🔴 THAT PRE-SETTLE `first-app` IS NOT RENDERED, AND THIS FUNCTION IS NOT WHAT STOPS IT.
 * Reading all-false as `first-app` is correct ARITHMETIC and was a live wrong-screen bug at
 * the CALL SITE, which used to render whatever this returned from the very first paint — so
 * every author with apps saw "Ship your first app" flash. `AppsBuildBody` now renders
 * `AppsBuildBodySkeleton` until its summary query has settled and only then consults this
 * function, so do not "fix" the branch below by inventing an `unknown` state: the caller
 * knows whether it has an answer and this pure function deliberately does not.
 */
export const APPS_BUILD_STATES = ['pitch', 'first-app', 'workbench'] as const;

export type AppsBuildState = (typeof APPS_BUILD_STATES)[number];

export function resolveAppsBuildState(args: {
  /** `isAppDeveloper(user, { appBlocksAuthor })` — SSR-frozen. */
  isAuthor: boolean;
  /** `getNavSummary.hasEditableApps` — client-only, `false` until mounted. */
  hasEditableApps: boolean;
  /** `getNavSummary.hasSubmissions` — client-only, `false` until mounted. */
  hasSubmissions: boolean;
}): AppsBuildState {
  if (!args.isAuthor) return 'pitch';
  return args.hasEditableApps || args.hasSubmissions ? 'workbench' : 'first-app';
}
