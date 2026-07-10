# Dynamic Judging Categories for All Challenges

**Status:** Implemented code-side on `feat/public-challenges`, including **D-DB (§5.1)**: the
category library lives in the `ChallengeCategory` table (structural migration
`prisma/migrations/20260709201808_challenge_category_table`), picker + key validation + rubric
injection all resolve from it, with the preset constants + `category-rubrics.ts` as the pre-seed
fallback. Remaining manual steps per env: apply the structural migration, seed the rubric content,
apply the judge-prompt sentinel migration, enable the `dynamic-judging-categories` flag (prompt
content and its migration scripts are environment data, managed directly per env — same handling
as `ChallengeJudge` prompts).
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

### 5.1 Category-owned rich rubrics — stored in the DB (D-DB)
Each category owns a **rich scoring rubric** (the multi-paragraph `X SCORING (0-10): …` block), not
just the terse `criteria`. Source of truth: a **Postgres table** holding the *entire* category
library — not a code module, and not the shared constants file.

```prisma
model ChallengeCategory {
  key        String   @id                 // e.g. 'theme', 'aesthetic' — stable identifier
  label      String                       // picker display + score JSON key (sanitized)
  group      String                       // vibe group for the grouped picker
  criteria   String                       // terse one-liner — client-visible (picker tooltip)
  rubric     String?                      // rich SFW scoring block — SERVER-ONLY, never sent to client
  rubricNsfw String?                      // NSFW override; null → falls back to rubric
  sortOrder  Int      @default(0)
  active     Boolean  @default(true)      // soft-hide from picker; historical challenges keep scoring
  createdAt  DateTime @default(now())
  updatedAt  DateTime @updatedAt
}
```
(Edit `prisma/schema.full.prisma`, then `pnpm run db:generate` — never `schema.prisma` directly.)

**Why the DB, not a repo module:**
- **Consistency with the rest of the judging system.** Rubric blocks are LLM prompt content, and
  prompt content already lives in the DB (`ChallengeJudge.systemPrompt/reviewPrompt/...`) and is
  tuned per environment without a deploy. Splitting one prompt across code + DB invites drift.
- **New categories become a runtime op.** A whole new category set is coming; with the full library
  DB-side, adding/re-wording a category needs no deploy.
- **Why Postgres, not Redis config:** the sys-redis wipe (~2026-05-14) permanently lost
  `system:user-score-multipliers`. Rubric content is too valuable for Redis.
- Terse `criteria` stays client-visible (picker tooltip); `rubric`/`rubricNsfw` are excluded from
  every client-facing selector, like the judge prompts.

**Rubric resolution** (server, at review time): `rubricNsfw` (when the challenge's NSFW context /
judge calls for it) → `rubric` → derived fallback `` `${label.toUpperCase()} SCORING (0-10):\n${criteria}` ``.
Always non-empty; un-authored categories degrade gracefully (resolves D5b).

**Client access:** a tRPC query (e.g. `challenge.getJudgingCategories`) returns
`key / label / group / criteria / sortOrder` for `active` rows only. Cache aggressively — content
churn is rare (in-memory TTL or `createCachedObject`; invalidate on admin edit).

**Consequences for `challenge.constants.ts`:**
- `CHALLENGE_PRESET_CATEGORIES`, `CHALLENGE_CATEGORY_KEYS`, `ADDABLE_PRESET_KEYS`, `makeRow` are
  replaced by the fetched list; `ChallengeCategoryKey` widens from a literal union to `string`.
- `challengeJudgingCategorySchema` (`challenge.schema.ts:315`) — `z.enum(CHALLENGE_CATEGORY_KEYS)`
  becomes `z.string()` + an async service-level check against active DB keys; the label/criteria
  `.transform` derivation moves to a DB lookup (still server-derived — the client still can never
  inject criteria text; that invariant is unchanged).
- `'theme'` stays a reserved key convention (mandatory-once refine + gate logic keep hardcoding it).
- `DEFAULT_CATEGORY_ROWS` weight split (50/15/15/20) stays a code-side policy constant; only the
  label/criteria display copies come from the fetched list.

**Seeding:** two-part seed:
1. Structural rows (key/label/group/criteria/sortOrder) — scripted from today's constants; part of
   the table migration.
2. `rubric` / `rubricNsfw` content — environment data, applied **manually per env** (psql/retool),
   same handling as the Phase 2 judge-prompt migration and the `ChallengeJudge` prompts generally.
   Track which envs are seeded (extends R5).

### 5.2 Injection
At review time (server), assemble a `SCORING RUBRICS` section from the selected categories' rubrics
and inject it via `prepareSystemMessage`, alongside a schema built from the category keys:

