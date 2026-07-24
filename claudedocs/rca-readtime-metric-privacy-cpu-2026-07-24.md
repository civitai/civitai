# RCA — read-time model-metric-privacy CPU regression (`model-metric-privacy-readtime`)

Date: 2026-07-24
Author: perf investigation (static source + measured A/B evidence)
Repo: `civitai/civitai` @ `origin/main` (f5fe73fd5f)
Branch: `zach/readtime-metric-privacy-cpu-fix`

## Measured evidence (ground truth)
- `civitai-dp-prod-api-primary`: per-request server CPU ~+35% and event-loop **longtask**
  time ~+71% higher with the Flipt flag `model-metric-privacy-readtime` **ON** vs **OFF**,
  via a clean load-normalized bracketed A/B (ON→OFF→ON).
- The flag gates code introduced by **#3266** (creator-controls hide-metrics).
- Fix **#3322** (`c3d924fc2`, live) cached creator-membership validity but delivered
  ~zero CPU benefit — the ON/OFF gap is unchanged.
- Longtask ⇒ the cost is **frequent synchronous event-loop blocking on a hot read path**.

## Root cause (1 paragraph)
The dominant flag-gated cost is **not** the membership lookup #3322 cached — it is an
**unconditional, uncached `dbRead.user.findMany({ select: { settings } })` that fetches and
synchronously deserializes every owner's FULL `settings` JSON blob, once per request, over
every owner in the response**, on the highest-volume gated read path (the browse feed
`model.getAll` → `getModelsRaw`). See `src/server/services/model.service.ts:1428-1447`
(the `if (metricPrivacyEnabled) { … dbRead.user.findMany … }` block). The same anti-pattern
is duplicated in the v1 models list (`model.service.ts:3350-3359`) and the associated-models
controller (`model.controller.ts:1637-1647`). `User.settings` is a large accumulating JSON
column (dismissed alerts, tour state, hidden tags, feature prefs, …); pulling it for up to
~100 feed owners on every browse request and JSON-deserializing all of it synchronously to
read **only three booleans** (`hideModelBuzz/Downloads/Generations`) is the synchronous
longtask. Critically, the codebase already has a batched, Redis-backed, bust-wired
`userSettingsCache` (`user.service.ts:2511`, 4h TTL) — these read-time paths **bypass it** with
a raw per-request DB read. This is a net-new query #3266 added and #3322 never removed.

## Why #3322 missed it (the key deliverable)
`#3322` optimized `getValidCreatorMembershipMap` (Redis-cached the `id→isValidMember` boolean,
skipping the `customerSubscription.findMany` + per-subscription
`subscriptionProductMetadataSchema.parse` on hits). But on the **feed** path the membership
lookup is only called for `membershipCandidates` — owners who **actually hide something**
(`model.service.ts:1440-1447`). In the common case **nobody hides any metric**, so
`membershipCandidates` is **empty**, and `getValidCreatorMembershipMap([])` returns
immediately at `creator-membership.service.ts:88` without touching Redis or the DB. So the
thing #3322 made cheaper **is not even invoked in the hot (nothing-hidden) case** — it could
not possibly shrink that cost. Meanwhile the cost that IS paid on every request — the
`dbRead.user.findMany({ settings })` at `model.service.ts:1431` — was left entirely in place.
It is unconditional (needed to evaluate the very short-circuit that decides whether anyone
hides), so #3322's "skip when nothing hidden" FIX 2 (added only to the single-model `getModel`
path, `model.controller.ts:307-324`) cannot elide it on the feed: you must read settings to
know if a default hides. #3322 fixed the branch that the hot path skips and left the branch the
hot path always runs.

### Ruled out (with code)
- **Membership Zod parse per entity** (hint a): only runs on cache MISS inside
  `queryValidCreatorMembership` (`creator-membership.service.ts:71`), and only for hide-owners;
  not on the common hot path. Not the delta.
- **Per-entity single-id membership calls** (hint b): the feed/v1/associated paths batch
  membership once (`getValidCreatorMembershipMap([...candidates])`); no per-entity mGet.
- **Membership cache never hitting** (hint c): irrelevant to the dominant case — membership is
  not called when nothing is hidden. Even a perfect hit rate wouldn't reduce common-case cost.
- **v1 model-versions `[id]` / OG card**: these call `hasValidCreatorMembershipCached` but are
  **NOT flag-gated** (no `metricPrivacyEnabled` reference in `src/pages/api/og.tsx` or
  `src/pages/api/v1/model-versions/[id].ts`), so they cannot contribute to the ON/OFF A/B delta.
- **Pure resolvers** (`resolveModel/VersionHiddenMetrics`, `model-metric-privacy.ts`): allocation-
  light boolean ORs; negligible per entity.

