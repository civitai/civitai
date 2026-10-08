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
  description: string | null;     // plain text; the server strips the stored rich-text markup
  media: { id: number; url: string; type: 'image' | 'video' | 'audio'; nsfwLevel: number; width: number; height: number }[];
  model: { id: number; name: string; versionName: string } | null;
  resources: { id: number; name: string; type: string; modelId: number; versionId: number }[];
  tools: string[];
  techniques: string[];
  tags: string[];
  stats: { reactions: number; comments: number } | null; // only once live; posts store no view count
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
  /** Release posts are never unscheduled or shifted here; they come back in `skippedReleaseIds`. */
  unschedule(ids: number[]): Promise<{ unscheduledIds: number[]; skippedReleaseIds: number[] }>;
  shift(req: { ids: number[]; deltaMinutes: number })
    : Promise<{ moved: { id: number; publishedAt: string }[]; skippedReleaseIds: number[] }>;
}

interface PlannerHost {
  backend: PlannerBackend;
  config: {
    userId?: number;              // scopes the remembered Show-mature choice on a shared device
    imageLocation: string;        // Cloudflare Images base for covers
    browsingLevel: number;        // covers above it render blurred
    /** Initial state of the "Show mature" toggle; the element remembers the viewer's choice per device
     *  and fires `show-mature-change`. It never writes the account's browsing settings. */
    showMature?: boolean;
    composerAvailable: boolean;   // hides quick-add until the composer ships
  };
  hrefFor(loc: PlannerLocation): string;
  navigate(loc: PlannerLocation): Promise<void>;
  /** Relative = same-tab in-host navigation; http(s) = new tab; any other scheme is dropped.
   *  `nsfwLevel` lets a host that splits domains by maturity (civitai.com / civitai.red) pick the right one. */
  editPostUrl(post: { id: number; nsfwLevel: number }): string;
  viewPostUrl(post: { id: number; nsfwLevel: number }): string;
  modelPageUrl(req: { modelId: number; modelVersionId: number; nsfwLevel: number }): string;
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
- `backend` is a small client object whose methods fetch this app's own
  `routes/api/planner/[action]`, a proxy over the main app's REST twins (below): the main app owns the
  read query as well as the writes, so Creator Studio carries no Kysely read of its own. The proxy
  forwards only the hub's session cookies, whitelists the read parameters, and takes writes only as
  same-origin `application/json`. A `409` reaches the element as the server's message; the element
  toasts it and reloads the range.
- `<html data-theme="dark" class="dark">` in `app.html` is the app's posture for every element.

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
- tRPC procedures above in `post.router.ts`, each `isFlagProtected('postPlanner')`, reads on
  `TokenScope.MediaRead` and writes on `TokenScope.MediaWrite` with a shared rate limit.
  `post.reschedule` keeps the first pass's release logic (the sibling-scheduled-versions refusal, the
  post-write re-read) in a service function plus the `expectedScope` check; the release move itself
  runs the real `model.publish` / `modelVersion.publish` procedures through scoped callers, so their
  muted, email-verification, token-scope and ownership guards stay theirs.
- REST twins for Creator Studio under `/api/v1/posts/planner/{scheduled,detail,schedule,unschedule,shift}`
  built with `createCallerFactory(appRouter)` over an authenticated context, so the ban / onboarding /
  muted / email-verification guards are the procedures' own. Cookie-authenticated POSTs must be
  `application/json`.
- Flag `postPlanner: { availability: ['mod'], fliptKey: 'post-planner' }`; Creator Studio reads the same
  Flipt key. No index work: production already carries two `Post(userId, publishedAt)` covering
  indexes and the list query uses one of them.

## 5. Package layout and tooling

```
packages/civitai-post-planner/
  package.json         @civitai/post-planner; deps lit, @civitai/components, @civitai/shared;
                       exports ".", "./define", "./react"
  src/
    civitai-post-planner.ts        the element (CivitaiElement subclass); one file until PR G splits
                                   it into views/ and parts/
    define.ts                      defineElement('civitai-post-planner', …)
    host.ts                        PlannerHost / PlannerBackend / PlannerLocation, hostLink
    react.ts                       @lit/react createComponent binding
    styles.ts                      the element's stylesheet on @civitai/theme tokens
    parts/media.ts                 blur rule, thumbnails, icons
    model/calendar.ts (+ test)     pure helpers: local-day bucketing, visible range per view,
                                   density default, snapping
  vitest.config.ts                 picked up by the root config's packages/*/vitest.config.ts glob
```

- Raw TypeScript like every other `@civitai/*` package: Next's `transpilePackages` and Creator Studio's
  `ssr.noExternal` both gain the entry; `docs/packages/new-app-integration.md` §3 is the checklist.
- `lit` and `@lit/react` become root dependencies (first use in the repo); `@civitai/components` and
  `@civitai/theme` come with them. Lock the components version; the elements manifest changing is a
  visible diff in the lockfile, not a CDN surprise.
- Pure helpers run under `test:packages:run`. Browser-mode tests for the element's interactions
  (drag, keyboard nudge, select mode, lightbox, undo, the narrow-screen list) reuse the main app's
  `test:component` project pattern and land with PR G; until then those paths are checked by hand.

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
- **PR F — the element package and the Creator Studio host** (~2,000 LOC as built). Package scaffold
  on `@civitai/components`, host seam, the view switcher with the density default (Agenda on phones),
  month grid with capped cells and badges, Week / Day / Agenda as grouped-by-day lists, chip, the
  full-detail drawer (media strip with a lightbox, description, resources, tools, techniques, tags,
  engagement, reschedule / publish now / unschedule), the Show-mature toggle with per-thumbnail
  unblur, drag across days with undo, `Shift+arrow` keyboard nudge announced via `aria-live`, select
  mode with the bulk bar (±1 day, +1 week, unschedule), model and status filters, quick-add, the
  loading state and the `truncated` notice, Creator Studio route and `routes/api/planner/*`. Replaces
  the first pass's page.
- **PR G — hour grids and polish** (~800 LOC). Week and Day as hour grids with drag-to-time, the
  `Shift ±` dialog and `Move to day…`, a compact phone toolbar, the file split into views/ and parts/,
  browser-mode tests for the interactions.
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
