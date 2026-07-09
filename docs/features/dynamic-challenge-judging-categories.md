# Dynamic Judging Categories for All Challenges

**Status:** Design / planning — not yet implemented
**Date:** 2026-07-09
**Related:** Public Challenges v1 (ClickUp 868k8z86x), `src/shared/constants/challenge.constants.ts`

## 1. Context & goal

Today, judging is bifurcated by challenge **source**:

- **User challenges** (`source = User`) are scored by creator-defined, weighted `judgingCategories`
  (pick from a curated preset library, weights must sum to 100%). Only a terse one-line `criteria`
  per category is injected into the review.
- **Mod / daily / system challenges** are scored by a **fixed** `theme / wittiness / humor /
  aesthetic` rubric plus an optional free-form `judgingPrompt` override. The *rich* per-category
  scoring rubrics live baked inside each judge's `reviewPrompt` (~11K chars, verified in DB).

**Goal:** make judging dynamic for *every* challenge, driven by **category-owned rich scoring
rubrics** (not terse criteria). Daily challenges keep behaving as they do today by default; a mod can
reshape a challenge's categories/weights; the LLM always gets the full per-category rubric for
whatever categories are selected.

**Non-goal (v1):** changing the automated daily pipeline's default outcomes, or giving users any new
power. Users stay preset-only.

## 2. Current architecture (verified)

| | User challenges | Mod / daily / system |
|---|---|---|
| Scored by | creator-defined weighted `judgingCategories` | fixed `theme/wittiness/humor/aesthetic` + `judgingPrompt` |
| Rubric detail | terse `criteria` one-liner in schema comment | **rich** per-category blocks baked in `judge.reviewPrompt` |
| Review response schema | `buildCategoryReviewSchema()` | fixed `RESPONSE_SCHEMA` |
| Ranking fn | `calculateWeightedCategoryScore()` | `calculateWeightedScore()` |
| Score JSON keys | category **labels** (`"Theme"`) | fixed lowercase (`theme`) |
| Persisted by | `upsertUserChallenge` (writes categories, `judgingPrompt=null`) | `upsertChallenge` (**no** `judgingCategories`) |

**Verified DB facts (postgres skill, replica):**
- 4 judges, all active: CivBot, CivChan, GigaBot, CivChan NSFW. `reviewPrompt` ≈ 10–12K chars each.
- **No judge uses `reviewTemplate`** (all null) → the template path in `generateReview` is dead code
  in practice; every review goes through the fallback (`buildFallbackMessages` → `prepareSystemMessage`).
- Judge `reviewPrompt` structure: **(1)** persona + general scoring approach → **(2)** per-category
  `THEME/WITTINESS/HUMOR/AESTHETIC SCORING (0-10):` blocks → **(3)** general closers (CONSISTENCY
  CHECK, HIGH SCORES, Score range) + judge-specific COMMENT STYLE.
- Cross-judge md5 of each SCORING block: **WITTINESS / HUMOR / AESTHETIC are byte-identical** across
  CivBot/CivChan/GigaBot (already judge-agnostic). **THEME** has minor per-judge drift. **CivChan
  NSFW** carries its own NSFW-adjusted variants of all four.

Key source locations:
- Injection seam: `generative-content.ts:446` `prepareSystemMessage` →
  `` `${systemMessage}\n\n${reviewPrompt}\n\nReply with json\n\n${schema}` ``
- Review path selection: `generative-content.ts:269` `generateReview` (`:271` template gate, `:357`
  `buildFallbackMessages`)
- Category schema builder: `generative-content.ts:252` `buildCategoryReviewSchema`
- Weighting fns: `daily-challenge-scoring.ts` (`SCORE_WEIGHTS:20`, `calculateWeightedScore:40`,
  `calculateWeightedCategoryScore:75`)
- `source === User` gates (4): `challenge.service.ts:1736`, `:2570`,
  `daily-challenge-processing.ts:625-629` (review), `:1194-1196` (rank)
