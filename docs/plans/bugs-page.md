# Bugs Page (Public Issue Tracker)

A public `/bugs` page that mirrors the `/changelog` surface but tracks **open** issues
instead of historical events. Mods own status manually (in-progress → in review →
complete, or whatever strings make sense). Users can press an "I'm experiencing this"
button so we can see whether reports are still coming in after we move a bug to
"in review".

**Target:** ship today. Scope is held tight on purpose — see "Out of scope" at bottom.

## Decisions (resolved)

- [x] **New `Bug` model** (not reusing `Changelog`).
- [x] **Footer placement** between `status` and `creator-program`, reuse the existing
      `indicator: true` Indicator wiring in `AppFooter.tsx`.
- [x] **Status as a free-form string** — no Prisma enum. A hardcoded
      `BUG_CLOSED_STATUSES` array (lowercased strings) drives "is this bug resolved?"
      behavior (badge color, default-hide on list, set `resolvedAt`). All other strings
      treated as "open" — UI sub-categorization is a small label map.
- [x] **No ClickUp integration.** Mods own status manually via the edit form. Keeps
      surface area small for v1.

@ai: All locked in below. Notable knock-on changes:
- `BugStatus` enum gone; model holds `status String @default("Open")`.
- ClickHouse columns are `LowCardinality(String)`.
- Service exposes a fire-and-forget `reportBug` (no toggle/dedup).
- ClickUp model fields, webhook handler, status sync, and registration all removed.

## Data model

### `Bug` (new Prisma model)

```prisma
model Bug {
  id            Int           @id @default(autoincrement())
  title         String
  summary       String        // short public statement — shown in list
  content       String?       // optional longer markdown/HTML body (RTE)

  // Free-form string. "closed" determined by BUG_CLOSED_STATUSES in constants.
  status        String        @default("Open")

  firstSeenAt   DateTime      @default(now())
  resolvedAt    DateTime?     // set when status flips into BUG_CLOSED_STATUSES
  publishedAt   DateTime?     // null = draft / mod-only

  createdAt     DateTime      @default(now())
  updatedAt     DateTime      @updatedAt
  disabled      Boolean       @default(false)
  domain        DomainColor[] @default([all])
  tags          String[]      @default([])

  @@index([status, publishedAt])
}
```

@ai: Dropped `UserBugReport` per your note. Report counts live entirely in
ClickHouse, fronted by a Redis `cachedCounter` (see "Report counter" below).
No Postgres state for per-user reports — users can press the button as many
times as they like, every press is an event in ClickHouse, the cached counter
ticks up.


### ClickHouse — `bugReports` (new table)

Append-only firehose. Every press of "I'm experiencing this" inserts one row.
No deduplication — the time-series shape (are we still getting reports after
status flipped to "in review"?) is the whole point.

Add DDL to `containers/clickhouse/docker-init/init.sh`:

```sql
CREATE TABLE bugReports (
  bugId      UInt32,
  userId     UInt32,                  -- 0 for anonymous
  status     LowCardinality(String),  -- bug status at time of report (e.g. "in progress")
  createdAt  DateTime DEFAULT now(),
  ip         String,
  userAgent  String
) ENGINE = MergeTree() ORDER BY (bugId, createdAt);
```

@ai: Low-cardinality strings as requested. Dropped the `action` column — there's
no `unreport` anymore since we're not toggling. Every row is a "report" event.

### Report counter — Redis-backed via `cachedCounter`

We already have `cachedCounter(rootKey, fetchFn, { ttl })` in
`src/server/utils/cache-helpers.ts:386` — same shape as the image-metrics cache
flow. Wire one up:

```ts
// src/server/services/bug.service.ts
import { cachedCounter } from '~/server/utils/cache-helpers';
import { REDIS_KEYS } from '~/server/redis/client';
import { clickhouse } from '~/server/clickhouse/client';
import { CacheTTL } from '~/server/common/constants';

export const bugReportCounter = cachedCounter<number>(
  REDIS_KEYS.BUG_REPORTS, // new key — add to redis/client.ts
  async (bugId) => {
    if (!clickhouse) return 0;
    const [row] = await clickhouse.$query<{ total: number }>`
      SELECT count() AS total FROM bugReports WHERE bugId = ${bugId}
    `;
    return row?.total ?? 0;
  },
  { ttl: CacheTTL.hour }
);
```

