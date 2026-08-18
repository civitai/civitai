# Moderator endpoints

`defineModeratorEndpoint` replaced `defineRetoolEndpoint`, and the moderator API has a self-describing
reference page at `/moderator/api`.

**Why the change.** The old helper authenticated a Bearer *user API key* — in practice one moderator's
personal key, shared by every caller — so the moderator check, the privileged-permission gate, the
per-actor rate limit and the audit row were all evaluated against that key's owner rather than the person
who acted. The new helper takes a signed-in moderator.

**Three ways in, one actor rule.** A moderator's browser session; that same session forwarded one hop by
a `*.civitai.com` spoke (which shares the hub's `.civitai.com` cookie, so it is not cross-domain); or a
moderator's own API key for scripts. All three resolve to a real moderator.

🔒 The mutating endpoints are cookie-authenticated POSTs, so CSRF is prevented **only** by the session
cookie being `SameSite=Lax`. That invariant is recorded in `moderator-endpoint.ts`; read it before
changing the cookie or adding a mutating GET.

**The pattern is the spoke's**, deliberately: `apps/moderator/src/lib/server/api-endpoint.ts` builds each
spec *from the zod schema that validates the request*, so a parameter cannot be documented and not
enforced. `/moderator/api` renders those specs, as `/xguard/docs` does in the moderator app.

---

## Done

- [x] `src/server/utils/moderator-endpoint.ts` — the builder, `moderatorBoolean`, `specToDoc`
- [x] **All 27 endpoints converted**, one route per action under `src/pages/api/mod/<domain>/<action>.ts`.
      Each carries a `summary` and per-param `.describe()`; none of the original schemas had either.
- [x] `defineRetoolEndpoint`, its tests and `src/pages/api/mod/retool/` are deleted. No `retool` remains
      in any moderator endpoint URL.
- [x] Shared zod pieces live in `src/server/schema/moderator/` — **not** under `src/pages`, where Next 16
      routes every file and the build's route-type validator rejects one with no default export. Only
      `next build` catches that; typecheck, vitest and `next dev` all stay green.
- [x] 18 unit tests on the helper: method handling, both auth paths, the moderator and banned gates,
      schema failure, the privileged gate in both directions, the rate limit, both audit outcomes, and
      two `specToDoc` regressions (see below).
- [x] Generated catalog — `pnpm run generate:moderator-endpoints`. Lazy `import()`s, so listing endpoints
      does not pull every moderator service into the page's graph.
- [x] `/moderator/api` — sections per domain, jump nav, and a per-endpoint **Try it** form built from the
      same params the docs show. POST arms before it fires: these are the real endpoints, not a sandbox.
- [x] `GET /api/mod/whoami` — reports the resolved moderator and their permissions. Confirmed working
      against a live auth server, which is the first end-to-end proof of the auth, rate-limit and audit
      path.

### Two runtime bugs typecheck could not see

Both took the whole reference page down with a 500, because the catalog builds all 27 docs in one pass.
Both are now pinned by a test.

- `specToDoc` returned `undefined` for absent optional fields, and `getServerSideProps` refuses to
  serialise `undefined`. Optional fields are omitted now.
- `z.toJSONSchema` **throws** on `z.coerce.date()`. Fixed with `unrepresentable: 'any'`, plus a catch so
  an unprojectable schema costs that endpoint its parameter table rather than every endpoint its entry.

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

## Known gap: catalog staleness

Generation is one script by choice — not wired into install or build. So adding an endpoint and
forgetting `pnpm run generate:moderator-endpoints` leaves it missing from `/moderator/api`, and nothing
fails. The generator is idempotent and takes ~0.12s, so a CI step running it and failing on a dirty tree
would close this if it is ever wanted.

## Deferred renames — each has a cost, neither is cosmetic

- [ ] The ClickHouse audit event is still `retoolAuditLog`. Renaming splits the audit history across two
      event names.
- [ ] The rate-limit key namespace is still `REDIS_SYS_KEYS.RETOOL_ENDPOINT.RATE_LIMIT`. It is a stored
      key — renaming resets every live counter mid-window.
