# Batch post scheduling — the planner as a Web Component

Companion to [`batch-scheduling-plan.md`](batch-scheduling-plan.md) (master plan),
[`batch-scheduling-ux.md`](batch-scheduling-ux.md) (what the planner does) and
[`batch-scheduling-phase1-tech.md`](batch-scheduling-phase1-tech.md) (the composer). ClickUp 868mcqb8t.

Decision (Luis, 2026-10-06): the planner ships as one framework-agnostic custom element,
`<civitai-post-planner>`, that runs in **both** hosts — Creator Studio's `/calendar` route and a
main-app page — on the pattern Training Studio already proved
([`training-studio-web-component.md`](training-studio-web-component.md),
`apps/training-studio/element/`, `src/pages/training-studio/index.tsx`). This replaces the
"Creator Studio or main app" decision the scope left open.

## 1. Shape

- **Pure client.** The element renders the planner and holds UI state. It owns no server routes, no
  credentials and no URL space. Everything host-specific comes in through one JS property, `host`,
  set after upgrade (never attributes).
- **Data through a backend seam, not direct fetches.** Unlike Training Studio, whose element talks to
  the orchestrator with an injected token, the planner's data lives in the main app's database. Each
  host supplies a `PlannerBackend` implementation: the main app with tRPC, Creator Studio with its own
  SvelteKit server routes (Kysely reads, `callMainApp` writes). No new CORS surface, no token in the
  browser.
- **Built and served from Creator Studio**, exactly as Training Studio builds and serves its element:
  `apps/creator-studio/element/` compiled by a `vite.element.config.ts` into
  `static/element/civitai-post-planner.{js,css}`; Creator Studio's own `/calendar` route imports the
  Svelte component directly (the "shell"); the main app loads the bundle from the Creator Studio
  origin (new `NEXT_PUBLIC_CREATOR_STUDIO_URL`, default `https://creator-studio.civitai.com`).
- **Light DOM with build-time scoping** (`shadow: 'none'`), reusing Training Studio's
  `scopeToElement` PostCSS plugin with the tag parametrised. Hoist that plugin to a shared module
  (`packages/civitai-ui/element-scope.ts`) rather than copying it; two elements now depend on it.
  Dark by default; a host toggles light by putting a `light` class on the tag. Portalled UI
  (sheet, dialogs, selects) goes to a body-level root the element creates, with every scoped rule
  dual-targeted onto `[data-cpp-portal]`, as Training Studio does with `[data-cts-portal]`.
- **Shared pure logic in `@civitai/shared`** (`post-scheduling/`): the window constants, the
  schedule generators and jitter, the cap/gap validator, `getPostScheduleScope` and
  `getPostScheduleError`. Consumed by the main-app server, the React composer, the element and the
  Creator Studio server, so the restated constants and the duplicated scope rule the abstraction
  review flagged cannot drift. Phase 1's PR A puts the logic there from the start.

## 2. The host contract

```ts
// apps/creator-studio/src/lib/planner/host.ts  (the seam; flow code imports only from here)

type PlannerView = 'month' | 'agenda' | 'week';
type PlannerLocation = {
  view: PlannerView;
  /** YYYY-MM for month/week, or the agenda's start day YYYY-MM-DD. */
  anchor: string;
  modelVersionId?: number;
};

interface PlannerPost {
  id: number;
  title: string | null;
  publishedAt: string;            // ISO instant; the element buckets into the viewer's local day
  modelVersionId: number | null;
  nsfwLevel: number;
  imageCount: number;
  cover: { url: string; type: 'image' | 'video' | 'audio' } | null;
  /** Set when the post goes live with a scheduled release and so moves with it. */
  release: { scope: 'model' | 'version'; modelName: string; versionName: string } | null;
}

interface PlannerBackend {
  getScheduled(range: { from: string; to: string; modelVersionId?: number }): Promise<{
    posts: PlannerPost[];
    /** The per-UTC-day cap and the gap the server enforces, so the grid can badge days. */
    dailyLimit: number;
    minGapMinutes: number;
    /** True when the range held more than the server returned; the UI says so. */
    truncated: boolean;
  }>;
  /** `expectedScope` is what the UI showed the creator; the server refuses with a conflict when its
   *  own computation differs (a stale replica must not turn a chip drop into a release move). */
  reschedule(req: { id: number; publishedAt: string; expectedScope: 'post' | 'version' | 'model' })
    : Promise<{ publishedAt: string; scope: 'post' | 'version' | 'model'; movedPostIds: number[] }>;
  publishNow(req: { id: number; expectedScope: 'post' | 'version' | 'model' })
    : Promise<{ publishedAt: string; scope: 'post' | 'version' | 'model'; movedPostIds: number[] }>;
  /** Back to drafts. Release posts are refused (they are unscheduled from the model page). */
  unschedule(ids: number[]): Promise<{ unscheduledIds: number[] }>;
  /** Bulk move; the server re-validates window, gap and cap for every target date. */
  shift(req: { ids: number[]; deltaMinutes: number }): Promise<{ moved: { id: number; publishedAt: string }[] }>;
}

interface PlannerElementHost {
  backend: PlannerBackend;
  config: {
    /** Cloudflare Images base for cover thumbnails. */
    imageLocation: string;
    /** The viewer's browsing level; covers with a higher nsfwLevel render blurred. */
    browsingLevel: number;
    /** Hide the quick-add and "schedule a batch" affordances until the composer exists. */
    composerAvailable: boolean;
  };
  /** The host owns the URL space (same semantics as Training Studio's hrefFor/navigate). */
  hrefFor(loc: PlannerLocation): string;
  navigate(loc: PlannerLocation): Promise<void>;
  /** Relative = same-tab in-host navigation; absolute = new tab (hostLink semantics). */
  editPostUrl(id: number): string;
  viewPostUrl(id: number): string;
  modelPageUrl(req: { modelId: number; modelVersionId: number }): string;
  composerUrl?(req: { startAt?: string; modelVersionId?: number }): string;
}
```

