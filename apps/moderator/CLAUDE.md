# apps/moderator

**Follow [`docs/svelte-app-standard.md`](../../docs/svelte-app-standard.md)** — the shared conventions
for every SvelteKit app here (runes, derive-the-promise, keyed loops, form actions, `@civitai/ui`,
`text-dark-2`, placement, comments, the three review agents).

Everything in this app arrives by **migration**: from Retool, or from the main Next.js app. That
provenance is the only reason it differs from the standard at all.

## Deltas

- **Route access is gated centrally** in `hooks.server.ts` against the `NAVIGATION` tree in
  `$lib/server/access.ts` — register a page there rather than checking per-page. A *page-level*
  permission and an *action-level* permission are different things: reaching a lookup page is an
  investigation permission, acting on an account is not. Gate the action on the page's own path, never
  on a parent group node (a group's grant is the union of its children).
- **A new page is unreachable until granted.** It has no `AppPageAccess` rows, so only
  `moderator:admin` can see it until someone ticks the boxes on `/admin`. Say so in the handover when
  you add one.
- **Two databases.** `$lib/server/db.ts` is the main app's Postgres; `getModeratorDb()` is moderation
  data that never lived there (notes, strikes, help requests), typed by hand in
  `moderator-db-types.ts` because those tables are not in the Prisma schema.
- **When porting, classify every source query before writing code**, and add the fourth
  export-vs-build review the standard describes. Three code reviews pass cleanly over a faithful
  implementation of the wrong thing — that is how four capabilities were missed on one page after
  passing every review.
