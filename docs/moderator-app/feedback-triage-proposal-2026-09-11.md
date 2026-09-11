# Feedback triage — a read surface for the `Feedback` table

**Scoping proposal, 2026-09-11. Nothing here is built.** The one executable artefact that ships with
this document is the migration at
[`packages/civitai-db-schema/prisma/migrations/20260911120000_feedback_triage/migration.sql`](../../packages/civitai-db-schema/prisma/migrations/20260911120000_feedback_triage/migration.sql),
which is additive, idempotent and — like every migration in this repo — applied **by hand**.

The problem in one line: **the onsite feedback prompt has been writing to a table nothing reads.**

---

## 1. What exists today

### The producer

| Piece | File | What it does |
| --- | --- | --- |
| Mount | [`src/pages/apps/index.tsx`](../../src/pages/apps/index.tsx):93 | The **only** live mount of `FeedbackPrompt` in the repo — `area="apps-marketplace"` |
| Component | [`src/components/Feedback/FeedbackPrompt.tsx`](../../src/components/Feedback/FeedbackPrompt.tsx) | Signed-in only, dismissed per-tab via `sessionStorage`, rendered only when `trpc.feedback.getArea` says the area is on |
| Context builder | [`src/components/Apps/appsStoreFeedbackContext.ts`](../../src/components/Apps/appsStoreFeedbackContext.ts) | Emits `path` + `filters{kind, category, sort, query}` |
| Attachments | same component, `:265-301` | Up to `FEEDBACK_IMAGE_MAX_COUNT` (3) images, plus one opt-in `html2canvas-pro` viewport screenshot; both upload to Cloudflare **at Send time** and land in `context` as ids |
| API | [`src/server/routers/feedback.router.ts`](../../src/server/routers/feedback.router.ts) | Exactly two procedures: `getArea` (query) and `create` (mutation, `rateLimit({ limit: 5, period: 3600 })`) |
| Schema | [`src/server/schema/feedback.schema.ts`](../../src/server/schema/feedback.schema.ts) | `createFeedbackSchema` = `{ area, message (1..2000), context? }` |
| Service | [`src/server/services/feedback.service.ts`](../../src/server/services/feedback.service.ts):56 | `dbWrite.feedback.create(...)` — the only database call the feature makes, in either direction |
| Areas | [`src/shared/constants/feedback.constants.ts`](../../src/shared/constants/feedback.constants.ts):11 | `FEEDBACK_AREAS = ['bitdex-image-feed', 'apps-marketplace']` |
| Flag | Flipt `feedback-area-<slug>` | `feedback-area-apps-marketplace` rolls out to `early-adopters OR testers`; every moderator is in `testers` |
| Table | [`20260813180000_feedback/migration.sql`](../../packages/civitai-db-schema/prisma/migrations/20260813180000_feedback/migration.sql) | `id, area, userId, message, context jsonb, status, createdAt` + a `Feedback_status_check` CHECK and two indexes |

Only `area` and `message` are sent at the top level. **Everything else — `path`, `filters`, `images`,
`screenshotId`, `sessionId` — is inside `context`**, merged in `handleSubmit`; `sessionId` comes from
Faro at submit time and is *not* produced by the context builder.

### The motivating problem

Measured against `cnpg-cluster-nvme0-5`, db `civitai`, 2026-09-11:

| area | rows | window | status |
| --- | --- | --- | --- |
| `apps-marketplace` | 3 | 2026-08-20 → 2026-09-02 | all `new` |
| `bitdex-image-feed` | 23 | producer decommissioned | all `new` |
| **total** | **26** | | **26 of 26 `new`** |

That is not a backlog, it is an **absence of a reader**. A case-sensitive sweep for `"Feedback"` across
`src/`, `apps/` and `packages/` returns the migration DDL and nothing else; the only non-test database
access anywhere is the single `create` above. There is no tRPC query, no moderator page, no notifier and
no cluster-side consumer. Three of the four statuses the CHECK constraint permits — `reviewed`,
`actioned`, `dismissed` — are **unreachable by any code path that exists**.

The three `apps-marketplace` rows carry `path` and `filters` only: no images, no screenshots.

### What is already in our favour

`Feedback` is already in the generated Kysely types —
[`packages/civitai-db-schema/src/kysely/types.ts`](../../packages/civitai-db-schema/src/kysely/types.ts):2322
for the row type, `:4460` for its entry in the `DB` map. `apps/moderator`'s
[`db.ts`](../../apps/moderator/src/lib/server/db.ts) types `dbRead`/`dbWrite` against exactly that `DB`,
so the spoke can query this table fully typed with **zero introspection work**. `apps/moderator` has no
reference to feedback today — case-insensitive `feedback` across the whole app returns nothing.

---

## 2. Proposed surface

### Route

**`/feedback`** — one page, no `[slug]`.

The area is a **filter, not a queue of its own**.
[`url-filtering-pattern.md`](url-filtering-pattern.md) draws that line: *"reach for `Tabs` + a param when
the dimension is a view of one queue; reach for a route segment when it is a queue of its own."* There
are two areas, one of them dead, and the head-count of both together is 26. `/reports/[slug]` is a route
segment per entity because each is a real queue with its own sidebar count and its own moderator; this is
not that.

### `NAVIGATION` entry

In [`apps/moderator/src/lib/server/access.ts`](../../apps/moderator/src/lib/server/access.ts), declared
immediately after `{ path: '/comics-review', label: 'Comics Review' }`:

```ts
{ path: '/feedback', label: 'Feedback', countKey: 'feedbackNew' },
```

A leaf, so `navBand` puts it in band 2 and the sidebar renders it between **Comics Review** and **Abuse
Detection**. No `informational: true` — this *is* a queue somebody works through, so it belongs in the
dashboard's "needs attention" total, unlike the stuck-scan counts beside it.