```
${systemMessage}

${reviewPrompt}              ← now category-AGNOSTIC (see 5.3)

SCORING RUBRICS:
${resolvedRubrics.join('\n\n')}        ← resolved per §5.1 (rubricNsfw → rubric → criteria fallback)

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
- **D-DB.** The full category library (label/group/criteria/rubric/rubricNsfw) lives in a new
  `ChallengeCategory` Postgres table (§5.1). Rationale: rubric blocks are prompt content and prompt
  content is DB-owned (`ChallengeJudge`) and per-env tunable; Redis rejected (wipe precedent);
  full-table over rubric-only so the incoming new category set is a runtime op, not a deploy.
  `category-rubrics.ts` stays as the pre-seed fallback.
- **D5b — resolved by D-DB.** Un-authored categories: `rubric = null` → derived
  `criteria`-based fallback (§5.1 resolution chain). Author rich rubrics directly in the DB,
  incrementally; no user-facing breakage.
- **D-NSFW — resolved by D-DB (option a).** `rubricNsfw` column as optional per-category override,
  falling back to `rubric` when null. NSFW vs SFW picked from the challenge's NSFW context/judge.
- **D6 = backfill.** A one-off backfill script sets the correct `judgingCategories` on already-run /
  historical challenges (default rows for dailies) so past challenges carry explicit categories.
  Manual-run script under `src/pages/api/admin/temp/` (temp-admin convention).
- **Q3 = ship Phase 0 (edit-populate) first** — independent and harmless.

### Open — need sign-off
<!-- @ai: D5b + D-NSFW resolved by D-DB (moved to Locked above). -->
<!-- @ai:* D6-seed — mod-form seeding for existing null-category dailies. -->
- **D6-seed.** When a mod opens an existing daily with `judgingCategories = null`, does the editor
  seed `DEFAULT_CATEGORY_ROWS` (save flips it to category-based — benign weights, richer prompt) or
  show empty / "uses default rubric" and persist only if the mod adds categories? (Distinct from D6's
  historical backfill.) Recommend the latter, to stop an unrelated edit from silently converting the
  judging path.

## 7. Change surface (phased)

> **Implementation status:** Phases 0, 1b (sentinel injection), 2 (SQL authored; manual per-env apply
> pending), 3 (flag-gated), 4, 5 (opt-in toggle) are **shipped** on `feat/public-challenges` — see
> `dynamic-judging-categories-plan.md` for the task-level record. Phase 6 backfill deferred (Task 9
> default-fallback obviates it for correctness). **D-DB (Phases 1a + 1b-delta below) is also
> shipped code-side** — `ChallengeCategory` model + structural migration, cached accessor with
> preset fallback (`challenge-category.service.ts`), `challenge.getJudgingCategories` tRPC,
> input/stored schema split (`z.enum` dropped; keys validated at `resolveJudgingCategories`),
> both upsert paths derive label/criteria from the library, `generateReview` resolves the rubric
> block from the DB, `CategoryWeights` fetches options. Rubric content seeding stays a manual
> per-env step, like the judge prompts.

### Phase 0 — Edit-populate plumbing (independent, low-risk; lands first per Q3) ✅ shipped
- `challenge.service.ts` `buildChallengeDetail._internal` — parse `challenge.judgingCategories`
  (`challengeJudgingCategoriesSchema`), add to `_internal`.
- `challenge.schema.ts` `ChallengeDetailForEdit` — add `judgingCategories: ChallengeJudgingCategory[] | null`.
- `moderator/challenges/[id]/edit.tsx` — map `judgingCategories` into `challengeForForm`.
- `ChallengeUpsertForm.tsx` — drop the stale "not populated by any loader" comment (`:141-142`);
  `defaultValues` already reads `challenge?.judgingCategories`.

### Phase 1a — `ChallengeCategory` table + seed (D-DB)
- Prisma model in `schema.full.prisma` + `pnpm run db:generate`; empty migration file with the
  CREATE TABLE (applied manually per env, per repo rule).
- Structural seed (key/label/group/criteria/sortOrder from today's constants) in the migration.
  `rubric`/`rubricNsfw` content applied manually per env (§5.1).
- Server accessor: fetch active categories + resolve rubric text (nsfw → sfw → criteria fallback),
  cached. `category-rubrics.ts` shrinks to this accessor; delete its hardcoded rubric text once the
  env's DB is seeded.
- tRPC `challenge.getJudgingCategories` (client-safe fields only — no rubric columns).

### Phase 1b-delta — Rewire shipped injection onto the DB (D-DB)
Sentinel injection (`injectRubrics` / `{{SCORING_RUBRICS}}` in `generative-content.ts`) and
`aestheticFlaws` are already shipped; this phase only swaps the rubric *source*:
- `getCategoryRubric` (`category-rubrics.ts`) — backing store moves from hardcoded constants to the
  cached `ChallengeCategory` accessor. Goes sync → async (or the review path pre-fetches the resolved
  map once per batch and passes it down); adjust `generateReview` callers accordingly. Resolution
  chain (nsfw → sfw → criteria fallback) is unchanged.
- `challenge.schema.ts:315` — key validation moves from `z.enum(CHALLENGE_CATEGORY_KEYS)` to string +
  active-DB-key check; label/criteria derivation becomes a DB lookup (client still can't inject text).
- Tests: fallback chain against DB rows (incl. `rubric = null` categories); prompt assembly unchanged
  for the seeded 4 defaults (byte-compare against current constants before deleting them).

### Phase 2 — Judge-prompt migration (§5.3) ✅ SQL authored; per-env apply pending
- Strip baked category blocks from the 4 judges' `reviewPrompt`. Provide the exact SQL/retool steps;
  **surface to a human to apply per env** (no auto-migration). Keep canonical rubric text in code.

### Phase 3 — Un-gate the read path ✅ shipped (flag-gated)
- Drop `source === User` at the 4 gates → presence + valid-parse only. Confirm `getJudgedEntries`
  routes on category presence, not source.

### Phase 4 — Persist from the mod path ✅ shipped
- `challenge.schema.ts:313` `upsertChallengeBaseSchema` — add
  `judgingCategories: challengeJudgingCategoriesSchema.optional().nullable()` (reuses theme-once /
  unique / sum-100 / max-4 `superRefine`).
- `challenge.service.ts:918` `upsertChallenge` — persist in `commonData`.

### Phase 5 — UI ✅ toggle shipped; CategoryWeights DB-fetch below = D-DB delta
- `CategoryWeights.tsx` — replace `CHALLENGE_PRESET_CATEGORIES` / `ADDABLE_PRESET_KEYS` / `makeRow`
  constants with `challenge.getJudgingCategories` query data (grouped select options, criteria
  tooltip, next-free-key pick). `DEFAULT_CATEGORY_ROWS` weights stay code-side (§5.1).
- `ChallengeUpsertForm.tsx:905` — un-gate `<CategoryWeights />` for the mod variant (honor D6-seed);
  keep "Judging Prompt Override" (they compose).

### Phase 6 — Backfill (D6) ⏸ deferred (Task 9 fallback obviates for correctness)
- Temp-admin script (`src/pages/api/admin/temp/…`) to set `judgingCategories` on historical
  challenges. Scoped, idempotent, `WEBHOOK_TOKEN`-guarded.

## 8. Risks & compatibility
- **R1. Judge-prompt migration must land with Phase 1b** — if rubric blocks are injected while still
  baked in `reviewPrompt`, the model sees them twice. Sequence Phase 1b + 2 together (or gate
  injection on a flag until prompts are migrated).
- **R2. `aestheticFlaws` drop** — mitigated in Phase 1.
- **R3. Automated daily pipeline** keeps working with `judgingCategories = null` via the fallback.
  Verify auto-create paths (`daily-challenge-processing.ts`, `challenge-auto-queue.ts`) don't need to
  write categories (backfill handles history; new dailies can stay null → fixed, or be seeded).
- **R4. Score-key case drift** — normalized in `calculateWeightedCategoryScore`
  (`daily-challenge-scoring.ts:80-88`). Handled.
- **R5. Per-env content sync** — three manual DB content ops per env (preview/staging/prod): judge
  `reviewPrompt` strip (Phase 2), `ChallengeCategory` structural seed, and rubric content seed
  (Phase 1a). The DB is the canonical rubric source. Track which envs are done.
- **R6. Column scope** — `rubric`/`rubricNsfw` are server-only prompt content (like judge prompts);
  keep them out of client selectors and tRPC output — review any new `ChallengeCategory` query for
  column scope.
- **R7. Losing the `ChallengeCategoryKey` literal union** — key typos that today fail typecheck become
  runtime concerns (`'theme'` refs, `DEFAULT_CATEGORY_ROWS` keys). Mitigate: service-level active-key
  validation + tests covering the reserved `theme` key.

## 9. Testing
- Unit: default categories reproduce `calculateWeightedScore` output (proves §3).
- Unit: rubric assembly emits the correct blocks + `aestheticFlaws`; fallback (no categories) unchanged.
- Unit: rubric resolution chain `rubricNsfw → rubric → criteria` incl. un-authored categories (D5b).
- Integration: null-category daily → fixed path; mod-set-categories daily → category path; user
  challenge → unchanged.
- Manual: mod edit form round-trips `judgingCategories` (Phase 0).

## 10. Open questions
<!-- @ai: D5b + D-NSFW resolved by D-DB. Remaining: -->
1. **D6-seed** — mod-form seeding for existing null-category dailies: default-seed or opt-in empty (rec)?
2. **New category set** — the incoming replacement/expanded category list: which keys/groups, and who
   authors the rich SFW + NSFW rubrics per category (drafted then reviewed, straight to DB)?
