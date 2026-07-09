# OAuth Server & Scoped Tokens Plan

## Context

Civitai needs a proper OAuth authorization server so third-party sites can implement "Log in with Civitai" and eventually "Publish to Civitai" capabilities. PR #1313 started this work ~2 years ago but was put on hold. The existing API key system has `KeyScope` (Read/Write/Generate) defined in the schema but **never enforced** — any API key has full access to everything the user can do.

This plan covers:

1. **Scoped tokens** — enforce granular permissions on all API keys and OAuth tokens
2. **OAuth server** — built fresh, using PR #1313 as reference for architecture decisions
3. **Token management** — improve the user-facing token experience
4. **Third-party integrations** — enable "Publish to Civitai", open-source frontends, and agent delegation

### Long-term direction

Eventually, the OAuth system should become the primary auth mechanism for all Civitai clients — including first-party apps (mobile, extensions, subdomains). This would allow us to retire NextAuth over time. For now, NextAuth sessions continue to work for the main web app, but all new clients should use OAuth.

---

## Current State

### What We Have

- **API keys**: Stored as SHA-512 hashes in `ApiKey` table. Users create them via account settings with a name and scope selection (Read/Write/Generate). Keys are validated in `getSessionFromBearerToken()` → `getSessionUser()`.
- **Scopes exist but aren't enforced**: The `KeyScope` enum has `Read`, `Write`, `Generate`, but no middleware or tRPC procedure checks these values against the operation being performed.
- **NextAuth sessions**: JWT-based, 30-day max, tracked per-token in Redis with invalidation support. Currently used for subdomains too via shared session cookies.
- **Token infrastructure**: `key-generator.ts` handles generation (32-char hex) and hashing (SHA-512 + NEXTAUTH_SECRET salt).
- **Orchestrator integration**: Hidden API keys are created for users to authenticate directly with the orchestrator for generation. Third-party clients should be able to do the same via OAuth tokens.
- **Flags utility**: Existing `Flags` class in `src/shared/utils/flags.ts` provides all bitwise operations (hasFlag, addFlag, removeFlag, intersects, etc.) — already used for NSFW levels and other systems.

### What PR #1313 Established (Reference Only)

The branch is too far behind to merge, but the architecture is sound and worth referencing:

- `OauthClient` table (id, secret, name, redirectUris, grants, userId)
- `ApiKeyType` expanded with `Access` and `Refresh` types
- Authorization code flow using `@node-oauth/oauth2-server`
- Auth codes stored in Redis, tokens as `ApiKey` rows
- Consent page at `/login/oauth/authorize`

### Critical Issues Found in PR #1313 (to avoid when rebuilding)

1. **Client secret never validated** — `getClient()` ignores the `clientSecret` parameter
2. **No PKCE** — vulnerable to code interception (required by OAuth 2.1)
3. **No scope validation** — `validateScope` is commented out
4. **Redis expiry bug** — expiry set on raw code field but stored under hashed key
5. **No CSRF protection** — `allowEmptyState: true`
6. **Consent screen shows raw client_id** instead of app name
7. **Token response includes PII** — should use separate userinfo endpoint
8. **Unique index on ApiKey.key dropped** inconsistently between migration and schema

---

## Proposed Scope System

### Design Principles

- Scopes are **hierarchical**: `models:write` implies `models:read`
- Scopes are **resource-based**: tied to what you're accessing, not how
- Every tRPC procedure gets a required scope annotation — aim for **full coverage from day one**
- API keys and OAuth tokens both use the same scope system
- Backward compatible: existing API keys + internally-created keys get `Full` scope
- Scopes stored as a **bitwise integer** (single `Int` column) for efficiency — fits the existing `Flags` pattern

### Scope Definitions (Bitwise Flags)

