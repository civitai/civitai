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

Every capability is declared once in `CAPABILITIES` (`access.ts`) and stored as an `AppPageAccess` row
keyed `capability:<id>` — `capability:user.buzz.send`.

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

A role that loses the page loses every feature on it, and a feature ticked for a role that cannot
open the page grants nothing. The `/admin` tree disables a feature checkbox until its page is
granted, so the rule is visible rather than a surprise on save.

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

## The capabilities

| `id` | Shown under | What it gates | Our gate before | Retool's rule | `defaultRoles` |
|---|---|---|---|---|---|
| `user.identity.edit` | User Lookup | Edit email, username, display name | **none** — `/users` only | `!includes('Volunteer Mod')` | `senior` |
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

Buzz **movement, balance and bounties stay ungated** — Ellie asked for those to remain visible to
every moderator. Only the send/deduct action and the bank rows are restricted.

`buzz.bank` and `moderator.toggle` are seeded wider than Retool (senior, vs admin plus a hardcoded
name). Both widenings pre-date this change and are recorded where they were made; hardcoding names is
what left this app's moderator list stale in three other places.

## The `/admin` tree

Justin drew a tree; the page also has a role axis that predates it. Both survive as **one tree of
rows with a role checkbox per column**, rather than the previous three role cards each holding a
flat, padding-indented copy of the page list.

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

- **Feature row** — nested under its page, collapsed by default, disabled until that page is granted
  to the same role. Shows the **effective** grant, not the stored one: unchecked whenever the role
  lacks the page, since `canUse` requires both. Rendering the stored value would put a tick on a
  capability nobody holds.
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

`/admin`'s save action intersects each feature's roles with the roles holding its page, and drops the
rest. The tree's cascade is UX; this is the rule.

Without it, a feature could sit granted under a page a role does not hold — inert, but **not stably
inert**: granting that page later activates it with no second decision. That is how a volunteer would
have picked up *Grant cosmetics* as a side effect of being handed User Lookup for an investigation.
The default-seeding described above intersects for the same reason.

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
