# Monetization caps — API cleanup plan

Status: proposal, nothing implemented.
Scope: licensing fees + paid access caps across `@civitai/buzz`, the main app, and the creator-studio spoke.

## The problem, measured

`getViewerMonetization` internally calls `getPaidAccess` → `getCapTiers` → `capMediaType` → `cappedTerms` →
`effectiveLicensingFee`. That composition is the function doing its job — one call in, one answer out. It is
not the problem.

The problem is one layer up. `@civitai/buzz` exports **44 monetization symbols**, and the primitives sit at
the same level as the composed answers, so consumers reach past the facade and compose by hand:

| Consumer                                                   | Distinct monetization symbols composed |
| ---------------------------------------------------------- | -------------------------------------- |
| `src/components/Resource/Forms/ModelVersionUpsertForm.tsx` | **11**                                 |
| `apps/creator-studio/src/lib/monetization/fee.ts`          | 9                                      |
| `src/server/services/paid-access.service.ts`               | 8                                      |
| `apps/creator-studio/src/routes/(app)/models/+page.svelte` | 7                                      |
| `src/server/services/model-version.service.ts`             | 6                                      |
| 4 more creator-studio files                                | 4 each                                 |

The upsert form composes `capMediaType`, `maxLicensingFee`, `maxLicensingFeeCeiling`, `maxFeeBuzzForRatio`,
`feeImageOptionsForCap`, `maxPaidAccessPrice`, `suggestedFeePerImage`, `feeToRatio`, `ratioToFee`,
`generationPrice`, `buildModelVersionTerms` — to answer one question: _what may this creator enter for this
version?_

### This already cost us

The video-pricing review found **7 call sites that silently applied image caps to video models**, two of them
user-visible bugs (a form offering a max the server rejects; a generation gate displaying 500 ⚡ then debiting
2,000). Every one had the same shape: an optional `mediaType?` parameter that defaults to image when omitted.
The type system was happy. Nothing failed loudly.

`raisesOverCap` — one rule, "only a raise is capped" — is hand-implemented at **7 call sites** across both
apps. The rule exists because rejecting every over-cap submission caused a real outage (`82f64846ba`). Seven
copies is seven chances to reintroduce it.

## Root cause

Three specific design choices, each individually reasonable:

1. **Optional media/tier parameters that default to the strict value.** `maxLicensingFee(tier, modelType,
mediaType?)` is _safe_ when forgotten but silently wrong. Safety made the bug invisible.
2. **Primitives exported alongside facades.** Nothing signals that `cappedTerms` is plumbing for
   `getViewerMonetization` and not for direct use.
3. **The write guard is split by concern, not by call site.** `assertPaidAccessCaps` covers access prices;
   licensing fees are guarded separately in every caller, so a new caller gets one and forgets the other —
   exactly what happened in `model-version.controller.ts`.

## Proposed shape: five utilities

Two client, three server. Everything else becomes internal to `@civitai/buzz`.

### Client (pure, no I/O)

**1. `monetizationLimits({ membership, modelType, baseModel, isModerator })` → `MonetizationLimits`**

Everything an editor needs to bound its inputs, in one object:

```ts
type MonetizationLimits = {
  capTier: string; // resolved here, not by the caller
  mediaType: CapMediaType; // resolved, for display copy
  fee: {
    maxPerGeneration: number; // the tier cap
    denominators: number[]; // which "per N" options are expressible
    maxBuzzFor(images: number): number;
    suggested: FeeRatio; // seeded default for a NEW version
  };
  access: { maxPrice: number | null }; // null = unlimited
  permanent: { limit: number | null };
};
```

Replaces the 11-symbol compose in the upsert form and the 7 in `+page.svelte`. Takes `baseModel`, not
`mediaType` — callers can't pass the wrong axis because they can't name it. Same for `membership` over a
pre-resolved tier string (see Decision 1).

**2. Display formatters — `formatFeeRatio`, `feeToRatio`, `tierCapRows`.** Already correct; keep as-is.

### Server

**3. `getViewerMonetization({ versions, viewer })`** — the read path. Already exists, already correct.
Keep. Consider folding `toModelVersionPaidAccessDto` into it: since rows arrive priced, that function is now
a 4-line mapper whose only remaining job is dropping `ownerId`.

