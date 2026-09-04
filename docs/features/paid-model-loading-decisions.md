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
§3 is already implemented one way and needs ratifying or reversing, and §4 is for Koen.

## Who needs to answer what

Every open item carries a **`@dev:`** block with the question stated in one line and a space to
answer in place. Search the file for `@dev:` to jump between them, or take just your own row:

| Who | Items |
| --- | --- |
| **Justin** | [1.1](#11--models-without-a-rentcivit-licence) licence gate · [1.2](#12-what-happens-when-a-load-fails-or-never-finishes) refund path · [2.1](#21-c14--demo-client-mod-only-or-straight-into-the-platform) C14 · [2.2](#22-select-any-model--and-it-is-two-questions-not-one) select any model · [2.3](#23--who-owns-coveredcheckpoint) `CoveredCheckpoint` |
| **Koen** | [K1](#k1--is-the-48-hour-residency-planned-and-where) residency · [K2](#k2-is-steppreparing-unadvertised-on-purpose) `step:preparing` |
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

### K1 🔴 Is the 48-hour residency planned, and where?

`PinModelJob` looks like the intended primitive — defined, `[Preview]`, with a `PushWorkerHandler`
handler — but nothing in the repo creates one and `PrepareResourceHandler` does not issue it. So a
prepared resource is evicted like any other.

**What turns on it:** whether the pitched product is reachable at all, or whether paid loading is
permanently "a faster download". Every site surface is already written to promise only a load, so
nothing is blocked on the answer — but the pitch is.

> **@dev: Koen** — Is retention planned, and is `PinModelJob` the primitive it will use? A rough "yes,
> after X" is enough; we are not asking for a date. If the answer is no, say so plainly and we will
> stop describing this as a residency guarantee anywhere.
>
> _Answer:_

### K2 Is `step:preparing` unadvertised on purpose?

`WorkflowCallbackSchemaFilter` strips `preparing` and `scheduled` from the advertised callback-type
enum, which is why the generated SDK looks like it is missing the feature. `step:*` matches it and is
what the code uses.

**What turns on it:** nothing today — the wildcard works. But more surfaces are about to depend on
it, and a deliberate omission is worth knowing about before they do.

> **@dev: Koen** — Deliberate, or an artifact of the Swagger filter? And is `step:*` the subscription
> you want consumers on, or should we be naming statuses?
>
> _Answer:_

### C2 — pricing (already yours, no question attached)

Not a decision, and not a request — noted only so this file is a complete picture of what Koen is
holding. `PrepareResourceHandler.CalculateCost` returns an empty cost, so `whatIf` reports 0 and the
site's estimate procedure has no number to show. Everything else on the purchase path is built and
waiting on it. ([868ktt57p](https://app.clickup.com/t/868ktt57p))

---

## Not decisions: tracked elsewhere

Both of these block launch, and neither is an open question. They are work with an owner, listed
here only because they are the two things most often raised as though a decision were pending.

- **C2 — pricing and charging.** Koen's, and not a config toggle — see
  [§4](#c2--pricing-already-yours-no-question-attached).
- **Residency.** No mechanism pins a prepared resource. What the surfaces may claim meanwhile is
  already settled — they promise a load, not a duration — so what remains is [K1](#k1--is-the-48-hour-residency-planned-and-where),
  a question for Koen, not a decision for us.
