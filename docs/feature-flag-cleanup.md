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

A flag here is safe to inline to `true` (or have its gate removed) only if **all three** hold. Check
them against the registry entry rather than against this list — the list is a snapshot and has
drifted repeatedly, always toward looking safer than it is:

1. `availability: ['public']` exactly. A domain list (`['blue', 'red', 'public']`) or a role
   (`['user']`) means the flag is already false for somebody.
2. **No `fliptKey`.** A flag carrying one is never decorative: Flipt overrides static availability
   in both directions, so inlining deletes a no-deploy off-switch.

   ⚠️ …but only where Flipt still has control, and a `FEATURE_FLAG_<KEY>` variable can take it
   away. The rule is not "is the variable set" — it depends on the registry entry:

   | Registry entry | Its variable | Flipt |
   | --- | --- | --- |
   | `availability: []` **with** a `fliptKey` | **ignored** | **keeps control** |
   | anything else | **applied** | **skipped entirely** |

   So a non-dark flag's `fliptKey` can be set `enabled: false` and have no effect, which makes it
   look decorative when it is merely pinned. Do not invert this on a dark flag: a variable naming
   one is discarded, and the flag stays dark, off and Flipt-owned.
3. Not `toggleable`. A toggleable flag is user-settable — `computeUserFeatureFlagsOverlay` in
   `src/server/services/feature-flags.service.ts` merges each user's stored choice over the
   defaults — so inlining one removes an existing opt-out even when its `default` is `true`. With
   `default: false` it is additionally off for everyone who has not opted in.

Derive it, don't trust the prose: the current split is 20 safe and 6 not.

**Safe:** `canWrite`, `apiKeys`, `articles`, `articleCreate`, `articleImageScanning`,
`imageGeneration`, `collections`, `profileCollections`, `buzz`, `cosmeticShop`, `donationGoals`,
`appTour`, `privateModels`, `toolSearch`, `draftMode`, `membershipsV2`, `prepaidMemberships`,
`newsroom`, `creatorComp`, `alternateHome`.

**Not safe, and previously listed as if they were:**

| Flag | Why inlining it changes behaviour |
| --- | --- |
| `disablePayments` | `['blue', 'red', 'public']`. Inlining to `true` disables the purchase buttons (`src/components/Buzz/BuzzPurchase.tsx`, `src/pages/user/membership.tsx`, the pricing redirect). |
| `bounties` | `['blue', 'red', 'public']` — domain-gated, on for some colors only. |
| `auctions` | `['blue', 'red', 'green', 'public']` — same. |
| `air` | `['user']`, not `['public']` — false for anonymous visitors. |
| `assistant` | `['user']` — same. |
| `largerGenerationImages` | `toggleable` with `default: false`, so it is **off** unless a user opts in. The old "toggleable but defaulted" annotation reads the wrong way round. |

Three more were removed from this list entirely rather than annotated: `imageSearch`
(`availability: []` plus a live `image-search` key — image search is retired, so inlining re-ships
it against a deleted index with no flag left to switch it off), `challengePlatform` (a live
kill-switch key), and `vault` (`['user']`).

Condition 3 is load-bearing, and not through its `default: true` half. The registry has exactly six
toggleable entries: `air`, `assistant` and `chat` are `default: true` and all three already fail
condition 1 on their availability, and `trainingStudioUi` fails conditions 1 and 2. The other two —
`largerGenerationImages` and `nativeVideoControls` — are `['public']` with no `fliptKey`, so
condition 3 is the only thing excluding them. That is why `largerGenerationImages` sits in the 6
above: drop condition 3 and the split is 21/5, not 20/6. `nativeVideoControls` was never on the
Tier 4 list so it does not move the split, but it is the same shape and is already in the registry —
the flag this condition exists to catch is not hypothetical.

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