**4. `assertMonetizationCaps({ user, version, next })`** — **one** write guard covering licensing fee _and_
access price _and_ the permanent count, applying the increase-only rule once. Replaces `assertPaidAccessCaps`
plus the 7 hand-rolled `raisesOverCap` sites. A new write path gets all three checks or none — it cannot get
one and forget the others.

**5. `getBillableMonetization(versionId)`** — what the orchestrator and the purchase path charge. Today
`mini/[id].ts` hand-composes two recipients × their own tiers × their own base models, and
`earlyAccessPurchase` composes its own clamp. Both want the same answer: _what does this generation/purchase
actually cost, and who receives it?_ Returns fee components **per lineage version**, never an aggregate —
each carries its own recipient, version, amount, and settlement currency (Decision 3).

### Tier resolution moves into the package

Both apps answer "which tier do the caps use?" and they answer it differently:

|          | Shape                                                                   | Source  |
| -------- | ----------------------------------------------------------------------- | ------- |
| Spoke    | `cappedTier(m) = m.isMember ? (m.tier ?? 'free') : 'free'` — pure, sync | session |
| Main app | `getCapTier(userId)` — async, filters `isBadState` subs, returns `null` | DB      |

They agree semantically but differ in return value (`'free'` vs `null`) and in when the "bad state" check
happens. Per Decision 1 the **spoke's shape wins**: `@civitai/buzz` owns

```ts
type Membership = { tier: string | null; isMember: boolean };
resolveCapTier(m: Membership): CapTier   // always a real tier, never null
```

Each app keeps producing `Membership` its own way — the main app from the session or the cached
`getCapTier` lookup, the spoke from the session plus its moderator test-cookie override, which stays
spoke-only. What moves is the _rule_, not the fetching.

### The rule that prevents recurrence

**Make `baseModel` required wherever a cap is computed, and stop exporting the primitives.** Every one of the
7 media-type bugs becomes a compile error rather than a silent image-cap. If a primitive must stay exported
for tests, mark it `@internal` and lint against external use.

## Migration plan

Per Decision 2, narrowing is **not** a trailing phase. Each phase ends by deleting or internalizing the
primitives it just replaced, so there is never a window where both the facade and the cobbled-together path
are reachable. Churn is not the constraint; a reachable wrong path is.

**Phase 1 — `monetizationLimits` + `resolveCapTier`** (client, no behavior change).
Add both, migrate the upsert form and `+page.svelte`, then **remove** `maxFeeBuzzForRatio`,
`feeImageOptionsForCap`, and `suggestedFeePerImage` from the package's public exports. Highest
value-to-risk: pure, fully unit-testable, collapses the two worst offenders (11 symbols → 1, 7 → 1), and
retires `CreatorCaps.priceCap`, which is page-level and structurally can't know a version's media type.

**Phase 2 — `assertMonetizationCaps`** (server, behavior-preserving by construction).
Fold `assertPaidAccessCaps` + the fee guard into one, covering fee, access price, and permanent count.
Migrate the tRPC handler, the REST endpoint, and both creator-studio actions, then **remove** `raisesOverCap`
and the bare `max*` functions from the public surface. The increase-only rule gets asserted once, with
`82f64846ba` as the named regression test.

**Phase 3 — make `baseModel` required.**
With Phases 1–2 done the remaining call sites are few, so this is mostly a signature change plus the compile
errors it surfaces. It is the step that makes the media-type bug class unrepresentable rather than merely
absent.

**Phase 4 — `getBillableMonetization` (also the prerequisite for deeper lineage).**
Riskiest (money path + orchestrator contract), so last, behind the mini endpoint's shape tests — and behind
an integration test that actually exercises a gated version, which we currently lack (see Risks).

## Audit — cleanup available now

### Main app

- `ModelVersionUpsertForm.tsx` — 11 symbols → 1 (Phase 1).
- `model-version.controller.ts:447` — the licensing-fee guard is hand-rolled next to `assertPaidAccessCaps`,
  which is exactly why it was missing `capMediaType` until the review caught it. Phase 2 target.
