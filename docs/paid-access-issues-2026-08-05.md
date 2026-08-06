# Paid access / donation goals — issues found 2026-08-05

Found while building the Creator Studio bulk editor and sharing its forms with the per-version sidebar.
Several are **pre-existing production bugs** unrelated to that work; they're recorded here because the
refactor surfaced them.

All code changes listed as _fixed_ are **uncommitted** on `main` at time of writing, and **none of the UI
has been opened in a browser yet**.

---

## ⚠️ Product decision taken 2026-08-05 (Justin, call with @dev)

**Donation goals stay exactly as they are for now. No change.** Justin explicitly considered and then
rejected the rule proposed below:

> "It would make sense to make it so that if you do a donation goal, it prohibits your capacity to do paid
> access afterwards… **for now**." → then: "maybe what we do is we wait until users complain about it. So we
> just leave it just as it is… **for now, let's just leave it open like it is.**" → "Basically, no change."

Reasoning: three creators in the Creator Studio chat couldn't agree on how the feature should work, which
he reads as a sign the feature itself is questionable — so he'd rather not entrench a rule around it.
**He's running a survey early next week** to collect feedback, and wants the longer-term direction
(tiered pricing, granting access to everyone who donated) settled off the back of that.

**So: do not build the switching rule, and do not block anything on donation goals.** Everything in the
two sections below is _recorded evidence for that survey_, not a work queue. Revisit after the survey.

Two things from that call worth carrying into any future work:

- **Justin is right that early-access purchases count toward the goal — VERIFIED.** Every purchase writes a
  `Donation` row for the full purchase amount against the active goal, then calls
  `checkDonationGoalComplete` (`model-version.service.ts:2217-2226`). So a goal can complete on sales alone,
  with nobody having voluntarily donated.
  **And it applies to permanent gates too**: the goal is read via `getOwnerDonationGoals`, deliberately
  bypassing the display filters, with a comment saying so explicitly (`:2089-2093`). So a permanent-gated
  version with a live goal keeps accruing goal progress from every sale — and on completion
  `checkDonationGoalComplete` closes the goal without ending anything, because permanent gates are exempt.
  **This reframes the 41.4M number below: 41.30M of it (99.5%) came from buyers, not donors** — 9,311 of
  17,154 rows are from users who hold `EntityAccess` to the version they "donated" to. It is overwhelmingly
  purchase revenue being counted toward goals that can never pay out, not a pot of voluntary donations.
- **"Once the goal is met, it exits early access"** — confirmed in code: `checkDonationGoalComplete` ends
  the gate only when `isTimedGateActive`, so permanent gates are deliberately exempt.

---

## Open — needs a product decision (deferred to the survey, see above)

- [ ] **Donation goals survive a switch to permanent paid access, and keep taking money**
      `writeModelVersionGateAndGoal` does `if (donationGoal) await ensureDonationGoal(...)` — a `null`
      (which is what a permanent config sends) is a **no-op**, so the goal row is never deactivated.
      The goal keeps displaying and accepting donations toward _"if the goal is met, this becomes free"_,
      which a permanent gate can never honour.
      **Production today: 754 permanent-gated versions with an active goal; 623 of them hold donations,
      totalling 41.4M Buzz.**
      What happens to money already donated toward unlocks that can't happen is a refund call.
      _(`src/server/services/model-version.service.ts:395`)_

- [ ] **Abuse vector: fish for donations, then switch to permanent** — @dev raised this 8/5. A creator can
      promise a free unlock, collect donations, switch to permanent, and keep both the Buzz and the paywall.
      Nothing blocks it today. Proposed rule and its blocker are below.

- [ ] **There is no way to cancel a donation goal.** `active: false` is written in exactly one place —
      goal completion (`donation-goal.service.ts:341`). No cancel, no delete, no moderator path. This is
      what makes a naive "an active goal blocks permanent access" rule dangerous: it would strand every
      creator whose goal will never fund, permanently, with no escape.
      **Any goal-based restriction needs a close path first.**

