# Auth review — synthesis of two independent subagent reviews

**Date:** 2026-06-15 · **Branch:** `monorepo-bootstrap` · **Scope:** the hub↔spoke auth work (the `@civitai/auth`
package incl. the browser client, the SvelteKit hub `apps/auth`, and the main-app server/proxy/React surfaces).

## Method

Two subagents reviewed the same working tree, deliberately differently:

- **Reviewer A — spec-bound.** Given ONLY `docs/auth-hub-spoke-overview.md` as the intended design; told to ignore
  every other doc. Job: does the implementation match the spec?
- **Reviewer B — cold.** Given NO design docs at all; told to assess the code purely on its own terms.

Their reports came back to me; I verified the most material finding in code and reconciled the two. (The harness
has no agent-to-agent messaging here, so the "discussion" is their two reports + my adjudication below.)

## The headline: what the two lenses caught differently

This is the useful part of running both.

- **The spec focused Reviewer A and made it efficient** — it confirmed the §6 package boundary is genuinely
  clean (no component hand-rolls a hub fetch) and caught the two *lifecycle* bugs that **contradict** the spec
  (revocation on the read path; the refresh claim-strip). But being anchored to "is this per spec?" it **accepted
  spec-endorsed designs at face value**: the moderator-only impersonation gate is "present ⇒ compliant," and the
  cross-domain swap is "planned ⇒ not my concern." It did not interrogate whether those *designs* are safe.
- **The cold Reviewer B, with nothing to conform to, interrogated the designs themselves** — and surfaced the
  deeper security issues the spec blesses: the swap token is called "single-use" but isn't enforced or bound to a
  principal (replayable → cross-domain takeover if it leaks), the impersonation gate trusts `isModerator` from a
  cache the hub itself produces (no defense-in-depth), the internal-token compare isn't constant-time, and several
  redirect/CSRF foot-guns. More signal **and** more noise (some findings are known tradeoffs or pre-existing).
- **Both independently converged on the same two top issues** (revocation-on-cache-hit and the refresh re-mint),
  which raises my confidence that those are real and worth fixing first.

**Takeaway:** a spec doc is the right tool for "did we build what we intended" and for guarding an invariant like
the package boundary; a cold read is the right tool for "is what we intended actually safe." A spec can blind a
reviewer to risks it endorses — so for security-sensitive work, run both, and don't let the spec be the ceiling.

## Reconciled findings

Severity is my adjudication after verification, not a copy of either agent's label. "Ours" = introduced/owned by
this session's work; "pre-existing" = already in the tree, surfaced because the file was in scope.

| # | Finding | Found by | My verdict | Sev | Origin |
|---|---------|----------|-----------|-----|--------|
| 1 | **Rolling refresh drops `impersonatedBy`** — `apps/auth/.../refresh/+server.ts:27` re-mints `{sub,signedAt}` only, so an impersonation session that crosses the ~24h update age silently becomes a *real* session for the target and the exit path/audit break. | A (D2/S2); B (touched, L1) | **Confirmed in code.** Real bug. | **HIGH** | Ours (F) |
| 2 | **Revocation not enforced on the spoke read path** — `createSessionClient`'s verifier has no `isRevoked`, so a `session:data2` **cache hit** resolves a logged-out/banned token until the key is re-warmed. (The hub's own refresh verifier *does* check revocation — confirming the asymmetry.) | A (D1/S1); B (M3) | **Valid.** Central to cutover correctness. | **HIGH** | Pre-existing, cutover-critical |
| 3 | **Swap token not single-use / not principal-bound** — `verifySwapToken` checks only sig+purpose+sub; "single-use" is documented but never enforced, and the token transits the browser. Leak → cross-domain account takeover within `exp` (60s). | B (H3/H4) | **Valid**, but gates the **planned** cross-domain path (not yet live). Fix before it ships. | **MED→HIGH (when live)** | Pre-existing / planned |
| 4 | **Internal service-secret compare is not constant-time** — `internal.ts:9` uses `===` for `AUTH_INTERNAL_TOKEN` (guards arbitrary-userId cache invalidation + dev mint). | B (H2) | **Valid.** Cheap fix (`crypto.timingSafeEqual`). | **MED** | Pre-existing |
| 5 | **Impersonation gate single-sourced from a producible cache** — the hub trusts `locals.user.isModerator` (from `getOrProduceSessionUser`); no DB re-read at the impersonate boundary. Blast radius = full takeover. | B (H1) | **Valid as defense-in-depth.** Cache is hub-produced from DB, so not a live bypass, but a DB re-read here is cheap insurance. | **MED** | Ours (F) touches it |
| 6 | **Three hand-rolled unverified JWT decoders** — `impersonate.ts decodeImpersonatedBy`, `civ-cookie.ts decodeExp`, `session-client.ts decodeClaim` all base64-read claims. The impersonate one feeds the `ModActivity` audit. | B (M4) | **Valid cleanup.** Low risk (cookie is server-set, httpOnly, already verified upstream) but duplicated + audit-adjacent. | **LOW-MED** | Ours (2 of 3) |
| 7 | **`logoutAll` doesn't clear other accounts** — identical to `logout`; relies on 30-day idle pruning. | A (G2) | **Known TODO**, already commented in code. | LOW | Ours |
| 8 | **Device switch needs no re-auth within the 30-day window** (kiosk/shared-machine exposure). | B (M1) | **Known design**, decided with the user (per-account 30-day, accepted tradeoff). Not a defect. | LOW (by design) | By design |
| 9 | Misc pre-existing: session token accepted from `?token=` query (`get-server-auth-session.ts:76`); `readReturnUrl` not composed with `isSafeReturnTarget` (open-redirect foot-gun); `/identity` returns a `bannedAt` user; `sync.ts` leaks raw error; permissive `aud` when unset; no explicit Origin/CSRF check on switch/impersonate POSTs. | B (M2/M5/M6/L2/L3/L4/L5) | **Valid, mostly pre-existing** hardening — out of this session's scope but worth tickets. | LOW–MED | Pre-existing |

