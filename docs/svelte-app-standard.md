# SvelteKit app standard

The shared conventions for **every** SvelteKit app in this repo — `apps/moderator`, `apps/auth`,
`apps/creator-studio`. Each app's own `CLAUDE.md` points here and records only what genuinely differs.

The root [`CLAUDE.md`](../CLAUDE.md) describes the **main Next.js app** (Mantine, tRPC, Prisma). None of
that applies here: these are SvelteKit 5 + Kysely + shadcn-svelte + Tailwind v4.

Where an app does not yet follow something below, that is a gap to close when you next touch the file —
not a per-app exception. `apps/auth` predates most of this and is the usual case.

---

## Svelte 5

Runes only. No `export let`, no `$:`, no stores for component-local state.

```svelte
let { userId, form }: { userId: number; form: FormResult } = $props();
let expanded = $state(false);
const visible = $derived(expanded ? rows : rows.slice(0, 5));
```

### Async data: derive the promise, don't assign to state

The single most repeated bug in these apps. Fetching in `$effect` and assigning the result to `$state`
gives you a stuck spinner, a re-run loop, or a stale response landing on a newer lookup.

```svelte
<!-- Do -->
const signals = $derived(
  browser ? fetch(`/api/user-signals/${userId}`).then((r): Promise<Signals> => {
    if (!r.ok) throw new Error(String(r.status));
    return r.json();
  }) : null
);

{#await signals}
  <p class="text-sm text-dark-2">Checking…</p>
{:then result}
  …
{:catch}
  <p class="text-sm text-red-300">Could not load security signals.</p>
{/await}
```

A new `userId` produces a new promise and the template re-awaits it, so there is no state to go stale.
`browser` keeps SSR from issuing the request. **Every `{#await}` needs a `{:catch}`** — without one a
rejection is silent and the panel just never fills in.

To refetch after a write, bump a counter (`?v=${version}`) — it is part of the derived expression, so
the promise rebuilds. Don't reach for `invalidateAll()` when the data didn't come from `load`.

`$effect` is for **synchronising with something outside Svelte** (a subscription, an imperative API,
resetting a local mirror when a prop changes). It is not a data-fetching hook and it is not a computed
value. Use `untrack()` for a `$state` initialiser seeded from a prop.

### Keys are correctness, not a lint rule

`{#each rows as row (row.id)}` — an unkeyed or duplicate-keyed loop reuses the wrong DOM node, so a
row's action button ends up wired to a different row. If the natural key isn't unique, compose one from
the columns that make it unique:

```svelte
{#each accounts as acct (`${acct.userId}:${acct.ip}:${acct.type}`)}
```

Prefer selecting a real primary key in the query over composing one in the template.

### Forms

Server mutations are **form actions**, progressively enhanced with `use:enhance` — not `fetch` + JSON.

A custom `enhance` callback **replaces** the default handling, including `applyAction`. Call it, or
every `fail()` is discarded and a refused action looks exactly like a successful one:

```svelte
const afterAction = () => async ({ result }: { result: ActionResult }) => {
  await applyAction(result);
  if (result.type === 'success') { … }
};
```

When several panels on one page submit to the same route they share one `form` object, so tag each
failure with a scope and let each panel render only its own. **Every action failure must be visible
somewhere on the page.**

**Optimistic UI must revert on failure.** If a click dims a row or marks it handled before the server
answers, undo it when the result is not a success — otherwise the operator's own record of what they
did is wrong, and the item they skip is the one that failed.

### Other

- `{#key}` around anything holding local state that must reset when the subject changes — an open
  confirmation must not survive a search onto a different subject.
- Snippets (`{#snippet}`) over duplicated markup; children over slots.
- `onclick`, not `on:click`.

## UI components

**Use [`@civitai/ui`](../packages/civitai-ui/README.md) (shadcn-svelte) primitives.** ~45 are available —
check `packages/civitai-ui/src/lib/components/ui/` before hand-rolling anything, and add missing ones to
that package (`npx shadcn-svelte@latest add <name>`), never to an app.