---

## Open — agreed shape, needs building

- [ ] **Deactivate goals when a timed window ends naturally.** `process-ending-early-access` never touches
      them, which is why **17,259 active goals are attached to versions with no gate at all** (plus 204 on
      expired windows, 212 on live ones). Donors got their outcome when the version went free, so the goal
      has served its purpose. Doing this first shrinks the problem from ~17.7k goals to a few hundred
      before any switching rule has to exist. **Hold pending the survey** — it changes behaviour, and the standing decision is no change.

- [ ] ~~**Block the timed→permanent switch only when it's actually the abuse case**: goal active **and**
      window still live **and** donations > 0 (≤212 versions). Allow it otherwise and deactivate the goal
      as part of the switch — zero donations means nobody was promised anything.~~ **Rejected 2026-08-05 by Justin — leave as is pending the survey.**

- [ ] **Sidebar locks donation goals more strictly than the rule.** `PaidAccessEditor` disables the goal
      input whenever one exists (_"manage it on civitai.com"_), but per @dev a goal is modifiable while the
      version has never been published. Now visible because both forms share `PaidAccessFields`.

- [x] **Single-version usage-control switch still dead-ends.** Bulk migrates prices between download and
      generation when usage control changes; the sidebar's `setUsageControl` keeps the old guard and
      refuses. Raised three times, still undecided — it's a worse inconsistency than the original error.

