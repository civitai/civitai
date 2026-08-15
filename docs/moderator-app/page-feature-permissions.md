# Feature permissions inside a page

Closes [`retool-parity-checklist.md` §12i](retool-parity-checklist.md#12i-permissions--sub-permissions-inside-a-page-1537519380148133980)
and the *Sub-permissions per app* entry in [`post-migration-backlog.md`](post-migration-backlog.md#permissions).

Page access answers *which pages a role can open*. It cannot answer *what a role may do once it is
there*, so every capability that needed a narrower gate was hand-rolled as `isSenior` — three times,
in three files, with a fourth (`updateIdentity`) never gated at all. This adds one layer below the
page grant and moves those gates onto it.

## Where this came from

Two recorded calls, both in the Civitai Discord's transcript channel:

- **2026-08-07** (`1535334993470033991`, 42:00–59:00) — Justin, Briant, Seb, Ellie. Briant described
  today's model (roles in the auth hub, page grants in the mod app), Seb and Ellie showed why page
  grants are too coarse, and Justin landed the shape: *"once you grant the page level, you can turn
  on and off specific features within that page."*
- **2026-08-14** (`1537865483989295196`) — Manuel, Justin, Seb, Ellie. Restated the same design and
  fixed the UI: a **tree** where a checked parent means everything under it is checked and a partial
  selection shows as mixed. Justin: *"it's beyond even just tabs — there could be things within a tab
  that are visible or not visible, or that you can't do."*

The named capabilities are Seb's (*"user lookup has the most of them — buzz transactions, activating
moderator for certain people, editing email and username"*) and Ellie's (*"the action for send or
remove buzz should be a me only"*, while buzz movement and balance stay visible to every moderator).

## Model

Every capability is declared once in `CAPABILITIES` (`$lib/capabilities.ts`) and stored as an
`AppPageAccess` row keyed `capability:<id>` — `capability:user.buzz.send`.

**The declarations are not server-only.** Components need the labels and the refusal wording too; while
they lived under `$lib/server/` the client re-typed them and drifted — a Bulk Ban banner went on saying
"restricted to senior moderators" after the gate became a grant any role could hold. `$lib/capabilities.ts`
is pure data over a literal and imports nothing back, so a component can use `denied(CAPABILITIES.x)`
without pulling in server code. `$lib/server/access.ts` re-exports it, so gates still read as one API.

**No schema migration.** `AppPageAccess` is already `(app, path) → roles[]`. A route path always starts
with `/`, so the `capability:` prefix cannot collide with one; capability grants are kept in their own
map anyway, and the prefix is the second line of defence rather than the first.

**The id is a stored value, and deliberately contains no path.** The first version keyed rows
`<pagePath>#<featureKey>`, which made the page's URL part of the grant's name: renaming a route
orphaned every capability under it and switched them off for everyone but admins, with no error and no
log. `/retool/*` exists only until Retool is retired, so that rename is a scheduled event and whoever
does it has no reason to suspect it touches access. Renaming an `id` now has the same effect — treat it
like a column name.

Access is **conjunctive**, per Justin's *"once you grant the page level"*:

```
canUse(user, cap)  =  isAdmin(user)
                   || ( canAccess(user, cap.path)
                        && cap.requires.every(p => canAccess(user, p))
                        && role ∈ featureRoles )
```

`requires` carries the extra pages an action needs — five of the six also need `/users`, the grant to
*act on* an account as opposed to reading one. It lives in the declaration rather than at the call
sites because when it lived at the call sites it immediately diverged: `/api/whoami` reported
`sendBuzz: true` for a role the action would refuse, on the endpoint whose entire purpose is settling
that question. `viewBankBuzz` declares `requires: []` explicitly — reading a ledger is investigation,
not enforcement — so the difference from its five siblings is visible instead of being an omission.

A role that loses any required page loses the capability. `/admin` locks the checkbox until the role
holds all of them, so the rule is visible rather than a surprise on save.

**An undeclared capability grants nothing.** Same rule as a page: what is not stored is not allowed, so
"granted to nobody" and "never configured" both fail closed.

### Defaults are declared, not migrated

Each capability carries `defaultRoles`. The first time the app loads grants and finds a declared
capability with **no row at all**, it writes that default — intersected with the roles that actually
hold the owning page, so it can never pre-arm a role that cannot reach it. A capability whose page is
ungranted seeds empty.

Once a row exists it is never touched again, whatever it contains. Row existence *is* the "somebody has
configured this" marker, so `/admin` is the authority from the first save onward and an empty row means
"deliberately nobody" rather than "not set up yet".

This exists because the alternative was a hand-applied SQL file per capability, on every environment,
whose failure mode was silent: miss one and moderators simply cannot act there — no error, no log, no
metric. It had already happened (prod ran without the first six for a day), and it recurred once per
capability forever. Adding a capability is now one declaration and nothing else.

The check costs one `in` test per capability per grants load, and only on a load that finds something
missing — after a deploy seeds them, it does no work. It runs on the cache-hit path too: returning
early there would leave a freshly deployed capability admin-only until the Redis entry expired, which
is the exact window the automation was meant to close.

Three properties it needs and has: it seeds from a **fresh Postgres read**, never the Redis snapshot,
because the row it writes is permanent and a stale snapshot would freeze a pre-revoke page grant into
it; a failed seed does **not** re-publish the unchanged map, since renewing the TTL on a stale entry
removes the expiry that is the last backstop for recovering it; and concurrent misses share one
in-flight promise, because the memo caches values rather than promises and every gated request would
otherwise issue its own INSERT during the unseeded window.

## The capabilities

| `id` | Shown under | What it gates | Our gate before | Retool's rule | `defaultRoles` |
|---|---|---|---|---|---|
| `user.identity.edit` | User Lookup | Edit email, username, display name | **none** — `/users` only | everyone (see note) | `senior` |
| `user.buzz.send` | User Lookup | Send or deduct Buzz | `isSenior` | `Senior Mod` group | `senior` |
| `user.buzz.bank` | User Lookup | See `type = 'bank'` rows in Buzz history | `isSenior` | admin + 2 names | `senior` |
| `user.moderator.toggle` | User Lookup | Activate / deactivate moderator | `isSenior` | admin + 1 name | `senior` |
| `user.cosmetics.grant` | User Lookup | Grant a cosmetic from the shop panel | **none** — `/users` only | admin + 1 name | **nobody** (admin-only) |
| `bulk-ban.execute` | Bulk Ban | Run a mass ban | `isSenior` | app-level restriction | `senior` |

The defaults follow these rules, applied in this order:

1. **A gate exists in our code** → seed the roles it already admits (`senior`). Zero behaviour change;
   a refactor of the gate, not a new one.
2. **No gate, and the team explicitly asked for one** → seed `senior`. Only `identity.edit`: Ellie on
   2026-08-07, *"other moderators do not have this ability"*, and §12i names it. This one **does**
   change behaviour, deliberately — it narrows, taking it from staff.
3. **No gate in our code, but Retool had one** → restore Retool's. Only `cosmetics.grant`, seeded to
   nobody, since Retool hid the badge-grant modal unless
   `current_user.groups.some(i => i.name === 'admin')` — the narrowest condition of the six — and
   admins bypass grants entirely. Our port gated it on `/users` alone, so staff can grant badges
   today; this is a widening being reverted, not a new restriction. If the team wants it wider, that
   is a tick on `/admin`.

> An earlier draft of this doc filed `cosmetics.grant` under *"nobody has decided"* and seeded it to
> every role. Retool **had** decided — the condition is on `modal2`, not in any query, which is the
> same place the other five hid. Check the export before concluding a capability was ungoverned.

> ⚠️ **Retool did not restrict identity editing**, though an earlier draft of this table said it did.
> `formButton1`'s condition ANDs the volunteer term with a *form-unchanged* term, so it could never
> hide the button from a Volunteer Mod — it hid it from **non**-volunteers while the form was clean.
> Almost certainly a Retool authoring bug. `senior` here rests on Ellie's 2026-08-07 request (rule 2),
> not on Retool, and "Retool allowed everyone but volunteers" is the wrong premise to widen from.

Buzz **movement, balance and bounties stay ungated** — Ellie asked for those to remain visible to
every moderator. Only the send/deduct action and the bank rows are restricted.

`buzz.bank` and `moderator.toggle` are seeded wider than Retool (senior, vs admin plus a hardcoded
name). Both widenings pre-date this change and are recorded where they were made; hardcoding names is
what left this app's moderator list stale in three other places.

## The `/admin` tree

Justin drew a tree; the page also has a role axis that predates it. Both survive as **one tree of
rows with a role checkbox per column**, rather than the previous three role cards each holding a
flat, padding-indented copy of the page list.

**The role columns come from the auth hub, not from this app.** `$lib/server/roles.ts` reads the hub's
`Role` table for ids prefixed `moderator:`, so a role created there gets a column here with nothing
granted, on the next page load and without a deploy. It was a constant in `access.ts` until 2026-08-14,
which meant `moderator:community-manager` was invisible on this screen for as long as it took someone
to notice and ship a matching line — with no error anywhere, since every other screen reads roles off
the session as opaque strings. The super role is filtered out (it bypasses grants entirely), and a
catalogue that does not contain the super role is treated as a failed read rather than "nothing to
grant" — empty, or against the wrong database or app prefix. The page 503s instead of rendering a blank
matrix. It could not actually *wipe* anything (a fully filtered matrix leaves the working copy equal to
the stored one, so Save is disabled), but it would state that nobody holds anything while the gate
carries on granting, which is worse on this screen than an error.

Column order is a display concern the hub cannot express — `Role` has no rank — so `roles.ts` sorts
known ids into ascending-trust order and appends unknown ones. That is ordering, never membership: a
role absent from the list still appears, just last. It exists because the matrix is read left to right
and a column's position is the only thing distinguishing one unlabelled checkbox from the next.

Two things deliberately do **not** consult that catalogue. The request-path gate (`applyGrants`) filters
stored roles against the super role alone — it runs on every gated request, and filtering against a
catalogue that failed to load would revoke the app; a grant naming a deleted role matches nobody anyway.
The `/admin` load and save do consult it, so a role retired in the hub stops being carried forward by
the next save.

A filter box narrows it, matching both labels and stored keys — so `buzz` finds the Buzz capabilities
and `capability:` finds all of them, which is what you have in hand when reading a grant row. Matching
keeps its ancestors so a hit never appears without the page and section that give it meaning.

**Filtering never changes an answer.** Every checkbox derives its state from the *unfiltered* node:
deriving from the filtered one made a page read "checked" while capabilities hidden by the search were
ungranted, which is the search quietly altering what the screen states. Section checkboxes lock while a
filter is active — their scope is every page underneath, and most of those are off screen — while page
and capability boxes stay editable, and edits made under one filter survive changing or clearing it.

> ⚠️ **An admin cannot test a permission change on their own account.** `isSuper` short-circuits every
> page and capability check, so an admin sees every nav entry and every action no matter what this
> screen says — including ones shown unticked. Verify with an account holding only the role in
> question, or with `/api/whoami?userId=…`, which reports the verdict per page and per capability. This
> is the first thing that confuses someone testing here, and it has cost time twice.

Justin's rule — *"if it's checked, it means that everything under it is checked; if you check just a
few things, then it's mixed"* — holds at every level:

- **Capability row** — nested under its page, collapsed by default, and locked until the role holds
  **every page the capability requires**, not just the one it sits under. Reasoning from the parent
  alone offered a tick that saved, rendered checked, and still refused, because the role was missing
  `/users`; the box now names what is missing. Shows the **effective** grant, so it never ticks for a
  role that cannot use it.
- **Page row** — tri-state. Checked when the role holds the page *and* every action in it, mixed when
  it holds the page but only some. A page with no actions is simply checked or not.
- **Group row** (`Retool`, `Images`) — tri-state over the pages under it, each of which has already
  folded in its own actions, so mixedness propagates all the way up.

**Granting adds the page only; revoking removes the page and its actions.** That asymmetry is
deliberate and it is the safety property:

- Revoking *has* to cascade — `canUse` requires the page, so an action left ticked under a page the
  role cannot open grants nothing while reading on screen as though it did.
- Granting *must not* cascade, or one click on "User Lookup" hands a volunteer the ability to send
  Buzz. Rolling actions into a section toggle would do the same from "Retool".

So a mixed row is completed by ticking the actions you want, not by clicking its parent. Clicking a
mixed row revokes.

### Every box is a function binding, not a one-way prop

`bind:checked={() => …, () => …}` rather than `checked={…}` + `onCheckedChange`. `checked` and
`indeterminate` are `$bindable` on the shadcn wrapper and the primitive writes to them on click; passed
one-way, that write is a **child-local override that Svelte discards only when the parent's expression
produces a different value than it last pushed**.

Tri-state is exactly the case where it doesn't. Ticking an ungranted page moves it `off → mixed`, so
`checked` is `false` before and after while the primitive has latched `true` locally — the box rendered
checked against an empty change set and a server that said otherwise, and survived a Revert. Binding
makes the component the single source of truth. The setters ignore their argument on purpose: the
primitive resolves a click on an indeterminate box to `true`, so the row's own state is the only
correct input.

Found by clicking the page, not by review or `svelte-check` — both were clean.

### The invariant is enforced at the write, not in the tree

`/admin`'s save action recomputes, for **every** declared capability, the roles it may hold given who
holds the pages it requires — and writes the difference. The tree's cascade is UX; this is the rule.

Two things make it load-bearing rather than decorative:

- It covers capabilities the submission never named. Narrowing a *page* has to trim the capabilities
  under it; a caller that names only the page would otherwise leave them armed for whoever gets that
  page next. A direct POST of `{"/retool/user-lookup": ["moderator:staff"]}` now trims three.
- It intersects against **all** required pages, matching `canUse`.

Without it a capability could sit granted under a page a role does not hold — inert, but **not stably
inert**: granting that page later activates it with no second decision. That is how a volunteer would
have picked up *Grant cosmetics* as a side effect of being handed User Lookup for an investigation.
`allowedCapabilityRoles` is the single definition; the seeding and the save both call it, so a third
writer finds it rather than inventing a fourth interpretation. A save that drops a submitted role says
so instead of reporting a plain success.

## Adding a capability

One entry in `CAPABILITIES`, and one `canUse()` call where the action is gated:

```ts
banUser: {
  id: 'user.ban',
  path: '/retool/user-lookup',
  label: 'Ban a user',
  requires: ['/users'],
  defaultRoles: ['moderator:senior'],
},
```

The `/admin` row, the storage key, the refusal wording, the `whoami` verdict and the initial grant all
follow. **No migration, no manual step on any environment.**

## Checklist

- [x] Capability layer in `access.ts` — `CAPABILITIES` (`id`, `requires`, `defaultRoles`), `canUse()`,
      separate `storedFeatures` map, `isGrantableFeature()`
- [x] `pageAccessState()` emits a tree (`AccessNode`) plus `paths` for the `whoami` diagnostic
- [x] `/admin` rewritten as the tri-state tree, with filtering
- [x] `isSenior` deleted; all six call sites moved to `canUse`
- [x] Capability ⊆ page enforced in the save action, not only in the tree
- [x] `+layout.server.ts` passes per-capability booleans instead of one `isSenior`
- [x] `whoami` reports capability verdicts alongside page verdicts, groups included
- [x] Refusal messages quote `CAPABILITIES[…].label`, so the wording matches the box to ask for
- [x] Reviewed — correctness, Svelte 5 idiom, abstraction (2026-08-14)
- [x] Exercised in a browser against live senior/staff sessions: tri-state at every level, the revoke
      cascade, SSR-populated matrix, a direct POST proving the write invariant, filtering, and the
      auto-seed writing six rows on a deploy with nobody running SQL
- [ ] Someone decides whether `user.cosmetics.grant` should be wider than admin-only (Retool's rule,
      restored). Staff can grant badges today; the default takes that away.
- [ ] Ellie confirms whether **payouts** should stay visible to every moderator (2026-08-14, 3:51 —
      *"I'm not sure about payouts"*). Ungated today; left alone pending her answer.
- [ ] The rest of the Admin section — ban, purge, force-logout, rewards eligibility, Paddle
      re-linking, restriction rulings — is still on `/users` alone. §12i asked for "the entire Admin
      section"; only `user.moderator.toggle` was carved out. Needs a decision on who should hold each.

## There is no migration

Deliberately. Every environment reaches the right state on its own: the app writes each capability's
declared default the first time it finds the row missing, narrowed to the roles already holding the
page. Deploying is the whole rollout.

An earlier draft of this work shipped a hand-applied seed, and that is what motivated the change — see
*Defaults are declared, not migrated* above. Both files were deleted before merge rather than kept as
history, because a migration writing the pre-rename `<pagePath>#<key>` keys would be actively wrong for
anyone who ran it later.

**One leftover, on dev only.** The machine that ran the deleted seed still has rows under the old keys.
They are inert — the app ignores keys it cannot resolve — so this is tidiness, not correctness:

```sql
DELETE FROM "AppPageAccess" WHERE app = 'moderator' AND path LIKE '%#%';
```
