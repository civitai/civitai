# OAuth & Scoped Tokens — Implementation Checklist

Reference: [oauth-scoped-tokens.md](./oauth-scoped-tokens.md)
Review: [oauth-scoped-tokens-review.md](./oauth-scoped-tokens-review.md)

---

## Phase 1: Scoped Token Enforcement

### 1.1 Define Token Scopes

- [x] Create `src/shared/constants/token-scope.constants.ts` with `TokenScope` bitwise enum
  - [x] All 25 scopes as powers of 2
  - [x] `Full` composite value `(1 << 25) - 1`
  - [x] Scope preset constants (ReadOnly, Creator, AIServices, FullAccess)
  - [x] Human-readable label map for each scope (for UI display)
  - [x] Scope-to-column mapping for the permissions table UI (Read / Write / Delete groupings)

### 1.2 Database Migration

- [x] Add `tokenScope Int @default(33554431)` column to `ApiKey` table (default = `Full`)
- [x] Backfill all existing `ApiKey` rows with `Full` scope value (via NOT NULL DEFAULT)
- [x] Add `lastUsedAt DateTime?` column to `ApiKey` table
- [x] Keep old `scope KeyScope[]` column temporarily (remove in Phase 1.8)
- [x] Run migration against dev/staging, verify no breakage

### 1.3 Scope Enforcement Middleware

- [x] Extend tRPC meta type to include `requiredScope: number` field
- [x] Create scope-checking middleware in `src/server/trpc.ts`
  - [x] Read `ctx.tokenScope` bitmask
  - [x] Check `Flags.hasFlag(tokenScope, procedure.requiredScope)`
  - [x] Return 403 with clear error message if scope missing
  - [x] Session auth (NextAuth cookies) always treated as `Full`
  - [x] Fail-safe: scoped tokens denied on un-annotated endpoints
- [x] Update `getSessionFromBearerToken()` to load `tokenScope` from `ApiKey` record
- [x] Attach `tokenScope` to the tRPC context object so middleware can read it

### 1.4 Annotate All tRPC Procedures (~767 procedures, 83 routers)

- [x] All 83 routers annotated with `.meta({ requiredScope: TokenScope.X })`
- [x] Reviewed by 3 external models (Gemini 2.5 Pro, Gemini 3.1 Pro, GPT 5.1 Codex)
- [x] Fail-open vulnerability identified and fixed (now fail-safe)
- [x] `user.getToken` elevated to `Full` scope (prevents token minting via limited key)

### 1.5 Audit Internal Key Creation

- [x] Search all calls to `addApiKey` / key creation in services
- [x] Identify hidden generation/orchestrator keys — all use `type: 'System'` with `scope: ['Generate']`
- [x] Verify: internal keys get `Full` tokenScope via DB column default — no changes needed
- [x] Callers audited: `orchestrator-key.ts`, `get-orchestrator-token.ts`, `admin/orchestrator/timings.ts`, `admin/orchestrator/index.ts`

### 1.6 Update `/api/v1/me` Endpoint

- [x] Modify the me handler to access tokenScope from req.context
- [x] Add `tokenScope` (bitmask) to response when authenticated via scoped API key
- [x] Add `buzzLimit` to response when authenticated via API key

### 1.7 Update API Key UI

- [x] Update `ApiKeyModal.tsx` — replace old scope multi-select with:
  - [x] Preset dropdown (Read Only / Creator / AI Services / Full Access)
  - [x] Permissions table (rows = resource categories, columns = Read / Write / Delete)
  - [x] Preset selection fills checkboxes, user can customize
- [x] Update `ApiKeysCard.tsx` — show scope summary badge and last used date per key
- [x] Update `addApiKey` mutation to accept new scope bitmask
- [x] Update `api-key.schema.ts` validation for new scope format
- [ ] Optional expiration date picker on key creation (deferred — nice to have)

### 1.8 Cleanup (deferred until validated in production)

- [ ] Drop old `scope KeyScope[]` column from `ApiKey` table
- [ ] Remove `KeyScope` enum from Prisma schema
- [ ] Remove old scope references from service/controller code
- [ ] Update any tests referencing old scope format