**Package boundary (§6):** Reviewer A explicitly confirmed **no violations** — every component goes
`UI → AccountProvider → @civitai/auth/client → proxy → server clients → hub`, and a grep for inline `/api/auth/*`
fetches in components came back clean. The one inline auth fetch left (`useDomainSync → /api/auth/sync`) is the
not-yet-migrated cross-domain path. The now-unused `impersonateEndpoint` constant can be deleted.

## Action items (prioritized)

**P0 — before flipping `USE_HUB_SESSION` / shipping:**
1. Carry `impersonatedBy` through rolling refresh (read it off the verified claims in `refresh/+server.ts`, pass
   to `mintSessionToken`). *(Our bug; #1.)*
2. Enforce revocation on the spoke read path — wire an `isRevoked` check into `createSessionClient` so a cache
   hit still re-checks the `jti` (or re-check after the cache read). *(#2.)*

**P1 — before the respective path goes live:**
3. Make the swap token genuinely single-use (redis `jti` burn) and keep it server-to-server / bound — before the
   cross-domain (`.red`/localhost) exchange ships. *(#3.)*
4. `crypto.timingSafeEqual` for `AUTH_INTERNAL_TOKEN`. *(#4.)*
5. DB re-read `isModerator` inside the hub impersonate handler (defense-in-depth). *(#5.)*

**P2 — cleanup/hardening (tickets):**
6. Centralize the three JWT claim decoders into one helper; treat the impersonation audit attribution as
   security-relevant. *(#6.)*
7. The pre-existing hardening set in #9 (query-token, redirect composition, banned `/identity`, error leak,
   Origin/CSRF on state-changing POSTs).

## Resolution (2026-06-15) — fixed this segment

All findings tied to this segment's work, plus the cheap safe wins, are now fixed (package 82 tests, hub
svelte-check 0/0, main typecheck 0):

- **#1 ✅** `refresh/+server.ts` now carries `impersonatedBy` through the roll.
- **#2 ✅** `createSessionClient` takes an injected `isRevoked`; the main app wires `session-verifier.ts`'s check
  in, so a revoked/banned token is rejected on the cache-hit read path.
- **#4 ✅** `internal.ts` uses `crypto.timingSafeEqual` (length-guarded) for `AUTH_INTERNAL_TOKEN`.
- **#5 ✅** the hub impersonate handler re-reads `isModerator` from the DB (defense-in-depth vs a stale cache).
- **#6 ✅** the three base64 decoders collapsed into `src/server/auth/token-claims.ts` (`decodeTokenClaim`),
  used by `civ-cookie`, `session-client`, and the impersonate proxy.
- **#9 (sync) ✅** `sync.ts` no longer returns the raw error object.

**Deferred (intentionally):**
- **#3** swap-token single-use + principal-binding — belongs WITH the cross-domain exchange (still deferred; the
  enforcement shape depends on that design, and the path isn't live yet). Tracked on the E cross-domain todo.
- **#7 / #8** are known/by-design (logoutAll TODO; per-account 30-day switch window decided with the user).
- The remaining pre-existing **#9** items (query-string bearer in `getServerAuthSession`, `readReturnUrl` not
  composed with `isSafeReturnTarget`, banned-user `/identity`, permissive `aud`, explicit Origin/CSRF on
  state-changing POSTs) are valid hardening but pre-date this work — left as tickets to avoid changing
  established behavior unreviewed.

## What I verified myself

- #1: read `refresh/+server.ts` — confirmed it re-mints without `impersonatedBy`; the bug is real and ours.
- #2: confirmed the contrast — the hub's `refresh` verifier enforces revocation, while the package
  `createSessionClient` read-path verifier does not, so the gap is specifically the spoke cache-hit path.
- The rest I assessed for plausibility against the code paths cited; #3–#6 are credible and worth the tickets,
  with the severities re-graded above (notably #8 down to "by design" and #9 to pre-existing).
