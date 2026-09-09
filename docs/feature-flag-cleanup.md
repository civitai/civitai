# Feature Flag Cleanup Candidates

Audit of [src/server/services/feature-flags.service.ts](../src/server/services/feature-flags.service.ts) — flags worth removing or rethinking, grouped by confidence.

## How a flag gets used (search before deleting)

Before deleting any flag, grep for **all** of these patterns. The destructure pattern in particular is easy to miss:

| Pattern                | Example                                                      |
| ---------------------- | ------------------------------------------------------------ |
| `features.X`           | `if (features.clubs) ...`                                    |
| Destructure            | `const { apiKeys, oauthApps } = useFeatureFlags();`          |
| `ctx.features.X`       | server-side tRPC handlers                                    |
| `ext.flags?.X`         | DataGraph node extensions (e.g. wan-graph.ts)                |
| `isFlagProtected('X')` | tRPC router middleware                                       |
| `'X'` literal          | component-config maps (e.g. AppFooter footer items)          |
| Flipt key (`X-name`)   | direct `isFlipt(...)` / `evaluateBoolean(FliptFlag.X)` calls |

Also check the `FliptFlag` enum in [src/server/flipt/client.ts](../src/server/flipt/client.ts).

## Tier 1 — Truly dead (already removed)

| Flag         | Status                                                                                 |
| ------------ | -------------------------------------------------------------------------------------- |
| `imageIndex` | ✅ Removed — zero consumers                                                            |
| `apiKeys`    | ❌ Restored — gates `ApiKeysCard` in [AccountPanes.tsx:92](../src/components/Account/AccountPanes.tsx#L92) and [LegacyAccountPage.tsx:62](../src/components/Account/LegacyAccountPage.tsx#L62) |
| `oauthApps`  | ❌ Restored — gates `OAuthAppsCard` + `ConnectedAppsCard` in [AccountPanes.tsx:93-94](../src/components/Account/AccountPanes.tsx#L93) and [LegacyAccountPage.tsx:63-64](../src/components/Account/LegacyAccountPage.tsx#L63) |

⚠️ Every account-page flag has **two** consumers while `accountSettingsV2` is alive — the pane
(`AccountPanes.tsx`) and the fallback (`LegacyAccountPage.tsx`). One grep hit is not the whole answer.

`apiKeys: ['public']` is decorative-only (always-true gate); see Tier 4.

## Tier 2 — Dead features (need code rip-out alongside flag deletion)

| Flag                 | Line                                                        | Cleanup scope                                                                                                                                                                                                                                                                                     |
| -------------------- | ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `clubs`              | [127](../src/server/services/feature-flags.service.ts#L127) | 40+ consumers — full feature rip-out (router, components, pages)                                                                                                                                                                                                                                  |
| `createClubs`        | [128](../src/server/services/feature-flags.service.ts#L128) | Only [club.router.ts:48,93](../src/server/routers/club.router.ts#L48); drops with `clubs`                                                                                                                                                                                                         |
| `coinbasePayments`   | [171](../src/server/services/feature-flags.service.ts#L171) | `availability: []` → already off. Remove dead branches in [BuzzPurchase.tsx:555](../src/components/Buzz/BuzzPurchase.tsx#L555), [BuzzPurchaseImproved.tsx:896](../src/components/Buzz/BuzzPurchase/BuzzPurchaseImproved.tsx#L896), [coinbase.router.ts](../src/server/routers/coinbase.router.ts) |
| `nowpaymentPayments` | [173](../src/server/services/feature-flags.service.ts#L173) | `availability: []` → already off; same pattern as coinbase                                                                                                                                                                                                                                        |
| `paddleAdjustments`  | [156](../src/server/services/feature-flags.service.ts#L156) | Comment says "temporarily disabled until we change ads provider" — confirm with team before deleting                                                                                                                                                                                              |

## Tier 3 — Single-reference flags worth product review

Each has exactly one real consumer; the question is whether the feature itself is still needed.

| Flag                      | Line                                                        | Sole consumer                                                                                                                                                                      | Product question                                                                           |
| ------------------------- | ----------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `questions`               | [90](../src/server/services/feature-flags.service.ts#L90)   | [pages-old/questions/...](../src/pages-old/questions/[questionId]/[[...questionDetailSlug]].tsx#L27)                                                                               | Lives in `pages-old/` — strong signal the section is archived. Delete page + flag together |
| `kinguinIframe`           | [177](../src/server/services/feature-flags.service.ts#L177) | [KinguinCheckout.tsx:85](../src/components/KinguinCheckout/KinguinCheckout.tsx#L85)                                                                                                | Is Kinguin still being used at all?                                                        |
| `annualMemberships`       | [168](../src/server/services/feature-flags.service.ts#L168) | [MembershipPlans.tsx:221](../src/components/Purchase/MembershipPlans.tsx#L221)                                                                                                     | `['dev']` — ship it or remove                                                              |
| `civitaiLink`             | [190](../src/server/services/feature-flags.service.ts#L190)  | [CivitaiLinkProvider.tsx:355](../src/components/CivitaiLink/CivitaiLinkProvider.tsx#L355), [CivitaiLinkPopover.tsx:341](../src/components/CivitaiLink/CivitaiLinkPopover.tsx#L341) | **Keep.** Desktop `v1.21.0` and node pack `v0.6.0` both shipped Sep 2026; `['mod','member']` is the supporter gate, not a rollout leftover |
| `thirtyDayEarlyAccess`    | [174](../src/server/services/feature-flags.service.ts#L174) | [constants.ts:1708,1718](../src/server/common/constants.ts#L1708)                                                                                                                  | Sets early-access duration ceiling to 30 days — likely still meaningful, but verify        |
| `prepaidBuzzTransactions` | [187](../src/server/services/feature-flags.service.ts#L187) | [PrepaidBuzzTransactions.tsx:81](../src/components/Subscriptions/PrepaidBuzzTransactions.tsx#L81)                                                                                  | Single mod component                                                                       |
| `safety`                  | [123](../src/server/services/feature-flags.service.ts#L123) | [AppFooter.tsx:36](../src/components/AppLayout/AppFooter.tsx#L36)                                                                                                                  | Just gates a footer link                                                                   |
| `comicSearch`             | [160](../src/server/services/feature-flags.service.ts#L160) | [AutocompleteSearch.tsx:516](../src/components/AutocompleteSearch/AutocompleteSearch.tsx#L516), [pages/search/comics.tsx:28](../src/pages/search/comics.tsx#L28)                   | Comics search page exists — keep?                                                          |
| `adminTags`               | [57](../src/server/services/feature-flags.service.ts#L57)   | [article.controller.ts:37](../src/server/controllers/article.controller.ts#L37)                                                                                                    | `['mod', 'granted']` — could be a plain permission check                                   |
| `moderateTags`            | [129](../src/server/services/feature-flags.service.ts#L129) | [pages/moderator/tags.tsx:234](../src/pages/moderator/tags.tsx#L234)                                                                                                               | `['granted']` — could be a plain permission check                                          |

## Tier 4 — Long-public flags worth promoting (decorative-only)

These have been `['public']` forever with no Flipt key, so the gate always evaluates `true`. Each `features.X` consumer can be inlined to `true` (or just the gate removed). This is mostly a code-tidying pass — there's no risk of behavior change.

`canWrite`, `apiKeys`, `articles`, `articleCreate`, `articleImageScanning`, `imageGeneration`, `collections`, `profileCollections`, `imageSearch`, `buzz`, `cosmeticShop`, `donationGoals`, `appTour`, `privateModels`, `toolSearch`, `vault`, `draftMode`, `membershipsV2`, `prepaidMemberships`, `newsroom`, `bounties` (mostly public), `creatorComp`, `alternateHome`, `auctions` (public), `disablePayments`, `challengePlatform`, `largerGenerationImages` (toggleable but defaulted), `air` (toggleable but defaulted), `assistant` (toggleable but defaulted).

⚠️ Before promoting any of these, double-check that `ENV` overrides via `FEATURE_FLAG_X` are not expected to flip them off in some deployment.

## Open question — only ship truthy flags to the client?

We could trim the client payload by sending only flags whose value is `true` (and treating missing entries as `false`). Past attempts broke a few consumers — the candidates are:

1. **Code that distinguishes `false` from `undefined`** — e.g. `if (features.X === false)` or `if (features.X !== undefined)`.
2. **Code that treats `undefined` as a "still loading" signal** — relevant if any consumer uses the lazy/async accessor.
3. **`!features.X` checks** — these continue to work (`undefined` is falsy), but subtle bugs are possible if downstream logic later asserts the type.

Audit checklist before attempting again:

- [ ] Grep for `features.X === false` and `features.X !== undefined`
- [ ] Grep for explicit `Boolean(features.X)` / `!!features.X` (these are fine but signal intent we should preserve)
- [ ] Audit the `getFeatureFlagsLazy` consumers — the `Object.defineProperty` getter pattern means `undefined` reads short-circuit through `obj.features`, which may have implications for serialization
- [ ] Check `FeatureAccess` type — currently `Record<FeatureFlagKey, boolean>`. If we ship a partial, the type needs to become `Partial<Record<FeatureFlagKey, true>>` so consumers can't read `.X` without a truthiness check

Easiest safe step: **keep the full payload but normalize all consumers to truthy-only checks** (`if (features.X)` not `if (features.X === true)`), then ship the partial payload as a follow-up once we're confident nothing relies on the negative case.