- `model-version.schema.ts:366` re-exports `MAX_LICENSING_FEE`, giving the same constant two import paths.
  This bit us during the video work: the form imported the ceiling from the schema, which didn't export it.
  Delete the re-export; import from `@civitai/buzz`.
- `mini/[id].ts` and `earlyAccessPurchase` hand-compose the same billing answer (Phase 4).
- `toModelVersionPaidAccessDto` is now a near-trivial mapper (see above).

### Creator Studio

- `lib/monetization/fee.ts` is a 9-symbol pure re-export barrel. It exists so spoke imports point at `$lib`,
  which is fine — but after Phase 1 it should re-export ~3 things, not 9.
- `lib/server/monetization/licensing-fee.ts` has **4** `raisesOverCap` sites; `+page.server.ts` has a 5th for
  access prices. All collapse into Phase 2.
- **The spoke re-implements the main app's write guard.** `+page.server.ts` validates caps, then POSTs to the
  main app's REST endpoint which validates again. The main app is the real enforcement point; the spoke's copy
  is a UX pre-check that must be manually kept in sync — and currently isn't (it lacked the video multiplier
  until this week). Options: (a) accept the duplication and cover it with a shared test vector, (b) have the
  spoke call a thin `/api/v1/monetization/limits` endpoint, (c) share the assert via `@civitai/buzz` as a pure
  function over already-fetched state. **(c) is the natural fit** — the guard is pure once you have tier +
  stored values + submitted values, which is exactly Phase 2's signature.
- `NON_COMMERCIAL_BASE_MODELS = new Set(['Ideogram 4.0'])` is hardcoded in the spoke. Now that
  `basemodel.constants` is shared, this should be data-driven off the license record.
- `CreatorCaps.priceCap` is vestigial after `PaidAccessEditor` began deriving its own per-version cap. Remove
  it so nothing re-adopts the page-level value.

### Package

- `licensing-fee.ts` and `paid-access.ts` now import each other's concepts (`CapMediaType`,
  `VIDEO_CAP_MULTIPLIER` cross the boundary). The split is historical — fees vs gates — but caps are now one
  concept spanning both. Consider a `caps.ts` owning the tier tables, multiplier, and every `max*` function,
  leaving the other two files to terms-shape and ratio math.

## Decisions

**1. Tier resolution — use the spoke's model.** (@dev)
`@civitai/buzz` owns `resolveCapTier(membership)`; each app keeps producing `Membership` its own way. See
"Tier resolution moves into the package" above. Two things to settle during Phase 1: the main app's
`getCapTier` returns `null` where the spoke returns `'free'` — unify on `'free'`, since every consumer
already funnels `null` through a `?? free` fallback and the two values have never meant different things.
And the spoke's moderator test-cookie override stays in the spoke; it simulates _membership_, not caps.