### 1.9 `lastUsedAt` Tracking

- [x] Update `getSessionFromBearerToken()` to fire async `lastUsedAt` update
- [x] Use debounced update — at most once per hour per key (fire-and-forget)
- [x] Display `lastUsedAt` in API key list UI

---

## Phase 2: OAuth Server

### 2.1 Install Dependencies

- [x] Add `@node-oauth/oauth2-server` package
- [x] Verify compatibility with current Node.js version

### 2.2 Database — OAuth Tables

- [x] Create `OauthClient` table migration
  - [x] `id` TEXT PK (UUID)
  - [x] `secret` TEXT (hashed, nullable for public clients)
  - [x] `name` TEXT
  - [x] `description` TEXT
  - [x] `logoUrl` TEXT?
  - [x] `redirectUris` TEXT[]
  - [x] `grants` TEXT[]
  - [x] `allowedScopes` Int (bitmask)
  - [x] `isConfidential` Boolean
  - [x] `userId` Int FK → User
  - [x] `isVerified` Boolean default false
  - [x] `createdAt` / `updatedAt` timestamps
- [x] Create `OauthConsent` table migration
  - [x] `id` Serial PK
  - [x] `userId` Int FK → User
  - [x] `clientId` TEXT FK → OauthClient
  - [x] `scope` Int (bitmask of consented scopes)
  - [x] `createdAt` / `updatedAt` timestamps
  - [x] Unique constraint on (userId, clientId)
- [x] Add `ApiKeyType` enum values: `Access`, `Refresh` (keep existing `System`, `User`)
- [x] Add `clientId TEXT?` FK column to `ApiKey` table
- [x] Add Prisma models and relations
- [x] Run migration

### 2.3 OAuth Server Model

- [x] Create `src/server/oauth/model.ts`
  - [x] `getClient(clientId, clientSecret)` — fetch client, **validate secret hash** for confidential clients
  - [x] `saveAuthorizationCode(code, client, user)` — store in Redis with hashed key, set expiry correctly
  - [x] `getAuthorizationCode(code)` — fetch from Redis by hashed key
  - [x] `revokeAuthorizationCode(code)` — delete from Redis
  - [x] `saveToken(token, client, user)` — create ApiKey rows (Access + Refresh), hash tokens, set scope bitmask
  - [x] `getAccessToken(accessToken)` — look up ApiKey by hashed token, check type = Access
  - [x] `getRefreshToken(refreshToken)` — look up ApiKey by hashed token, check type = Refresh
  - [x] `revokeToken(token)` — delete ApiKey row, also revoke associated access token
  - [x] `validateScope(user, client, scope)` — check requested scope against client's `allowedScopes`
  - [x] `verifyScope(token, scope)` — check token's scope bitmask via `Flags.hasFlag()`
- [x] Token prefix: prepend `civitai_` to generated OAuth tokens for distinguishability
- [x] Access token lifetime: 1 hour
- [x] Refresh token lifetime: 30 days
- [x] Auth code lifetime: 10 minutes

### 2.4 OAuth Server Instance

- [x] Create `src/server/oauth/server.ts` — instantiate OAuth2Server with model
- [x] Configure `allowEmptyState: false`
- [x] PKCE (S256) validated in authorize endpoint before issuing codes

### 2.5 Authorization Endpoint

- [x] Create `src/pages/api/auth/oauth/authorize.ts`
  - [x] Require authenticated user (NextAuth session)
  - [x] Validate `client_id`, `redirect_uri`, `response_type=code`, `scope`, `state`
  - [x] Validate PKCE `code_challenge` + `code_challenge_method=S256`
  - [x] Check `OauthConsent` — if user previously approved this client+scope, skip consent
  - [x] Otherwise redirect to consent page with query params
  - [x] Handle consent approval flow (save consent if "remember" checked)

### 2.6 Consent Page

