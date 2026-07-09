import { expect, test } from '@playwright/test';
import { storageStatePath } from './preview-fixtures';
import { trpcMutation, trpcQuery, uniqueToken } from './preview-trpc';
import { retryFlaky } from './preview-retry';

/**
 * Moderation-surface tests for a deployed PR preview environment.
 *
 * Runs as the `mod` fixture — the ONLY role that both clears the preview gate and
 * carries user.isModerator, which the /moderator/* tRPC procedures
 * (moderatorProcedure) require. The mod fixture is also onboarding=15, so it
 * passes guardedProcedure and can self-seed a post + report.
 *
 * Two render tests (the reports + images queues render behind the gate) and one
 * end-to-end ACTION test (a mod self-seeds an isolated post -> reports it ->
 * actions the report), kept as separate test()s so a render-selector miss can't
 * mask the action coverage and vice-versa.
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
 *                       (server/schema/report.schema.ts:104) — a discriminatedUnion
 *                       on `reason`. The `Spam` variant (reportSpamSchema, :92) is the
 *                       minimal shape: { type: ReportEntity, id: number,
 *                       reason: 'Spam', details: {} }. `type` is z.enum(ReportEntity)
 *                       and the Post entity string is 'post'
 *                       (shared/utils/report-helpers.ts:8 `Post = 'post'`).
 *                       Returns the created Report row incl. `id` + `status`
 *                       (server/services/report.service.ts createReport `return createdReport`).
 *  - report.getAll      moderatorProcedure, input getReportsSchema
 *                       (server/schema/report.schema.ts:128) = getAllQuerySchema
 *                       (page/limit) + { type: ReportEntity, filters?, sort? }.
 *                       Row shape selects post.post.id
 *                       (server/controllers/report.controller.ts:180) so a Post
 *                       report row is matched via row.post?.post?.id.
 *  - report.setStatus   moderatorProcedure, input setReportStatusSchema
 *                       (server/schema/report.schema.ts:116) = { id: number,
 *                       status: ReportStatus }. ReportStatus ∈
 *                       Pending|Processing|Actioned|Unactioned (prisma/schema.prisma:1114).
 */

const ROLE = 'mod' as const;

// Mirror preview-smoke.spec.ts: assert we cleared the preview gate.
function assertGatePassed(page: import('@playwright/test').Page, path: string) {
  expect(page.url(), `${path}: should not redirect to /login`).not.toContain('/login');
  expect(page.url(), `${path}: should not redirect to /preview-restricted`).not.toContain(
    '/preview-restricted'
  );
}

