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

## 0. Check the scope and tracker first

[`CLICKUP-SCOPE.md`](CLICKUP-SCOPE.md) holds the content of the two ClickUp tickets that define this
work — what to build (868kkxqpn) and which tables to move (868kn67aq) — as checklists, so the work does
not depend on ClickUp access. Read it for *why*; read the tracker for *how far*.

[`MIGRATIONS.md`](MIGRATIONS.md) in this directory lists every app handed to us and how far each has got.
**Read it before starting** — a slice may already be shipped, blocked, or deliberately dropped.

Keep it current as part of the work:

- a new export arrives → add its row (status `not started`) before writing any code
- a slice ships and verifies → tick it
- something is skipped → record it with the reason

Do not tick a slice because the page renders — an app is not `done` until the Retool original is switched
off. Moderator-database slices *can* be ticked once they work: the app reads and writes that data live
(see below), so there is no data migration to wait for.

## The moderator database (`retool_db` in the exports)

User notes, strikes, timed mutes and image help requests live in a database of their own, never in
Civitai's. **The app reads and writes it through `getModeratorDb()`** — port these queries like any
other; there is no need to wait for a data migration.

```ts
import { getModeratorDb } from '$lib/server/moderator-db';

const notes = await getModeratorDb()
  .selectFrom('UserNotes')
  .select(['id', 'notes', 'lastUpdate', 'lastUpdateBy'])
  .where('userId', '=', userId)
  .orderBy('lastUpdate', 'desc')
  .execute();
```

It points at Retool's Postgres today, so **Retool and the moderator app are writing to the same tables
during the transition** — which is what makes an incremental cutover possible. Keep writes compatible
with what Retool expects to read back.

### Attribution: write the name, ids come later

`createdBy` / `lastUpdateBy` / `handledBy` are free text holding Retool *display names*, and only 5 of
37 map to a Civitai account. A name → userId table is being assembled separately.

Until it lands, **write `locals.user.username` into those columns** and do not invent an id column. New
rows are then at least resolvable (a Civitai username maps to an account trivially), while historical
rows wait for the mapping. Record in the slice's tracker entry that its writes use usernames, so the
backfill knows there are two naming schemes to reconcile.

Do not block a slice on this. Functionality first; attribution is a follow-up migration.

### Querying it directly

For scoping and schema questions, outside the app:

```bash
cp .env.example .env      # then fill in RETOOL_DATABASE_URL
node .claude/skills/retool-migration/retool-db.mjs --tables
node .claude/skills/retool-migration/retool-db.mjs --describe UserStrikes
node .claude/skills/retool-migration/retool-db.mjs "SELECT * FROM \"UserStrikes\" LIMIT 5"
```

**`retool-db.mjs` is read-only, not gated behind a flag** — writes are refused before the connection is
even opened. It exists for scoping and schema questions; the app itself goes through `getModeratorDb()`,
which does write.

## 1. Inventory the app

Committed inventories for the apps handed over so far live in
[`docs/moderator-app/retool-exports/`](../../../docs/moderator-app/retool-exports/) — read those first;
you may not need the raw export at all.

**Never commit a raw export.** `User Lookup v2.json` contains a hardcoded
`Authorization: Bearer <token>` header repeated seven times; the others may too. Keep exports outside
the repo (`~/Downloads/Retool/`) and commit the generated inventory instead — it carries the SQL and no
auth config.

```bash
node .claude/skills/retool-migration/extract.mjs "<export.json>"           # full inventory
node .claude/skills/retool-migration/extract.mjs "<export.json>" --queries # SQL only
node .claude/skills/retool-migration/extract.mjs "<export.json>" --json    # machine-readable
```

You get: query count, component count, backing resources, a component-type histogram (a scale
signal only — do not reproduce it), and every query with its SQL/URL plus the `{{ … }}` bindings
it depends on.

**The queries are most of the spec, but NOT all of it.** Read them first and work out what question
each answers; the page is whatever surfaces those answers well.

**The rest of the spec is in the widgets, and the extractor's job is to surface it — check that it
did.** A dropdown's options, a button's label, the JS that fires on selection: these encode workflows
that exist nowhere in the SQL. A moderator asked about a "Stripe Chargeback Retrieval" button that
appears in no query — it is one of five *presets* filling the `BuzzSend` form with a canned amount, type
and description. The same blind spot hid timed-mute duration presets (`6h/12h/24h/48h/72h/1 week`,
ported as a free-text box), a `Received Reviews` tab, and a `Bounties` tab.

If something a moderator describes is not in the inventory, **grep the raw export before concluding it
is not there**:

```bash
grep -io "chargeback[^\"]\{0,60\}" "<export.json>"      # find the label
grep -o '\\"_labels\\",\[[^]]*\]' "<export.json>"        # every option set in the app
```