- [x] Create `src/pages/login/oauth/authorize.tsx`
  - [x] Fetch client details (name, logo, description) by `client_id`
  - [x] Display requested scopes in human-readable form (uses tokenScopeLabels)
  - [x] Show "Verified by Civitai" badge if `isVerified`
  - [x] All-or-nothing: user accepts all requested scopes or declines entirely
  - [x] "Remember this decision" checkbox
  - [x] On approve: form POST to authorization endpoint with `approved=true` (CSRF-safe)
  - [x] On decline: redirect back to client with `error=access_denied`
  - [x] Handle unauthenticated users: redirect to login, then back to consent

### 2.7 Token Endpoint

- [x] Create `src/pages/api/auth/oauth/token.ts`
  - [x] Handle `grant_type=authorization_code` — validate code + PKCE `code_verifier`
  - [x] Handle `grant_type=refresh_token` — validate refresh token, rotate
  - [x] Validate client secret for confidential clients (via model)
  - [x] Return `{ access_token, token_type, expires_in, refresh_token, scope }`
  - [x] Do NOT return user PII in token response

### 2.8 UserInfo Endpoint

- [x] Create `src/pages/api/auth/oauth/userinfo.ts`
  - [x] Require valid access token with `UserRead` scope
  - [x] Return user profile: `{ sub, id, username, image }`

### 2.9 Token Revocation Endpoint

- [x] Create `src/pages/api/auth/oauth/revoke.ts`
  - [x] Accept `token` + `token_type_hint` (access_token or refresh_token)
  - [x] Require authentication (session or client credentials) before deletion
  - [x] Verify caller owns the token being revoked
  - [x] Delete the ApiKey row
  - [x] If revoking refresh token, also revoke all associated access tokens
  - [x] Always return 200 (per RFC 7009, even if token not found)
  - [x] Rate limited by IP (not client_id) to prevent bypass

### 2.10 Redis Key Setup