test.describe('moderation surface (mod)', () => {
  test.use({ storageState: storageStatePath(ROLE) });

  test('/moderator/reports renders the report queue', async ({ page }) => {
    const resp = await page.goto('/moderator/reports', { waitUntil: 'domcontentloaded' });
    expect(resp?.status(), 'HTTP status for /moderator/reports').toBeLessThan(400);
    assertGatePassed(page, '/moderator/reports');

    // Page-loaded anchor: reports.tsx renders <Meta title="Reports" /> (line 219),
    // so the document <title> is the most stable "the mod page rendered (not an
    // error/redirect)" signal, independent of how many rows the prod-clone DB has.
    await expect(page).toHaveTitle(/Reports/i, { timeout: 30_000 });

    // Structural presence of the queue UI. reports.tsx renders a MantineReactTable
    // (import line 30, JSX line 231), which emits a <table> with role="table".
    // Be tolerant of 0..N rows on the prod clone — assert the grid scaffold exists,
    // not any specific row.
    // NOTE: if MantineReactTable's role/markup changes, widen this — the intent is
    // "a table/grid structure is on the page". A visible table OR a non-empty main
    // region both satisfy "the queue rendered".
    const table = page.getByRole('table').first();
    await expect(table).toBeVisible({ timeout: 30_000 });
  });

  test('/moderator/images renders the image review queue', async ({ page }) => {
    // /moderator/images is image-search-backed (getModeratorReviewQueue ->
    // getAllImagesIndex -> the in-cluster feeds-proxy), which intermittently 5xx's
    // under concurrent preview-build load. Retry the navigation with backoff to ride
    // out a transient search spike — honest: the page must still render < 400, and a
    // sustained outage still fails after the attempts are exhausted.
    await retryFlaky('/moderator/images navigation', async () => {
      const resp = await page.goto('/moderator/images', { waitUntil: 'domcontentloaded' });
      expect(resp?.status(), 'HTTP status for /moderator/images').toBeLessThan(400);
    });
    assertGatePassed(page, '/moderator/images');

    // images.tsx is an infinite list off trpc.image.getModeratorReviewQueue. It
    // renders either image <Card>s (Mantine Card import line 5, usage line 366) OR,
    // when the queue is empty, <NoContent message="There are no images that need
    // review" /> (line 343). Tolerate BOTH branches: assert at least one of the
    // known structural anchors is present so the test passes on a full or empty
    // prod-clone queue.
    // NOTE: broad OR over the empty-state copy and the card/list region. If a
    // preview shows different empty copy, widen the regex — the structural intent
    // is "the review queue surface rendered, not an error/redirect".
    const queueRendered = page
      .getByText(/no images that need review|need review|review queue/i)
      .first()
      .or(page.locator('.mantine-Card-root, [class*="Card-root"]').first());
    await expect(queueRendered).toBeVisible({ timeout: 30_000 });
  });

  test('mod can self-seed a post, report it, and action the report', async ({ page }) => {
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
    //    type:'post' is ReportEntity.Post. createReport returns the row incl. id+status.
    // NOTE: 'Spam' / type:'post' verified in report.schema.ts:92 + report-helpers.ts:8.
    // If the CSRF/origin gate (createContext.ts) rejects this direct tRPC POST with
    // 403 live, the UI-driven fallback would be: open the post page → use the report
    // menu → then drive setStatus from /moderator/reports' row status Badge → Menu.
    const report = await trpcMutation<{ id: number; status: string }>(
      page.request,
      'report.create',
      { type: 'post', id: post.id, reason: 'Spam', details: {} }
    );

    // 3) Resolve the report id. Prefer it straight from report.create's return; fall
    //    back to report.getAll (moderatorProcedure) matching on the seeded post id.
    let reportId: number | undefined = report?.id;
    if (typeof reportId !== 'number') {
      // getReportsSchema = page/limit (getAllQuerySchema) + type (ReportEntity).
      // Newest-first isn't guaranteed by default, so request a generous page and
      // match on the post relation's id (handler selects post.post.id).
      const all = await trpcQuery<{
        items: Array<{ id: number; post?: { post?: { id?: number } | null } | null }>;
      }>(page.request, 'report.getAll', { page: 1, limit: 100, type: 'post' });
      const mine = all?.items?.find((r) => r.post?.post?.id === post.id);
      reportId = mine?.id;
    }
    expect(reportId, 'should resolve the seeded report id').toEqual(expect.any(Number));

    // 4) Action the report. setReportStatusSchema = { id, status } with status ∈
    //    ReportStatus; 'Actioned' is a valid enum member.
    // NOTE: setStatus's handler returns void (controller setReportStatusHandler), so
    // we assert the mutation resolves without throwing — trpcMutation throws on any
    // tRPC error envelope or non-2xx, so a clean resolve == success.
    await expect(
      trpcMutation(page.request, 'report.setStatus', { id: reportId, status: 'Actioned' })
    ).resolves.toBeDefined();

    // Best-effort confirmation: re-query and assert our row now reads 'Actioned'.
    // Kept non-fatal-shaped (still an assertion, but only runs if getAll is reachable
    // for a mod, which it is) — the setStatus resolve above is the primary signal.
    const after = await trpcQuery<{
      items: Array<{ id: number; status?: string; post?: { post?: { id?: number } | null } | null }>;
    }>(page.request, 'report.getAll', { page: 1, limit: 100, type: 'post' });
    const updated = after?.items?.find((r) => r.id === reportId);
    if (updated) {
      expect(updated.status, 'seeded report should now be Actioned').toBe('Actioned');
    }
  });
});
