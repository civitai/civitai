---
name: moderator-page-migration
description: Port a moderator page from the main Next.js app (src/pages/moderator/**) into apps/moderator. Use when asked to migrate, move or cut over a /moderator/* page to the spoke, or to port its tRPC procedures and Prisma services to SvelteKit loads/actions and Kysely.
---

# Main app → moderator spoke migration

Ports a page under `src/pages/moderator/**` into `apps/moderator`, then **switches the main-app page
off**. The React component is not the work — the page's whole backend slice is. tRPC and Prisma do not
exist in the spoke.

Sibling skill: [`retool-migration`](../retool-migration/SKILL.md), for the other inbound path. The two
converge — same app, same conventions, same reviews — and differ only in what the source is and how you
read it. Read that skill's §4–§6 if you have not built a page here before; they are not repeated.

## Done means all three

A migration is one unit of work and it is not finished until every part of it is. Partial delivery is
the failure mode this whole skill is arranged around — a page that is 90% ported and still live in both
apps is worse than one that was never started, because a moderator now has two tools that disagree.

1. **Full functional parity.** Every query, every mutation, every side effect, and every action reachable
   from the page's child components. Not "the useful half" — §1 and §2 are how you enumerate it, §6.1 is
   the gate.
2. **The legacy page removed, and everything it orphans with it.** Delete the page file, redirect its URL,
   then trim the procedures, controllers, schemas and service functions nothing else uses. Leaving the old
   page live means moderators keep using it. Leaving dead procedures behind means the next reader cannot
   tell what is still load-bearing. §5.
3. **Reviewed** — `svelte-correctness-review`, `svelte-idiom-review` and `svelte-abstraction-review` over
   the segment, findings fixed. §6.

Do not tick the tracker until all three have happened.

## 0. Read the tracker first

[`docs/moderator-app/page-migration-checklist.md`](../../../docs/moderator-app/page-migration-checklist.md)
is the tracker. Every page is a checkbox with its procedures, services, schemas and infra already
enumerated, plus what earlier ports deferred. **Read your page's entry before writing code** — several
carry a decision you would otherwise re-litigate (`/moderator/tags` may be superseded by
`/images/tags`; Paddle pages are excluded by decision).

Update it as part of the work, not afterwards: tick the page, and write what you deliberately did not
port. "Not ported" and "not needed" look identical six months later.

The second tracker is
[`side-effect-parity-checklist.md`](../../../docs/moderator-app/side-effect-parity-checklist.md) — see §3.

## 1. Inventory the slice

A page is not its procedures. Walk outward until nothing new appears:

```bash
sed -n '1,80p' src/pages/moderator/<page>.tsx        # the flag guard and what it renders
grep -n "trpc\." src/pages/moderator/<page>.tsx      # procedures the PAGE calls
grep -rn "<procedure>" src/server/routers/           # → controller → service
```

Then, for every service function a mutation reaches, read it to the end. That is where the migration
actually lives.

🔴 **The child components issue mutations the page never mentions.** A context menu, a row action, a
confirm dialog — each imports `trpc` itself, so grepping the page file finds none of them. The
`/moderator/articles` entry in the tracker says exactly this ("`ArticleContextMenu` may issue extra
mutations — verify"), and it is the main-app analogue of the Retool export's missing event handlers.
Grep the component tree, not the page:

```bash
grep -rn "trpc\.[a-z]" $(grep -o "from '~/components/[^']*'" src/pages/moderator/<page>.tsx \
  | sed "s|from '~/|src/|;s|'||") 2>/dev/null
```

**A shared service is ported once, for the whole cluster.** `image.service.ts` (~8K lines) and
`report.service.ts` back most of the image/CSAM pages. Port the functions your page needs into a spoke
service, and check `apps/moderator/src/lib/server/` first — 80+ services already exist there and the
one you want is often among them.

## 2. Classify every mutation's side effects — before building

The queries port mechanically. **The mutations are the risk**, because a main-app moderation write is
rarely one UPDATE: it fans out to notifications, email, Buzz, ClickHouse, Redis busts, search-index
enqueue and session invalidation, and none of that is visible from the procedure name.

For each mutation, list every effect its service performs and put each into one bucket:

| Bucket | Meaning |
| --- | --- |
| **port** | The spoke does it. Most Postgres/Redis/ClickHouse/S3 work, via the `@civitai/*` packages. |
| **delegate** | Stays in the main app behind an internal endpoint the spoke calls. The pattern exists: `syncKonoFinalize` in `apps/moderator/src/lib/server/kono.ts` → `src/pages/api/internal/kono-finalize.ts`. |
| **defer** | Deliberately dropped for now. **Goes in the side-effect checklist with a severity**, not in a code comment. |
| **equivalent** | Covered differently here — say how. |

An effect not in a bucket is dropped by accident, and a dropped side effect is invisible: the page
works, the moderator sees success, and the notification/index/cache silently never happens. That is the
whole reason `side-effect-parity-checklist.md` exists — it was written after an audit found eight of
them across three already-migrated domains, two rated BLOCKER.

**Delegate rather than defer for anything a moderator would notice.** Deferring is for effects whose
absence is recoverable (analytics, a self-healing metric); delegating is for the ones that are not.

## 3. Map main app → spoke

| Main app | Spoke |
| --- | --- |
| tRPC query procedure | `+page.server.ts` `load`, or an `+server.ts` endpoint if it is slow enough to keep off the load |
| tRPC mutation | form `action` in `+page.server.ts`, calling a service |
| `src/server/services/*.service.ts` (Prisma) | `apps/moderator/src/lib/server/*.service.ts` (Kysely) |
| `dbRead` / `dbWrite` (Prisma) | `$lib/server/db.ts` — Kysely over `@civitai/db` |
| zod schema in `src/server/schema/` | zod in the spoke; reuse for the action's parse |
| Redis, ClickHouse, S3, email, notifications, Buzz, orchestrator | the `@civitai/*` packages, already deps of the app |
| feature flag (`flag: strikes`) | **nothing** — no Flipt in the spoke by decision. Access is the role gate in `hooks.server.ts` |
| moderation data with no Prisma model (notes, image help requests) | `getModeratorDb()` — a second database, typed by `apps/moderator/prisma/schema.prisma` (introspected). **Not mutes or strikes** — both live in the main DB (`User.muteExpiresAt`, `UserStrike`); the side tables are Retool-era history. |

**Adding a package the app does not have yet** is three edits, not one: `workspace:*` in
`apps/moderator/package.json`, the name in `ssr.noExternal` in `vite.config.ts`, then `pnpm install`.
Miss the second and it fails at runtime, not at typecheck.

**A pure moderation constant or util that now exists in both apps belongs in `@civitai/mod-utils`** —
add a row to [`mod-utils-candidates.md`](../../../docs/moderator-app/mod-utils-candidates.md) and move
it in its own scoped change, never folded into the page port. Utils only: no DB, no `process.env`, no
framework imports.

### Prisma → Kysely: match the predicate, not the intent

🔴 **A partial index is matched by the literal shape of its predicate, including casts.** The
`/images/tags` port had to reproduce `TagsOnImageNew`'s predicate exactly — `::integer` cast included —
because a semantically identical form does not match the index and sequential-scans the table. Before
rewriting any `WHERE` a Prisma query generated, check what index it was hitting and keep the shape.

Two more from ports already done, both silent:

- **Pick the cheap source.** Image tags come from `TagsOnImageDetails` plus a hash-index vote count, not
  the `ImageTag` view, which is expensive.
- **`timestamp without time zone` columns read as local time** in node-pg with no parser registered, so
  `toISOString()` adds the host's offset. Pass such bounds with `to_char`. On a UTC-6 host this hid 60%
  of the rows a page existed to find.

Use Kysely's builder by default; raw `sql` only for bitmask/index-match, PG functions, jsonb and LATERAL.

## 4. Build, register, grant

Per [`apps/moderator/CLAUDE.md`](../../../apps/moderator/CLAUDE.md) and
[`docs/svelte-app-standard.md`](../../../docs/svelte-app-standard.md) — Svelte 5 runes, derive-the-promise,
keyed `{#each}`, `applyAction` in custom `enhance`, shadcn primitives, `text-dark-2`. Filters go in the URL
query string ([`url-filtering-pattern.md`](../../../docs/moderator-app/url-filtering-pattern.md)). Image
grids reuse `ImageQueueGrid`.

Register the route in `NAVIGATION` in `$lib/server/access.ts` — **a page absent from it is unreachable for
everyone, admins included** — and put the page under the nav group it belongs to (`/images`, `/audit`,
`/articles`, …), *not* under `/retool`, which is the transitional namespace for the other inbound path.

Then say in the handover that **the page needs granting on `/admin`**. A new page has no `AppPageAccess`
row, so only `moderator:admin` can open it until someone ticks the boxes. That is correct behaviour, not
a bug, and it is the thing a moderator reports as "the migration broke my page".

Gate actions on `locals.grants['<permission.id>']` (or `requiresGrant`), on the page's own path — never a
parent group node, whose grant is the union of its children.

## 5. Cut over — this is the step that gets skipped

A migration is not done when the spoke page renders. It is done when the main-app page is **gone** and
its URL lands on the spoke. Otherwise both exist, and moderators use whichever they had bookmarked.

**Deleting the page and adding its redirect are ONE change.** `src/pages/moderator/[...slug].tsx` is a
catchall: a real page file takes routing precedence over it, so the entry in `MIGRATED_ROUTES` does
nothing until the file is deleted, and deleting the file without the entry 404s.

```ts
// src/shared/constants/migrated-moderator-routes.ts
export const MIGRATED_ROUTES: Record<string, string> = {
  'image-rating-review': 'images/ratings',   // key = path under /moderator, value = spoke path
};
```

Longest matching key wins and the sub-path is preserved, so one entry covers a whole subtree with
dynamic segments, and a rename maps cleanly. `ModerationNav` reads the same map to mark the links that
leave the app — which is why there must not be a second copy of this list.

**Then trim everything the deletion orphaned.** This is part of the migration, not a follow-up — dead
moderator procedures are indistinguishable from live ones to the next reader, and they keep a Prisma
service on the main app's dependency graph long after the spoke owns the behaviour.

Work outward from the page, in this order, checking each layer before deleting it:

| Layer | Where |
| --- | --- |
| the page component + its moderator-only children | `src/pages/moderator/`, `src/components/` |
| tRPC procedures | `src/server/routers/*.router.ts` |
| controller handlers | `src/server/controllers/` |
| service functions | `src/server/services/*.service.ts` |
| zod schemas + moderator-only constants | `src/server/schema/`, `src/shared/constants/` |

A symbol is orphaned only if **nothing else** references it, and "nothing else" includes
`src/types/router.ts`, which references procedure *output types* and will not show up in a search for
call sites:

```bash
grep -rn "<symbol>" src/ --include=*.ts --include=*.tsx | grep -v "src/server/routers/"
grep -rn "<procedure>" src/types/router.ts
```

Real outcomes from earlier ports, both directions: `image.moderate` was **kept** (shared with
`NeedsReviewBadge`, `UnblockImage`, comics), while `resolveAppealSchema`'s **procedure** went and its
**service** stayed, because `handleUnblockImages` still calls `resolveEntityAppeal` — the layers do not
die together. The `src/types/router.ts` trap is real but has no live example: the review-queue
procedures the `/moderator/images` port kept for their output type have since been trimmed, so grep it
yourself rather than looking for one.

When a symbol is shared and you cannot cleanly cut it, leave it and record the follow-up trim in the
tracker entry. An over-eager delete breaks a page nobody was testing; an unrecorded one is never done.

`pnpm run typecheck` at the root is what proves the trim: if the main app still compiles with the page
and its procedures gone, nothing was reaching them.

## 6. Verify

In order. The first two are gates, not formalities.

1. **Parity coverage.** Re-read §1's inventory and §2's buckets against what you built. Every procedure,
   every child-component mutation, every side effect accounted for as ported, delegated, deferred or
   equivalent. *No review agent can see what you never wrote* — the three below compare the code to
   itself and to this app's conventions, so all three pass cleanly over a faithful implementation of half
   the page. That is exactly how the Retool path shipped a page that had passed three full review rounds
   with most of its capability unported. **You are the fidelity check on this path**; do it before the
   reviews, not after.
2. **Side-effect parity.** Open the checklist doc and either tick your page's effects or add rows with a
   severity for what you deferred.
3. **Look at the page.** Typecheck passes on plenty of pages that render blank.
4. **The three reviews** — run [`/svelte-review`](../svelte-review/SKILL.md), which fans out all three, or
   the agents individually:
   - `svelte-correctness-review` — logic, data shape, authorization scope, failure paths
   - `svelte-idiom-review` — Svelte 5 runes, async, forms, keys, and the shared UI conventions
   - `svelte-abstraction-review` — duplication, and what belongs in a shared service or `@civitai/mod-utils`

   Run them over **both halves of the change** — the new spoke page *and* the main-app trim. Every slice
   reviewed so far has come back with findings, several of the kind that make a moderator believe
   something false about a user. Fix them, then re-run what you touched.

   After fixing a non-trivial defect, `svelte-recurrence-sweep` finds the same shape elsewhere in the app
   — most of these pages were ported from the same source and inherit each other's mistakes.

```bash
pnpm --filter ./apps/moderator run typecheck   # during the work — read WARNING lines too
pnpm --filter ./apps/moderator run check       # ONCE, after the route tree changed
pnpm run typecheck                             # you touched src/ — the main app must still compile
```

`typecheck`, never `check`, in the edit→verify loop: `check` runs `svelte-kit sync`, which fights the
dev server's watcher. `build` is not a check — it catches nothing `svelte-check` doesn't and pays the
same cost. Read `state_referenced_locally` warnings; that one is a real stale-data bug.

Deleting a main-app page changes the main app's route tree, so run its typecheck and confirm nothing
imported the page module itself.

**One page, one session.** Commit at the end of it. The trackers exist so the next session does not need
this one's context.
