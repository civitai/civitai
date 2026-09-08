# Paid Model Loading — decisions to make

Every open decision in one place, so none of them is discovered later by a user paying for it.

Companion to:

- [paid-model-loading.md](paid-model-loading.md) — the contract, and the decisions already made
- [paid-model-loading-build-plan.md](paid-model-loading-build-plan.md) — files, procedures, order
- [paid-model-loading-checklist.md](paid-model-loading-checklist.md) — the state of the work
- [paid-model-loading-coverage.md](paid-model-loading-coverage.md) — the coverage model and its audit

This file holds no implementation detail. Each entry says what is being decided, what turns on it,
what the options are, and — following the repo's rule for anything filed as work — **who decides**
and **what closes it**. Where an entry has a recommendation it is marked as such and is mine, not a
settled position.

Only genuinely open questions live here. Anything already answered belongs in
[Decided, do not relitigate](paid-model-loading.md#decided-do-not-relitigate), and anything that is
work rather than a judgement belongs in the checklist — see [Not decisions](#not-decisions-tracked-elsewhere)
at the end for the two big ones people keep mistaking for open questions.

**Nothing here blocks Phase A**, which is built. §1 and most of §2 were answered by Justin on
2026-09-08 and are kept, with their answers, because each changed what gets built. What remains open
is two build questions, the Phase A ratifications, and one new question for Koen.

The coverage model those answers produced — and the audit behind it — is
[paid-model-loading-coverage.md](paid-model-loading-coverage.md).

## Who needs to answer what

Every open item carries a **`@dev:`** block with the question stated in one line and a space to
answer in place. Search the file for `@dev:` to jump between them, or take just your own row.

Justin's six questions were asked on a separate page, which has served its purpose and is gone —
his answers are quoted verbatim in §1 and §2 below.

| Who | Items |
| --- | --- |
| **Justin** | nothing open — all six [answered 2026-09-08](#1-blocks-launch) |
| **Koen** | [K3](#k3-does-the-orchestrator-refund-a-failed-prepare) refund on a failed prepare; C2 (pricing) is still his to build |
| **Briant / team** | [2.4](#24--the-c4-webhook--not-now) C4 webhook · [2.5](#25-the-rate-limit-numbers-are-off-by-one) off-by-one · [2.6](#26-the-17-base-model-gap-between-the-constants-and-generationbasemodel) constants gap · [3.1](#31-a-fifth-state-unknown)–[3.3](#33-which-buzz-account-pays) ratify Phase A |

Answering in place is enough — nothing here needs a meeting. An item with no answer after review is
one we will ship a default for, and each entry says what that default would be.

---

## 1. Blocks launch

**1.1–1.3 answered by Justin, 2026-09-08**; 1.4–1.6 were decided in code while building. All six are
kept with their answers because each changed what gets built; the work they created is in the
[checklist](paid-model-loading-checklist.md).

### 1.1 ✅ Models without a `RentCivit` licence — refuse

> **Justin:** "Do we currently allow on-site generation for models without a `RentCivit` license?
> I'm assuming that we don't. We should be refusing if `RentCivit` is false"

Correct on the main path, and confirmed in the data: **zero covered versions lack `RentCivit`** —
measured branch by branch and end-to-end against the view.

**Implement as: refuse anything not in `GenerationCoverage`**, rather than testing the licence
directly. The two select the same set today, but the view also carries the two branches that skip the
licence check, so gating on coverage inherits the rule instead of keeping a second opinion of it.
Detail in [coverage](paid-model-loading-coverage.md#the-licence-gate).

### 1.2 ✅ A load that never finishes — refund

> **Justin:** "refund failed loads, though this should be occurring via the orchestrator"

⚠️ **The second clause is an assumption, not a confirmed behaviour.** `CalculateCost` returns zero
today, so no prepare has ever been charged and no refund path has ever run. Whether the orchestrator
refunds a failed or timed-out `prepareResource` is [K3](#k3-does-the-orchestrator-refund-a-failed-prepare),
and it has to be answered before pricing goes live — not after.

### 1.3 ✅ What we promise — the original 48 hours

> **Justin:** "'another controller has it' means that the model is still downloaded on our servers
> and available for generation. I think the original promise should suffice."

That reading makes the eviction caveat benign: the copy can move, the availability does not. So the
48-hour promise as originally pitched is what the surfaces say. This closes the question reopened on
2026-09-07 when Koen's answer showed residency exists after all.

### 1.4 ✅ Progress signals go to the buyer, not to a topic

**Decided 2026-09-08**, and it corrects a design these docs recorded.

The load callback used to point at the `model-version:<id>` signals **group**, so anyone watching
the model received progress. 🔴 That leaks: the orchestrator posts its `WorkflowStepEvent` straight
to the signals service — we are not in the path and cannot rewrite it — and `workflowId` is
`<userId>-<timestamp>` (see `workflowOwnerId`). A group broadcast would tell everyone watching a
model **who paid for the load**.

Callbacks now target `/users/{userId}/signals/`. Pinned by a test asserting the URL contains
`/users/` and not `/groups/`.

Consequence: bystanders get no **live** progress. They are told when it is ready instead — see 1.5.

### 1.5 ✅ Notification is a toast on return; real notifications are Phase 2

**Decided 2026-09-08.**

A browser keeps what it is waiting on in `localStorage` — loads it requested and loads it chose to
watch. The queue **drains on every page load**: finished ones raise a toast that must be dismissed
and are removed, ones that can no longer finish are removed, and the rest stay subscribed. The drain
is mounted app-wide, so a finished load is reported wherever the user lands next.

🔴 **A ceiling is what makes "it always drains" true.** Done / gone / still-loading does not cover a
load that FAILED or one that finished and was then evicted — both read back as `unavailable`, which
is indistinguishable from "queued". Without a deadline such an item is re-subscribed forever. Items
expire at 48h, matching the residency policy.

**Accepted limits:** this reaches someone only when they return, in that browser. A different device
or a cleared browser gets nothing, and that is fine (Justin, 2026-09-08). Reaching a user who does
not come back is the **Phase 2** goal — API-level notifications, for users who want them.

### 1.6 ✅ There is a durable record of a purchased load, and it is not ours

**Decided 2026-09-08.** `submitResourceLoad` tags every load `resource-load`, and
`queryWorkflows({ token, tags })` returns that user's workflows — durable, cross-device, no site-side
storage. So `localStorage` is **not** the record of what someone bought; it is one browser's list of
what it is watching.

Redis was considered and rejected as the home for this: something that must survive hours and drive
a notification should not sit somewhere evictable.

⚠️ Not yet built as a procedure (`getMyLoads`), and one unknown remains — **how long the
orchestrator retains a completed workflow**, which bounds how far back such a list can look. Worth
asking Koen alongside [K3](#k3-does-the-orchestrator-refund-a-failed-prepare).

---

## 2. Blocks specific build work

### 2.1 ✅ C14 — start with the mod test page

> **Justin:** "We are going to start with the test page I asked for. The page that allows me, a mod,
> to request a model to be loaded and see what models are loaded and get status updates as a model is
> loading. This should already be documented."

It is built and documented — `/moderator/resource-load`, Phase 1.5 in the checklist. So C14 is
answered by something that already exists: no standalone demo client, no platform rollout yet.

### 2.2 ✅ Checkpoints only — **not** LoRA-first

> **Justin:** "model loading only applies to checkpoints. Checkpoints have this separate loading
> system due to the size of the models. Loras typically aren't large enough to worry about."

🔴 **This reverses the recommendation these docs carried.** The LoRA-first argument — that LoRAs need
no view change and are therefore the smallest slice — was solving the wrong problem: size is the
reason the loader exists, and LoRAs do not have it. Every "LoRA-first" recommendation in this
document set was wrong and has been removed.

Consequence: 2.3 is not optional, it is the critical path.

### 2.3 ✅ `CoveredCheckpoint` goes away

> **Justin:** "In theory, coveredCheckpoint shouldn't affect generation going forward. If
> CoveredCheckpoint is only used for generation, then CoveredCheckpoint should go away. […] So,
> canGenerate for checkpoint models should no longer be conditional on CoveredCheckpoint from the
> auction system."

The conditional holds: `CoveredCheckpoint` has four uses and all four are generation, one of which
is dead code. Removing it widens covered checkpoints by roughly two orders of magnitude —
[the numbers](paid-model-loading-coverage.md#what-changes-in-numbers).

⚠️ The audit that followed found the neighbouring table is the opposite case: **`EcosystemCheckpoints`
must stay**, because 62 of 63 checkpoint defaults are covered through it and none through
`CoveredCheckpoint`. See [coverage](paid-model-loading-coverage.md#the-two-tables-do-opposite-jobs).

### 2.4 ✅ The C4 webhook — not now

**Closed 2026-09-08: no.** Both reasons to build it went away on the same day.

It existed to do two things a direct-to-signals callback cannot: fire the completion notification
(C9), and let a bystander see a load without disclosing who paid for it. C9 is now a **Phase 2**
goal, and bystanders **do not need live progress** — they need to be told when it is ready, which
the localStorage drain does by asking `getState` on their next visit. Neither needs a hop.

Not building it also avoids an endpoint that would fire every 10 seconds per in-flight download
across the whole cluster.

⚠️ **It comes back with Phase 2.** A real notification has to be sent from somewhere, and that
somewhere is a server-side moment this feature does not otherwise have. Reopen this rather than
inventing a second mechanism.

### 2.5 The rate-limit numbers are off by one

**The decision:** what the configured numbers should read.

`rateLimit()` compares `attempts > limit`, so the current 3 / 6 / 10 permit **4 / 7 / 11**. That the
shared comparison must not be "fixed" here is settled; which of the two remaining options to take is
not.

**Options:** write 2 / 5 / 9 so the effective caps are 3 / 6 / 10; or keep the numbers and record
out loud that "3 means 4".

**Recommendation:** keep the numbers, write it down. The tiers are deliberately low and meant to be
raised, so an off-by-one at this scale is noise — but an undocumented one is a surprise later.

**Owner:** whoever closes C10 ([868ktt5aq](https://app.clickup.com/t/868ktt5aq)).
**Closes when:** the numbers are renumbered, or the decision to keep them is taken. The off-by-one
is already documented beside the limiter, so only the renumber option is still open.

> **@dev:** 2/5/9 for true caps of 3/6/10, or keep 3/6/10 and accept that they permit one more?
> Default if nobody minds: keep them and write it down.
>
> _Answer:_

### 2.6 The 17-base-model gap between the constants and `GenerationBaseModel`

**The decision:** whether `basemodel.constants.ts` or the database is wrong.

17 base models declare generation support in the constants and have no `GenerationBaseModel` row;
5 rows exist in the table that the constants do not declare. The 17 are generatable today **only**
because `EcosystemCheckpoints` covers their default model — the allowlist never learned about them,
and the other table quietly compensated. Full lists in
[coverage](paid-model-loading-coverage.md#basemodelconstantsts--generationbasemodel-disagree).

**What turns on it:** nothing for paid loading, which gates on `GenerationBaseModel` either way. It
matters because the two sources of truth disagree and nothing detects it — a guard-shaped problem.

**Owner:** unowned.
**Closes when:** the rows are added, or the constants stop claiming generation support, or a test
pins the two together.

> **@dev:** Worth fixing now, or filing? It predates paid loading and does not block it.
>
> _Answer:_

---

## 3. Already decided in code during Phase A — ratify or reverse

These are live in the built code, and none was covered by the existing docs. Each was a judgement
call made to keep going; none is expensive to reverse now, and all get harder once a surface depends
on them.

### 3.1 A fifth state, `unknown`

When the orchestrator answers with a status this build does not recognise, or with no `availability`
at all, the service reports `unknown` rather than folding it into `unsupported`. The purchase path
refuses both.

**Why:** collapsing them makes "the cluster will never host this" indistinguishable from "we could
not read the answer". The first is permanent, the second is a retry, and a support conversation
needs to tell them apart.

### 3.2 `estimate` returns `{ cost, priced }`

`priced` is false while the orchestrator quotes zero (i.e. always, until C2).

**Why:** without it, a real zero and a placeholder zero render identically, which is how "free model
loading" ships by accident. The mod page shows a warning on `priced: false`.

### 3.3 Which Buzz account pays

`submit` and `estimate` pass `currencies: getAllowedAccountTypes(ctx.features)` — the same
derivation the auction path uses, so the domain currency is correct on green.

**Why it is a decision:** it was not specified anywhere. If paid loading is meant to be payable from
a specific account type only, this is the line to change.

> **@dev:** All three of these are live in the code and cheap to reverse today. Say "fine" and they
> stop being decisions; say otherwise and name which one.
>
> _Answer:_

---

## 4. For Koen

### C2 — pricing

The only thing still with Koen. `PrepareResourceHandler.CalculateCost` returns an empty cost, so
`whatIf` reports 0 and the site's estimate procedure has no number to show. Everything else on the
purchase path is built and waiting on it. ([868ktt57p](https://app.clickup.com/t/868ktt57p))

Not a decision and not a new request — noted so this file shows everything he is holding. Context
from 2026-09-01, on a neighbouring topic, for whoever chases it: *"The whole pricing section in the
orchestrator is one big mess with many features hacked on top of other features, that makes me
irrationally reluctant to touch it, but I do agree with your reasoning, will put it on my list."*

### K3 Does the orchestrator refund a failed prepare?

Justin decided a load that never finishes is refunded, and expects the orchestrator to be doing it
("though this should be occurring via the orchestrator"). Nothing confirms that: `CalculateCost`
returns zero, so no prepare has ever been charged and no refund has ever been exercised.
`PrepareResourceJob` has a 24-hour `MaxTimeout`, and at the bandwidth measured on the lab call a
large checkpoint can plausibly reach it.

**What turns on it:** whether the refund is the orchestrator's or ours. If ours, it is unscoped work
that has to land with pricing rather than after it.

> **@dev: Koen** — When a `prepareResource` step fails or hits its 24h timeout, does the charge get
> refunded automatically, or does the consumer have to reverse it? Same conversation as C2, since
> neither can be observed until a prepare actually costs something.
>
> _Answer:_

### Answered, 2026-09-04 and 2026-09-07

Kept as a record because both answers changed what this document says.

**K1 — is the 48-hour residency planned, and where?** It is not planned; it **exists**. The spine
controllers check with each other before evicting a resource and refuse to evict anything less than
48h old unless another spine controller has it. `PrepareResourceJob` gets the resource into the DC
and that policy guards its lifetime from then on — `ClusterAwareEvictionPolicy.cs` in
`civitai-spine-controller`. **`PinModelJob` is legacy: "don't even look at it."** This register had
it as the intended primitive, which was wrong. What the answer opens rather than closes is
[1.3](#13--what-we-promise--the-original-48-hours).

**K2 — is `step:preparing` unadvertised on purpose?** No. Koen: the intent was that `preparing` and
`scheduled` are step statuses and never workflow statuses, but their absence from the callback enum
was a spec limitation from a 2024 change made with no comment. He has **added the missing event
types to the spec**. `step:*` remains correct, and a future `@civitai/client` publish should carry
the types.

---

## Not decisions: tracked elsewhere

- **C2 — pricing and charging.** Koen's, and not a config toggle — see [§4](#c2--pricing).
- **Residency.** Built, and not ours — the spine controllers enforce it. What is ours is the copy
  question, [1.3](#13--what-we-promise--the-original-48-hours).
