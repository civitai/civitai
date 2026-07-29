# Creator Studio — `/models` scope questions (Justin)

> **How to answer:** reply inline under each **Answer:** line (or drop an `@justin:` comment). Each has a
> **recommended default** — if you're happy with it, just write "default." Full page spec:
> [models.md](models.md); overall progress: [implementation-checklist.md](implementation-checklist.md).
>
> **Context:** the `/models` **licensing-fee** work is done — set/adjust/clear a fee (single + bulk), fractional
> pricing, Creator-Program gating, non-commercial-base-model guard, search/filter/sort/pagination.
>
> Only **two things** on the `/models` spec are still genuinely undecided — everything else is locked in the
> earlier product round + [models.md](models.md). These aren't "should we build it" questions (both are already
> committed *in principle*); they're **narrow scope calls** so we don't over- or under-build v1. (A third item,
> "sell access indefinitely," is separately blocked on backend A4 and not covered here.)

---

## Q1 — Early/paid-access config: which fields make the v1 cut? ✅ ANSWERED — full parity

**What "access-config" is.** The `earlyAccessConfig` blob powers **Early Access** — a creator publishes a *new
version* gated behind payment and/or a time window before it opens to everyone for free. Two monetization levers,
both time-boxed by `timeframe`: **pay-to-download** and **pay-to-generate** (optionally softened by a free-trial
count and/or a community donation goal). It's distinct from the licensing fee (an ongoing per-image charge) — this
is how creators earn on a *fresh drop*. When the window expires, the version becomes free/public automatically.

**Already decided** (models.md, earlier calls): the **full** `earlyAccessConfig` editor lives **in the studio**
(not just a status badge), and it's **open to any owner** (early access isn't member-gated).

**Open piece → now answered:** *which fields ship in the first cut.* **Decision: full parity — all fields**,
matching the main-app upsert form (no "why can't I set X here" gaps against the main app).

| Field | What it does |
|---|---|
| `timeframe` | how many days early access lasts before the version goes public/free |
| `chargeForDownload` + `downloadPrice` | charge buzz to **download** the file during the window (100+ ⚡) |
| `chargeForGeneration` + `generationPrice` | charge buzz to **generate** with the model on-site (50+ ⚡) |
| `generationTrialLimit` | free trial generations before charging kicks in (default 10) — try-before-you-buy |
| `donationGoalEnabled` + `donationGoal` | a community **crowdfund/tip goal** on the version (min/max buzz) |
| `freeGeneration` | allow free generation even while download is paid (mix the two levers) |
| `originalPublishedAt` | bookkeeping — real publish date, kept so the public timeline is correct after EA ends |

**Answer:** ✅ **Full parity** — expose all fields (Justin, 2026-07-10).

> ✅ **Follow-on (write-path) — RESOLVED & built.** Access-config is **not** a plain column write like the
> licensing fee: the main-app path enforces post-publish guards (no adding EA after publish, no raising
> price/timeframe, no changing donation goals), preserves hidden fields like `buzzTransactionId`, and creates a
> `DonationGoal` row on publish. Chosen approach **(a): the studio calls a narrow main-app REST endpoint**
> (`POST /api/v1/model-versions/early-access`), forwarding the shared `.civitai.com` session cookie —
> **merged to main**. The spoke's editor drawer + `setEarlyAccess` action call it; version-level guards and the
> config merge live in the endpoint's service, per-user EA limits in the route.

---

## Q2 — Publish / schedule: v1 or fast-follow?

Publishing a draft version, or setting a future publish date, from the studio. This is the **one** `/models` item
with no clear answer yet: B7 was titled *"Publish/schedule + bulk fee editor — v1 or fast-follow?"*, but your
answer only resolved the **fee-editor** half (bulk = v1). Publish/schedule went unmentioned, and models.md still
tags it "2nd priority to fees."

**Why it's a decision:** publishing **already works on the main app** (the model-version page), and it's a
**management convenience, not monetization** — the studio's v1 focus. So: build a second publish path now, or
fast-follow?

**Recommended default:** **fast-follow** — unless you want the studio to be a complete model-management hub at
launch (in which case it's v1).

**Answer:**

---

## How this affects the build

The access-config editor (Q1) is committed regardless, and it — plus publish/schedule if you take it in v1 —
lives behind a per-version **edit drawer** (linkable `?version=` panel). That drawer is the single remaining UI
addition on `/models`; it also houses sell-indefinitely later, once A4 lands. So the marginal cost of Q2's
publish/schedule is "one more form in a drawer we're building anyway," not a rework.

**Notes / anything else:**
