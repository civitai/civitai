# Per-Subject Buzz Spend Limits

Final design as shipped on `feature/scoped-tokens`. Earlier revisions of
this document captured the design dialogue with Koen and have been removed
in favour of a single source of truth for what's in the codebase.

## Summary

API keys and OAuth tokens can spend buzz on behalf of a user. Users can cap
that spend with a per-subject **buzz limit**. The orchestrator owns
enforcement and rolling-window math; Civitai stores the limit, exposes it on
`/api/v1/me`, busts the orchestrator's cache when the user edits, reads
spend back per subject for UI display, and tells the orchestrator to delete
its record when the user deletes a key or revokes an app.

## Subjects

A "subject" is the unit the orchestrator buckets spend by. Civitai sends an
opaque `(type, id)` pair on every limit/spend operation:

| `type`   | `id`                | Source                                       |
| -------- | ------------------- | -------------------------------------------- |
| `apiKey` | `ApiKey.id` (int)   | User-type API keys                           |
| `oauth`  | `clientId` (string) | OAuth grants — stable across token rotations |

The OAuth `clientId` is the right level for OAuth: refresh-token rotations
issue new ApiKey rows but the consent (userId + clientId) is stable. Spend
attaches to the consent, not the access token.

## Limit shape — `BuzzBudget[]`

`buzzLimit` is a JSONB array of budgets. `null` (or `[]`) means no limit.

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
- **sliding** — rolling window of `unit × window`. Civitai's UI exposes
  this one (day/1, day/7, day/30 = the simple `day | week | month` periods).
- **rollover** — calendar reset driven by a cron expression. Cron syntax
  matches Hangfire Cronos (https://github.com/HangfireIO/Cronos).

Helpers `simpleBuzzLimitToBudgets` / `budgetsToSimpleBuzzLimit` in
`src/server/schema/api-key.schema.ts` round-trip the simple-UI form to the
canonical array shape and back.

## Storage

| Column                         | Used for                               |
| ------------------------------ | -------------------------------------- |
| `ApiKey.buzzLimit JSONB`       | User-type API keys                     |
| `OauthConsent.buzzLimit JSONB` | OAuth grants — stable across rotations |

Both nullable; null = no limit. The OauthConsent column was added in
migration `20260507165710_add_buzz_limit_to_oauth_consent`.

## Auth pipeline

`src/server/auth/bearer-token.ts` resolves the subject + buzzLimit at bearer
auth time:

- `apiKey.clientId == null` → `subject = { type: 'apiKey', id: apiKey.id }`,
  limit = `apiKey.buzzLimit`
- `apiKey.clientId != null` → `subject = { type: 'oauth', id: apiKey.clientId }`,
  limit = consent's `buzzLimit` (looked up by `(userId, clientId)`)

These thread through `req.context` → tRPC context → `/api/v1/me` response.

## `/api/v1/me` shape (token-authenticated requests)

```jsonc
{
  "id": 12345,
  "username": "...",
  "tier": "...",
  "status": "active",
  "isMember": false,
  "subscriptions": [],

  // present only when auth is via a non-Full token
  "tokenScope": 4194303,
  "subject":   { "type": "apiKey" | "oauth", "id": <number | string> },
  "buzzLimit": [{ "type": "sliding", "limit": 5000, "window": "day", "unit": 1 }] // or null
}
```

Session-authenticated requests don't get the token-specific fields.

## Civitai ↔ Orchestrator contract

All endpoints are RESTful under `/v1/manager/*` and use the existing system
Civitai bearer (`ORCHESTRATOR_ACCESS_TOKEN`) for auth — the same pattern as
flagged-consumers.

| Method   | Path                                              | Purpose                                            |
| -------- | ------------------------------------------------- | -------------------------------------------------- |
| `GET`    | `/v1/manager/users/:userId/limits/auth/:type/:id` | Fetch spend snapshot for one subject. 404 = none.  |
| `DELETE` | `/v1/manager/users/:userId/limits/auth/:type/:id` | Bust the orchestrator's cached limit for a subject |
| `DELETE` | `/v1/manager/users/:userId/auth/:type/:id`        | Delete the orchestrator's record for a subject     |

GET response shape:

```jsonc
{
  "spend": <number>,
  "buckets": [{ "ts": "<iso>", "amount": <number> }, ...]
  // (additional fields tolerated)
}
```

There's intentionally no batched "all subjects for user" endpoint. Koen
stores subjects in Mongo with no deletion policy, so a list response would
return entries Civitai has forgotten about. Civitai is the source of truth
for which subjects exist; we fan out one GET per subject and only for
subjects that have a limit set (filtering done in
`apiKey.controller.getApiKeySpendHandler`).

## Civitai-side mutations

| Procedure                   | Effect                                                                                    |
| --------------------------- | ----------------------------------------------------------------------------------------- |
| `apiKey.setBuzzLimit`       | Updates `ApiKey.buzzLimit`, busts cache                                                   |
| `oauthConsent.setBuzzLimit` | Updates `OauthConsent.buzzLimit`, busts cache                                             |
| `apiKey.delete`             | Best-effort `DELETE …/auth/apiKey/:id` after the row is gone                              |
| `oauthConsent.revokeApp`    | Best-effort `DELETE …/auth/oauth/:clientId` after the consent + tokens are gone           |
| `apiKey.getSpend`           | Builds the user's subject list (filtered to those with a limit), fans out per-subject GET |

These management mutations (and `apiKey.add`) accept a browser session or a
full-scope personal API key (`requireFullUserCredential`); OAuth access tokens,
System keys and reduced-scope keys are refused. `apiKey.setBuzzLimit` also
refuses to modify the calling key's own limit, so a key can't raise or clear
its own cap. Session auth and other full-scope personal keys of the same user
can edit any limit.

## UI

`src/components/Account/ApiKeysCard.tsx` and
`src/components/Account/ConnectedAppsCard.tsx` render keys and OAuth
grants as cards. Each card shows:

- Name + scope/type badge (header, with delete on the right)
- Created date · last used (api keys only) · authorized date (oauth)
- Inline spend bar + "spent / limit per period" link when a limit is set
- "No limit" link when not (clickable to add)

The shared `EditBuzzLimitModal` accepts a discriminated `subject` prop and
routes to the correct mutation. The form exposes only the simple sliding
budget today; setting an absolute or rollover budget requires hitting the
mutation directly (e.g. via tRPC client). When the stored `buzzLimit` can't
be expressed as a simple sliding budget, the card falls back to a "Custom
limit" pill that opens the editor with empty form fields rather than
showing a confused partial state.

The OAuth Apps and Connected Apps surface lives behind the `oauth-apps`
Flipt flag, mod-only by default. API keys card has a separate `apiKeys`
flag (pre-existing).

## Audit

`BuzzLimit_Set` ActionType in `src/server/clickhouse/client.ts`. Both
mutations fire `ctx.track.action(...)` on success with `subjectType`,
`subjectId`, the new `buzzLimit`, and the calling token's `subject`. Used
to retro answer "when did this user lower their cap" and "did they do it
from the browser or via an agent token."

## Self-modify protection summary

- `apiKey.setBuzzLimit` rejects when `ctx.subject.type === 'apiKey' && ctx.subject.id === input.id`.
- `oauthConsent.setBuzzLimit` refuses every OAuth access token through `requireFullUserCredential`, so no token can reach its own consent.

## Open follow-ups

- Multi-budget editor in the UI (currently sliding-only)
- Real end-to-end verification once Koen ships his side beyond
  `orchestration-next.civitai.com`
