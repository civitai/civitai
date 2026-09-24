# Paid model loading — boosting as a separate workflow

**Status: proposed, nothing built.** This is a successor design for how a boost is paid for and
displayed. What ships today is described in [paid-model-loading.md](paid-model-loading.md); nothing
here contradicts what is built, but several items change decisions recorded there, and those are
called out.

## Why the shape changes

Today a boost is an upgrade to the generation workflow: the site `PUT`s a higher `downloadPriority`
and the fee comes back as `cost.fixed.downloadPriority`. That ties the boost's currency to the
generation's, which is the thing we want to break — a user paying for generation with one Buzz colour
should be able to boost with another.

Upgrading a live workflow to a different currency was rejected on the orchestrator side: it
complicates every later payment decision on that workflow, including its own refunds. The supported
alternative is to **submit a second workflow** carrying just the load steps and the currency of its
own choosing.

## The shape

- **One multi-step workflow per boost.** One `prepareResource` step per model, not one workflow per
  model.
- It emits the **standard workflow signals** — `preparing → processing → succeeded` — so no bespoke
  signal channel is needed on this path.
- Generation is submitted as its own workflow, unchanged. Neither waits on the other: both race on
  the same shared download, and the lane is whichever requester asked highest.
- ETAs use the **longest** of the models being loaded. `summarizeDownloads` already does this
  (`maxKnown`), so no change there.

`prepareResourceStep` currently hardcodes `name: PREPARE_STEP_NAME`, which is fine for the one-step
explicit purchase and not for N steps in one workflow. Distinct step names are required.

## Which resources the boost covers — the site cannot compute this itself

A generation prepares resources the site never named. What actually gets downloaded is a product of
the **job type**, decided inside the workflow step — a training on a model requires different things
from a generation on the same model. A load workflow built from the site's own list of the user's
chosen resources therefore does **not** cover them, and those models would load unboosted while the
boosted ones raced ahead.

The list does exist, but only after submit: the **generation workflow's own response carries the
resources being prepared**, and that list includes the behind-the-scenes ones. So the boost's step
list is derived from the submitted generation workflow, not computed on the form.

That forces an ordering decision:

| | Where the boost is offered | What it covers |
| --- | --- | --- |
| **Pre-submit** | the generation form, priced from `whatif`, as today | only what `whatif` reports — behind-the-scenes resources are missed |
| **Post-submit** | the generation's queue item, once its prepared-resource list is known | everything that will actually download |

Post-submit is complete, and it fits decision 1 — if a boost is its own queue item, "boost this" being
an action on an existing entry is coherent, and by then the real ETA is known. The cost is a product
change: boosting stops being a checkbox priced in the form footer.

Pre-submit remains viable if the gap is judged acceptable — behind-the-scenes models are reported to
be rare and largely resident already, in which case the missed set is usually empty. That is a
judgement call, not a technical blocker, and it needs making before either is built.

It is also stronger than it first appears. A `whatif` step's `preparation` array already carries **one
entry per resource needing download, of any type** — a checkpoint and a LoRA in the same generation
each get their own `resource`, `sizeBytes`, `lane`, `queuePosition` and `etaSeconds`. So a pre-submit
boost can enumerate and price everything `whatif` knows about; the only thing it cannot see is
resources the job type adds. Whether those appear in `preparation` too is untested — the sample that
established the rest had none needing download.

## Decisions

### 1. A boosted load workflow is shown as its own queue item

The boost becomes an object the user owns, rather than an invisible side effect of a generation.
Three things follow from that and are the reason for it:

- **The refund is legible.** A partial refund on an invisible workflow is a balance changing for no
  stated reason.
- **Cancellation has a natural affordance** — the user cancels the thing they bought.
- **Coarse step status is survivable.** `preparing → processing → succeeded` works on a dedicated
  card in a way it does not when it has to drive a countdown embedded in a generation card.

### 2. It does NOT replace the per-generation download display

Stated separately because the first reading of decision 1 was that generation cards would no longer
need loading state at all. They do.

An un-boosted generation waiting on a cold model loads **inside its own generation workflow** — there
is no second object to show. Those are the majority of cold starts. Remove their in-card download
state and a non-boosting user watches a generation sit there with no explanation.

So both surfaces exist, and a boosted generation shows both. They answer different questions:

| Surface | Question it answers |
| --- | --- |
| Generation card | When will *this* generation be ready, and what is it waiting on |
| Boost queue item | What did I buy, did it work, and what came back if it didn't |

Making every load a separate workflow — boosted or not — would collapse this into one presentation,
and is rejected: it doubles workflow volume for every cold generation rather than only the boosted
ones.

### 3. The generation card needs no wiring to the boost

It already works. `mergeDownloadRow` takes progress and ETA from the **live per-model status** and
only lane, cap and position from the workflow's own `preparation`. Every waiter shares one physical
download, so a boost raising it to the high lane makes the live status report faster progress and a
shorter ETA, and the generation card picks both up unchanged.

The lane is the one thing it does not take from live, which stays correct here: the generation
workflow asked at its own lane, and the fact that a boost moved the transfer to `high` is the boost's
to report. So the generation card does not claim to be boosted — that belongs on the boost item, which
is an argument for decision 1 rather than a cost of it.

