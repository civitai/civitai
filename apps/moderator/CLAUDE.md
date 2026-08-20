# apps/moderator

**Follow [`docs/svelte-app-standard.md`](../../docs/svelte-app-standard.md)** — the shared conventions
for every SvelteKit app here (runes, derive-the-promise, keyed loops, form actions, `@civitai/ui`,
`text-dark-2`, placement, comments, the three review agents).

Everything in this app arrives by **migration**: from Retool, or from the main Next.js app. That
provenance is the only reason it differs from the standard at all.

## Deltas

- **Route access is gated centrally** in `hooks.server.ts` against the `NAVIGATION` tree in
  `$lib/server/access.ts` — register a page there rather than checking per-page. Gate the action on the
  page's own path, never on a parent group node (a group's grant is the union of its children).
- **Page grants and action grants are two INDEPENDENT axes.** A page grant is what a role may OPEN,
  enforced centrally in `hooks.server.ts`. A permission is what a role may DO, declared in
  `$lib/permissions.ts` as `{ id, label }` and granted to roles on `/admin`. An action sits behind both,
  and they are composed where the action runs — never welded together in the declaration.

  🔴 **Do not give a permission a page.** They used to: each named the page it lived on plus the pages it
  required, and the check demanded all of them. `/users` was never built past a placeholder, so five
  permissions seeded to nobody, could not be granted (any `/admin` save re-trimmed them), and silently
  became admin-only — identity editing, the moderator toggle, Buzz send and mass ban, off for every
  non-admin with nothing reporting it. Which pages exist is not a permissions question. Background:
  [`docs/moderator-app/page-feature-permissions.md`](../../docs/moderator-app/page-feature-permissions.md).

- **Gate an action with the resolved set, never a hand-rolled role check.** `locals.grants` is a
  `PermissionSet` resolved once per request in `hooks.server.ts` (after `applyGrants` — before it the
  store is empty and everyone resolves to `{}`) and handed to the client by the root layout, so both
  sides read one answer:

  ```ts
  // form action — the permission is part of the signature, not a line to remember
  sendBuzz: requiresGrant('user.buzz.send', async ({ request, locals }) => { … })
  // anywhere else, server or client
  if (!locals.grants['user.buzz.send']) …      {#if data.grants['user.buzz.send']}
  ```

  Absent means not held, which is also what an unloaded store looks like — both read false, so it fails
  closed. A mistyped id does not compile.

- **A permission's `id` is a stored value — changing one orphans its grants.** Rows are keyed
  `grant:<id>`, deliberately never the page's URL, so retiring the `/retool/` prefix cannot switch
  permissions off. Treat an id like a column name. There are **no default roles**: a new permission is
  held by nobody until someone ticks it on `/admin`, exactly like a new page. Seeding defaults is what
  the old model did, and intersecting them against an ungranted page is how they arrived at nobody.
- **A new page is unreachable until granted.** It has no `AppPageAccess` row, so only `moderator:admin`
  can see it until someone ticks the boxes on `/admin`. Say so in the handover.
- **The role list is the auth hub's, never a constant here.** `$lib/server/roles.ts` reads the hub's
  `Role` table (`moderator:` prefix), so a role created there gets a `/admin` column without a deploy.
  Do not reintroduce a `ROLES` array — the one that existed made `moderator:community-manager` silently
  invisible on the only screen that grants it. Roles are opaque strings everywhere else already.
  `COLUMN_ORDER` in that file is **not** that array: it sorts, and anything absent from it still renders.
- **Never `throw error()` from a form action on a page holding unsaved work.** It renders the nearest
  error boundary, which unmounts the page and takes the operator's in-progress edits with it. `/admin`
  can carry dozens of unsaved ticks. Return `fail(status, { error })` and render it — and check that the
  page actually *shows* it: the default `enhance` does not invalidate on failure, so any status line
  led by a "you have unsaved changes" branch will hide every refusal behind it.
- **Two databases.** `$lib/server/db.ts` is the main app's Postgres; `getModeratorDb()` is moderation
  data that never lived there (notes, strikes, help requests), typed by hand in
  `moderator-db-types.ts` because those tables are not in the Prisma schema.
