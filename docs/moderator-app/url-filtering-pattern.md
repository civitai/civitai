# Moderator pages — URL-driven filtering pattern

Established in the **reports** page and meant to be reused on the other filter-heavy moderator queues
(images, models, image-tags, downleveled-review, etc.). Reference implementation:

- Load + canonical redirect + actions → [`apps/moderator/src/routes/reports/+page.server.ts`](../../apps/moderator/src/routes/reports/+page.server.ts)
- UI (Tabs / MultiCombobox / Pagination / Input) → [`apps/moderator/src/routes/reports/+page.svelte`](../../apps/moderator/src/routes/reports/+page.svelte)
- Tag multi-select → [`packages/civitai-ui/…/multi-combobox`](../../packages/civitai-ui/src/lib/components/ui/multi-combobox/)

## Principles

- **The query string is the single source of truth** for filter + pagination state — shareable, back-button friendly, SSR-consistent. No filter state in component `$state`.
- The server `load` parses `url.searchParams` → calls the Kysely service → returns the data **plus the effective filter values** (defaults applied) so the UI can reflect/highlight what's active.
- Filter changes **navigate** via `goto()` (re-runs `load`). The root layout shows a top loading bar off `navigating` — no per-page spinner needed.
- **Every filter change resets `page` to 1.**

> **Auth — gated globally, not per-page.** Role-tier access is enforced once in `hooks.server.ts`
> (`canAccess(user, event.route.id)`), which runs for every load, action, and endpoint. Don't call
> `requireAccess` per-page; just register the page's path + tier in `ROLE_HIERARCHY` (access.ts).

## Parsing params (zod + `parseQuery`)

`load` parses `url.searchParams` through a per-page zod schema via the shared
[`parseQuery`](../../apps/moderator/src/lib/server/query.ts) helper:

```ts
const querySchema = z.object({
  page: z.coerce.number().int().min(1).catch(1),
  status: z.enum(['Pending', 'Actioned', 'Unactioned']).catch('Pending'),
  type: z.array(z.enum(CosmeticType)).catch([]), // multi-value
});
const { page, status, type } = parseQuery(url, querySchema, ['type']); // 3rd arg = repeated keys
```

- **Every field gets `.catch(default)`** (or `.optional().catch(undefined)`). Query params are
  user-controllable, so `?page=abc` must degrade to the default, not throw a 500 — with a catch on each
  field `parseQuery` never rejects.
- `z.coerce.number()` for numbers, `z.enum(...)` for single/multi enums, `z.string().trim()` for text.
- **Multi-value keys** must be passed in `parseQuery`'s 3rd arg so they're read via `getAll` — a plain
  `Object.fromEntries(searchParams)` would drop all but the last value.

**Exception — the present-but-empty sentinel.** zod can't tell an *absent* param from a
*present-but-empty* one (`getAll` → `[]` vs `['']`), and reports needs that distinction (see below). So
**reports keeps manual `has()` parsing** + its canonical-defaults redirect. Pages whose default *is* "no
filter" (articles, cosmetics, …) don't need the sentinel and use the zod schema directly.

## The three filter kinds

| Kind | Control | Applies via |
|---|---|---|
| Single-select (e.g. entity type) | `Tabs` | `onValueChange={(v) => v && goto(urlWith({ key: v, page: 1 }))}` |
| Multi-select | `MultiCombobox` (tag input) | `onValueChange={(vals) => applyMulti('key', vals)}` |
| Text | `Input` in a `<form>` | submit handler reads `FormData` → `goto(urlWith({ key: value \|\| null, page: 1 }))` |

Pagination uses the `Pagination` component with `onPageChange={(p) => goto(urlWith({ page: p }))}`.

## Multi-value filter semantics (the important part)

Multi-valued filters use a **repeated param** (`?status=A&status=B`) and a three-state model:

| URL | Meaning |
|---|---|
| param **absent** | apply the **default** set |
| `?status=` **present-but-empty** | **explicit clear → all** (no filter) |
| `?status=A&status=B` | exactly those |

The trick is distinguishing "cleared" from "initial default" — both would otherwise look empty. Use
**`url.searchParams.has(key)`** (not `.getAll(key).length`):

```ts
const urlStatuses = url.searchParams.getAll('status').filter(isStatus);
// absent → default; present (even empty) → use the URL values (may be [] = all)
const statuses = url.searchParams.has('status') ? urlStatuses : DEFAULT_STATUSES;
```

…and on **clear**, write the empty sentinel so the param stays present:

```ts
function applyMulti(key: string, values: string[]) {
  const url = new URL(page.url);
  url.searchParams.delete(key);
  if (values.length === 0) url.searchParams.set(key, ''); // explicit clear → "all"
  else values.forEach((v) => url.searchParams.append(key, v));
  url.searchParams.set('page', '1');
  goto(url.pathname + url.search);
}
```

Validate every param with a **type guard** before use (`isStatus`, `isReason`, `isEntity`) — never trust the URL.

## Canonicalize defaults into the URL

On a bare landing, redirect so the active default filters are **explicit in the URL**. Only fill **absent**
params (leave a present-but-empty sentinel alone, so it doesn't undo a clear), and guard against loops
(after the redirect all params are present → no second redirect):

```ts
if (!p.has('type') || !p.has('status') || !p.has('reason')) {
  const c = new URL(url);
  if (!c.searchParams.has('type')) c.searchParams.set('type', DEFAULT_TYPE);
  if (!c.searchParams.has('status')) DEFAULT_STATUSES.forEach((s) => c.searchParams.append('status', s));
  if (!c.searchParams.has('reason')) DEFAULT_REASONS.forEach((r) => c.searchParams.append('reason', r));
  redirect(307, c.pathname + c.search);
}
```

## The `urlWith` helper (single/text/pagination)

```ts
function urlWith(params: Record<string, string | number | null>) {
  const url = new URL(page.url);
  for (const [k, v] of Object.entries(params)) {
    if (v === null) url.searchParams.delete(k);
    else url.searchParams.set(k, String(v));
  }
  return url.pathname + url.search;
}
```

## Server-side: defaults live in shared constants

Keep default filter sets and enum labels in the page's `$lib` module (like `DEFAULT_REPORT_REASONS`,
`reportReasonLabels` in `$lib/reports.ts`) so the load, the UI, and the canonical redirect share one source.
The service treats an **empty** filter array as "no filter" (`if (values.length) query.where('col','in',values)`),
which is what makes the cleared-→-all path work end to end.

## Gotcha: slow queries

Each filter/page change is a fresh navigation → a fresh service query. Some moderator queries are slow
(see [[moderator-queries-slow]]). Where it matters, prefer:

- **apply-on-close** for `MultiCombobox` (accumulate selections, navigate once when the popover closes)
  instead of navigating per tag, and/or
- optimistic local updates / targeted `invalidate()` over full `invalidateAll()` refetches.