- [x] **Result step in the bulk dialog** — @dev approved the design 8/5 (mockup:
      [flow walkthrough](https://claude.ai/code/artifact/ec863843-2134-43a9-b190-59a3d9832821), step 4).
      Report the outcome in
      the dialog instead of closing onto an emptied table, offer the one causal follow-up
      (usage control → download price), and give partial failures somewhere to be seen — `errors[]` is
      currently collapsed into a toast.

- [x] **Badge for Download+Generation versions with no download price** that fell back to the generation
      price. Built into the result step — it surfaces at the moment those versions start selling at a price the creator did not choose.

- [x] **Main-app bulk-remove-paid-access endpoint — dropped.** The unused `bulkRemoveModelVersionPaidAccess`
      service was deleted rather than wired up (@dev, 8/5). The studio keeps its bounded-concurrency loop,
      which works; the helper had no caller and carried two unexercised bugs. This also closes the three
      findings against it below.

- [ ] **Bulk unpublish** — the second half of [CU 868kk4j2n](https://app.clickup.com/t/868kk4j2n).

- [ ] **Desktop table view for licensing/bulk edit** — [CU 868km6kan](https://app.clickup.com/t/868km6kan).
      The "keep bulk mode open between operations" half is done (there's no mode any more, and the
      selection now survives an apply).

- [ ] **Nothing has been visually verified.** The whole paid-access sidebar was rewritten underneath to
      share components with bulk. Highest-value checks: the gate picker's loading/disabled states, the
      partial-selection notice, and the fee dropdown now sourcing real per-tier denominators.

- [ ] **Steps 2 and 3 of [retire-earlyaccess-availability.md](retire-earlyaccess-availability.md)** —
      clear the remaining 152 rows, then drop the five readers.

---

## Fixed this session (uncommitted)

- [x] **Early access was unreachable in bulk.** The bulk dialog only ever wrote permanent gates —
      no timed option existed. It now renders the same `PaidAccessFields` as the sidebar.

- [x] **`status = 'Published'` was the wrong test for "has been published".** It misses **121,096
      `Unpublished`** and **1,615 `Draft`** versions that have been published before. Now
      `initialPublishedAt IS NOT NULL OR status = 'Published'`.

- [x] **`publishedAt` is not a reliable anchor** — `process-ending-early-access` overwrites it on
      republish (**27,101 rows already differ from `initialPublishedAt`**). `initialPublishedAt` was added
      2026-07-25 as a write-once anchor and, until now, **had zero readers anywhere in the codebase**.
      Populated by a live trigger; 0 of 14,731 versions published since the migration are missing one.

- [x] **The main-app endpoint had no publish guard at all.** `/api/v1/model-versions/early-access` checked
      ownership and nothing else, so the "no early access after publish" rule lived only in the forms — a
      direct call with a session cookie bypassed it. Now enforced there, while still allowing an existing
      window to be edited.

- [x] **Bulk forms had drifted from the sidebar** — different components, missing fields, and a fee
      dropdown reading a static option list instead of the creator's per-tier denominators (so it offered
      ratios the server rejects). Now shared: `UsageControlPicker`, `LicensingFeeFields`, `PaidAccessFields`,
      with eligibility in `gate-eligibility.ts` (8 unit tests).

- [x] **The bulk gate picker could show a disabled card as selected** — it seeded Timed from score alone,
      before the async publish check answered, and nothing re-seeded it.

- [x] **Selection was cleared after every bulk apply**, so chaining two operations over the same versions
      meant re-picking them — and a successful write is exactly what moves rows out of the filter that
      found them. Selection now survives; the bar names the part that no longer matches.

- [x] **"Simulate membership" can't reach early access.** The ladder keys off `User.meta.scores.models`
      (first rung 40k), which membership doesn't touch. Added a matching **Simulate models score**
      control, wired through both the page load and the bulk action guard.

---

## From the agent review (2026-08-05)

**Update:** every finding below that blocks the bulk editors has since been fixed and is ticked; what
remains is the donation cluster (deferred) and a handful of low-severity polish items.
enforcement gap.

Two agents reviewed the uncommitted work — one per app. Findings below are **verified against the code**,
not taken on the agents' word; anything I could not confirm is marked. Ranked by severity.

### High — money or state correctness

- [x] **`bulkSetPaidAccess` drops "Free for everyone".** The shared form emits
      `<input name="freeGeneration">`, but `bulkPaidAccessSchema` has no such field and the action never
      reads it, so `buildModelVersionTerms` writes a _priced_ generation tier instead of a free one.
      Worse, `genMode === 'free'` unmounts the trial-limit input (preprocessed to 0), so non-buyers can
      neither generate free **nor** trial — the exact opposite of what the creator picked, across the whole
      selection. The sidebar handles it correctly (`paidAccessFormSchema` has `freeGeneration: checkbox`),
      so this is a new sidebar/bulk divergence introduced by sharing the form.
      _(verified: `freeGeneration` appears nowhere in `+page.server.ts`)_

- [x] **Bulk timed access never checks the concurrent early-access cap.** The `!permanent` branch validates
      duration only. `earlyAccessQuantityForScore` / `countActiveEarlyAccessVersions` are imported and used
      in `load`, but not in the action — while the permanent branch _does_ do its aggregate check. The only
      enforcement is the main app's per-request `assertUserEarlyAccessLimits`, which reads-then-writes, and
      we fan out 10 concurrent writes. At 40k score (cap = **1 slot**), selecting 50 versions lets roughly
      the first wave of 10 through. _(verified: no quantity check in the action)_

- [x] **An expired gate is a tombstone, so "already has a timed gate" is true forever.** The new endpoint
      guard allows the write when `existing.timeframeDays != null`, but `process-ending-early-access` never
      deletes the row — an expired window leaves `timeframeDays` set with `endsAt` in the past. So any
      version that _ever_ had early access can start a new window after publication, and `endsAt` is
      recomputed from the rewritten `publishedAt`. Guard should require the gate to be **active**
      (`endsAt == null || endsAt > now`). This is a hole in the guard I added.

- [x] ~~**`bulkRemoveModelVersionPaidAccess` never busts the paid-access cache.**~~ — _moot: function deleted._ It deletes the row and
      calls `bustMvCache` / `dataForModelsCache.refresh`, but not `bustPaidAccessCache` — which every other
      gate write does call. That cache is 1h TTL with `staleWhileRevalidate: false`, so for up to an hour
      readers still see a deleted money gate and keep charging. (Also re-opens the tombstone issue above,
      since the endpoint guard reads the same cache.)

### Medium

- [x] **The rule is enforced in one of two write paths.** tRPC `modelVersion.upsert` accepts the same
      `paidAccess` shape and reaches `writeModelVersionGateAndGoal` without any ever-published check — the
      main app's own form gates it client-side only. The same is true of the "permanent only from Creator
      Studio" webhook-token restriction: tRPC upsert can set `permanent: true` with no token. Pre-existing,
      but the new guard's premise ("this endpoint is reachable directly, so enforce here") applies equally.

- [x] **Scheduled versions are wrongly blocked.** The `set_initial_published_at` trigger fires on any
      non-null `publishedAt`, **including a future one** — and `publishModelVersionById` sets
      `status = Scheduled` with a future `publishedAt`. So a version scheduled for next week already has an
      anchor and is refused an early-access window, which is precisely the pre-release case the feature is
      for. Needs `initialPublishedAt <= now()` (or an explicit `Scheduled` carve-out) in **both**
      `countPreviouslyPublished` and the endpoint guard — they share the wrong predicate.

- [x] ~~**`bulkRemoveModelVersionPaidAccess` is non-transactional.**~~ — _moot: function deleted._ The `deleteMany` and the
      `availability='EarlyAccess' → 'Public'` reconcile are separate statements; if the second fails,
      non-buyers are locked out permanently, and the self-heal in `process-ending-early-access` can't help
      because it joins `PaidAccess`, which is now gone. Wrap both in a transaction.

- [x] **Sidebar seeds the gate kind from `status` but decides eligibility from `initialPublishedAt`.**
      `seed()` still uses `v.status !== 'Published'`. For a version with an anchor but currently
      `Unpublished`, the drawer opens with **Timed** selected _and_ disabled, with no correcting effect
      (the bulk dialog has one). Saving without noticing produces a 400.

- [x] **Partial outcomes are invisible.** The success toast reads only `updated ?? cleared ?? …`; `failed`
      and `skippedPublished` are returned by the action and dropped. `bulkSetPaidAccess` returns `ok:false`
      only when _nothing_ succeeded, so "288 skipped, 3 failed, 9 written" renders as a plain green
      success. The result step already on the list is where this belongs.

- [x] **Bulk dialog says "Set permanent paid access"** in the title and toast even when the creator chose
      Timed — stale copy from when bulk was permanent-only.

### Low

- [x] ~~**`bulkRemoveModelVersionPaidAccess` has no caller**~~ — _moot: function deleted._ — the studio still fans out one request per
      version. ~85 lines of unreachable money-path code carrying the two bugs above.
- [ ] **Sidebar can't tell a version already has a donation goal**: `paidAccessToConfig` hardcodes
      `donationGoalEnabled: false`, so `hadDonationGoal` is always false and the "already set" lock is
      unreachable. Pre-existing; the new bulk path queries `DonationGoal` directly and so avoids it.
- [ ] **Bulk price cap ignores the media axis** — the client uses `maxPaidAccessPrice(tier)` with no base
      model while the server uses `strictestCapMediaType`. Under-permits only (client ≤ server), so no
      bypass, but an all-video selection is clamped to the image cap.
- [ ] **Gold renders "up to ∞ ⚡"** — bulk passes the raw cap; the sidebar routes through `finiteOrNull`.
- [ ] **Over-slot warning miscounts across pages** — `alreadyPermanentIds` is built from the current page,
      so after "select all matching" it can show a false over-limit alert. Warning only; server is correct.
- [ ] **CSV export ignores the `usage` filter** though `exportHref` forwards it. Pre-existing.
- [ ] **`bulkSetPaidAccess` / `setPaidAccess` don't call `bustVersionCache`** while every sibling action
      does. May be deliberate if the main-app endpoint busts its own — **unverified**.
- [ ] **Permanent → timed is refused on a published version** (a permanent gate has `timeframeDays == null`,
      so the guard rejects). Probably intended, but it refuses a strictly _less_ restrictive change.

### Fixed immediately

- [x] **Both server previews were dead.** `deserialize()` takes a **string**, and both fetches passed the
      already-parsed object from `r.json()` — every call threw `SyntaxError`, swallowed by `.catch()`. So
      `publishedCount` was always 0 and `freeGenAffected` always empty: the "applies to N of M" notice and
      the "N versions will stop giving generation away" confirmation **never rendered at all**. Now
      `r.text()`. _(This is why the partial-selection notice couldn't be seen in testing.)_

### Cleared by review

- Svelte 5 reactivity: no effect loops or stale-scope bugs; `$state` initializers reading props are
  correctly `untrack`ed behind a genuine `{#key}` remount.
- SQL: every `in` clause is guarded against an empty array; the polymorphic `DonationGoal`
  `entityId`/`modelVersionId` dual-write is handled on both branches.
- Buyers' `EntityAccess` grants are genuinely untouched by bulk removal.
- The `process-ending-early-access` `CASE` change is correct and doesn't disturb the reconciliation pass.
- No dangling references from the deleted bulk bars or the removed CSV-import path.

---

## Investigated — not a bug

- **`materializePaidAccessEndsAt(id, publishedAt, tx)`** looked like it should use the anchor (the
  migration comment names this call site). It shouldn't: early access can only _start_ pre-publish, so at
  materialization `publishedAt` **is** the first publish. They diverge only on republish, where
  `publishedAt` is the value you want — the anchor would compute an `endsAt` in the past and expire the
  gate the instant it was created.

---

## Notes

- `pnpm typecheck` reports **5 pre-existing errors** (stale Prisma client vs schema — `pnpm db:generate`
  clears them). Same count with and without this session's changes.
- Local testing (@dev, userId 5): both versions are unpublished with no anchor, and `scores.models` is 0 —
  which is why early access was unavailable. The new score simulator covers this without a DB write.

---

## Second agent review (2026-08-05, post-fix)

Two agents — one correctness, one simplicity/comments. Findings verified before acting.

### Fixed

- [x] **Bulk paid access was unusable on live early access.** A version mid-window is Published by
      definition, so the "ever published" filter dropped exactly those — select 5 versions with running
      windows, set a price, and all 5 were skipped. Worse, the eligibility count then force-flipped the
      form to Permanent and **rewrote every running window as a permanent gate**. Both paths now carve out
      versions with an _active_ timed gate, matching `assertUserEarlyAccessLimits`.
- [x] **Usage-control migration planned from tombstones and swallowed failures.** `readGates` returned
      expired gates, so a migration POSTed a timed config the server rejects — leaving the version on the
      new usage control with a price on the tier that just vanished, reported as success. Expired gates are
      now excluded and failures are counted (`migrationFailures`).
- [x] **Concurrent-EA cap double-counted the selection** — re-pricing versions that already held windows
      was refused with nothing to deselect. Now excludes the selection, matching the permanent branch.
- [x] **Moderators were score-gated** on the bulk timed branch, unlike every other path.
- [x] **`donationGoalSupported` deleted** — always `true` at both call sites, with a doc comment asserting
      the opposite of what the code did.
- [x] **~20 comments removed** against the keep test, plus an orphaned paragraph that had drifted onto
      `bulkClearFee` and a stale reference to `bulkSetPermanentAccess` (renamed in this same diff).

### Recorded, not taken

Both agents flagged smaller cleanups, none load-bearing: collapse `priceCapFor`/`accessCapFor` into one
context function; model `action`/`applied` as a single `mode` union so "never both" is unrepresentable;
hoist the affirmation out of the field components so it isn't in three places; derive the score-simulator
labels from the ladder functions; share the polymorphic DonationGoal predicate between the CSV join and
`versionsWithDonationGoal`. Worth doing next time this code is opened.
