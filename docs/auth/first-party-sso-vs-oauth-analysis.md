# First-Party SSO: Custom Swap-Token vs OIDC Authorization-Code (and a Converged Option)

**Author:** Claude (Opus 4.8) · **Date:** 2026-06-17 · **Status:** analysis / decision input
**Companion to:** [auth-hub-cutover-review-2026-06-17.md](./auth-hub-cutover-review-2026-06-17.md) · [plans/oauth-provider-to-auth-app.md](./oauth-provider-to-auth-app.md) · [auth-hub-spoke-overview.md](./auth-hub-spoke-overview.md)

> Handoff note for the other session: this is an architectural analysis, not a directive. It argues that the monorepo's first-party SSO mechanism (the bespoke hub-session-cookie + swap-token flow) is a hand-rolled subset of OAuth's authorization-code flow, weighs whether to use OAuth instead, and recommends a converged design. No code has been changed.

---

## The question

We are building **two** ways to authenticate against the hub (`auth.civitai.com`):

1. **First-party SSO** — a hub-issued session: login at the hub sets a `civ-token` (thin ES256 JWT) cookie; spokes (civitai.com, civitai.red, moderator app) verify it locally via JWKS and resolve the full `SessionUser` from the identity endpoint. Cross-domain to `.red` is bridged by a custom **swap-token** flow (mint a short-lived single-use token, redirect with `?swap=`, the spoke exchanges it server-side at `/api/auth/exchange` for its own cookie).
2. **OAuth 2.0 / OIDC provider** — scoped bearer tokens (`civitai_…`, hashed `ApiKey` rows) for **third-party** developer apps, with consent + scope bitmask. (Currently lives in the main app; migration into the hub is planned but not started.)

**Could the monorepo (first-party) apps use OAuth instead of the custom session mechanism — and would that be less efficient?**

---

## Key observation: the custom flow is already a narrow re-implementation of OAuth

The swap-token flow maps almost 1:1 onto the OAuth authorization-code flow:

| Custom flow (being built) | OAuth equivalent |
|---|---|
| `swap` token — short-lived, single-use, redirected in URL, exchanged server-side | **authorization code** |
| `/api/auth/exchange` endpoint | **`/token`** endpoint |
| `.red` registered in `AUTH_SPOKE_ORIGINS` | **`redirect_uri`** exact-match registry |
| `civ-token` thin session cookie issued after exchange | the **session minted after `/token`** (BFF pattern) |

The cross-domain `.com` ↔ `.red` problem the swap-token bridge solves is exactly what `redirect_uri` solves in OAuth: `civitai.red` is just another registered redirect target whose backend exchanges its own code for its own session. No special sync/exchange/swap endpoints — it falls out of the protocol.

**Several review blockers are problems OAuth already solves.** The open-redirect (review `B1`), swap-token-not-bound-to-redeeming-spoke (`B4`), and replay are precisely what OAuth's `state`, `nonce`, PKCE, exact-match `redirect_uri`, and audience binding exist to prevent. The custom path is maintaining bespoke security-sensitive crypto — which has already produced blockers — to do a job a hardened standard covers.

---

## Efficiency: essentially a wash at runtime (wrong axis to optimize)

The intuition "OAuth is heavyweight, the custom thing is lean" does not hold once you use OAuth correctly for a **web** app (the BFF — backend-for-frontend — pattern):

- **Per request (what matters at scale):** identical. With BFF you exchange the code **once** at login, then run your own session cookie. Steady state = "validate a local session cookie," same as the thin-token today. You would **not** put bearer access tokens in the browser or hash-lookup a token per page — that is the third-party API path, and *that* would be slower (DB lookup per request) and worse for security. No one uses it for first-party web sessions.
- **At login:** OAuth is marginally heavier — one extra redirect (the `/authorize` leg) plus the consent gate. But first-party apps register as **trusted clients**, and OIDC explicitly supports auto-approving them with **no consent prompt**. Net user-visible cost ≈ one redirect.
- **Network calls:** OAuth may actually *remove* a round-trip — the per-domain custom sync step is subsumed by the standard redirect_uri exchange.

**Conclusion:** the efficiency delta is a slightly longer login handshake, not a runtime tax. "Less efficient" is not a real reason to prefer the custom path.

