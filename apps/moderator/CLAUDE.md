# Moderator app — feature standard

Everything in `apps/moderator` arrives by migration: from Retool (see the
[`retool-migration`](../../.claude/skills/retool-migration/SKILL.md) skill) or from the main Next.js app
(see [`page-migration-checklist.md`](../../docs/moderator-app/page-migration-checklist.md)). Different
sources, one destination — this file is what makes the destination consistent.

The root [`CLAUDE.md`](../../CLAUDE.md) describes the **main app** (Next.js, Mantine, tRPC, Prisma).
None of that applies here. This app is SvelteKit 5 + Kysely + shadcn-svelte + Tailwind v4.

**Before finishing any migration segment, run the three review agents** — see
[Reviews](#reviews-run-these-before-calling-a-segment-done) at the bottom.

---

## Svelte 5

Runes only. No `export let`, no `$:`, no stores for component-local state.

```svelte
let { userId, form }: { userId: number; form: FormResult } = $props();
let expanded = $state(false);
const visible = $derived(expanded ? rows : rows.slice(0, 5));
```

### Async data: derive the promise, don't assign to state

The single most repeated bug in this app. Fetching in `$effect` and assigning the result to `$state`
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
resetting a local mirror when a prop changes). It is not a data-fetching hook and it is not a
computed value. Use `untrack()` for a `$state` initialiser seeded from a prop.

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
failure with a scope and let each panel render only its own (`user-lookup/format.ts` has the pattern).
**Every action failure must be visible somewhere on the page.**

### Other

- `{#key}` around anything holding local state that must reset when the subject changes — an open ban
  confirmation must not survive a search onto a different account.
- Snippets (`{#snippet}`) over duplicated markup; children over slots.
- `onclick`, not `on:click`.

## UI components

**Use [`@civitai/ui`](../../packages/civitai-ui/README.md) (shadcn-svelte) primitives.** ~45 are
available — check `packages/civitai-ui/src/lib/components/ui/` before hand-rolling anything, and add
missing ones to that package (`npx shadcn-svelte@latest add <name>`), never to an app.

```svelte
import { Button } from '@civitai/ui/components/ui/button/index.js';
import * as Dialog from '@civitai/ui/components/ui/dialog/index.js';
```

- **`Select`, not `NativeSelect`.** `native-select` exists in the package but is not our default — it
  doesn't take the theme and looks like a browser control next to everything else.
- Raw `<button>`/`<input>` only for genuinely unstyled affordances (an inline "revoke" link). Anything
  that reads as a control uses the primitive.
- No Mantine, no `clsx` — `cn` from `@civitai/ui/utils.js`.

## Styling

Tailwind v4, dark-only.

**Body and secondary text is `text-dark-2` (`#8c8fa3`).** `text-dark-3` (`#5c5f66`) is what the
instinct reaches for and it fails contrast against `bg-dark-6` — treat it as borders and disabled
states only. `text-dark-0` for primary values, `text-white` for headings.

Reuse the shapes already on the page rather than inventing spacing: panels are
`rounded-xl border border-dark-4 bg-dark-6 p-5`, links are `LINK_CLASS`.

**Don't add `cursor-pointer` to a button.** Tailwind v4's preflight drops the pointer cursor from
`<button>`; `@civitai/ui`'s `theme.css` puts it back for every button, `[role="button"]` and `summary`
(and `not-allowed` when disabled). Per-element overrides just diverge from it.

## Component placement

- **Page-level components are siblings of `+page.svelte`**, in the route directory
  (`routes/retool/user-lookup/ReportsPanel.svelte`). This is the default.
- `$lib/components/` is for something used by **more than one route** — move it there when the second
  consumer appears, not in anticipation of one.
- Page-local helpers and types live in a sibling module too (`user-lookup/format.ts`).
- A `+page.svelte` past ~150 lines, or holding more than one panel's worth of markup, wants splitting.

## Server

- `+page.server.ts` `load` for reads, form `actions` for writes; services in `$lib/server/`.
- Kysely builder first, raw `sql` only where the builder can't go (bitmask index matching, PG
  functions, jsonb/LATERAL).
- Slow or optional data (ClickHouse roll-ups, external HTTP) goes behind `/api/*` and is fetched by the
  panel, so it can't hold up the page's first paint. Everything cheap belongs in `load`.
- Route access is gated centrally in `hooks.server.ts`; register the page rather than checking per-page.
  A *page-level* permission and an *action-level* permission are different things — reaching User
  Lookup is an investigation permission, banning from it is not.
- Validate every action input with zod. Scope every mutation by owner as well as id (`WHERE id = ?
  AND userId = ?`), and treat 0 affected rows as a failure, not a success.

## Comments

Per the [root guide](../../CLAUDE.md#comments), and more strictly here: a comment in this app earns its
place only as a **breakage guard** — an invariant, a cast, an ordering requirement, a hazard that a
future edit would otherwise walk into. No narration, no provenance, no "ported from X", no explaining
your work to a reviewer. Say that in the PR.

---

## Reviews: run these before calling a segment done

Three agents, run **in parallel**, on the diff for the segment:

| Agent | Looks for |
| --- | --- |
| [`moderator-correctness-review`](../../.claude/agents/moderator-correctness-review.md) | Logic, data shape, auth scope, failure paths |
| [`moderator-svelte-review`](../../.claude/agents/moderator-svelte-review.md) | Svelte 5 idiom + the UI/styling conventions above |
| [`moderator-abstraction-review`](../../.claude/agents/moderator-abstraction-review.md) | Duplication, missing components, placement |

Or invoke the [`moderator-review`](../../.claude/skills/moderator-review/SKILL.md) skill, which fans out
all three and consolidates.

Fix what they find, then `pnpm run check` in `apps/moderator` — once, at the end. A segment with
unresolved findings is not done, and neither is one that only typechecks — **look at the page**.

`build` is not a check: it is `svelte-kit sync && vite build`, and it catches nothing `svelte-check`
doesn't. Read `svelte-check`'s WARNING lines as well as its errors — `state_referenced_locally` is a
real bug (stale UI after a navigation) and it only appears there.

### `typecheck` vs `check`

`typecheck` is `svelte-check` alone and **writes nothing**. `check` prefixes it with `svelte-kit sync`,
which regenerates ~690 files under `.svelte-kit/` — a directory the dev server watches, so running it
in a loop with `vite dev` up makes both fight. Do not "fix" `typecheck` by adding `sync` back to it.

Use `typecheck` for the edit→verify loop. Use `check` after changing the **route tree** (adding,
removing or renaming a `+page`/`+server` file), which is the only time the generated `$types` go stale.
`prepare` runs `sync` on install, so a fresh checkout is already covered.
