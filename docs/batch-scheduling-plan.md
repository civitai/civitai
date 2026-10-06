# Batch post scheduling — master plan

ClickUp project: 868mcqb8t (owner: Luis; Justin closes it). Origin: feature request 868m9kjnm (closed,
replaced by the project). Scope doc: attached to the project task as
`2026-10-02_batch-scheduling-scope.html`.

Companions: [`batch-scheduling-ux.md`](batch-scheduling-ux.md) (UX plan, both phases),
[`batch-scheduling-phase1-tech.md`](batch-scheduling-phase1-tech.md) (Phase 1 implementation plan) and
[`batch-scheduling-planner-element.md`](batch-scheduling-planner-element.md) (Phase 2: the planner as
a Web Component in both apps).

Done when: Phase 1 is merged and switched on for creators, or Justin decides not to build it.

## 1. State of play (2026-10-06)

| Phase | Scope | State |
|-------|-------|-------|
| 0 | Fix stale image `sortAt` on reschedule | **Fixed on main** since June (`820f4ecedc`, `b5f8f4047d`): `updatePost` → `afterPostPublish` reindexes the post's images. Bug ticket 868k68g0z is still `pending review`; needs a prod verification query and closing. |
| 1 | Batch composer in the main app, behind a flag | **Not started.** Technical plan ready; no code. |
| 2 | Planner (calendar of scheduled posts, drag to reschedule) | **First pass exists**, built by the foreman agent in Creator Studio, uncommitted, reviewed below. Ships as a Web Component in both apps (decided 2026-10-06; see the element plan). |
| 3 | Saved presets | Not started; Phase 1 leaves hooks (UX plan §5). |

The first pass was built out of order: the agent that ran on the feature request built Phase 2 before
Phase 1 existed, in Creator Studio, on a `main` from 2026-10-02. It lives in the worktree
`~/foreman/data/civitai/worktrees/868m9kjnm` (branch `foreman/868m9kjnm`, nothing committed). Its own
notes are in `REVIEW.md` there; its screenshots in `.foreman/shots/`.

## 2. Review of the first pass

What it built: a `/calendar` route in Creator Studio (month grid, drag a post to another day, side
sheet with reschedule and publish-now), a Kysely read of the creator's posts, a main-app REST endpoint
`POST /api/v1/posts/schedule` (reschedule or publish now; moves the model/version release when the post
is tied to a scheduled release), two pure rule helpers `getPostScheduleError` / `getPostScheduleScope`
in `src/server/utils/post-reschedule.ts`, and the `POST_MAXIMUM_SCHEDULE_MONTHS` constant replacing a
hard-coded 3. Tests: 32 main-app unit tests, 93-line Svelte helper test. Typecheck and suites pass.

Seven review lanes ran: the foreman's own correctness, intent, perf, reuse and test reviews, then
svelte correctness, idiom and abstraction reviews on 2026-10-06. Consolidated:

**Keep regardless of where the planner ends up**
- The release semantics: a post on a Scheduled model version moves the *release* (whole model if the
  model is unpublished, else the version), a drop on a release post opens the panel instead of
  committing, publish-now takes a confirm step. These were the hardest decisions and they are right.
- `post-reschedule.ts` (window rules stricter than `post.update`, which silently publishes
  out-of-window dates) and its tests.
- The `POST_MAXIMUM_SCHEDULE_MONTHS` extraction.
- The refusal to move an unpublished model whose other versions are also scheduled.

**Must fix if the Creator Studio page ships**
1. A partial write is reported as a plain failure and the page never refreshes: the endpoint answers
   409 *after* the release moved; a 30 s `callMainApp` timeout answers 502 after the write landed.
   `handleResult` must `invalidateAll()` on failure/error and word 409/502 as "may have gone through".
2. `Post` has no `(userId, publishedAt)` index; the month query filters a 44-day `publishedAt` range
   by user. Confirm with `pg_indexes` + `EXPLAIN` on the replica; add `CREATE INDEX CONCURRENTLY` by
   hand if missing. Phase 1's cap query is bounded by today so it does not need it; the planner does.
3. `MAX_POSTS = 500` truncates silently, and the cut falls on the *future* end of the range, which is
   the part the page exists for. Fetch `+1` and show a notice, or order from the end of the range.
4. The client decides drop-commits-vs-panel from `post.release`, read from the replica; the server
   recomputes the scope from the primary. A stale replica lets a drop move a whole release with no
   confirmation. Send `expectedScope` and 409 on mismatch.
5. `submit()` calls `applyAction` on `error` results, which swaps the calendar for the error page.
6. Client 3-month bound uses `setUTCMonth(+3)` (rolls Nov 30 → Mar 2); server uses dayjs (clamps).
7. `postCalendarEnabled` re-implements `modFallbackFlagEnabled` from `$lib/server/main-app-flags.ts`,
   which landed on main after the worktree's base. Rebase and import it.
8. `role="gridcell"` with no `role="grid"`/`row` ancestor and a dead `tabindex="-1"`; `text-dark-3`
   on `bg-dark-7/60` fails contrast; the hand-rolled confirm step should use `AlertDialog`.
9. The REST endpoint re-implements the tRPC guards (ban, onboarding, muted, email verification) and
   calls controllers with a hand-built context. Run the real procedures through
   `createCallerFactory(appRouter)` instead, as the reuse review proposed.
10. Split the 478-line page into `PostChip`, `CalendarGrid`, `PostDetailSheet` siblings before Phase 2
    adds week view and multi-select.