**On the `countKey`.** The `Models` group carries the standing warning that
[`sidebar-counts.service.ts`](../../apps/moderator/src/lib/server/sidebar-counts.service.ts) is one
`Promise.all` every navigation in the app waits on, and that a ~10 s count has no business in it. This
one is the opposite case and the cost is worth stating rather than asserting:

- the query is `select count(*) from "Feedback" where "status" = 'new'`;
- the migration adds `Feedback_status_createdAt_idx` on `("status", "createdAt" DESC)`, which serves it
  as an index-only scan — the existing `Feedback_area_status_createdAt_idx` cannot, its leading column
  being `area`;
- the table holds **26 rows**, and the producer is rate-limited to 5 submissions per user per hour on
  one page behind a Flipt flag;
- the whole map is behind `createCache(... ttlSeconds: 60)`, so this runs at most once a minute per pod.

It does **not** need `bounded()`. That wrapper exists for aggregates with no index of their own
(`countStuckIngestion`, `countIngestionErrorImages`); wrapping a sub-millisecond index-only count in a
3-second race adds a timer and a nullable to buy nothing.

### List view

Default view: **`?status=new`**, all areas, `createdAt DESC`. Canonicalised into the URL on a bare
landing exactly as `/reports/[slug]` does, so the active default is explicit and shareable, and using the
same present-but-empty sentinel (`?status=` means *explicitly all*, an absent `status` means *the
default*) — the three-state model in [`url-filtering-pattern.md`](url-filtering-pattern.md) §"Multi-value
filter semantics".

| Column | Source | Notes |
| --- | --- | --- |
| Age | `createdAt` | Relative ("3w"), absolute in `title=` |
| Area | `area` | Badge. A retired area still renders its own slug |
| User | `userId` → `User.username` | Links to `/retool/user-lookup?q=<username>` |
| Message | `message` | First line, truncated; the full text is in the expanded view |
| 📎 | `context.images`, `context.screenshotId` | Count only — `3 📎`, or nothing |
| Status | `status` | Badge, colour-coded per the four CHECK values |
| Handled | `handledById` → username, `handledAt` | Empty for `new` |
| Bug | `bugId` | `#1234` linking to `/issues`, or `—` |

Filters, rendered with the existing `ListFilterBar` shape but URL-driven rather than client-side:

- **Area** — single select. 🔴 The option list must be `SELECT DISTINCT area FROM "Feedback"` **unioned
  with** `FEEDBACK_AREAS`, not `FEEDBACK_AREAS` alone. Decision 1 exists because the 23
  `bitdex-image-feed` rows must stay reachable, and an area retired from the TS constant would otherwise
  hide its own rows — the exact failure the decision was taken to prevent, re-introduced by reading the
  wrong list.
- **Status** — multi-select over the four CHECK values, defaulting to `['new']`.

Paging: keyset on `id`, `limit 50`, via the existing
[`CursorPager.svelte`](../../apps/moderator/src/lib/components/CursorPager.svelte) — the shape
`/audit/training-models` and `/users/newest` already use. At 26 rows it will never render.

No sort control. `createdAt DESC` is the only order the index serves and the only one a triage queue
wants; a sort dropdown here is a control nobody would touch.

### Detail view

**Expanded inline, keyed on `?open=<id>`**, not a second route. Same mechanism as `/reports/[slug]`'s
`?report=<id>`: the URL stays the source of truth, the operator keeps their place in the queue after a
form action reloads `load`, and the expanded state survives a link being shared.

```
┌─ Feedback ─────────────────────────────────────────────── 24 of 26 ──┐
│ Area [ apps-marketplace ▾ ]  Status [ new ×          ▾ ]   Clear     │
├──────────────────────────────────────────────────────────────────────┤
│ Age  Area              User        Message              📎 Status  … │
│ 3w   apps-marketplace  kaeru       the list is empty        new    ▸ │
│ 4w   bitdex-image-feed jth          feed loads twice     2  new    ▸ │
│ 5w   apps-marketplace  m_orr       sort doesn't stick       new    ▾ │
│ ┌──────────────────────────────────────────────────────────────────┐ │
│ │ “sort doesn't stick — I pick Newest and it goes back to Top       │ │
│ │  Rated when I come back from an app page”                         │ │
│ │                                                                   │ │
│ │ WHERE                                            2026-08-20 14:02 │ │
│ │  /apps?kind=onsite&sort=newest              ← reconstructed, ↗    │ │
│ │  path      /apps                                                  │ │
│ │  kind      onsite      category  (none)                           │ │
│ │  sort      newest      query     —                                │ │
│ │  session   v913JNcgDs ⧉                                           │ │
│ │            Faro data expired (72h Loki retention)                 │ │
│ │                                                                   │ │
│ │ ATTACHMENTS  (none)                                               │ │
│ │                                                                   │ │
│ │ OTHER CONTEXT                                                     │ │
│ │  { "pagesLoaded": 3 }                                             │ │
│ │                                                                   │ │
│ │ TRIAGE                                                            │ │
│ │  Status  ( new )( reviewed )( actioned )( dismissed )             │ │
│ │  Note   ┌─────────────────────────────────────────────┐           │ │
│ │         │ dupe of #1187, fixed in civitai#4702        │           │ │
│ │         └─────────────────────────────────────────────┘           │ │
│ │                                        [ Save ]  [ Promote to Bug ]│ │
│ └──────────────────────────────────────────────────────────────────┘ │
│ 4w   apps-marketplace  kaeru       cant find the free…      new    ▸ │
└──────────────────────────────────────────────────────────────────────┘
```

---

## 3. Rendering the context payload