- **When porting, classify every source query before writing code**, and add the fourth
  export-vs-build review the standard describes. Three code reviews pass cleanly over a faithful
  implementation of the wrong thing — that is how four capabilities were missed on one page after
  passing every review.

  There is a skill per inbound path, and each carries its own traps and cutover:
  [`retool-migration`](../../.claude/skills/retool-migration/SKILL.md) (from a Retool export) and
  [`moderator-page-migration`](../../.claude/skills/moderator-page-migration/SKILL.md) (from
  `src/pages/moderator/**` — which also deletes the legacy page and trims what it orphans).

- 🔴 **This app has NO tests, and `typecheck` is the whole verification.** It is the only app in the
  monorepo without a suite — `auth` has 37 files, `creator-studio` 10, `notifications` 10, and every
  other app at least one; `apps/moderator/package.json` declares no `test` script at all, so it is
  absent from `pnpm run test:apps:run` (`--project 'app:*'`) and nothing here runs in CI.

  Say so when you report on work in this app. "Typecheck clean" is a complete statement of what was
  verified, not a summary of it — and a typecheck cannot see a wrong predicate, a mis-attributed row or
  a mute that never lifts, all of which have shipped here and been found later by reading the code.

  **What is worth testing when someone wires it up** (`app:auth` is the template — a `test` script plus
  a project entry): the pure decision functions where a wrong answer is silent and consequential —
  `chatReportSubject`, `resolveImageId`/`resolveArticleId`, `getTimedMute`'s `source`,
  `parseIdListStrict`, the flag and browsing-level helpers. Not the Kysely services: those need a
  database and the value drops sharply.

## Non-negotiables

Duplicated verbatim in every SvelteKit app's `CLAUDE.md` because **this file always loads and the
standard is one link away**. Each of these has cost real time when broken. Full reasoning and examples:
[`docs/svelte-app-standard.md`](../../docs/svelte-app-standard.md).

- **Derive the promise; never fetch in `$effect` and assign to `$state`.** The single most repeated bug
  in these apps — it gives a stuck spinner, a re-run loop, or a stale response landing on a newer
  lookup. `const x = $derived(browser ? fetch(...).then(r => r.json()) : null)`, then `{#await x}`.
- **Every `{#await}` needs a `{:catch}`.** Without one a rejection is silent and the panel just never
  fills in.
- **Key every `{#each}` on something unique.** An unkeyed or duplicate-keyed loop reuses the wrong DOM
  node, so a row's action button ends up wired to a different row. This is correctness, not lint.
- **A custom `use:enhance` callback must call `applyAction`.** It *replaces* the default handling, so
  without it every `fail()` is discarded and a refused action looks exactly like a successful one.
- **Optimistic UI must revert on failure.** A dim or a "handled" mark applied before the server answers
  and never undone makes the operator's own record wrong — and the item they skip is the one that failed.
- **Treat 0 affected rows as a failure, not a success.** Reporting success on zero writes an audit row
  for something that did not happen.
- **A `$bindable` prop passed one-way can latch.** shadcn wrappers declare `checked`/`value`/`open` as
  `$bindable` and the primitive writes to them on click. Passed as a plain prop, that write is a
  child-local override Svelte discards only when the parent expression yields a *different* value than it
  last pushed — so any click whose new state leaves that prop unchanged (tri-state `off`→`mixed` is the
  classic) leaves the control showing the opposite of your data, through a re-render and a reset. Use
  function bindings — `bind:checked={() => expr, (v) => handler(v)}` — whenever the parent owns the state.
- **Gate an action on the page's own path, never a parent group node.** A group's grant is the union of
  its children, so gating on the parent silently widens who can act.
- **`typecheck`, never `check` — and `build` is not a check.** Both run `svelte-kit sync`, which fights
  the dev server's watcher; that collision froze an editor for a full day. Read `svelte-check`'s
  **WARNING** lines too: `state_referenced_locally` is a real bug and appears nowhere else.
- **Before calling a segment done**, run `svelte-correctness-review`, `svelte-idiom-review` and
  `svelte-abstraction-review` (or the `/svelte-review` skill) — then **look at the page**. Typecheck
  passes on plenty of pages that render blank.
