# Paid Model Loading — decisions to make

Every open decision in one place, so none of them is discovered later by a user paying for it.

Companion to:

- [paid-model-loading.md](paid-model-loading.md) — the contract, and the decisions already made
- [paid-model-loading-build-plan.md](paid-model-loading-build-plan.md) — files, procedures, order
- [paid-model-loading-checklist.md](paid-model-loading-checklist.md) — the state of the work

This file holds no implementation detail. Each entry says what is being decided, what turns on it,
what the options are, and — following the repo's rule for anything filed as work — **who decides**
and **what closes it**. Where an entry has a recommendation it is marked as such and is mine, not a
settled position.

Only genuinely open questions live here. Anything already answered belongs in
[Decided, do not relitigate](paid-model-loading.md#decided-do-not-relitigate), and anything that is
work rather than a judgement belongs in the checklist — see [Not decisions](#not-decisions-tracked-elsewhere)
at the end for the two big ones people keep mistaking for open questions.

**Nothing here blocks Phase A**, which is built. §1 blocks launch, §2 blocks specific build work,
§3 is already implemented one way and needs ratifying or reversing, and §4 is for Koen — where both
of his questions are now answered, and one of the answers reopened a decision we thought settled.

## Who needs to answer what

Every open item carries a **`@dev:`** block with the question stated in one line and a space to
answer in place. Search the file for `@dev:` to jump between them, or take just your own row:

| Who | Items |
| --- | --- |
| **Justin** | [1.1](#11--models-without-a-rentcivit-licence) licence gate · [1.2](#12-what-happens-when-a-load-fails-or-never-finishes) refund path · [1.3](#13--what-the-surfaces-may-promise-now-that-residency-exists) what we promise · [2.1](#21-c14--demo-client-mod-only-or-straight-into-the-platform) C14 · [2.2](#22-select-any-model--and-it-is-two-questions-not-one) select any model · [2.3](#23--who-owns-coveredcheckpoint) `CoveredCheckpoint` |
| **Koen** | nothing open — K1 and K2 [answered](#answered-2026-09-04-and-2026-09-07); C2 (pricing) is still his to build |
| **Briant / team** | [2.4](#24-whether-to-build-the-c4-webhook-at-all) C4 webhook · [2.5](#25-the-rate-limit-numbers-are-off-by-one) off-by-one · [3.1](#31-a-fifth-state-unknown)–[3.3](#33-which-buzz-account-pays) ratify Phase A |

Answering in place is enough — nothing here needs a meeting. An item with no answer after review is
one we will ship a default for, and each entry says what that default would be.

---

## 1. Blocks launch

### 1.1 🔴 Models without a `RentCivit` licence

**The decision:** whether the purchase path refuses them.

**What turns on it:** `GenerationCoverage` excludes these models deliberately — the creator did not
grant on-site generation. Taking payment to load one sells what the licence forbids. The failure
mode is a refund *plus* a creator complaint, which is the expensive pair.

**Not implemented.** `submit` will currently accept a load for such a model. This is the only gap in
the built code that is a policy question rather than missing work.

**Options:** refuse at the CTA and at `submit`; or get a product decision that loading is not
"generating" and the licence does not reach it.

**Recommendation:** refuse, unless someone senior signs the opposite in writing. It is three lines
of service code once the answer exists.

**Owner:** Justin (Briant may take it) — no ClickUp task yet.
**Closes when:** the purchase path refuses unlicensed models, or a named person signs off that it
should not.

> **@dev: Justin** — Do we refuse to sell a load for a model whose creator did not grant `RentCivit`?
> A yes costs three lines of code; a no needs your name on it, because the licence says otherwise.
>
> _Answer:_

### 1.2 What happens when a load fails or never finishes

**The decision:** whether there is a refund path, and who runs it.

**What turns on it:** bandwidth was measured at ~10 KB/s with LoRAs taking four hours, and
`PrepareResourceJob` has a 24-hour `MaxTimeout` — so a large checkpoint can plausibly hit the
ceiling and never complete. Koen on the call: "we got to be prepared for us not giving any hard
guarantees about when it's going to be available."

No task, no owner, and it only becomes visible once money is real — so it is due at C2, not before.

**Owner:** Justin — no ClickUp task yet.
**Closes when:** a refund path exists, or a named person accepts that failed loads are not refunded
and the surfaces say so before purchase.

> **@dev: Justin** — A load that never finishes: refund, or say up front that we do not refund?
> Not urgent until C2 makes the money real, but it decides what the CTA has to say before purchase.
>
> _Answer:_

### 1.3 🔴 What the surfaces may promise, now that residency exists

**The decision:** what the CTA says a paid load buys.

**Reopened 2026-09-07.** This was settled as "promise a load, never a duration", on the premise that
no residency mechanism existed. That premise was false — it lives in `civitai-spine-controller`,
which nothing on the site side had read. The old answer is therefore not safe to keep by default: it
was right about a world we are not in.

**What turns on it:** the policy refuses to evict a resource less than 48h old **unless another
spine controller has a copy**. So the honest sentence is closer to *"it stays reachable in the
cluster for 48 hours"* than *"we hold your copy for 48 hours"* — and for a user who paid, the
difference only shows up on the day it bites.

Two things nobody on the site side can currently check: we have not read the policy (private repo),
and **no API reports when a given resource's window ends**, so we cannot show a countdown even if we
promised one.

**Options:** promise the 48 hours as pitched; promise reachability without a duration; or promise
the duration with the caveat stated in the CTA.

**Recommendation:** ask Koen to confirm the user-visible consequence of the "unless another
controller has it" branch before writing any of the three. It is one question and it decides the
sentence.

**Owner:** Justin — no ClickUp task yet.
**Closes when:** the CTA copy is written and someone named signs it off.

> **@dev: Justin** — Residency turned out to exist (see §4). What do we tell a buyer they are
> getting: "48 hours", "loaded and kept available", or "48 hours, usually"? Worth one confirmation
> from Koen on the eviction caveat first.
>
> _Answer:_

---

## 2. Blocks specific build work

### 2.1 C14 — demo client, mod-only, or straight into the platform

**Gates:** C5–C8, the three real surfaces.

Justin's counter to a full platform rollout is a small standalone first-party app driving Koen's API
end to end, or a mod-only launch. **The mod test page at `/moderator/resource-load` is the cheap
version of the third option and already exists** — it drives estimate, submit and the live queue
against the real orchestrator. That may narrow the question rather than answer it.

**Owner:** Justin ([868ktt5bz](https://app.clickup.com/t/868ktt5bz)).
**Closes when:** Justin states the choice in the task.

> **@dev: Justin** — Demo client, mod-only, or straight into the platform? Worth looking at
> `/moderator/resource-load` first — it already drives the real orchestrator end to end, which may
> be the demo you were asking for rather than an argument for building a separate app.
>
> _Answer:_

### 2.2 "Select any model" — and it is two questions, not one

**Gates:** C6 (the generator), and nothing else. Phase A and the rest of Phase B do not touch it.

`GenerationCoverage` is a **view**, not a flag, so there is no `covered` boolean to set.

- **LoRA / TextualInversion / VAE / LoCon / DoRA / Upscaler** are already covered once licensed and
  scanned. They are merely not *resident* — exactly the problem paid loading solves. **No view
  change.**
- **Checkpoints** additionally require membership in `CoveredCheckpoint`, which the weekly auction
  job owns and prunes (see 2.3).

**Recommendation:** LoRA-first v1. It avoids both the view change and the auction entanglement, and
it is the only slice that can ship without settling 2.3.

**Owner:** Justin — no ClickUp task yet.
**Closes when:** the choice is written into paid-model-loading.md, and a task exists if a checkpoint
path is in scope.

> **@dev: Justin** — LoRA-first, or checkpoints in v1 too? Checkpoints drag in a view change and the
> auction entanglement in 2.3; LoRAs need neither and are already the resources people cannot
> generate with today.
>
> _Answer:_

### 2.3 🔴 Who owns `CoveredCheckpoint`

**Gates:** any checkpoint shipping as paid-loadable. Follows directly from 2.2.

`handle-auctions.ts` deletes every row outside the weekly winner set on each cycle, so a checkpoint
someone paid to load loses its coverage at the next auction run — silently.

**Owner:** Justin — no ClickUp task yet, and entangled with 868gtq1kt (splitting featuring out of
auctions).
**Closes when:** ownership of the table is settled, before — not after — a checkpoint is offered.

> **@dev: Justin** — Only if 2.2 lets checkpoints in. Who owns `CoveredCheckpoint` once paid loading
> can put rows in it? As it stands the weekly auction job deletes anything it did not put there, so a
> paid checkpoint silently loses coverage.
>
> _Answer:_

### 2.4 Whether to build the C4 webhook at all

**The decision:** whether progress needs a server-side hop. Contingent on C9 being scoped.

The load submit points its callback straight at the signals **group** URL for `model-version:<id>`,
so progress already fans out with no endpoint of ours in the path. The only things a webhook would
add are the completion notification (C9) and resolving AIR → version id once instead of per client.

**Recommendation:** build it if and only if C9 survives scoping. Otherwise it is a hop that does
nothing.

**Owner:** whoever scopes C9.
**Closes when:** C9 is scoped in or out.

> **@dev:** Is C9 (the completion notification) in scope? That is the whole question — if yes we need
> the webhook, if no it does nothing.
>
> _Answer:_

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

### Answered, 2026-09-04 and 2026-09-07

Kept as a record because both answers changed what this document says.

**K1 — is the 48-hour residency planned, and where?** It is not planned; it **exists**. The spine
controllers check with each other before evicting a resource and refuse to evict anything less than
48h old unless another spine controller has it. `PrepareResourceJob` gets the resource into the DC
and that policy guards its lifetime from then on — `ClusterAwareEvictionPolicy.cs` in
`civitai-spine-controller`. **`PinModelJob` is legacy: "don't even look at it."** This register had
it as the intended primitive, which was wrong. What the answer opens rather than closes is
[1.3](#13--what-the-surfaces-may-promise-now-that-residency-exists).

**K2 — is `step:preparing` unadvertised on purpose?** No. Koen: the intent was that `preparing` and
`scheduled` are step statuses and never workflow statuses, but their absence from the callback enum
was a spec limitation from a 2024 change made with no comment. He has **added the missing event
types to the spec**. `step:*` remains correct, and a future `@civitai/client` publish should carry
the types.

---

## Not decisions: tracked elsewhere

- **C2 — pricing and charging.** Koen's, and not a config toggle — see [§4](#c2--pricing).
- **Residency.** Built, and not ours — the spine controllers enforce it. What is ours is the copy
  question, [1.3](#13--what-the-surfaces-may-promise-now-that-residency-exists).
