# Paid model loading — launch-day triage

Feedback from the launch announcement's comment thread, first 3.5 hours after release
(2026-09-25). Items only; reporters and sources are kept privately. The thread was still live when
this was written, so this is a first pass rather than a complete list.

Feature docs: [paid-model-loading.md](paid-model-loading.md).

## Bugs

### B1 — The boost is offered whenever the unboosted ETA is unknown
- [ ] `boostBuysVisibleTime` (`src/components/ResourceLoad/download-eta.ts:70-72`) returns **true**
  when `etaSeconds == null`, deliberately — nothing contradicts an unknown wait. `isWorthBoosting` is
  the only gate `DownloadBoostPanel.tsx:128` applies, and it carries no model-type or size filter.
- The boost fee is **flat per workflow**, so a user who cannot see a standard-lane ETA can be offered
  a checkpoint-priced boost to speed a 30 MB LoRA. Reported independently by two users.
- **Mostly downstream of B4**: the inflated small-file ETA is what made the boost read as worth
  offering, and that is fixed. A size floor on the offer itself was considered and deliberately **not**
  added, to avoid layering a second rule over a cause already addressed. Revisit only if bogus offers
  survive the B4 fix.
- **Closes when:** re-checked in production after B4, and either shown to be resolved or given its own
  rule.

### B2 — Every resource type participates in loading, not just checkpoints
- [ ] Measured on production, 2026-09-25 — versions with `coveredNext`, by type:

  | Type | Covered versions | Resident |
  | --- | --- | --- |
  | LORA | 886,098 | 6.5% |
  | Checkpoint | 31,755 | 3.2% |
  | LoCon | 16,136 | 6.0% |
  | TextualInversion | 6,292 | 5.3% |
  | DoRA | 1,716 | 4.7% |
  | VAE | 251 | 31.1% |
  | Upscaler | 54 | 40.7% |

- Non-checkpoints are ~96% of covered versions, so the overwhelming majority of "not loaded" badges
  and download waits are on resources the feature was not designed around —
  [paid-model-loading.md](paid-model-loading.md) records "loading is for checkpoints (size is why the
  loader exists)" as decided. B1, B4 and B5 all reach users through this.
- Reported by three users.
- **Closes when:** a decision is recorded on whether non-checkpoints show residency at all, and the
  badge and boost surfaces match it.

### B3 — "Waiting on downloads" while every component shows loaded
- [ ] Contradictory state on a single page. Not reproduced. Suspected cause is the generation step's
  `preparation` block disagreeing with the live per-version status the badges read; the two refresh
  by different paths.
- **Closes when:** a workflow id is captured showing both states and the disagreement is explained or
  fixed.

### B4 — ETA swings wildly on small files — **fixed, awaiting production confirmation**
- [x] A 30 MB LoRA quoted ~2 minutes, then 1h15m. Cause: `isEtaSettled` believed a transfer's ETA once
  **either** a fraction of it **or** a fixed byte count had moved, whichever came first. On a large
  file the byte floor won and the sample was real; on a small one the fraction won and resolved to a
  size still inside the ramp-up — so the guard against projecting from a ramping stream got weaker the
  smaller the file, which is backwards.
- Fixed by requiring the byte floor, bounded by a fraction of the file so anything smaller than the
  floor still settles. Checkpoint-sized transfers keep the thresholds they had; only the small end
  moves.
- B1 is largely downstream of this — an inflated ETA is what made the boost look worth offering.
- **Closes when:** a small resource's quoted ETA is observed holding steady in production and the
  reporters confirm.

### B4a — Is a queue position comparable across resource types?
- [ ] `summarizeDownloads` collapses every downloading resource into a single `queuePosition`, and the
  availability contract carries `queuePosition` and `lane` but **no queue identity** — so the site
  cannot tell whether it is reporting one queue or several.
- If the orchestrator runs a separate, faster queue for smaller non-checkpoint files, then "#3 in
  queue" for a LoRA and "#3" for a checkpoint describe different waits, and collapsing them into one
  number is a display defect independent of B4.
- **Closes when:** the orchestrator states how many queues a resource can be waiting in, and the
  summary either stays as-is or reports per-queue.

### B5 — Priority lane quoting ~1h10m for a 6.46 GB checkpoint
- [ ] Possibly the same defect as B4 rather than a separate one, but it is what paying members see.
- **Closes when:** re-measured after B4 lands, and either fixed or confirmed as the real rate.

### B6 — Stuck on "Waiting on downloads — starting"
- [ ] Two reports against the same ecosystem, one noting a base model should never need loading.
  Production data shows that ecosystem's LoRAs are overwhelmingly non-resident while covered, which
  is consistent with the wait being on a LoRA and the message naming the ecosystem — so a base-model
  eviction is **not** established.
- **Closes when:** a workflow id is captured and the waited-on resource identified.