`context` is a JSONB column whose contents are **a claim, not evidence** — the schema says so in as many
words at [`feedback.schema.ts`](../../src/server/schema/feedback.schema.ts):13-24. The panel must read
that way too: the heading is WHERE **the reporter said they were**, not where they were.

### The reconstructed URL is the point

🔴 **`context.path` is `window.location.pathname` — it carries no query string.** On `/apps` the entire
view is determined by the query string, so `path` alone links to a *different page* than the one the
report is about. The detail view must rebuild the URL from `path` + `filters`, using the param names
`useAppsStoreQueryParams` owns (`kind`, `category`, `sort`, `query`) and omitting anything equal to
`APPS_STORE_DEFAULTS` (`kind=all`, `sort=top-rated`, empty `query`), which is what the store's own
`urlWith` does.

`category: 'none'` is a **sentinel meaning "no category selected"**, written deliberately because an
explicit `undefined` is a record value that fails the schema union. Render it as `(none)` and omit it
from the reconstructed URL. Do not render it as a category called "none".

Link target: `civitaiLinkUrl()` (`.red`), matching every other content link this app builds. Note the
tension honestly — the reporter was on `.com`, and `.red` renders browsing levels `.com` will not — but
one base per app beats a second decision per page.

### The fields

| Key | Rendering |
| --- | --- |
| `path` | Monospace, plus the reconstructed link above it |
| `filters.*` | A four-cell grid: kind / category / sort / query. `query` empty → `—` |
| `sessionId` | Monospace, with a copy control, **plus an age-aware Grafana Explore link** — its own subsection below. **Absence is ordinary**, not an error: Faro does not run in dev, test, preview, or an ad-blocked session |
| `images` | Inline thumbnails — see below |
| `screenshotId` | Inline thumbnail, labelled as the reporter's viewport capture |
| anything else | 🔴 **Dumped verbatim as pretty-printed JSON under "Other context".** `feedbackContextSchema` already accepts `reportedSource`, `reportedPageSources` and `pagesLoaded`, which the `/apps` builder does not emit and a future area will. A panel that renders only the five keys it knows about silently discards the payload of every area added after it |

### The Faro session deep link — built, and deliberately age-aware

**Decision: build it.** The `sessionId` becomes a link into Grafana Explore against Loki, so a moderator
goes from a one-line complaint to the reporter's actual browser telemetry in one click.

**Datasource — confirmed, not assumed.** Loki is provisioned with a **pinned** `uid: loki` (name `Loki`,
`orgId: 1`), read out of `/etc/grafana/provisioning/datasources/datasources.yaml` in the running Grafana
pod rather than from a manifest, so this is what Grafana actually loaded. It is not a generated hash and
will not change under a redeploy — it is declared in the GitOps values. Grafana is **13.1.1**, so the
`panes` Explore state is the current form and the legacy `?left=` parameter is not something to build on.

**Base URL: `https://grafana-new.civitai.com`.** New config for this app — it carries no Grafana variable
today. A public var (`PUBLIC_GRAFANA_URL`), because the link is built for the browser; **the link must
not render at all when it is unset**, rather than pointing at `undefined/explore`.

```
https://grafana-new.civitai.com/explore
  ?schemaVersion=1
  &orgId=1
  &panes=<encodeURIComponent(JSON.stringify(pane))>
```

```jsonc
{
  "faro": {                                   // pane key: any short string
    "datasource": "loki",
    "queries": [{
      "refId": "A",
      "datasource": { "type": "loki", "uid": "loki" },
      "editorMode": "code",
      "queryType": "range",
      "expr": "{source=\"faro-rum\"} |= \"v913JNcgDs\""
    }],
    "range": { "from": "1755691320000", "to": "1755698520000" }  // epoch-ms strings
  }
}
```

`range` is derived from `Feedback.createdAt` — **±1 h around the report**, not `now-72h`. The moderator
wants the session that produced the complaint, and a window centred on it is the only thing that
survives being clicked two days later.

🔴 **Use the raw substring filter `|= "<id>"`, NOT `| logfmt | session_id="<id>"`.** The id appears under
**two different keys** in the same stream: `kind=event event_name=session_start` lines spell it
`session_id=<id>`, while `faro.tracing.fetch` lines spell it `event_data_session.id=<id>`. A `logfmt`
filter on `session_id` matches the first and silently drops the second — which are exactly the rows
carrying `traceID`/`spanID`, i.e. the most useful ones. A filter that returns *some* rows is the worst
possible failure here, because it looks like it worked.

The honest caveat: session ids are short opaque strings (~10 chars, e.g. `v913JNcgDs`), so a substring
match over the stream is **not provably collision-free**. At this volume a collision is unlikely and a
stray extra line is visible to the reader; a dropped tracing event is not. That is the trade, stated
rather than hidden.

🔴 **The link expires after 72 hours, and the UI must say so instead of showing an empty Explore.**
Loki's global `retention_period` is **72h**, and `{source="faro-rum"}` has no `retention_stream` override,
so it sits on that global. (The separate `{signal="resource_timing"}` sub-stream is cut to 24h; that is a
different stream and only matters to a query that names it.)

Past 72 h the Explore view returns **no rows** — and "no logs found" is indistinguishable from *"this
session produced no telemetry"* and from *"the link is broken"*. Three different facts, one observable.
So:

| `now - createdAt` | Rendering |
| --- | --- |
| **< 72 h** | A live Explore link |
| **≥ 72 h** | **Not a link.** The copyable id, plus: *"Faro session data for this report expired (72 h Loki retention)."* |

Derive the cutoff from `createdAt`, and put the figure in **one named constant** —
`FARO_LOKI_RETENTION_HOURS = 72` in `$lib/feedback.ts`, with a comment naming Loki's `limits_config`
as its source — so it cannot drift away from the cluster silently.

