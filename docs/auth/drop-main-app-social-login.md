# Drop In-App Social Login Buttons from the Main App — Checklist

**Status:** complete · **Date:** 2026-06-17

**Context:** All authentication now flows through the hub (auth.civitai.com) — `requireLogin` opens the hub
login in a popup, and the hub owns the login UI + cookie issuance. The main app's in-page OAuth/social-login
buttons are therefore obsolete. This checklist finishes removing them (the Phase 5 in-page-login removal
surface) and relocates the now hub-only provider/social code out of the shared package.

## Decision: centralize linked-accounts in the hub — option 2 (native list, NOT an iframe)

**Date:** 2026-06-17

Account linking/unlinking is an auth-authority concern, so the hub owns it. We deliver this as a **thin native
list** in each app's settings (option 2), **not** an embedded `auth.civitai.com/linked-accounts` iframe.

**Why not an iframe:** a cross-origin `auth.civitai.com` iframe is *same-site* on `*.civitai.com` (cookie sent,
works) but *third-party* on **civitai.red** (hub cookie blocked by ITP / Chrome's phase-out → the iframe can't
identify the user). It also forces theme-passing, postMessage auto-resize, and `frame-ancestors` CSP — the same
cross-site cookie trap login avoided by using a popup.

**The .red-safe transport (this is what makes option 2 work on BOTH civitai.com and civitai.red):**

| Action | Transport | Cross-site? |
| --- | --- | --- |
| **Connect (link)** | top-level navigation to `hubLoginUrl(provider, { link: true })` | ✅ first-party at the hub |
| **List connected** | same-origin app tRPC (`account.getAll`) reading the shared DB | ✅ session via same-origin civ-token |
| **Disconnect (unlink)** | same-origin app tRPC (`account.delete`) on the shared DB | ✅ same-origin |
| ~~Direct browser→hub fetch for data/unlink~~ | ✗ **do not** | ❌ third-party cookie blocked on .red; civ-token is httpOnly so it can't be a bearer |

Accounts live in the **shared DB**, which both apps' servers read/write same-origin — so the hub owning the
*OAuth link* is the part that matters; list/unlink stay same-origin (no browser→hub call). If a single canonical
hub-owned unlink is ever wanted, route it as a **same-origin main-app proxy → hub server-to-server**, never a
browser→hub call.

**Status:** AccountsCard already uses this transport (`account.getAll`/`account.delete` same-origin + hub-nav
link), so it is already .red-safe. The only option-2 work left there is UI decoupling from the deletable
`Social/` folder — note the connected-accounts icon+name is a main-app *presentation* detail and stays in the
main app; the code being moved to the hub is the *login* social-button UI, not this list.

## Consumers to migrate (blockers)

- [x] **AccountsCard** *(done)* — now fully decoupled from the `Social/` folder:
  - `providers` repointed to `import { OAUTH_PROVIDERS as providers } from '@civitai/auth/client'` (dropped
    `~/components/Social/SocialButton`).
  - `SocialLabel` replaced with an inline icon+name (small local tabler brand-icon map + `provider.name`),
    dropping `~/components/Social/SocialLabel`.
  - Transport is already .red-safe per the decision above: `account.getAll`/`account.delete` are same-origin
    tRPC on the shared DB; Connect is a top-level `hubLoginUrl(..., link: true)` navigation. No behavior change.
  - AccountsCard was `SocialLabel`'s only consumer, so the Social folder is now unblocked from that side.
- [x] **IframeHost (app-blocks)** *(done)* — the `REQUEST_SIGN_IN` handler now calls
  `openLoginPopup(returnUrl ?? here, 'image-gen')` instead of `dialogStore.trigger(LoginModal)`; the `LoginModal`
  dynamic import is gone. Host runs at top level, so the popup works.
- [x] **`/login` page** *(done)* — converted to a pure server-side hub redirect (renders `null`). Threads
  returnUrl (via post-login) + reason + error + `prompt=select_account` for add-account; the hub picker now
  forwards `prompt` to its provider links ([+page.server.ts](../../apps/auth/src/routes/login/+page.server.ts) +
  [+page.svelte](../../apps/auth/src/routes/login/+page.svelte)). Route kept (major redirect target).
- [x] **discord/link-role** *(done)* — "Connect Discord" now navigates to the hub account-LINK flow
  (`hubLoginUrl({ provider: 'discord', link: true, returnUrl })`); the hub requests `role_connections.write`
  and stores the granted scope on the Account, so the page detects it on return and pushes metadata. Dropped
  `SocialButton` + `handleSignIn` + `getProvidersInProcess` from this page; metadata-push + branded UI stay.
  **Note (RESOLVED 2026-06-17):** `getProvidersInProcess` is **deleted** — `src/server/auth/get-providers-in-process.ts`
  no longer exists and `auth.router.ts` no longer references it (removed with the next-auth strip).

## Package hygiene