Flow components resolve everything through `backend()`, `hrefFor()`, `navigate()`, `config()` and
`portalProps()` from the seam, never from `$app/*`, `$env/*` or a hard-coded path. The element
wrapper (`element/CivitaiPostPlanner.svelte`) sets the seam from its `host` prop; the shell
(`routes/(app)/calendar/+page.svelte`) sets it from Kit APIs. Both render the same `PlannerApp`.

The `location` property is host-controlled: the element renders whatever view the host says, and
its own navigations go out through `host.navigate`, which flips `location` back in. Query state on
the host route (`?view=&anchor=&mv=`) is the source of truth in both hosts.

## 3. Hosts

### Creator Studio shell (`/calendar`)
- `+page.svelte` sets the seam with `shellBackend` (relative fetches to `routes/api/planner/*`) and
  mounts `PlannerApp`. Flag-gated with `modFallbackFlagEnabled(POST_PLANNER_FLAG, user)` from
  `$lib/server/main-app-flags.ts`; nav item as in the first pass.
- `routes/api/planner/scheduled/+server.ts` — Kysely read (the first pass's query, with the cover
  subqueries collapsed into one lateral join, the `+1` overfetch for `truncated`, and
  `getPostScheduleScope` from `@civitai/shared` for the release label).
- `routes/api/planner/{reschedule,publish-now,unschedule,shift}/+server.ts` — forward the session
  cookie through `callMainApp` to the main app's REST twins (below), mapping its `409` to a conflict
  the UI words as "may have gone through; refreshed".

### Main app host (`/user/schedule`)
- `src/pages/user/schedule.tsx`, modelled line for line on `src/pages/training-studio/index.tsx`:
  loads `${NEXT_PUBLIC_CREATOR_STUDIO_URL}/element/civitai-post-planner.{css,js}` (dev
  cache-buster, one module script per document, `customElements.whenDefined` before setting
  `host`), mirrors Mantine's colour scheme onto the `light` class, keeps `location` in shallow
  query state, renders `NotFound` without the flag.
- `backend` is tRPC: `post.getScheduled`, `post.reschedule`, `post.publishNow`, `post.unschedule`,
  `post.shiftSchedule`. `editPostUrl` is `/posts/{id}/edit?returnUrl=…`, `composerUrl` is
  `/posts/batch?startAt=…` once Phase 1 ships.
- Entry points: the posts tab's "Scheduled" filter gets an "Open planner" button; the composer's
  success screen links here; Creator Studio's dashboard gets a "Scheduled posts · open planner" tile
  that points at its own `/calendar`.

### Main-app server (shared by both hosts)
- tRPC procedures above, in `post.router.ts`, each `isFlagProtected('postPlanner')` and
  `TokenScope.MediaWrite`. `post.reschedule` carries the first pass's release logic
  (`publishModelHandler` / `publishModelVersionHandler` when the scope is `model` / `version`,
  the sibling-scheduled-versions refusal, the post-write re-read) moved from the REST handler into a
  service function, plus the `expectedScope` check.
- REST twins for Creator Studio under `/api/v1/posts/{schedule,unschedule,shift}` built with
  `createCallerFactory(appRouter)` over an authenticated context, as the reuse review proposed, so
  the ban / onboarding / muted / email-verification guards are the procedures' own and not a copy.
  The first pass's `src/pages/api/v1/posts/schedule.ts` is the starting point; its hand-built
  `ProtectedContext` cast goes away.
- Flag: `postPlanner: { availability: ['mod'], fliptKey: 'post-planner' }` in
  `feature-flags.service.ts`; Creator Studio reads the same Flipt key. One switch, both hosts.
- Index: `CREATE INDEX CONCURRENTLY "Post_userId_publishedAt_idx" ON "Post"("userId","publishedAt")`,
  written under `packages/civitai-db-schema/prisma/migrations/` and applied by hand, after confirming
  with `pg_indexes` that nothing equivalent already exists in prod.

