import { expect, test } from '@playwright/test';
import { storageStatePath } from './preview-fixtures';
import { trpcMutation, uniqueToken } from './preview-trpc';

/**
 * Moderation-surface tests for a deployed PR preview environment.
 *
 * Runs as the `mod` fixture — the ONLY role that both clears the preview gate and
 * carries user.isModerator, which the moderator-gated pages
 * (createServerSideProps({ requireModerator: true })) and the /moderator/* tRPC
 * procedures require. The mod fixture is also onboarding=15, so it passes
 * guardedProcedure and can self-seed a post + report.
 *
 * 🔴 SCOPE MOVED (civitai#3573, tracked as civitai#4171). The reports + images
 * QUEUES and their moderator tRPC procedures (report.getAll / report.setStatus)
 * were migrated OUT of this app into the standalone moderator app
 * (`apps/moderator`), and the main app now 302s those paths there
 * (src/pages/moderator/[...slug].tsx + shared/constants/migrated-moderator-routes.ts).
 * A preview cannot exercise the moderator app at all — MODERATOR_APP_URL defaults
 * to PRODUCTION (server-schema.ts), so the hop leaves the preview origin. So this
 * spec now covers the three things that DO still live here:
 *
 *   1. Two render tests on moderator surfaces that stayed in this app, proving the
 *      requireModerator SSR gate admits a mod and the page renders. Kept as
 *      separate test()s so a selector miss on one can't mask the other.
 *   2. A migration test pinning that the two migrated paths still redirect to the
 *      moderator app — asserted WITHOUT following the hop.
 *   3. The report-CREATION leg of the old end-to-end action test. `report.create`
 *      is still a main-app guardedProcedure; `report.getAll` / `report.setStatus`
 *      are not (they were deleted in #3573), so the ACTIONING half of that
 *      coverage cannot be asserted from here. It now lives in `apps/moderator`'s
 *      own suite (`app:moderator`) — see the note at the end of this file.
 *
 * Only runs under playwright.preview.config.ts (needs PREVIEW_URL + minted states).
 *
 * Verified tRPC shapes (civitai repo, paths relative to civitai/src):
 *  - post.create        guardedProcedure, input postCreateSchema
 *                       (server/schema/post.schema.ts:postCreateSchema) ->
 *                       { title?: string|null, detail?: string|null, ... } ;
 *                       returns the created Post incl. `id`
 *                       (server/controllers/post.controller.ts createPostHandler `return post`).
 *  - report.create      guardedProcedure, input createReportInputSchema
 *                       (server/schema/report.schema.ts) — a discriminatedUnion
 *                       on `reason`. The `Spam` variant (reportSpamSchema) is the
 *                       minimal shape: { type: ReportEntity, id: number,
 *                       reason: 'Spam', details: {} }. `type` is z.enum(ReportEntity)
 *                       and the Post entity string is 'post'
 *                       (shared/utils/report-helpers.ts:8 `Post = 'post'`).
 *                       Returns a Report row incl. `id` — either the freshly
 *                       created one or, if one already existed for the entity, the
 *                       existing one (server/services/report.service.ts createReport:
 *                       `if (validReport) return validReport` / `return createdReport`).
 *                       Self-reporting is only blocked for ReportEntity.User, so a
 *                       mod may report their own post.
 */

const ROLE = 'mod' as const;

/**
 * Moderator surfaces that are STILL SERVED BY THIS APP, with an anchor verified to
 * render unconditionally (outside every loading / empty / feature branch).
 *
 * Screened on origin/main against the four ways a moderator page makes a bad probe:
 * present under src/pages/moderator/, absent from MIGRATED_ROUTES, gated by
 * `createServerSideProps({ requireModerator: true })`, and carrying NO `features.*`
 * flag check (a flag-gated page renders <NotFound /> when the flag is off in
 * preview, which would look exactly like a broken gate).
 *
 * `title` is what the page's <Meta title> emits — Meta renders `<title>{title}</title>`
 * verbatim (components/Meta/Meta.tsx). Matched as a case-insensitive SUBSTRING, the
 * same tolerance the pre-#3573 version of this spec used, so a layout that appends a
 * site suffix doesn't turn a rendering page into a red gate.
 * `heading` is an unconditional Mantine `<Title order={1}>` (an <h1>).
 */
const MODERATOR_SURFACES = [
  {
    // src/pages/moderator/rewards/index.tsx — Buzz purchasable-rewards admin.
    path: '/moderator/rewards',
    title: /Rewards/i,
    heading: 'Purchasable Rewards',
  },
  {
    // src/pages/moderator/suspicious-audit-matches.tsx — prompt-audit flag queue.
    path: '/moderator/suspicious-audit-matches',
    title: /Suspicious Audit Matches/i,
    heading: 'Suspicious Audit Matches',
  },
] as const;

/**
 * Paths #3573 moved to the moderator app, and the PATH the mapping produces there.
 * Literal expectations on purpose — derived from MIGRATED_ROUTES' declared values,
 * not imported from it, so a wrong edit to that map fails this test instead of
 * silently redefining what "correct" means. The HOST is deploy-dependent
 * (MODERATOR_APP_URL), so only the path is pinned.
 */
const MIGRATED_PATHS = [
  { path: '/moderator/reports', target: '/reports' }, // @migrated-route-probe
  { path: '/moderator/images', target: '/images' }, // @migrated-route-probe
] as const;

// Mirror preview-smoke.spec.ts: assert we cleared the preview gate.
function assertGatePassed(page: import('@playwright/test').Page, path: string) {
  expect(page.url(), `${path}: should not redirect to /login`).not.toContain('/login');
  expect(page.url(), `${path}: should not redirect to /preview-restricted`).not.toContain(
    '/preview-restricted'
  );
}