## Exact hot cost & fan-out
| Path | file:line | Gated by flag? | Per-request fan-out | Cost |
|---|---|---|---|---|
| Browse feed `model.getAll` → `getModelsRaw` | `model.service.ts:1428-1447` | **Yes** | 1 DB query + deserialize of full `settings` for **all N feed owners** (N up to ~100) | **Dominant** — highest volume on api-primary |
| v1 models list `getModelsWithVersions` | `model.service.ts:3350-3359` | No (always-on) | same, all owners in page | always-on baseline cost |
| associated models | `model.controller.ts:1637-1647` | Yes | same, all associated owners | lower volume |
| single `getModel` | `model.controller.ts:307-324` | Yes | 1 owner `findUnique`, short-circuited | small — leave as-is |

The synchronous longtask = JSON deserialization of N large `settings` blobs per request,
attributed to the feed because it is the hottest gated caller.

## Fix design (minimal, deterministic, byte-identical privacy)
Add a tiny read-through per-user cache of the **three derived hide-default booleans only**,
mirroring the proven `getValidCreatorMembershipMap` pattern in the same dependency-light module:

- `getUserMetricPrivacyDefaultsMap(userIds): Promise<Map<number, UserMetricPrivacyDefaults>>`
  in `creator-membership.service.ts` — packed Redis `mGet` of
  `packed:caches:user-metric-privacy-defaults:<id>`; DB-query the **misses only**, deriving
  `{ hideModelBuzz, hideModelDownloads, hideModelGenerations }` from `settings`; backfill; fail
  open to the uncached DB path on any Redis error (a Redis stall must never 500 a read).
  Value stored is a **tiny 3-boolean object**, shaped exactly like the slice of `settings` the
  resolvers read.
- Bust wired into `setUserSetting` (`user.service.ts:2595`, next to `userSettingsCache.bust`)
  via `bustUserMetricPrivacyDefaultsCache`; `CacheTTL.md` (10 min) backstops any missed writer.
- Swap the three raw `dbRead.user.findMany({ select:{settings} })` + map constructions
  (feed / v1 / associated) to `await getUserMetricPrivacyDefaultsMap(ownerIds)`. The returned
  map's values feed the **unchanged** downstream `getUserMetricPrivacyDefaults(...)` /
  `resolveModel/VersionHiddenMetrics({ userSettings })` calls — those read only the three
  `hideModel*` keys, so output is **byte-identical**.

**Byte-identical privacy guarantee:** the resolvers still AND the stored hide flags with live
membership; the defaults cache only replaces "how we read the 3 booleans off the owner", not
"whether a metric is hidden". A default is `!!settings.hideModelX` before and after. The
membership gate (which enforces lapse→revert-to-visible) is untouched. Worst-case staleness is a
≤10-min-late reflection of a user toggling their own default — the same staleness class as the
existing `userSettingsCache` and membership cache, and it can only make the cache lag a user's
OWN setting change; it can never expose another creator's metric that membership would hide.

## Verification plan
1. **Compile:** `NODE_OPTIONS=--max_old_space_size=8192 npx tsc --noEmit` (default heap OOMs).
2. **Unit tests:** cache hit/miss/batch-backfill/fail-open/bust + byte-identical-vs-raw-settings
   (a stored 3-bool object resolves the same hidden metrics as reading full settings), and the
   short-circuit still fires (nobody hides ⇒ empty membership candidates).
3. **Prod A/B (authoritative):** re-run the same bracketed `model-metric-privacy-readtime`
   ON→OFF→ON on api-primary AFTER this ships; the ON cost should now drop toward the OFF
   baseline. Metrics: per-request CPU (Pyroscope / cpuprofile) and the event-loop **longtask**
   metric (the +71% signal). Success = the ON/OFF gap collapses (longtask ON ≈ OFF).
4. **Cache-hit confirmation:** watch the new key populate (`packed:caches:user-metric-privacy-
   defaults:*`) and DB `user` findMany volume from these paths drop after warmup; confirm no
   change in emitted hidden-metric values on a hide-owner model (spot-check a known CP member's
   card + version stats look identical pre/post).

## Residual uncertainty (honest)
Static analysis proves the feed unconditionally does an uncached full-`settings` fetch per
request that #3322 left in place and that the common hot path never calls membership — so this
IS a real, dominant, always-run synchronous cost the A/B flag toggles. What static reading
cannot prove is the exact split between DB latency and deserialize-CPU within the +35%/+71%.
The fix removes both (cache hit ⇒ no DB query; tiny object ⇒ no large-blob deserialize), and the
prod A/B in step 3 is the authoritative confirmation.