```svelte
import { Button } from '@civitai/ui/components/ui/button/index.js';
import * as Dialog from '@civitai/ui/components/ui/dialog/index.js';
```

- **`Select`, not `NativeSelect`.** `native-select` exists in the package but is not the default — it
  doesn't take the theme and looks like a browser control next to everything else.
- Raw `<button>`/`<input>` only for genuinely unstyled affordances (an inline "revoke" link). Anything
  that reads as a control uses the primitive.
- No Mantine, no `clsx` — `cn` from `@civitai/ui/utils.js`.

## Styling

Tailwind v4, dark-only.

**Body and secondary text is `text-dark-2` (`#8c8fa3`).** `text-dark-3` (`#5c5f66`) is what the instinct
reaches for and it fails contrast against `bg-dark-6` — treat it as borders and disabled states only.
`text-dark-0` for primary values, `text-white` for headings.

Reuse the shapes already on the page rather than inventing spacing: panels are
`rounded-xl border border-dark-4 bg-dark-6 p-5`.

**Don't add `cursor-pointer` to a button.** Tailwind v4's preflight drops the pointer cursor from
`<button>`; `@civitai/ui`'s `theme.css` puts it back for every button, `[role="button"]` and `summary`
(and `not-allowed` when disabled). Per-element overrides just diverge from it.

## Component placement

- **Page-level components are siblings of `+page.svelte`**, in the route directory. This is the default.
- `$lib/components/` is for something used by **more than one route** — move it there when the second
  consumer appears, not in anticipation of one.
- Page-local helpers and types live in a sibling module too.
- A `+page.svelte` past ~150 lines, or holding more than one panel's worth of markup, wants splitting.

## Server

- `+page.server.ts` `load` for reads, form `actions` for writes; services in `$lib/server/`.
- Kysely builder first, raw `sql` only where the builder can't go (bitmask index matching, PG functions,
  jsonb/LATERAL, and tables the Prisma schema does not model).
- Slow or optional data (ClickHouse roll-ups, external HTTP) goes behind `/api/*` and is fetched by the
  panel, so it can't hold up the page's first paint. Everything cheap belongs in `load`.
- Validate every action input with zod. Scope every mutation by owner as well as id (`WHERE id = ? AND
  userId = ?`), and **treat 0 affected rows as a failure, not a success** — reporting success on zero
  writes an audit row for something that did not happen.
- **Gate an action on the same path the page is gated on.** A group node's grant is the union of its
  children, so gating on a parent silently widens who can act.

## Comments

Per the [root guide](../CLAUDE.md#comments), and more strictly here: a comment in these apps earns its
place only as a **breakage guard** — an invariant, a cast, an ordering requirement, a hazard a future
edit would otherwise walk into. No narration, no provenance, no "ported from X", no explaining your work
to a reviewer. Say that in the PR.

## Verifying

`typecheck`, never `check` — and `build` is not a check. Both run `svelte-kit sync`, which fights the
dev server's file watcher; see the root [`CLAUDE.md`](../CLAUDE.md) for the full rule and why. Read
`svelte-check`'s **WARNING** lines as well as its errors: `state_referenced_locally` is a real bug and
appears nowhere else.

## Reviews: run these before calling a segment done

Three agents, on the diff for the segment:

| Agent | Looks for |
| --- | --- |
| `svelte-correctness-review` | Logic, data shape, auth scope, failure paths |
| `svelte-idiom-review` | Svelte 5 idiom + the UI/styling conventions above |
| `svelte-abstraction-review` | Duplication, missing components, placement |

Each takes the app directory as its scope and reads that app's `CLAUDE.md` for local deltas.

A segment with unresolved findings is not done, and neither is one that only typechecks — **look at the
page**. Typecheck and build pass on plenty of pages that render blank.

**These three compare the code to itself.** They cannot see what you never wrote, so a missing capability
passes all three cleanly. When porting from somewhere (Retool, the main app), add a fourth pass that
compares the build against the *source* — that is the only one that catches an absent feature.
