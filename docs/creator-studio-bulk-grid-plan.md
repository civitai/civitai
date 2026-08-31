# Creator Studio — bulk monetization grid

Status: proposal, nothing implemented.
Goal: **make it easy for a power user to bulk manage licensing fees and paid access across their catalog.**

## Decision: editable grid, not CSV round-trip

@dev: an inline table can naturally cap values, show tooltips, and disable cells — a CSV can't.

Agreed, and the deciding argument is the one that kills the CSV on its own terms: **if we export every column we
must import every column**, and a self-describing CSV needs roughly 19 of them —

- ~8 editable: `usageControl`, fee buzz + denominator, access price, generation price, free generation,
  trial limit, timeframe/permanent
- ~6 identity: versionId, model, version, baseModel, modelType, status
- ~5 hints: fee cap, suggested fee, access-price cap, permanent slots left, and _why_ the cap is that value
  (image vs video)

Five of those are read-only decoration **in a format with no concept of read-only**, and the caps are
per-row — a video checkpoint and an image LoRA have different ceilings, so `feeCap` can't live in a header.
You would ship a spreadsheet that needs a legend, then validate that nobody edited the legend.

The structural reason the grid wins: **a disabled cell makes an invalid state unreachable; a CSV cell can
only make it detectable** — after upload, as a row error the creator must map back to a model.
`freeGeneration = true` alongside `generationPrice = 200` is a contradiction a form prevents and a CSV can
only report. That is the same principle as Phase 3 of [monetization-cap-api-plan.md](./monetization-cap-api-plan.md):
make the wrong thing unrepresentable.

**The CSV stays, narrowed and symmetric.** It remains a licensing-fee tool — export fee, import fee, in and
out matching. Fee is the one field that is genuinely row-independent, and `bulkSetLicensingFeeVaried` already
handles varied per-row values at scale. Everything multi-field belongs to the grid.

## Scale — measured, not assumed

@dev: "a power user will have hundreds of models… pull in all their models and not worry about pagination."

Actual distribution of non-deleted versions per creator:

| Creators with… | Count      |
| -------------- | ---------- |
| > 100 versions | 1,657      |
| > 500 versions | 259        |
| > 2,000        | 30         |
| **max**        | **15,342** |
| p99            | 191        |

So "no pagination" is right for the overwhelming majority (p99 is 191 rows) but the tail reaches 15k. That
rules out rendering every row, and rules **in** loading every row:

- **Load all rows, render a window.** One query, no pagination, virtualized rendering. At ~120 bytes/row a
  15k-version payload is ~1.8 MB uncompressed — acceptable once, on an explicit "bulk edit" entry, not on
  every page view.
- **Keep the paginated view as the default.** The grid is a mode you enter, not the landing state. Today's
  page (20/50/100) stays the browse/scan surface.

## Shape

### Entry

Bulk edit is a mode toggle on `/models`, carried in the URL (`?bulk=grid`) so it survives reload and shares
the existing filter state. Entering it swaps the paginated card list for the grid and switches the loader to
the unpaginated query.

### Columns

| Column               | Editable | Notes                                                            |
| -------------------- | -------- | ---------------------------------------------------------------- |
| Model / Version      | no       | sticky left, links out                                           |
| Base model, Type     | no       | drives the row's caps; shown because it explains them            |
| Status               | no       | Draft rows can't take early access                               |
| Usage control        | **yes**  | select — Download / Generation; hidden for moderator-only values |
| Licensing fee        | **yes**  | buzz + denominator, `max` = this row's cap                       |
| Access price         | **yes**  | `max` = this row's cap; label changes for gen-only               |
| Generation price     | **yes**  | disabled when free generation is on                              |
| Free generation      | **yes**  | checkbox; disables generation price + trial limit                |
| Trial limit          | **yes**  | disabled unless there's a paid generation tier                   |
| Duration / Permanent | **yes**  | permanent is count-capped — see Save semantics                   |

Caps are per row (`tier × modelType × mediaType`), so each row derives its own from `monetizationLimits`
once that exists — or from the same helpers `PaidAccessEditor` uses today.

### Save semantics

**Explicit save, not per-cell autosave.** Edits mark rows dirty; one "Save N changes" commits. Autosave over
hundreds of rows means hundreds of writes and no way to review before committing money-affecting changes.

Two rules that fall out of the existing code and must survive here:

- **Increase-only cap checks.** The grid resubmits stored values for untouched fields, so a hard clamp would
  make an over-cap row unsavable (`82f64846ba`). Only raises are rejected — per row, per component.
- **Permanent access is count-capped, so rows are _not_ independent.** Free tier allows 3. A grid marking 50
  rows permanent must reject the batch up front against remaining slots, not partially succeed. This is the
  one field where a bulk edit cannot be modelled as N independent row writes.

Failed rows stay dirty and marked, rather than the whole save rolling back — a creator editing 200 rows
should not lose 199 good edits to one bad one.

### Reuse

Most of the pieces exist:

| Need                  | Already have                                                    |
| --------------------- | --------------------------------------------------------------- |
| Per-version cap logic | `PaidAccessEditor` derives per-version caps from `capMediaType` |
| Number input + max    | `NumberInput`                                                   |
| Apply-to-selection    | `PaidAccessBulkBar`, `BulkLicensingFeesBar`                     |
| Varied per-row write  | `bulkSetLicensingFeeVaried`                                     |
| Usage-control write   | `setUsageControl` + `?/setUsageControl`                         |
| Cache invalidation    | `bustVersionCache` → `/api/v1/model-versions/bust-cache`        |

What is genuinely new: the virtualized table, dirty-row tracking, and a batched multi-field write action.

## Phases

**Phase 1 — read-only grid.** All rows loaded, virtualized, every column rendered read-only, with the
existing filters. Ships the "see my whole catalog at once" value on its own and de-risks the loading and
virtualization work before any write path exists. Also answers whether auditing was the real need.

**Phase 2 — editable licensing fee.** One editable column, dirty tracking, batched save through the existing
varied-fee write. Smallest possible proof of the edit loop.

**Phase 3 — editable usage control + access pricing.** The interdependent fields, with disabled-cell rules.
Needs the batched multi-field action and the permanent-count pre-check.

**Phase 4 — retire the fee CSV import** if grid adoption makes it redundant. Keep export.

## Open questions

@ai: Is the real pain **auditing** ("which of my 200 versions are over cap?") or **varied bulk editing**? If
auditing, Phase 1 alone may close it and Phases 2–3 can wait. Worth asking a power user before building the
edit loop.

@ai: Should "select all" in the grid mean all _loaded_ rows or all _filtered_ rows? Today's `bulkFeeCap`
already has to reason about versions beyond the current page; loading everything makes them the same thing,
which is a simplification worth taking deliberately.

@ai: Does the grid need to show versions the creator can't monetize at all (non-commercial base models,
moderator-only usage controls)? Hiding them is cleaner; showing them greyed explains why a model is absent.

## Risks

- **15k rows is a real payload.** Needs measuring against the actual query before committing — the current
  loader joins model + paid-access + fee data per version.
- **Row count × editable columns.** 10 columns of live inputs over a virtualized list means input state must
  live outside the rendered nodes, or values will detach as rows recycle.
- **Money-affecting bulk writes need a confirmation step** showing what changes and for how many versions.
