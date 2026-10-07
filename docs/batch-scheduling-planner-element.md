# Batch post scheduling — the planner as a Civitai Element

Companion to [`batch-scheduling-plan.md`](batch-scheduling-plan.md) (master plan),
[`batch-scheduling-ux.md`](batch-scheduling-ux.md) (what the planner does) and
[`batch-scheduling-phase1-tech.md`](batch-scheduling-phase1-tech.md) (the composer). ClickUp 868mcqb8t.

Decisions (Luis, 2026-10-06 and 2026-10-07): the planner ships as one framework-agnostic custom
element, `<civitai-post-planner>`, that runs in **both** hosts, Creator Studio's `/calendar` route and
a main-app page, and it is built on **Civitai Elements**: the `<civitai-*>` design-system elements from
`@civitai/components` (developer.civitai.com/apps/elements), so it looks and behaves like the rest of
the platform without a second styling system.

## 1. The stack it joins

`@civitai/components` (npm, 0.9.x; source `civitai/civitai-app-starters`, `packages/civitai-components`)
ships the Civitai design system as Lit 3 custom elements. Facts the plan relies on:

- Each element extends `CivitaiElement` (exported from `@civitai/components/internals` together with
  `defineElement`, `hostBaseline` and `spinner`), renders in a **shadow root**, and reads
  `--civitai-*` tokens from `@civitai/theme`, which the first element to mount injects into the
  document. Tokens inherit across shadow boundaries; ancestor selectors do not, so scheme-dependent
  values are tokens (`--civitai-color-surface`, `--civitai-color-border`, `--civitai-card-border-width`…).
- `@civitai/theme` is generated from the main app's real Mantine theme (`ThemeProvider.tsx`) and the px
  breakpoint scale; a drift guard fails when they diverge. The element therefore matches Mantine by
  construction.
- `@civitai/components-react` wraps every element with `@lit/react` `createComponent`, generated from
  the elements manifest, so React assigns props as properties and typed events come from the element.
- Theme is `data-theme="light" | "dark"` on any ancestor; OS preference otherwise.
- The published bundles (`elements.js` 32 kB, `site-elements.js` 38 kB gzip) are budgeted and fail the
  build when exceeded. A post planner is far larger and app-specific, so it does **not** go into that
  package; it depends on it.
- Nothing in this repo uses `@civitai/components` yet. The planner is the first consumer.

## 2. Shape

- **One Lit element, `<civitai-post-planner>`**, in a new workspace package `packages/civitai-post-planner`
  (`@civitai/post-planner`), depending on `lit`, `@civitai/components` and `@civitai/shared`
  (`post-scheduling`). It extends `CivitaiElement` and registers with `defineElement`, exactly as the
  design-system elements do, and composes them: `civitai-segmented-control` for Day · Week · Month ·
  Agenda, `civitai-button`/`-button-group`, `civitai-select`, `civitai-checkbox`, `civitai-badge` for
  the `n/cap` counts and release markers, `civitai-tooltip`, `civitai-menu`/`-menu-item` for row
  actions, `civitai-confirm-dialog` for publish-now and unschedule, `civitai-toast-region` for the undo
  toast, `civitai-image` for covers (its `blocked`/`pending` states cover the browsing-level blur),
  `civitai-text-input`/`civitai-number-input` in the drawer and the shift dialog, `civitai-alert` for
  the truncated notice and the release caveat, `civitai-text`/`-stack`/`-group`/`-card` for structure.
- **What it draws itself** (nothing in the kit covers it): the month grid, the week and day hour
  rows, the post chip, the drag-and-drop layer, and the right-hand drawer. All of it is Lit templates
  in the element's own shadow styles using only `--civitai-*` tokens. Candidates to upstream to
  `@civitai/components` once they settle: `civitai-drawer`, `civitai-date-input`, `civitai-calendar-grid`.
- **Pure client, data through a backend seam.** The element owns no routes, credentials or URLs.
  Everything host-specific arrives through one JS property, `host` (below), set after upgrade.