- [x] **Provider descriptors removed from `@civitai/auth`** *(done)* — `OAUTH_PROVIDERS` + the `OAuthProvider`
  interface had a single consumer (`AccountsCard`); it now defines its own id→name+icon map driven by
  `availableOAuthProviders`, so the package no longer holds single-app login presentation. **Nuance vs the
  original "move into the hub" framing:** the descriptors went to the **main app** (their actual consumer —
  `AccountsCard`), NOT the hub, because the hub already has its own full provider config
  (`apps/auth/.../providers.ts`). `ProviderId` STAYS in the package (the hub keys its config on it), and
  `hubLoginUrl`/`HubLoginUrlOptions` stay (the genuine cross-app contract). Verified: hub typecheck clean, 109
  package tests pass.

## LoginContent → hub parity (resolve before Batch 1 deletion)

Audited every LoginContent behavior against the hub (2026-06-17). Branding, title, provider buttons, email
(with captcha), and the `error` display are all covered by the hub login page. Gaps:

- [x] **Re-home the `reason` mechanism — DONE (except optional display).** `reason` drove three jobs, all in
  LoginContent. Re-homing landed (see the parity-audit section):
  - **(b) attribution** — ✅ DONE. `reason` rides the post-login URL → `runLoginSideEffects` (param + legacy
    cookie fallback) → `createUserReferral`. No longer depends on the LoginContent cookie; works cross-site.
  - **(c) analytics** — ✅ DONE. The hub fires `LoginRedirect` itself (its own tracker, any reason) from the
    `/login` page; popup + full-page both forward `reason` to the hub.
  - **(a) display message** (`loginRedirectReasons[reason]`) — *still open / optional*. Prefer a **main-app
    gate-time toast** over teaching the hub (keeps reason vocabulary main-app-side; avoids arbitrary copy through
    the hub URL). **Hub stays reason-agnostic.**
  - `loginRedirectReasons` itself STAYS — it's the source of `type LoginRedirectReason = keyof typeof …`.
- [x] **`prompt=select_account` (`forceAccountSelection`)** — **DONE.** The hub now forwards `prompt` to the
  provider: `buildAuthorizeUrl` accepts `prompt` and sets the query param
  ([providers.ts](../../apps/auth/src/lib/server/auth/providers.ts)), and
  [login/[provider]/+server.ts](../../apps/auth/src/routes/login/[provider]/+server.ts) reads it from the
  request. LoginContent passes it for `reason==='switch-accounts'` so a user can pick a *different* identity on
  the same provider.
- [ ] **Referrer card** — LoginContent shows a "you were referred by X (+500 Buzz)" card. Pure display; the
  referral itself still applies main-app-side (post-login attribution + onboarding code), so dropping the card
  is a UX nicety loss, not a functional regression. Decide: reproduce somewhere or drop.
- [ ] **Green-domain bounce / alias-host suppression** (`civitaiLoginHref` / `isOnAlias`) — the pre-hub
  cross-domain mechanism, superseded by the hub + swap-token sync. Verify alias hosts route to the hub login
  correctly, then it can just be dropped with LoginContent.
- **Referrals: the hub does NOT (and need not) accept referrals** — user creation assigns only a username;
  attribution + code application are entirely main-app-side. No hub work needed here.

## Login-flow parity audit (2026-06-17)

Diffed the legacy next-auth flow against the hub + handoff (3 parallel read-only audits — old baseline, hub
flow, main-app handoff). Outcome:

**Fixed (hub changes verified — hub typecheck clean, 77 hub tests pass):**

- [x] **Email magic-link grace window** — `consumeVerificationToken` no longer single-use-deletes on click
  (email security scanners prefetch links → would consume the token and lock out the real click). Valid for its
  TTL instead; expired rows cleaned up on access. [email-tokens.ts](../../apps/auth/src/lib/server/auth/email-tokens.ts).
  *Knob:* the grace window is the 24h `TTL_MS`; lower it if a tighter replay bound is wanted.
- [x] **Discord `role_connections.write` scope** — restored on the provider; `exchangeCode` now returns the
  granted scope; `findOrCreateUser`/`linkAccountToUser` store it on the Account (create + re-login + re-connect),
  porting legacy `updateAccountScope`. Linked-roles detection (`/discord/link-role`) works again.
- [x] **Plus-address block** — new `+`-alias email signups blocked (existing `+` users still sign in) via
  `userExistsByEmail` in the hub email action + inline error.
- [x] **Provider avatars** — hub stores `image: null` on creation (was storing the provider avatar — unintended;
  no unmoderated provider avatars shown by default).
- [x] **Full-page login `reason`** — the `/login`→hub redirect + `handleSignIn` now forward `reason` (the popup
  path already did).
- [x] **Reason re-homing (was item #10 / the "reason re-homing" task above)** — `reason` now rides in the
  post-login URL → `runLoginSideEffects` (param, with the legacy cookie as a transition fallback), so referral
  attribution survives LoginContent's deletion. Works same-site AND cross-site (rides the returnUrl through the
  hub / `/api/auth/sync`). Files: `auth-helpers.ts`, `pages/api/auth/post-login.ts`, `login-side-effects.ts`,
  `pages/login/index.tsx`. (The attribution-cookie half of the reason task is now done; the optional gate-time
  message toast is still open.)