```typescript
enum TokenScope {
  None = 0,

  // Account & Profile
  UserRead = 1 << 0, // 1       — Read own profile, settings, preferences
  UserWrite = 1 << 1, // 2       — Update profile, settings, preferences

  // Models & Resources
  ModelsRead = 1 << 2, // 4       — Browse, search, download models
  ModelsWrite = 1 << 3, // 8       — Upload, edit, publish, unpublish models
  ModelsDelete = 1 << 4, // 16      — Delete own models

  // Media & Posts (images, videos, posts — tightly coupled)
  MediaRead = 1 << 5, // 32      — View images, videos, posts, galleries
  MediaWrite = 1 << 6, // 64      — Upload images/videos, create/edit posts
  MediaDelete = 1 << 7, // 128     — Delete own media/posts

  // Articles
  ArticlesRead = 1 << 8, // 256     — Read articles
  ArticlesWrite = 1 << 9, // 512     — Create/edit articles
  ArticlesDelete = 1 << 10, // 1024    — Delete own articles

  // Bounties (write implicitly allows buzz spend for bounty creation)
  BountiesRead = 1 << 11, // 2048    — View bounties and entries
  BountiesWrite = 1 << 12, // 4096    — Create/edit bounties, submit entries
  BountiesDelete = 1 << 13, // 8192    — Delete own bounties

  // AI Services (generation, training, scanning — all orchestrator requests)
  // Write implicitly allows buzz spend for orchestrator usage
  AIServicesRead = 1 << 14, // 16384   — View generation/training history
  AIServicesWrite = 1 << 15, // 32768   — Generate, train, scan via orchestrator

  // Buzz (Currency)
  BuzzRead = 1 << 16, // 65536   — View buzz balance and transaction history

  // Collections & Interactions
  CollectionsRead = 1 << 17, // 131072  — View own collections
  CollectionsWrite = 1 << 18, // 262144  — Create/edit collections, add/remove items
  SocialWrite = 1 << 19, // 524288  — Follow, react, comment, review
  SocialTip = 1 << 20, // 1048576 — Tip other users (buzz spend for tips)

  // Notifications
  NotificationsRead = 1 << 21, // 2097152  — Read notifications
  NotificationsWrite = 1 << 22, // 4194304  — Mark read, update preferences

  // Vault
  VaultRead = 1 << 23, // 8388608   — View vault contents
  VaultWrite = 1 << 24, // 16777216  — Add/remove vault items

  // Convenience composites
  Full = (1 << 25) - 1, // All bits set — full access
}
```

**25 scopes, fits in 32-bit integer** with 7 spare bits for future expansion.

**Key design notes:**

- **`Full`** is a single value (all bits set) — used as the default for existing keys, session auth, and internally-created keys. Avoids needing to enumerate all scopes.
- **Buzz spend is implicit**, not a standalone scope:
  - `AIServicesWrite` — implicitly spends buzz for generation, training, scanning
  - `BountiesWrite` — implicitly spends buzz for bounty creation
  - `SocialTip` — dedicated scope for tipping (buzz spend on tips)