- Category zod contract: `challenge.schema.ts:361-388`
- Mod upsert: schema `challenge.schema.ts:313`, service `challenge.service.ts:918`
- Preset library (label/group/short criteria): `src/shared/constants/challenge.constants.ts:64`

## 3. Key insight — convergence is behavior-preserving

Fixed daily weights == default category rows:

| Category | `SCORE_WEIGHTS` (fixed) | `DEFAULT_CATEGORY_ROWS` |
|---|---|---|
| theme | 0.50 | 50 |
| aesthetic | 0.20 | 20 |
| humor | 0.15 | 15 |
| wittiness | 0.15 | 15 |

Same theme gate (`disqualify < 2`, `cap 5 when < 4`). A challenge scored with the default categories
ranks identically to the fixed rubric — outcomes only change when a mod edits categories.

## 4. Target architecture

Single, source-agnostic path:

> **Score by `judgingCategories` when present & valid; otherwise fall back to the fixed rubric.**
> **The per-category rubric text is category-owned and assembled into the prompt dynamically.**

- Drop `source === User` from all 4 gates; keep only presence + valid-parse (fallback already exists).
- Persist `judgingCategories` from the mod path.
- `judgingPrompt` and `judgingCategories` are **orthogonal and compose**: `judgingPrompt` shapes the
  judge persona/system prompt; `judgingCategories` shape which dimensions are scored *and* (new) which
  rubric blocks are injected.

## 5. Rubric ownership & prompt injection (the core of this feature)

### 5.1 Category-owned rich rubrics
Each preset category owns a **rich scoring rubric** (the multi-paragraph `X SCORING (0-10): …` block),
not just the terse `criteria`. Source of truth: a **server-only** module, e.g.
`src/server/games/daily-challenge/category-rubrics.ts`, keyed by `ChallengeCategoryKey`:

```ts
export const CATEGORY_RUBRICS: Record<ChallengeCategoryKey, string> = {
  theme: `THEME SCORING (0-10): …`,       // from current judge.reviewPrompt (verified)
  wittiness: `WITTINESS SCORING (0-10): …`,
  humor: `HUMOR SCORING (0-10): …`,
  aesthetic: `AESTHETIC SCORING (0-10): …`,
  // …the other ~20 presets: rich rubric authored, or fall back to terse criteria (see D5b)
};
// Optional NSFW override where the NSFW judge's rubric differs (see D-NSFW):
export const CATEGORY_RUBRICS_NSFW: Partial<Record<ChallengeCategoryKey, string>> = { … };
```

**Why server-only, not the shared constants file:** rubric text is ~1–3K chars × 24 categories (~35KB).
`challenge.constants.ts` is imported by client components (`CategoryWeights`) — the client only needs
`label / group / criteria` for the picker. Keeping rubric text server-side keeps the client bundle
lean and keeps rubric wording off the wire.

### 5.2 Injection
At review time (server), assemble a `SCORING RUBRICS` section from the selected categories' rubrics
and inject it via `prepareSystemMessage`, alongside a schema built from the category keys:

```
${systemMessage}

${reviewPrompt}              ← now category-AGNOSTIC (see 5.3)

SCORING RUBRICS:
${selectedCategories.map(c => CATEGORY_RUBRICS[c.key]).join('\n\n')}

Reply with json

${buildCategoryReviewSchema(selectedCategories)}   ← keys only; detail lives in the rubric above
```

`buildCategoryReviewSchema` stays the schema (score keys), but its inline criteria comment becomes
redundant/short since the rich rubric now carries the detail. `prepareSystemMessage` (`:446`) gains a
`rubricSection` param (or the review prompt carries a `{{scoringRubrics}}` placeholder that gets
replaced).

### 5.3 Judge-prompt migration
Strip the hardcoded per-category `SCORING` blocks (part **(2)** in §2) out of the 4 judges'
`reviewPrompt`, leaving persona + general scoring approach + closers + COMMENT STYLE. Otherwise the
model would see the rubric twice (baked block + injected block). This is a **DB content change**,
applied **manually per environment** (psql/retool) per the repo's migration rule — not an auto-run
migration. Capture the canonical rubric text (extracted from the current prompts) in the code module
so code and DB don't drift.

