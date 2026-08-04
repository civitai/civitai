# Creator Studio Review — feedback triage (Jul 31 – Aug 4, 2026)

Source: "Creator Studio Review" Discord group DM. Window covers Fri 2026-07-31 00:00 through Tue 2026-08-04 07:43.
Reporters: MNeMiC (@mnemic1), alexds9, SubtleShader. A few items from Jul 29–30 are included where the thread is still unresolved.

Legend: `[x]` resolved in-channel · 🔄 in flight · ❓ needs verification

---

## Priority — assigned ClickUp tasks

All three came out of the **Creator Studio article (33297) comments, not the Discord DM**, and all three were assigned to Briant on 8/4. Take these ahead of the triage list below.

- [x] **Require creator affirmation of rights to monetize before paid access** — [CU 868kjuhj6](https://app.clickup.com/t/868kjuhj6), created 7/31. Gate setting a licensing fee or paid access behind an explicit affirmation that the creator holds the rights to monetize the model, its training data, and its content. The exposure is the point: hosting possibly-infringing content is one thing, **selling** access to it is materially worse, and an affirmation sets expectations, shifts responsibility to the creator, and strengthens our position in a dispute. Origin: top-upvoted community concern (dobomex761604 +8, PartiZanen) about models trained on unlicensed content.
  - **Implemented 8/4** — per-version affirmation on the Creator Shop pattern, recorded on `ModelVersion.meta.rightsAffirmation` as `{ userId, affirmedAt, version, statement }` with the wording stored verbatim so a later dispute shows what was actually agreed. Shared statement + predicates in `@civitai/buzz/rights-affirmation`; bump `MONETIZATION_RIGHTS_AFFIRMATION_VERSION` when the wording changes and everyone is asked again.
  - Covers all five write paths — tRPC `modelVersion.upsert`, the REST early-access endpoint, and Creator Studio's single / bulk / CSV-import fee writes. Asked once per version (already-affirmed versions aren't re-prompted), and not required to *clear* a fee or gate.
  - The moderator carve-out is scoped to **other people's** models. Exempting on the role alone meant every staff creator silently skipped the affirmation on their own models — which is also why the checkbox looked absent while testing.
