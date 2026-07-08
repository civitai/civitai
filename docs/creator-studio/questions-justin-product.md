# Creator Studio — product / business questions (Justin)

> **How to answer:** reply inline under each **Answer:** line (or drop an `@justin:` comment). Each question has
> a **recommended default** — if you're happy with it, just write "default" and I'll run with it. Full context
> lives in [pre-implementation-decisions.md §B](pre-implementation-decisions.md#b-product--business--justin);
> the IDs (B1–B11) map back to it.
>
> **TL;DR:** the Studio shell is up and I'm about to build `/models`. The top four (B1–B4) genuinely gate the
> feature work; the rest have safe defaults and just need a thumbs-up.

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

**Answer:**

---

### B2 — Indefinite-sale mechanics

How does "available for sale indefinitely" actually work? It's new and underspecified, and needs main-app
backend (A4 on Koen's list) before the control is real.

- One-time purchase at a **creator-set price**?
- How does it relate to early-access pricing — **replaces / stacks / separate**?
- Any quantity or per-buyer limits, or truly unlimited?

**Recommended default:** _none — need your definition before I build the control._

**Answer:**

---

### B3 — Which earnings sources ship in v1

`comp / license fee / tip` are available today. **Access-sale + cosmetic-sale** earnings need a new buzz rollup
from Koen (A5).

Show **all** sources in v1, or ship **comp / license / tip only** and add access/cosmetic as fast-follow?

**Recommended default:** comp / license / tip in v1; access + cosmetic fast-follow.

**Answer:**

---

### B4 — "Basic analytics" scope

Lock the v1 metric list so it doesn't balloon (richer analytics — cohorts, per-model funnels — is post-v1).

Proposed v1: **generations-over-time**, **downloads-over-time**, a **top-models table**, and a few **stat
tiles** (total generations / downloads / engagement for the range).

**Recommended default:** the four above.

**Answer:**

---

## Quicker calls (defaults are fine unless you say otherwise)

### B5 — Fee auto-pause → notify the creator?

When a fee silently pauses because membership lapsed, do we notify the creator (in-app / email) in v1? A silent
pause = lost income = support tickets.

**Recommended default:** no notification in v1; surface the paused state prominently in-Studio. Revisit if
support load appears.

**Answer:**

---

### B6 — Max licensing fee

Floor is 0.01 buzz/image (confirmed). Is the **cap** still 100 buzz/image (`MAX_LICENSING_FEE`) with fractional
pricing, or does it change?

**Recommended default:** keep the 100 cap.

**Answer:**

---

### B7 — Publish/schedule + bulk fee editor — v1 or fast-follow?

Both were flagged "2nd priority" / "may trail" the per-version fee editor.

**Recommended default:** per-version fee first; publish/schedule + bulk editor fast-follow if time-boxed.

**Answer:**

---

### B8 — Currency display

Buzz-only in v1, or show USD equivalents for cash earnings (dashboard / earnings)?

**Recommended default:** buzz-only in v1.

**Answer:**

---

### B9 — Default fee suggestions

Confirm the values and which model types get one. Proposed: **LoRA ~0.1**, **base model ~1** buzz/image.

**Recommended default:** the values above; suggest for LoRA + checkpoint/base, none for others (confirm).

**Answer:**

---

### B10 — Studio discoverability

How do creators find `creator.civitai.com` — a main-app nav link for **everyone**, only users **with models**,
or a **launch announcement**? Shapes the non-member / `/join` experience. (Not a v1-build blocker, but needed
before launch.)

**Recommended default:** _your call — no engineering dependency, just need direction before launch._

**Answer:**

---

### B11 — Cutover creator comms / grandfathering

When 25% comp retires (~1 week after v1 ships), what's the creator-facing story, and is there any grandfathering
/ transition for creators mid-accrual? (Part of the separate cutover track, not this app's v1 — flagging so it's
not forgotten.)

**Answer:**

---

### Anything else?

If I've mis-scoped something or you want a capability in v1 that isn't listed, add it here:

**Notes:**