**What this bounds.** The link's value is a function of **triage latency**: it pays off only if the queue
is read within three days of a report landing. This queue has gone unread for a **month**, and all three
live `apps-marketplace` rows (2026-08-20 → 2026-09-02) are already far past the window — every one of
them renders as expired on day one. That is not an argument against the link. It is the argument **for**
the sidebar count and for reading the queue at all: the telemetry is there for three days and then it is
not, and nothing today tells anyone to look.

### Inline thumbnails — decided, with the risk recorded

**Decision (operator's, overriding the click-to-reveal recommendation): attachments render inline as
thumbnails.** `context.images` and `context.screenshotId` hold Cloudflare Images keys — the same kind of
key `Image.url` holds, which is exactly what
[`EdgeImage.svelte`](../../apps/moderator/src/lib/components/EdgeImage.svelte) /
[`edge-url.ts`](../../apps/moderator/src/lib/media/edge-url.ts) take — so
`<EdgeImage src={id} width={320} />` is the whole implementation.

🔴 **Accepted risk, recorded rather than argued.** `feedback.schema.ts`:13-24 states outright that these
are *"ids the CLIENT says it uploaded: this request never proves the objects exist, that they belong to
this user, or that the screenshot is of the page named in `path`."* Rendering them inline therefore
auto-loads unverified, client-supplied Cloudflare ids into a moderator's browser the moment the row is
expanded. Two consequences follow and neither is hypothetical:

1. a **page capture can contain NSFW content** — the reporter's own viewport, on a site that serves it —
   or another user's private UI, neither of which the moderator asked to see;
2. the id is attacker-chosen, so a reporter can point the moderator's browser at *any* object in the
   Cloudflare account, not only one they uploaded.

**Mitigation option, one line, not adopted:** render each thumbnail through `EdgeImage`'s existing
`blur` parameter (`blur={40}`) with a click to clear it — the transform is applied at the CDN, so it
costs one prop and no new code path. If the queue is ever opened by anyone who is not a moderator, take
it.

Accepted as-is for this scope. Row-level expansion is the containment: nothing loads until a moderator
opens the row.

---

## 4. Access design

Two independent axes, composed where the action runs, per
[`page-feature-permissions.md`](page-feature-permissions.md) and the app's own `CLAUDE.md`. Getting this
wrong once cost four moderator abilities; the failure mode was a permission that named a page.

### The page grant

```ts
// $lib/server/access.ts — NAVIGATION
{ path: '/feedback', label: 'Feedback', countKey: 'feedbackNew' },
```

That is the whole of "who may **open** the queue". It is enforced centrally in
[`hooks.server.ts`](../../apps/moderator/src/hooks.server.ts):126-135 against the concrete pathname —
there is no per-page `requireAccess`, and adding one would be a second gate that can disagree with the
first.

🔴 **There is no `feedback.read` permission and there must not be.** Reading the queue is what the page
grant means; a permission that duplicates it is exactly the weld this app's history forbids.

### The action permissions

Two, added to `PERMISSIONS` in
[`apps/moderator/src/lib/permissions.ts`](../../apps/moderator/src/lib/permissions.ts):

```ts
{ id: 'feedback.status.set', label: 'Set feedback status and triage notes' },
{ id: 'feedback.bug.promote', label: 'Promote feedback to a Known Issue' },
```

| Action | Gate |
| --- | --- |
| Open `/feedback`, read any row, see the attachments and context | page grant on `/feedback` |
| Change `status`; write / edit `triageNote` | `requiresGrant('feedback.status.set', …)` |
| Promote to a `Bug` (and link `bugId`) | `requiresGrant('feedback.bug.promote', …)` |

### Why two and not one, or three

**Two, and the recommendation is not hedged.**

*Why not one.* Setting a status and writing an internal note are moderator-internal, reversible, and
visible to nobody outside this app. Promoting writes a row into `Bug` — the table that backs the
**public** Known Issues board at `/issues`, and the table the inbound ClickUp webhook mutates. Different
blast radius, different audience, different table. The app already carries this exact split with a
recorded reason: `audit.ban.execute` exists because *"Reaching a review queue is an investigation right;
banning the account it belongs to is not."* Reading and triaging feedback is queue work. Minting a row on
a public board is not.

*Why not three* (splitting status from note). They are written by one form, in one `UPDATE`, and a note
with no status change is a no-op in queue terms — nothing moves out of `new`, so nobody's view changes.
Two ids here would be two checkboxes on `/admin` that nobody could sensibly tick differently, and a
permission id is a stored value: minting one is cheap today and permanent afterwards.

*On the id spelling.* `feedback.status.set` follows `user.moderator.toggle` (domain.object.verb);
`feedback.bug.promote` follows `csam.report.file`. 🔴 Both are **stored values** — every grant row is
keyed `grant:<id>` — so renaming either after the first `/admin` save orphans its grants silently.

### Who holds them at launch — settled

**Both permissions are granted to the same set of roles.** Promoting is not held back from anyone who can
triage, because a promoted `Bug` lands with `publishedAt` **NULL** and is therefore invisible to everyone
without the `bugsEdit` flag; publishing it to the Known Issues board is a separate, deliberate act taken
on `/issues` by someone who holds that flag. The thing that would justify a narrower grant — a triager
being able to put text on a public page — is exactly what the null `publishedAt` prevents.

🔴 **The two ids stay separate even though the grant is identical, and that is the whole point.** The
split is the cheap half: both checkboxes already exist on `/admin`, so narrowing `feedback.bug.promote`
later is one tick and no code change, no migration and no rename. Collapsing them into one id now would
make that same decision a permission rename — which orphans stored grant rows — so the identical launch
grant is a *configuration* choice and the separate ids are the thing that keeps it reversible.

### Handover — the page ships invisible

🔴 **A new page has no `AppPageAccess` row, so on the day it merges only `moderator:admin` can see it,
and the two new permissions are held by nobody.** Three separate ticks are needed on `/admin`:

1. the `/feedback` **page** box, for each role that should reach the queue;
2. **Set feedback status and triage notes**;
3. **Promote feedback to a Known Issue** — the *same* roles as tick 2, per the decision above.

This is the same handover note the Audit section's five-agent review left for `audit.ban.execute` and
`csam.report.file`, and it is still open there — which is the argument for putting it in the merge
message rather than only here.

---

## 5. Actions

All three are SvelteKit form actions on `/feedback`, returning `fail(status, { error })` — never
`throw error()`, which would unmount a page holding an unsaved triage note.

### `setStatus` / `saveNote` — one action, `triage`

```
status: 'new' | 'reviewed' | 'actioned' | 'dismissed'   (zod enum, the four CHECK values)
note:   string, trimmed, '' → NULL
```

Writes, in one statement:

```
UPDATE "Feedback"
   SET "status" = $status,
       "triageNote" = $note,
       "handledById" = $moderatorId,
       "handledAt"   = now()
 WHERE "id" = $id
   AND "status" = $expectedStatus     -- optimistic-concurrency guard, from the form
```

🔴 **Zero affected rows is a failure**, not a success — the standing rule, and `resolveHelpRequest` and
`setReportStatus` are both already written this way with the incident recorded above them. Scoping the
`WHERE` on the status the operator was looking at turns "someone else already triaged this" into a 409
the page can render, instead of a silent overwrite of a colleague's verdict.

Moving a row **back to `new`** must clear `handledById`/`handledAt` rather than stamp them — otherwise
"handled by" says a moderator handled something that is sitting in the unhandled queue.

Records `recordModActivity({ entityType: 'feedback', entityId: id, activity: 'triage' })` for the same
reason every other mutation in this app does.

### `promote` — feedback → `Bug`

🔴 **This scope creates no ClickUp task and calls no ClickUp API, because it cannot.** Verified: the
product code has a ClickUp **webhook secret** (`CLICKUP_WEBHOOK_SECRET`,
[`src/env/server-schema.ts`](../../src/env/server-schema.ts):852) and nothing else — no client, no token,
no base URL. The one `api.clickup.com` string in the tree lives in
`apps/event-engine/.claude/skills/clickup/api/client.mjs`, agent tooling that no application code imports
and whose `CLICKUP_API_TOKEN` is not in the env schema. **The ClickUp task is still created by hand
today**, by a moderator, in ClickUp, and its URL pasted onto the Bug.

What the action does instead: insert a `Bug` row, and link it.

| `Bug` field | Seeded from | |
| --- | --- | --- |
| `title` | `message`, first line, clipped to ~100 chars | **Moderator edits before submit** — a bug title is a summary, and a feedback message is a complaint |
| `summary` | — | **Moderator writes it.** Required (`z.string().min(1)`) |
| `content` | — | Left null. See the sanitisation note below |
| `status` | `'Open'` | The schema default |
| `publishedAt` | `NULL` | 🔴 Load-bearing — see below |
| `clickupUrl` | — | Optional, pasted by hand after the task is made |
| `domain` | `[all]` | Schema default |
| `tags` | `[]` | Moderator may add |
| `disabled` | `false` | Schema default |
| `resolvedAt` | `NULL` | Derived: `isBugClosed('Open')` is false |

🔴 **`publishedAt: NULL` is what keeps the reporter's words off the public board.** `getBugs` filters
`publishedAt = { lte: now, not: null }` and `disabled: false` for anyone without the `bugsEdit` feature
flag ([`bug.service.ts`](../../src/server/services/bug.service.ts):73-76), so an unpublished Bug is a
draft visible only to flag holders. Publishing stays a deliberate second act, taken on `/issues` by
someone who holds `bugsEdit` — not a side effect of triaging feedback.

🔴 **Do not seed `content` from `message` without deciding about HTML.** `createBugInput.content` runs
through `getSanitizedStringSchema()`, i.e. the field is stored and rendered as HTML. Feedback `message`
is plain text written by a user. Piping one into the other means user-authored text reaching an
HTML-rendered field on a public board via a path that never sanitises it, because the spoke does not go
through that zod schema. Leaving `content` null and making the moderator write the summary sidesteps it
entirely, which is why this proposal does that.

**The spoke writes the row directly with Kysely.** It has to: `apps/moderator` speaks Kysely, not tRPC,
and `bug.create` is a `moderatorProcedure` in the main app. This is safe to reproduce because
[`createBug`](../../src/server/services/bug.service.ts):139-149 is a plain insert with one derived field
(`resolvedAt = isBugClosed(status) ? new Date() : null`) — no cache bust, no notification, no search
enqueue. Port `isBugClosed` rather than re-deriving it; with a hardcoded `'Open'` it is always `null`,
but a future status field on this form makes that assumption wrong silently.

Then, in the same transaction:

```
UPDATE "Feedback" SET "bugId" = $newBugId, "status" = 'actioned',
                      "handledById" = $moderatorId, "handledAt" = now()
 WHERE "id" = $id AND "bugId" IS NULL
```

`AND "bugId" IS NULL` makes double-promotion impossible; zero rows means someone beat you to it, and the
Bug insert rolls back with it.

### Linking existing feedback to an existing Bug

The same action, with `bugId` supplied instead of the new-bug fields — a numeric input plus a lookup of
the Bug's title for confirmation. This is the common case after the first promotion: the second report of
the same thing gets attached, not re-filed.

### Afterwards

Once `bugId` is set, the expanded row shows:

- a link to the Bug on `/issues` (via `civitaiLinkUrl()`), with its **current** `Bug.status` read live —
  so the moderator sees ClickUp's answer, which is the entire point of routing through `Bug`;
- **“3 other reports linked to this issue”**, listing the sibling `Feedback` rows with the same `bugId`,
  each linking to `?open=<id>`. This is what turns 26 rows of duplicated complaints into one issue.

The status flow back from ClickUp needs nothing new:
`ClickUp task → /api/webhooks/clickup → resolveBugsByClickupTaskId → Bug.status = 'Complete'` already
exists and is signature-verified. A later phase could surface "your report was fixed" to the reporter;
that is not in this scope.

### A later automated-creation phase — what it would need

Not designed here. For the record, so nobody assumes the pieces exist: a ClickUp **API token** in SOPS, a
target **list id**, an outbound client (there is none), the token wired into the moderator app's env
(which today carries no ClickUp variable at all), and a decision about what happens when the ClickUp call
fails after the `Bug` row is already committed.

---

## 6. Migration

**File:**
[`packages/civitai-db-schema/prisma/migrations/20260911120000_feedback_triage/migration.sql`](../../packages/civitai-db-schema/prisma/migrations/20260911120000_feedback_triage/migration.sql)
— written, additive, idempotent, manual-apply header, following
`20260813180000_feedback` and `20260910120000_app_user_scope_grant_buzz_budget`.

| Change | |
| --- | --- |
| `+ "triageNote" TEXT NULL` | Moderator-internal. Never seeded into a Bug |
| `+ "handledById" INTEGER NULL` | FK → `User(id)` `ON DELETE SET NULL ON UPDATE CASCADE` |
| `+ "handledAt" TIMESTAMP(3) NULL` | |
| `+ "bugId" INTEGER NULL` | FK → `Bug(id)` `ON DELETE SET NULL ON UPDATE CASCADE` |
| `+ Feedback_status_createdAt_idx` | `("status", "createdAt" DESC)` — the default view and the sidebar count |
| `Feedback_status_check` | **Untouched.** Triage reuses the four statuses it already allows |

Both FKs go through `pg_constraint` `DO` blocks, because `ALTER TABLE … ADD CONSTRAINT` has no
`IF NOT EXISTS` form. Every `ADD COLUMN` is nullable with no default, so all four are catalog-only on
PG 11+ — no table rewrite, safe while the site is up.

🔴 **Nothing applies this.** There is no `prisma migrate deploy` in any deploy path, `_prisma_migrations`
is not the source of truth, and CI does not run migrations. A human applies it, per environment, to
**prod nvme0** and **the dev clone**.

### The Prisma model change — stated, deliberately NOT applied on this branch

⚠️ **The brief named `packages/civitai-db-schema/prisma/schema.prisma`. That file does not exist in the
repo.** It is *generated* by `scripts/generate-slim-schema.js` from
[`schema.full.prisma`](../../packages/civitai-db-schema/prisma/schema.full.prisma) and is gitignored
(`.gitignore:17`). The authored model lives at `schema.full.prisma:2352-2366`. The edit is:

```prisma
model Feedback {
  id          Int       @id @default(autoincrement())
  area        String
  userId      Int
  user        User      @relation(fields: [userId], references: [id], onDelete: Cascade)
  message     String
  context     Json      @default("{}")
  status      String    @default("new")
  createdAt   DateTime  @default(now())

  triageNote  String?
  handledById Int?
  handledBy   User?     @relation("FeedbackHandledBy", fields: [handledById], references: [id], onDelete: SetNull)
  handledAt   DateTime?
  bugId       Int?
  bug         Bug?      @relation(fields: [bugId], references: [id], onDelete: SetNull)

  @@index([area, status, createdAt(sort: Desc)])
  @@index([userId, createdAt(sort: Desc)])
  @@index([status, createdAt(sort: Desc)])
}
```

Plus the two back-relations Prisma requires: `feedbackHandled Feedback[] @relation("FeedbackHandledBy")`
on `model User` (the existing `feedback Feedback[]` stays, and the named relation is what keeps the two
`User` links unambiguous), and `feedback Feedback[]` on `model Bug`.

**This branch does not make that edit, and that is deliberate.** Two CI gates make it a non-trivial
commit that a scoping pass has no business landing:

- **`db:check-generated`** (`.github/workflows/lint.yml:674-677`) runs `pnpm run db:generate` and then
  `git diff --exit-code -- packages/civitai-db-schema/src`. `packages/civitai-db-schema/src/*` is
  **generated but tracked**, so editing `schema.full.prisma` without regenerating and committing
  `kysely/types.ts`, `models.ts` and `enums.ts` turns the gate red.
- **`schema-drift`** (`.github/workflows/schema-drift.yml:86`) compares `schema.full.prisma` against a
  captured production catalog. Four columns present in the schema and absent from the database is the
  normal state of a pending hand-applied migration here, but it is a delta the gate will have an opinion
  about, and that opinion should be read on the implementation PR rather than guessed at now.

**Who runs what, and when.** On the implementation PR, in this order:

1. edit `schema.full.prisma` as above;
2. `pnpm run db:generate` (root) — regenerates `src/kysely/types.ts`, `src/models.ts`, `src/enums.ts`;
3. commit those generated files **in the same commit**, or `db:check-generated` fails;
4. a human applies `20260911120000_feedback_triage/migration.sql` to prod nvme0 and the dev clone.

Until step 2 runs, the moderator app's Kysely types do not know the four columns exist and the page
cannot be written. **Step 2 is the first thing the implementation session does, not the last.**

---

## 7. Test plan

This app's suite is narrow and lopsided — the report queue and abuse detection are most of it — and it
is node-env tests over plain modules: **route `load`/`actions` are importable and testable; component
behaviour is not**, because no SvelteKit app here has a browser-test project. `pnpm exec vitest list
--filesOnly` is the only honest inventory of what runs. (A `find` over `apps/moderator/src` shows 53 test
files on disk; that is a count of files, not of what vitest selects, and this proposal did not run
vitest.)

Any verification claim on the implementation PR must say **which** of `typecheck` and `test` it refers
to. A `typecheck` cannot see a wrong predicate, a mis-attributed row, or a status transition that never
lands — all three have shipped in this app and been found later by reading the code.

### Worth covering — the pure decision functions

In the style of
[`routes/reports/[slug]/__tests__/report-actions.test.ts`](../../apps/moderator/src/routes/reports/[slug]/__tests__/report-actions.test.ts):
real `FormData`, mocked service module, assert the **translation** of the service's outcome.

| Target | What a wrong answer costs |
| --- | --- |
| `reconstructFeedbackUrl(path, filters)` | The one function that makes a one-line report actionable. Table-drive it: defaults omitted (`kind=all`, `sort=top-rated`, empty `query`), `category: 'none'` omitted, a non-default combination round-tripped, and `path` absent (SSR) yielding no link rather than a link to `/` |
| `feedbackAreaOptions(distinctAreas, FEEDBACK_AREAS)` | The union that keeps the 23 orphaned `bitdex-image-feed` rows reachable. Assert an area present **only** in the table still appears — that is the whole decision, and the failure is silent |
| `triage` action: zero affected rows | Must be a `fail(409)`, not `{ success: true }`. Mock the service to `{ ok: true, changed: false }` and assert the status code and the message, not merely that it failed |
| `triage` action: status → `new` | Must clear `handledById`/`handledAt`. Assert the values passed to the service, not the return |
| `promote` action: outcome translation | Service `{ ok: false, reason: 'already-linked' }` → a 409 the page renders; assert no Bug insert was attempted |
| `splitContext(context)` | The known-keys / unknown-keys split. Feed it a key none of the five named ones cover and assert it lands in the "other" bucket — this is what stops a future area's payload vanishing |
| `faroSessionLink({ sessionId, createdAt, now })` | 🔴 The highest-value test on this page, because both of its wrong answers are silent. Take `now` as an **argument**, never `Date.now()` inside — a function that reads the clock cannot be tested at the boundary at all. Four cases: **inside** 72 h → a URL; **outside** → `null` (the caller renders the expired note); **exactly 72 h** → pin which side the boundary falls on and assert it, rather than leaving it to whichever comparison operator got typed; `sessionId` absent → `null`, not a URL with `undefined` in it. Then assert the built URL **contains `|= "<id>"` and does not contain `logfmt`** — that is the whole two-spellings hazard, expressed as something a machine can check |

Worth adding, in the `explain-harness` style already in this app: an `EXPLAIN` (never `ANALYZE`) over the
list query and the count, gated on `describe.skipIf(!hasDb)`, to prove the two new reads compile against
the real schema. Cheap, and it is the only thing that catches a column name that typechecks against a
stale generated type.

**Not worth testing:** the thumbnail rendering, the expand/collapse, the filter bar. All component
behaviour, none of it reachable from a node-env suite, and all of it verified by opening the page — which
this app's standard requires anyway.

---

## 8. Risks and decisions

### Risks

🔴 **Inline attachments render unverified, client-supplied Cloudflare ids.** Section 3 carries the full
statement. Accepted by the operator; the one-line mitigation (`blur={40}` + click to clear) is recorded
and not adopted. Revisit if anyone who is not a moderator ever gets the page grant.

🔴 **Faro session data expires at 72 h, and the failure mode is an empty screen that lies.** Loki's global
`retention_period` is 72h and `{source="faro-rum"}` has no stream override. Past that window the Explore
view returns no rows — and *"the data expired"*, *"this session produced no telemetry"* and *"the link is
broken"* are three different facts with **one observable**. A reader who is not told which one they are
looking at will pick whichever they already suspected. The age-aware rendering in §3 is the whole
mitigation: inside 72 h a link, outside it no link and an explicit expiry note, cutoff derived from
`createdAt` and held in one named constant (`FARO_LOKI_RETENTION_HOURS`) whose comment names Loki's
`limits_config` as its source. 🔴 **That constant is a copy of a number owned by another repo.** Nothing
makes the two agree — if Loki's retention is ever shortened, this page starts offering links that land on
nothing, and the mismatch is invisible from inside this codebase. Re-read it when the link stops paying
off, and treat a live link that returns nothing as evidence the constant is stale, not that Faro is
broken.

🟡 **The deep link is only worth having if the queue is read within three days.** Stated in §3 and worth
repeating as a risk, because it is the one that has already happened: the queue has gone unread for a
month, so every row in it today renders as expired. The link does not fix triage latency — it *rewards*
it, which is a different thing and is why it ships alongside the sidebar count rather than instead of it.

🔴 **`Bug.status` is a free-form string with no enum and no CHECK constraint.**
`BUG_STATUS_SUGGESTIONS = ['Open', 'In Progress', 'In Review', 'Complete']` is an autocomplete list fed
to a free-text field, and `isBugClosed` matches `['complete','closed','done','resolved']`
case-insensitively. So "is this bug closed?" is a string comparison against a value ClickUp supplies.
Read the closed state through `isBugClosed`, never by comparing to a literal.

🟡 **The spoke becomes a second writer of `Bug`.** `createBug` in the main app and the spoke's Kysely
insert will both exist. `createBug` is a plain insert today, so they cannot disagree — but if it ever
grows a side effect (a cache bust, a search enqueue, a notification), the spoke will silently not do it.
The same hazard the `/api/mod/[action]` endpoints in
[`moderator-actions-plan.md`](moderator-actions-plan.md) exist to remove; if a second writer is
unwelcome, `bug-create` is a natural candidate for that surface and would replace this half of the
promote action without touching the rest.

🟡 **The page ships invisible.** Section 4's handover. Not a defect, but it is how the last two
permissions ended up ungranted and unnoticed.

🟡 **`context` has no schema at rest.** It is JSONB, written by a zod schema in a different app, and the
moderator page must not assume any key is present — including `path`, which is `undefined` during SSR by
its own type. Every read is optional-chained or it is a 500 on a row nobody can then triage.

### The 23 orphaned `bitdex-image-feed` rows — recommendation

**Keep them, show them, and triage them once.** They are 88% of the table, their producer is gone, and
they cost nothing to display. The concrete recommendation:

1. ship the page with the area filter defaulting to **all areas**, so the first person to open it sees
   all 26;
2. read the 23 in one sitting, `dismissed` with a one-word `triageNote` for anything about the retired
   BitDex feed, `actioned` or promoted for anything that describes a defect that still exists;
3. do **not** delete them and do **not** backfill a status in SQL. A hand-written
   `UPDATE … SET status='dismissed'` would stamp `handledById = NULL` across 23 rows, which reads
   forever after as "the system dismissed these", and it would be the first write to this table by
   anything other than the app.

That leaves the queue at 3 rows on day two, which is the honest number.

### Decisions

The three questions this proposal opened have been answered. They are settled, not deferred.

**1. No reporter feedback loop. `Feedback.bugId` is an internal link only.** Nothing notifies the
reporter that their feedback was read, promoted, or fixed — not now, and not as a planned later phase.
If a promoted report is eventually published to Known Issues the reporter may come across it like anyone
else; that is **incidental, not a designed path**, and no part of this page should be built as if it were
the first step toward one. What this settles concretely: `bugId` needs no user-facing rendering, no
notification hook and no "reporter was told" state, and the sibling-reports panel in §5 can show
`userId`s freely because it is a moderator-only view with no outward edge.

**2. `feedback.bug.promote` launches with the same roles as `feedback.status.set`.** Reasoning and the
"separate ids, identical grant, cheap to narrow later" argument are in §4 — that is where an implementer
will look for it.

**3. Build the Grafana Explore deep link.** This overrode the recommendation to leave `sessionId` as a
copyable string, and the design is in §3. The reversal was right for a reason worth recording: the
objection was "a new env var and an unknown URL format for 3 rows", and both halves dissolved on contact
with the facts — the Loki datasource has a **pinned** uid (`loki`, confirmed in the running Grafana pod,
not inferred from a manifest), so there was no format to guess at. What the investigation *did* surface
was the thing nobody had asked about: **72 h retention**, which changes the feature's shape far more than
the link itself does. The question was worth asking; the answer it produced was not the one it was about.

---

## 9. Effort estimate

| Piece | Estimate |
| --- | --- |
| `schema.full.prisma` edit + `db:generate` + commit the generated files | 0.5 h |
| Apply the migration by hand (prod nvme0 + dev clone) | 0.25 h, human |
| `$lib/feedback.ts` — area/status labels, `reconstructFeedbackUrl`, `splitContext`, `feedbackAreaOptions` | 2 h |
| `faroSessionLink` + `FARO_LOKI_RETENTION_HOURS` + `PUBLIC_GRAFANA_URL` wiring (env var, `.env.example`, the absent-var and expired branches) | 1 h |
| `$lib/server/feedback.service.ts` — list (keyset), count, `triage`, `promote`, `linkToBug`, siblings-by-bug | 3 h |
| `NAVIGATION` entry + two `PERMISSIONS` + the `feedbackNew` count in `sidebar-counts.service.ts` | 1 h |
| `/feedback` route — `+page.server.ts` (load + 2 actions) | 2 h |
| `/feedback` UI — list, filter bar, expanded row, context panel, thumbnails, promote form | 5 h |
| Tests (§7) | 3 h |
| `svelte-correctness-review` / `svelte-idiom-review` / `svelte-abstraction-review` + fixes + looking at the page | 3 h |
| **Total** | **~20.5 h**, one implementation pass |

🔴 **One thing in the deep link cannot be desk-checked and is not in any of the numbers above: click it
once.** The datasource uid and the Grafana version are confirmed live, and the `panes` state is Grafana's
documented Explore format for 13.x — but a URL built from documentation is a claim about the
documentation. Build one against a report **less than 72 h old** (a fresh one, or a row you have just
written into the dev clone) and confirm it lands on rows rather than an empty pane; a link tested against
an expired session proves only that expiry works.

### Not in scope

- **Any outbound ClickUp call.** No token, no client, no list id. The task is created by hand.
- **Publishing a Bug.** Stays on `/issues`, behind `bugsEdit`.
- **New `FeedbackPrompt` mount points.** This is a read surface; where the prompt appears is a separate
  decision.
- **The write-side gaps.** Noted, not scoped: attachments upload *before* the rate limiter runs
  (`feedback.constants.ts`:19-36), so a failed re-send still spends upload budget; and nothing verifies
  that an uploaded image id belongs to the reporter. Both are real and both are the producer's problem,
  not the queue's.
- **Notifying reporters.** A **settled no**, not a deferral — see §8 Decisions. `Feedback.bugId` is an
  internal link; nothing on this page tells a user their report was read, promoted or fixed.
- **A cluster-side consumer** (Discord notifier, weekly digest). If the queue is worth watching, that is
  the next lever, and it should read the same service this page does rather than the table directly.
  🔴 Note what §3 implies about its urgency: Faro telemetry is gone after 72 h, so a notifier is the only
  thing that could reliably get a moderator to the queue while the deep link still resolves.