---

## Honest trade-off

### What the custom thin-session genuinely wins on
- Cheapest per-request validation: local JWKS verify, **no scopes to evaluate**.
- A single shared `SessionUser` shape across all first-party apps.
- Zero OAuth ceremony (no scope bitmask, no token rotation) for apps we fully own. First-party apps want "you are fully logged in," not "this client may do these 14 scoped things." Modeling a full session as a `Full`-scope trusted OAuth client is conceptually heavier than needed.

### What OAuth wins on
- **One** protocol and **one** security-review surface for both first-party and third-party.
- Far less bespoke code to maintain — delete swap / exchange / sync / refresh endpoints.
- Clean multi-domain via `redirect_uri` (no custom cross-eTLD+1 bridge).
- Inherits battle-tested CSRF / replay / open-redirect defenses instead of rediscovering them in review.

---

## Recommendation: converge, don't choose

Use the OIDC **authorization-code + PKCE** flow as the single *login handshake* — it replaces the bespoke swap / exchange / sync and provides `state` / `nonce` / `redirect_uri` hardening for free — **but still issue the thin ES256 session cookie as the *result*** of that handshake. First-party apps register as trusted clients with consent skipped.

This keeps the genuine wins (cheap per-request validation, shared session shape) while retiring the hand-rolled cross-domain crypto that is generating blockers.

```
[ browser ]
    │  1. visit spoke (civitai.com / .red / moderator), not logged in
    ▼
[ spoke backend ]  ──2. redirect to hub /authorize?client_id=<spoke>&PKCE&state ──►
                                                                                  [ hub /authorize ]
                                                                                   3. hub session gate
                                                                                      (login if needed)
                                                                                   4. trusted client →
                                                                                      skip consent
    ◄────────────── 5. redirect back to spoke redirect_uri with ?code ────────────┘
[ spoke backend ]
    6. back-channel POST hub /token  (code + PKCE verifier)  ──► [ hub /token ]
    ◄──────────────  7. thin ES256 session token (+ optional id_token)  ──────────┘
    8. spoke sets its OWN civ-token cookie (BFF). Steady state = local JWKS verify.
```

Net effect: **one** hardened login front door for everyone; first-party apps differ only by "trusted client → no consent" and "issued a session cookie rather than a long-lived API token."

---

## The strategic kicker

We are **building the OAuth provider anyway** (the unstarted `M3` work in the review / `plans/oauth-provider-to-auth-app.md`). If first-party SSO rides the same authorization-code front door, we build and harden **one** login path instead of two. Under the converged design, the custom swap-token scheme becomes the redundant piece.

---

## The one real caveat (sequencing)

This only pencils out if the OAuth-provider-into-hub migration is **in scope**. Decision tree for the other session:

- **If OAuth migration is in scope for this launch:** seriously consider building first-party SSO *on* the authorization-code flow from the start (converged design) and not finishing the standalone swap-token path. Avoids hardening a private reimplementation you'll later have in standard form.
- **If shipping first-party SSO now and deferring OAuth:** finishing the swap-token path is the pragmatic call — but know that (a) you are hardening a bespoke reimplementation of a flow you'll later have in standard form, and (b) there will be a consolidation opportunity (or some throwaway) when the two meet. Fix the review blockers (`B1`, `B4` especially) regardless, since they're live until then.

Either way, the swap-token flow should be understood as "a tactical stand-in for authorization-code," not as a permanent parallel mechanism.

---

## Open questions for the team

1. Is the OAuth-provider-into-hub migration in scope for the **same** launch as first-party SSO, or sequenced after? (Determines converge-now vs ship-custom-then-consolidate.)
2. Are we comfortable modeling first-party apps as trusted OIDC clients (consent skipped), or is there a reason first-party must stay off the OAuth code path entirely?
3. If we converge: confirm the result of the first-party handshake is still the thin session cookie (BFF), **not** a browser-held access token. (Strong recommendation: yes — keep tokens server-side.)
4. Reconcile the signing-alg doc rot first (`RS256` in docs vs `ES256` in code — review `B3`/`B5`); the converged design's `id_token` signing inherits whatever the hub signer actually uses.
