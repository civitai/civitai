# Paid model loading — boosting as a separate workflow

**Status: deferred to after the current release. Nothing built.** This is a successor design for how a
boost is paid for and displayed. What ships today is described in
[paid-model-loading.md](paid-model-loading.md); nothing here contradicts what is built, but several
items change decisions recorded there, and those are called out.

Because it ships later, the shipped boost stays as it is — including
`BOOST_NON_REFUNDABLE`, which is accurate for the `PUT`-upgrade boost and only becomes wrong when this
design lands.

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

**`whatif` does not carry the job-type resources — only the submitted workflow's response does.** So
the two entry points differ in what they can cover, and both exist:

| Entry point | Submits | Covers |
| --- | --- | --- |
| **Boost toggled on the form** | two workflows — the generation, and a load workflow beside it | what `whatif`'s `preparation` reports |
| **Boost from the queue item** | one workflow — the load workflow alone | everything, read off the submitted generation's response |

The form path is the common one and its gap is accepted: job-type resources are rare and largely
resident, so the missed set is usually empty. The queue path is complete, and doubles as the recovery
route when a form-path boost is unavailable or fails.

What `whatif` *does* carry is better than first assumed: `preparation` has **one entry per resource
needing download, of any type** — a checkpoint and a LoRA in the same generation each get their own
`resource`, `sizeBytes`, `lane`, `queuePosition` and `etaSeconds`. The form path can therefore
enumerate and price every resource it can see.

### Two submits are not one submit

The form path replaces an atomic `PUT` with two independent submissions, so it can half-fail in a way
today's boost cannot. **The generation submits first and a failed boost is non-fatal**: failing the
generation because its boost failed is strictly worse than running it unboosted, and the queue path
is already the way to retry. A boost that does not go through has to say so rather than silently
leaving the user believing they paid.

It also splits the price the form shows. The generation's cost no longer carries
`cost.fixed.downloadPriority` — that moves to the load workflow, in whatever currency it was chosen
to draw from.

**The two prices still add up.** Buzz colours are accounts, not currencies with exchange rates — the
helpers sum across them — so the footer shows one total as it does today. What it does not say is
which account pays, and it never did: `currencies` is a drain *order*, spent in array order until
satisfied, so a single generation already splits across accounts according to balances at charge time.
Two workflows double an indeterminacy that is already there and already accepted.

### The boost does not inherit the generation's currency preference

`appendDomainCurrency` seeds blue first, then the domain currency — green on a SFW domain, yellow on a
mature one. Under one shared order, "generating on yellow while boosting with blue" cannot occur:
anyone generating on yellow is there because blue is empty. That case exists only because the submit
control lets a user deliberately deprioritise blue for the generation.

So the boost takes the **default drain order** rather than the generation's override. Someone who
chose yellow for their generation still wants blue spent on the boost, which is what the default
already does. This needs no second currency control; one would only be needed for a user who wants a
*non-default* boost order, and nobody has asked for that.

## Decisions

### 1. A boosted load workflow is shown as its own queue item

The boost becomes an object the user owns, rather than an invisible side effect of a generation.
Three things follow from that and are the reason for it:

- **The refund is legible.** A partial refund on an invisible workflow is a balance changing for no
  stated reason.
- **Cancellation has a natural affordance** — the user cancels the thing they bought.
- **Coarse step status is survivable.** `preparing → processing → succeeded` works on a dedicated
  card in a way it does not when it has to drive a countdown embedded in a generation card.

**Boost workflows carry their own tag rather than reusing `resource-load`.** That tag is also on the
moderator tool's explicit purchases, which are not generation-queue material; selecting the queue on
it would drag them in. A distinguishing tag makes the queue show boosts and nothing else, and avoids
having to decide whether moderators mind seeing their loads there.

**The card vanishes on success and persists whenever money came back** — a full or partial refund is
the only state whose whole value is being readable afterwards. "Was there a refund" is the right
predicate rather than "was it cancelled": a cancel that refunded nothing, because everything had
already started, has as little to say as a success.

The refund amount is the orchestrator's to decide and ours only to display, and the surface for
showing it already exists. We do not apportion the fee, which also means we cannot quote a figure
*before* a cancel — a confirmation can say un-started downloads are refunded, without a number.

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

Stated as the button's full enable rule, a resource is boostable when it is **not resident**, **not
already in the high lane**, and **not already covered by one of your in-flight boosts**. The three
clauses have three different sources — residency, the live lane, and your own queue — and the first
two are already implemented, in the cold check and in `isWorthBoosting` respectively. The queue-path
button needs the same rule as the form-path one.

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

## Assumed, not confirmed

Three things below are expectations of how the orchestrator behaves, taken as the basis for the design
above. Each is cheap to check and expensive to be wrong about, so none should be treated as settled
until it is.

| Assumption | How it gets confirmed |
| --- | --- |
| A multi-step load workflow returns a usable `whatif` — i.e. C2 is closed for this shape | one `whatif` against a two-step `prepareResource` workflow |
| Load steps carry a `preparation` block like generation steps do | the same call — read whether `preparation` is present |
| Live per-version availability re-reports against a lane raised by a *different* workflow | boost a cold model, watch an unboosted generation's live ETA on the same model — it drops, or it does not |

The third is the one to check first: decision 3 rests entirely on it, and it is the only one of the
three we can answer without the orchestrator changing anything.

## Open

| Question | Closes when |
| --- | --- |
| **Does raising the lane speed a transfer already in progress, or only queued ones?** Decides whether a generation whose big checkpoint is already downloading is worth boosting at all — the small resources behind it would gain, the large one in flight might not. Answered by the same experiment as the third assumption above. | the experiment is run |
| **What a failed form-path boost shows.** The generation ran, the boost did not; the user must not be left believing they paid. | the copy exists and the queue path is reachable from it |