Expect volume — real apps run 77–170 queries, and many are variants of one lookup, dead experiments,
or Retool plumbing (`State`, `Timer`). That does not license skipping them; it licenses *classifying*
them. See §2.

🔴 **A `Function` query is NOT plumbing — open every one.** This is where Retool keeps the lists that
have no table behind them, and the extractor renders it as a bare name with no SQL, which reads exactly
like glue. `TosReasons` (Bulk Image Manager **and** User Reports) is a `Function`, and it holds the
eleven canned TOS removal reasons, the **user-facing message** each one sends, and the flag
(`poi` / `minor` / `tag`) each one sets — a whole removal workflow, absent from the port until a
post-hoc review dug it out of the raw JSON. `BanReasons` in Bulk Ban is the same shape.

**A picker's options are a capability.** They come from three places and only one of them is in the
query list: a static `_labels` set on the widget, a `Function` like the above, or a query bound to the
widget. Port the source, not a hand-written subset of what you saw in a screenshot — a shortened list
silently removes choices a moderator relies on, and no review that reads only the code can see it.

🔴 **Read the widget's `data` expression; do NOT infer the binding from a plausibly-named query.**
User Lookup's buzz *Reason* is `{{buzzSendAction.value === 'send' ? SendTypes.value :
DeductTypes.value}}` — two `Function`s whose lists are **scoped by the sibling Action field** (send →
Reward/Refund; deduct → Purchase/Chargeback/AuthorizedPurchase). The export also contains a
`transactionTypes` query doing `SELECT DISTINCT type FROM buzzTransactions`, which binds to nothing.
A fix that assumed the obvious query was the source shipped all 28 ledger types in both directions and
made `deduct + Reward` selectable — a *different* wrong answer, and one that reads as thorough.
`--json` gives you `dataBindings` per widget; resolve every one to a body before believing it.

## 2. Classify every query before building — no partial ports

**An app is ONE slice: port all of it, then review it.** Not a panel at a time, not "the useful half".
Retool stays live until the port is whole, so a partial port is a moderator using two tools and
trusting whichever one they opened.

Before writing code, put **every** query into exactly one bucket:

| Bucket | Meaning |
| --- | --- |
| **port** | Real functionality. Build it. |
| **equivalent** | Covered by a different shape here — say which. Retool's twelve per-type COUNTs become one list. |
| **plumbing** | Retool-side glue with no server meaning: `State`, table grouping, `CurrentUTCTime`. |
| **superseded** | A v1 whose v2 is also present, or a duplicate. Name the winner. |
| **blocked** | Needs a key, a system, or a decision we do not have. Say exactly what unblocks it. |

Anything not in a bucket is unported by accident. Commit the classification next to the inventory —
see [`user-lookup-audit.md`](../../../docs/moderator-app/retool-exports/user-lookup-audit.md) for the
shape.

**Do not let a ticket's musing become a decision.** The User Lookup ticket said of add/subtract buzz
"maybe this should be a separate app". That went into the tracker as settled, and a capability
moderators use daily went unported for weeks. A ticket aside is an open question — ask, do not resolve
it silently in a doc.

**"Which queries are actually in use" is not answerable from the export.** Ask, but do not treat silence
as permission to drop one. Bucket it as `port` and build it.

## 3. Map Retool resources to ours

| Retool resource | Here |
| --- | --- |
| `Replicated_Read_Prod` | `dbRead` (`$lib/server/db`) |
| `Prod` (write) | `dbWrite` |
| `Clickhouse` | `$lib/server/clickhouse` |
| `retool_db` | `getModeratorDb()` (`$lib/server/moderator-db`) — a single read-write Kysely client over the **moderator database**. Points at Retool's own Postgres today, so the data is live; later it moves and only the connection string changes. Types: `ModeratorDB` in `moderator-db-types.ts`. |
| `REST-WithoutResource` → `/api/mod/*` | existing main-app mod endpoints, or a spoke service |
| `BuzzTemp` / buzz API | `$lib/server/buzz` |
| `Notifications DB` | `$lib/server/notifications` |

`{{ }}` bindings become real inputs: URL query params for filters, form fields for actions.
Never interpolate them into SQL — use Kysely's builder, or parameterised `sql` tags.

⚠️ **Read the resource AND the URL before deciding what a query is.** A Retool query is very often a
**REST call into the main app**, not a database write — the exports carry 13 distinct `/api/mod/*`
endpoints between them, including every destructive one (`ban-user`, `remove-images`,
`restore-images`, `remove-all-content`, `update-image-flag`, `action-report`,
`send-mod-notification`). Classifying by table name alone will file a main-app side effect as a local
write and lose everything the endpoint does around it — search-index sync, ClickHouse tracking,
notifications, cache busting.

### Look up the main app's endpoints BEFORE deciding something is unported

**Do this for every query that hits REST, and for every capability you are about to call missing.** The
main app already carries most of the privileged writes, and three times in one day a capability filed
as "a write surface we never built" turned out to be one call:

```bash
ls src/pages/api/mod/ src/pages/api/mod/retool/          # the whole mod surface
sed -n '1,40p' src/pages/api/mod/retool/user.ts          # the header comment lists every action
grep -rn "action:" src/pages/api/mod/retool/*.ts | head  # action names per resource
```

**Read the endpoint's zod schema, not its name.** It is the authoritative contract, and it is usually
richer than the Retool query that called it:

| Found this way | What it was filed as |
| --- | --- |
| `/api/mod/retool/user` → `updateIdentity` (username/email/name), `toggleModerator` | "the whole account-edit capability, a write surface we never built" |
| `/api/mod/remove-images` → `violationType` **enum** + `violationDetails` | free-text `reason`, so every removal logged unclassified |
| `/api/mod/update-image-flag` | Image Lookup "is read-only" — a comment that was simply wrong |

Two further things the schemas give you free:

- **`privileged:` markers are the per-capability permissions** the tickets ask for
  (`retoolUpdateIdentity`, `retoolToggleModerator`). Wire the action to them; do not invent a
  local role check for something the endpoint already gates.
- **An endpoint often accepts more than Retool sent.** `remove-images` takes `userId` *or* `imageIds`;
  Retool's `nukeUser` used the first and its bulk path the second. Reading only the query you were
  handed hides the other half.

When a Retool query looks nonsensical — a dangling binding, a hardcoded id, a `SELECT *` feeding a
button — **check whether the real work happens in an endpoint** before concluding the app did nothing.

The [`retool-endpoint-audit`](../../agents/retool-endpoint-audit.md) agent does this sweep mechanically;
run it at §6 as well, since the misses are easiest to see once the code exists.

Two blind spots in the export itself, both of which need a screenshot to close:

- **No event handlers.** Nothing records what a button, row or modal click actually triggered. A table
  labelled "click rows!" gives no hint in the export where the click went.
- **Frame-level widgets are not dumped.** A persistent header outside the main container appears in no
  pane, so an app can have a whole toolbar the `## layout` section never mentions.

## 4. Build the page

**Read [`apps/moderator/CLAUDE.md`](../../../apps/moderator/CLAUDE.md) first** — Svelte 5 idiom, shadcn
usage, styling tokens and component placement are defined there and apply to every page in the app,
whether it came from Retool or the main app. What follows is only the Retool-specific part. A
neighbouring route (`routes/reports`, `routes/blocklists`) is a good model.

- **Route**: `apps/moderator/src/routes/retool/<slug>/+page.server.ts` + `+page.svelte`
- **Data**: `load` calls a service in `$lib/server/<domain>.service.ts`; queries go through
  **Kysely's builder** by default (raw `sql` only for bitmask/index-match, PG functions,
  jsonb/LATERAL)
- **Mutations**: SvelteKit form actions → the same service layer, `use:enhance` on the client
- **Filters**: the URL query string is the source of truth — see
  `docs/moderator-app/url-filtering-pattern.md`
- **UI**: image grids reuse `ImageQueueGrid` (300px cards); everything else per the standard above.

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

**Coverage first — it is a gate, not a formality.** Re-read the §2 classification against what you
built and confirm every query is accounted for. The three review agents read the code you wrote; none
of them can see what you never wrote, so a missing capability passes every review cleanly. User Lookup
passed three full review rounds while 97 of its 170 queries were unported.

```bash
# every query name in the export
grep "^### " docs/moderator-app/retool-exports/<app>.md | sed 's/^### //' | awk '{print $1}' | sort
```

Diff that against your classification. Anything unaccounted for is a gap, not a judgement call.

**Keep Retool's shape — moderators navigate by layout, not by query.** The inventory's `## layout`
section lists every container, its panes and its modals. Read it before designing the page:

- **A container with several panes is a tab group. Port it as SUB-PAGES — one route per pane**
  (`[section]`/`[tab]`, as User Lookup and Chat Audit already do), not as one long scrolling page.
  A moderator who had "Submitted Reviews / Received Reviews" as two tabs and now scrolls past both
  reports the tool as broken, even when both queries are ported. Use our own styles and `@civitai/ui`
  primitives inside them — matching the shape is not matching the skin.
- **A modal is a dialog, not an inlined panel.**
- **`only visible when` on a pane is a role or state gate that appears in NO query.** User Lookup's
  "Buzz Transaction" pane is `current_user.groups.some(i => i.name === "Senior Mod")` — porting the
  pane without the gate hands every moderator a capability that was restricted to seniors.

Pane names also carry filter widgets (`"TOS Violation?"`, `"Review Rating"`, `"Search Review
Content"`). Those are entry points; a table you ported without its filter row is not the same tool.

**Being NAMED in the classification is not being COVERED, and this is the failure that survives every
other check.** Bulk Image Manager's audit named all 40 queries and still shipped four real gaps
(2026-08-08), because a row can absorb a query whose behaviour it does not carry:

- `UserQuery5000` was listed as covered by `resolveUserId`. It resolves an identifier to an id; the
  query's actual content was `WHERE i."nsfwLevel" = 32` — *the images already removed from this
  account*, i.e. the entire restore workflow. Absent from the build.
- `RemoveArrayOfImages`/`RestoreArrayOfImages` were mapped to `/api/mod/remove-images`. That names the
  **endpoint** and drops the **entry point** — a pasted list of image ids, which is how a ticket or a
  script hands work over. Absent from the build.
- `nukeUser` was mapped to `purgeAllContent`. It actually POSTs `remove-images` (images only), while
  `purgeAllContent` also takes models, posts, articles and comments — a *larger* blast radius under
  the same label.
- Columns selected by every finder (`prompt`, `poi`, `minor`) reached the DOM nowhere, so moderators
  set POI from a thumbnail with the prompt and the current flag state both invisible.

So for each query, read its **SQL body**, not its name: what does the WHERE filter, what columns does
it select, and where does its input come from? A query whose input is a widget you did not build is
not ported, whatever endpoint you mapped it to.

**Then run the [`svelte-review`](../svelte-review/SKILL.md) skill.** It
fans out three review agents — correctness, Svelte 5 + UI conventions, abstraction — over the segment.
Every slice reviewed so far has come back with findings, several of them the kind that make a moderator
believe something false about a user.

**Then run [`retool-endpoint-audit`](../../agents/retool-endpoint-audit.md).** It checks the slice
against the main app's API surface: a local write that duplicates an endpoint, a constant copied out of
the main app, an endpoint parameter the call never sends, or a capability filed as "unported" that is
already an endpoint action. It has caught all four shapes in one day — including a hardcoded vote
weight that was a second copy of the number deciding whether a tag gets disabled, and a removal path
that logged every deletion with an empty violation classification. Run it even when the slice looks
finished; the misses are easiest to see once the code exists.

**Then run a FIFTH review, export-vs-build.** The three code reviews compare the code to itself and to
this app's conventions, and the endpoint audit compares it to the main app's API — **none of them opens
the export**, so all four pass cleanly over a faithful implementation of the wrong thing. Give an agent the inventory (`<app>.md`, which carries each query's
SQL), the audit, and the built files, and ask one question: *walk the export query by query — is each
behaviour present, and does it match?* On Bulk Image Manager the three code reviews returned 14
findings and missed all four gaps above; the fidelity pass found them in one run. Verify its claims
against the inventory yourself before acting — it will also produce plausible-but-false ones (it called
`TOSImages` a dismissed mutation; the export says `//doesnt run anywhere, just a test`).

Then:

```bash
pnpm --filter ./apps/moderator run typecheck   # during the work — reads WARNINGs too
pnpm --filter ./apps/moderator run check       # ONCE, when the slice is done
npx prettier --check "<changed .ts files>"
npx eslint "<changed .ts files>"
```

**Do not run `build` as a check.** It is `svelte-kit sync && vite build` — the sync half writes ~690
files into the directory the dev server watches, and it catches nothing `svelte-check` doesn't.
**Read the WARNING lines**, not just ERROR: `state_referenced_locally` (`let x = $state(data.foo)`
capturing only the first value, so the page shows stale data after a navigation) is a real bug that
shows up there and nowhere else in the loop.

Typecheck and build are the real gates. If you touched anything under `src/` or `packages/`, run
the root `pnpm run typecheck` too.

**Use `typecheck`, NOT `check`, for the edit→verify loop.** They are not synonyms here: `check`
prefixes `svelte-kit sync`, which regenerates ~690 files under `.svelte-kit/` — a directory the Vite
dev server watches — so running it in a loop has Vite re-optimising the module graph while
`svelte-check` loads ~9,000 files. That collision froze a whole session's worth of work before it was
diagnosed. `typecheck` is `svelte-check` alone and writes nothing.

Reach for `check` **only** after changing the route tree — adding, removing or renaming a
`+page`/`+server`/`+layout` file — which is the only time the generated `$types` go stale. A migration
slice does that once, at the start. (`prepare` runs `sync` on install, so a fresh checkout is covered.)

**One slice, one session.** A slice is a whole Retool app — 10 to 170 queries, a dozen files, an audit
and three review reports. Commit at the end of it and start the next slice fresh rather than carrying
one conversation across several apps: the §2 classification and the coverage gate are written down in
the repo precisely so the next session doesn't need the previous one's context.

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