Read path (`getBugs` / `getBug`): for each bug, `bugReportCounter.get(id)` →
Redis HIT returns cached count, MISS calls ClickHouse once, caches for 1 hour.

Write path (`reportBug` mutation): inserts a row into ClickHouse via the
Tracker, then `bugReportCounter.incrementBy(id, 1)` so the UI ticks immediately.
On TTL expiry the next read re-syncs from ClickHouse, which corrects for any
drift (e.g. a press where the CH insert failed).

@ai: This is the helper pattern you were remembering — same one used for the
image-metrics flow at `src/server/utils/metric-helpers.ts:113` (which uses
`entityMetricRedis.increment` under the hood for its specific entity-metric
schema). For a single counter per bug, `cachedCounter` is the direct fit and
doesn't require extending the `EntityMetric_EntityType_Type` enum.

## Server

### Service — `src/server/services/bug.service.ts`

Mirror of `changelog.service.ts`, adjusted for the simpler shape:

- `getBugs(input, hasFeature)` — paginated list; filters by status, "open vs
  closed" (BUG_CLOSED_STATUSES), tags, domain, search. Hydrates `reportCount`
  via `bugReportCounter.get(id)` per row.
- `getBug({ id })` — single, same counter hydration.
- `createBug` / `updateBug` / `deleteBug` — mod-only. `updateBug` sets
  `resolvedAt = now()` when status crosses into `BUG_CLOSED_STATUSES` (and
  clears it on re-open).
- `reportBug({ bugId, status })` — fires the ClickHouse event via Tracker and
  bumps the Redis counter. No tx, no Postgres write, no dedup. Anonymous users
  allowed (userId = 0 in CH).
- `getLatestBugUpdate(domain?)` — like `getLatestChangelog`, max `updatedAt`
  for the footer dot.

@ai: `toggleBugReport` became `reportBug`. All `BugStatus`-enum, Postgres
`UserBugReport`, and ClickUp-sync references are gone. Counter hydration calls
out the cache path.

### Router — `src/server/routers/bug.router.ts`

```ts
export const bugRouter = router({
  getInfinite: publicProcedure
    .meta({ requiredScope: TokenScope.UserRead })
    .input(getBugsInput)
    .use(applyRequestDomainColor)
    .query(...),
  getById: publicProcedure
    .meta({ requiredScope: TokenScope.UserRead })
    .input(z.object({ id: z.number() }))
    .query(...),
  getLatest: publicProcedure
    .meta({ requiredScope: TokenScope.UserRead })
    .use(edgeCacheIt({ ttl: CacheTTL.xs }))
    .query(...),
  report: publicProcedure // anon allowed; userId = 0 when not signed in
    .input(z.object({ bugId: z.number() }))
    .mutation(...),
  create: moderatorProcedure.input(createBugInput).mutation(...),
  update: moderatorProcedure.input(updateBugInput).mutation(...),
  delete: moderatorProcedure.input(deleteBugInput).mutation(...),
});
```

Register in `src/server/routers/index.ts` as `bug`.

### Public REST — for support agents

Thin REST wrappers over the tRPC procedures, mounted at:

- `GET /api/v1/bugs` — list with `?open=true&limit=50` (default: open only).
  Optional `?status=in+review,in+progress` for finer filtering.
- `GET /api/v1/bugs/[id]` — single

Both inherit `requiredScope: UserRead`. Output JSON shape matches Changelog's
public-API conventions and includes the cached `reportCount`.

### Tracker — `src/server/clickhouse/client.ts`

Add a `bugReport` method:

```ts
public bugReport(values: { bugId: number; status: string }) {
  return this.track('bugReports', values);
}
```

`userId`, `ip`, `userAgent` are filled in by `Tracker.track`'s actor block
(see `src/server/clickhouse/client.ts:363`). For anon users, `actor.userId`
is `0` — matches the CH schema.

## UI

### `src/pages/bugs/index.tsx`

Copy-modify of `src/pages/changelog/index.tsx`:

- SSG prefetches `bug.getInfinite` (status filter defaults to "open" = InProgress + PendingReview).
- Renders `<Bugs />` component.

### `src/components/Bug/Bugs.tsx`

Adapted from `Changelogs.tsx`:

- Top: title "Known Issues", search, status filter dropdown (default: open),
  sort by `updatedAt desc`.