- WITTINESS/HUMOR/AESTHETIC canonical = the shared SFW block (identical across 3 judges — verified).
- THEME canonical = pick one (minor per-judge drift); THEME is the mandatory gate category.
- NSFW variants: see D-NSFW.

## 6. Decisions

### Locked
- **D1.** Behavior-preserving default (§3): defaulted challenges rank identically.
- **D2.** No judge uses `reviewTemplate`; injection work lives in the fallback path (§5.2). Keep the
  template path working but it is not exercised today.
- **D3.** `judgingPrompt` + `judgingCategories` compose (§4).
- **D4.** Score-shape compat already handled — user challenges already emit label-keyed
  `Record<string, number>`; consumers (`parseJudgeScore`, `JudgeScoreBadge`, `challenge.schema.ts:198/493`,
  `challenge-helpers.ts:511`, `image.service.ts:2069`) accept the union.
- **D5 = Option A: preset-only for everyone** — mods reshape the category *mix* + weights from the
  curated library; no free client/mod text reaches the LLM (`criteria`/`rubric` stay server-derived
  from the key, `challenge.schema.ts:366-373`). Users preset-only too.
- **D5-RICH.** Each category owns a **rich** rubric (§5.1), replacing terse-criteria injection.
- **D6 = backfill.** A one-off backfill script sets the correct `judgingCategories` on already-run /
  historical challenges (default rows for dailies) so past challenges carry explicit categories.
  Manual-run script under `src/pages/api/admin/temp/` (temp-admin convention).
- **Q3 = ship Phase 0 (edit-populate) first** — independent and harmless.

### Open — need sign-off
<!-- @ai:* D5b — un-authored preset rubrics. Recommend fallback to terse criteria. -->
- **D5b. Un-authored presets.** Only the 4 defaults have rich rubrics in the DB today; the other ~20
  presets currently have only terse `criteria`. Options: **(a)** author rich rubrics for all 24 before
  ship (content-heavy); **(b, rec)** ship rich rubrics for the 4 defaults now, assembler uses
  `CATEGORY_RUBRICS[key] ?? criteria`, author the rest incrementally (no user-facing breakage);
  **(c)** only expose presets that have a rich rubric.

<!-- @ai:* D-NSFW — NSFW rubric variants. Recommend optional per-category override, fall back to canonical. -->
- **D-NSFW.** CivChan NSFW carries NSFW-adjusted rubric variants. Public/user challenges are SFW-only,
  but daily/mod NSFW challenges use the NSFW judge. Options: **(a, rec)** optional
  `CATEGORY_RUBRICS_NSFW[key]` override, fall back to canonical when absent — pick NSFW vs SFW by the
  challenge's NSFW context/judge; **(b)** canonical SFW rubric for all (NSFW dailies get SFW rubric
  text — simpler, minor quality loss).

<!-- @ai:* D6-seed — mod-form seeding for existing null-category dailies. -->
- **D6-seed.** When a mod opens an existing daily with `judgingCategories = null`, does the editor
  seed `DEFAULT_CATEGORY_ROWS` (save flips it to category-based — benign weights, richer prompt) or
  show empty / "uses default rubric" and persist only if the mod adds categories? (Distinct from D6's
  historical backfill.) Recommend the latter, to stop an unrelated edit from silently converting the
  judging path.

## 7. Change surface (phased)

### Phase 0 — Edit-populate plumbing (independent, low-risk; lands first per Q3)
- `challenge.service.ts` `buildChallengeDetail._internal` — parse `challenge.judgingCategories`
  (`challengeJudgingCategoriesSchema`), add to `_internal`.
- `challenge.schema.ts` `ChallengeDetailForEdit` — add `judgingCategories: ChallengeJudgingCategory[] | null`.
- `moderator/challenges/[id]/edit.tsx` — map `judgingCategories` into `challengeForForm`.
- `ChallengeUpsertForm.tsx` — drop the stale "not populated by any loader" comment (`:141-142`);
  `defaultValues` already reads `challenge?.judgingCategories`.

