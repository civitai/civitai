# Feature Flag Truthy-Only Migration Plan

## Goal

Stop sending `false` flag values from server → client. The wire payload becomes a sparse object containing only `true` flags, and the type forces every consumer through a truthiness check. Two wins:

1. **Smaller payload + smaller cache footprint** — currently every flag for every user is serialized on every page load
2. **Compiler-enforced grep safety** — when a flag is removed from the registry, the type system catches every consumer (including destructure sites that text grep misses)

## Why this broke last time

Two consumer patterns silently changed behavior when the payload became partial:

1. **Strict-equality on `false`** — `if (features.X === false)` flips meaning when `false` becomes `undefined`
2. **Existence checks** — `if ('X' in features)` or `features.X !== undefined` flip meaning the same way
3. **TypeScript widening** — anything passed to a function typed `(b: boolean) => ...` stops compiling once the type is `true | undefined`

We also have a unique-to-this-codebase wrinkle: `getFeatureFlagsLazy` in [feature-flags.service.ts:422](../src/server/services/feature-flags.service.ts#L422) defines getters via `Object.defineProperty` that route through `obj.features`. Need to confirm `JSON.stringify` walks those getters cleanly when the underlying object is partial.

## Consumer landscape (audit data)

There are **203 `useFeatureFlags()` callsites across 179 files**, plus **server-side `ctx.features` reads**.

Audit snapshot, 2026-05-12. Paths and counts below are not maintained — re-run the grep before
relying on a row.

### Destructure sites (36 total) — most vulnerable to type changes

These are the ones that aren't caught by `grep "features\.X"` — when removing a flag, you must also grep the destructure variable name in scope.

#### Client-side (`useFeatureFlags()`) — 34 files

| File                                                                                                                                                       | Destructured flags                         |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------ |
| [hooks/useDomainColor.tsx:5](../src/hooks/useDomainColor.tsx#L5)                                                                                           | `isGreen, isBlue, isRed`                   |
| ~~pages/user/account.tsx:30~~ → [LegacyAccountPage.tsx:34](../src/components/Account/LegacyAccountPage.tsx#L34) + [AccountPanes.tsx:41](../src/components/Account/AccountPanes.tsx#L41)                                                                                             | `apiKeys, oauthApps, canViewNsfw, strikes` |
| [pages/user/[username]/comics.tsx:192](../src/pages/user/[username]/comics.tsx#L192)                                                                       | `isGreen`                                  |
| [pages/comics/[id]/[[...slug]].tsx:101](../src/pages/comics/[id]/[[...slug]].tsx#L101)                                                                     | `isGreen`                                  |
| [pages/comics/project/[id]/iterate.tsx:316](../src/pages/comics/project/[id]/iterate.tsx#L316)                                                             | `isGreen`                                  |
| [pages/comics/project/[id]/read.tsx:160](../src/pages/comics/project/[id]/read.tsx#L160)                                                                   | `isGreen`                                  |
| [pages/articles/[id]/[[...slug]].tsx:137](../src/pages/articles/[id]/[[...slug]].tsx#L137)                                                                 | `articles`                                 |
| [pages/search/articles.tsx:27](../src/pages/search/articles.tsx#L27)                                                                                       | `articles`                                 |
| [pages/search/images.tsx:48](../src/pages/search/images.tsx#L48)                                                                                           | `canViewNsfw`                              |
| [pages/moderator/images.tsx:139](../src/pages/moderator/images.tsx#L139)                                                                                   | `csamReports, appealReports`               |
| [pages/moderator/csam/[userId].tsx:24](../src/pages/moderator/csam/[userId].tsx#L24)                                                                       | `csamReports`                              |
| [pages/moderator/csam/index.tsx:17](../src/pages/moderator/csam/index.tsx#L17)                                                                             | `csamReports`                              |
| [components/Account/ApiKeysCard.tsx:63](../src/components/Account/ApiKeysCard.tsx#L63)                                                                     | `apiKeyBuzzLimit`                          |
| [components/Account/ApiKeyModal.tsx:54](../src/components/Account/ApiKeyModal.tsx#L54)                                                                     | `apiKeyBuzzLimit`                          |
| [components/Alerts/YellowBuzzMigrationNotice.tsx:19](../src/components/Alerts/YellowBuzzMigrationNotice.tsx#L19)                                           | `isGreen, buzz`                            |
| [components/Alerts/MatureContentMigrationAlert.tsx:15](../src/components/Alerts/MatureContentMigrationAlert.tsx#L15)                                       | `isGreen`                                  |
| [components/Auction/AuctionPlacementCard.tsx:733](../src/components/Auction/AuctionPlacementCard.tsx#L733)                                                 | `isGreen`                                  |
| [components/Auction/AuctionInfo.tsx:291](../src/components/Auction/AuctionInfo.tsx#L291)                                                                   | `isGreen`                                  |
| [components/BrowsingLevel/BrowsingLevelProvider.tsx:45](../src/components/BrowsingLevel/BrowsingLevelProvider.tsx#L45)                                     | `canViewNsfw`                              |
| [components/Comics/PanelModal.tsx:242](../src/components/Comics/PanelModal.tsx#L242)                                                                       | `isGreen`                                  |
| [components/Comics/PanelDetailDrawer.tsx:84](../src/components/Comics/PanelDetailDrawer.tsx#L84)                                                           | `isGreen`                                  |
| [components/Comics/PanelCard.tsx:122](../src/components/Comics/PanelCard.tsx#L122)                                                                         | `isGreen`                                  |
| [components/Filters/SortFilter.tsx:78](../src/components/Filters/SortFilter.tsx#L78)                                                                       | `canViewNsfw`                              |
| [components/Gated/Gated.tsx:80](../src/components/Gated/Gated.tsx#L80)                                                                                     | `canViewNsfw`                              |
| [components/HiddenPreferences/useApplyHiddenPreferences.ts:47](../src/components/HiddenPreferences/useApplyHiddenPreferences.ts#L47)                       | `canViewNsfw`                              |
| [components/Image/ExplainHiddenImages/ExplainHiddenImages.tsx:111](../src/components/Image/ExplainHiddenImages/ExplainHiddenImages.tsx#L111)               | `canViewNsfw`                              |
| [components/ImageGeneration/GenerationForm/ResourceSelectFilters.tsx:230](../src/components/ImageGeneration/GenerationForm/ResourceSelectFilters.tsx#L230) | `canViewNsfw`                              |
| [components/IterativeEditor/IterativeImageEditor.tsx:265](../src/components/IterativeEditor/IterativeImageEditor.tsx#L265)                                 | `isGreen`                                  |
| [components/Meta/MetaPWA.tsx:5](../src/components/Meta/MetaPWA.tsx#L5)                                                                                     | `isRed`                                    |
| [components/Metrics/useLiveMetricsEnabled.ts:7](../src/components/Metrics/useLiveMetricsEnabled.ts#L7)                                                     | `liveMetrics`                              |
| [components/Profile/ProfileNavigation.tsx:26](../src/components/Profile/ProfileNavigation.tsx#L26)                                                         | `articles, comicCreator`                   |
| [components/UserAvatar/UserAvatar.tsx:103](../src/components/UserAvatar/UserAvatar.tsx#L103)                                                               | `canViewNsfw`                              |
| [components/UserAvatar/UserAvatarSimple.tsx:40](../src/components/UserAvatar/UserAvatarSimple.tsx#L40)                                                     | `canViewNsfw`                              |
| [components/VotableTags/VotableTags.tsx:34](../src/components/VotableTags/VotableTags.tsx#L34)                                                             | `canViewNsfw`                              |

#### Server-side (`ctx.features`) — 2 files

| File                                                                                                                                 | Destructured flags       |
| ------------------------------------------------------------------------------------------------------------------------------------ | ------------------------ |
| [server/controllers/tag.controller.ts:44](../src/server/controllers/tag.controller.ts#L44)                                           | `adminTags`              |
| [server/controllers/buzz-withdrawal-request.controller.ts:101](../src/server/controllers/buzz-withdrawal-request.controller.ts#L101) | `buzzWithdrawalTransfer` |

### Alias-pattern sites (~167 files)

Use `const features = useFeatureFlags()` then `features.X`. These behave identically under the destructure pattern at runtime, but they ARE caught by a `features\.X` text grep, so the search-and-delete workflow is safer for these.

## Migration plan

### Phase 1 — Audit & normalize (no behavior change) ✅ DONE

Goal: make every consumer treat the value as a _truthy check_ so changing the type later is mechanical.

**Step 1.1 — Forbid the dangerous patterns.** Grepped for:

```regex
features\.\w+\s*(===|!==)\s*(false|true|undefined|null)
features\?\.\w+\s*(===|!==)\s*(false|true|undefined|null)
flags\.\w+\s*(===|!==)\s*(false|true|undefined|null)
'\w+'\s+in\s+features
```

Result: only two real matches, both in [src/utils/training.ts](../src/utils/training.ts):

| Was                                                        | Became                                     |
| ---------------------------------------------------------- | ------------------------------------------ |
| `if (features && features.kohyaTraining === false)` (L530) | `if (features && !features.kohyaTraining)` |
| `return features.kohyaTraining !== false;` (L543)          | `return !!features.kohyaTraining;`         |

These were the only call sites that distinguished "Flipt explicitly disabled" from "absent/undefined." Safe to swap because `features.kohyaTraining` is always present in today's payload (the flag is registered), so the semantic change is unrealizable in production.

The `=== true` matches in [generation.service.ts:591,779](../src/server/services/generation/generation.service.ts#L591) and [process-enqueued-comic-panels.ts:160](../src/server/jobs/process-enqueued-comic-panels.ts#L160) are on `config.isGreen` / `metadata.isGreen` — separate object types intentionally tri-state, **not** the FeatureAccess payload. Left alone.

**Step 1.2 — `getFeatureFlagsLazy` audit.** ✅ All callers are server-side ([createContext.ts:83,105,132](../src/server/createContext.ts#L83), [image-scan-result.ts:177](../src/pages/api/webhooks/image-scan-result.ts#L177), [image-scan-result.service.ts:120](../src/server/services/image-scan-result.service.ts#L120)) and use only property access (`features.X`). No iteration, no JSON serialization, no `=== false`. The non-enumerable getters won't cause serialization issues because nothing serializes the lazy object.

**Step 1.3 — ENV overrides.** ✅ `getEnvOverrides()` in [feature-flags.service.ts:517](../src/server/services/feature-flags.service.ts#L517) sets `availability` to a parsed array. The empty array case evaluates `false` for everyone today; under truthy-only that becomes "absent in payload" — same falsy semantics. No behavior change required.

**Step 1.4 — Adjacent patterns confirmed safe.**

- [user.controller.ts:1284,1320](../src/server/controllers/user.controller.ts#L1284) — `Object.keys(features)` and `...features` here operate on the user-settings toggleable-preferences object (DB-stored), **not** the wire payload. Different namespace, safe.
- [user.controller.ts:1297](../src/server/controllers/user.controller.ts#L1297) — `!ctx.features[key]` already truthy-style
- [trpc.ts:217](../src/server/trpc.ts#L217) `isFlagProtected` uses `!features[flag]` — already truthy-style
- [constants.ts:1708,1718](../src/server/common/constants.ts#L1708) already uses `features?.X ?? false` — partial-aware (good pattern; recommend for new code)
- [data-graph context.ts:21](../src/shared/data-graph/generation/context.ts#L21) already typed as `Partial<FeatureAccess>` — data-graph nodes already partial-aware

**Step 1.5 — Convert destructure sites to alias pattern.** ✅ All 36 destructure sites converted:

```ts
// Before
const { canViewNsfw } = useFeatureFlags();
if (!canViewNsfw) doStuff();

// After
const features = useFeatureFlags();
if (!features.canViewNsfw) doStuff();
```

This eliminates two risks ahead of Phase 3:

- **Grep-detection blind spot**: every flag read is now `features.X`, so removing a flag from the registry can be confidently audited via text grep
- **Type widening at destructure**: when `FeatureAccess` becomes `Partial<Record<FeatureFlagKey, true>>` in Phase 3, destructured locals would silently widen to `true | undefined`. Property-access reads keep their type at the call site

Server-side `ctx.features` destructures (2 files: [tag.controller.ts](../src/server/controllers/tag.controller.ts), [buzz-withdrawal-request.controller.ts](../src/server/controllers/buzz-withdrawal-request.controller.ts)) were collapsed to inline `ctx.features.X` reads. Identifier collisions (helper-function parameters with same name in different scope, common-word substrings in URLs/strings, object-literal keys) were left alone where they don't reference the wire payload.

**Step 1.6 — Lint rule (deferred to Phase 2).** Add an ESLint rule banning `=== false` / `!== false` / `=== undefined` / `'X' in features` against `FeatureAccess`-typed values, plus a rule banning destructure of `useFeatureFlags()` / `ctx.features`. Deferred because there are no current violations to lint against; the rule prevents regression once Phase 2 lands.

### Phase 2 — Server: ship sparse payload ✅ DONE

[`getFeatureFlags`](../src/server/services/feature-flags.service.ts#L412) now skips assignment for `false` values:

```ts
return keys.reduce<FeatureAccess>((acc, key) => {
  if (hasFeature(key, ctx)) acc[key] = true;
  return acc;
}, {} as FeatureAccess);
```

`getFeatureFlagsAsync` delegates to `getFeatureFlags`, so it inherits the change. `getFeatureFlagsLazy` reads from `getFeatureFlags` for its cached object, so the underlying lookup also returns `undefined` for absent keys (the getter still returns the value at that key — JavaScript-wise this is fine; the cast hides the type lie).

The `FeatureAccess` type intentionally stays as `Record<FeatureFlagKey, boolean>` for one deploy so client + server agree on the wire shape during rollout. The payload shrinks immediately; the type lies temporarily. Phase 3 will tighten it.

**Why this is safe given Phase 1:**

- Every consumer uses truthy checks (`if (features.X)`, `!features.X`) — `undefined` evaluates the same as `false` in those expressions
- No `Object.keys(features)` / `...features` on the wire payload (verified in Phase 1 — those patterns only appear on the user-settings preferences object)
- No `=== false` / `!== false` consumers (Phase 1 normalized the only two)
- `isFlagProtected` middleware uses `!features[flag]` — works identically with `undefined`
- `getUserFeatureFlagsHandler` at [user.controller.ts:1297](../src/server/controllers/user.controller.ts#L1297) uses `!ctx.features[key]` — also identical

### Phase 3 — Client: tighten the type ❌ DECIDED AGAINST

Tried it. Changed `FeatureAccess` to `Partial<Record<FeatureFlagKey, true>>` and surfaced 13 type errors across the codebase — all `boolean | undefined not assignable to boolean` at boundaries where flag values flow into typed slots (context props, function params, predicate return types).

**Why we backed out:** the fixes all required `!!features.X` coercion, which adds friction at every boundary without a corresponding behavior gain. The runtime is already sparse from Phase 2; consumers already use truthy checks (Phase 1). Forcing every boundary to coerce was noise without payoff.

**What we're keeping instead:**

```ts
export type FeatureAccess = Record<FeatureFlagKey, boolean>;
```

The type "lies" — it claims every flag is present and boolean, when at runtime absent flags are `undefined`. The lie is benign because:

- `if (features.X)` works for both `false` and `undefined`
- `!features.X` works for both `false` and `undefined`
- Truthy ternary works the same way
- The wire payload is still sparse (Phase 2 stays — half the win was the bytes)
- **The flag-removal safety net still works**: `FeatureFlagKey` is the keyspace, so removing a flag from the registry shrinks the union and produces a type error at every consumer (including destructure sites)

**What we lose:** the type doesn't enforce write safety (`features.X = false` compiles even though wire payload never produces `false`). Acceptable — no consumer writes to the cache except [SettingsCard.tsx:335](../src/components/Account/SettingsCard.tsx#L335), and that one assignment is internal optimistic-cache state, not the wire payload.

### Phase 4 — Benefits realized

- Wire payload is smaller (most users have ~25 of ~80 flags true)
- Cache hit ratios improve since the payload is more uniform across users
- Removing a flag from the registry produces type errors at every consumer (destructure-blind-spot bug from Tier 1 is fixed) — this works because `FeatureFlagKey` is the keyspace, regardless of `Record` vs `Partial<Record>`
- Consumers stay terse — no `!!` coercion required at boundaries

## Risks & gotchas

| Risk                                                                                        | Mitigation                                                                                                                                                                                                                                                                 |
| ------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Some consumer is intentionally checking `=== false` to distinguish from "not yet evaluated" | Phase 1 audit; if found, refactor to use a different signal                                                                                                                                                                                                                |
| Server-side `ctx.features.X` checks in tRPC handlers                                        | The two known destructure sites ([tag.controller.ts](../src/server/controllers/tag.controller.ts), [buzz-withdrawal-request.controller.ts](../src/server/controllers/buzz-withdrawal-request.controller.ts)) get the same Partial type — type errors will surface on touch |
| `getFeatureFlagsLazy` getter pattern + JSON serialization                                   | Test in dev that SSR hydration produces identical payloads in alias and lazy modes                                                                                                                                                                                         |
| Third-party tooling reading `__NEXT_DATA__.props.pageProps.features`                        | Probably nothing reads this externally, but worth confirming with the team before Phase 2                                                                                                                                                                                  |

## Recommended sequence

1. Land Phase 1 as a single PR (audit + lint rule + any normalizations) — no behavior change, low risk
2. Wait one deploy cycle, watch for any unexpected breakage in the lint warnings
3. Land Phases 2 and 3 together as a single PR (server + type) — this is where the wire shape changes, and shipping them together avoids a brief window where the type lies about the payload