- **`MediaRead/Write/Delete`** covers images, videos, AND posts (they're tightly coupled)
- **`AIServicesRead/Write`** covers all orchestrator operations: generation, training, scanning, and anything else added to orchestration
- Adding a new scope is just adding a new bit position and a migration to update `Full`

### Scope Bundles (Convenience Presets)

The API key UI uses a preset dropdown that populates a permissions table. The table has columns for **Read**, **Write**, and **Delete**, with rows for each resource category. Selecting a preset fills in the checkboxes, but users can customize from there.

| Preset          | Flags                                                                                                                                                    | Use Case                   |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------- |
| **Read Only**   | `UserRead \| ModelsRead \| MediaRead \| ArticlesRead \| BountiesRead \| BuzzRead \| CollectionsRead \| AIServicesRead \| NotificationsRead \| VaultRead` | Analytics, dashboards      |
| **Creator**     | Read Only + `ModelsWrite \| MediaWrite \| ArticlesWrite \| BountiesWrite \| CollectionsWrite \| SocialWrite`                                             | Publishing tools           |
| **AI Services** | `AIServicesWrite \| AIServicesRead \| BuzzRead`                                                                                                          | Generation/training agents |
| **Full Access** | `Full`                                                                                                                                                   | Personal automation        |

These presets are defined in code as constants, not in the database.

### Per-Key Spend Limits

For any key with buzz-spending scopes (`AIServicesWrite`, `BountiesWrite`, `SocialTip`), users can set spending caps:

- Daily / weekly / monthly buzz limit
- Stored on the `ApiKey` record
- Enforced at both:
  1. **Civitai middleware layer** — before processing buzz transactions via tRPC
  2. **Orchestrator** — checks against the `/api/v1/me` endpoint response (see Orchestrator Integration section)
- Especially important for agent delegation tokens

### Scope Enforcement Architecture

Scope enforcement focuses on **tRPC procedures** — the v1 REST APIs are read-only/public and don't need scoped access.

```
Request (Bearer token)
  → getSessionFromBearerToken()
    → look up ApiKey, load scope bitmask
    → attach scope to session context
  → tRPC procedure middleware
    → Flags.hasFlag(session.scope, procedure.requiredScope)
    → reject with 403 if missing
```

**Implementation approach:**

- Add a `requiredScope` field to tRPC procedure metadata
- Create a `scopedProcedure` wrapper (or extend existing `protectedProcedure`)
- The middleware reads `ctx.session.scope` and checks via `Flags.hasFlag()`
- For session auth (browser/NextAuth), treat as `Full` (no restrictions)
- **Aim for full scope coverage immediately** — annotate all tRPC procedures with their required scope from the start
- All existing API keys and internally-created keys (e.g., generation service keys) get `Full` scope so nothing breaks

### Updating Internal Key Creation

Currently, hidden API keys are created for orchestrator/generation use. These need to be updated to include the appropriate scope (`AIServicesWrite | AIServicesRead | BuzzRead` at minimum, or `Full` to maintain current behavior). Need to audit all places that call `addApiKey` or create keys programmatically.

---

## OAuth Server Design

### Start Fresh, Reference PR #1313

The PR #1313 branch is too far behind to merge. We'll build from scratch on `main`, keeping the same architectural decisions that were sound (auth codes in Redis, tokens as ApiKey rows, `@node-oauth/oauth2-server` library).

### OAuth Flows to Support

| Flow                          | Use Case                                                | Priority |
| ----------------------------- | ------------------------------------------------------- | -------- |
| **Authorization Code + PKCE** | Web apps, open-source frontends ("Log in with Civitai") | P0       |
| **Refresh Token**             | Long-lived sessions                                     | P0       |
| **Client Credentials**        | Server-to-server (trusted partners)                     | P1       |
| **Device Authorization**      | CLI tools, agents                                       | P2       |

**Key use case — open-source frontends**: Third-party or community-built UIs (e.g., custom generation interfaces) where:

1. User authorizes via OAuth, token stored in browser localStorage
2. Frontend calls Civitai tRPC/API directly with the token
3. Frontend can also call orchestrator directly using the token (same pattern as our hidden API keys for generation)

This means the OAuth token must be usable anywhere our current API keys work, including direct orchestrator auth.

**Public clients (frontend-only, no server)**: The standard approach per OAuth 2.1 is PKCE-only authorization code flow with no client secret. The client is registered as `isConfidential: false`, and PKCE alone provides the security. Short-lived access tokens (1 hour) + refresh tokens ensure tokens in localStorage don't stay valid forever.

### Key Components

#### 1. Client Registration & Management

**Database: `OauthClient` table**

```
id              TEXT PK (UUID)
secret          TEXT (hashed, like API keys — null for public clients)
name            TEXT
description     TEXT
logoUrl         TEXT?
redirectUris    TEXT[]
grants          TEXT[] (authorization_code, refresh_token, client_credentials)
allowedScopes   INT (bitmask — max scopes this client can request)
isConfidential  BOOLEAN (public vs confidential client)
userId          INT FK → User (developer who registered it)
isVerified      BOOLEAN (Civitai-reviewed apps get verified badge on consent)
createdAt       TIMESTAMP
updatedAt       TIMESTAMP
```

**Developer Portal (new page: `/user/account/developers`)**

- Register new OAuth apps (open registration — no approval required)
- View/edit app details, redirect URIs
- Rotate client secrets
- View usage stats (active tokens, total authorizations)

#### 2. Authorization Endpoint (`/api/auth/oauth/authorize`)

- Validate `client_id`, `redirect_uri`, `response_type`, `scope`, `state`
- **Require PKCE**: `code_challenge` + `code_challenge_method` (S256 required)
- **Require state**: CSRF protection mandatory
- Redirect to consent page if user hasn't previously authorized this client+scope combo

#### 3. Consent Page (`/login/oauth/authorize`)

- Show app name, logo, description (not raw client_id)
- List requested scopes in human-readable form
- Show "Verified by Civitai" badge for reviewed apps
- "Remember this decision" checkbox for trusted apps
- Store consent records in `OauthConsent` table to skip re-authorization

#### 4. Token Endpoint (`/api/auth/oauth/token`)

- **Validate client secret** for confidential clients
- **Validate PKCE code_verifier** against stored code_challenge
- Issue access token (1 hour expiry) and refresh token (30 days)
- Store as `ApiKey` rows with `type: Access/Refresh` and scope bitmask
- **Do not include PII in token response** — use userinfo endpoint

#### 5. UserInfo Endpoint (`/api/auth/oauth/userinfo`) — NEW

- Standard OpenID Connect-style endpoint
- Returns user profile based on token scopes
- `UserRead` scope required

#### 6. Token Revocation (`/api/auth/oauth/revoke`) — NEW

- RFC 7009 compliant
- Revoke access or refresh tokens
- Also revoke from user's token management page

### Security Requirements

- **PKCE required** for all authorization code grants (not optional)
- **Client secret validation** for confidential clients
- **State parameter required** (CSRF protection)
- **Redirect URI exact match** (no wildcards)
- **Rate limiting** on token endpoint
- **Short-lived access tokens** (1 hour, not 7 days like in PR #1313)
- **Token rotation on refresh** — old access token revoked when new one is issued
- Audit log for all OAuth events (authorization, token issue, revoke)

---

## Token Management Improvements

### Updated API Key UI (`/user/account#api-keys`)

**Current**: Name + scope multi-select (Read/Write/Generate)
**Proposed**:

- Name field
- Preset dropdown (Read Only / Creator / Generator / Full Access)
- Permissions table: rows = resource categories, columns = Read / Write / Delete
  - Preset fills checkboxes, user can customize
  - `Generate` maps to "Write" column conceptually
- Optional expiration date picker
- Optional buzz spend limit (daily/weekly/monthly)
- Show last used timestamp in the key list
- Show scopes summary per key

### New: Connected Apps Page (`/user/account#connected-apps`)

- List all third-party apps the user has authorized via OAuth
- Show app name, logo, granted scopes, authorization date
- Revoke access per app (deletes all tokens for that client)
- View activity log per app

### Database Changes

**`ApiKey` table updates:**

```
+ scope       Int           (bitmask, default = Full. Replaces old KeyScope[] enum)
+ clientId    TEXT? FK      (which OAuth client issued this, null for user-created)
+ lastUsedAt  TIMESTAMP?   (track usage)
+ buzzLimit   JSON?        ({ daily?: number, weekly?: number, monthly?: number })
```

**Migration strategy for existing keys:**

- All existing keys get `Full` scope (single integer value with all bits set)
- Default column value is `Full` so keys created during rollout work correctly against prod database
- Old `scope KeyScope[]` column dropped after migration
- Audit all internal key creation (generation service, etc.) to ensure they set appropriate scopes

**New tables:**

```sql
CREATE TABLE "OauthClient" (
  -- as described above
);

CREATE TABLE "OauthConsent" (
  id          SERIAL PK,
  "userId"    INT FK → User,
  "clientId"  TEXT FK → OauthClient,
  scope       INT,  -- bitmask of consented scopes
  "createdAt" TIMESTAMP DEFAULT now(),
  "updatedAt" TIMESTAMP DEFAULT now(),
  UNIQUE("userId", "clientId")
);
```

---

## Publishing API

For the "Publish to Civitai" use case, third-party clients need to create posts with images, upload models, etc. The primary use case is publishing images/posts.

### Approach: tRPC for now, v2 later

External clients call existing tRPC endpoints directly via their OAuth tokens. This works once OAuth + scopes ship. Future v2 API would be a cleaner REST surface hitting the service layer directly — potentially as a separate API server rather than more endpoints in this Next.js project.

---

## Implementation Phases

### Phase 1: Scoped Token Enforcement (Foundation)

**Goal**: Make token scopes actually enforced. Ship the new scope system.

1. Define `TokenScope` bitwise enum in `src/shared/constants/token-scopes.ts`
2. Add `scope Int @default(Full)` column to `ApiKey` table
   - Default to `Full` so all new keys (including ones created against prod DB during development) work correctly
3. Migrate existing keys: all get `Full` scope
4. Audit all internal key creation (generation service keys, etc.) — ensure they set correct scopes
5. Add scope to tRPC procedure metadata: `.meta({ requiredScope: TokenScope.ModelsWrite })`
6. Create middleware that checks `Flags.hasFlag(ctx.session.scope, procedure.requiredScope)`
7. For session auth (browser/NextAuth), treat as `Full` (no restrictions)
8. Annotate **all** tRPC procedures with required scopes from the start
9. Update API key creation UI with preset dropdown + permissions table
10. Add `lastUsedAt` tracking
11. Drop old `KeyScope` enum and `scope` column after migration
12. Identify orchestrator permission-check endpoint and include per-key spend limits

### Phase 2: OAuth Server (Core)

**Goal**: Ship a working, secure OAuth authorization code flow.

1. Create `OauthClient` and `OauthConsent` tables + migration
2. Implement OAuth server from scratch using `@node-oauth/oauth2-server`
3. Build authorization, token, userinfo, and revocation endpoints
4. Build consent page with proper app display
5. Build developer portal for client registration
6. Add rate limiting on token endpoint
7. Add audit logging
8. Add per-key buzz spend limits (UI + enforcement)

### Phase 3: Connected Apps & Management

**Goal**: Give users full control over their tokens and authorized apps.

1. Build Connected Apps page
2. Add token activity tracking
3. Build app usage dashboard for developers

### Phase 4: Advanced Flows & Integrations

**Goal**: Enable open-source frontends, CLI tools, and agent delegation.

1. Implement Client Credentials flow (open-source frontends, trusted partners)
2. Implement Device Authorization flow (CLI tools, agents)
3. Agent delegation tokens with spend caps
4. OpenID Connect Discovery (`.well-known/openid-configuration`)

---

## Decisions Made

| Question               | Decision                                                                                                                           |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| Scope granularity      | media (images+videos+posts) together, articles separate, bounties separate                                                         |
| Buzz spending          | Implicit — `AIServicesWrite` for orchestrator, `BountiesWrite` for bounties, `SocialTip` for tips. No standalone `BuzzSpend` scope |
| Tips                   | Dedicated `SocialTip` scope, separate from `SocialWrite`                                                                           |
| AI services            | `AIServicesRead/Write` covers all orchestrator ops (generation, training, scanning, etc.)                                          |
| Existing API keys      | Grandfathered with `Full` scope                                                                                                    |
| OAuth app registration | Open — anyone can register freely                                                                                                  |
| Scope storage          | **Bitwise flags** (single Int column) — matches existing `Flags` pattern, efficient, easy to extend                                |
| OAuth branch           | Start fresh on main, use PR #1313 as reference                                                                                     |
| First-party apps       | Should use OAuth eventually (retire NextAuth long-term)                                                                            |
| Publishing API         | tRPC for now, v2 service-layer API later (possibly separate server)                                                                |
| Scope rollout          | Full coverage from day one, not incremental                                                                                        |
| Default scope value    | `Full` — safe for prod DB development, single value for "everything on"                                                            |
| Public clients         | PKCE-only auth code flow, no client secret, standard OAuth 2.1 approach                                                            |
| Token prefix           | `civitai_` prefix on OAuth tokens for distinguishability                                                                           |
| Consent UX             | All-or-nothing — user accepts all requested scopes or declines                                                                     |
| CORS                   | OAuth token endpoint needs permissive CORS; per-client origin restrictions are future work                                         |
| Developer docs         | Static markdown page on the site                                                                                                   |

## Orchestrator Integration

**Resolved**: The orchestrator checks user permissions via the `/api/v1/me` endpoint (`src/pages/api/v1/me.ts`). It doesn't do anything special with key types — it just calls this endpoint with the API key as a bearer token and uses the response to determine what the user can do.

**Current response shape:**

```json
{
  "id": 123,
  "username": "user",
  "tier": "member",
  "status": "active",
  "isMember": true,
  "subscriptions": ["gold"]
}
```

**What we need to add** (when the request is authenticated via API key, not session):

```json
{
  ...existing fields,
  "tokenScope": 33554431,      // bitmask of allowed scopes
  "buzzLimit": {                // per-key spend limits (null if no limits)
    "daily": 5000,
    "weekly": null,
    "monthly": 50000
  }
}
```

The `AuthedEndpoint` helper already resolves the session from either a cookie or bearer token. We need to:

1. Pass the `ApiKey` record (not just the user) through to the handler when auth is via bearer token
2. Include `tokenScope` and `buzzLimit` from the ApiKey in the response
3. The orchestrator can then check `Flags.hasFlag(tokenScope, TokenScope.Generate)` and enforce spend limits on its side

This means OAuth access tokens (which are stored as ApiKey rows) will work transparently with the orchestrator — no special handling needed.

---

## Addendum: OIDC `id_token` via the `@civitai/auth` hub (2026-06-09)

**Context:** the OAuth server above made Civitai an OAuth2 provider + a *userinfo-based* pseudo-OIDC IdP — third parties get a code → access token → `/userinfo`. To match "Sign in with Google" exactly (a signed `id_token` the relying party verifies locally via JWKS, no userinfo round-trip), the only missing piece was a **signing key + JWKS**. The centralized-auth hub work ([centralized-auth-app.md](./centralized-auth-app.md), [auth-verification-strategy.md](./auth-verification-strategy.md)) provides exactly that — the same RS256 hub key + `/api/auth/jwks` endpoint serve both first-party session JWTs and third-party id_tokens.

**What landed (opt-in, off unless the hub RS256 keys are set):**

- `@civitai/auth` signer gained `mintIdToken({ sub, aud, nonce, authTime, claims?, expiresIn? })` — RS256, `iss = AUTH_JWT_ISSUER` (must equal the discovery `issuer` / `NEXTAUTH_URL`).
- **`nonce`/`auth_time` capture** — [`src/server/oauth/oidc-nonce.ts`](../../src/server/oauth/oidc-nonce.ts) stashes them in a packed Redis hash (`REDIS_KEYS.OAUTH.OIDC_CONTEXT`, sha256(code) field, `AUTH_CODE_TTL`) at `/authorize`; `/token` consumes by `code`. @node-oauth doesn't carry nonce through the grant, hence the side channel.
- **`/oauth/token`** now returns a signed `id_token` on the `authorization_code` grant when `UserRead` (identity) scope is granted and the signer is configured. Profile/email claims are intentionally omitted — RPs fetch them from the existing `/userinfo`.
- **Discovery** advertises `jwks_uri` + `id_token_signing_alg_values_supported: ['RS256']`, but **only when signing is enabled** (else the JWKS 404s, so claiming RS256 would lie to RPs).

**Design decisions:**

- **Access tokens stay opaque/DB-backed** (the `ApiKey`-row model above) for **instant revocation** of untrusted clients. Only the **`id_token` is a JWT.** This is Google's split — and the deliberate inverse of the first-party session, which is a stateless JWT for performance.
- **Trigger = `UserRead` scope** (always forced on at `/authorize`), not a literal `openid` scope (the scope system is bitwise, no `openid` bit). A dedicated `openid` marker scope is the spec-pure alternative if we want to *not* issue id_tokens to pure-API code grants.

**Open follow-ups:**

- `.well-known/jwks.json` rewrite (currently served at `/api/auth/jwks`; some RP libraries assume the `.well-known` path).
- Optionally fold profile/email claims into the id_token (gated by scope) to save the `/userinfo` round-trip.
- `at_hash` claim (OIDC §3.1.3.6) if any RP validates it.
- A dedicated `openid` scope if we want to gate id_token issuance to OIDC clients specifically.
