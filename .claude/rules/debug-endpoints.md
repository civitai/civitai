---
paths:
  - "src/pages/api/testing/**"
---

# Debug endpoints (`src/pages/api/testing/*`)

`src/pages/api/testing/*.ts` holds hidden debug endpoints. Each is guarded by `WEBHOOK_TOKEN` (via `WebhookEndpoint(...)`, which checks the `?token=` query param) and exposes POST actions for exercising a feature without real money or hand-editing the DB.

## Using one

Read the endpoint's source: the top-of-file comment lists the actions and params, and the zod schema is the authoritative contract. No wrapper skill is needed; cURL with `?token=$WEBHOOK_TOKEN` appended to the URL is enough.

## Adding one

1. Create `src/pages/api/testing/<feature>.ts`.
2. Wrap the handler in `WebhookEndpoint(handler)` for auth.
3. Lead the file with a block comment listing each action, its params, and a one-line description (pattern: `src/pages/api/testing/referrals.ts`).
4. Scope every destructive action to a single `userId`/`refereeId` per call so misuse can't cascade.