- Mod create/edit form gated by `bugsEdit` feature flag (mirror `changelogEdit`).
- Card per bug shows: title, status badge, `reportCount`,
  "I'm experiencing this" button, body content.
- Same `?id={bugId}` deep-link + scroll-into-view behavior.
- Same `useLocalStorage('last-seen-bug', 0)` to drive the "new" dot per item.

### Card actions

- **"I'm experiencing this"** — small button below the card body. Authed and
  anon users both allowed. Each press fires `bug.report` and optimistically
  bumps the count shown next to the button. No server-side dedup; we accept
  some noise so the time-series signal stays honest.
- **Direct-link copy** — same `IconLink` pattern as Changelog cards.

### Footer link + dot indicator

In `src/components/AppLayout/AppFooter.tsx`, add to `footerLinks`:

```ts
{
  key: 'bugs',
  href: '/bugs',
  children: 'Known Issues',
  indicator: true, // toggled below
}
```

`indicator` becomes dynamic. Easiest approach: change `indicator` from `boolean`
to `boolean | (() => boolean)` and resolve at render with a query to
`bug.getLatest` + `useLocalStorage('last-seen-bug', 0)` — matches the pattern
in `HomeContentToggle.tsx:127-145`. Keep the LocalStorage write next to the
list render in `Bugs.tsx` so visiting the page clears the dot.

@ai: Mods own status manually via the edit form — no external sync.


### Feature flag

Add to `feature-flags.service.ts`:

```ts
bugsPage: ['public'],         // public visibility — ship on
bugsEdit: ['granted'],        // mod create/edit form
```

## Status semantics (constants)

Free-form string. Only one constant is needed — the list of statuses that count
as "closed":

```ts
// src/server/common/constants.ts
export const BUG_CLOSED_STATUSES = ['complete', 'closed', 'done', 'resolved'] as const;

export const isBugClosed = (status: string) =>
  BUG_CLOSED_STATUSES.includes(status.trim().toLowerCase() as any);
```

`isBugClosed` drives:
- `resolvedAt` set/clear in `updateBug`
- Default filter on `/bugs` (hide closed unless toggled on)
- Status badge color (green for closed, yellow/blue/grape for everything else)

UI label mapping (badge text + color) lives in `Bugs.tsx` — a small
case-insensitive lookup with a sensible fallback so unknown statuses still
render cleanly.

The mod create/edit form exposes `status` as a free-text input with a
suggested-values dropdown (`Open`, `In Progress`, `In Review`, `Complete`) —
mods can pick from the suggestions or type their own.

## Migration

One Prisma migration adding the `Bug` table (no enum, no `UserBugReport`),
plus the `bugReports` ClickHouse DDL added to
`containers/clickhouse/docker-init/init.sh` and applied to prod CH via the
`clickhouse-query` skill (`--writable`).

## Cache invalidation

- `bug.getLatest` has `edgeCacheIt({ ttl: CacheTTL.xs })` — short TTL is fine,
  no manual purge needed.
- After mod edits, invalidate `bug.getInfinite` and
  `bug.getLatest` via tRPC `queryUtils` on the client; server-side cache is
  edge TTL only.

## Out of scope for v1 (intentionally cut to ship today)

- User-submitted bug reports (a "Report a new bug" form). Mods create entries.
- Per-bug subscriptions / notifications when status changes.
- Private mod-only notes on the Bug record.
- Severity field surfacing in UI (model has no severity column in v1).
- Slack/Discord cross-post on status change.
- ClickUp integration (status auto-sync, task linking) — explicitly out of v1
  scope to keep the surface tight.
- Bug-to-Changelog promotion (auto-create a `Changelog{type: Bugfix}` row when
  a Bug hits a closed status). Worth doing later — explicit cut for v1.

## Build order (to keep "ship today" honest)

1. Prisma migration (`Bug` only) + ClickHouse `bugReports` DDL applied to prod.
2. Service (`getBugs`, `getBug`, `createBug`, `updateBug`, `deleteBug`,
   `reportBug`, `getLatestBugUpdate`) + `bugReportCounter`.
3. Router + REST endpoints.
4. `/bugs` page + `Bugs.tsx` (copy-modify from Changelog).
5. Footer link + dot indicator wiring.
6. "I'm experiencing this" button + `bug.report` mutation.
7. Feature flag flip → public.

Pieces 1-5 ship a usable page; 6 layers on user reports without blocking launch.
