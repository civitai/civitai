# Licensing fee + paid access revamp

> **Status: implemented and committed** on `feat/licensing-fee-revamp` (unpushed), merged up to main. The migration in
> `packages/civitai-db-schema/prisma/migrations/20260821120000_pricing_slot/` still has to be applied
> by hand, per environment — nothing auto-runs it — and it must be applied **before** the code deploys,
> or every first-time pricing write throws on a missing relation. Read the header comment in that file
> for the lock-timeout caveat. **The full pre-ship list is in [Before shipping](#before-shipping).**

Work checklist for moving monetization onto the model proposed in
[article 33749](https://civitai.com/articles/33749) (JustMaier, 2026-08-10). Decided 2026-08-20.

**The change in one line:** membership stops governing _how much_ a creator may charge and starts
governing _how often_ they may put a new price on something.

| | Today | After |
| --- | --- | --- |
| Who may monetize at all | Anyone | Creator score ≥ 10,000 |
| Licensing fee ceiling | Per tier (free 1/0.1 → gold 100) | Flat 100/generation for everyone, ×5 video |
| Paid access price ceiling | Per tier (free 500 → gold unlimited) | None — uncapped |
| Permanent gate allowance | Concurrent count, free capped at 3 | — replaced by the monthly allowance |
| New priced versions | Unlimited | Monthly allowance: free 3, bronze 10, silver 25, gold unlimited — a fee or a permanent gate both count |
| Re-pricing an already-priced version | Cap-checked | Free — costs no allowance |
| Early access | Uncapped price, score-gated length | Unchanged, and never counts against the allowance |
| Membership lapse | Prices clamp to the lower tier's cap | Nothing changes; only the allowance shrinks |

## What this replaces

The lapse-grace work on `feat/paid-access-lapse-grace` (14-day honour/clamp/suspend window derived
from the subscription, two warning emails, a cap-profile batch query, a warning job) was **reverted
unshipped on 2026-08-20**. It was a mitigation for lapse-repricing; this model removes the
repricing, so there is nothing left to soften. Both open follow-ups under "Early Access price cap
regression" in [creator-studio-feedback-2026-08-03](creator-studio-feedback-2026-08-03.md) are
answered by the table above rather than by that machinery.

Nothing from that branch is being carried forward except two notes worth keeping:

- **The `past_due` anchor.** Stripe advances `currentPeriodEnd` when it raises the renewal invoice
  and only then flips the row, so a failed card leaves the nominal period end in the _future_ while
  cover has already gone (278 prod rows were in that state). Anything that asks "what tier is this
  user today" inherits that; the monthly allowance is the only such consumer left, and it is a soft
  limit, so this is a note rather than a fix.
- **`raisesOverCap`.** Still needed against the single global ceiling — the whole version is
  resubmitted on every edit, so a flat ceiling check would make a grandfathered over-cap version
  unsavable.

---

## 0. Monetization eligibility floor — creator score ≥ 10,000

Added by Justin 2026-08-20, not in the article. Gates **any** monetization, so it sits in front of
everything below: no licensing fee, no paid access, without the score.

- [x] Read `User.meta.scores.models`, the same score the early-access ladder uses
      (`EARLY_ACCESS_CONFIG` in [common/constants.ts](../src/server/common/constants.ts)). Note EA
      already gates 4× higher — its first rung is 40,000 — so this floor binds on fees and paid
      access, not on EA.
- [x] Enforce on the write path in both editors and the REST endpoint, beside the allowance check.
- [x] Creators already monetizing below the floor **keep what they have**; the floor applies to new
      fees and gates only (settled 2026-08-21). So this is a write-path check, and nothing existing
      is switched off — the 1,477 fee-bearing versions below the floor keep earning.
- [x] **Moderators are not exempt** (settled 2026-08-21). Deliberate, and the opposite of every
      other creator-score gate in the codebase — worth a comment at the check so nobody "fixes" it.

**Blast radius** (prod, 2026-08-20). Because the floor is not retroactive, none of this is taken
away — the table describes who could not _start_ monetizing under the new rule, and how much of the
catalogue those creators represent:

| Owner score | Creators with a fee set | Versions carrying a fee |
| --- | --- | --- |
| Below 10k | 845 (57%) | 1,477 (4.6%) |
| 10k+ | 642 (43%) | 30,879 (95.4%) |

Paid access is far more concentrated already — only 56 of 336 gate owners (17%) are below the floor.
This is the "junk model priced at the ceiling" filter that made removing the price caps risky, and
it covers a majority of creators while touching under 5% of priced versions.

**Eligibility needs no history — read current state.** The rule is "no new fee below the floor", and
grandfathering attaches to the _version_, not to the creator: does this version carry a fee / a
`PaidAccess` row right now? One that does stays editable at any score; one with none needs ≥10k.
Clearing a price and re-applying it is a new application, refused below the floor — that falls out of
the same read rather than needing a special case, and it means the sub-10k tail is frozen at its
current size rather than exempted going forward.

The floor still does **not** consult `PricingSlot` (§2), even though the two now cover the same kinds.
The slot ledger records what has been _spent_; the floor asks what is _set_. Keeping them separate is
what makes "no backfill" possible — the ledger starts empty at cutover, while the floor correctly sees
every existing price from day one. ⚠️ **Known trapdoor:** if the re-application case should be softened,
the fix is to grandfather on the slot row instead — which then requires the backfill this design avoids.

It does not overlap with §2 at all: **all 17** creators who would exceed their monthly allowance are
above 10k. The two rules bind on disjoint populations — the floor filters the low-reputation tail,
the allowance binds on established, high-volume creators. Nobody meets both.

## 1. Collapse the price caps

Settled 2026-08-21: **the fee ceiling is a flat 100 per generation for every model type, ×5 for
video (500). Paid access is uncapped.**

- [x] `LICENSING_FEE_CAP_BY_TIER` → a single constant. `maxLicensingFee` loses both `tier` **and**
      `modelType` — 100 covers checkpoints and everything else — keeping only `mediaType` for the
      ×5. At that point it is `MAX_LICENSING_FEE * mediaMultiplier(...)`, i.e.
      `maxLicensingFeeCeiling`, which already exists: delete `maxLicensingFee` and call that.
- [x] `PAID_ACCESS_PRICE_CAP_BY_TIER` and `maxPaidAccessPrice` — **delete outright**. Uncapped means
      there is no ceiling to check, not a large one, so the paid-access price loses its raise check
      too, and `assertPaidAccessCaps` keeps only the eligibility and allowance work — it shipped as
      `assertMonetizationWrite`.
- [x] `effectiveLicensingFee` loses its `recipientTier` argument and stops clamping. This takes a
      tier lookup off the per-generation billing path.
- [x] `maxFeeBuzzForRatio`, `feeImageOptionsForCap`, `monetizationLimits`, `resolveCapTier` — drop
      the tier axis where it no longer varies anything. `resolveCapTier` may survive only for the
      allowance.
- [x] `capUpsellRows` / `shouldUpsellCap` / `tierCapRows` — the upsell is no longer "upgrade to
      charge more". Either retarget it at the allowance or remove it.
- [x] `assertMonetizationWrite` (was `assertPaidAccessCaps`) — drop the tier resolution and the price check entirely. `raisesOverCap`
      survives only for the fee ceiling, which still needs it so a grandfathered over-100 fee stays
      savable.

## 2. Build the monthly allowance

The only genuinely new mechanism. Counts an entity the first time a price of any counted kind is
applied to it; adjusting that price afterwards is free.

- [x] **Scope: licensing fees and permanent paid access** (confirmed 2026-08-21, per the article).
      Timed early access spends nothing. One slot per **entity**, not per kind — the primary key is
      the entity, so a version already carrying a fee costs nothing further to gate.
- [x] Unit is the **entity**, not the model — one slot per priced version, no version→model rollup.
      A creator pricing several versions of one model spends a slot each. That is the intent: the
      tighter the free allowance binds, the more reason to subscribe. Don't loosen it later.
- [x] A slot is spent on application and **never returned** — clearing the gate does not give it
      back, and neither does deleting the entity (the table has no FK to it).
- [x] Allowance table: free 3, bronze 10, silver 25, gold unlimited. **Calendar month**, no rollover.
- [x] Count is `PricingSlot WHERE ownerId = ? AND createdAt >= date_trunc('month', now())` — one
      index scan on `(ownerId, createdAt)`, no join.
- [x] Idempotency comes from the primary key: `(entityType, entityId)` is write-once, so
      re-pricing, clearing and re-applying within the same month, or any unrelated edit cannot
      spend a second slot. Insert with `ON CONFLICT DO NOTHING` and let the row be the record.
- [x] Enforce on the write path, in both surfaces — the onsite model-version form and Creator
      Studio — plus the REST endpoint. `assertMonetizationWrite` (was `assertPaidAccessCaps`) is the natural place for the gate
      half; it is where `PERMANENT_ACCESS_LIMIT_BY_TIER` is checked today, and that check is what
      this replaces. The **fee** half needs the same call on the licensing-fee write path, which
      has no equivalent guard today — that is new surface, not a modified one.
- [x] Surface remaining allowance in both editors, replacing the "X of Y set" capacity hint. Both show
      the count itself ("2 of 3 priced this month"), not only the upgrade nudge — `CapUpsell` stays
      silent below 80% of the limit, so on its own a creator at 0 of 3 would never learn the allowance
      exists until the server refused them. Both mark an already-priced version as exempt.
- [x] Migration note: free creators sitting at 3 concurrent permanent gates today are unaffected —
      the ledger starts empty, so nothing existing counts against the first month.

**Storage: the `PricingSlot` table**, keyed `(entityType, entityId)` like `PaidAccess` so it
covers ComicChapter and anything else paid access grows to gate. `ownerId` is the only foreign
key — deliberately none on the entity, since the key is polymorphic and since a deleted version
should not refund its slot. Rows outliving their entity are inert: the count is scoped to the
current month, so a stale row stops mattering when the month turns.

**No backfill.** Everyone starts with an empty ledger. Prices applied before the feature ships cost
nobody their first month, and nothing existing is treated as already-spent. Eligibility (§0) reads
current state, so it needs no history either.

The insert condition is the **transition**, not the end state: write a slot only when the previous
state had no counted price and the new one does. That is what keeps an edit to an existing fee free
without needing the ledger to have been backfilled, and the primary key catches anything the
transition check misses.

**Blast radius** (prod, prices applied in the 30 days to 2026-08-21 — a licensing fee or a permanent
gate, per version). Measured against each creator's own allowance:

| Tier | Creators pricing | Versions priced | Over limit |
| --- | --- | --- | --- |
| Free (3) | 789 | 1,158 | 5 |
| Bronze (10) | 26 | 1,600 | 11 |
| Silver (25) | 4 | 91 | 1 |
| Gold (unlimited) | 7 | 1,016 | 0 |

826 creators priced something; **17 exceed their allowance**. Note where the pressure actually
lands: 5 free creators against 11 bronze. The tier the allowance squeezes hardest is one people
already pay for, so expect upgrade pressure at bronze→silver rather than at free→bronze. Free
creators overwhelmingly price 1–3 versions a month and never feel it.

Undercount to be aware of: fee applications come from the `entityChangeEvents` log, which only
begins 2026-07-30, so the fee half covers ~22 days rather than 30. Gates come from
`PaidAccess.createdAt` and are complete.

## 3. Lapse behaviour

- [x] A lapse changes the allowance and nothing else. Verify no read path clamps a stored price
      once §1 lands, and pin it with a test — this is the property the reverted branch existed to
      protect.
- [x] Retire the "unknown or lapsed tier falls back to the free cap" comments across
      `licensing-fee.ts` / `paid-access.ts`; that rule stops existing.

## 4. Docs

- [x] Rewrite R3 in [features/monetization-rules.md](features/monetization-rules.md): the price
      ceiling row leaves the tier column, the permanent-slot row becomes the monthly allowance.
      R1/R2/R4 are untouched.
- [x] Close the two follow-ups under "Early Access price cap regression" in
      [creator-studio-feedback-2026-08-03](creator-studio-feedback-2026-08-03.md), pointing here.
- [x] Update [creator-tools-backlog](creator-tools-backlog.md) if it carries cap items.

---

## Before shipping

Nothing here blocks the code — every decision is answered and the branch builds. These are the things
that have to happen, or be decided, before it reaches creators.

### Must happen

- [ ] **Apply the migration, per environment, BEFORE the deploy.** `20260821120000_pricing_slot`.
      Until the table exists every first-time pricing write throws on a missing relation and the Creator
      Studio models page 500s outright, because its loader counts slots. Under a short `lock_timeout` —
      the owner FK takes `SHARE ROW EXCLUSIVE` on `User`. See the migration header.
- [ ] **Decide whether the revamp ships behind a flag.** The scheduled-sales feature that merged
      alongside it gates its *reads* on `scheduled-model-sales` for exactly this reason, and says so:
      "The flag has to gate the reads, not just the UI." This change has the same manually-applied
      migration and no flag, so the migration is the only thing standing between a deploy and a 500.
- [ ] **Push, open the PR** (one PR for the whole revamp), and move the ClickUp task off "to do".
- [ ] **Update Justin's article** to the monthly allowance — tracked in
      [creator-studio/paid-access-followups](creator-studio/paid-access-followups.md), which warns that
      the old and new numbers look identical and mean different things.

### Should be decided

- [ ] **The eligibility floor has no UI.** `MONETIZATION_MIN_CREATOR_SCORE` appears in no client
      component in either app. 845 creators will fill in the fee form and learn at save time, with no
      path from the refusal to their score. The floor is meant as a junk filter, not a punishment.
- [ ] **The upsell lands on the wrong tier.** Measured over 30 days: 11 of 26 bronze creators exceed the
      allowance against 5 of 789 free. The free allowance was set tight *because* it is the upsell, but
      the data says it delivers bronze→silver, not free→bronze.
- [ ] **Existing over-tier fees start billing at full value on deploy.** The one user-visible price
      *increase* in the revamp, and still unmeasured — neither blast-radius table counts how many live
      versions get more expensive for buyers, or by how much.
- [ ] **Two behaviours recorded rather than decided**: cross-month re-pricing is free (see the
      consequences section above), and a sub-10k creator who clears a price cannot re-apply it.
- [ ] **`thirtyDayEarlyAccess` is deferred, not resolved** ("don't worry about it, I thought this was
      already wired up"). The contradiction is still in the code: a granted user below 10k.

### Follow-ups to file — user-reported, so Synced Team rather than the agent list

- [ ] **Tip split** (RisingV, article 33749 comments): 4 ⚡ tipped on a generation using a fee-charging
      checkpoint plus their own fee-free LoRA; the LoRA received 2 ⚡. Either tips split across
      fee-charging resources anyway, or half went nowhere.
- [ ] **Fee denominator** (NanashiAnon, same thread): whether a "per 10 generations" fee bills
      fractionally per generation. Unverifiable from this repo — the billing lives in the orchestrator.

### Known and accepted, no action planned

- The allowance is a count-then-insert with no advisory lock. A rate limit, not a balance;
  `free-placement.service.ts` documents the advisory-lock pattern if it ever needs to become one.
- `creator-shop.service.ts:getEarlyAccessModelPrices` reports a closed early-access window as still
  priced — it skips `isPaidAccessActive`. Pre-existing, unrelated to this change.
- 4 type errors and 1 failing suite (`user-payment-configuration`, `civitai-telemetry`) arrived with
  the merge from main. Verified pre-existing there; this branch contributes none.

### Opened by the merge with scheduled sales

- [ ] **Two 10k creator-score floors and two per-tier allowance tables now live in `@civitai/buzz`**,
      written a week apart by different work: `MONETIZATION_MIN_CREATOR_SCORE` (10000) beside
      `MIN_CREATOR_SCORE_FOR_SALE` (10_000), and `MONTHLY_PRICING_ALLOWANCE_BY_TIER`
      (3/10/25/∞ prices) beside `SALE_DAYS_BY_TIER` (3/7/14/30 days). They mean different things and
      happen to share a threshold, which is the shape that drifts silently. Worth collapsing the score
      floor to one constant before both grow more consumers.
- [ ] **A sale now discounts the STORED price**, since the ceiling it used to compose over is gone.
      Sale limits are validated against a floor computed from stored prices too. Worth a second look
      from whoever owns sales, because the numbers a creator sees when authoring one have moved.

## Consequences neither blast-radius table measures

- **Existing over-tier fees start billing at full value on deploy.** Nothing clamps at charge time any
  more, so any fee stored above the creator's OLD tier cap — set at gold and then lapsed, or
  grandfathered from before the caps — begins charging generators the stored number. That is the one
  user-visible price *increase* in the revamp, and it is not in the tables above, which only count who
  can no longer start monetizing and who exceeds an allowance.
- **"Never returned" holds within a month, not across them.** The count is scoped to the calendar
  month and the slot row is write-once, so a version priced in August, cleared, and re-priced in
  September passes free and writes nothing. Consistent with "a slot is spent once"; inconsistent with
  reading the allowance as a hard per-version toll. Recorded as the behaviour, not as an oversight.

## Decisions — all settled

Questions and answers verbatim in [licensing-fee-revamp-questions](licensing-fee-revamp-questions.md).
Nothing below is still open; each line is enforced by an item above.

| | Settled |
| --- | --- |
| Eligibility | Creator score ≥ 10,000 to apply a price to a version that has none. Already-priced versions keep and may edit theirs at any score; moderators are **not** exempt |
| Fee ceiling | Flat 100 per generation, every model type, ×5 for video (500) |
| Paid access price | **Uncapped** |
| Allowance scope | Licensing fees **and** permanent paid access; timed early access spends nothing |
| Allowance unit | The gated entity (a model version), not the model |
| Allowance period | Calendar month, no rollover |
| Slot return | Never — removing a fee or gate does not give the slot back |
| Dormancy suspension | Rejected |

## Raised in the article comments — decide before or alongside

Not committed scope. From the 15 comments on 33749; the first two are the ones that most change the
design.

- **Gate on creator score, not tier** (NanashiAnon) — **adopted as §0**, as an on/off floor at
  10,000 rather than the sliding ceiling proposed. Same insight: reputation governs eligibility,
  membership governs volume. What it does _not_ do is bound the price a qualifying creator sets, so
  the "priced at the ceiling" concern survives above 10k — relevant to the unlock-price question in
  Open questions, since that is the price with no market feedback to limit it.
- **Suspend on dormancy** (NanashiAnon) — **rejected 2026-08-21.** Nothing suspends on any signal;
  abandoned accounts keep collecting fees. Recorded so it is a decision rather than an oversight.
- **Let unused allowance accrue** (Marmadish) — **rejected 2026-08-21.** Calendar month, hard reset,
  deliberately. The burst-release friction it predicted is real and accepted: a free creator
  publishing a batch spends a slot per version, hits 3 in a day, and waits out the month. That
  pressure is the point — the allowance is the upsell.
- **The denominator strands the long tail** (NanashiAnon). Reported that a "per 10 generations" fee
  earns nothing on models that see fewer than 10 generations a month. `licensingFee` is stored
  per-image at `DECIMAL(10,2)` and should bill fractionally per generation — so either something
  rounds where it shouldn't, or the ratio UI is teaching creators the wrong model. Verify which.
- **Paid access on artist-style LoRAs** (NeilSylver). The only ethical objection raised, and
  unanswered: selling access to a style trained on one person's work, and paywalling a
  long-published back catalogue. `paidAccessBlockedFor` (already refusing POI and Private) is the
  extension point if we want a restriction. Product call.
- **Complexity budget** (John_KSampler). "A lot of this seems wildly complicated for very little
  gain… I still regularly see people wondering what the difference between Yellow and Blue is."
  Worth holding against §2 plus any of the above: they should replace concepts, not stack on them.

Two unrelated reports from the same thread, filed for elsewhere: a possible tip-split bug (RisingV —
4⚡ tipped on a generation using a fee-charging checkpoint plus their own fee-free LoRA, the LoRA
received 2⚡), and confusion about whether creators still earn when a user turns tips off in favour
of fees (KuroKenzo).
