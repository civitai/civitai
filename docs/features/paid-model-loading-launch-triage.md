# Paid model loading — launch triage

What the launch announcement's comment thread surfaced on 2026-09-25, what was fixed, and what was
deliberately left. Reporters and sources are kept privately.

One item is still open: a report whose likeliest cause was fixed two days after it was made, needing
confirmation that the fix addressed it. Everything else is shipped, decided, or closed with a reason.

Feature docs: [paid-model-loading.md](paid-model-loading.md).

## Fixed

**The boost was offered on things that were not worth boosting.** The fee is one flat charge per
workflow, sized against multi-gigabyte weights, but the offer fired on any pending download — so a
user waiting on a 30 MB LoRA saw a checkpoint-priced boost to save seconds, and a large ETA ratio made
it look justified. Both gates now require the resource's real model type to be a Checkpoint
(`isBaseWeightsType`), at the queue card and the pre-submit offer.

Deliberately not read from the AIR: a Checkpoint whose primary file is a standalone denoiser
advertises `diffusionmodel` or `unet` instead (`stringifyAIR`'s `fileTypeUrnMap`), which is every
Flux / Wan / ZImage / Anima / Boogu base model, so matching `checkpoint` alone would have refused a
boost on the largest downloads there are. A size floor was tried first and dropped — type is the
property the fee is actually sized against.

**A boost was offered on the user's own uploaded image.** An i2v source image arrives in a step's
`preparation` exactly like a checkpoint does, so a request with nothing to fetch still reported
"Waiting on downloads" and sold a boost on the uploader's own file. Supplied orchestrator blobs are
filtered in `normalizePreparation`, which every consumer goes through. A training epoch's weights are
a blob too and are kept, being a real download.

**Small files quoted wild ETAs.** A 30 MB LoRA quoted ~2 minutes, then 1h15m. `isEtaSettled` believed
a transfer's ETA once *either* a fraction of it *or* a byte floor had moved, whichever came first — so
on a large file the byte floor won and the sample was real, while on a small one the fraction won and
resolved to a size still inside the ramp-up. The guard got weaker the smaller the file, which is
backwards. It now requires the byte floor, bounded by a fraction so a file smaller than the floor still
settles; checkpoint-sized transfers keep the thresholds they had.

⚠️ This corrected the **number**, not a real wait. The same reporter later described waiting two hours
for a ~30 MB LoRA, which no display fix reaches.

**"Potentially slow generation" blamed downloads for a busy queue.** The alert claimed "we need to
download additional resources" whenever the whatIf came back not-ready with nothing to download.
`ready` is derived from `queuePosition.support` — a `JobSupport` of available / unavailable /
unsupported, describing worker capacity — so it carries no claim about resources, and users whose
models were all resident were told otherwise. The alert still shows; only the invented cause is gone.

This was also the cause of the separately-reported "waiting on downloads while every component shows
loaded". The suspicion recorded at the time — the step's `preparation` disagreeing with live
per-version status — was **wrong**, and is written down so nobody chases it again.

*Known limitation:* `unavailable` and `unsupported` collapse into one boolean on the wire, so the copy
cannot separate "no worker free" from "this cannot run here". It now asserts neither. Widening `ready`
into a reason is our side entirely — the orchestrator already sends all three states — but it changes
a whatIf response shape App Blocks also consumes.

**"No speed cap" could be shown for the slowest lane.** `formatLaneSpeed` mapped a null cap to "no
speed cap" on the assumption that only the uncapped high lane reports null. Nothing enforced that, so
an absent figure on the free lane would have advertised it as the fastest. Null now reads as uncapped
only on the boosted lane.

## Open — one report, awaiting confirmation

### A resource loads, generates once, then needs loading again

Reported against one video ecosystem after a long wait. **Eviction is not the explanation**, which
overturns the first reading of this.

Measured directly, by capturing the resident id *set* twice rather than watching the count: over a
7-minute window, **2 evictions and 16 loads across ~53,900 resident versions**. Net count movement of a
few hundred, which had been read as churn, is the reconcile job's own noise. At that rate mean
residency is months, not minutes — nothing is being evicted between generations.

`generatorLoaded` is also not stale: it is fully reconciled against the orchestrator's resident list
every 15 minutes, diffed both ways, with a refusal to clear on an empty list.

The likeliest remaining explanation is the alert defect fixed above — "we need to download additional
resources" was shown whenever the queue was merely busy, which reads exactly as *it needs to load it
again*. That fix did not exist when this was reported, and released in **v5.1.141** two days later.

So the defect that best explains the report is fixed and out. What has *not* been established is that
it is what the reporter saw: there is no workflow id, and the link is inference.

**Closes when:** the same ecosystem is exercised on v5.1.141 or later and the message does not recur —
or it does, with an id, and this becomes a different investigation.

### For reference — what the cluster is actually holding

Resident working set, measured 2026-09-28:

| Type | Resident versions | Bytes |
| --- | --- | --- |
| Checkpoint | 2,162 | 20.2 TB |
| LORA | 50,344 | 9.5 TB |
| LoCon | 846 | 120 GB |
| everything else | ~430 | ~42 GB |

Checkpoints are **4% of resident versions and 68% of resident bytes**. Resident checkpoints roughly
doubled over the first weekend (1,075 → 2,162), consistent with loading opening beyond members, while
the total resident count fell — so checkpoints are displacing smaller resources, which is the shape to
watch if capacity becomes a question.

## Decided

### Non-checkpoints keep their residency badge

Non-checkpoints are ~96% of covered versions, so nearly every "not loaded" badge a user meets is on
one — which is what the first commenter noticed twenty minutes after release, and why this was
initially read as scope creep.

Kept deliberately. The badge tells a user that files still have to be downloaded and that this
generation will take longer than usual, which is true and useful whatever the resource type. The half
that was wrong was charging for it: the boost offer is now checkpoint-only, since the fee is flat per
workflow and sized against weights of that order.

On-demand loading of non-checkpoints predates this release in any case — it was the old "we need to
download additional resources" behaviour. Users did not gain a wait; they gained a clearer account of
one they already had.

## Closed without action

Recorded so they are not re-triaged. None is a work item: each either has no owner, no closing
condition anyone will check, or turned out to need nothing.

- **Free users wait for loads the members gate was supposed to spare them.** Moot: loading has since
  been opened to all users, so there is no gate for the non-checkpoint path to be inconsistent with.
- **Auction winners from the day before release.** Bids bought a week of guaranteed residency less
  than 24 hours before the rules changed. Raised three times in-thread. Judged not to need action.
- **Do loaded models stay loaded?** Asked three times, never answered officially. Checkpoints are
  intended to stay at least two days, unconfirmed in practice. No action taken.
- **Standard lane: hard cap or demand-dependent?** Asked once. Answer not known, no reply planned.
- **When does this open to non-members?** Being read as a permanent lockout rather than a staged
  rollout. No announcement planned.
- **Do Perks memberships get the priority lane?** They do — the Referral Perks products carry the same
  `tier` metadata as the paid ones, so they pass `(tier ?? 'free') !== 'free'`. The membership pages
  say nothing about model loading, but the members-only period is temporary, so this was not worth
  documenting.
- **Standard lane shows no speed or ETA.** Not ours: `rateLimitBytesPerSecond` exists on the
  availability union only for the lane the viewer is in, and no per-lane cap is reported anywhere. The
  display showing nothing is correct. Needs the orchestrator to expose per-lane caps; not asked.
- **Is a queue position comparable across resource types?** `summarizeDownloads` collapses every
  downloading resource into one `queuePosition`, and the contract carries no queue identity. If the
  orchestrator runs a separate faster queue for smaller files, that number mixes scales. Not asked.
- **Priority lane quoting ~1h10m for a 6.46 GB checkpoint.** Most likely the same defect as the ETA
  warm-up, now fixed. Not re-measured.
- **Two unreproduced reports**, both lapsed for want of a workflow id: a step stuck on "Waiting on
  downloads — starting", and a "Potentially ToS violating content detected" offered in answer to the
  article's request for breakage reports, whose relation to this release was never established.
  Reopen if either recurs with an id.

### Custom video checkpoints cannot be loaded — correct behaviour

Kept because it explains a recurring complaint, and the answer changed under it on 2026-09-29.

At triage, 52 of 73 MiniMax H3 checkpoints were covered, and every uncovered one had a file-level
reason:

- **GGUF** — 9 of the 21. The loader serves SafeTensor only, which `UNLOADABLE_MESSAGES` states. The
  model named in the thread is itself a GGUF build.
- **Not a checkpoint** — most named entries are type `Workflows` or `Other`, never loadable as one.
- **Unpublished or draft** — 5 of the 7 uncovered versions that do carry a SafeTensor.
- **Unscanned** — the last 2 are ~63 GB uploads with pickle and virus scans still `Pending`, or whose
  only SafeTensor is an `Enhancement LoRA` rather than a `Model` file.

Those reasons no longer decide the case for **community** checkpoints here. MiniMax H3 is
`modelLocked`, so
`isGenerationEligible` holds every **community** checkpoint on it to the live rule — 47 were being
offered on 2026-09-29, 4 of them already loaded. The ecosystem's own
`EcosystemCheckpoints` versions keep their coverage. The refusal is now deliberate rather than
incidental: the graph rewrites a custom checkpoint back to the workflow default, so loading one buys
nothing. Reasoning and the per-base-model table:
[paid-model-loading-coverage.md](paid-model-loading-coverage.md), "Model-locked ecosystems".

Nothing to fix. The gap is that none of it is stated where a user hits it.

## Pricing signal

Not work items; worth having when the boost price is next reviewed. A creator who bids compared
boosting an Illustrious checkpoint (~4 minutes for 700 paid Buzz) against holding an auction slot
(1000/week) and concluded the boost is not worth it. The 1000 Buzz checkpoint auction minimum reads as
steep now that residency can be bought separately, and at least one bidder said they would end standing
bids because of this release.

## Not this feature

Noise artifacts reported on every generation from one video ref-to-video model — a generation-quality
report that landed here because the thread was busy.

## Sentiment

Broadly positive with explicit wariness: several users referenced the previous checkpoint-coverage
rollback unprompted and are watching for a repeat, while others called the design reasonable. As the
evening went on it soured wherever waits were involved. The complaints cluster on waiting, not on the
pricing or the concept.