### Phase 1 — Category rubrics + injection (§5)
- New server module `category-rubrics.ts` with `CATEGORY_RUBRICS` (+ optional `_NSFW`), seeded from the
  verified DB text for the 4 defaults.
- `generative-content.ts` — assemble the `SCORING RUBRICS` section from selected categories; extend
  `prepareSystemMessage`/`buildFallbackMessages` to inject it; keep `buildCategoryReviewSchema` for the
  schema. Add `aestheticFlaws` to the category schema (present in fixed `RESPONSE_SCHEMA:244`, missing
  in the category schema) so converged dailies keep flaw capture.
- Tests: assembled prompt contains the rubric blocks for selected categories + `aestheticFlaws`;
  no-categories path unchanged.

### Phase 2 — Judge-prompt migration (§5.3)
- Strip baked category blocks from the 4 judges' `reviewPrompt`. Provide the exact SQL/retool steps;
  **surface to a human to apply per env** (no auto-migration). Keep canonical rubric text in code.

### Phase 3 — Un-gate the read path
- Drop `source === User` at the 4 gates → presence + valid-parse only. Confirm `getJudgedEntries`
  routes on category presence, not source.

### Phase 4 — Persist from the mod path
- `challenge.schema.ts:313` `upsertChallengeBaseSchema` — add
  `judgingCategories: challengeJudgingCategoriesSchema.optional().nullable()` (reuses theme-once /
  unique / sum-100 / max-4 `superRefine`).
- `challenge.service.ts:918` `upsertChallenge` — persist in `commonData`.

### Phase 5 — UI
- `ChallengeUpsertForm.tsx:905` — un-gate `<CategoryWeights />` for the mod variant (honor D6-seed);
  keep "Judging Prompt Override" (they compose).

### Phase 6 — Backfill (D6)
- Temp-admin script (`src/pages/api/admin/temp/…`) to set `judgingCategories` on historical
  challenges. Scoped, idempotent, `WEBHOOK_TOKEN`-guarded.

## 8. Risks & compatibility
- **R1. Judge-prompt migration must land with Phase 1** — if rubric blocks are injected while still
  baked in `reviewPrompt`, the model sees them twice. Sequence Phase 1 + 2 together (or gate injection
  on a flag until prompts are migrated).
- **R2. `aestheticFlaws` drop** — mitigated in Phase 1.
- **R3. Automated daily pipeline** keeps working with `judgingCategories = null` via the fallback.
  Verify auto-create paths (`daily-challenge-processing.ts`, `challenge-auto-queue.ts`) don't need to
  write categories (backfill handles history; new dailies can stay null → fixed, or be seeded).
- **R4. Score-key case drift** — normalized in `calculateWeightedCategoryScore`
  (`daily-challenge-scoring.ts:80-88`). Handled.
- **R5. Env drift on judge prompts** — the code module is the canonical rubric source; DB prompts must
  be migrated in every env (preview/staging/prod). Track which envs are done.

## 9. Testing
- Unit: default categories reproduce `calculateWeightedScore` output (proves §3).
- Unit: rubric assembly emits the correct blocks + `aestheticFlaws`; fallback (no categories) unchanged.
- Unit: `CATEGORY_RUBRICS[key] ?? criteria` fallback for un-authored presets (D5b).
- Integration: null-category daily → fixed path; mod-set-categories daily → category path; user
  challenge → unchanged.
- Manual: mod edit form round-trips `judgingCategories` (Phase 0).

## 10. Open questions
<!-- @ai:* answer D5b + D-NSFW + D6-seed, then implement per phase order. -->
1. **D5b** — un-authored preset rubrics: author all (a), fallback to terse criteria (b, rec), or
   expose only authored presets (c)?
2. **D-NSFW** — NSFW rubric variants: optional override (a, rec) or canonical SFW for all (b)?
3. **D6-seed** — mod-form seeding for existing null-category dailies: default-seed or opt-in empty (rec)?
