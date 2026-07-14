# Creator Studio — owner-keyed earnings rollup (build handoff)

> **Status:** **substantially revised 2026-07-14** after a second live ClickHouse audit + Justin's answers to
> D1/D2. The earnings half of this design is **simpler than originally specced**: `/earnings` reads
> `default.buzzTransactions`, which is **already owner-keyed**, so it needs **no dictionary and no CDC**. The
> `modelVersionId → ownerUserId` dictionary survives **only** for the per-model `/analytics` table. Answers
> backend question **A1** in [questions-koen-backend.md](questions-koen-backend.md).

## The problem (unchanged, but narrower than we thought)

Every ClickHouse **usage** aggregate is keyed by `modelVersionId`, never the creator's `userId`. The `userId`
columns that exist (`daily_user_resource`, `userModelDownloads`) are the **generator/downloader**, not the
**creator** who owns the resource. So "creator X's per-model usage" has no direct key, and answering it means
looking up all of a creator's `modelVersionId`s and querying `WHERE modelVersionId IN (…)` — which balloons for
prolific creators.

**What changed:** this was assumed to apply to *earnings* too. It does not. Creators are paid via **buzz
transactions**, and `default.buzzTransactions` is keyed by `toAccountId` — which **is** the creator's `userId`
(verified 1:1, see below). Earnings were never actually missing an owner key; we were reading the wrong table.

## The design — two separate things, only one of which needs a dictionary

### Part 1 — `/earnings` + dashboard: read `default.buzzTransactions` directly. No dictionary.

**Justin's D2 answer (2026-07-14):** *"You'll probably use buzz transactions for all of it, actually, because
they get their money given to them through buzz transactions."* Confirmed against live data — **all five earnings
sources are already in `default.buzzTransactions`, already keyed by the creator.**

| Source | Filter (`toAccountId = <creatorId>` in all cases) |
|---|---|
| Tip | `type = 'tip'` |
| Generation compensation | `type = 'compensation'` |
| License fee | `type = 'licenseFee'` — ⚠️ **currently `'27'`, see the blocker below** |
| Access sale (early access) | `type = 'purchase' AND externalTransactionId LIKE 'early-access-%'` |
| Cosmetic sale | `type = 'sell'` |

Why this works:

- **`toAccountId` is the creator's `userId`, 1:1.** Verified two independent ways: 1,791/1,791 `purchase` rows
  carrying `details.userId` match `toAccountId`; 22,310/22,310 `tip` rows match `toAccountId ∈
  details.targetUserIds`.
- **The table already has an owner-keyed projection.** `PROJECTION byToAccount (SELECT * ORDER BY toAccountId,
  date, fromAccountId, transactionId)`. The base table's `ORDER BY` leads with `date`, so a `toAccountId` filter
  would full-scan — the projection is what makes this a point lookup. **Use it; do not add a new MV until it is
  proven too slow.**
- **`toAccountType` carries the currency** as `LowCardinality(String)`, lowercase: `yellow`, `blue`, `green`,
  `creatorProgramBank`, `cashSettled`, `cashPending`, `club`, `creatorProgramBankGreen`.

**This deletes a large amount of previously-planned work:** no `Model`/`ModelVersion` CDC mirror, no dictionary,
no `AggregatingMergeTree`, no backfill, and **no A1 dependency blocking `/earnings` or the dashboard**. The
launch fallback below is moot for those pages.

#### Gotchas that will bite whoever writes these queries

- **`type = 'purchase'` is NOT "a sale". It is mostly users topping up their own buzz.** Over 90 days:
  `np-deposit-` (NOWPayments top-up) = 39,402 rows / 686M buzz vs `early-access-` = 29,993 rows / 54.8M buzz.
  Those top-ups have `toAccountId` = the buyer, so a naive `toAccountId = X AND type = 'purchase'` **counts a
  creator's own buzz purchases as earnings.** Always filter on the `externalTransactionId` prefix (or
  `details.earlyAccessPurchase` / `details.modelVersionId`).
- **Exclude `accountId = 0`** — that is the system/platform account, not user 0.
- **Cosmetic revenue is `type = 'sell'`, not `'purchase'`.** Cosmetics are two-legged: the buyer's `purchase`
  goes to the bank (`toAccountId: 0`, `externalTransactionId` `cosmetic-purchase-…`), then a separate `sell` leg
  forwards ~70% to `cosmetic.createdById`. The creator-facing row is the `sell`.
- **`details` is a JSON *string*.** Every entity extraction costs a `JSONExtract` at query time. There are no
  `entityType`/`entityId` columns.
- **Amounts here are integers and that is correct.** See "Precision" below.

#### 🔴 Blocker for the license-fee card: `type` is literally `'27'`

`TransactionType.LicenseFee = 27`, but the ClickHouse ingest MV (`buzz.tx_to_staged_mv`) has a hand-written
`caseWithExpression` map that only enumerates `0..26` and falls back to `toString(Type)`. So **every license fee
payout since 2026-05-21 is labelled `'27'`** — 92 rows, growing nightly at 02:00. It is the only numeric type
value in the table's history.

