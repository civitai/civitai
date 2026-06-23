# Civitai OAuth — Developer Guide

## Overview

Civitai supports OAuth 2.0 for third-party applications to authenticate users and access the Civitai API on their behalf. This guide covers how to register an application, implement the authorization flow, and use access tokens.

## Quick Start

1. Go to **Account Settings → OAuth Applications** and register your app
2. Implement the **Authorization Code + PKCE** flow
3. Exchange the authorization code for an access token
4. Use the access token as a Bearer token in API requests

## Registering an Application

Visit your [Account Settings](/user/account) and scroll to the **OAuth Applications** section. Click **Register App** and fill in:

- **App Name** — displayed to users on the consent screen
- **Description** — what your app does
- **Redirect URIs** — where users are sent after authorization (must be exact match, HTTPS required in production)
- **Client Type**:
  - **Confidential** — server-side apps that can keep a secret (you'll get a client secret)
  - **Public** — SPAs, mobile apps, CLI tools (no client secret, PKCE provides security)
- **Allowed Scopes** — the maximum permissions your app can request

After registration, you'll receive a **Client ID** and (for confidential clients) a **Client Secret**. Save the secret — it won't be shown again.

## Authorization Code Flow (with PKCE)

PKCE (Proof Key for Code Exchange) is **required** for all authorization requests.

### Step 1: Generate PKCE Values

```javascript
// Generate a random code_verifier (43-128 chars)
const codeVerifier = crypto.randomBytes(32).toString('base64url');

// Hash it to create the code_challenge
const codeChallenge = crypto.createHash('sha256').update(codeVerifier).digest('base64url');
```

### Step 2: Redirect User to Authorization

> **Note:** OAuth endpoints are served from the hub origin `https://auth.civitai.com`. The old `https://civitai.com/api/auth/oauth/...` URLs are legacy 308-redirect shims kept for back-compat — point new integrations at `auth.civitai.com`.

```
GET https://auth.civitai.com/api/auth/oauth/authorize
  ?client_id=YOUR_CLIENT_ID
  &redirect_uri=https://yourapp.com/callback
  &response_type=code
  &scope=SCOPE_BITMASK
  &state=RANDOM_STATE
  &code_challenge=CODE_CHALLENGE
  &code_challenge_method=S256
```

Parameters:

- `client_id` — your app's client ID
- `redirect_uri` — must exactly match a registered redirect URI
- `response_type` — always `code`
- `scope` — integer bitmask of requested permissions (see Scopes below)
- `state` — random string for CSRF protection (required)
- `code_challenge` — SHA-256 hash of your code_verifier, base64url-encoded
- `code_challenge_method` — always `S256`

The user will see a consent screen listing the requested permissions. If they approve, they'll be redirected to your `redirect_uri` with an authorization code.

### Step 3: Exchange Code for Token

```
POST https://auth.civitai.com/api/auth/oauth/token
Content-Type: application/x-www-form-urlencoded

grant_type=authorization_code
&code=AUTHORIZATION_CODE
&redirect_uri=https://yourapp.com/callback
&client_id=YOUR_CLIENT_ID
&client_secret=YOUR_CLIENT_SECRET  (confidential clients only)
&code_verifier=ORIGINAL_CODE_VERIFIER
```

Response:

```json
{
  "access_token": "civitai_abc123...",
  "token_type": "Bearer",
  "expires_in": 3600,
  "refresh_token": "civitai_def456...",
  "scope": "33554431"
}
```

### Step 4: Use the Access Token

```
GET https://auth.civitai.com/api/auth/oauth/userinfo
Authorization: Bearer civitai_abc123...
```

Response (standard OIDC UserInfo claims):

```json
{
  "sub": "12345",
  "id": 12345,
  "username": "creator",
  "preferred_username": "creator",
  "name": "Creator",
  "picture": "https://...",
  "image": "https://...",
  "email": "creator@example.com",
  "email_verified": true
}
```

`email` and `email_verified` are released under the **UserRead** scope. UserRead is a mandatory baseline granted on **every** OAuth token — an app always needs to know whose account it's acting on — so the userinfo endpoint always works and `email` is present whenever the account has an email on file (unverified emails are still returned, with `email_verified: false`). Note that **existing** tokens issued before this change keep their original scope until they refresh — their access tokens (1h TTL) and the next refresh pick up the `UserRead` baseline automatically.

Or use it with any Civitai API/tRPC endpoint:

```
Authorization: Bearer civitai_abc123...
```

## Refreshing Tokens

Access tokens expire after 1 hour. Use the refresh token to get a new one:

```
POST https://auth.civitai.com/api/auth/oauth/token
Content-Type: application/x-www-form-urlencoded

grant_type=refresh_token
&refresh_token=civitai_def456...
&client_id=YOUR_CLIENT_ID
&client_secret=YOUR_CLIENT_SECRET  (confidential clients only)
```

The old access and refresh tokens are revoked, and new ones are issued.

## Device Authorization Flow

For CLI tools and devices without a browser:

### Step 1: Request Device Code

```
POST https://auth.civitai.com/api/auth/oauth/device
Content-Type: application/x-www-form-urlencoded

client_id=YOUR_CLIENT_ID
&scope=SCOPE_BITMASK
```

Response:

```json
{
  "device_code": "abc123...",
  "user_code": "ABCD-EFGH",
  "verification_uri": "https://auth.civitai.com/login/oauth/device",
  "verification_uri_complete": "https://auth.civitai.com/login/oauth/device?code=ABCD-EFGH",
  "expires_in": 900,
  "interval": 5
}
```

### Step 2: Display Code to User

Show the user the `user_code` and `verification_uri`. They visit the URL in a browser and enter the code.

### Step 3: Poll for Token

Poll the token endpoint every `interval` seconds:

```
POST https://auth.civitai.com/api/auth/oauth/device-token
Content-Type: application/x-www-form-urlencoded

grant_type=urn:ietf:params:oauth:grant-type:device_code
&device_code=abc123...
&client_id=YOUR_CLIENT_ID
```

Responses:

- `authorization_pending` — user hasn't approved yet, keep polling
- `access_denied` — user denied the request
- `expired_token` — device code expired
- Success — returns access token + refresh token

## Client Credentials Flow

For server-to-server communication (no user context):

```
POST https://auth.civitai.com/api/auth/oauth/token
Content-Type: application/x-www-form-urlencoded

grant_type=client_credentials
&client_id=YOUR_CLIENT_ID
&client_secret=YOUR_CLIENT_SECRET
&scope=SCOPE_BITMASK
```

The token acts on behalf of the client owner's account, scoped to the client's allowed permissions.

## Revoking Tokens

```
POST https://auth.civitai.com/api/auth/oauth/revoke
Content-Type: application/x-www-form-urlencoded

token=civitai_abc123...
&token_type_hint=access_token
```

Always returns 200, even if the token was already revoked.

## Scopes

Scopes are represented as a bitmask integer. Combine scopes with bitwise OR.

> **UserRead is always granted.** Every issued token includes the `UserRead` bit regardless of what you request — an app always needs to identify the user it's acting on. You don't need to add it explicitly, and it can't be omitted.

| Scope              | Value        | Description                                     |
| ------------------ | ------------ | ----------------------------------------------- |
| UserRead           | 1            | Read profile, settings & email (always granted) |
| UserWrite          | 2            | Update profile & settings                       |
| ModelsRead         | 4            | Browse & download models                        |
| ModelsWrite        | 8            | Upload & edit models                            |
| ModelsDelete       | 16           | Delete models                                   |
| MediaRead          | 32           | View images, videos & posts                     |
| MediaWrite         | 64           | Upload media & create posts                     |
| MediaDelete        | 128          | Delete media & posts                            |
| ArticlesRead       | 256          | Read articles                                   |
| ArticlesWrite      | 512          | Create & edit articles                          |
| ArticlesDelete     | 1024         | Delete articles                                 |
| BountiesRead       | 2048         | View bounties                                   |
| BountiesWrite      | 4096         | Create & manage bounties                        |
| BountiesDelete     | 8192         | Delete bounties                                 |
| AIServicesRead     | 16384        | View generation & training history              |
| AIServicesWrite    | 32768        | Generate, train & scan                          |
| BuzzRead           | 65536        | View buzz balance & history                     |
| CollectionsRead    | 131072       | View collections                                |
| CollectionsWrite   | 262144       | Manage collections                              |
| SocialWrite        | 524288       | Follow, react, comment & review                 |
| SocialTip          | 1048576      | Tip other users                                 |
| NotificationsRead  | 2097152      | Read notifications                              |
| NotificationsWrite | 4194304      | Manage notification preferences                 |
| VaultRead          | 8388608      | View vault                                      |
| VaultWrite         | 16777216     | Manage vault                                    |
| **Full**           | **33554431** | All permissions                                 |

### Common Scope Combinations

| Use Case           | Scopes                                                                                                                               | Value                            |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------- |
| Read-only browsing | UserRead, ModelsRead, MediaRead, ArticlesRead, BountiesRead, BuzzRead, CollectionsRead, AIServicesRead, NotificationsRead, VaultRead | Combine with OR                  |
| AI generation      | AIServicesWrite, AIServicesRead, BuzzRead                                                                                            | 16384 \| 32768 \| 65536 = 114688 |
| Publishing         | ModelsWrite, MediaWrite, ArticlesWrite + all reads                                                                                   | Combine with OR                  |

## Endpoints

| Endpoint                                | Method | Description                            |
| --------------------------------------- | ------ | -------------------------------------- |
| `/api/auth/oauth/authorize`             | GET    | Start authorization flow               |
| `/api/auth/oauth/token`                 | POST   | Exchange code for token, refresh token |
| `/api/auth/oauth/userinfo`              | GET    | Get authenticated user profile         |
| `/api/auth/oauth/revoke`                | POST   | Revoke a token                         |
| `/api/auth/oauth/device`                | POST   | Start device authorization             |
| `/api/auth/oauth/device-token`          | POST   | Poll for device token                  |
| `/.well-known/openid-configuration`     | GET    | OpenID Connect discovery               |
| `/.well-known/jwks.json`                | GET    | JSON Web Key Set (token-signing keys)  |

> Endpoints are served from `https://auth.civitai.com` (e.g. `https://auth.civitai.com/api/auth/oauth/authorize`). Discovery: `https://auth.civitai.com/.well-known/openid-configuration`; JWKS: `https://auth.civitai.com/.well-known/jwks.json`. The matching `https://civitai.com/api/auth/oauth/...` paths are legacy 308-redirect shims.

## Rate Limits

- Token endpoint: 20 requests/minute per client
- Authorization endpoint: 10 requests/minute per user
- Revocation endpoint: 20 requests/minute per client

Rate limit headers are included in responses: `X-RateLimit-Limit`, `X-RateLimit-Remaining`, `X-RateLimit-Reset`.

## Token Lifetime

- Access tokens: 1 hour
- Refresh tokens: 30 days
- Authorization codes: 10 minutes
- Device codes: 15 minutes

## Security Best Practices

1. **Always use PKCE** — required for all authorization code requests
2. **Validate the `state` parameter** — prevent CSRF attacks
3. **Store tokens securely** — never expose in URLs or client-side storage for confidential apps
4. **Use short-lived access tokens** — refresh when they expire
5. **Request minimal scopes** — only ask for what your app needs
6. **Register exact redirect URIs** — no wildcards allowed

## What tokens _cannot_ do

Some Civitai actions are **only available to session-authenticated users**, regardless of token scope. Hitting these via a Bearer token returns `403 FORBIDDEN`:

- Tipping (`buzz.tipUser`)
- Bounty creation (`bounty.upsert`)
- Cosmetic shop purchases (`cosmeticShop.purchaseShopItem`, `purchasableReward.purchase`)
- Comic chapter purchases (`comics.purchaseChapterAccess`)
- Event donations (`event.donate`, `donationGoal.donate`)
- Auction bids (`auction.createBid`)
- Paid AI judge reviews (`challenge.requestReview`)
- Paid game starts (`games.chopped.start`)
- Model version early-access purchases (`modelVersion.earlyAccessPurchase`)
- Creator-program bank/extract/withdraw (`creator-program.*`)
- Direct user-to-club buzz transfers (`buzz.depositClubFunds`)

Buzz-spending operations that flow through the orchestrator (image generation, training, scanning, recommenders) **are** available to tokens — that's the entire point of the OAuth/API key surface. The orchestrator enforces buzz spend on its side using each token's per-subject budget.

## /api/v1/me — token introspection

Hitting `/api/v1/me` with a Bearer token returns the user's identity plus token-specific fields:

```jsonc
{
  "id": 12345,
  "username": "...",
  "tier": "...",
  "status": "active" | "muted" | "banned",
  "isMember": false,
  "subscriptions": [],

  // UserRead is always granted, so these are present for any token
  "email": "creator@example.com",
  "emailVerified": true,

  // Present only when authenticated via a non-Full token
  "tokenScope": 4194303,
  "subject":   { "type": "apiKey" | "oauth", "id": <number | string> },
  "buzzLimit": [{ "type": "sliding", "limit": 5000, "window": "day", "unit": 1 }] | null
}
```

`subject` is the `(type, id)` pair Civitai's orchestrator buckets buzz spend by:

- For User-type API keys, `id` is the numeric `ApiKey.id`.
- For OAuth-issued tokens, `id` is the `clientId` — stable across access-token refresh rotations, so spend tracking persists when the access token rotates.

`buzzLimit` is `null` (or omitted) when the user has not configured a limit on this token. Otherwise it's an array of budgets that cap how much buzz this token may spend in the orchestrator.

## Buzz spend limits — `BuzzBudget[]`

Each entry in `buzzLimit` is one of three discriminated variants:

```ts
type BuzzBudget =
  | { type: 'absolute'; currencies?: string[]; limit: number }
  | {
      type: 'sliding';
      currencies?: string[];
      limit: number;
      window: 'second' | 'minute' | 'hour' | 'day' | 'week' | 'month';
      unit: number;
    }
  | { type: 'rollover'; currencies?: string[]; limit: number; cron: string };
```

- **absolute** — hard cap, no time component.
- **sliding** — rolling window of `unit × window` (e.g. `window: 'day', unit: 7` = rolling 7-day window).
- **rollover** — calendar-based reset driven by a cron expression. Cron syntax matches Hangfire Cronos.
- Optional `currencies` restricts the cap to specific buzz pools (e.g. `["yellow"]`).

Civitai's UI today only exposes a single sliding budget (limit + day/week/month period), but the JSON shape supports the full set. Programmatic clients with a Full-scope key can set any combination via the tRPC `apiKey.setBuzzLimit` and `oauthConsent.setBuzzLimit` mutations. A token cannot modify the limit on its own subject — use a different management key or session auth.