- **Consumed as a package, not loaded cross-origin.** Both hosts live in this monorepo and already
  transpile `@civitai/*` workspace packages, so the main app imports the element directly (behind
  `next/dynamic` with `ssr: false`, since a shadow-DOM element has nothing to hydrate) and Creator Studio
  imports `@civitai/post-planner/define` in its route. This drops the Training Studio element's
  cross-origin bundle load, its `scopeToElement` PostCSS plugin and its `.light`-class theming: shadow
  DOM gives isolation and `data-theme` gives the scheme. Training Studio's element stays as it is.
- **React binding** `packages/civitai-post-planner/src/react.ts`: one `createComponent` wrapper
  (`@lit/react`) with the element's event map, the same shape `@civitai/components-react` generates.

## 3. The host contract

```ts
// packages/civitai-post-planner/src/host.ts

type PlannerView = 'day' | 'week' | 'month' | 'agenda';
type PlannerLocation = {
  view: PlannerView;
  /** YYYY-MM-DD anchor day (the month/week containing it, or the day itself). */
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

interface PlannerPostDetail extends PlannerPost {
  description: string | null;
  media: { id: number; url: string; type: 'image' | 'video' | 'audio'; nsfwLevel: number; width: number; height: number }[];
  model: { id: number; name: string; versionName: string } | null;
  resources: { id: number; name: string; type: string; modelId: number; versionId: number }[];
  tools: string[];
  techniques: string[];
  tags: string[];
  stats: { views: number; reactions: number } | null;   // only once live
}

interface PlannerBackend {
  getScheduled(range: { from: string; to: string; modelVersionId?: number }): Promise<{
    posts: PlannerPost[];
    dailyLimit: number;
    minGapMinutes: number;
    truncated: boolean;
  }>;
  /** Everything the drawer shows; fetched on open so the list payload stays small. */
  getPostDetail(id: number): Promise<PlannerPostDetail>;
  /** `expectedScope` is what the UI showed; the server answers a conflict when its own computation
   *  differs, so a stale replica cannot turn a chip drop into a release move. */
  reschedule(req: { id: number; publishedAt: string; expectedScope: 'post' | 'version' | 'model' })
    : Promise<{ publishedAt: string; scope: 'post' | 'version' | 'model'; movedPostIds: number[] }>;
  publishNow(req: { id: number; expectedScope: 'post' | 'version' | 'model' })
    : Promise<{ publishedAt: string; scope: 'post' | 'version' | 'model'; movedPostIds: number[] }>;
  unschedule(ids: number[]): Promise<{ unscheduledIds: number[] }>;
  shift(req: { ids: number[]; deltaMinutes: number }): Promise<{ moved: { id: number; publishedAt: string }[] }>;
}

interface PlannerHost {
  backend: PlannerBackend;
  config: {
    imageLocation: string;        // Cloudflare Images base for covers
    browsingLevel: number;        // covers above it render blurred
    /** Initial state of the "Show mature" toggle; the element remembers the viewer's choice per device
     *  and fires `show-mature-change`. It never writes the account's browsing settings. */
    showMature?: boolean;
    composerAvailable: boolean;   // hides quick-add until the composer ships
  };
  hrefFor(loc: PlannerLocation): string;
  navigate(loc: PlannerLocation): Promise<void>;
  /** Relative = same-tab in-host navigation; absolute = new tab. */
  editPostUrl(id: number): string;
  viewPostUrl(id: number): string;
  modelPageUrl(req: { modelId: number; modelVersionId: number }): string;
  composerUrl?(req: { startAt?: string; modelVersionId?: number }): string;
}
```

`location` is a second host-controlled property: the element renders the view it names and emits
`navigate` (a `CustomEvent<PlannerLocation>`) for its own moves, which the host turns into URL state
and pushes back in. Both hosts keep `?view=&anchor=&mv=` as the source of truth.

Events the element fires (all `composed`, typed in the manifest): `navigate`, `rescheduled`,
`published`, `unscheduled`, `shifted`, `show-mature-change`, `error`. Hosts use them for analytics and cache invalidation;
the element already updates its own view optimistically and reverts on a rejected promise.

## 4. Hosts