- [ ] **Reaction breakdown: followers vs non-followers** — [CU 868kk4j2p](https://app.clickup.com/t/868kk4j2p), created 8/1. Requested by pablo_b (comment 2260887, 7 upvotes): split reactions on a creator's content by whether the reactor follows them. **Feasibility scout came back DOABLE** (MetaAgent, 8/1 5:43 PM) with one decision left:
  - Approach is bounded by number of *reactors*, not number of followers — aggregate the creator's image reactions in ClickHouse `entityMetricEvents_month` grouped by `userId` (net via `sum()`, since `metricValue` is a ±1 delta), then semi-join that small reactor list against PG `UserEngagement (userId IN (reactors) AND targetUserId = creator, type='Follow')`. Never materialize the full follower set. No new MV needed for a recent window.
  - **Blocking decision: window scope.** `entityMetricEvents_month` holds only a rolling ~month, and the all-time rollup `entityMetricDailyAgg_v2` has already discarded `userId` — so an all-time split isn't cheaply available without a new per-user aggregate plus backfill. Is a trailing-window breakdown acceptable, or do we want all-time?
  - Note the tension with MNeMiC's analytics asks below (lifetime history, rolling 30 days): if he gets lifetime ranges, a month-only reaction breakdown will look inconsistent next to them.
- [ ] **Bulk-set model-version permissions in Creator Studio** — [CU 868kk4j2n](https://app.clickup.com/t/868kk4j2n), created 8/1. Requested by RisingV (comment 2260930): set version permissions across many models/versions at once — e.g. flip a batch between "Download & On-Site Generation" and "On-Site Generation Only". Also evaluate a **bulk unpublish** option (JustMaier to raise separately).
  - **This is the same gap alexds9 and JustMaier already hit in Discord** — see *Bulk-edit Usage Control* and *Extend CSV import/export* under Feature requests. `9ceb92e0d6` shipped the single-version picker; alexds9 wrote his own script to flip 346 versions because no bulk path exists. Three independent reporters plus a script written to route around it — treat these as one piece of work, not three requests.

---

## Fixes

### Money-affecting

- [ ] **Generation compensation payouts appear stalled** — alexds9, 8/2 7:10 PM; follow-up 8/4 2:34 AM. Last "Compensation for generated images" transaction is 6 days old. Tips land daily and the licensing-fee graph shows earnings, but nothing transfers. On 8/4 he narrowed it: *Recent Yellow Transactions* shows **only** "Tip" rows — no Compensation and no License Fee rows at all — and the "License Fees Earned" graph total is larger than the tips he actually receives. MNeMiC (2:46 AM) has Compensation rows but no license fees (nothing enrolled), and alexds9 flags that MNeMiC having no daily Tip rows is itself odd since it was always Compensation + Tip. **Still never answered in-channel.** Likely root-caused by `a1ea8e0817` (CU 868kk4j2k): setting a licensing fee sets `ModelVersionFlag.DisablePayout`, and clearing the fee never stripped the bit, leaving 176 published versions across 134 creators earning nothing. Two reasons to keep this open: the backfill **migration must be applied manually** and is what actually releases the affected versions, and alexds9's report is dated *after* the commit. His second claim — fee earnings showing on the graph but not transferring — is a separate question the commit doesn't address.
- [x] **Early Access price cap regression** — MNeMiC, 8/1 4:24 AM. EA downloads charged 500 buzz against 10k/15k prices; the membership tier cap was applied to Early Access, which is meant to be uncapped. Confirmed working 8/1 3:24 PM, affected users credited in yellow buzz. Follow-ups below.
  - [ ] Grace period + warning email before a price drop on a lapsed membership (JustMaier committed, 8/1 9:45 AM).
  - [ ] Fall back to generation-only instead of silently repricing on lapse — SubtleShader, 8/1 8:45 AM. An expired card shouldn't auto-sell models at 500 buzz; he raises liability for selling at a price the creator never agreed to.
- [x] **Paid Access sales mislabeled as Early Access** — alexds9, 8/1 3:51 AM. Shown as "Gain early access on model:" in Buzz Dashboard *Recent Yellow Transactions* and Transaction History. Fixed in `86cedc5ca5` (CU 868kk3avq); only new transactions are affected, since the description is frozen into each ClickHouse row at write time.
- [x] **Transaction history renders yellow transactions as green** — MNeMiC, 8/1 4:25 AM (screenshots). Fixed in `86cedc5ca5` (CU 868kk3aw1); the bolt now takes its color from the row's account type and direction moves to the sign.
- [ ] **Draft models accrue 1 download before publish** — alexds9, 8/3 6:09 AM. Repros: models/2830674, models/2825921.

### Creator Studio

- [ ] **Licensing page never renders** — MNeMiC, 8/1 5:24 PM; detail 8/2 2:44 AM; **console error captured 8/3 4:19 PM**. `creator-studio.civitai.com/models` paints briefly, then the whole page goes black including the left nav. ESC at the right moment interrupts it but leaves the page non-interactive. Data *is* in the DOM (scraped it), so it's a render/overlay issue, not a fetch failure. Firefox + Chrome, all blockers off. **Blocks setting permanent access entirely.**
  - Root cause is now concrete: `Uncaught (in promise) Error: https://svelte.dev/e/each_key_duplicate` — a Svelte `{#each}` keyed block receiving duplicate keys, which tears down the whole subtree. Look for a keyed each over model/version rows where the key isn't unique (e.g. keyed by model id when a user has the same model twice, or by version name).
  - Kesler42 (8/3 4:11 PM) logged in **as MNeMiC** and the page rendered fine — so it's data- or client-state-dependent, not account-data-dependent alone. MNeMiC (4:28 PM) notes he runs **two accounts and switches between them**, which is the strongest lead for a duplicate-key collision in cached/merged client state.
- [ ] **Analytics defaults badly on the 1st of the month** — MNeMiC, 8/1 5:26 PM. On Aug 1 it defaults to August and compares 1 day against all of July. Should default to last *completed* month vs the one before.
- [ ] **"Per-model performance" is actually per-version** — MNeMiC, 8/1 5:28 PM. Mislabeled; previously raised.

### Upload / training

- [ ] **MXFP8 and NVFP4 precision auto-detection failing** — MNeMiC, 8/2 2:54 AM.
- [ ] **Precision dropdown is height-clipped with an invisible scrollbar** — MNeMiC, 8/2 2:56 AM. Options below the fold are undiscoverable.
- [ ] **Upload Files width differs between new-model and add-version flows** — MNeMiC, 8/2 3:04 AM. Type/Precision columns offset and not right-aligned when adding to an existing model. Firefox.
- [ ] **File upload hangs** — MNeMiC, 8/2 4:43 PM. Same model stuck twice. Regression: constant before the uploader rework 1–2 months ago, had stopped since. **Escalated 8/3–8/4 to all three reporters**: SubtleShader (8/3 10:18 PM) sees "upload finished but not getting added" on **40 GB+ files**, needing 3–5 retries before one sticks; MNeMiC (8/4 1:11 AM) confirms it went unstable again yesterday after a stable stretch; alexds9 (8/4 1:28 AM) had slow-and-stuck uploads the same day. Treat the size threshold as a lead — the finish-but-never-attach shape points at the post-upload finalize/commit step, not the transfer.
- [ ] **Mage Flow training cost calculation failing** — MNeMiC, 8/3 3:37 AM.
- [ ] **Missing training samples desync the epoch viewer** — MNeMiC, 8/3 4:22 PM. Fairly often no samples, or only some, come back from a training run. The new up-arrow "view next epoch" navigation then goes off-sync because absent samples collapse out of the list. Ask: render a "No Sample" placeholder that still occupies its slot.
- [ ] **Continued training restarts epoch numbering at 1** — MNeMiC, 8/4 2:08 AM. Any continued training reports its epochs as 1–10 again, including in the output filenames, so continued runs collide with the originals. Wants the true cumulative epoch number.

### Main site

- [x] **Free-preview generations are effectively hidden** — alexds9, 7/31 11:51 AM → 12:11 PM. With 1,000 free previews enabled, Create still demands payment; the free path was a small "here" link under "get generate access". Addressed in `8f5d83566a` (7/31, in main): the purchase modal now has a "Try it free" button behind an "or try it first" divider, and neither the "get generate access" nor the "here" copy exists in the codebase anymore. This modal is the only buyer-facing trial surface. Not re-confirmed by alexds9.
- [ ] **Purchase modal is worded as Early Access on permanent paid-access models** — SubtleShader, 8/1 ([CU 868kk3aw8](https://app.clickup.com/t/868kk3aw8)). `ModelVersionEarlyAccessPurchase.tsx` says "has set this version to early access… by purchasing it during the early access period or just waiting until it becomes public" and renders a `<Countdown>`, with no `permanent` branch — so a permanent sale is described as timed and as eventually becoming free. The transaction-description fix (`86cedc5ca5`) covered the ledger text only; this is the buyer-facing surface and is still open.
- [ ] **Swipe feature broke drag-and-drop into ComfyUI** — SubtleShader, 8/2 7:10 AM. Dragging an image from `civitai.red/images/*` into a ComfyUI tab to load the embedded workflow mostly fails; works right after F5. Called an essential daily workflow. **Now reported by an unrelated user too** (SubtleShader relayed it 8/4 3:05 AM), so it isn't environment-specific to him. He adds 8/4 7:42 AM that **the F5 workaround doesn't work on macOS** — i.e. the one escape hatch is platform-dependent.
- [ ] 🔄 **Duplicate notifications** — MNeMiC, 8/1 3:34 PM. One comment matching several notification settings fires 3–4 notifications. PR #3530 is up, deploy held for Monday.
- [ ] **Stale comment leaking through the comments cache** — alexds9, 7/31 2:13 PM. A 3-year-old comment appeared on a brand-new article. Suspected cache key overlap; **no root cause was posted.**
- [ ] **Scan-state vs visible/rated-state drift** — from the 44k re-stamped old images (alexds9, 8/2 9:46 AM). Queue drained and dates deliberately left as-is; the committed follow-up is to stop the two states diverging.
- [ ] **NSFW rating accuracy** — SubtleShader, 8/2 10:41 PM (examples). Images rated R that clearly aren't, plus PG/PG-13 images that should be R or X.
- [ ] **Subscription page doesn't state the paid-access price caps** — MNeMiC, 8/1 4:28 AM. Caps went live with no advance notice; this drove most of the 8/1 friction. Partly addressed by `149b360b2f` (#3513, in main), which adds a tier-gated benefit line to the membership plan cards and a "Charge more as you climb" section to the Creator Program page — but **deliberately numberless** (Free < Bronze < Silver < Gold) because the per-tier cap numbers are still placeholders. MNeMiC's actual ask was the numbers, so this stays open until the caps are final.

---

## Feature requests

### Creator Studio

- [ ] **Analytics history beyond 1 year → lifetime** — MNeMiC, 8/1 5:23 PM. Wants seasonal trends; explicitly called a key metric.
- [ ] **Rolling "Last 30 days" range option** — MNeMiC, 8/1 5:26 PM.
- [ ] **Model-level rollup view alongside version-level** in per-model performance — MNeMiC, 8/1 5:28 PM.
- [ ] **Desktop table view for licensing/bulk edit** — alexds9, 7/29. Current design is mobile-first; a separate desktop view may be worth it. Also: keep bulk-edit mode open between operations instead of collapsing it.
- [ ] **Named price groups / price tags** — alexds9 + MNeMiC, 7/29. Tag models ("very-desired", "not-desired"), set a price per tag, change the tag and every model follows. Modeled on Google Play price templates.
- [ ] **Extend CSV import/export to paid-access rates and Usage Control** — JustMaier asked directly, 7/31 12:44 PM. alexds9 wrote his own script to flip 346 versions from generation-only to paid-access + download. Answers the open 7/29 question: expand the import/export buttons rather than retire them.
- [ ] **Bulk-edit Usage Control** (Gen-only ↔ Download & Gen) on the page — JustMaier, 7/31 1:05 PM. `9ceb92e0d6` (7/31, in main) made usage control an editable per-version picker with its own save — previously it was read-only context echoed into the paid-access form as a hidden field. **Single-version only; the bulk path alexds9 scripted around is still missing.**
- [x] **Allow 0 buzz generation price / unlimited free previews** — alexds9 + SubtleShader, 7/31 6:07 AM. Shipped same day in `0e0e1d718d` (in main): generation is now a three-way choice — same as access price / cheaper generation-only price / free for everyone — matching the three `GenerationGrant` shapes. The free grant carries no price and no trial limit, so the 1,000-preview ceiling no longer applies to it (it's still 1,000 for paid generation).
- [ ] **Revisit paid-access price caps** — sustained push from alexds9 and SubtleShader all weekend, with a concrete counter-proposal: **minimum prices instead of maximums** (SubtleShader, 8/1 6:14 AM). JustMaier's position (8/1 10:31 AM) is that high caps out of the gate would shock consumers and he wants to ease into pricing. Track as a revisit, not a change.
  - **Counter-proposal firmed up 8/3 evening into two specific asks.** (1) alexds9, 7:28 PM: Free→Bronze is the conversion that matters, and a 500 → 1,000 buzz cap makes the two tiers feel the same; Bronze should be 2,500–5,000 if Free is 500. (2) alexds9, 7:28 PM: **replace price caps with a monthly limit on how many models you may *add* to Paid Access** — Free 3/mo, Bronze 10/mo, Silver 25/mo, Gold unlimited, no price ceiling at any tier. His argument: new slots every month motivates output, whereas capping price penalizes a creator's investment in an individual model; and buzz-withdrawal requirements are already tier-restrictive, so the benefits needn't be too.
  - SubtleShader, 9:39 PM (+2 💯): agrees; caps limit Civitai's revenue as well as the creator's and "teach them to undersell". Adds a demand-decay data point — interest in a model drops sharply after 5–10 days, so throughput of new paid releases is what drives revenue, which is what makes a per-month add limit the better lever than a price ceiling.

### Model page / site

- [ ] **Persistent Paid Access indicator for creators** — alexds9, 8/2 5:31 AM (+1 SubtleShader). The price tag flashes on the Download button for a second on refresh then vanishes, leaving no way to confirm a model is in paid access at the right price. Suggested: keep it visible in gray, **plus a badge on model thumbnails** in your profile. SubtleShader notes TA uses a `$` in the tab.
- [ ] **"Hide post from gallery"** as a single action — SubtleShader, 8/2 10:36 PM. Currently 20× "Hide image from gallery". Confirmation dialog is fine.
- [ ] **Let creators raise their own image ratings** (PG/PG-13 → R/X) — SubtleShader, 8/2 10:41 PM. Upward-only edits are safe since nobody over-rates their own content.
- [ ] **Option to hide Blue Buzz from the top-right balance** — alexds9, 8/3 5:15 AM. Blue buzz noise obscures sales performance. Default stays combined; opt-in yellow-only display, both still shown in the dropdown.
- [ ] **Mute/unfollow a notification thread** — JustMaier, 8/1 3:36 PM, alongside the dedup work.
- [ ] **Architecture-name suffix on trained model filenames** — MNeMiC, 8/3 3:40 AM. Multi-architecture training produces identical filenames; wants `esadribicstyle_krea2` / `esadribicstyle_pdxl`. Prefers a shared standard, default-on, and **sticky** so it isn't re-enabled every run.
- [ ] **Customizable precision list** (hide unused formats) — MNeMiC, 8/2 2:56 AM. He flagged this himself as possibly over-scoped.
- [ ] **SFW/NSFW section markers in descriptions** — SubtleShader, 7/30. Comment-style markers so one description renders differently on .com vs .red instead of maintaining two. Also applies to "About This Version".
- [ ] **Blue buzz rewards for gallery contributors** — SubtleShader, 8/1 9:18 AM, re article 33331. Wants creator-side abuse controls: opt-in application/approval per contributor, and a daily blue-buzz cap per contributor to stop mass near-identical posting.

---

## Notes

**The compensation-payout report never got a reply.** Everything else in the window got at least an acknowledgement; that one scrolled past during the EA pricing fire. If real, it's six days of unpaid generation compensation.

**Most of the weekend's heat wasn't about bugs.** The EA cap regression, the undocumented caps on the subscription page, and the two separate Creator Program articles (MNeMiC, 8/1 4:34 AM: unclear whether the second supersedes the first or only lists deltas) all landed as communication failures.

- [ ] Publish a single consolidated, current-state Creator Program article rather than an original plus a changes article.
- [ ] Document the per-tier paid-access caps on the subscription page.
