# OAuth Scoped Tokens — Resume State (post-compaction)

**Branch:** `feature/scoped-tokens` (force-pushed, rebased on latest main)
**Backup branch:** `backup/scoped-tokens-pre-rebase` (sha 922d83160)

## Where We Are

All 4 phases shipped. 2 commits on top of main:

1. `3a0618d83` — Squash-rebase of all OAuth/scoped-tokens work onto current main
2. `c390396c9` — Partial router annotations (comment + model only)

## Database State (already applied to prod)

| Column / Table                                           | Status  |
| -------------------------------------------------------- | ------- |
| `ApiKey.tokenScope` (Int, default 33554431)              | applied |
| `ApiKey.lastUsedAt` (timestamp, nullable)                | applied |
| `ApiKey.clientId` (text, nullable, FK→OauthClient)       | applied |
| `ApiKey.buzzLimit` (jsonb, nullable)                     | applied |
| `ApiKeyType` enum: Access, Refresh added                 | applied |
| `OauthClient` table (13 cols)                            | applied |
| `OauthConsent` table (6 cols, unique on userId+clientId) | applied |

## Code State

### Done

- `src/shared/constants/token-scope.constants.ts` — TokenScope enum, presets, labels, grid, getScopeLabel
- `src/server/oauth/{model,server,constants,token-helpers,rate-limit,audit-log}.ts` — Full server impl
- `src/pages/api/auth/oauth/{authorize,token,userinfo,revoke,device,device-token,device-approve,device-info}.ts`
- `src/pages/api/.well-known/openid-configuration.ts`
- `src/pages/login/oauth/{authorize,device}.tsx`
- `src/server/routers/{oauth-client,oauth-consent}.router.ts` + registered in `index.ts`
- `src/server/schema/{api-key,oauth-client}.schema.ts`
- `src/server/services/api-key.service.ts` — accepts tokenScope
- `src/server/auth/{bearer-token,get-server-auth-session}.ts` — load tokenScope/buzzLimit, thread via req.context
- `src/server/createContext.ts` — tokenScope on context (default Full for session auth)
- `src/server/trpc.ts` — `enforceTokenScope` middleware (fail-safe: scoped tokens denied on un-annotated endpoints)
- `src/server/utils/server-side-helpers.ts` — tokenScope: Full for SSG
- `src/pages/api/v1/me.ts` — returns tokenScope + buzzLimit when scoped
- `src/components/Account/{OAuthAppsCard,ConnectedAppsCard,ApiKeyModal,ApiKeysCard}.tsx` — UI
- `src/pages/user/account.tsx` — adds OAuthAppsCard + ConnectedAppsCard
- 5 docs in `docs/plans/`: plan, checklist, review, developer guide, spend-limits design
- Migrations: tokenScope/lastUsedAt, oauth tables, buzzLimit (all applied to prod)

### Router annotations (.meta({ requiredScope }))

- DONE: comment, model
- TODO: 87 other routers in `src/server/routers/`. Skip `index.ts`, `base.ts`, `oauth-client.router.ts`, `oauth-consent.router.ts` (those don't need it).

### Not built (deferred)

- Spend limit UI in API key modal
- Spend tracking mechanism (Redis counter per key)
- Buzz transaction middleware enforcement
- Old `KeyScope[]` column cleanup (after prod validation)
- Agent delegation tokens (special type)
- OIDC `scopes_supported` human-readable names
- ScopeSelector UI extraction (cosmetic dedup)

## Resume Steps

1. `git checkout feature/scoped-tokens`
2. `pnpm install` (in case deps drift)
3. `pnpm run db:generate`
4. Spawn 4 annotation agents in parallel (rate limits permitting). Per-agent prompt template in `docs/plans/oauth-scoped-tokens-checklist.md` — basically:
   - Add `import { TokenScope } from '~/shared/constants/token-scope.constants';`
   - Add `.meta({ requiredScope: TokenScope.X })` after procedure type before `.input()`/`.query()`/`.mutation()`
   - Scopes: UserRead/Write, ModelsRead/Write/Delete, MediaRead/Write/Delete, ArticlesRead/Write/Delete, BountiesRead/Write/Delete, AIServicesRead/Write, BuzzRead, SocialWrite, SocialTip, CollectionsRead/Write, NotificationsRead/Write, VaultRead/Write, Full (mod/system)
   - Special: `user.getToken` → Full (token mint)
5. Typecheck
6. Squash-commit annotations
7. Update checklist
8. Push

## Open Design Questions (spend limits)

See `docs/plans/spend-limits.md` — 5 questions for Justin + Koen:

1. Redis counters vs DB queries for tracking
2. Per-key vs per-user spend attribution
3. Single daily limit vs multi-period
4. Orchestrator enforcement — does Koen need to add it?
5. Limits on all buzz spending or just specific types

## Audit Status (from prior session)

All critical/high findings fixed. Remaining low items documented in `docs/plans/oauth-scoped-tokens-review.md`.