### Creator Studio (`/calendar`)
- `+page.svelte` imports `@civitai/post-planner/define`, renders `<civitai-post-planner>` and binds
  `host` and `location` as properties (`bind:this` + assignment after mount; Svelte sets unknown
  attributes as properties when the element defines them). Flag-gated with
  `modFallbackFlagEnabled(POST_PLANNER_FLAG, user)`.
- `backend` is a small client object whose methods fetch this app's own `routes/api/planner/*`:
  `scheduled` (Kysely read, the first pass's query with the cover subqueries collapsed into one lateral
  join, `+1` overfetch for `truncated`, and `getPostScheduleScope` from `@civitai/shared`), `detail`
  (one post with its media, resources, tools, techniques and tags), and
  `reschedule` / `publish-now` / `unschedule` / `shift`, which forward the session cookie through
  `callMainApp` to the main app's REST twins and map a `409` to a conflict the UI words as "may have
  gone through; refreshed".
- `data-theme="dark"` is already the app's posture (`<html class="dark">` gains the attribute).

### Main app (`/user/schedule`)
- `src/pages/user/schedule.tsx` renders the React binding from `@civitai/post-planner/react` inside
  `next/dynamic(..., { ssr: false })`, under `Page(..., { features: f => f.postPlanner })`. `backend` is
  tRPC (`post.getScheduled`, `post.reschedule`, `post.publishNow`, `post.unschedule`,
  `post.shiftSchedule`); `hrefFor` is `/user/schedule?view=&anchor=`; `editPostUrl` is
  `/posts/{id}/edit?returnUrl=…`; `composerUrl` is `/posts/batch?startAt=…` once Phase 1 ships.
- `data-theme` follows Mantine's colour scheme: a one-line effect mirrors `useComputedColorScheme()`
  onto the element.
- Entry points: "Open planner" beside the posts tab's Scheduled filter; the composer's success screen;
  a Creator Studio dashboard tile pointing at its own `/calendar`.

### Main-app server (shared by both hosts)
- tRPC procedures above in `post.router.ts`, each `isFlagProtected('postPlanner')` and
  `TokenScope.MediaWrite`. `post.reschedule` carries the first pass's release logic
  (`publishModelHandler` / `publishModelVersionHandler` by scope, the sibling-scheduled-versions
  refusal, the post-write re-read) moved into a service function, plus the `expectedScope` check.
- REST twins for Creator Studio under `/api/v1/posts/{schedule,unschedule,shift}` built with
  `createCallerFactory(appRouter)` over an authenticated context, so the ban / onboarding / muted /
  email-verification guards are the procedures' own.
- Flag `postPlanner: { availability: ['mod'], fliptKey: 'post-planner' }`; Creator Studio reads the same
  Flipt key. Index `Post(userId, publishedAt)` as a hand-applied migration after checking `pg_indexes`.

## 5. Package layout and tooling

```
packages/civitai-post-planner/
  package.json         @civitai/post-planner; deps lit, @civitai/components, @civitai/shared;
                       exports ".", "./define", "./react"
  src/
    civitai-post-planner.ts        the element (CivitaiElement subclass)
    civitai-post-planner.define.ts defineElement('civitai-post-planner', …)
    host.ts                        PlannerHost / PlannerBackend / PlannerLocation
    react.ts                       @lit/react createComponent binding
    views/{month,week,day,agenda}.ts   Lit templates + styles per view
    parts/{chip,drawer,bulk-bar,shift-dialog,drag}.ts
    model/{buckets,ranges,density}.ts  pure helpers (local-day bucketing, visible range per view,
                                       density default)
  src/__tests__/                   vitest: pure helpers in node; element behaviour in browser mode
  vitest.config.ts                 picked up by the root config's packages/*/vitest.config.ts glob
```

- Raw TypeScript like every other `@civitai/*` package: Next's `transpilePackages` and Creator Studio's
  `ssr.noExternal` both gain the entry; `docs/packages/new-app-integration.md` §3 is the checklist.
- `lit` and `@lit/react` become root dependencies (first use in the repo); `@civitai/components` and
  `@civitai/theme` come with them. Lock the components version; the elements manifest changing is a
  visible diff in the lockfile, not a CDN surprise.
