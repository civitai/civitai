# Report queue pages — the pattern

How to build a report queue that is not a table: a queue down the left, the reported item across the
rest. `/reports/user`, `/reports/model` and `/reports/post` are built this way, each its own route.
Articles, chats, collections, bounties and bounty entries share ONE route,
`/reports/[queue=entityQueue]` — the same layout, with the evidence column picked per type (below).
`/reports/image` is the exception on purpose: an image report is judged by looking at the image, so it
is the image queues' card grid (`$lib/components/image-queue/`), one card per report; the remaining
types under `/reports/[slug]` use the shared table (`ReportsTable.svelte`) until each moves over on
purpose, when someone has looked at how it is worked.

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

## The shared route, for types without a page of their own

Most report types are judged from one view of the thing — no tabs, no heavy loads — so they do not
each need a route. [`routes/reports/[queue=entityQueue]/`](../../apps/moderator/src/routes/reports/[queue=entityQueue]/)
is one queue route for all of them, picked by the `entityQueue` param matcher, which outranks the plain
`[slug]` table route beside it. What differs per type is two server reads and one component:

| | |
|---|---|
| **Which types** | `ENTITY_QUEUE_TYPES` (`$lib/entity-report-queues.ts`). The matcher, the queue's title and noun, and the item URL all come from it. |
| **Queue rows** | `queueSubjects(type, rows)` (`$lib/server/entity-queue-load.ts`): one `QueueSubject` per report — title, the account it is about, one note. One shape, so the queue column is one component. |
| **The open item** | `loadEntityItem(type, id, locals, url)`: `{ id, type, reports, evidence }`, `evidence` discriminated on `kind`, with `ownerId` — the account a strike or notification goes to (a chat's is worked out on the page, below). `url` only through `parseQueryKeys`, for the item's own `imgPage`. |
| **Evidence** | One preview component per kind (`ArticlePreview`, `ChatPreview`, `CollectionPreview`, `BountyPreview`), chosen in `EntityView.svelte`. Images go through `ImageEvidence`, the account through `OwnerActions` — both shared with the post queue. |
| **A type's own action** | In `actions.server.ts`, refusing on any other queue (`params.queue`) and gated on its own queue's path — the article queue's `unpublishArticle`, which any moderator may do, as on the site. It names a REPORT and reads the article from it (`getReportedEntityId`), as `moderateModel` does. |

The layout reads `params.queue`, which SvelteKit tracks per param and is the same for every item in the
queue; it must never read `params.id`. The route's test proxies `params` as well as the URL.

What each type shows, and why:

- **Article** — status, unpublish reason, rating; the body as TEXT (author-written HTML is never
  rendered in a moderator's session), with the article's own images in place and the cover first —
  an editor media tag naming anything else is not loaded; the cover and body images as a grid. Unpublish as a violation, with the
  site's reasons (`$lib/article-unpublish-reasons.ts`, held to the main app by its parity test).
  Republishing stays on Unpublished Articles, as the model queue leaves republishing to the model page.
- **Chat** — a chat report names a conversation, not a person. The subject is the other member of a
  two-person chat a reporter is in (`chatSubject`, `chatReportSubject`'s rule), over every report the
  page lists — resolved ones a filter or `?report=` shows included — and every co-reporter folded into
  them (`alsoReportedBy`). A group chat, a chat both members reported, or no reporter in the chat names
  nobody, and the page says which. A chat nobody reported shows nothing: its id is in the path.
  🔴 The transcript is private messages: it is shown only to a moderator with Chat Audit
  (`/retool/chat-audit`), and everyone else sees who is in the chat and which grant they are missing.
- **Collection** — what it holds and who can see it; its images as the grid; posts, models and
  articles listed and linked.
- **Bounty / bounty entry** — the bounty's terms, pool and reference images; an entry's submitted
  images with the bounty it was entered into, since most entry reports are claims about the bounty's
  rules.

Adding a type here: add it to `ENTITY_QUEUE_TYPES` and `ENTITY_QUEUE_LABELS`, its `case` to
`subjectsByEntity` and to `itemEvidence` (both `never`-checked, so the build fails until you do), then
a preview component, its branch in `EntityView` and its header there. Its `/reports/<slug>` URL stays
the same.

What these types gave up by leaving the table, as images did: setting Pending or Processing (the queue
rules Actioned/Unactioned only). Internal notes came with them — every layout queue has them (below).

## 🔴 The layout must not rerun when the open item changes

That is the reason the queue is a layout. SvelteKit reruns a load whose tracked URL reads changed, and
tracks `url.searchParams.get` / `getAll` / `has` **per key**. Anything that iterates the query string
(`parseQuery`, `searchParams.keys()`, `url.search`) or reads `url.pathname`, or any `params` key that
changes with the item (`params.id`), counts as reading all of it, and the queue — 50 rows, status counts, a user or model hydration — reruns on every click,
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
- `reportModerationActions(pagePath)` (`report-actions.ts`) — the user, post and shared queues' writes:
  `actionReport`, `saveNotes`, the image actions, `strike`, `notify`, each gated on `pagePath`. Every
  queue that renders `ReportList` must export a `saveNotes` from one of the two.

**Client** (`$lib/components/report-queue/`, plus `$lib/report-queue.ts`)

| | |
|---|---|
| `ReportQueueShell` | The page: the `title` in a `TriagePageHeader`, then a fixed-width queue flush against the detail, sized against the viewport. The layout renders it with `detail={children}`, and its load returns `fullBleed` and `headerInline`. |
| `ReportQueueColumn` | `ReportFilters` (or the note for a `?report=` view), the listbox with the open row marked as a `TriageRow` is, and a footer with the range and Prev/Next. The page supplies each row's content as a `row` snippet, and `isOpen` / `onOpen`. Every filter or page change goes to the bare path, so the new view opens on its own first item. |
| `ReportDetailColumns` | The open item: `evidence` (optional) in the middle under the item's `header`, and `actions` in a right sidebar that runs the pane's full height, with an optional `footer` pinned under it. Both columns scroll on their own (see "A scrolling column is `relative`"). The Model Flags tabs use it too, through `ModelFlagDetailFrame`, with `ModelPreview` (`$lib/components/`) as the evidence and a compact decision bar as the footer. |
| `ReportList` | The item's reports, one compact row each, one row open at a time; nothing is truncated. A ruling opens the next open report. Each report keeps its own ruling, since reports about one item can need different answers. `details` adds to the open row (the model queue's merge-permission check). The open row ends with the report's internal notes (`ReportNotes`), editable by whoever can rule and posting to the queue's `?/saveNotes`. |
| `ReportStatusButtons` | A report's ruling, Actioned/Unactioned by default (`REPORT_RULINGS`). Pass `statuses` to offer more. |
| `reportsForItem` | The item's open reports plus any of its reports the queue is showing, so a resolved report reached by a link can still be ruled on. |
| `itemHref`, `QUEUE_NAV` | An item's URL with the queue's filters carried and `?report=` and the item's pagers dropped, and the `goto` options every queue moves with. Every "open this item" goes through them. |
| `advanceAfterRuling` | Once the open item has nothing left to rule, open whichever item now sits where it sat in the queue (`hasOpenReport`, `nextItemId`). `capture()` at submit — after the write the queue has reloaded — and `advance()` on success. |
| `ReportRowMeta` | A queue row's second line: status, reason, who filed it and how many more, then the type's own note as `children`. |
| `reportActionGrants`, `ReadOnlyNotice` | What the viewer may do to the content (`image.moderate`) and the owner (`user.strike`), read once per view from `data.grants`; and the line naming each missing grant and where it is given. Ruling and notes need only the queue's own path. |
| `ImageEvidence`, `OwnerActions` | An item's images (grid, selection, remove/restore/flag, optional numbered `paging`) and the strike/notify panel. Both hold their own state: render them under `{#key}` on the item. With `paging`, the selection spans pages (`keepOffScreen`) and blocked ids accumulate across every page shown. |

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
4. `+layout.svelte`: `ReportQueueShell` with the queue's `title`, around the type's queue component
   (`ReportQueueColumn` with its `row` snippet). The layout load returns `fullBleed` and `headerInline`.
5. The item view: `ReportDetailColumns` with the header, the evidence, and a `ReportList` above the
   type's own actions in the sidebar.
6. Copy the layout-tracking test. Remove the type's branch from `routes/reports/[slug]`.
7. Before calling it done, compile every changed `.svelte` file as the dev server does — `preprocess`
   with `vitePreprocess()`, `compile` for `server` and `client`, `node --check` the output.
   `svelte-check` validates the TypeScript, not the JavaScript Svelte emits. An optional arrow-function parameter
   (`(x?: T) => …`) compiled to `(x?) => …` and took both user report pages down with a 500 that
   typecheck and the tests passed over.

A type that needs no route of its own goes on the shared route instead — see above.