test.describe('moderation surface (mod)', () => {
  test.use({ storageState: storageStatePath(ROLE) });

  for (const surface of MODERATOR_SURFACES) {
    test(`${surface.path} renders behind the moderator gate`, async ({ page }) => {
      const resp = await page.goto(surface.path, { waitUntil: 'domcontentloaded' });
      expect(resp?.status(), `HTTP status for ${surface.path}`).toBeLessThan(400);
      assertGatePassed(page, surface.path);
      // Not bounced home by the requireModerator gate, and not swallowed by the
      // migration catchall (which would leave this origin entirely).
      await expect(page).toHaveURL(new RegExp(`${surface.path}/?$`));

      // Anchor 1: the document title. <Meta title> is rendered unconditionally at
      // the top of the page component, so it is the "the mod page rendered, not an
      // error/redirect" signal that is independent of how many rows the prod-clone
      // DB has.
      await expect(page).toHaveTitle(surface.title, { timeout: 30_000 });

      // Anchor 2: the page's own <h1>. Also unconditional — it sits outside the
      // isLoading / empty-state branches, so it holds on a full OR empty queue and
      // even if the page's tRPC query errors. That is the point: a structural
      // anchor inside a data branch would make this test a data test.
      await expect(
        page.getByRole('heading', { name: surface.heading, exact: true }).first()
      ).toBeVisible({ timeout: 30_000 });
    });
  }

  test('migrated /moderator paths redirect to the moderator app', async ({ page }) => {
    for (const { path, target } of MIGRATED_PATHS) {
      // Inspect the 3xx Location WITHOUT following it: the hop leaves this origin for
      // the moderator app, which on a preview is PRODUCTION (MODERATOR_APP_URL's
      // default) — following it would probe prod from CI and prove nothing about the
      // preview. `page.request` carries the mod's cookies + the preview baseURL.
      const res = await page.request.get(path, { maxRedirects: 0 });
      expect(res.status(), `HTTP status for ${path}`).toBeGreaterThanOrEqual(300);
      expect(res.status(), `HTTP status for ${path}`).toBeLessThan(400);

      const location = res.headers()['location'] ?? '';
      expect(location, `${path} should set a redirect Location`).not.toBe('');
      // A mod must not be bounced by the _app guard instead — its two bounces are
      // '/' and '/login?returnUrl=…'; distinguish them from the migration hop.
      expect(location, `${path}: a mod must not be bounced home`).not.toBe('/');
      expect(location, `${path}: a mod session should resolve, not bounce to login`).not.toContain(
        '/login'
      );
      expect(location, `${path} should map to ${target} on the moderator app`).toMatch(
        new RegExp(`${target}$`)
      );
    }
  });

  test('mod can self-seed a post and report it', async ({ page }) => {
    const token = uniqueToken('mod');

    // Warm the context (cookies + an allowlisted Origin host) before hitting tRPC.
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    assertGatePassed(page, '/');

    // 1) Self-seed an isolated post (title+detail carry the unique token). post.create
    //    returns the created Post incl. id.
    const post = await trpcMutation<{ id: number }>(page.request, 'post.create', {
      title: token,
      detail: token,
    });
    expect(post?.id, 'post.create should return a numeric post id').toEqual(expect.any(Number));

    // 2) Report that post. Minimal valid variant of the createReportInputSchema
    //    discriminatedUnion is reason:'Spam' (reportSpamSchema → just baseDetailSchema).
    //    type:'post' is ReportEntity.Post. createReport returns the row incl. id.
    // NOTE: 'Spam' / type:'post' verified in report.schema.ts + report-helpers.ts:8.
    // If the CSRF/origin gate (createContext.ts) rejects this direct tRPC POST with
    // 403 live, the UI-driven fallback would be: open the post page → use the report
    // menu.
    const report = await trpcMutation<{ id: number; status: string }>(
      page.request,
      'report.create',
      { type: 'post', id: post.id, reason: 'Spam', details: {} }
    );
    // trpcMutation throws on any tRPC error envelope or non-2xx, so reaching here
    // already means the mutation succeeded; the id assertion pins that the handler
    // returned the row (createReportHandler `return result`) rather than undefined.
    expect(report?.id, 'report.create should return a numeric report id').toEqual(
      expect.any(Number)
    );

    // 🔴 The ACTIONING legs (report.getAll → report.setStatus → re-read as
    // 'Actioned') used to live here. #3573 deleted both procedures from this app's
    // report.router.ts — that queue is the moderator app's now, and asserting it
    // from a preview of THIS app is not possible. Do not "restore" them here: the
    // procedures do not exist, so it cannot be made to work.
    //
    // The coverage itself was rebuilt where the code now lives, against the spoke's
    // `setReportStatus` and the form actions over it:
    //   apps/moderator/src/lib/server/__tests__/reports-actioning.test.ts
    //   apps/moderator/src/routes/reports/[slug]/__tests__/report-{actions,queue}.test.ts
    // Unit-level rather than end-to-end, so it is not the same coverage — it does not
    // exercise a real report through a real database. What it does buy is a tier that
    // renders RED: the `App unit tests` job is not `continue-on-error`, unlike this
    // preview job and unlike `unit`. It still does not block a merge — `main` has no
    // required_status_checks — so read it as a louder signal, not as a gate.
    //
    // The do-not-restore instruction still stands, and its reason is the one above:
    // the procedures were deleted from this app. That is what makes restoring them
    // here impossible, independently of what any other suite covers.
  });
});