Two things follow:

- **The boost card reuses this derivation** rather than computing progress a second way. Not because
  the numbers would otherwise conflict — both read the same live status — but because a second
  derivation of one transfer is a second thing to keep correct.
- **A missing live ETA falls back to `preparation`'s**, which was computed at submit and therefore
  pre-boost. Rare, but it shows a stale slow number after the lane has already changed.

### 4. A boost workflow does not count against the generation cap

Already true and easy to lose: `getUserQueueStatus` filters on `WORKFLOW_TAGS.GENERATION`
(`queue-limits.ts`), and load workflows carry `resource-load`.

The risk is specifically that whoever makes the cards visible reaches for that same tag list. The
display query and the limit query stay separate. Worth a guard asserting the limit query's tags
exclude `resource-load` — the failure is silent and in the direction that hurts, a boost quietly
eating a generation slot.

### 5. No boost offer for resources already under an in-flight boost

Expressed as a **set difference**, not a superset check: the boost targets the models not already
covered by one of your own in-flight boost workflows, and the button disappears only when that
difference is empty. Hiding on superset alone means a generation needing three models, two of which
are already boosted, can never boost the third.

Both sides of that difference are the **prepared-resource list**, not the user's chosen resources —
see [Which resources the boost covers](#which-resources-the-boost-covers--the-site-cannot-compute-this-itself).

- **In-flight only.** A failed boost must not suppress the button; a succeeded one need not, because
  the models are resident and the existing cold check already hides it.
- **The server enforces it.** Client-side the rule is presentational — two tabs or a fast double-click
  still pays twice otherwise, which is a double-boost testers have already hit. The server computes
  the same difference at submit, drops covered resources from the step list, and refuses when nothing
  is left.

This is cheap because of decision 1: if boost workflows are queue items, the client already holds
their steps and needs no new query.

**Scope:** your own in-flight boosts. Another user having already boosted the same model is not
visible to us and does not need to be — `isWorthBoosting` already declines when the lane is `high`,
whoever put it there.

### 6. Cancellation

Cancelling a load workflow cancels the steps whose downloads have **not started** and issues a
**partial refund** for them, under the same refund rules as any other workflow. Steps already
downloading are not refunded.

Because the boost is its own object (decision 1), generation cancellation does not cascade into it.
That removes the need to reason about whether another of your queued generations still depends on a
model in that workflow — the dependency question only arises if a generation's cancellation implies a
boost's, and here it does not.

## What this changes in the shipped design

- **C2 stops being irrelevant to the boost.** [paid-model-loading.md](paid-model-loading.md) records
  that the boost has its own fee and is unaffected by prepare steps quoting zero — true only while the
  fee rides on a generation workflow's `cost.fixed.downloadPriority`. With no generation workflow to
  read it from, the boost's price has to come from the load workflow, and C2 becomes this design's
  blocker rather than a moderator-tool detail.
- **`BOOST_NON_REFUNDABLE`** — "The boost fee isn't refunded if you cancel the generation" — is
  accurate today and becomes wrong the day decision 6 ships. It reached testers deliberately, in
  response to their asking; it has to change with the architecture, not after it.
- **Surfacing load workflows in the queue makes the existing explicit-purchase loads visible too.**
  Those already ship and are currently invisible. Possibly an improvement, but it is a live behaviour
  change riding along on this one.

## Open

| Question | Closes when |
| --- | --- |
| **Pricing.** `CalculateCost` returns an empty cost for a prepare step, so `whatif` reports 0 — tracked as C2 in [paid-model-loading.md](paid-model-loading.md). Submitting a load workflow with a chosen currency implies it *charges*, so the gap may be `whatif` alone. Nothing can be shown before submit until this resolves. | a multi-step `prepareResource` workflow returns a non-zero `whatif` cost, or C2 closes stating it never will |
| **Do load steps carry download ETAs?** The answer covering multiple models per workflow did not separate this from it. Only the boost card is affected — per decision 3 the generation card reads live status and is unaffected — but without one the boost card has no countdown of its own. | the orchestrator states whether a `prepareResource` step reports an ETA |
| **How is a flat boost fee apportioned across a partial refund?** `cost.fixed.downloadPriority` is one figure for the whole workflow, not per resource, while cancellation refunds *per un-started step*. Step count is the wrong divisor when one step is a 4 GB checkpoint and another a 130 MB LoRA. | the orchestrator states the apportionment, or states that the fee is per-step in a load workflow |
| **Is the boost fee per workflow or per prepare step?** Today one fee covers however many resources a generation needs. A load workflow with N steps may charge once or N times, which changes the price of boosting a multi-resource generation. | a multi-step load workflow's `whatif` shows which |
| **Pre-submit or post-submit boost.** The ordering decision above. Not blocked on anything — it needs a product call. | Briant decides, and it is recorded here |
| **Queue-item lifecycle.** The success path is meaningless after seconds; the cancel/refund path is the one whose whole value is being readable afterwards. | the asymmetry is specified before the card is built — Justin or Briant reviews a mock |