### B7 — "Potentially ToS violating content detected"
- [ ] Offered directly in response to the article's request for breakage reports, with no prompt,
  model or workflow id. Its relation to this release is unestablished — it may be ordinary prompt
  moderation surfacing more often now that more models are reachable.
- **Closes when:** a workflow id is obtained and the report is either tied to this release or ruled
  out.

### B8 — Standard lane shows no speed or ETA — **not ours to fix**
- [x] Investigated. `rateLimitBytesPerSecond` exists on the availability union only for the lane the
  viewer is **currently in**; no per-lane cap is reported anywhere. So a lane the viewer is not in
  cannot quote a speed, and the display showing nothing is correct rather than broken.
- [ ] Needs the orchestrator to expose per-lane caps, or acceptance that only the occupied lane
  quotes one.
- **Closes when:** the orchestrator answers, alongside B4a.

### B9 — "No speed cap" could be shown for the SLOWEST lane — **fixed**
- [x] Found next to B8. `formatLaneSpeed` mapped `null` to "no speed cap" on the assumption that only
  the uncapped high lane reports null — nothing enforced that, so an absent figure on the free lane
  would have advertised it as the fastest. Null now reads as uncapped only on the boosted lane, and
  as "unknown" everywhere else. The same assumption in the boost panel's "boosted lane" note is now
  derived from the lane too.

### B10 — Boost offered on the user's own uploaded image — **fixed**
- [x] An i2v source image arrives in the step's `preparation` exactly like a checkpoint does, so a
  request with nothing to download still showed "Waiting on downloads" and offered a paid boost on
  the uploader's own file. Supplied orchestrator blobs are now filtered out of `normalizePreparation`,
  which every consumer goes through; a training epoch's weights are a blob too and are kept, being a
  real download worth boosting.

## Decisions and official answers needed

### D1 — Auction winners from the day before release
- [ ] Bids were placed for a week of guaranteed residency less than 24 hours before the rules
  changed, and the auction wording was updated only afterwards. Raised three times by the same
  creator and attempted-answered by two others; no official reply in-thread. This is a
  refund/grandfather decision rather than a bug, and the most likely item to escalate.
- **Closes when:** an official answer is posted in the thread, and any grandfathering or refund is
  recorded here.

### D2 — Do loaded models stay loaded?
- [ ] Asked three times; answered plausibly by other users with an LRU-eviction model, never
  confirmed officially.
- **Closes when:** the eviction rule is stated in the article or a reply.

### D3 — Do Perks memberships get the priority lane? — **yes, answered**
- [x] They do. The gate reads `(tier ?? 'free') !== 'free'`, and the Referral Perks products carry the
  same `tier` metadata as the paid ones (bronze/silver/gold), so a Perks subscriber passes it and gets
  both the coverage expansion and the priority lane.
- [ ] The remaining gap is documentation: neither the membership page nor the Perks page mentions model
  loading at all, which is what prompted the question.
- **Closes when:** both pages say what a membership and a Perks subscription include here.

### D4 — Standard lane: hard cap or demand-dependent?
- [ ] Asked once, unanswered.
- **Closes when:** answered in-thread.

### D5 — When does this open to non-members?
- [ ] Users are reading the members gate as a permanent lockout rather than a staged rollout.
- **Closes when:** the rollout condition is stated publicly.

### D6 — Custom video checkpoints cannot be loaded — **correct behaviour, every case explained**
- [x] Checked against production. Of 73 MiniMax H3 checkpoints, 52 are covered under the expansion.
  Every uncovered one has a reason:
  - **GGUF** — 9 of the 21. The loader serves SafeTensor only, which `UNLOADABLE_MESSAGES` states.
    The model named in the thread is itself a GGUF build.
  - **Not a checkpoint** — most of the named "can't load these" entries are type `Workflows` or
    `Other`, which were never loadable as a generation checkpoint.
  - **Unpublished or draft** — 5 of the 7 uncovered versions that do carry a SafeTensor.
  - **Unscanned** — the remaining 2 are ~63 GB uploads whose pickle and virus scans are still
    `Pending`, or whose only SafeTensor is an `Enhancement LoRA` rather than a `Model` file.
- [ ] Nothing to fix in code. The gap is that none of this is stated where a user hits it.
- **Closes when:** the article or the picker says why a checkpoint is not loadable.

## Product feedback — recorded, not actioned

- **P1** A creator who bids compared boosting an Illustrious checkpoint (~4 minutes for 700 paid
  Buzz) against holding an auction slot (1000/week) and concluded the boost is not worth it. Worth
  having when the boost price is next reviewed.
- **P2** The 1000 Buzz checkpoint auction minimum reads as steep now that residency can be bought
  separately.
- **P3** At least one bidder said they would end standing auction bids because of this release — a
  behavioural signal that the auction's value changed on release day.

## Sentiment

Broadly positive, with explicit wariness. Several users referenced the previous checkpoint-coverage
rollback unprompted and are watching for a repeat; others called the design reasonable and
congratulated the team. The tone is "this looks right, prove it holds".
