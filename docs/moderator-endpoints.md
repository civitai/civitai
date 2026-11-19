# Moderator endpoints

`defineModeratorEndpoint` replaced `defineRetoolEndpoint`.

**Why the change.** The old helper authenticated a Bearer *user API key* — in practice one moderator's
personal key, shared by every caller — so the moderator check, the privileged-permission gate, the
per-actor rate limit and the audit row were all evaluated against that key's owner rather than the person
who acted. The new helper takes a signed-in moderator.

**Three ways in, one actor rule.** A moderator's browser session; that same session forwarded one hop by
a `*.civitai.com` spoke (which shares the hub's `.civitai.com` cookie, so it is not cross-domain); or a
moderator's own full-access personal API key for scripts (any other token gets 403). All three resolve
to a real moderator.

🔒 The mutating endpoints are cookie-authenticated POSTs, so CSRF is prevented **only** by the session
cookie being `SameSite=Lax`. That invariant is recorded in `moderator-endpoint.ts`; read it before
changing the cookie or adding a mutating GET.

**The pattern is the spoke's**, deliberately: `apps/moderator/src/lib/server/api-endpoint.ts` declares each
endpoint's summary, zod input and handler in one record, and validates the request against that schema
before the handler runs.

---

## Done

- [x] `src/server/utils/moderator-endpoint.ts` — the builder and `moderatorBoolean`
- [x] **All 27 endpoints converted**, one route per action under `src/server/api-routes/mod/<domain>/<action>.ts`.
      Each carries a `summary` and per-param `.describe()`; none of the original schemas had either.
- [x] `defineRetoolEndpoint`, its tests and `src/pages/api/mod/retool/` are deleted. No `retool` remains
      in any moderator endpoint URL.
- [x] Shared zod pieces live in `src/server/schema/moderator/` — **not** under `src/pages`, where Next 16
      routes every file and the build's route-type validator rejects one with no default export. `next build` and
      `pnpm run typecheck` (which runs `next typegen` first) catch that; vitest and `next dev` stay green.
- [x] Tests on the helper: method handling, both auth paths, the moderator and banned gates, schema
      failure, the privileged gate in both directions, the rate limit and both audit outcomes.
- [x] `GET /api/mod/whoami` — reports the resolved moderator and their permissions. Confirmed working
      against a live auth server, which is the first end-to-end proof of the auth, rate-limit and audit
      path.
- [x] The `/moderator/api` reference page, its Try-it form and `/api/mod/openapi.json` were removed; nothing in the repo used them.

## Outstanding

- [ ] **Spoke side (`apps/moderator`, other repo) — the blocking work.**
      - [ ] It still POSTs `/api/mod/retool/<resource>` with an `{action}` body. Those routes are gone;
            every call must move to its per-action URL.
      - [ ] Auth: forward the moderator's cookie. `hooks.server.ts` already reads
            `event.request.headers.get('cookie')`; `user-actions.service.ts` needs it threaded to the call
            sites, the same shape as the `moderatorId` thread-through already done there.
      - [ ] Back out the uncommitted `actingUserId` argument on `callRetoolEndpoint` — it was the
            workaround for not having the session. Keep the `moderatorId` threading: the spoke still
            writes its own `ModActivity` rows, and the tag-vote and minor-flag paths had no actor at all
            before it.
- [ ] **`minor-flag` and `restriction` exist only on the `moderator-app-pages` branch** and still import
      the deleted helper. **That branch will not build once it merges** until they are converted.
- [ ] No **write** endpoint has fired. `whoami` proves the shared path; the 26 others are unexercised.
- [ ] Nothing is committed, in either repo.

## Where the routes live

Under `src/server/api-routes/mod/`, served by `src/pages/api/mod/[...path].ts` so they are not each their own
build entry. Adding one, and which routes stay files in `src/pages/api/mod/`: `docs/dev/api-routes.md`.

## Deferred renames — each has a cost, neither is cosmetic

- [ ] The ClickHouse audit event is still `retoolAuditLog`. Renaming splits the audit history across two
      event names.
- [ ] The rate-limit key namespace is still `REDIS_SYS_KEYS.RETOOL_ENDPOINT.RATE_LIMIT`. It is a stored
      key — renaming resets every live counter mid-window.