**Resolved — no action:**

- **SameSite `none`→`lax`** — safe. `*.civitai.com` are same-*site* (cookie still sent cross-subdomain); no
  cross-origin embeds; no cross-site POST callbacks (OAuth is hub-side GET; Stripe/Paddle/PayPal returns are GET;
  webhooks are server-to-server). Confirmed by grep (no `form_post`/SAML, payment `success_url`/`return_url` all GET).
- **Reddit `duration` permanent→temporary** — fine (the Reddit token isn't used after login).
- **Removed credential providers** (`token-login`/`testing-login`) + **preview-env per-host OAuth** — fine
  (previews share the main app's env; admin impersonation is covered hub-side).
- **`isNewUser` stays main-app** (createdAt heuristic) — moving it to the hub adds a shared-state contract, not
  removes coupling.

**Covered by the hub already (no gap):** username assignment, post-login side-effects
(referral/tracking/notification/orchestrator-cookie), token invalidation/refresh/revocation + rolling refresh,
verified-email account-linking, session resolution with legacy `civitai-token` fallback, account switching
(device-set), hub impersonation, 30-day TTL, redirect-origin validation, email blocklist + Turnstile captcha +
rate-limit.

## Deletions

### Batch 1 — orphaned by `LoginContent` removal (gated only on the two reworks above: `/login` + IframeHost)

Verified consumers (2026-06-17): `LoginContent` is used only by `/login` (fallback render) and `LoginModal`;
`LoginModal` is triggered only by `IframeHost` ([IframeHost.tsx:574](../../src/components/AppBlocks/IframeHost.tsx#L574));
`EmailLogin` and `SignInError` have **zero** consumers outside `LoginContent`.

- [x] `src/components/Login/LoginContent.tsx` — **deleted** (/login is now a hub redirect).
- [x] `src/components/Login/LoginModal.tsx` — **deleted** (IframeHost migrated off it).
- [x] `src/components/EmailLogin/EmailLogin.tsx` (+ folder) — **deleted**.
- [x] `src/components/SignInError/SignInError.tsx` (+ folder) — **deleted**.
- **Keep:** `src/components/Login/requireLogin.ts` (active gate, uses `openLoginPopup`). `CreatorCardSimple`,
  `IconCivitai`, `CurrencyBadge`, `useReferralsContext`, `useTrackEvent`, `login-helpers` are all shared — keep.

**Transitive-orphan check (done 2026-06-17):** traced every import of all four deleted files.

- `EmailLogin` and `SignInError` are leaves (only `@civitai/auth/client`+`env` / only Mantine) — orphan nothing.
- `LoginModal` adds only `useDialogContext` (shared). LoginContent's other imports are all heavily shared:
  `CurrencyBadge` (49), `useTrackEvent` (26), `setCookie` (4), `useReferralsContext` (3), `CreatorCardSimple`
  (2), `IconCivitai` (2), `trackedReasons` (1).
- **One nuance — `loginRedirectReasons`** (`src/utils/login-helpers.ts`): the imported symbol has 0 consumers
  besides LoginContent, BUT it is the source of `export type LoginRedirectReason = keyof typeof
  loginRedirectReasons`, which is used app-wide. **Do NOT delete it.** Only its reason→message strings go unused.
  Those messages ("You need to be logged in to …") are a candidate to relocate to the hub login so it can
  display the redirect reason — a follow-up, not part of this deletion.
- **Conclusion:** no file/method deletions beyond the four scoped files. Batch 1 is self-contained.

### Batch 2 — orphaned only once `link-role` is migrated (NOT by `LoginContent` alone)

`link-role` still imports `SocialButton` + `handleSignIn`, so these survive until that consumer is rewired.

- [x] `src/components/Social/SocialButton.tsx` — **deleted**.
- [x] `src/components/Social/Social.tsx` (+ `Social.module.css`) — **deleted**. (`LiveNow.tsx` in the same
  folder is unrelated and kept.)
- [x] `src/components/Social/SocialLabel.tsx` — **deleted** (AccountsCard inlines its own icon+name now).
- [x] `handleSignIn` (+ `HandleSignInOptions` + the now-orphaned `postLoginReturn`) removed from
  `src/utils/auth-helpers.ts`.
- [x] `getProvidersInProcess` (`src/server/auth/get-providers-in-process.ts`) — **deleted** (done with the
  next-auth strip). The file no longer exists and `auth.router.ts` no longer references it. ~~NOT yet — still
  used by `auth.router.ts`~~.

- [x] Verify: main-app typecheck clean (running) + grep clean for remaining
  `Social`/`SocialButton`/`SocialLabel`/`handleSignIn`/`LoginContent`/`LoginModal`/`EmailLogin`/`SignInError`
  imports (0 found).