**UX verdict** (full critique in the UX plan §1): the first pass is a correct single-post reschedule
tool, not yet a planner. It has no density strategy (fails at ~150 posts/month, and 13 users already
have 200+ queued), no bulk operations, no unschedule, drag with no keyboard/touch path and no undo,
month view only with a 720 px minimum width, no cap/gap feedback, no model filter, and no quick-add.
Those are the features the request was actually for.

## 3. Decisions

Settled by the scope (Justin, 2026-10-02) and followed here: composer in the main app behind a flag;
daily cap counted on the go-live day; 30-minute minimum gap per user; members first via Flipt then
everyone; the 20-image-per-post limit stays; daily rewards from spread schedules accepted; minute
jitter, never :00.

**Decided by Luis, 2026-10-06**

1. **The planner is a Web Component that lives in both apps.** The scope left "Creator Studio or
   main app" open; the UX review argued for the main app (most of the 618 schedulers are not Creator
   Program members; every edge of the planner crosses the app boundary otherwise; browsing-level blur
   and mobile layouts live there). Shipping one `<civitai-post-planner>` element, built in Creator
   Studio and hosted by both its `/calendar` route and a main-app `/user/schedule` page, gets both:
   RLY's Creator Studio planner and a planner next to the composer for everyone else, with one UI to
   maintain. It follows the Training Studio element pattern already in production. Data goes through
   a host-supplied backend (tRPC in the main app, SvelteKit server routes in Creator Studio), so no
   credential or CORS surface is added. Full design in the element plan. Cost: ~0.5–1 week over a
   single-host planner.

**Recommended, needs Justin's confirmation**

2. **Batch limits**: 200 posts and 500 files per batch (the UX plan's 500 and the tech plan's 200
   reconciled: grouping N images per post makes 500 files fit in ≤ 200 posts; the composer says so when
   it doesn't).
3. **Weekday/time-slot schedule mode** ("only Mon/Wed/Fri at 6 PM"): Phase 2 unless it costs under a
   day in Phase 1.
4. **Review step is its own screen** (virtualised table, overrides limited to title / time / remove).
5. **"Fix spacing automatically" pushes forward only**, never earlier than asked.
6. **Phase 1 success CTA** before the planner exists: the posts tab with the Scheduled filter on.

## 4. Sequencing

**Now, in parallel with Phase 1**
- Verify Phase 0 in prod (stale `sortAt` count over the last 14 days of reschedules, expect 0), then
  close 868k68g0z against the two commits. Blocked on the replica tunnel as of 2026-10-06.
- Tell Justin the planner decision on 868mcqb8t and get his call on decisions 2–6. Phase 1 does not
  depend on them.
- The foreman worktree stays until PR F has ported what it needs; nothing in it is committed.

**Phase 1 — composer** (tech plan §9; ~1.5–2 weeks, four flag-dark PRs on `main`)
- PR A: schedule generators, jitter, validator, `getDailyPostLimit`, constants, tests, in
  `@civitai/shared/post-scheduling` so the element and the Creator Studio server import the same code.
- PR B: `post.validateBatchSchedule` + `post.scheduleBatch`, flag `batchPostScheduling` at `['mod']`.
- PR C: `/posts/batch` composer (UX plan §3): media grid, apply-to-all, schedule builder, sticky
  summary rail with preview and inline violations, review screen, progress modal.
- PR D: owner-only "Promote this model" on the model page, feature doc.
- Rollout: Flipt flag with an `isMember` rule, dogfood as mods, widen.

**Phase 2 — planner element** (element plan §5, UX plan §4; ~2–2.5 weeks, four flag-dark PRs)
- PR E, main-app server: `post.getScheduled`, `post.reschedule` (with the first pass's release-move
  logic and an `expectedScope` check), `post.publishNow`, `post.unschedule`, `post.shiftSchedule`;
  REST twins for Creator Studio via `createCallerFactory`; flag `postPlanner`; the
  `Post(userId, publishedAt)` index SQL, applied by hand.
- PR F, Creator Studio: the element scaffold (host seam, backend interface, shell and element
  backends, `vite.element.config.ts` with the hoisted `scopeToElement`), the `/calendar` shell route
  re-hosting the first pass's UI split into components with the must-fix list applied, and the
  `routes/api/planner/*` server routes.
- PR G, Creator Studio: the planner UX. Month with `+N more` and `n/cap` badges, agenda view, drag with
  keyboard nudge and undo, select mode with shift ± / move-to-day / unschedule, model filter,
  quick-add, legend; release posts amber and excluded from bulk moves.
- PR H, main app: the `/user/schedule` host page, `NEXT_PUBLIC_CREATOR_STUDIO_URL`, the posts tab's
  "Open planner" entry, the composer success CTA, a Creator Studio dashboard tile.
- Week view with drag-to-time, bulk publish-now and drafts on the calendar come later.

**Phase 3 — presets** (~1 week, migration applied by hand): named presets of resources, tools,
techniques, tags, title template; used in the composer and the post editor. Phase 1 ships the hooks
(UX plan §5) and a localStorage "use last settings" to measure demand first.

## 5. Open items with closing conditions

| Item | Closes when | Who checks |
|------|-------------|------------|
| Phase 0 verification | Prod query shows 0 stale images for reschedules in the last 14 days; 868k68g0z set to complete | Luis |
| Scope decisions 2–6 | Justin confirms or amends them on 868mcqb8t | Justin |
| `Post(userId, publishedAt)` index | `pg_indexes` shows it, or EXPLAIN shows the month query is already cheap | Luis, before PR E |
| First-pass worktree | Deleted once PR F has ported its UI, query and endpoint logic | Luis |
| `scopeToElement` hoist | Training Studio's element build imports the shared module and its embed still renders correctly in the main app | Luis, in PR F |