- Browser-mode tests reuse the main app's `test:component` project pattern for the element's
  interactions (drag, keyboard nudge, select mode); pure view helpers run under `test:packages:run`.

## 6. What carries over from the first pass

| First pass (Svelte, Creator Studio) | Becomes |
|------------------------------------|---------|
| `routes/(app)/calendar/+page.svelte` (478 lines) | Lit views and parts in the package; the route is a thin host |
| `lib/server/post-calendar.ts` Kysely read | `routes/api/planner/scheduled/+server.ts` |
| `lib/post-calendar.ts` grid/month helpers (+ test) | `src/model/{buckets,ranges}.ts`, same logic, same tests ported |
| `src/pages/api/v1/posts/schedule.ts` | service function behind `post.reschedule` / `post.publishNow`; REST twin via `createCallerFactory` |
| `src/server/utils/post-reschedule.ts` (+ test) | already in `@civitai/shared/post-scheduling` (PR A) |
| The 10 must-fix findings in the master plan §2 | fixed during the port; the client-side ones land once, in the element |

## 7. Sequencing

Phase 1 (composer) is unchanged. Phase 2, four PRs on `main`, each flag-dark:

- **PR E — main-app server** (~500 LOC). Procedures, release-move service function, REST twins,
  `postPlanner` flag, index SQL. Carries the first pass's endpoint tests, re-pointed.
- **PR F — the element package, month view, and the Creator Studio host** (~1,000 LOC). Package
  scaffold on `@civitai/components`, host seam, month grid with the capped cells and badges, chip,
  the full-detail drawer (media strip, description, resources, tools, techniques, tags, reschedule /
  publish now / unschedule), the Show-mature toggle with per-thumbnail unblur, drag across days with
  undo, Creator Studio route and `routes/api/planner/*`. Replaces the first pass's page.
- **PR G — day, week, agenda, select mode** (~1,000 LOC). The switcher with the density default, hour
  rows and drag-to-time, agenda for phones, bulk bar (shift ±, move to day, unschedule), model filter,
  quick-add, legend, `truncated` notice.
- **PR H — main-app host** (~250 LOC). `/user/schedule` with the React binding, `data-theme` sync, the
  posts-tab "Open planner" entry, the composer success CTA, the Creator Studio dashboard tile. Measure
  the bundle on this route before widening the flag.

Estimate: 2.5–3 weeks for one engineer. Compared with the Svelte element plan this trades the
scoping plugin, the cross-origin loader and a second host-side stylesheet for learning Lit and the
elements' `data`-property conventions; the net is simpler.

## 8. The composer stays Mantine in Phase 1

The composer lives in the main app and is built with Mantine, which `@civitai/theme` is generated
from, so it already looks like the elements. Its upload, metadata parsing and picker machinery are
main-app React; wrapping them for a second host is the ~1.5-week cost the master plan defers. If a
both-host composer is wanted later, `@civitai/components-react` lets its pure parts (schedule builder,
preview, review table) be written once as elements in the same package and rendered inside the React
page, so nothing in Phase 1 blocks that.

## 9. Risks

- **First Lit element in the repo.** Small learning cost; the design-system elements are the worked
  examples (`civitai-media-card.ts`, `civitai-badge.ts`), and `CivitaiElement` handles token injection
  and `change` retargeting.
- **Property-vs-attribute footguns.** `data`, `host`, `location` are properties; React 18 sets unknown
  props as attributes, which is exactly why the `@lit/react` binding exists. Never render the bare tag
  with those props from React.
- **SSR.** The element renders client-only in Next (`ssr: false`); the page's heading and entry copy
  stay in ordinary markup for SEO, as the components-react README advises.
- **Kit gaps.** Drawer, date/time input and the calendar grid are hand-drawn with tokens until they are
  upstreamed; they must be kept to the token set so a theme change reaches them.
- **Element version drift.** `@civitai/components` is pre-1.0; pin it and bump deliberately. The
  manifest-driven React binding is regenerated on each bump.
- **Two cap counters** and **UTC-day labelling** are inherited Phase 1 risks (tech plan R3, R5).
