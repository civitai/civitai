# Action permissions

Closes [`retool-parity-checklist.md` §12i](retool-parity-checklist.md#12i-permissions--sub-permissions-inside-a-page-1537519380148133980)
and the *Sub-permissions per app* entry in [`post-migration-backlog.md`](post-migration-backlog.md#permissions).

Page access answers *which pages a role can open*. It cannot answer *what a role may do*, so every
action needing a narrower gate was hand-rolled as `isSenior` — three times, in three files, with a
fourth (`updateIdentity`) never gated at all. This is the layer those gates moved onto.

> **Renamed and reshaped 2026-08-19.** This file previously described "capabilities", each declared
> against a page. That coupling caused a live outage of four moderator abilities — see
> [What this replaced](#what-this-replaced-and-why) at the bottom, which is the part worth reading
> before changing anything here.

## Where this came from

Two recorded calls, both in the Civitai Discord's transcript channel:

- **2026-08-07** (`1535334993470033991`, 42:00–59:00) — Justin, Briant, Seb, Ellie. Briant described
  the model at the time (roles in the auth hub, page grants in the mod app), Seb and Ellie showed why
  page grants are too coarse, and Justin landed the shape: *"once you grant the page level, you can turn
  on and off specific features within that page."*
- **2026-08-14** (`1537865483989295196`) — Manuel, Justin, Seb, Ellie. Restated the design and fixed the
  UI. Justin: *"it's beyond even just tabs — there could be things within a tab that are visible or not
  visible, or that you can't do."*

The named actions are Seb's (*"user lookup has the most of them — buzz transactions, activating
moderator for certain people, editing email and username"*) and Ellie's (*"the action for send or remove
buzz should be a me only"*, while buzz movement and balance stay visible to every moderator).

Note what the calls asked for and what they did **not**: "turn features on and off within a page" is a
statement about the `/admin` screen's shape, not about a permission depending on a page grant. The first
implementation read it as the latter.

## Model

**Two independent axes.** They are composed where an action runs, never in the declaration.

| | Page grant | Action grant |
| --- | --- | --- |
| Answers | what a role may **open** | what a role may **do** |
| Declared in | `NAVIGATION` (`$lib/server/access.ts`) | `PERMISSIONS` (`$lib/permissions.ts`) |
| Stored as | `AppPageAccess` row keyed by route path | `AppPageAccess` row keyed `grant:<id>` |
| Enforced in | `hooks.server.ts`, centrally, before any handler | at the action, against `locals.grants` |
| Granted on | `/admin`, first table | `/admin`, second table |

A permission is declared as `{ id, label }` and nothing else. **It names no page**, needs none, and one
can be used from several.

```ts
export const PERMISSIONS = [
  { id: 'user.buzz.send', label: 'Send or deduct Buzz' },
  …
] as const;
```

The dotted `id` is the only name a permission has — the same literal in the grant row, on the `/admin`
checkbox and at every call site, so one grep answers "who holds this, and does this user have it".

**Resolution.** `hooks.server.ts` builds `locals.grants` once per request, immediately after
`applyGrants` — before that the store is empty and everyone resolves to `{}`. It is handed to the client
by the root layout, so both sides read one answer instead of the layout deriving booleans of its own.
The super role is materialised rather than short-circuited, so an admin's record contains every
permission and the UI shows what the server would actually allow.

```ts
// a form action: the permission is part of the signature, not a line to remember
sendBuzz: requiresGrant('user.buzz.send', async ({ request, locals }) => { … })

// anywhere else
if (!locals.grants['user.buzz.send']) return buzzFail(denied('user.buzz.send'));   // server
{#if data.grants['user.buzz.send']}                                                // client
```

Only granted permissions are present. An absent key is not held — which is also what an unloaded grant
store looks like, so both read false and the gate fails closed. A mistyped id does not compile.

**No defaults.** A new permission is held by nobody until someone ticks it on `/admin`, exactly like a
new page. `denied(id)` produces the refusal text from the same `label` the checkbox shows, so a
moderator reading a refusal can find the box to ask for.

## The permissions

| `id` | What it gates | Our gate before | Retool's rule |
| --- | --- | --- | --- |
| `user.identity.edit` | Edit email, username, display name | **none** — `/users` only | everyone (an authoring bug; grants nothing) |
| `user.buzz.send` | Send or deduct Buzz | `isSenior` | `Senior Mod` group |
| `user.buzz.bank` | See `type = 'bank'` rows in Buzz history | `isSenior` | admin + 2 names |
| `user.moderator.toggle` | Activate / deactivate moderator | `isSenior` | admin + 1 name |
| `user.cosmetics.grant` | Grant a cosmetic from the shop panel | **none** — `/users` only | admin + 1 name |
| `bulk-ban.execute` | Run a mass ban | `isSenior` | app-level restriction |
| `audit.ban.execute` | Ban an account from an audit queue | — | — |
| `csam.report.file` | File a CSAM report | — | — |

Who holds each is whatever `/admin` says; this table records what each gates and what Retool did, which
is the context for deciding, not the current state.

## Adding one

One entry in `PERMISSIONS`, and one gate where the action runs. That is the whole job — the `/admin`
row, the storage key and the refusal wording all derive from the entry, and there is no migration.

## `/admin`

Two tables, pages and actions, filtered together and saved together. A page's box grants the page and
nothing else; revoking a page does not touch any action, because an action does not depend on one.

Every box is a **function binding**, never a one-way prop: shadcn's `Checkbox` declares `checked` as
`$bindable` and the primitive writes to it, so a one-way prop latches whenever a click leaves the
parent's value unchanged.

## What this replaced, and why

The first implementation gave each permission a `path` (the page it was shown under) and a `requires`
list (other pages it needed), and the check demanded **all** of them plus the role grant. It also
carried `defaultRoles`, seeded on first load and intersected with the roles already holding those
pages, so a default could never pre-arm anyone.

`/users` was declared in `NAVIGATION` but never built past a "Not built yet" placeholder (it still is
one; the 2026-08-24 newest-accounts list is its sibling `/users/newest`), so nobody
held it. Every consequence followed from that:

- Five permissions seeded to `[]` — the intersection with a page nobody held is empty.
- A row that exists is never re-seeded, so they stayed empty permanently.
- Ticking them on `/admin` did not stick: a subset rule re-trimmed every permission to the roles holding
  its required pages on **every** save.
- `canUse` re-checked the page at request time anyway, so even a correct grant would not have helped.
- Admins bypass all of it, so it worked for whoever checked.

Net: identity editing, the moderator toggle, Buzz send/deduct and mass ban were **off for every
non-admin**, nothing reported it, and the one permission declared `requires: []` — `user.buzz.bank` —
was the only one that worked. That is as clean a natural experiment as the codebase is likely to
produce.

Removed with the coupling: `path`, `requires`, `defaultRoles`, the seeding, the subset trimming, the
`/admin` revoke cascade, and `canUse`. **Which pages exist is not a permissions question**, and an
action already sits behind its route's own gate — the hook runs before any handler, so re-asking in the
permission only made a permission inexpressible on more than one page.

The storage prefix moved `capability:` → `grant:` at the same time. Ids are stored values, so the six
existing rows were repointed by hand; an un-repointed row is not revoked, it simply stops being found.

## Open decisions

- [ ] Whether `user.cosmetics.grant` should be wider than admin-only. Retool restricted it to admin +
      one person; staff could grant badges under our port.
- [ ] Whether **payouts** stay visible to every moderator (2026-08-14, 3:51 — *"I'm not sure about
      payouts"*). Ungated today.
- [ ] The rest of the Admin section — ban, purge, force-logout, rewards eligibility,
      restriction rulings — is still on `/users` alone. §12i asked for "the entire Admin section"; only
      `user.moderator.toggle` was carved out. Needs a decision on who should hold each.