## 4. What carries over from the first pass

| First pass | Becomes |
|------------|---------|
| `apps/creator-studio/src/routes/(app)/calendar/+page.svelte` (478 lines) | `src/lib/planner/{PlannerApp,CalendarGrid,PostChip,PostDetailSheet,…}.svelte`, rendered by both the shell and the element |
| `src/lib/server/post-calendar.ts` Kysely read | `routes/api/planner/scheduled/+server.ts` |
| `src/lib/post-calendar.ts` grid/month helpers (+ test) | `src/lib/planner/calendar.ts`, unchanged; the restated window constants are deleted in favour of `@civitai/shared` |
| `src/pages/api/v1/posts/schedule.ts` | service function behind `post.reschedule` / `post.publishNow`; REST twin via `createCallerFactory` |
| `src/server/utils/post-reschedule.ts` (+ test) | `@civitai/shared/post-scheduling` |
| `POST_MAXIMUM_SCHEDULE_MONTHS` extraction | kept, moves to `@civitai/shared` |
| The 10 must-fix review findings in the master plan §2 | fixed during the port; items 1, 3, 4, 5, 6 land in the shared flow components so both hosts get them once |

## 5. Sequencing

Phase 1 (composer) is unchanged except that PR A writes the pure scheduling logic into
`@civitai/shared/post-scheduling` instead of `src/utils`, with `@civitai/shared` already in both
apps' transpile lists.

Phase 2, four PRs on `main`, each flag-dark:

- **PR E — main-app server** (~500 LOC). Procedures, the release-move service function, REST twins,
  `postPlanner` flag, index migration SQL. Carries the first pass's endpoint tests, re-pointed.
- **PR F — element scaffold in Creator Studio** (~600 LOC). `src/lib/planner/host.ts` seam,
  `PlannerBackend`, `shellBackend`, `elementBackend`, `element/` entry + wrapper + CSS,
  `vite.element.config.ts` with the hoisted `scopeToElement`, `build:element` in the `build` script,
  `/calendar` shell route re-hosting the first pass's UI split into components, `routes/api/planner/*`.
  Ships the first pass's behaviour with the must-fix list applied; no new UX yet.
- **PR G — planner UX** (~900 LOC). The UX plan §4: month with `+N more` and `n/cap` badges, agenda
  view (phone default), drag with keyboard nudge and undo, select mode with the bulk bar (shift ±,
  move to day, unschedule), model filter, quick-add, legend, `truncated` notice. Week view later.
- **PR H — main-app host** (~300 LOC). `/user/schedule` page, `NEXT_PUBLIC_CREATOR_STUDIO_URL`,
  the "Open planner" entry on the posts tab, the composer success CTA, the Creator Studio dashboard
  tile. Measure the element's bundle weight on this route before widening the flag.

Estimate: 2–2.5 weeks for one engineer, against the scope's 1–1.5 for a single-host planner. The
extra half to one week buys the seam, the element build, the second host and the REST twins.

## 6. The composer stays React in Phase 1

The composer was considered for the same treatment and deferred. Its value is mostly main-app
machinery the element would have to re-implement or route through host callbacks: `useMediaUpload`
and the multipart S3 upload, client-side metadata parsing, the resource / tools / techniques / tag
pickers, and `post.scheduleBatch`. Creator Studio has none of that, so a composer element would mean
a Svelte dropzone plus host-provided upload and picker callbacks in both hosts, roughly another
1.5 weeks, and the project's done condition is Phase 1 switched on. If both-host composing is wanted
later, the path is the same seam pattern with `uploadMedia`, `pickResources`, `searchTags`,
`listTools`, `listTechniques` and `scheduleBatch` on the host contract; the shared logic in
`@civitai/shared` already makes the schedule builder and preview portable.

## 7. Risks

- **Contract skew between the element and the main-app host.** Training Studio lives with this; keep
  the `host` contract additive, export its types from the element entry, and have the element render
  a plain "Waiting for a host context…" rather than throw when a field is missing.
- **Creator Studio deploy state gates the main-app page.** If the bundle fails to load the main app
  shows a one-line error, as the Training Studio host does. Acceptable for a flag-gated tool; a
  same-repo copy of the bundle into `public/` is the fallback if it ever is not.
- **Styles in a Mantine page.** The scoping plugin, the `@layer` unwrapping and the Tailwind v3/v4
  transform collision are all solved in `apps/training-studio/vite.element.config.ts`; hoisting it
  rather than copying it is what keeps the two elements fixed together.
- **Bundle weight.** Svelte runtime + bits-ui sheet/dialog/select + the planner. Lazy on one route;
  measure before widening.
- **Cache busting in prod.** The bundle URL is stable; a stale CSS cache after a deploy reads as a
  theming bug. Follow whatever Training Studio does for its `/element/*` cache rules.
- **Two cap counters** (Redis at create time vs DB by go-live day) and **UTC-day labelling** are
  Phase 1 risks that the planner inherits; the per-day badge must say which day boundary it counts.
