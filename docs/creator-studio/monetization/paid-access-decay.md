# Paid access — one system, with discounts and a free-date guarantee

> **Status:** proposed, nothing built. **Blocks** [pricing-templates.md](pricing-templates.md) — see
> [Relationship to pricing templates](#relationship-to-pricing-templates). Owner: unassigned.
>
> Originates in creator feedback asking us to reconcile early access and paid access so creators stop
> having to think about which one they are using. The structure below is theirs; the analysis,
> numbers and open questions are ours.
>
> ⚠️ **Reopened 2026-09-03.** A second creator thread raised an abuse path this design does not
> close — see [Reopened: does a window imply a guarantee?](#reopened-does-a-window-imply-a-guarantee).
> Three questions, one axis: whether a guarantee is ever created *automatically*. Nothing else in
> this plan changes, and Phase 1 stays unblocked.

## The ask

> *"I would try to reconcile these systems eventually so these are not things people need to think
> about. i.e. it's all paid access, but some have a pledge to be free after some duration, and let
> creators decide this duration."*

Concretely, a creator wants to set most of their models up as: paid on release, 20% off after a
month, 50% off after three, 75% off after six, free after a year — and to be unable to walk the last
step back.

## What exists today

| | Timed early access | Permanent paid access |
|---|---|---|
| Ends? | Yes — becomes free at `endsAt` | Never |
| Max duration | **30 days**, score-gated (3d at 40k score, 30d behind a feature flag) | n/a |
| Concurrency cap | Yes, score-gated | No |
| Can be *started* after publish? | **No** — `canChooseTimed = !isPublished \|\| timedAlreadySet` | Yes |
| Can a sale discount it? | **No** | Yes |
| Donation goal? | Yes — meeting it ends the window early | No (a goal ends a *window*; there isn't one) |

**And there is a third pricing system, not two.** `ComicChapter` carries its own
`earlyAccessConfig` Json and `earlyAccessEndsAt` — a parallel early-access implementation on a
different table, with its own expiry. 79 chapters use it. `PaidAccessEntityType` already lists
`ComicChapter` in anticipation of merging the two, and nothing has yet.

That makes this worth more than the framing above suggests: comics stop needing a second early-access
mechanism, and the guarantee, the ladder and promotions become available there without a third build. It
also means comics migrating is *easier* if this lands first — otherwise they inherit the split.

Two further pieces already exist and matter:

- **`ModelVersionSale`** — scheduled discounts with `startsAt`/`endsAt`, `Fixed`/`Percent`,
  `discountAmount`, and a per-version join table. Tier-scaled duration caps (3 days free → 30 gold),
  a 14-day scheduling lead cap, and a 10,000 creator-score floor, all overridable from a `KeyValue` row.
- **`process-ending-early-access`** — the job that retires a window when it expires.

### Promotions: measure before you argue from the numbers

An earlier draft ran a section titled *"Sales have no installed base"* and leaned on it — 5 sales, 28
items, "reshape it now while it is free". **That argument is dead, and it died within a day of being
written.**

| | 2026-09-01 | 2026-09-02 |
|---|---|---|
| Sales | 5 | **7** |
| Sale items | 28 | **604** |

One sale created on the original measurement date carries 575 items on its own. The table grew 20x in
a day. The re-key is still small work — it is a column rename on a young table — but **nothing in this
plan should rest on a raw row count as evidence that a feature is dormant.** Quote counts with an
as-of date, and re-measure before acting on one.

What does hold from that audit: 13 sale items cover versions with no gate at all, so they discount
nothing. Both their sales are over, so the rows are inert — see Q13.
The wall between them is deliberate. From
[`sale-eligibility.ts`](../../../apps/creator-studio/src/lib/server/monetization/sale-eligibility.ts):

> **Permanent only** — a sale never covers a timed early-access window.

A timed gate's price already varies with time; layering a second time-varying discount over it was an
interaction nobody wanted to own.

## Proposed structure

Three independent parts, which is what makes this tractable:

**1. Paid access** — the base gate and its price. Unchanged from today: access price, generation
grant, trial generations, Blue Buzz.

**2. Unlock** — one date, plus flags. Not two modes.

The proposal originally described "permanent free unlock" and "timed with a donation goal" as
alternatives. They are better modelled as **an unlock date, which may carry a guarantee**:

| | No guarantee | Guaranteed |
|---|---|---|
| **No unlock date** | Permanent paid access *(today)* | — |
| **Unlock date** | Early access *(today)* — creator may still change it | Guaranteed free *(new)* |

The unlock date is `PaidAccess.endsAt`. The guarantee is a **separate row** keyed to the same entity
(see [Guarantee rules](#guarantee-rules)) — not a flag on the gate, because it has to outlive it.
Where both exist, `endsAt` can never be later than the guaranteed date; a donation goal may pull the
unlock earlier, leaving the guarantee standing at its original date as the ceiling that was met early.

This resolves something the proposal left tangled. A ladder step "down to free, no promise" is not a
third mechanism — it is an unlock date without a guarantee, which is exactly early access. Nothing extra
to build for it.

It is also forced by the code: **a sale can take at most 99% off**, so a discount can never reach free.
Free is structurally the job of the unlock and cannot be the job of the ladder.

A **donation goal** attaches to the unlock date and accelerates it (decided 2026-09-01), guaranteed or
not. It never pushes the date back.

**3. Timed discounts** — a new, separate section: an array of `after X time, reduce by Y%` (or *to*
Y). **No promise is made.** A creator may schedule a step down to free here, and may still cancel or
change it. This is the part that carries the long durations, and the part templates can hold.

Separating (3) from (2) is the whole trick. A discount ladder that promises nothing needs no ratchet,
no cap, and no new policy. A guarantee needs all three, and is one small object.

**All of it is authorable from both the main-site version form and the Creator Studio** (decided
2026-09-01).

**This is a smaller change than an earlier draft claimed.** That draft said permanent paid access was
Studio-only and called opening it up "a real widening". It is not: the main-site form already renders
an undisabled `Paid Access (permanent)` option
([`ModelVersionUpsertForm.tsx`](../../../src/components/Resource/Forms/ModelVersionUpsertForm.tsx)), and
`canConfigurePaidAccess` admits any published version. The 403 in the REST endpoint restricts *that
endpoint*, which is the Studio's own channel — not the main site.

The real asymmetry runs the other way, and it **is** something this unification has to delete:
`canChooseTimed = !isPublished || timedAlreadySet` — a **timed window cannot be started after
publish**, and `mergeEarlyAccessConfigUpdate` throws on it server-side. Under one model where the
unlock date is just a date, that restriction has to go or be re-justified. It is in the build list.

### A step sets a price. It can do so two ways.

A step is part of the entity's own pricing plan — *what this grant costs from that day* — not a
temporary reduction spanning many products. That is what keeps it a different object from a promotion
no matter how it is expressed. But there are two legitimate ways to express it, and the original ask
named both: *"lower price by Y, **or to** Y"*.

```prisma
enum PriceStepMode {
  SetTo     // amount IS the new price
  ReduceBy  // amount is a percentage off the grant's price
}
```

| Mode | `amount` means | For |
|---|---|---|
| **`ReduceBy`** | % off the grant's price | "my pricing shape" — reusable across models, and it tracks base-price changes |
| **`SetTo`** | the new price outright | "this model ends at 50 Buzz" — buyer-verifiable, the only way to name an exact figure |

🔴 **Do not reuse `SaleDiscountType`.** An earlier draft did. In that enum `Fixed` means *Buzz taken
off* — `saleDiscountFor` computes `off = discountAmount` and subtracts it
([`paid-access.ts`](../../../packages/civitai-buzz/src/paid-access.ts)). A step needs the opposite: the
amount **is** the price. Same enum, inverted meaning, with a shared helper sitting right there for
someone to reach for — on a 5,000 base with a 1,250 step that charges **3,750 instead of 1,250**.
`SetTo`/`ReduceBy` cannot be passed to `saleDiscountFor` by accident.

Neither emulates the other: percent cannot name a final figure, fixed cannot follow a base change.

**An earlier draft of this plan had `Fixed` only**, on the reasoning that a scheduled price change is
still a price and "20% off" is an authoring convenience. That under-weighted one thing: **base prices
move in bulk here.** The Studio's bulk fee editor was decided as v1 because it is the point of the
tool, so a creator repricing 200 models at once is ordinary. With fixed steps:

| | Base | Step at 90d | Effective discount |
|---|---|---|---|
| Before a bulk raise | 200 | 100 | 50% |
| After raising to 300 | 300 | **100** | **67%** |

The ladder silently deepens. Nobody edited the step; the discount changed anyway — a wrong price
arriving through a path the creator never touched, which is the failure mode this design exists to
remove. Percentage steps track the base and it does not happen.

**The mode is uniform per ladder.** Every step for one `(entity, kind)` shares it. A mixed ladder —
rung one fixed, rung two percent — makes *"will a price raise move this?"* unanswerable. Editor-level,
like the monotonic guardrail.

**`ReduceBy` leads in the editor.** The sale system has offered a fixed and a percent mode since
launch and every sale created has used percent; the fixed mode has never been used once.

### Guarantee rules

A guarantee is a row in `PaidAccessGuarantee`. **Row exists ⇒ guaranteed**, the same idiom as the
gate's own *row exists ⇒ gated*.

Three invariants, and everything else follows:

1. **`freeAt` may only move earlier, and is never cleared.**
2. **Once `freeAt` has passed, the entity cannot be gated again.**
3. **`freeAt` is a ceiling on every read.** The effective unlock is
   `LEAST(COALESCE(endsAt, infinity), COALESCE(freeAt, infinity))`.

🔴 **Invariant 3 is not optional, and an earlier draft omitted it.** A permanent gate has
`endsAt IS NULL`, which is later than every date. With only invariants 1 and 2 the sequence — set a
12-month guarantee, then switch the gate to permanent — passes every write check, because invariant 2
only refuses gates created *after* `freeAt` has already passed. `isPaidAccessActive` then returns true
forever and the entity never goes free. Enforcing on **read** closes it for every gate shape at once,
and needs no sweep job. The write path should refuse it too, so the creator gets an error rather than
a silently-capped gate — but the read is what makes the promise true.

Everything else stays the creator's — price, steps, promotions, all under the rules that already
exist. Until it fires, they own it. A donation goal can still be **lowered, never raised**, behind a
confirmation that says the change cannot be undone; today a goal is fully immutable once published,
so that is a deliberate loosening.

Every guarantee is **public** (Q2). A promise a buyer cannot see cannot be relied on, and it is what
makes "no refunds on a price drop" (Q14) fair — the drop was disclosed before they paid.

**Three write paths have to enforce it**, or it is a UI convention rather than a guarantee:

| Path | Check |
|---|---|
| Gate upsert (service + REST endpoint) | Refuse a new gate on an entity whose guarantee has fired |
| Guarantee write | Refuse a later `freeAt`; refuse a delete |
| Gate delete | *Nothing* — deleting a gate no longer touches the guarantee |
| **Every price read** | **Treat `freeAt` as a ceiling** — past it, the entity is free whatever the gate says |

### What "free" covers

When a guarantee fires, **every grant on that entity goes free** — download, generation, access. It is
the gate that unlocks, not one grant.

The per-generation **licensing fee is a separate charge and is untouched.** So a "free" model may still
cost Buzz to generate with, which is exactly what a buyer will not expect from the word *free*.

🔴 **This is a naming problem, and the fix is the name.** Calling it *"permanently free"* promises more
than it delivers. Call it **free access** — or "access becomes free" — so the scope is in the phrase
rather than in a footnote nobody reads.

### A ladder may reach free

A `ReduceBy 100` or `SetTo 0` step is allowed — the owner's call (Q16). Two things follow, and the
second is not optional:

- **It is revocable.** A ladder promises nothing, so a creator may raise it again. That is a different
  state from a guarantee, and a buyer has no way to tell them apart unless the page says which it is.
- **Reaching zero means the grant is FREE, not that it costs 0.** Resolve a zero price to the free
  state — no purchase, no transaction. A zero-Buzz *charge* writes no ledger row, and the 30-day refund
  path reads amounts back from the ledger, so a zero-value purchase is invisible to refunds and to
  reporting. The sale path avoids this with a 99% cap and a minimum price; the step path has neither,
  so it has to resolve to free instead of flooring.

### Notifying on a price drop

A step firing notifies **people who liked the model but have not bought it** (Q10) — a self-selected
audience that has signalled interest and has nothing to lose by hearing the price fell. Not followers,
not a broadcast.

It also naturally bounds the spam risk the promotions feature needed a per-month cap for: the audience
is per-model and opt-in by behaviour rather than per-creator.

### A guarantee cannot be broken

No override, moderator or otherwise (Q11). The enforcement burden therefore moves entirely to the
moment of creation — the confirmation has to be unmistakable, because nothing downstream can undo it.

Content that has to come down is handled by **removing the content**, not by breaking the promise: a
deleted entity has no gate to enforce, and its guarantee row is inert. That is why the table carries no
FK — it neither blocks the delete nor resurrects with it.

### Who may set one, and who it follows

**Only the model version owner may set a guarantee** (Q17) — a check at the write path, alongside the
existing ownership guards. That is an *authorization* rule, and it is deliberately not an `ownerId`
column: the guarantee travels with the entity (Q9), so a current owner is read from the entity. Storing
and syncing a second copy would be one more thing to forget on transfer, and `PaidAccess.ownerId`
already exists for the gate.

What the table *does* record is **`createdBy`** — who made the promise, written once and never updated.
An irrevocable commitment with no trace of who committed to it is not something anyone can support
later.

### Three transfer behaviours

A model transfer now moves three things differently, and the split is principled rather than
accidental:

| | On transfer | Why |
|---|---|---|
| **The gate and its guarantee** | **Transfer** | Attached to the entity — the promise is about the model, not the person |
| **A promotion** (`PaidAccessSale.userId`) | **Does not** | *"a sale is the previous owner's pricing decision"* — their running promo stops applying |
| **The rights affirmation** | **Does not** | Owner-scoped; a named person accepting liability, which does not carry over |

So a new owner inherits an obligation they did not make. That is the intended reading of Q9 — a buyer
relied on the promise, and who owns the model afterwards is not their problem.

### Templating a guarantee

A guarantee **is** templatable (Q3), so a creator who wants every release to go free after a year sets
that once rather than per upload.

**It still requires an explicit confirmation on every model.** Templates only ever pre-fill a form —
nothing is applied until the version is saved — but a creator clicking save is not the same as a
creator deciding to make a permanent promise. This follows the rights affirmation, which is never
pre-filled for exactly this reason. Drop the confirmation and the first support ticket is *"I did not
know I had promised that."*

**Why its own table rather than columns on the gate.** Clearing paid access **deletes** the gate row —
`if (!gated) { deleteMany(...) }` in `paid-access.service.ts`, the most ordinary operation there is. A
guarantee stored there would be destroyed by it, and the fix would be an invariant forbidding the
delete, which is fighting the table rather than modelling the thing. The lifetimes differ: a gate
answers *"how is this sold right now"* and comes and goes; a guarantee answers *"what has been promised
about this, permanently"* and exists precisely to constrain gates that may not exist yet.

## Price steps are not promotions

Asked cold on 2026-09-02 — *what tables would this need, ignoring what exists?* — four entities fall
out, and a price step and a promotion are clearly not the same one:

| | Price step | Promotion |
|---|---|---|
| Belongs to | **one** version | **many** versions |
| Time basis | relative to publish | absolute dates |
| Lifetime | until superseded | a bounded window |
| Shape | a monotonic ladder | arbitrary, one-off |
| Limits | none needed | duration / lead / score caps |

An earlier draft of this plan merged steps into `ModelVersionSale` behind a `kind` discriminator.
That was wrong, and **the discriminator was the tell**: it exists precisely because two things with
different rules were put in one table, and every consumer then has to ask which kind it is holding.
That relocates complexity rather than removing it — and it forced two `NOT NULL` columns to go
nullable for promotions that always have them.

Steps get their own table. The promotion tables keep every column they have — they are re-keyed onto
the gate axis for a separate reason ([below](#promotions-belong-at-the-gate-level)), not reshaped.

### The three layers compose

1. **Base price** — the gate's grants.
2. **Price steps** set the current list price: **only the latest step whose `afterDays` has elapsed**
   applies, per grant. `SetTo` uses its `amount`; `ReduceBy` takes that much off *the grant's price*.
   **Steps never compound** — a −20 / −50 / −75 ladder resolves to 25% of the grant price at the end,
   not 8%. Earlier rungs are superseded, not stacked.
3. **A promotion** discounts that list price.
4. **The unlock** is terminal and beats everything.

A 5,000 version at a 50% step lists at 2,500; a 20% promotion over it charges **2,000**.

A `ReduceBy` ladder on a grant priced at 5,000:

| Elapsed | Latest step | List price | With a 20% promo |
|---|---|---|---|
| 0–1 month | none | 5,000 | 4,000 |
| 1–3 months | day 30 · −20% | 4,000 | 3,200 |
| 3–6 months | day 90 · −50% | 2,500 | 2,000 |
| 6–12 months | day 180 · −75% | 1,250 | 1,000 |
| 12 months | — | **free** (guarantee fires) | free |

The same ladder as `SetTo` would store 4,000 / 2,500 / 1,250 and produce identical prices — until the
base moves.

The merged design could not express this. Two rows in one table can only be *compared*, not composed,
which is why it forced "deepest wins" and the consequence that **a promotion shallower than the current
step does nothing**. Separating the tables restores the reading a creator expects: they ran a
promotion, and it took money off.

### Unifying the gates still deletes code

Independent of the above. The wall — `pa."timeframeDays" IS NULL` in the sale query, and the
permanent-only rule in `isSaleEligibleGate` — exists *only* because a timed gate is a separate
mechanism. Once a timed gate is "a gate with an unlock date", the filter has nothing left to exclude
and both can go.

### The whole build list

0. **Normalize the gate's grants** out of the `terms` JSONB — a prerequisite that ships first and
   alone. See [Prerequisite](#prerequisite-normalize-the-gates-grants).
1. **A price-step table** (below) and the reader that resolves the latest elapsed step per grant.
2. **One column** on `PaidAccess` — `acceptsBlueBuzz`, lifted out of `terms` — and a
   **`PaidAccessGuarantee` table**, keyed to the entity so it survives the gate being cleared.
3. **Re-key the promotion tables** onto the gate's polymorphic axis — see
   [Promotions belong at the gate level](#promotions-belong-at-the-gate-level).
4. **Compose** the promotion over the resolved list price, in the three places a price is produced:
   the model page, the purchase flow and the charge path.
5. **Delete two rules** — the sale query's `timeframeDays IS NULL` filter and `isSaleEligibleGate`'s
   permanent-only check (the wall); and `canChooseTimed`, which forbids *starting* a timed window
   after publish, both in the form and in `mergeEarlyAccessConfigUpdate`.
6. **Editor rules** — one mode per ladder, and a ladder should get cheaper over time. Both guardrails,
   not correctness rules. No schema.

Three new tables (grants, price steps, guarantees), **one** column on the gate, one re-key.
**11,342 grant rows** backfilled and **28 promotion rows** re-keyed; no gate row changes. See
[Database changes](#database-changes).

### What this costs that the merged design did not

Honestly: the price resolver reads two sources instead of one, and the cache has to carry the steps.
That is a join and a cache field, against a discriminator threaded through every limit check, editor
and query, plus null-handling at ~36 date comparisons. The trade is not close.

It also *removes* a build item. A step stores `afterDays` and is inherently relative, so nothing has
to be materialized at publish — the merged design needed that only because a sale row carries an
absolute `startsAt`.

## Promotions belong at the gate level

Paid access is polymorphic everywhere except one place:

| | Keyed on |
|---|---|
| `PaidAccess` — the gate | `entityType` + `entityId` |
| `EntityAccess` — purchases | `accessToType` + `accessToId` |
| `PaidAccessPriceStep` — proposed | `entityType` + `entityId` |
| **`ModelVersionSaleItem`** | **`modelVersionId`** |

Config, purchases and the new steps all carry the polymorphic key. The promotion is the odd one out,
which means a comic chapter can be gated, bought, and put on a price ladder — but cannot be put on
promotion.

**The gap is latent, not live.** Production carries 5,760 gates and every one is a `ModelVersion`;
there are no `ComicChapter` gates yet. So this costs nothing today — which is the argument for fixing
it now rather than against. The re-key is a column rename on a young table either way — but size it
from a fresh count, not from this document (see [Promotions: measure before you argue from the
numbers](#promotions-measure-before-you-argue-from-the-numbers)).

**And it makes the read simpler.** The sale query already joins `PaidAccess`. It joins
`ModelVersion → Model` for one reason — to reach `m."userId"` for the ownership check — and
`PaidAccess.ownerId` already exists. Two joins collapse into a column the query is already holding.

The per-type liveness check (`mv.status = 'Published'`) stays a per-type join. That is fine: every
call site is already single-type, so nothing has to resolve mixed types in one query.

### Why not denormalize `publishedAt` onto the gate

Considered and rejected. It would make the step read type-agnostic, but that optimizes a query nobody
writes — every reader already knows its entity type — and the join it saves is a primary-key lookup.
Against that, `ModelVersion.publishedAt` is nullable and mutable, so a copy needs every writer to keep
it in step or the two silently disagree, in a price.

The rule that separates this from `endsAt`, which *is* materialized:

> **Materialize when a job has to scan by it. Resolve through the entity when the reader already has
> the entity in hand.**

`PaidAccess.endsAt` carries `@@index([entityType, endsAt])`, annotated *"expiry-job +
early-access-complete notification scan by end time"*. A sweep cannot know which entities to look at,
and `publishedAt + timeframeDays` cannot be indexed across a polymorphic join — that index is the
whole reason it is a column. Price resolution has no such sweep.

One contingency: if **Q10** decides that steps notify, something must sweep for boundaries crossed,
which *is* index-shaped. The materialization then belongs on the step row as an `activeFrom` computed
at publish — the boundary being scanned, not the anchor — and not on the gate.
## Prerequisite: normalize the gate's grants

**Ships first, on its own, before anything else here.** It is independently valuable, and everything
below is easier once it is done.

Today a gate's prices live in a `terms` JSONB, and the reason is sound: `PaidAccess` is polymorphic,
so different entity types may want different pricing shapes. The question is whether they actually do.

**The weak version of this argument, which an earlier draft made:** across 5,760 gates every observed
shape is a subset of the same six keys, so the flexibility is unused. That proves nothing — all 5,760
are `ModelVersion`. One type having one shape says nothing about a second type.

**The real evidence is comics**, the one other type that is planned and partly built. Its
`ComicChapter.earlyAccessConfig` is, in every one of the 79 chapters using it:

```json
{ "buzzPrice": 500, "timeframe": 12 }
```

A price and a window — *simpler* than a model version, not differently shaped. No comic-specific
field, nothing a model version does not also have. So:

| | Kinds | Fields per kind |
|---|---|---|
| ModelVersion | Download, Generation | price · trialLimit |
| ComicChapter | Access | price · trialLimit |

The variation between types is **which kinds exist**, not **what a kind holds**. A `kind` enum handles
that natively. A blob handles it too, but also buys per-type *field* variation that neither type needs
— at the cost of prices no query can read.

And that cost is not hypothetical. `isSaleEligibleGate` exists because *"does this gate carry a
price?"* is not a SQL predicate but a JS function over JSON; thirteen sale items covered priceless
gates, schedulable and discounting nothing. The sale query carries a second: *"a jsonb `::int` in SQL
would hard-error the whole batch on a fractional price the write path never rejected"* — prices cannot
be safely cast in SQL, so every one is read in JS. Nothing can index on price.

**If a future entity type genuinely needs a field these do not**, add a `meta Json` column to the grant
at that point. Flexibility exactly where it is needed, without surrendering queryable prices
everywhere else — and a decision that can be deferred until something forces it.

### The model

```prisma
enum GrantKind {
  Download
  Generation
  // Access — when comics ship gated chapters. The code already calls a chapter grant `access`
  // (ComicChapterTerms = { access: Grant }), so keep that word. Additive enum: deploy the client first.
}

model PaidAccessGrant {
  entityType PaidAccessEntityType
  entityId   Int
  kind       GrantKind
  // NULL = free. Otherwise what it costs.
  price      Int?
  trialLimit Int?

  @@id([entityType, entityId, kind])
  @@index([kind, price])
}
```

```sql
CHECK (price IS NULL OR price > 0)               -- no zero-priced grant
CHECK (price IS NOT NULL OR trialLimit IS NULL)  -- a free grant has no trial
```

There is deliberately **no `free` column**. It would be true exactly when `price IS NULL`, and a
column derivable from another column is a column that can disagree with it. Three states cover
everything: **no row** = not sold, **row with NULL price** = free, **row with a price** = costs that.

The second CHECK is the one worth having: a trial limit on a free grant is meaningless — *free uses
before you must pay*, when you never must. Nothing in production does it, and now nothing can.

**No inheritance.** An earlier draft had a generation grant with no price of its own inherit the
download price — that is what "bundled" means today. Two problems: it makes `NULL` mean two different
things (free, or inherit), and "Generation inherits from Download" is ModelVersion vocabulary inside a
kind-agnostic table — a `Access` grant on a comic chapter has no Download to inherit from.

So bundling resolves **once, in the migration**, not on every read forever. A bundled generation grant
is simply stored at the same number as the download grant. Verified safe: all **1,738** bundled grants
have a download price to resolve against, and none is free-and-priced at once.

"Same as the access price" survives as a **UI mode**, not a storage fact — the form infers it by
comparing the two numbers and writes both on save.

**Why this resolves once while a price step may track (`Percent`).** They look like the same question
and are not. Bundling is an *immediate* relationship: both numbers exist at the moment of the write, so
the writer can resolve it then. A step is *deferred* — it fires months later, when no writer is present
to resolve anything, and possibly after a bulk reprice. There is no moment at which a step could have
been resolved correctly; there is always such a moment for bundling.

The obligation that follows: **every path that changes a download price must also update a bundled
generation grant** — the form, and the Studio bulk editor, which can reprice gates across many versions
at once. Miss the bulk path and bundled grants go stale exactly the way fixed ladders would. That is
work moved from the read path to the write path, which is the right direction given how few write sites
there are, but it is not free and the bulk editor is the easy one to forget.

### The mapping is total

| `terms` | kind | `price` | `trialLimit` | Rows |
|---|---|---|---|---|
| `download: {price: P}` | Download | P | — | 5,723 |
| `generation: {free: true}` | Generation | **NULL** *(= free)* | — | 2,219 |
| `generation: {price: P, trialLimit: T}` | Generation | P | T | 1,662 |
| `generation: {trialLimit: T}` — bundled | Generation | **the download price** | T | 1,738 |
| key absent | *(no row)* | | | |

A missing row is meaningful: no `Generation` row means generation is not sold at all, which is a
different fact from `free: true`, where it is sold and costs nothing.

**11,342 grant rows** from 5,760 gates, measured **2026-09-02**. Every count reconciles against the
shape census — and every one of them drifts daily, so re-measure at migration time rather than
trusting these.
`acceptsBlueBuzz` is not a grant property and is lifted to a column on the gate — 1,684 gates carry it,
all `true`.

### What a migrated comic chapter looks like

Not part of this migration — comics move separately — but it is the case the model has to serve, so
it is worth showing that it does.

```json
// TODAY — ComicChapter
{ "earlyAccessConfig": { "buzzPrice": 500, "timeframe": 12 },
  "earlyAccessEndsAt": "2026-09-14T00:00:00.000Z" }

// AFTER — PaidAccess
{ "entityType": "ComicChapter", "entityId": 777777, "ownerId": 999999,
  "timeframeDays": 12,
  "endsAt": "2026-09-14T00:00:00.000Z",
  "acceptsBlueBuzz": false }

// AFTER — PaidAccessGrant (one row)
[ { "entityType": "ComicChapter", "entityId": 777777,
    "kind": "Access", "price": 500, "trialLimit": null } ]
```

`timeframe` → `timeframeDays`, `earlyAccessEndsAt` → `endsAt`, `buzzPrice` → an `Access` grant. One kind,
no new fields, and `ComicChapter.earlyAccessConfig` and `earlyAccessEndsAt` can then be dropped.

### The data is clean

Audited 2026-09-02, and none of this was assumed:

| Check | Result |
|---|---|
| Empty or null `terms` | 0 |
| `download` present without a price | 0 |
| Non-integer prices *(the code warns this is possible)* | 0 |
| Zero or negative download prices | 0 |
| Non-integer trial limits | 0 |
| Gates with neither grant | 0 |
| `generation` carrying both `free` and `price` | 0 |
| Orphaned gates (entity deleted) | **19** |

Max download price 888,888 Buzz, max generation 20,000 — both fit `Int`. Migrate the 19 orphans rather
than filtering them: `PaidAccess` has no FK to its entity, so orphans accrue naturally, they are inert
either way, and excluding them turns the migration from a pure transform into a filter — which is what
makes the verification below meaningful. Clean them up as a separate decision.

### The backfill

```sql
INSERT INTO "PaidAccessGrant" ("entityType","entityId","kind","price","trialLimit")
SELECT pa."entityType", pa."entityId", 'Download',
       (pa.terms->'download'->>'price')::int, NULL
FROM "PaidAccess" pa WHERE pa.terms ? 'download';

INSERT INTO "PaidAccessGrant" ("entityType","entityId","kind","price","trialLimit")
SELECT pa."entityType", pa."entityId", 'Generation',
       -- free -> NULL. Bundling resolves HERE, once, not on every read forever.
       CASE WHEN (pa.terms->'generation'->>'free')::boolean THEN NULL
            ELSE COALESCE((pa.terms->'generation'->>'price')::int,
                          (pa.terms->'download'->>'price')::int)
       END,
       (pa.terms->'generation'->>'trialLimit')::int
FROM "PaidAccess" pa WHERE pa.terms ? 'generation';

UPDATE "PaidAccess" SET "acceptsBlueBuzz" = true WHERE (terms->>'acceptsBlueBuzz')::boolean;
```

### The verification gate

Reconstruct `terms` from the grant rows and diff every field against the source. **Require zero rows**
before anything reads grants.

```sql
WITH rolled AS (
  SELECT "entityType" et, "entityId" eid,
    count(*) FILTER (WHERE kind='Download')        AS has_dl,
    max(price) FILTER (WHERE kind='Download')      AS dl_price,
    count(*) FILTER (WHERE kind='Generation')      AS has_gen,
    max(price) FILTER (WHERE kind='Generation')    AS gen_price,
    max("trialLimit") FILTER (WHERE kind='Generation') AS gen_trial
  FROM "PaidAccessGrant" GROUP BY 1,2
)
SELECT count(*) AS mismatched_gates
FROM "PaidAccess" pa
LEFT JOIN rolled r ON r.et = pa."entityType" AND r.eid = pa."entityId"
WHERE (coalesce(r.has_dl,0) = 1) IS DISTINCT FROM (pa.terms ? 'download')
   OR r.dl_price  IS DISTINCT FROM (pa.terms->'download'->>'price')::int
   OR (coalesce(r.has_gen,0) = 1) IS DISTINCT FROM (pa.terms ? 'generation')
   -- A bundled grant stores the RESOLVED download price, so compare against that — but only when a
   -- generation grant exists at all. Without the first arm, a download-only gate expects a Generation
   -- row priced at the download price, and the gate fails on 141 correct rows.
   OR r.gen_price IS DISTINCT FROM (
        CASE WHEN NOT (pa.terms ? 'generation') THEN NULL
             WHEN (pa.terms->'generation'->>'free')::boolean THEN NULL
             ELSE COALESCE((pa.terms->'generation'->>'price')::int,
                           (pa.terms->'download'->>'price')::int) END)
   OR r.gen_trial IS DISTINCT FROM (pa.terms->'generation'->>'trialLimit')::int;
```

The transform logic was dry-run against production over a CTE on 2026-09-02 and returned **0**
mismatches across all 5,760 gates. That proves the *mapping*; the query above, run against the real
table after the insert, proves the *migration*. They are not the same claim.

### Sequencing — this is expand/contract, not one INSERT

A backfill is a snapshot, and creators change prices continuously, so the two representations drift
from the moment it finishes. The order:

1. Create the table and columns. Deploy.
2. **Dual-write** — every write to `terms` also writes grants. Deploy.
3. Backfill. Run the verification gate; require zero.
4. Cut reads over to grants, behind a flag. Verify again.
5. Stop writing `terms`.
6. Drop `terms` in a later migration — the point of no return.

Dual-write is cheap here: only **two call sites write `terms`**, both in `paid-access.service.ts` (the
upsert and the in-transaction update). Every other write to `PaidAccess` touches `endsAt` or deletes
the row, and deletes cascade to grants via the composite FK.

**Rollback**, while `terms` is retained: stop reading grants, truncate `PaidAccessGrant`. Nothing else
to undo. That property disappears at step 6, which is why 6 is a separate migration.

### What it costs in code

11 files read gate terms, but the shape logic concentrates in
[`packages/civitai-buzz/src/paid-access.ts`](../../../packages/civitai-buzz/src/paid-access.ts) —
`gatePrices`, `paidGenerationGrant`, `isFreeGeneration`, `saleAnchorPrice`. **Those helpers already act
as an anti-corruption layer over the JSONB.** Keep their signatures, change what feeds them, and most
of the other ten files do not move.

## Database changes

Additive in shape. **No gate row changes** — both of today's gate types are already representable:
early access is an unlock date with no guarantee (`timeframeDays` set, `endsAt` materialized), and
permanent paid access is neither.

Two data moves, both transforms of rows that already exist: the grant backfill (**11,342 rows**, the
[prerequisite](#prerequisite-normalize-the-gates-grants)) and the promotion re-key (**604 rows** as of
2026-09-02, and growing fast — re-count before planning it).

### `PaidAccess` — the header

With grants normalized out (see the [prerequisite](#prerequisite-normalize-the-gates-grants)), the
gate keeps only what is true of the **whole entity**: who owns it, when it unlocks, and how it may be
paid for. **One added column.**

```prisma
model PaidAccess {
  // ... unchanged: entityType, entityId, ownerId, endsAt, timeframeDays
  // terms  Json  -> decomposed into PaidAccessGrant, dropped after cutover

  // Lifted out of `terms`: a gate-level payment option, not a property of one grant.
  acceptsBlueBuzz Boolean  @default(false)
}
```

**Why the gate survives at all once grants are rows.** It is the header to their line items, and the
unlock is what makes that necessary: it is *one event* that frees every grant at once.
Duplicating `endsAt` onto each grant lets two rows disagree — download unlocked, generation still
charging — and a date backed by an irrevocable promise is the worst place to permit drift. The same
holds for `ownerId` (the promotion query reads it), for the `@@index([entityType, endsAt])` the expiry
sweep uses (per gate, not per grant), and for `acceptsBlueBuzz`.

### `PaidAccessGuarantee` — the new table

Keyed to the entity, not to the gate, because it has to survive the gate being cleared.

```prisma
model PaidAccessGuarantee {
  entityType PaidAccessEntityType
  entityId   Int
  // Guaranteed-free length in days for a not-yet-published entity; freeAt is materialized to
  // publishedAt + freeAfterDays at first publish and NEVER recomputed. Mirrors endsAt/timeframeDays.
  freeAfterDays Int?
  // The date this is guaranteed free by. May only move EARLIER. Never cleared.
  freeAt     DateTime?
  // No visibility flag: every guarantee is public (Q2). A promise nobody can see is not one.
  // Who made the promise. An audit fact, recorded once, never updated — NOT an owner pointer.
  // The guarantee travels with the entity (Q9), so a current owner is read from the entity, not here.
  createdBy  Int
  createdAt  DateTime @default(now())

  @@id([entityType, entityId])
  // "everything going free this month" — a scan of one small table
  @@index([freeAt])
}
```

**No foreign key to `PaidAccess`**, deliberately, and it is the only child here without one: the gate
may be absent, may be deleted, and may not exist yet. That is the whole point of the table.

**`freeAt` is materialized once and never recomputed.** That closes the unpublish-and-republish reset:
a guarantee stored as a duration would restart its clock every time a version was taken down and put
back, which is a way to walk back an irrevocable promise. Because the guarantee lives on its own row,
nothing in the ordinary gate lifecycle can touch it.

### The anchor is `initialPublishedAt`

🔴 **Not `publishedAt`.** `process-ending-early-access` **overwrites `ModelVersion.publishedAt` with
`NOW()`** when a timed gate expires, to resurface the version as New. The service says so where it
guards against exactly this ([`model-version.service.ts`](../../../src/server/services/model-version.service.ts)):

> `initialPublishedAt` is the test — `publishedAt` is what that job rewrites

Anchor a ladder on `publishedAt` and **every entity that has ever had a timed gate resets its ladder to
step zero the moment that gate expires.** A twelve-month ladder on a version with a 30-day window jumps
back to full base price on day 30 and never advances again. Silent, permanent, and it looks like a
pricing bug rather than a schema one.

The same applies to materializing `freeAt` from `freeAfterDays`. An earlier draft said that "mirrors
`endsAt`/`timeframeDays`" — but `endsAt` **is** re-materialized on republish, which is precisely the
reset a guarantee must forbid. `freeAt` materializes once, from `initialPublishedAt`, and is never
recomputed.

### `PaidAccessPriceStep` — the new table

Polymorphic on the same axis as the gate it belongs to, so a step can exist for a comic chapter the
day that gate does.

```prisma
model PaidAccessPriceStep {
  entityType PaidAccessEntityType
  entityId   Int
  // Days after the entity FIRST published — ModelVersion.initialPublishedAt, never publishedAt.
  // See "The anchor is initialPublishedAt" below; this is not a stylistic choice.
  afterDays  Int
  // Which grant this reprices. Same vocabulary as PaidAccessGrant, deliberately.
  kind       GrantKind
  // SetTo: `amount` IS the new price. ReduceBy: `amount` is % off the grant's price.
  // Uniform per ladder — every step for one (entity, kind) shares a mode.
  // A DEDICATED enum, not SaleDiscountType — see the warning below.
  mode       PriceStepMode
  amount     Int
  createdAt  DateTime @default(now())
  updatedAt  DateTime @updatedAt

  @@id([entityType, entityId, afterDays, kind])
  @@index([entityType, entityId])
}
```

A step names *a grant, a day, and what that grant costs from then on* — resolved to a number before
anything else touches it. `kind` rather than a `downloadPrice`/`generationPrice` pair, because naming
those columns would bake ModelVersion vocabulary into a polymorphic table, the same mistake as keying
a sale item on `modelVersionId`.

`mode` does **not** blur the line with promotions: it
describes how a step computes, not what a step *is*. A step still belongs to one entity, is relative to
publish, and is permanent until superseded — none of which a promotion is.

**A step on a free grant has no effect** (Q15). A free grant is free; the ladder is ignored rather than
applied. That closes two holes at once — `ReduceBy` never does arithmetic on a NULL price, and `SetTo`
can never make a free thing cost money, which would have been a price *rise* on something buyers
already get for nothing. The editor should not offer a ladder on a free grant, since it would silently
do nothing.

🔴 **Cascade has a sharp edge, and the sync strategy decides how sharp.** Clearing paid access is
`deleteMany` on `PaidAccess` — reached whenever a gate write arrives with nothing gated. Under these
FKs that removes the grants, and with them every price step. So a creator who turns paid access off
for a week loses a twelve-month ladder, silently and unrecoverably.

Two things follow, and both are build requirements rather than notes:

- **Grant sync must be upsert-and-prune keyed on `kind`, never delete-and-reinsert.** Projecting a
  JSON blob onto rows by wiping and re-writing is the natural implementation and it would cascade away
  every step **on every save**, not just on ungating.
- **The editor must warn before an ungate that a ladder will be lost**, the same way it already warns
  before removing a stored charge.

The alternative — keying steps on the entity with no FK, so they survive like the guarantee — was
considered and rejected: a ladder is part of *how this is sold*, and a schedule for pricing that no
longer exists is not something to preserve. But that is a judgement, and it is the reason the warning
is not optional.

**Its foreign key goes to `PaidAccessGrant`, not to `PaidAccess`** — `(entityType, entityId, kind)` is
exactly that table's primary key. So a step repricing a grant the gate does not have cannot be
inserted, and removing a grant takes its ladder with it. The looser FK to the gate would allow a
Generation step on a gate that sells no generation, which resolves to nothing and is the same class of
defect as a promotion covering an ungated entity.

One consequence worth naming: a step can only *reprice* a grant that exists, so "start charging for
generation in six months" is not expressible. That is intended — it is a price rise, which is the
opposite of what a ladder is for.

Two constraints come free here and were unavailable while steps lived in the sale table: one step per
offset per grant, and deleting a gate can take its steps with it instead of orphaning rows.

### `PaidAccessSale` / `PaidAccessSaleItem` — renamed and re-keyed

No new columns, no new enum, no nullability relaxations, no discriminator. The limits — duration by
tier, 14-day lead, creator-score floor — keep applying exactly as they do today, with no per-kind
branching. Only the key and the name change.

```prisma
model PaidAccessSaleItem {          // was ModelVersionSaleItem
  saleId     Int
  entityType PaidAccessEntityType   // was: modelVersionId Int
  entityId   Int
  sale       PaidAccessSale @relation(fields: [saleId], references: [id], onDelete: Cascade)

  @@id([saleId, entityType, entityId])
  @@index([entityType, entityId])
}
```

**There is already a precedent for this exact re-key, mid-flight.** `DonationGoal` carries
`entityType`/`entityId` *and* a legacy `modelVersionId` with a real relation, with the schema comment
saying it plainly: *"Nullable while modelVersionId is dual-written; becomes the sole target when
modelVersionId is dropped (re-key migration)."* Someone is moving that table onto the gate's axis right
now, by exactly the expand/contract route proposed here. It is also the reason `DonationGoal` is the one
table in this schema still touching `ModelVersion` — temporarily.

Re-keying onto the gate's own key makes something new possible: a **composite foreign key** from
`(entityType, entityId)` to `PaidAccess`. Today there is none — a sale item points at a model version,
which may or may not be gated — and that is why 13 items ended up covering priceless gates. With the FK,
**that row cannot be inserted**, and clearing a gate takes its promotion items with it instead of
orphaning them. The eligibility rule stops being a JS check the write path has to remember and becomes a
constraint. The same FK applies to `PaidAccessGrant` and `PaidAccessPriceStep`.

`PaidAccessSale` itself keeps every column it has. Ownership checks move from the
`ModelVersion → Model` join to `PaidAccess.ownerId`.

### `DonationGoal` — unchanged

Already polymorphic (`entityType`/`entityId`) and already the accelerator: meeting the goal sets the
gate's `endsAt` to now. It needs no change to work with the unlock, guaranteed or not — the guarantee only
constrains which direction that date may move.

### Code changes that need no migration

- Drop `pa."timeframeDays" IS NULL` from the sale query, and the permanent-only rule in
  `isSaleEligibleGate` — the wall.
- Resolve the list price from the latest elapsed step per grant before applying any promotion, in all
  three places a price is produced.
- Editor: one mode per ladder, and a ladder should get cheaper over time. Guardrails, not correctness
  rules — a non-monotonic ladder is odd, not unpredictable.

### Applying it

Migrations here are applied by hand — see the Database section of the root `CLAUDE.md`.

The step table and the gate columns touch no existing row and have no ordering constraint
against a deploy. The re-key does — and it is **expand/contract with dual-write**, not a one-shot rename
(Q13): add the new columns, dual-write both spellings, backfill, cut every reader over, and only then
drop `modelVersionId`. **Nothing is deleted**, including the 13 inert items; they migrate with the rest
and can be cleaned up separately once nothing depends on the old column.

**604 sale items** as of 2026-09-02 move from `modelVersionId` to
`(entityType, entityId)`, all of them `'ModelVersion'`. Order it the usual expand/contract way — add
the new columns, backfill, deploy the readers, then drop the old column — or, given that 13 of the 28
are inert and both their sales are over (Q13), take the far simpler route of migrating only the 15
live items and deleting the rest in the same statement.

## Donation goals have to survive this

Measured against production, 2026-09-01:

| | |
|---|---|
| Goals created | **22,841** (19,022 active) |
| Distinct creators using them | **1,136** |
| Goals receiving at least one donation | **19,850 — 86.9%** |
| Goals actually met | **3,311 — 14.5%** |
| Donations all-time | **376,846**, totalling **176M Buzz** |
| Last 90 days | 18,268 donations · 7,658 distinct donors · 2,175 goals · 19.5M Buzz |
| Last 30 days | 5,567 donations · 7.5M Buzz |

Roughly 5.5k donations a month from thousands of distinct donors — not a legacy feature. The 86.9%
engagement rate against a 14.5% completion rate says goals mostly work as a **tip jar with a visible
target**, not as a reliable early-unlock mechanism. Worth remembering when deciding how prominent
they should be, and decisive on the main point: any unified model has to carry them forward intact.

## Reopened: does a window imply a guarantee?

Raised by creators in Discord, 2026-09-03. The design so far makes a guarantee **opt-in**, and the
migration never invents one. This asks whether a timed window should imply one on its own.

> *"A creator sets up early access and tells users that it will be free after a certain period of
> time. Currently, a creator can remove early access and switch it to paid access. […] I think it
> would be dishonest to set up early access with donation goals, receive donations, and then switch
> to paid access."*

### The claim that this is already handled is false

The thread settled on the belief that donors are refunded when a creator switches within 30 days.
**They are not.** A 30-day early-access refund does exist — `model-early-access-refund.service.ts` —
but it differs on both axes that matter:

- It refunds **buyers of paid access**, not **donors to a goal**. A donor is only ever refunded when
  their own donation transaction fails mid-flight (`donation-goal.service.ts`).
- It fires on **unpublish**, not on a config change. The gate write path contains no refund at all —
  `paid-access.service.ts` mentions the word once, in a comment.

So switching early access → paid access today refunds nobody and notifies nobody.

🔴 **We already learned this exact lesson on the buyer side.** The refund service records that it
used to require an active `PaidAccess` row, and that doing so *"put the switch in the obligated
party's hands"* — an ordinary editor save that omits `paidAccess` deletes the gate row, so two saves
cleared the obligation and a take-down refunded nobody. That was fixed for buyers by keying the
obligation to the **purchase** rather than to the gate's current state. Donors have the unfixed
version of the same hole, and the fix has the same shape: key the promise to something the obligated
party cannot edit.

### Exposure, measured 2026-09-03

| | |
|---|---|
| Donation goals on gated versions | **1,992** |
| — on a **timed** gate | 1,017 |
| — **timed and have taken money** | **764** (4.5M Buzz) |
| — on a **permanent** gate, with money | 840 |

The 764 are the exposure: money already collected against a stated free-by date the creator can
withdraw with one save.

**Past abuse is not measurable, and will not become measurable.** The gate keeps no history, and
`ModelVersion.earlyAccessTimeFrame` is `0` for all 840 permanent-gate goals — it is a legacy column
predating `PaidAccess` (6,033 non-zero repo-wide, none in this set). We can say the path is open, not
how often it has been walked. Do not go looking for a number to justify the fix; there is not one.

### Why this argues for the guarantee rather than a validation rule

The thread surfaced a second escape hatch: a creator can keep the download gated by dropping to
**generation-only** rather than switching to permanent paid access.

That is the argument for shape. A transition rule has to enumerate every downgrade — drop download
but keep generation, raise the price, switch to permanent, shorten the window — and a missed one
leaks the promise. A guarantee does not: **Q1** already defines it as freeing **every grant** on the
entity, so generation-only closes by construction. The machinery is designed and needs no change;
only the question of when a guarantee is created automatically is open.

> 🔴 **Q18 and Q19 are superseded (2026-09-03).** The donation-goal half of this question moved to
> [donation-goals.md](donation-goals.md) and was answered differently: a goal that is **met** (not
> merely funded) makes the model free to everyone for **30 days**, not permanently, and a lapsed
> window simply becomes **ungated** rather than guaranteed. **30 days is now the only guaranteed
> free.** Q20 below is still open. The two subsections are kept for the reasoning, not the
> recommendations.

> ⚠️ **This invalidates `PaidAccessGuarantee` as specified in this document** — an irrevocable,
> *permanent* free date whose `freeAt` only moves earlier, is never cleared, and is a ceiling on
> every read. Either that guarantee also becomes a 30-day window, or the product carries two
> different meanings of *free*: the ladder's and the goal's. Tracked as **D1** in
> [donation-goals.md](donation-goals.md#open-questions), and it has to be settled before either
> document is built from.

### Q18 — Does a timed window plus a funded donation goal create a guarantee?

**Recommended: yes.** Money changed hands on the strength of a stated date, which is the honest case
and the one the thread is actually about. A goal that has received **no** donation has nothing to
protect, so the trigger is the first donation, not the goal's existence.

### Q19 — Does a timed window with no donation goal create one?

**Recommended: no — disclose instead.** Show the date as *expected*, with one action to make it
guaranteed. A creator testing a timed price has promised nothing, and auto-binding all 1,017 existing
windows would invent obligations nobody made. This is the line between the two recommendations: a
guarantee follows the money, not the calendar.

### Q20 — Are the 764 existing funded windows bound retroactively?

**No recommendation — this is a judgement call about fairness, not a technical one.** Those donations
were taken under today's rules, where a window carried no promise. Binding them applies a rule
created after the fact; not binding them leaves the disclosed harm in place for the population that
actually experienced it.

⚠️ Answering **yes** contradicts the recorded decision that the migration never invents a guarantee
(see [Decided](#decided)). That decision was made about *unfunded* windows and did not consider this
case, so it is reopened rather than violated — but it has to be edited if Q20 lands on yes.

### Enforce, or compensate?

Refunding donors when a promise is withdrawn is the alternative to enforcing it. **Enforcement is the
recommendation**: a donation was never a purchase, so compensating means putting a price on a gift,
and the amount that would make a donor whole is not a number anyone can derive. Enforcement also
needs no new money path — the guarantee already exists.

## What this resolves

An earlier pass at this listed the 30-day cap and the irreversibility guarantee as the two hardest
blockers. The split above largely answers both.

**The duration cap should not apply to a guarantee — and the reason inverts the usual argument.** The
30-day cap bounds how long a creator may withhold something *that would otherwise become free*. A
permanent gate withholds forever and is uncapped. So a guarantee to go free at twelve months is
strictly better for the ecosystem than the uncapped status quo, and capping guarantees at 30 days would
push creators back to a plain permanent gate — the worse outcome for everyone. Long durations
otherwise attach to the discount ladder, which withholds nothing.

**And it stays small.** Unifying the gate types deletes the permanent-only wall rather than teaching
it a new case, and the unlock-plus-guarantee model collapses three creator-facing concepts into one.
What is added is three tables, one column, and a re-key of 28 promotion rows — plus the grant
normalization, which is a prerequisite that ships on its own.

**The ratchet shrinks to one object.** Not every rung of a ladder — just the guarantee, with the rules
above. The codebase already reasons in this shape: the licensing-fee ceiling check is
raise-only, with a named exception for a write that moves a version onto a stricter media axis
([`paid-access.service.ts`](../../../src/server/services/paid-access.service.ts)).

## Decided

| | |
|---|---|
| **Q4 — Do the unlock options combine?** | **Yes.** Modelled as one unlock date with an optional guarantee and an optional goal — see [Proposed structure](#proposed-structure). |
| **Q5 — Where can this be authored?** | **Main site and Creator Studio both.** Removes the studio-only restriction on never-ending gates; note the widening that implies. |
| **Q7 — Can a donation goal be lowered?** | **Yes, never raised**, behind a confirmation that says the change cannot be undone. |
| **Q8 — What does "after X time" count from?** | **First publish — `initialPublishedAt`, not `publishedAt`.** A step stores `afterDays` and is evaluated live against that, so nothing is materialized. See [The anchor is `initialPublishedAt`](#the-anchor-is-initialpublishedat). |
| **Q1 — What does "free" cover?** | **The whole gate** — every grant on that entity goes free. The per-generation licensing fee is a separate charge and is untouched. See [What "free" covers](#what-free-covers). |
| **Q2 — Private guarantees?** | **No.** Every guarantee is public. The `visible` column is dropped. |
| **Q10 — Do steps notify?** | **Yes — people who liked the model but have not bought it.** A self-selected audience rather than a broadcast. See [Notifying on a price drop](#notifying-on-a-price-drop). |
| **Q11 — Can a guarantee be broken?** | **No, by anyone.** No moderator override. The weight moves to making sure a creator knows what they are doing when they make one. |
| **Q12 — Does a ladder cover the licensing fee?** | **No.** Paid-access grants only. It would only make sense if the licensing fee itself became a grant kind — a much larger change, noted and out of scope. |
| **Q14 — Refunds on a price drop?** | **No**, as in any store. A drop is not a refund event. |
| **Q16 — May a ladder reach free?** | **Yes — the owner's call.** See [A ladder may reach free](#a-ladder-may-reach-free) for what "free" resolves to. |
| **Q3 — Is the guarantee templatable?** | **Yes** — with an explicit per-model confirmation each time, per the recommendation this accepted. See [Templating a guarantee](#templating-a-guarantee). |
| **Q9 — Does a guarantee transfer with ownership?** | **Yes.** It is attached to the model version, not to a person — which is why it is keyed on the entity. Contrast [Three transfer behaviours](#three-transfer-behaviours). |
| **Q13 — The inert sale items** | **Migrate everything, delete nothing**, with dual-write across the re-key until every consumer is released. |
| **Q15 — A step on a free grant?** | **It has no effect.** A free grant is free; steps are ignored. |
| **Q17 — Who sets a guarantee?** | **The model version owner.** An authorization rule, plus a `createdBy` audit column — *not* a synced `ownerId`. |
| **Q6 — Deepest wins, or compose?** | **Compose.** A price step sets the list price (fixed or percent off the grant); a promotion discounts the result. Settled by the entity split rather than by preference — see [The three layers compose](#the-three-layers-compose). |
| **Substrate** | Price steps get their own table; the promotion tables keep their columns and are re-keyed onto the gate axis — see [Price steps are not promotions](#price-steps-are-not-promotions) and [Promotions belong at the gate level](#promotions-belong-at-the-gate-level). |

## Follow-ups

**Nothing blocking.** Every question this plan originally raised has been answered — see
[Decided](#decided). Three later ones (Q18–Q20) are open on a single axis and are tracked in
[Reopened](#reopened-does-a-window-imply-a-guarantee), not here.

Four things the answers themselves raised. None changes the schema; all four are decisions about
copy, cadence or a resolution rule, and each is written up in the section it belongs to.

### 1. Do not ship the word "free" — [What "free" covers](#what-free-covers)

Q1 scopes the promise to the gate, so a "permanently free" model can still cost Buzz to generate with,
via the licensing fee. That is a naming problem and the fix is the name: **free access**. Otherwise the
footnote is doing work the headline should.

### 2. A ladder reaching zero must resolve to FREE, not to a price of 0 — [A ladder may reach free](#a-ladder-may-reach-free)

Q16 allows it. A `SetTo 0` that resolves to a *price* of zero writes no Buzz ledger row, and the 30-day
refund path reads amounts back from that ledger — so a zero-value purchase is invisible to refunds and
to reporting. The sale path avoids this with a 99% cap and a minimum price; the step path has neither,
so it has to resolve to the free state instead of flooring. **Written that way in this doc** — it is the
one follow-up already decided rather than merely raised.

### 3. Q10 bounds the audience but not the cadence — [Notifying on a price drop](#notifying-on-a-price-drop)

"Liked but has not bought" is a well-chosen audience. A four-rung ladder is still four notifications per
liker per model, and a creator applying a template does that catalogue-wide. Needs a rule before it
ships — every rung, or only the last one, or only the one that reaches free.

### 4. A ladder that reaches free is revocable; a guarantee is not — [A ladder may reach free](#a-ladder-may-reach-free)

After Q16 the two look identical on the model page and are opposites underneath: one is a price the
owner may raise again tomorrow, the other is a promise nobody can break (Q11). The page has to say which
it is looking at, or the guarantee is worth less than it should be — a buyer who cannot tell them apart
discounts both.
## Cheaper than it looks

- **Monthly pricing allowance** — `assertPricingAllowed` counts entities newly priced, one slot each.
  A four-step ladder costs one slot, which is already the right answer.
- **Migration** — every existing gate maps onto the new model mechanically: a timed window is an
  unlock date with no guarantee; a permanent gate is neither. No existing gate becomes guaranteed —
  a guarantee is something a creator opts into, never something a migration invents for them.
- **Storage** — three new tables (grants, price steps, guarantees), one column on the gate. The
  promotion tables keep every column; only their key and name change.
- **A time-varying price in cache** — solved once already for the cliff: `endsAt` is materialized and
  active-ness derived live, so a cached row cannot assert a stale verdict. A ladder needs the same
  treatment for its step boundaries, not a new pattern.

## Relationship to pricing templates

[pricing-templates.md](pricing-templates.md) is **blocked on this**, but narrowly.

**Unaffected** — the `PricingTemplate` table, both targeting axes, ordering and first-match-wins,
conflict detection, and the entire licensing-fee half. That is all of the templates plan's Phase 1.

**Affected** — the template's stored `paidAccess` payload changes shape, so the editor's gate panel
is rework, and the "a timed window can't be applied to a published version" rule may cease to exist
under a guarantee model.

**Templates get more valuable, not less.** A four-step ladder is far more tedious to re-enter per
upload than a single price, and the ask — *"I would go for this for most of my models automatically"*
— is a template described without the word.

Shipping templates first would mean migrating stored template JSON later, which is why the order is
this way round.
