# Report queue pages — the pattern

How to build a report queue that is not a table: a queue down the left, the reported item across the
rest. `/reports/user` and `/reports/model` are built this way; the remaining types under
`/reports/[slug]` use the shared table (`ReportsTable.svelte`) until each moves over on purpose, when
someone has looked at how it is worked.

Built 2026-10-15. Claims, skip and escalation, which replace Processing, are planned on top of this in
[`report-queue-claims-plan.md`](report-queue-claims-plan.md) and are not part of it yet.

## The shape

| | |
|---|---|
| **Route** | `routes/reports/<type>/+layout.server.ts` + `+layout.svelte` hold the queue. `+page.server.ts` + `+page.svelte` at the bare path, and `[id]/+page.*` (plus an optional `[[tab=…]]` where the item has tabs), hold the open item. A static `reports/<type>` route wins over `reports/[slug]`, so the slug stops reaching the table page as soon as the folder exists. |
| **Layout load** | The queue's rows, the status counts, the permissions, `fullBleed: true`. Nothing about the open item. |
| **Page load** | Only the open item: its own data and **all its open reports**. The bare path opens the queue's first item by reading `parent()`, and renders it there rather than redirecting (a redirect runs the queue twice on every filter change). |
| **Actions** | One object, exported by **both** pages, the bare one and `[id]`, since the open item's forms post to whichever URL is showing. |
| **URL** | Path: which item, which tab. Query string: what the moderator changed from the defaults — the queue's filters and page, and the item's own filters (the Images tab's, say). Defaults are **not** written in (`canonicalize: false`). `?report=<id>` opens one report with every filter off. |

Reference implementation: [`routes/reports/user/`](../../apps/moderator/src/routes/reports/user/) (an
item with tabs and its own heavy loads) and [`routes/reports/model/`](../../apps/moderator/src/routes/reports/model/)
(an item whose preview comes from `/api/*`).

## 🔴 The layout must not rerun when the open item changes

That is the reason the queue is a layout. SvelteKit reruns a load whose tracked URL reads changed, and
tracks `url.searchParams.get` / `getAll` / `has` **per key**. Anything that iterates the query string
(`parseQuery`, `searchParams.keys()`, `url.search`) or reads `url.pathname` / `params` counts as reading
all of it, and the queue — 50 rows, status counts, a user or model hydration — reruns on every click,
with nothing looking broken except the speed.

So the layout reads the URL **only** through `loadReportQueue`, and an item page's own params through
`parseQueryKeys` (`$lib/server/query.ts`), which reads its schema's keys and nothing else. Each route
has a test that hands the layout a proxied `URL` which throws on any other read — copy it
(`__tests__/user-queue.test.ts`, `__tests__/model-queue.test.ts`).

Writes still reload everything (`FormState({ reload: true })` → `invalidateAll`), which is what you
want: a ruling changes the queue.

## The pieces

**Server** (`$lib/server/`)

- `loadReportQueue(type, url, { statusCounts, canonicalize, dates, limit })` — the one reader of a
  queue's URL, for these layouts and the tables. Filter parsing is `parseReportQueueFilters`.
- `loadItemReports(type, entityId)` — the open item's own open, human-filed reports, through
  `getReports({ entityId })`. Not the queue page's rows: a second report on the same item can sit a
  page away, and was left unruled when the page only listed what was in view.
- `reportStatusActions({ rulingsOnly })` (`report-queue-actions.ts`) — `setStatus` and `saveNotes`.
  `rulingsOnly` refuses Pending and Processing on the server, not just in the buttons.

**Client** (`$lib/components/report-queue/`, plus `$lib/report-queue.ts`)

| | |
|---|---|
| `ReportQueueShell` | The page: the queue section and the detail section, sized against the viewport. The layout renders it with `detail={children}`. |
| `ReportQueueColumn` | Title, `ReportFilters` (or the note for a `?report=` view), the striped listbox, Prev/Next. The page supplies each row's content as a `row` snippet, and `isOpen` / `onOpen`. Every filter or page change goes to the bare path, so the new view opens on its own first item. |
| `ReportDetailColumns` | The open item's two scrolling columns: `evidence` (optional) and `actions`. Both are `relative` — see below. |
| `ReportList` | The item's reports, one compact row each, one row open at a time; nothing is truncated. A ruling opens the next open report. Each report keeps its own ruling, since reports about one item can need different answers. `details` adds to the open row (the model queue's internal notes). |
| `ReportStatusButtons` | A report's ruling, Actioned/Unactioned by default (`REPORT_RULINGS`). Pass `statuses` to offer more. |
| `reportsForItem` | The item's open reports plus any of its reports the queue is showing, so a resolved report reached by a link can still be ruled on. |
| `hasOpenReport`, `nextItemId` | Once the open item has nothing left to rule, open whichever item now sits where it sat in the queue. Read the index at submit; after the write the queue has reloaded. |

The row's look, the item's header and its evidence are the type's own. Everything above them is shared;
a second copy of any of it is how the two pages drifted before this existed.

## Rules the pieces encode

- **The open item is read through `page.data` in the layout** (the layout's own `data` is only its
  load's). Highlight every queue row about the open item.
- **Rulings are Actioned and Unactioned.** Pending and Processing are filtered on, not set — the user
  queue refuses them server-side. The model queue still sets all four until the Processing question in
  the claims plan is answered.
- **Every form owns its result** (`FormState`), never the page's `form` prop: the item's forms live in
  a page under a layout, and a page-level result has to be routed back to the right form. Clear the
  item's form state when the item changes — a `{#key}` on the item does it for components under it.
- **A scrolling column is `relative`.** A scroll box that is not positioned does not contain its
  absolutely positioned descendants (a form control's hidden input, a badge), so they are laid out
  against the page and the page scrolls into empty space below the fold. `ReportQueueColumn` and
  `ReportDetailColumns` already do this; a scroll box you add yourself needs it too.
- **Opening an item keeps the queue page and the filters**; it drops `?report=` and the item's own
  pagers (`clearPaging`).

## Adding a type

1. Create `routes/reports/<type>/`. The layout load is `loadReportQueue(ReportEntity.X, url, {
   statusCounts: true, canonicalize: false })` plus whatever the rows need hydrated.
2. A shared `<type>/item.server.ts` (or `account.server.ts`) loads the open item, `loadItemReports`
   included. The bare page calls it for `parent()`'s first item; `[id]` validates the id (404 when it is
   not one) and calls it.
3. The actions object, exported from both pages.
4. `+layout.svelte`: `ReportQueueShell` around the type's queue component (`ReportQueueColumn` with its
   `row` snippet).
5. The item view: header, then `ReportDetailColumns` with the evidence and a `ReportList` above the
   type's own actions.
6. Copy the layout-tracking test. Remove the type's branch from `routes/reports/[slug]`.
7. Before calling it done, compile every changed `.svelte` file as the dev server does — `preprocess`
   with `vitePreprocess()`, `compile` for `server` and `client`, `node --check` the output.
   `svelte-check` validates the TypeScript, not the JavaScript Svelte emits. An optional arrow-function parameter
   (`(x?: T) => …`) compiled to `(x?) => …` and took both user report pages down with a 500 that
   typecheck and the tests passed over.