Until fixed, filter `type IN ('licenseFee','27')`, or the license-fee card reads zero. **Justin owns this fix**
(he built the MV chain); the root cause, the verified swap procedure, and the backfill live in his private plan
doc. Do not attempt the MV surgery from this workstream — it has a data-loss failure mode.

### Part 2 — per-model `/analytics`: the dictionary still applies

The dictionary is **still needed** for the per-model usage/earnings table on `/analytics`, which is genuinely
`modelVersionId`-keyed and cannot be answered from `buzzTransactions` (a comp/licenseFee transaction is a daily
per-creator *aggregate*; it does not carry `modelVersionId`).

- **Key:** `modelVersionId` (UInt/Int). **Attribute:** `ownerUserId` (`Model.userId` of the version's parent).
- **Source:** production Postgres (`ModelVersion` joined to `Model`), reached via **CDC / ClickPipe** — CH cannot
  reach the Bastion-gated prod DB directly, and we already run ClickPipes against the Buzz DB, so reuse that
  pattern. CDC-mirror `Model` + `ModelVersion` as `ReplacingMergeTree` and back the dictionary with the mirror.
- **Usage:** `dictGet('mv_owner_dict', 'ownerUserId', modelVersionId)` — O(1), no join.

> ⚠️ **Do not source a dictionary from Postgres directly.** The two existing Postgres-sourced dictionaries
> (`default.model_names`, `default.model_file_sizes`) have **hardcoded IPs**, and `model_names` is **dead in prod
> right now** — `dictGet` on it returns `Connection refused`. A CDC-mirror-backed dictionary has no external
> network dependency at read time. (Also: a dictionary inside an *insert-path* MV turns a dead dict into halted
> ingestion. This one is read-path only, which is safer, but the lesson stands.)

## D1 — the MV key must carry currency → **ANSWERED: yes**

**Justin (2026-07-14):** *"The account type is what we need. That'll allow us to distinguish what's yellow versus
green versus cash versus whatever. And you would use the `toAccountType`."*

Confirmed and adopted. To be precise about why this was a real question rather than a data-availability one: the
currency existing on the row does not help if the aggregate sums it away. Any rollup **must** carry
`toAccountType` in its grouping key, or yellow/green/cash collapse into one meaningless bucket — which would
break **B8** (show earnings in the currency received, **no conversion**).

For the `buzzTransactions` read path this is simply `GROUP BY toAccountId, toAccountType, date, type`. The
composite `(toAccountId, toAccountType)` is the real owner key — one user holds separate per-color balances.

**Two wrinkles worth knowing:**

- **Access sales always credit yellow**, regardless of what the buyer spent. `earlyAccessPurchase`
  (`src/server/services/model-version.service.ts:1777`) omits `toAccountType`, so `buzz.service.ts:652` defaults
  it to `'yellow'`. Buyers may spend green or yellow (blue is rejected). So the currency dimension is constant
  for that source by construction. If that is not intended, it is a bug in the payment path, not in reporting.
- **Comp, license fee, and cosmetic sales all preserve the original color**, so the dimension is meaningful there.

### Currency splits are only trustworthy after 2025-07-15

If any chart splits **historical** earnings by currency, note that `orchestration.resourceCompensations.accountType`
has a label history (this affects `/analytics`, not the `buzzTransactions` read path):

| Era | Labels | Meaning |
|---|---|---|
| 2024-08-01 → 2025-07-14 | `User` | **catch-all: yellow AND blue combined** |
| 2025-07-15 → 2025-08-26 | `User` + `Generation` | split; `User` = yellow, `Generation` = blue |
| 2025-08-26 → now | `Yellow` + `Blue` | rename of the above (one-day cutover) |

So `User`/`Yellow` and `Generation`/`Blue` are the **same currencies renamed**, not double-labelling — verified by
a clean one-day cutover on 2025-08-26 (`User` 25,203→0, `Yellow` 16,308→23,908) with no sustained overlap, and no
creator was double-paid (the per-`accountType` payout suffix postdates the rename by seven weeks; `-User` and
`-Generation` suffixes have zero rows, ever). **But pre-2025-07-15 `User` is not yellow** — it is yellow+blue.
Any all-time by-currency chart overstates yellow and understates blue for that era. Recommend an explicit start
date on currency-split views, or normalize the eras.

## D2 — the `source` filter spans more than this MV → **ANSWERED: use buzz transactions for all of it**

**Justin (2026-07-14):** *"You're not going to be using resource compensations for all of those… things like
access sale, cosmetic sale, those sorts of things… essentially, we will be looking at the buzz transactions, not
resource compensation."*

Adopted — see Part 1 for the canonical filter table. The single canonical `source` label set for `/earnings` is
therefore **derived from `buzzTransactions.type`**, not invented: `tip`, `compensation`, `licenseFee`,
`accessSale` (= `purchase` + `early-access-` prefix), `cosmeticSale` (= `sell`). A1 and A5 now share one
vocabulary because they are **one query against one table** — the union problem this question was about no longer
exists.

**Corrections this forces elsewhere (both now applied):**

- **A5 said access/cosmetic "currently ride the generic purchase type, so we need a distinct type/flag."** Half
  wrong: on the *buyer's* leg both are `purchase`, but on the *creator's receiving* leg — the only side earnings
  cares about — cosmetic is already `sell` and access is `purchase` + a stable `early-access-` prefix. **No new
  type/flag is needed and no schema change is required.** A distinct type would be *cleaner*, not *blocking*.
- **`earnings.md` claimed `resourceCompensations` carries a `tip` source.** It does not — the only real `source`
  values are `compensation`, `compensation_recovered_20260507`, and `licenseFee`. Tips are
  `buzzTransactions.type = 'tip'`.

## Precision — resolved, and the earlier "must NOT FLOOR" note was wrong

**Justin (2026-07-14):** *"The buzz transactions are at settlement point. I believe that the resource
compensations are fractional. We make buzz transactions once a day to settle up, essentially. So those are not
fractional."*

That is the whole answer, and it makes the previous version of this doc's requirement incorrect:

- **`orchestration.resourceCompensations.amount` is `Float64` and fractional** (sub-buzz, e.g. `0.0234`) — that is
  **accrual**.
- **`default.buzzTransactions.amount` is `Int32`** — that is **settlement**. The nightly job
  (`src/server/jobs/deliver-creator-compensation.ts`) sums and floors **once** at the daily boundary, which is
  the A2-specified behavior, not a bug.

So `/earnings` reading integer amounts is **correct** — it reports what the creator was actually paid. Accrued
and paid will differ slightly by design (the sub-buzz remainder is dropped at the daily boundary; the job flags
this in-code as needing finance review). Only a *forecasting* view would want raw fractional accrual.

## Launch fallback (Option B) — now only relevant to `/analytics`

`/earnings` and the dashboard no longer need a fallback; they read `buzzTransactions` today. The per-model
`/analytics` table still does: until the dictionary lands, the app-side `WHERE modelVersionId IN (…)` query is an
acceptable stopgap for **small creators**, with a version-count cap and top-earners hidden.

## ⚠️ Do not `SELECT sum(amount)` over all of `resourceCompensations`

11 rows all-time carry **binary-garbage** `accountType` values, absurd dates (1970-02-05, 2083-11-04) and amounts
up to `2.03e+267` / `-8.32e+290`. The garbage contains length-prefixed fragments (`\x06Yellow`, `\x04Blue`) —
ClickHouse **RowBinary framing misparsed as column data**, i.e. the orchestrator sent a malformed batch and row
boundaries desynced. The nightly payout job is safe (it filters to yesterday), but **any all-time `sum(amount)`
on this table is meaningless** — one row swamps everything. Filter `match(accountType,'^[A-Za-z]+$')` and/or a
sane amount bound. Reported upstream separately; the table is written by the external .NET orchestrator (nothing
in this repo inserts into it).

## Build-confirm checklist

**For Part 1 (`/earnings`, dashboard) — mostly unblocked, build now:**

- [ ] Confirm the `byToAccount` projection actually serves the query plan (`EXPLAIN indexes=1`) for a
      `toAccountId = X AND date BETWEEN …` read. If yes, **no MV is needed at all** for v1.
- [ ] Filter `type IN ('licenseFee','27')` until Justin's ingest fix + backfill lands, then drop the `'27'`.
- [ ] Exclude `accountId = 0`; isolate access sales by `externalTransactionId LIKE 'early-access-%'`.
- [ ] Decide whether the dashboard's "top-earning models" is answerable at all from `buzzTransactions` — it is
      **not** (comp/licenseFee rows are per-creator daily aggregates with no `modelVersionId`). That tile depends
      on Part 2, or on `resourceCompensations` + the `IN (…)` fallback.

**For Part 2 (`/analytics` per-model table) — still needs Koen:**

- [ ] **CDC/ClickPipe path** — clone the Buzz-DB ClickPipe for prod `Model` + `ModelVersion` (Bastion/networking
      OK? CDC enabled?). Mirror **full tables, or just** `ModelVersion.id/modelId` + `Model.id/userId`?
- [ ] **Dictionary refresh + staleness** — CDC-mirror `ReplacingMergeTree` backing (**not** direct Postgres, see
      warning above). On ownership transfer / version delete, we attribute *historical* earnings to the
      **current** owner and drop rows whose `modelVersionId` isn't in the dict — OK?
- [ ] **Layout** — `ownerUserId` UInt32, `source` LowCardinality, ordering key, `PARTITION BY toYYYYMM(date)`,
      TTL (likely none — financial history).
- [ ] **Corrupt-row filter** must be in any MV sourced from `resourceCompensations` (see warning above).

## References

- Backend question this answers: [questions-koen-backend.md](questions-koen-backend.md) §A1 (and it substantially
  narrows **A5**).
- Related product calls: B3 (which earnings sources ship v1 — all five are now cheap), A5 (access/cosmetic —
  needs no new MV), A2 (fractional fee), B8 (currency, no conversion).
- Audit basis: live ClickHouse audits 2026-07-14 (schema, type distribution, label history, payout verification).
