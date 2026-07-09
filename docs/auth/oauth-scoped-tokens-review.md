# OAuth & Scoped Tokens — Review Checklist

Items that need human review, testing, or validation before this feature is production-ready.

---

## UI Components to Review

### API Key Management (Phase 1)

- [ ] **ApiKeyModal** — New scope selection UI
  - [ ] Preset dropdown works (Read Only / Creator / AI Services / Full Access)
  - [ ] Permissions table shows correct checkboxes per resource
  - [ ] Selecting a preset fills checkboxes correctly
  - [ ] Customizing checkboxes after preset selection works
  - [ ] Created key has correct `tokenScope` bitmask
  - [ ] Old keys still work (backward compat)
- [ ] **ApiKeysCard** — Updated key list
  - [ ] Shows scope summary badge per key (Full Access / Read Only / Custom / etc.)
  - [ ] Shows `lastUsedAt` date for keys that have been used
  - [ ] Delete still works

### OAuth Consent Page (Phase 2)

- [ ] **`/login/oauth/authorize`** — Consent screen
  - [ ] Shows app name and description (not raw client_id)
  - [ ] Lists requested scopes in human-readable form
  - [ ] "Verified by Civitai" badge shows for verified apps
  - [ ] "Remember my decision" checkbox works
  - [ ] Approve redirects back to client with auth code
  - [ ] Deny redirects back with `error=access_denied`
  - [ ] Unauthenticated users redirected to login first

### Developer Portal (Phase 2) — NOT YET BUILT

- [ ] Page at `/user/account/developers` or tab in account settings
- [ ] Register new OAuth app form
- [ ] List/edit/delete apps
- [ ] Rotate client secret
- [ ] Show client ID + secret (once)

### Connected Apps (Phase 3) — NOT YET BUILT

- [ ] Page at `/user/account#connected-apps`
- [ ] List authorized apps with revoke button

---

## Backend Validation

### Phase 1: Scoped Token Enforcement

#### Database

- [ ] Run migration `20260410124247_add_token_scope_to_api_key`
  - Adds `tokenScope INT NOT NULL DEFAULT 33554431` and `lastUsedAt` to ApiKey
- [ ] Verify all existing keys have `tokenScope = 33554431` (Full)

#### Scope Enforcement

- [ ] **Test: Full-scope API key can access everything** (existing behavior preserved)
  - Create a key with Full scope → all tRPC procedures work as before
- [ ] **Test: Scoped key is restricted**
  - Create a key with only `ModelsRead` scope → can call `model.getById` → cannot call `model.upsert`
- [ ] **Test: Scoped key blocked on un-annotated endpoints**
  - A key with any non-Full scope hitting an un-annotated procedure gets 403
- [ ] **Test: Session auth (cookie) always has Full scope**
  - Browser users are never restricted by token scopes
- [ ] **Test: lastUsedAt updates**
  - Use an API key → `lastUsedAt` column updates (debounced to ~1 hour)

#### /api/v1/me endpoint

- [ ] With a scoped API key, response includes `tokenScope` field
- [ ] With a Full-scope key or session cookie, `tokenScope` is NOT included
- [ ] Orchestrator continues to work with existing keys

### Phase 2: OAuth Server

#### Database

- [ ] Run migration `20260410140011_add_oauth_tables`
  - Creates OauthClient, OauthConsent tables
  - Adds Access/Refresh to ApiKeyType enum
  - Adds clientId FK to ApiKey

#### OAuth Flow (end-to-end)

- [ ] **Register a test client** via tRPC `oauthClient.create`
  - Record client_id and client_secret
- [ ] **Authorization Code + PKCE flow**:
  1. Generate PKCE code_verifier + code_challenge (S256)
  2. GET `/api/auth/oauth/authorize?client_id=X&redirect_uri=Y&response_type=code&scope=Z&state=random&code_challenge=C&code_challenge_method=S256`
  3. Should redirect to consent page (first time)
  4. Approve → redirects to redirect_uri with `?code=ABC&state=random`
  5. POST `/api/auth/oauth/token` with `grant_type=authorization_code&code=ABC&client_id=X&client_secret=S&code_verifier=V&redirect_uri=Y`
  6. Response should include `access_token` (prefixed `civitai_`), `refresh_token`, `expires_in`, `scope`
- [ ] **Access token works as bearer token**
  - `Authorization: Bearer civitai_XXX` → authenticated, scoped requests work
- [ ] **Refresh token flow**
  - POST `/api/auth/oauth/token` with `grant_type=refresh_token&refresh_token=RT&client_id=X&client_secret=S`
  - Get new access + refresh tokens, old ones revoked
- [ ] **UserInfo endpoint**
  - GET `/api/auth/oauth/userinfo` with bearer token → returns user profile
  - Without `UserRead` scope → 403
- [ ] **Token revocation**
  - POST `/api/auth/oauth/revoke` with token → returns 200
  - Token no longer works after revocation
- [ ] **Security checks**:
  - [ ] PKCE required — request without code_challenge is rejected
  - [ ] State required — request without state is rejected
  - [ ] Invalid client_secret for confidential client → rejected
  - [ ] Wrong redirect_uri → rejected
  - [ ] Expired auth code → rejected
  - [ ] Expired access token → rejected
  - [ ] Consent remembered — second auth for same client+scope skips consent page

---

## Items Deferred to Later

These are noted but not blocking the current implementation:

- **Phase 1.8**: Drop old `scope KeyScope[]` column — wait until new system is validated in production
- **Phase 2.11**: Developer portal UI page — tRPC router exists, need the React page
- **Phase 2.12**: Rate limiting on OAuth endpoints — operational hardening
- **Phase 2.13**: Audit logging for OAuth events — operational hardening
- **Phase 2.14**: Per-key buzz spend limits — separate feature
- **Phase 2.15**: Per-client CORS origin restrictions — future enhancement
- **Phase 3**: Connected apps page — user management UI
- **Phase 4**: Client credentials flow, device auth, OIDC discovery, developer docs
