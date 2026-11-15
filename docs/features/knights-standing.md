# Knights of New Order: banned and muted accounts

Moved from `apps/knights/CLAUDE.md`. Code lives in `apps/knights/src/lib/server/standing.ts` and `apps/knights/src/hooks.server.ts`.

`lib/server/standing.ts` `getStanding(db, userId)` reads `User.bannedAt`, `deletedAt` and `muted` from the database (one primary-key lookup; never from the session, which can be stale).

- Banned, deleted or with no `User` row (fails closed): `hooks.server.ts` shows the closed page ("Your account can't enter the Order.", 403) on every page, action and non-job route, moderators included. Job routes are unaffected.
- Muted: may enter and view everything, and may claim and convert gold. The `vote`, `skip` and `apprentice` actions on `/play` and `POST /career` (restart career, from the account menu) answer 403 with `MUTED_MESSAGE` and write nothing (`mutedFailure`). `/play` load returns `muted: true` with no item, hidden check, yes/no question or apprenticeship item, and the page shows a calm notice instead of answer buttons. Joining stays open. Email verification is not checked.