- [x] Add `OAUTH.AUTHORIZATION_CODES` key constant to Redis client
- [x] Auth codes stored as Redis hash: key = hashed code, value = JSON (client, user, scope, PKCE challenge, redirectUri)
- [x] Set expiry correctly on the hashed key (not the raw code — PR #1313 bug avoided)

### 2.11 Developer Portal

- [x] Create tRPC router: `oauth-client` with CRUD procedures
  - [x] `create` — register new client, generate ID + secret
  - [x] `getAll` — list user's clients
  - [x] `getById` — client details
  - [x] `update` — edit name, description, redirectUris, allowedScopes
  - [x] `rotateSecret` — generate new secret, hash and store
  - [x] `delete` — remove client + all associated tokens and consents
- [x] Developer portal UI as OAuthAppsCard on account page
  - [x] List user's registered OAuth apps
  - [x] "Register New App" form with scope selector
  - [x] Edit app details / rotate secret / delete
  - [x] Show client ID + secret (once, with copy button)

### 2.12 Rate Limiting

- [x] Add rate limit on token endpoint (20 req/min per client_id)
- [x] Add rate limit on authorization endpoint (10 req/min per user)
- [x] Add rate limit on revocation endpoint (20 req/min per client_id)
- [x] Rate limit headers (X-RateLimit-Limit, Remaining, Reset, Retry-After)

### 2.13 Audit Logging

- [x] Log OAuth events as structured JSON to stdout (for Axiom/log aggregation)
- [x] Events: client.created/updated/deleted/secret_rotated, authorization.granted, token.issued/refreshed/revoked

### 2.14 Per-Key Spend Limits

- [x] Add `buzzLimit JSONB` column to `ApiKey` table (migration)
- [x] Load buzzLimit in bearer token auth pipeline
- [x] Include buzzLimit in `/api/v1/me` response for orchestrator enforcement
- [ ] Add spend limit UI to API key creation/edit modal
- [ ] Create spend tracking mechanism (Redis counter per key, reset on period boundary)
- [ ] Enforce limits in buzz transaction middleware

### 2.15 CORS for OAuth Endpoints

- [x] Token endpoint has permissive CORS via `addCorsHeaders`
- [x] UserInfo and revocation endpoints have CORS
- [ ] Consider per-client CORS origin restrictions (future)

---

## Phase 3: Connected Apps & Management

### 3.1 Connected Apps Page

- [x] Create ConnectedAppsCard component on account page
  - [x] List all apps user has authorized (from `OauthConsent` + active tokens)
  - [x] Show: app name, verified badge, granted scopes badge, authorization date, active tokens
  - [x] "Revoke Access" button per app — deletes all tokens for that client + consent record
  - [x] Confirmation modal before revoking
  - [x] Auto-hides when no connected apps

### 3.2 Token Activity Tracking

- [x] `lastUsedAt` tracking on all API key usage (Phase 1.9)
- [x] Active token count shown in Connected Apps view
- [x] Active token + consent counts shown in developer portal per-app view

### 3.3 Developer Dashboard

- [x] In developer portal, per-app stats:
  - [x] Active token count
  - [x] Total authorizations (consent count)

---

## Phase 4: Advanced Flows & Integrations

### 4.1 Client Credentials Flow

- [x] Implement `getUserFromClient` in OAuth model
- [x] Only for confidential clients with `client_credentials` in `grants` array
- [x] Token scoped to client's `allowedScopes` (user = client owner)

### 4.2 Device Authorization Flow

- [x] Implement device authorization endpoint (`/api/auth/oauth/device`)
- [x] Implement device token polling endpoint (`/api/auth/oauth/device-token`)
- [x] Implement device approval endpoint (`/api/auth/oauth/device-approve`)
- [x] Device info endpoint (`/api/auth/oauth/device-info`) — look up app details by user code
- [x] Device verification page (`/login/oauth/device`) — two-step: enter code → review app name/scopes → approve/deny
- [x] Validates client grants array (`urn:ietf:params:oauth:grant-type:device_code`)
- [x] Validates scope against client's `allowedScopes` at both initiation and token exchange
- [x] Redis storage for device codes with TTL
- [x] Use case: CLI tools, headless agents

### 4.3 Agent Delegation Tokens

- [ ] Special token type for AI agents (deferred — uses standard OAuth tokens + spend limits for now)
- [ ] Additional rate limiting per agent token

### 4.4 OpenID Connect Discovery

- [x] Create `/api/.well-known/openid-configuration` endpoint
- [x] Publish authorization, token, userinfo, revocation, device endpoint URLs
- [x] Publish supported scopes, grant types, response types, code challenge methods

### 4.5 Developer Documentation

- [x] Create comprehensive developer guide (`docs/plans/oauth-developer-docs.md`) covering:
  - [x] Overview of Civitai OAuth
  - [x] Registering an app
  - [x] Authorization code + PKCE flow walkthrough with code examples
  - [x] Available scopes with bitmask values and common combinations
  - [x] Token lifecycle (access, refresh, revocation)
  - [x] UserInfo endpoint
  - [x] Device authorization flow
  - [x] Client credentials flow
  - [x] Rate limits and security best practices
- [ ] Publish as static page on the site (currently in docs/plans/)

---

## Security Hardening (from audits)

### Applied

- [x] Fail-safe middleware — scoped tokens denied on un-annotated endpoints
- [x] Consent bypass blocked — `approved=true` only accepted via POST
- [x] Redirect URI validated against registered URIs before use
- [x] Scope defaults to 0 (not Full) for missing/invalid values
- [x] Negative and overflow scope values rejected
- [x] Constant-time secret comparison (`crypto.timingSafeEqual`) in model + revoke
- [x] Device flow validates grants array and scope against allowedScopes
- [x] Revoke requires authentication, rate limited by IP
- [x] `user.getToken` requires Full scope (prevents token minting via limited key)
- [x] Public clients can refresh tokens (OAuth 2.1 compliant)
- [x] Shared `createOAuthTokenPair` helper prevents logic drift
- [x] `userinfo.ts` fails safe — defaults scope to 0 when missing

### Remaining (Low severity)

- [ ] Extract ScopeSelector component from OAuthAppsCard for reuse in ApiKeyModal
- [ ] OIDC `scopes_supported` uses numeric keys — consider human-readable names
- [ ] Device-approve CSRF (mitigated by SameSite=Lax cookies)
- [ ] Rate limit TOCTOU: `incr` + `expire` not atomic (use Lua script or SET NX EX)
