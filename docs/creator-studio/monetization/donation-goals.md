# Donation goals — a crowdfunded free month

> **Status:** proposed, nothing built. Supersedes `donation-goal-escrow.md`, which explored refunds
> and escrow — neither is needed under this design. Owner: unassigned.
>
> Originates in a creator thread (2026-09-03) about early access being switched to paid access after
> donations were taken. The rules are the team's; the numbers and the code findings are ours.
>
> 🔴 **The feature itself may be removed.** Dropping `DonationGoal` entirely is under consideration
> (Justin, 2026-09-03), pending community feedback. If that happens, rules 1–3 below disappear and
> only rule 4 survives. **Decide that before building any of this** — see
> [Whether to keep donation goals at all](#whether-to-keep-donation-goals-at-all).

## The four rules

**1. A donation goal requires download access.** A goal cannot be set on a generation-only gate.

**2. Goal met → the model is free to everyone for 30 days.** No purchases can be made during the
window. The clock starts the moment the goal is met.

**3. After the 30 days, the creator prices the model however they like.**

**4. Everything without a goal is freely priced.** An early access date with no goal is an *estimate*,
labelled as one. When the window ends the model is simply ungated — it becomes gated again only if
the creator sets up paid access again.

That is the whole design. There is no transition matrix, no refund path, and nothing is permanent.

## What each rule is doing

**Rule 1 closes the generation-only escape without a rule about it.** A creator cannot switch a
goal-bearing model to generation-only, because the goal would no longer be valid. The earlier designs
needed to enumerate every downgrade — drop download, raise the price, switch to permanent — and leaked
on whichever one they missed. Here the goal's precondition does that work.

It also guarantees a met goal delivers something **permanent**: a file the user keeps. Access records
are only created by purchase, so a free window hands over nothing durable on a generation-only
model — 30 days of use and then nothing. Rule 1 means that case cannot arise.

**Rule 2's purchase block is what makes rule 1 safe.** With no purchases during the window, nobody
acquires permanent access mid-window and `EntityAccess` keeps meaning *bought*. The window is inert in
both directions: no money in, no money out.

**Rules 3 and 4 are the creator's flexibility**, and they are the reason nothing here needs a refund.
A creator is never trapped; they simply cannot take back a month they already sold to the community.

### The trade a creator is making

Meeting the goal costs **30 days of sales**. So a goal amount should be at least a month's revenue for
that model, or the donors have bought it cheaply on everyone else's behalf.

Creators have no rational way to set a goal amount today. This gives them one, and we can show the
estimate from their own sales history.

## What is true today

Three facts, verified in code, because the creator thread reached the opposite conclusion on the
second.

**Donations pay the creator immediately.** `donateToGoal` sends Buzz straight to `goal.userId`. No
holding period, no intermediary.

**There is no donor refund.** A 30-day early-access refund exists but refunds **buyers of paid
access**, and only on **unpublish** (`model-early-access-refund.service.ts`). A donor is refunded only
when their own donation transaction fails mid-flight. *The thread assumed this protection exists; it
does not.* Under the four rules it is not needed — nothing is promised that could be broken.

**A met goal does not currently stick.** `endPaidAccessNow` is
`UPDATE "PaidAccess" SET "endsAt" = NOW()` and nothing more; the next editor save runs
`writePaidAccessForModelVersion`, whose `permanent` branch writes a fresh gate. So today a creator can
take a fully-funded goal, let it unlock the model, and re-gate it the same afternoon. Rule 2's 30-day
window is the minimum that has to be enforced against that.

Also today: `donationGoalCompleteAfterDonate` only ends **timed** gates, so a goal on permanent paid
access is inert — donors can fund something that by construction unlocks nothing. Rule 2 fixes that
by making the unlock a property of the goal rather than of the gate.

## Evidence that the switch happens

`writePaidAccessForModelVersion` writes a permanent gate as `endsAt NULL, timeframeDays NULL`. **63
permanent gates still carry a `timeframeDays`** — residue consistent with a timed gate having been
switched to permanent by a path that did not clear it.

| Of those 63 | |
|---|---|
| Have a donation goal | 31 |
| — **took money** | **15** · 15,200 Buzz · 62 donors |
| — goal was **met in full** | **1** |

⚠️ **Evidence, not proof, and a floor rather than a count.** Another write path could leave the field,
and any switch that cleared it is invisible. The true number is ≥15.

## What it costs to build

Smaller than any earlier option, because nothing is held and nothing is permanent.

1. **A free window on the gate** — `goalMetAt <= now < goalMetAt + 30 days` resolves to free,
   whatever the gate says. One range check in the resolution path.
2. **A purchase guard** — reject purchases while the window is open.
3. **A goal precondition** — a goal may only be created where the gate grants download.
4. **Copy** — an estimate has to read as an estimate, and a free month as a month.

No escrow, no refund path, no terminal state, no held balances, no backfill of in-flight money.

## Decided

| | |
|---|---|
| **Unmet goals** | **Nothing happens for the donor.** The creator keeps the donation. This is how it already works, and it is the majority case — worth revisiting later, not now. |
| **A lapsed window** | **Becomes ungated.** Not terminal. It is gated again only if the creator sets up paid access again. |
| **When the month starts** | **The moment the goal is met**, not the original free date. |
| **Permanence** | **30 days is the only guaranteed free.** There is no permanent free-forever promise. |
| **Escrow** | **Parked** (2026-09-03). Holding donations and refunding them is not being pursued. Nothing under these four rules requires it — see [What was considered and dropped](#what-was-considered-and-dropped). |

🔴 **"Nothing is terminal" supersedes an earlier decision** that a met goal and a lapsed window should
both make a model permanently free. The rules above are the current position.

## Whether to keep donation goals at all

Under consideration as of 2026-09-03, pending community feedback. Two things make the decision
unusual, and both argue against a broad poll.

### Removing goals dissolves the problem this doc exists to solve

Everything since the creator thread has been about managing an obligation that **donations** create.
With no donations there is no obligation: an early access date becomes an estimate, honestly
labelled, and rule 4 is the entire design. That is not an argument for removal — it is a reason to
settle removal first, because building rules 1–3 and then dropping the feature wastes all of it.

### The income is extremely concentrated

Measured over the 90 days to 2026-09-03: **238 creators** received donations, totalling **19.7M
Buzz**.

| | Share of all donation income |
|---|---|
| Top 10 earners | **78.0%** |
| Top 50 earners | **95.0%** |

| The tail | |
|---|---|
| Median earner, per quarter | **5,015 Buzz** |
| 75th percentile | 16,693 Buzz |
| Earned under 10k Buzz | 147 of 238 |
| Earned under 1k Buzz | 53 |
| Earned over 100k Buzz | 21 |

*(Per-creator figures are deliberately omitted — this repository is public and the population is
small enough that individual income would be inferable.)*

🔑 **So a broad poll would mislead.** It samples overwhelmingly from creators whose stake is a few
thousand Buzz a quarter, while the ~10 carrying 78% of the income are ten voices in a channel. The
result would be sincere, unrepresentative, and would read as a mandate.

**The income conversation is with roughly 20 people** — direct conversations, not a poll.

### But there is a real community question next to it

**Donors are broad even though earners are not.** 2,201 distinct donors gave in the last 30 days on
gated goals alone. So *"do people like donation goals"* and *"would removing this hurt anyone
materially"* have different answers, and one thread will blur them.

Ask donors what they would use instead; ask the top earners what goals earn them that nothing else
does. And note the framing trap: *"should we keep donation goals"* invites defence of the status quo.
The 14.5% completion rate suggests the honest replacement may be a **tip jar**, not an unlock
mechanism.

### The four rules land on the same small group

**6 of the top 10** and **40 of the top 50** donation earners use timed gates with goals (143 of 238
overall). So this is not a broad policy change — it changes how a dozen or so top creators operate,
and the "meeting the goal costs 30 days of sales" trade lands hardest exactly where the money is.
Another reason to talk to them rather than announce.

## Open questions

**D1 — What does "free" mean at the end of the discount ladder?**
[paid-access-decay.md](paid-access-decay.md) is built around `PaidAccessGuarantee`: an irrevocable,
**permanent** free date, where `freeAt` may only move earlier, is never cleared, and is a ceiling on
every read. The decision that *30 days is the only guaranteed free* contradicts that directly. Either
that guarantee also becomes a 30-day window, or the product has two different meanings for the word
*free* — the ladder's and the goal's. **This has to be settled before either doc is built from.**

**D2 — Can the cycle repeat?** Gate → goal → free month → re-gate → new goal. Reads fine, possibly
good — a recurring community unlock — but it should be decided rather than discovered.

**D3 — The 14 live generation-only goals.** Rule 1 makes them invalid. *Recommended:* let them run to
completion under the old terms and block new ones. Retro-invalidating a goal changes the deal for
people who have already donated to it, which is the behaviour this design exists to stop.

**D4 — Does hitting the goal early cost donors free time?** The month runs from goal-met, so a goal met
on day 3 of a 15-day window ends its free period sooner than one met on day 15. Recorded as a property
of the decision rather than a reopening: donors who fund fast get an earlier month, not a longer one.

## Numbers, measured 2026-09-03

| | |
|---|---|
| Donation goals on gated versions | 1,997 |
| — gate includes **download** | **1,981 (99.2%)** |
| — generation-only (rule 1 would forbid) | **16**, of which 14 active · 53,260 Buzz |
| — on a timed gate, funded | 764 · 4.5M Buzz |
| Early access windows in use | 3–15 days (30 offered, unused by funded goals) |
| Creators with donations on timed gates, last 30d | 119 · 2,514,562 Buzz · 2,201 donors |
| Donation goals all-time | 22,841 · **86.9% funded** · **14.5% met** |

Rule 1 codifies what creators already do: 99.2% of goals are on gates that grant download.

The 86.9%/14.5% split is why *unmet goals do nothing* is the majority case rather than an edge case —
roughly **16,500 goals have taken money and never unlocked anything**. That is the status quo and the
decision above keeps it.

## What was considered and dropped

Kept only so the reasoning is not re-run from scratch.

- **Escrow** — hold donations in the system account (as bounties do) and refund them if the promise is
  withdrawn. **Parked 2026-09-03**, not merely outranked: with nothing promised beyond the 30-day
  window there is nothing to refund, and it would have delayed every honest creator's payout by about
  a week. The full exploration — the bounty precedent, the ~1 week hold, the five-step build and the
  measured float — was in `donation-goal-escrow.md`, which this document replaced. Recover it from
  git history if escrow is ever revisited; do not re-derive it.
- **A permanent guarantee** — a met goal or a lapsed window making the model free forever. Dropped by
  the decision that 30 days is the only guaranteed free.
- **A transition matrix** — permitting or forbidding each gate transition per configuration, with
  refunds where a goal took money. Dropped as combinatorial; rules 1–4 cover the same cases without a
  grid. Its one durable idea — *the grant set is protected separately from the price* — survives as
  rule 1.
