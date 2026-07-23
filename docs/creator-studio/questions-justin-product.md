# Creator Studio — product / business questions (Justin)

> **How to answer:** reply inline under each **Answer:** line (or drop an `@justin:` comment). Each question has
> a **recommended default** — if you're happy with it, just write "default" and I'll run with it. Full context
> lives in [pre-implementation-decisions.md §B](pre-implementation-decisions.md#b-product--business--justin);
> the IDs (B1–B11) map back to it.
>
> **TL;DR:** the Studio shell is up and I'm about to build `/models`. The top four (B1–B4) genuinely gate the
> feature work; the rest have safe defaults and just need a thumbs-up.
>
> **@justin (2026-07-09):** Heads-up — most of these were already answered in an earlier round; the answers
> below are the locked calls. The public `pre-implementation-decisions.md` is stale relative to those, which is
> why several resurfaced here. Please reconcile that doc so this doesn't repeat.

---

## The four that gate the build

### B1 — The member gate ⭐ (most impactful)

Is "member" an **active subscription tier** (bronze/silver/gold) or **full Creator Program membership** (tier +
creator score ≥40k)? You've said fee-setting = **tier**, and you scoped indefinite-sale to **CP members** — so
I've built the gate as **feature-specific**:
- **licensing fee** → active subscription `tier`
- **sell indefinitely** → Creator Program membership

**Why it matters.** Drives gating on `/models`, `/licensing`, `/settings`, and all the `/join` upsell copy
("subscribe to a plan" vs "join the Creator Program").

**Recommended default:** the feature-specific split above.

**Answer:** **Full Creator Program membership gates ALL actions** (fee-set *and* sell-indefinitely) — a single
bar, not the feature-specific tier/CP split. Reason: a tier-only gate lets a brand-new account subscribe at
bronze and slap licensing fees on a pile of other people's models; CP membership requires creator score, which
keeps a quality bar on top of pay-to-play. This was already locked in the earlier round.

> ⚠️ **Build fix needed:** the scaffold currently ships the split we're dropping —
> `apps/creator-studio/src/lib/server/membership.ts:24-25` gates `canSetLicensingFee` on `m.isMember`
> (subscription tier). Change it to gate on Creator Program membership (`isCreatorProgramMember`) so both
> actions share the single CP bar.

---

### B2 — Indefinite-sale mechanics

How does "available for sale indefinitely" actually work? It's new and underspecified, and needs main-app
backend (A4 on Koen's list) before the control is real.

- One-time purchase at a **creator-set price**?
- How does it relate to early-access pricing — **replaces / stacks / separate**?
- Any quantity or per-buyer limits, or truly unlimited?

**Recommended default:** _none — need your definition before I build the control._

**Answer:** It's **early access with no time limit** — reuse the existing early-access system (which already lets
creators charge to download and/or generate with a model), just uncapped in time. Not a new purchase mechanic.
See A4 for the backend representation.

---

### B3 — Which earnings sources ship in v1

`comp / license fee / tip` are available today. **Access-sale + cosmetic-sale** earnings need a new buzz rollup
from Koen (A5).

Show **all** sources in v1, or ship **comp / license / tip only** and add access/cosmetic as fast-follow?

**Recommended default:** comp / license / tip in v1; access + cosmetic fast-follow.

**Answer:** Show **all** sources in v1, including access-sale + cosmetic-sale (needs the A5 MV). One wrinkle:
cosmetic sales and early access both currently ride the generic "purchase" transaction type, which makes them
hard to isolate — talk to Koen about a distinct type/flag so these sales are cleanly identifiable for the rollup.
Comp + licenses can share a chart; add a source filter.

---

### B4 — "Basic analytics" scope

Lock the v1 metric list so it doesn't balloon (richer analytics — cohorts, per-model funnels — is post-v1).

Proposed v1: **generations-over-time**, **downloads-over-time**, a **top-models table**, and a few **stat
tiles** (total generations / downloads / engagement for the range).

**Recommended default:** the four above.

**Answer:** Two sections in the dashboard:

**(a) Model section** — the proposed list, plus the refinements from Alex DS9's feedback: weekly granularity
option, generations **split by buzz color** (blue / yellow / green), earnings **week-over-week** delta, per-model
earnings for the **last 1–2 weeks**, and a **cost-to-generate reference** (avg buzz cost/image by base-model +
model type) so creators can price.

**(b) NEW Content/Creator section** — for creators who are content-focused rather than model-focused. These are
all already tracked in ClickHouse and directly keyed to the creator's `userId` (no owner-join needed), verified
live 2026-07-09:
- **Reactions received over time** (`reactions` by `ownerId` + date) — the single highest-value content chart
- **Followers / new followers over time** (`userEngagements`, `targetUserId`)
- **Images & posts published over time** (`images_created` / `posts` by `userId`)
- **Profile views over time** (`views` / `uniqueViewsDaily` where `entityType='User'`)
- **Top content by reactions** table (`image_metrics` for the creator's `userId`)
- **Stat tiles** — total reaction score, images posted, models published, comments received (all-time MVs)

Implementation note: the all-time SummingMergeTree MVs have no date dimension (fine for stat tiles, useless for
trends). Trend charts should query the raw event tables (`reactions`, `userEngagements`, `posts`,
`images_created`, `views`/`daily_views`); the clean build is new owner-keyed daily SummingMergeTree MVs mirroring
the existing entity-keyed `daily_*` ones.

---

## Quicker calls (defaults are fine unless you say otherwise)

### B5 — Fee auto-pause → notify the creator?

When a fee silently pauses because membership lapsed, do we notify the creator (in-app / email) in v1? A silent
pause = lost income = support tickets.

**Recommended default:** no notification in v1; surface the paused state prominently in-Studio. Revisit if
support load appears.

**Answer:** **Notify — both email and in-app** (overrides the default). In-app: a simple "you have models that
have lost their licensing fee." Email: list the **top models** that lost the fee, capped at **10** + "and N
more." A silent pause is lost income, and we want people keeping their membership active so these stay in place.

---

### B6 — Max licensing fee

Floor is 0.01 buzz/image (confirmed). Is the **cap** still 100 buzz/image (`MAX_LICENSING_FEE`) with fractional
pricing, or does it change?

**Recommended default:** keep the 100 cap.

**Answer:** Keep the **100** buzz/image cap.

---

### B7 — Publish/schedule + bulk fee editor — v1 or fast-follow?

Both were flagged "2nd priority" / "may trail" the per-version fee editor.

**Recommended default:** per-version fee first; publish/schedule + bulk editor fast-follow if time-boxed.

**Answer:** **Bulk fee editing is v1, not fast-follow** — it was the whole point of this tool. Per-version
editing already exists on the model page and is a pain; making creators do it one-by-one here adds nothing over
what they can already do. (Bulk ops get a confirm-before-continue step; an audit log of changes is nice-to-have,
no undo.)

---

### B8 — Currency display

Buzz-only in v1, or show USD equivalents for cash earnings (dashboard / earnings)?

**Recommended default:** buzz-only in v1.

**Answer:** Show earnings in **whichever currency they were actually received** — buzz for the vast majority,
cash only for the few earning cash (≈1 creator on licensing fee today; treat as the exception). **No
conversion/mapping** — there's no rate, so a creator's chart shows USD if that's what they earned, buzz
otherwise. This was answered in the earlier round.

---

### B9 — Default fee suggestions

Confirm the values and which model types get one. Proposed: **LoRA ~0.1**, **base model ~1** buzz/image.

**Recommended default:** the values above; suggest for LoRA + checkpoint/base, none for others (confirm).

**Answer:** **No default fee** — fees stay off unless a creator turns one on. When they do, seed the input with
**LoRA ~0.1** and **base/checkpoint ~1** buzz/image; no suggestion for other model types.

---

### B10 — Studio discoverability

How do creators find `creator.civitai.com` — a main-app nav link for **everyone**, only users **with models**,
or a **launch announcement**? Shapes the non-member / `/join` experience. (Not a v1-build blocker, but needed
before launch.)

**Recommended default:** _your call — no engineering dependency, just need direction before launch._

**Answer:** A **Creator Studio nav item in the main-app user dropdown** + an on-site **launch announcement**,
plus a notice on the Buzz dashboard (where banking already lives). Answered in the earlier round.

---

### B11 — Cutover creator comms / grandfathering

When 25% comp retires (~1 week after v1 ships), what's the creator-facing story, and is there any grandfathering
/ transition for creators mid-accrual? (Part of the separate cutover track, not this app's v1 — flagging so it's
not forgotten.)

**Answer:** **Straight cutover, no grandfathering.** The story is that we're giving creators control — you set
the price. Comp **already accrued up to the cutoff is settled, not clawed back**; there's just no new comp after.
Comms are covered by the Creator Economy Update article
([32087](https://civitai.com/articles/32087/creator-economy-update-2026-you-set-the-price-now)). Answered
earlier.

---

### Anything else?

If I've mis-scoped something or you want a capability in v1 that isn't listed, add it here:

**Notes:** Most of B1–B11 were already answered in the earlier product round — please treat the public
`pre-implementation-decisions.md` as stale where it disagrees with the answers above and reconcile it. The one
concrete build gap to fix from that drift is the B1 member gate (see the ⚠️ note under B1).