**2. Phase 3 is not deferred cleanup.** (@dev: "churn isn't the issue. Code that can be misinterpreted or
poorly cobbled together is the issue.")
Restructured accordingly: every phase now ends by removing the primitives it replaced, rather than leaving a
trailing narrowing step. There is never an interval where both the facade and the hand-rolled path compile.

**3. Lineage — per-version components, and it's cheap.** (@dev: "we need to know the licensing fee for each
lineage version, not an aggregate total")

@ai: Researched. **Today lineage is structurally one hop, enforced at the write boundary** — but see the
N-hop section below, which is what actually drives the Phase 4 design. `model-version.controller.ts:468` requires `licensingSourceVersionId` to point at a
registered `LicensingRoot` for the same base model. A derivative therefore always points at a _root_, and a
root is never itself a derivative, so chains can't form. `mini/[id].ts` already resolves the whole lineage in
one `LEFT JOIN` — no recursion, no CTE.

And `fees[]` is _already_ the per-version breakdown you want, not an aggregate: each entry carries
`role` (`baseModel` | `version`), `amount`, `type`, `settlementCurrency`, `recipientModelVersionId`, and
`recipientUserId`. So `getBillableMonetization` can own lineage outright at no extra query cost — it just
returns that array instead of the endpoint hand-assembling it.

### Lineage will get deeper — design for N hops now

@dev: lineage is one hop today but may need more levels later.

That changes the recommendation from "cheap, do it whenever" to **`getBillableMonetization` should own
lineage resolution in Phase 4 regardless**, because one-hop is currently assumed in three separate places and
each is a silent-truncation hazard the day depth increases:

1. `mini/[id].ts` — a single `LEFT JOIN` to `licensingSourceVersionId`. At depth 2 it bills the parent and
   silently drops the grandparent. No error, just a recipient who stops getting paid.
2. `mini/[id].ts` — `hasSourceRule = !isLicensingRoot && ...`. The root/derivative split is binary; a
   mid-chain version is both.
3. `model-version.controller.ts:468` — the write guard requires the source to be a registered
   `LicensingRoot`, which is what _makes_ depth 1 true. Relaxing it is what enables depth N.

Consolidating first means the depth change is one function's internals plus a wire-contract decision, rather
than an archaeology exercise across the endpoint, the controller, and the purchase path.

**What N-hop needs that 1-hop doesn't:**

- **Recursive resolution with a bounded depth.** A `WITH RECURSIVE` walk up `licensingSourceVersionId`, with
  an explicit `MAX_LINEAGE_DEPTH` so a pathological chain can't turn one generation into an unbounded walk.
  Decide whether exceeding the cap truncates (and under-pays) or errors (and blocks generation) — this is a
  product call, not a technical one.
- **Cycle protection.** Depth 1 makes cycles impossible; depth N does not, and the FK allows them. Needs
  either a write-path check (walk before insert) or a `WITH RECURSIVE` visited-set at read time. Prefer the
  write path: cheaper, and it fails at authoring time rather than at generation time.
- **Per-hop cap resolution.** Every ancestor is capped against **its own** recipient's tier and base model,
  which the current code already does correctly for its two components. `getCapTiers` already batches, so N
  recipients is one cache read — the existing shape scales without change.
- **A wire-contract decision.** This is the sharp edge: deeper lineage means **more entries in `fees[]`**, and
  the array is the orchestrator's contract. Adding entries is a coordinated change, not a unilateral one.
  Worth settling the shape _before_ depth ships — e.g. a `depth` field on each component so consumers can
  reason about ancestry, added while the array is still length ≤ 2 and the change is free.
- **A settled root semantic.** `LicensingRoot` is unique per `(baseModel, modelType)` and marks the top of a
  chain. At depth N, is a mid-chain version that is _also_ registered as a root a terminator (stop walking) or
  a pass-through (keep walking)? Today the question can't arise. It decides who gets paid.

**Still true regardless of depth:** the return shape is a per-version array, never an aggregate — each entry
carries its own recipient, version, amount, and settlement currency. Depth changes how many entries there
are, not what an entry is.

One more caveat for today's code:

- **The one-hop guarantee is enforced in one controller, not in the schema.** `ModelVersion.licensingSourceVersionId`
  is a plain nullable FK; nothing at the DB level stops a row pointing at a non-root. A second write path
  would make chains representable _before_ the read side is ready for them — and the single JOIN would
  truncate silently. Until Phase 4, that guard is load-bearing; treat it as such.
- **Multi-parent / revenue splits are a different axis from depth** and would change the shape, not just the
  query: N recipients per component with proportions. That's a schema change and the point to re-ask whether
  `getBillableMonetization` still owns it.

## Risks and gaps

- **No integration coverage on the billing endpoint.** The BigInt 500 fixed in `46512a8cf0` proves the gap:
  `tsc` typed `freeTrialLimit` as `number`, unit tests mock the query, and 1,144 gated versions were failing
  in production. Nothing in the suite exercises `mini/[id]` against a real gated version. Phase 4 should not
  land without one.
- **Sweep for sibling BigInt hazards.** Any `$queryRaw` interpolating a JS number into `COALESCE`, `GREATEST`,
  `LEAST`, or a comparison against an int4 column has the same int8-promotion problem. Not yet swept.
- **Two enforcement points stay in sync by hand** until Phase 2 — the spoke pre-validates, the main app's REST
  endpoint actually enforces. That drifted once already (the spoke lacked the video multiplier).
