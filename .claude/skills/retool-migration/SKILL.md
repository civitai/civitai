---
name: retool-migration
description: Port a Retool app's functionality into a page in apps/moderator. Use when given a Retool JSON export (or asked to migrate/replace a Retool moderation tool) and a page needs to be built in the moderator app. Decodes the export, inventories its queries, and builds the page with shadcn + Tailwind under the Retool nav group.
---

# Retool → moderator app migration

Ports what a Retool app **does** into `apps/moderator`. Retool's layout, styling and component
tree are **not** ported — the JSON is a spec for behaviour, not a design.

## Setup (once per checkout)

```bash
cd .claude/skills/retool-migration && npm install
```

The export is not plain JSON: `page.data.appState` is a **transit-js** encoded string (`~#iR`
tag, `["^ ", k, v, …]` maps, `^N` back-references). `JSON.parse` alone gets you an opaque blob.
`extract.mjs` handles it; don't try to read the raw file.

## 0. Check the tracker first

[`MIGRATIONS.md`](MIGRATIONS.md) in this directory lists every app handed to us and how far each has got.
**Read it before starting** — a slice may already be shipped, blocked, or deliberately dropped.

Keep it current as part of the work:

- a new export arrives → add its row (status `not started`) before writing any code
- a slice ships and verifies → tick it
- something is skipped → record it with the reason

Do not tick a slice because the page renders. `retool_db`-backed slices stay unticked until the data has
actually moved, and an app is not `done` until the Retool original is switched off.

## 1. Inventory the app

```bash
node .claude/skills/retool-migration/extract.mjs "<export.json>"           # full inventory
node .claude/skills/retool-migration/extract.mjs "<export.json>" --queries # SQL only
node .claude/skills/retool-migration/extract.mjs "<export.json>" --json    # machine-readable
```

You get: query count, component count, backing resources, a component-type histogram (a scale
signal only — do not reproduce it), and every query with its SQL/URL plus the `{{ … }}` bindings
it depends on.

**The queries are the spec.** Components mostly render query output. Read the queries first and
work out what question each answers; the page is whatever surfaces those answers well.

Expect volume — real apps run 77–170 queries. Do not port them one-for-one. Many are variants of
the same lookup, dead experiments, or Retool plumbing (`Function`, `State`).

## 2. Agree the scope before building

These apps are far too large to port in one page. Decide with the user:

- which queries are actually in use (ask — the export cannot tell you)
- what the smallest useful slice is
- what stays in Retool for now

Then say what you are leaving out. A half-built page presented as complete is worse than a
narrow one presented honestly.

## 3. Map Retool resources to ours

| Retool resource | Here |
| --- | --- |
| `Replicated_Read_Prod` | `dbRead` (`$lib/server/db`) |
| `Prod` (write) | `dbWrite` |
| `Clickhouse` | `$lib/server/clickhouse` |
| `retool_db` | **no equivalent** — Retool's own Postgres, holds mod notes/strikes/timed mutes. Needs a data migration, not a port. Flag it. |
| `REST-WithoutResource` → `/api/mod/*` | existing main-app mod endpoints, or a spoke service |
| `BuzzTemp` / buzz API | `$lib/server/buzz` |
| `Notifications DB` | `$lib/server/notifications` |

`{{ }}` bindings become real inputs: URL query params for filters, form fields for actions.
Never interpolate them into SQL — use Kysely's builder, or parameterised `sql` tags.

## 4. Build the page

Follow the app's existing conventions (read a neighbouring route first — `routes/reports` and
`routes/blocklists` are good models).

- **Route**: `apps/moderator/src/routes/retool/<slug>/+page.server.ts` + `+page.svelte`
- **Data**: `load` calls a service in `$lib/server/<domain>.service.ts`; queries go through
  **Kysely's builder** by default (raw `sql` only for bitmask/index-match, PG functions,
  jsonb/LATERAL)
- **Mutations**: SvelteKit form actions → the same service layer, `use:enhance` on the client
- **Filters**: the URL query string is the source of truth — see
  `docs/moderator-app/url-filtering-pattern.md`
- **UI**: shadcn from `@civitai/ui/components/ui/*` + Tailwind. No bespoke components where a
  shadcn one exists. Image grids reuse `ImageQueueGrid` (300px cards).
- **Comments**: only breakage guards. The moderator app's rule is stricter than the repo's.

## 5. Register it in the nav — and grant access

Add the entry to `NAVIGATION` in `apps/moderator/src/lib/server/access.ts`, under the Retool
group:

```ts
{
  label: 'Retool',
  path: '/retool',
  children: [{ path: '/retool/<slug>', label: '<Name>' }],
},
```

Two things that will otherwise bite you:

- **A page not in `NAVIGATION` is unreachable.** `canAccess` denies unmatched paths for everyone,
  admins included.
- **Access is grant-based, not tiered.** A new page has no rows in `AppPageAccess`, so only
  `moderator:admin` reaches it until someone ticks boxes on `/admin`. That is correct
  behaviour — tell the user the page needs granting rather than leaving them to discover it.
- Section entries (links with `children`) are **not** grantable; a section is reachable when any
  page inside it is.

## 6. Verify

```bash
pnpm --filter ./apps/moderator run typecheck
pnpm --filter ./apps/moderator run build
npx prettier --check "<changed .ts files>"
npx eslint "<changed .ts files>"
```

Typecheck and build are the real gates. If you touched anything under `src/` or `packages/`, run
the root `pnpm run typecheck` too.

## 7. Feedback loop

Moderators report bugs and request features in the **Mod Studio Feedback** Discord group chat —
channel `1534637921829912777`.

```bash
QB=~/.claude/skills/discord-bridge/query.mjs
node $QB messages 1534637921829912777          # recent feedback
node $QB search "retool" --guild <guildId>     # older context
```

Check it **before** starting a page (someone may have already described what they need) and
**after** shipping one. It carries screenshots, real SQL moderators want surfaced, and bug
reports against pages already live.

Do not post to it unless the user asks. Reading is passive; posting is visible to the whole mod
team.

## Gotchas

- **Exports are stale the moment they're taken.** The live Retool app may have moved on. When
  behaviour looks odd, ask rather than reverse-engineering intent from SQL.
- **`{{ }}` can contain arbitrary JS** (`select1.data.find(i => i.id === select1.value)`), not
  just field references. Read them as data-flow hints, not as expressions to translate literally.
- **Retool queries often hit the read replica.** Keep it that way — use `dbRead` for
  investigation screens so they never load the primary.
- **Some queries are already ported.** Check `NAVIGATION` and `docs/moderator-app/` before
  building; images, articles, blocklists, audit and cosmetics have moved already.
- Query IDs in the export (`GetHelpers`, `GetImageData`) are the names moderators use verbally.
  Keeping them in service function names makes conversations easier to follow.
