# Paid Model Loading — six questions for Justin

> ✅ **All six answered, 2026-09-08.** Justin's answers are inline under each `@dev:` marker below.
> This page is now a **record of what was asked and answered** — the recommendations in it were
> written before the answers and one of them (2.2, LoRA-first) turned out to be wrong. For the
> current position read [the register](paid-model-loading-decisions.md) and
> [the coverage model](paid-model-loading-coverage.md), not this page.

Everything on this page is a decision only you can make. Each one is stated in a sentence, with what
turns on it, the options, and a recommendation you can just say "yes" to.

**Answer in place** — write after the `@dev:` marker under each question, or reply wherever this
reached you. Search `@dev:` to jump between them.

This is a view for reading. The register with owners, closing conditions and the engineering detail
is [paid-model-loading-decisions.md](paid-model-loading-decisions.md); numbering matches it, so 1.1
here is 1.1 there. Where the two ever disagree, that one is right.

**If you answer only one, make it 2.2.** It closes itself, makes 2.3 moot, and unblocks the
generator — three of the six on one reply.

| | Question | If you don't answer |
| --- | --- | --- |
| [1.1](#11-do-we-refuse-models-without-a-rentcivit-licence) 🔴 | Refuse models without a `RentCivit` licence? | We refuse them |
| [1.2](#12-what-happens-when-a-load-never-finishes) | Refund a load that never finishes? | The CTA says we don't refund |
| [1.3](#13-what-do-we-tell-a-buyer-they-are-getting) 🔴 | What do we promise a buyer? | We promise a load, no duration |
| [2.1](#21-demo-client-mod-only-or-straight-into-the-platform) | C14: demo, mod-only, or platform? | Stays mod-only |
| [2.2](#22-lora-first-or-checkpoints-in-v1-too) | LoRA-first, or checkpoints too? | LoRA-first |
| [2.3](#23-who-owns-coveredcheckpoint) 🔴 | Who owns `CoveredCheckpoint`? | Only matters if 2.2 says checkpoints |

Where the work stands: the server side is built and driveable today on a mod-only page
(`/moderator/resource-load`) — enter a model version id, get an estimate, submit, watch the queue.
What is missing is pricing (Koen's, in progress) and the answers below.

---

## Blocks launch

### 1.1 Do we refuse models without a `RentCivit` licence?

A creator who has not granted `RentCivit` has deliberately said their model may not be generated
with on-site. Paid loading would take money to pull that model into the cluster — selling something
the licence forbids.

The code accepted it when this was written; the refusal shipped 2026-09-08.

**What it costs to get wrong:** a refund *and* a creator complaint, which is the expensive pair.

**Options:** refuse them at the button and on the server; or decide that loading is not "generating"
and the licence does not reach it.

**Recommendation:** refuse. It is three lines of code. If we go the other way I would want your name
on it in writing, because the licence text says otherwise.

@dev: Do we currently allow on-site generation for models without a `RentCivit` license? I'm assuming that we don't. We should be refusing if `RentCivit` is false

### 1.2 What happens when a load never finishes?

Bandwidth into the data centre was measured at roughly 10 KB/s at the time of the lab call — LoRAs
took four hours — and the orchestrator gives a load 24 hours before it gives up. So a large model
plausibly never completes.

Not urgent until pricing lands and the money is real. But it decides what the button has to say
*before* someone clicks it, so it cannot wait until after.

**Options:** refund failed loads; or say plainly up front that we don't, and let people decide with
that in hand.

**Recommendation:** no strong view — this is a support-cost question more than an engineering one.
Whichever you pick, the CTA has to say it before purchase.

@dev: refund failed loads, though this should be occurring via the orchestrator

### 1.3 What do we tell a buyer they are getting?

**This one reopened last week.** We had settled on promising nothing about duration, because as far
as we could tell the 48-hour residency did not exist. That was wrong — we had only read the
orchestrator, and the mechanism lives in a different repo. Koen, 4 Sept:

> "The spine controllers check with each other before evicting a resource, it refuses to evict
> something thats less than 48h old unless other spine controllers have it"

So residency is real. The catch is the last clause: a copy **can** be dropped inside 48 hours if
another controller still has one. That makes *"we keep your copy for 48 hours"* and *"it stays
reachable for 48 hours"* different promises — and the difference only shows up on the day it bites
someone who paid.

Also worth knowing: nothing reports **when** a given model's 48 hours run out, so we cannot show a
countdown even if we promised one.

**Options:** promise the 48 hours as originally pitched; promise it stays loaded without naming a
duration; or promise 48 hours with the caveat said out loud.

**Recommendation:** one question to Koen first — what that "unless another controller has it" branch
actually means for someone who paid. It is a small ask and it picks the sentence for you. I can send
it if you want.

@dev: "another controller has it" means that the model is still downloaded on our servers and available for generation. I think the original promise should suffice.

---

## Blocks build work

### 2.1 Demo client, mod-only, or straight into the platform?

Your position on the lab call was that a change this large to how generation works should be shown
to power users before it is sprinkled through the platform — either a small standalone app driving
Koen's API, or a mod-only launch.

**Worth knowing before you decide:** the mod-only version already exists. `/moderator/resource-load`
drives the real orchestrator end to end — estimate, submit, live queue. That may be the demo you
were asking for, rather than an argument for building a separate app.

**Recommendation:** look at that page first, then decide. If it does what you wanted, this question
answers itself and we skip building a second client.

@dev: We are going to start with the test page I asked for. The page that allows me, a mod, to request a model to be loaded and see what models are loaded and get status updates as a model is loading. This should already be documented.

### 2.2 LoRA-first, or checkpoints in v1 too?

These are two different jobs, and only one of them is small.

- **LoRAs** (and embeddings, VAEs, LoCon, DoRA) are already allowed to generate once licensed and
  scanned. They are simply not loaded into the cluster — exactly what paid loading fixes. **No
  plumbing change at all.**
- **Checkpoints** additionally have to be on a curated list that the weekly auction job owns and
  rewrites. That drags in both a database change and the auction question in 2.3.

**Recommendation:** LoRA-first. It ships without touching auctions, and LoRAs are the resources
people actually cannot generate with today. Checkpoints can follow once 2.3 has an owner.

@dev: model loading only applies to checkpoints. Checkpoints have this separate loading system due to the size of the models. Loras typically aren't large enough to worry about.

### 2.3 Who owns `CoveredCheckpoint`?

**Skip this if 2.2 is LoRA-first.**

If checkpoints are in scope: the weekly auction job currently deletes every checkpoint outside that
week's winners. So a checkpoint someone *paid* to load would quietly lose its place at the next
auction run, with nothing telling them or us.

Nobody owns that table for this purpose, and it is tangled with the existing task about splitting
"featured" out of auctions.

**Recommendation:** do not ship a paid checkpoint until this has an owner. The failure is silent,
which is the kind we find out about from users.

@dev: In theory, coveredCheckpoint shouldn't affect generation going forward. If CoveredCheckpoint is only used for generation, then CoveredCheckpoint should go away. The idea is that a user can generate with any checkpoint for ecosystems that support community checkpoints. If a checkpoint isn't currently available in the generator, a user will be prompted to pay to load that model, and they should be able to know when that model becomes available. So, canGenerate for checkpoint models should no longer be conditional on CoveredCheckpoint from the auction system.

---

## Not for you, listed so the picture is complete

- **Pricing (C2)** — Koen's. The orchestrator currently prices a load at zero, so there is no number
  to show yet. Everything else on the purchase path is built and waiting on it.
- **Two questions Koen already answered** — residency (above) and a spec gap in the progress events,
  which he has since fixed.
- **Three engineering choices** already made in code and cheap to reverse, plus two small build
  questions. Those are ours, not yours; they are in the register if you want them.
