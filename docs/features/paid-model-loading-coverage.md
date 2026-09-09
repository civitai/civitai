# Paid Model Loading — coverage, and what has to change

What decides whether a model can be generated with, what decides whether it can be *loaded*, and the
audit of the gap between them. Every number here was measured against production on 2026-09-08 and
the query that produced it is described, so it can be re-run rather than trusted.

Companion to [paid-model-loading.md](paid-model-loading.md) (the contract),
[paid-model-loading-build-plan.md](paid-model-loading-build-plan.md) (the inventory),
[paid-model-loading-checklist.md](paid-model-loading-checklist.md) (the state) and
[paid-model-loading-decisions.md](paid-model-loading-decisions.md) (open decisions).

---

## The model, decided 2026-09-08

Justin's framing, which the audit below tests and supports:

- **`EcosystemCheckpoints`** is the list of models the orchestrator should support **by default** —
  the generator's default model for each ecosystem.
- **`GenerationBaseModel`** is the list of base models where the orchestrator has extended
  checkpoint/diffuser support, i.e. where **community** models can be run.
- **Both populations go through the model-loading system.**
- **File-less models — external API coverage — never touch the loader.** There is nothing to
  download.
- **Every other checkpoint requires a correct model file to use the loader.**

🔴 **"File-less" must mean "has no *loadable* file", not "has no file row."** 36 of the 125
`EcosystemCheckpoints` are external API models carrying a single `Training Data` archive. Keyed on
"has any file", every one of them reads as loadable, and the site would sell a load for a model with
no weights — a guaranteed failure, and a refund once pricing exists. See
[the 36](#the-36-mislabelled-api-models).

### Coverage becomes three branches

1. **No loadable file** → covered, never offered a load. External/API generation.
2. **In `EcosystemCheckpoints` with a loadable file** → covered; the orchestrator should carry it by
   default.
3. **Checkpoint on a `GenerationBaseModel` base model**, licensed, scanned, `baseModelType =
   'Standard'`, with a loadable file → covered, loadable on demand. This is the population
   `CoveredCheckpoint` gates today.

The existing LORA / TextualInversion / VAE / LoCon / DoRA / Upscaler branch is unchanged.

The load CTA fires only for branches 2 and 3, and only when the resource is not resident. Never for
branch 1.

---

## The two tables do opposite jobs

This is the thing an earlier reading of these docs got wrong, and it inverted a plan.

| Table | Rows | What it is |
| --- | --- | --- |
| `CoveredCheckpoint` | 514 rows | Auction-won community checkpoints — a **residency proxy**. Written and pruned weekly by `handle-auctions.ts`. **This is what paid loading replaces.** (638 versions are covered *as checkpoints* — the rest come from `EcosystemCheckpoints`.) |
| `EcosystemCheckpoints` | 125 | The generator's **default model per ecosystem**. **62 of the 63 checkpoint defaults are covered through it — and zero through `CoveredCheckpoint`.** Not a loophole; the registry that keeps the generator working. |

Dropping `CoveredCheckpoint` is the feature. Dropping `EcosystemCheckpoints` would remove the
default model from half the ecosystems the generator supports — see
[the defaults audit](#the-defaults-audit).

`CoveredCheckpoint` has exactly four uses, all generation:

- the `GenerationCoverage` view
- `handle-auctions.ts` — inserts winners, deletes everything outside the weekly set
- `toggleCheckpointCoverage` — a moderator tRPC tool
- `getCheckpointGenerationCoverage` — **zero callers; dead code**

So it can go, and nothing outside generation notices.

---

## What changes, in numbers

Both views counted in the same query, 2026-09-08, so these reconcile:

| | `GenerationCoverage` | `GenerationCoverageNext` |
| --- | --- | --- |
| Covered **checkpoints** | 638 | **33,796** |
| Covered rows, all types | 899,553 | 933,386 |

**+33,158 checkpoints, +33,833 rows.** The two deltas differ because dropping `Diffusers` from the
excluded formats helps every type, not only checkpoints — about 675 of the added rows are LoRAs and
friends.

⚠️ **514 is not the number of covered checkpoints.** It is the row count of `CoveredCheckpoint`, the
auction's list; 638 versions are covered as checkpoints today because `EcosystemCheckpoints` also
contributes. Earlier drafts of these docs used 514 for both, which is what made the headline figures
fail to add up.

155 published, licensed, standard checkpoints on supported base models were blocked **only** by file
format: 132 Diffusers, 21 Core ML, 2 ONNX. Diffusers is loadable (Justin, 2026-09-08); Core ML and
ONNX are inference-runtime formats rather than servable weights and stay excluded.

### The loader population, split by bucket

| | `EcosystemCheckpoints` | Community checkpoints |
| --- | --- | --- |
| Total | 125 | 33,792 |
| **A** — no loadable file → never loaded | 51 (15 with no file at all + 36 training-data-only) | 123 |
| **B** — has a loadable file → goes through the loader | **74** | **33,669** |

≈ **33,743 loadable checkpoints**, against 514 covered by auction today.

---

## The licence gate

**Zero covered versions lack `RentCivit`.** Verified two ways: branch by branch, and end-to-end
against the view (`899,068` covered rows, `0` without the licence).

The view has two branches that do not check the licence — `EcosystemCheckpoints` membership and
`usageControl = 'ExternalGeneration'` — but nothing is currently using them to escape it. All 143
versions covered via those branches hold `RentCivit` anyway.

**Consequence:** "refuse when `RentCivit` is false" and "refuse when not in `GenerationCoverage`"
select the same set today. Gate on **coverage**, because it stays correct if a version later does
use a bypass, and because it inherits the licence rule instead of keeping a second opinion of it.

---

## The defaults audit

`basemodel.constants.ts` declares generation support; `ecosystemSettings[].defaults.model.id` names
the default model per ecosystem. Run against the real exports (via `tsx`), not by grepping:

- **105** base model records; **90** ecosystems; **60** base models with generation support
- **64** ecosystem default model versions — **all 64 covered today**
- **63** of them are checkpoints; **62** are covered via `EcosystemCheckpoints`, **0** via
  `CoveredCheckpoint`

### What a naive unification would have cost

Evaluated against the main path with `CoveredCheckpoint` dropped, Diffusers allowed and **no**
`EcosystemCheckpoints` branch: **33 of the 64 defaults lose coverage.** Nine have no file at all
(Flux3Video, HappyHorse, MAI, MuseImage, Qwen3, Reve, Seedream, Veo3, WanVideo30 — all
`ExternalGeneration`); the rest fail on base model and/or file type.

That is why branch 1 and branch 2 both have to exist.

### `basemodel.constants.ts` ↔ `GenerationBaseModel` disagree

**17 base models declare generation support in the constants but have no `GenerationBaseModel` row:**

> ACE Audio, Flux.1 Kontext, Grok, HappyHorse, HiDream-O1, Lens, MAI, MageFlow, MiniMax Music 3,
> Qwen 2, Reve, Upscaler, Wan Image 2.7, Wan Video 2.5 I2V, Wan Video 2.5 T2V, Wan Video 2.7,
> Wan Video 3.0

**5 go the other way** — in the table, not declared in the constants: Nano Banana, SDXL 0.9,
SDXL 1.0 LCM, Wan Video, Wan Video 1.3B t2v.

Those 17 line up with the failing defaults above: **those ecosystems work today only because
`EcosystemCheckpoints` covers their default model.** The base-model allowlist never learned about
them, and nothing surfaced the inconsistency because the other table was quietly compensating.

This is a real inconsistency independent of paid loading. It has no owner —
[decisions 2.6](paid-model-loading-decisions.md#26-the-17-base-model-gap-between-the-constants-and-generationbasemodel).

---

## What stays out of scope

**1,676 published checkpoints across 43 base models have no `GenerationBaseModel` row**, so they are
not loadable under the rule above. Decided (Justin, 2026-09-08): loading supports only base models in
`GenerationBaseModel`. They fall into four groups that want different messages, not different rules:

| Group | Versions | Why not |
| --- | --- | --- |
| `Other` — the catch-all | 785 | Architecture unknown |
| Legacy SD 2.x (2.1 768, 2.1, 2.0, 2.0 768, Unclip) | 537 | Deliberately retired |
| API-only (Veo 3, Sora 2, Kling, Seedance, Seedream, Imagen4, OpenAI, Vidu Q1, Grok, Ideogram 4.0, Reve, MAI, Wan 2.5/2.7/3.0, MiniMax Music 3) | ~35 | Nothing to load, ever |
| Open architectures the generator does not support yet (PixArt E 95, Lumina 39, Flux.1 Kontext 26, Kolors 19, ACE Audio 10, HiDream-O1 8, AuraFlow 7, Hunyuan 1 7, Mochi 5, MageFlow 5, Qwen 2 4, …) | ~240 | The generator cannot run the architecture |

Every one would fail at generation time even if loaded perfectly, so the gate is right. ⚠️ But all
four currently produce the same silence in the UI. "We don't support this architecture yet" is a
roadmap answer, "this is API-only" is permanent, and `Other` means the upload is missing metadata —
worth distinguishing whenever a load CTA appears on a model page.

---

## The 36 mislabelled API models

36 `EcosystemCheckpoints` versions are external API models whose **only** file is type
`Training Data`, format `Other`, scanned, with `usageControl = 'Generation'`.

They are FLUX, Flux.1 Kontext, Flux.2, Grok Imagine, Google Imagen 4, Kling Video, Nano Banana,
ChatGPT Images / GPT-image-1, Qwen Image (API), Seedance, Seedream, Sora 2, Vidu Video and
Wan 2.2 / 2.5 / 2.7 — several carrying "(API)" in the model name. **17 are ecosystem defaults.**

All 36 are `Published`, none is POI, none is private, and **all 36 are covered and in use in the
generator today**.

**Decided (Justin, 2026-09-08): set their `usageControl` to `ExternalGeneration`,** which is what
they are. The codebase already treats that value as "intentionally file-less, routed via external
engines" — `ModelVersionList` stops reporting them as missing files, the upload step is skipped in
the wizard, and `reset-to-draft-without-requirements` excludes them. Today those 36 lie to all three.

Verified safe: the `ExternalGeneration` branch of the view requires published and not-POI, and all 36
satisfy both, so **coverage is preserved for 36 of 36**.

Notes for whoever runs it:

- `model-version.controller.ts` refuses `ExternalGeneration` from non-moderators, so this is a direct
  DB write or a moderator action — not creator-serviceable.
- The `Training Data` files stay attached. Harmless for coverage, and the new rule ignores them
  because they are not loadable files. Whether an API model should carry one is a separate question.
- After this, "no loadable file" and `ExternalGeneration` nearly coincide (51 file-less ecosystem
  checkpoints: 15 already flagged, 36 newly). **Keep the loader gated on "no loadable file" anyway** —
  it fails safe, so a future mislabelled model gets no CTA rather than an undeliverable load.

---

## `covered` is not `canGenerate`

The database view and `basemodel.constants.ts` answer different questions, and both are needed.
Only the database knows licence, scan state, status and POI. Only the constants know which **model
types** an ecosystem supports for generation — the view's type branch is one flat list
(`LORA, TextualInversion, VAE, LoCon, DoRA`) applied to every base model.

Measured 2026-09-08: **736 versions across 33 (baseModel, type) pairs** are covered by the view and
excluded by the constants — Wan Video + LORA (337), Flux.1 D + DoRA (102) / LoCon (76) / VAE (7) /
TextualInversion (3), LTXV + LORA (67), and 28 smaller pairs on Flux.2, Krea 2, ZImage and Qwen.

Nothing was broken by this, because all three consumers composed the pair correctly — but each did
so **by hand**: the models search index (twice), `model.service`, and the batch resolver in
`generation.service`. A fourth consumer reading `covered` alone would offer those 736 a paid load,
for a resource search already hides and the orchestrator cannot generate with.

**Resolved 2026-09-08.** The pair is composed once, in
`isGenerationEligible` (`packages/civitai-shared/src/generation-eligibility.ts`), and all four call
sites go through it. `no-divergent-can-generate-derivation` keeps
`isBaseModelGenerationSupported` out of `src/` entirely, with an empty allowlist that fails if it
grows — the same shape as `no-divergent-paid-gate-derivation`, written after the paid badge was
copied four times.

🔴 **The paid-loading CTA gates on `isGenerationEligible`, never on `covered`.**

A longer-term fix would remove the divergence rather than compose around it: derive per-ecosystem
type support into the database so the view's coarse type branch disappears. Bigger than this
feature needs; worth filing.

## The `covered` readers audit

23 files read `GenerationCoverage` / `generationCoverage.covered`. Classified below by what changes
when `covered` stops implying *resident*. The generation gate was read closely; the rest are
identified and grouped, not yet read line by line.

### 🔴 A — the generation gate. Read this before scheduling the swap.

`canGenerate` in [generation.service.ts](../../src/server/services/generation/generation.service.ts)
is `(resource.covered || explicitCoveredModelVersionIds.includes(id)) && !isUnavailable`, and an
uncovered resource is routed through `getResourceDataSubstitutes`. `resource-data.redis.ts` carries
`covered` into the generation resource cache and refuses to cache anything uncovered.

So the swap makes tens of thousands more versions generatable ([the numbers](#what-changes-in-numbers)),
and for a non-resident checkpoint the
orchestrator starts the download **implicitly, on submit**.

🔴 **That is free, uncapped model loading at the scale of the whole checkpoint catalogue.**
`CalculateCost` returns zero, and the C10 rate limit only guards `resourceLoad.submit` — the
implicit path via a generation submit has no cap at all. The gap was already recorded; the coverage
change turns it from a theoretical bypass into an invitation with 33k entries.

**Sequencing that follows:** the shared rate-limit key on the generation submit path, and C2
pricing, both land **before** anything reads the new view. Not after, and not in the same change.

### B — search

[models.search-index.ts](../../src/server/search-index/models.search-index.ts) and
[models-update.ts](../../src/pages/api/mod/search/models-update.ts) derive an indexed `canGenerate`
from `covered`. After the swap, search advertises every one of them as generatable — with no
indication that many need a paid load first. Load state in search was deliberately deferred, so
this widens exactly the surface that has no way to express the difference.

### C — display

`model.controller`, `model-version.controller`, `model.selector`, `modelVersion.selector`,
`generation.selector` and `AutocompleteSearch/renderItems/models.tsx` render a badge or a Generate
button — mostly correct after the change, since that is where the load CTA belongs.

**`/api/v1/model-versions/mini/[id]` has already been swapped** (2026-09-08). It is what the
orchestrator reads for `CanGenerate`, and on the live view it made `prepareResource` refuse the very
checkpoints paid loading exists for — verified on version 3040959. Its `covered` field therefore
changed meaning for external consumers ahead of everything else, unflagged.

### D — pools and adjacent consumers

`daily-challenge-processing.ts` picks challenge models joined on coverage; `blocks/workflow.service.ts`
reports coverage for App Blocks; `caches.ts` and `model.service.ts` filter model lists on it. Each
widens with the view. None looks dangerous; all need a look before the swap.

### E — no action

`getCheckpointGenerationCoverage` is dead code (zero callers) and can go with `CoveredCheckpoint`.
`backfill-trained-model-permissions.ts` asserts coverage never grants without `RentCivit` — still
true under the new view.

## How to re-run this

- View definition: `SELECT pg_get_viewdef('public."GenerationCoverage"'::regclass, true)`
- Constants side: run the real exports through `node_modules/.bin/tsx` —
  `getGenerationBaseModelRecords()`, `ecosystemSettings`, `allEcosystemDefaultVersionIds`. Regex over
  the file gives wrong answers; the array literal starts after `= [`, not at the first `[` (which
  belongs to `BaseModelRecord[]`).
- ⚠️ Counting against `GenerationCoverage` directly is slow enough to hit the statement timeout on a
  899k-row view. Evaluate the branch predicates against the base tables instead.
