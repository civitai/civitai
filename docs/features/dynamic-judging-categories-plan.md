# Implementation Plan — Dynamic Judging Categories for All Challenges

Executable task plan for the design in
[dynamic-challenge-judging-categories.md](dynamic-challenge-judging-categories.md).
Run with subagent-driven development. Base commit: `f0815c6d20` (CategoryWeights→constants
refactor). Branch: `feat/public-challenges` (work directly, no sub-branch).

## Global Constraints (bind every task; copied to reviewers verbatim)

1. **Preset-only (D5).** No client- or mod-supplied free text reaches the LLM judge. `label`,
   `criteria`, and `rubric` are all **server-derived from the category `key`**. Keep the existing
   `challengeJudgingCategorySchema` transform (`challenge.schema.ts:361-373`) that strips any
   client-sent label/criteria.
2. **Rubric text is server-only.** It lives in `src/server/games/daily-challenge/category-rubrics.ts`,
   NOT in the client-imported `src/shared/constants/challenge.constants.ts`. Never import
   `category-rubrics.ts` from client code.
3. **Behavior-preserving default (D1).** `DEFAULT_CATEGORY_ROWS` weights (theme 50 / aesthetic 20 /
   humor 15 / wittiness 15) equal `SCORE_WEIGHTS`. A challenge with default categories must rank
   identically to the fixed rubric. Do not change `SCORE_WEIGHTS`, the theme-gate constants, or
   `calculateWeightedScore`.
4. **Placeholder-gated injection (backward compat).** Rich rubric injection replaces a
   `{{SCORING_RUBRICS}}` sentinel in the judge's `reviewPrompt`. If the sentinel is absent (judge
   prompt not yet migrated), behavior is byte-identical to today. This decouples the code deploy from
   the manual per-env judge-prompt migration.
5. **Flag-gated non-user activation.** Daily/mod/system challenges only use categories when a Flipt
   flag is enabled (name: `dynamic-judging-categories`; via `isFlipt(FLIPT_FEATURE_FLAGS.…)`). **User
   challenges are unaffected by the flag — they already use categories and must keep working.** Flag
   is GitOps-managed (created outside this repo); code just reads it, defaulting OFF.
6. **No Prisma change.** `Challenge.judgingCategories Json?` already exists
   (`packages/civitai-db-schema/prisma/schema.full.prisma:5216`). Do not touch Prisma schema.
7. **Manual DB / no auto-migrations.** Judge-prompt edits and backfills are SQL/scripts surfaced to a
   human to apply per environment. Never suggest `prisma migrate deploy`.
8. **Tests:** Vitest (`pnpm vitest run <path>`). No test files under `src/pages`. Follow
   test-driven-development.

## Sequencing & safety

Code tasks 1–6 can land together. Non-user challenges stay on the fixed rubric until, **per
environment**: (Task 7) judge prompts are migrated AND (Task 8) categories are backfilled AND the
Flipt flag is enabled. User challenges auto-improve once judge prompts carry the `{{SCORING_RUBRICS}}`
sentinel (placeholder mechanism) — no flag, no data change needed.

---

## Task 1 — Edit-populate plumbing (Phase 0)

**Independent, harmless — surfaces stored `judgingCategories` into the mod edit form.**

Files:
- `src/server/services/challenge.service.ts` — in `buildChallengeDetail` (`~:533`), parse
  `challenge.judgingCategories` with `challengeJudgingCategoriesSchema.safeParse(...)` and add to the
  `_internal` block (`~:747`): `judgingCategories: parsed.success ? parsed.data : null`.
- `src/server/schema/challenge.schema.ts` — `ChallengeDetailForEdit` (`:207`): add
  `judgingCategories: ChallengeJudgingCategory[] | null`.
- `src/pages/moderator/challenges/[id]/edit.tsx` — in the `challengeForForm` map (`~:82`), add
  `judgingCategories: challenge.judgingCategories ?? undefined`.
- `src/components/Challenge/ChallengeUpsertForm.tsx` — delete the now-stale comment at `:141-142`
  ("Not populated by any loader today…"). Leave the `judgingCategories?: CategoryWeightRow[]` field
  and the `defaultValues` line (`challenge?.judgingCategories ?? DEFAULT_CATEGORY_ROWS`) as-is.

Tests: a service/handler test asserting `getChallengeForEdit` returns `judgingCategories` for a
challenge that has them (and `null` when absent/malformed). Keep handler tests outside `src/pages`.

Done: mod edit form pre-populates saved categories; typecheck clean.

---

## Task 2 — `category-rubrics.ts` server module (Phase 1a)

Create `src/server/games/daily-challenge/category-rubrics.ts`:
- `export const CATEGORY_RUBRICS: Partial<Record<ChallengeCategoryKey, string>>` — seed the **four
  defaults verbatim** from the canonical DB text. **Verbatim source:** read
  `<scratchpad>/rubric_blocks.json` (keys `THEME SCORING`, `WITTINESS SCORING`, `HUMOR SCORING`,
  `AESTHETIC SCORING`) — these were extracted from CivBot's live `reviewPrompt`. Store each under its
  category key (`theme`, `wittiness`, `humor`, `aesthetic`) with the leading `X SCORING (0-10):`
  header included. If the scratchpad file is gone, re-extract via the postgres skill:
  `SELECT "reviewPrompt" FROM "ChallengeJudge" WHERE name='CivBot'`.
- `export const CATEGORY_RUBRICS_NSFW: Partial<Record<ChallengeCategoryKey, string>> = {}` — empty for
  v1 (D-NSFW: falls back to canonical; populate from CivChan NSFW later).
- `export function getCategoryRubric(key: ChallengeCategoryKey, opts?: { nsfw?: boolean }): string` —
  returns `CATEGORY_RUBRICS_NSFW[key]` (if nsfw) ?? `CATEGORY_RUBRICS[key]` ?? a rubric built from the
  preset's terse `criteria` (`CHALLENGE_PRESET_CATEGORIES[key]`) formatted as
  `` `${label.toUpperCase()} SCORING (0-10):\n${criteria}` `` (D5b fallback for the ~20 un-authored
  presets). Never returns empty.

Constraints: server-only (Global #2). Import category keys/presets from
`~/shared/constants/challenge.constants`.

Tests: `getCategoryRubric` returns the rich block for a default, the NSFW override when present, and
the criteria-derived fallback for a non-default preset (e.g. `gruesomeness`).

Done: module + unit test green.

---

## Task 3 — Rubric injection + `aestheticFlaws` (Phase 1b)

`src/server/games/daily-challenge/generative-content.ts`:
- Build a `SCORING RUBRICS` string from the selected `input.categories` using
  `getCategoryRubric(key, { nsfw })` joined by `\n\n`. (The category `key` is needed — see Task 3a
  note: `GenerateReviewInput.categories` currently carries `{ name, criteria }`; extend it to carry
  `key` so the rubric can be looked up. Update the caller at `daily-challenge-processing.ts:917` to
  pass `key`.)
- Injection: if `config.prompts.review` contains the sentinel `{{SCORING_RUBRICS}}`, replace it with
  the assembled `SCORING RUBRICS` block. If the sentinel is absent, **do not change current
  behavior** (Global #4). Apply in the fallback path (`buildFallbackMessages` /
  `prepareSystemMessage`, `:357`/`:446`) which is the live path (no judge uses `reviewTemplate`).
- `buildCategoryReviewSchema` (`:252`): add the optional `"aestheticFlaws"` array field so converged
  daily challenges keep flaw capture (present in fixed `RESPONSE_SCHEMA:244`, missing here). Keep
  `GeneratedReview.aestheticFlaws` wiring (`:294`, note `:926`).

Tests: sentinel present → assembled rubric blocks appear in the system message for the selected
categories; sentinel absent → message identical to pre-change; category schema includes
`aestheticFlaws`; no-categories (fixed) path unchanged.

Done: injection + schema change covered by tests; nsfw flag threaded from the caller.

---

## Task 4 — Un-gate the read path, flag-gated (Phase 3)

Generalize the 4 `source === ChallengeSource.User` gates to
`(source === User) || isFlipt(FLIPT_FEATURE_FLAGS.dynamicJudgingCategories)`, keeping the existing
`safeParse` + fixed-rubric fallback:
- `src/server/services/challenge.service.ts:1736-1742` and `:2570`
- `src/server/jobs/daily-challenge-processing.ts:625-629` (review) and `:1194-1196` (rank)

Confirm `getJudgedEntries` (`daily-challenge-processing.ts:1512`) routes on the presence of
`userCategories`, not on `source`, once the gate passes; adjust if it re-checks source internally.

Add the flag key to `FLIPT_FEATURE_FLAGS` (wherever the enum/const lives). Default OFF.

Tests: with flag off, a non-User challenge with categories still uses the fixed rubric; with flag on,
it uses categories; null/malformed categories always fall back; User source unaffected either way.

Done: gates flag-generalized; tests cover flag on/off × source.

---

## Task 5 — Persist categories from the mod path (Phase 4)

- `src/server/schema/challenge.schema.ts` — `upsertChallengeBaseSchema` (`:313`): add
  `judgingCategories: challengeJudgingCategoriesSchema.optional().nullable()` (reuses the theme-once /
  unique / sum-100 / max-4 `superRefine`).
- `src/server/services/challenge.service.ts` — `upsertChallenge` (`:918`): destructure and persist
  `judgingCategories` in `commonData` as `... as unknown as Prisma.InputJsonValue` (match
  `upsertUserChallenge:1199`). Do NOT null out `judgingPrompt` — mod path keeps both (compose).

Tests: mod upsert accepts + round-trips `judgingCategories`; invalid weights (sum≠100) rejected;
omitting the field leaves it null.

Done: mod create/update persists categories; validation reused.

---

## Task 6 — UI: show CategoryWeights for mods (Phase 5)

`src/components/Challenge/ChallengeUpsertForm.tsx`:
- Render category judging for the **moderator variant** too (currently `{isUser && …}` at `:905`).
  Keep the "Judging Prompt Override" field for mods (they compose).
- **D6-seed via an explicit toggle (not an empty editor).** `CategoryWeights` requires an always-
  present locked `theme` row and its "Add category" button excludes `theme` — so an empty
  `judgingCategories: []` is an unreachable/broken state (no theme, can't add one). Implement D6-seed
  ("opt-in, never silently convert") as a mod-only switch, e.g. **"Customize judging categories"**:
  - **Off** → the challenge uses the default rubric; the form submits `judgingCategories: null`
    (Task 5 persists `Prisma.JsonNull`). `CategoryWeights` is hidden. Show a short note that judging
    uses the default rubric until customized.
  - **On** → render `CategoryWeights`; if the challenge has no categories yet, seed the field array
    with `DEFAULT_CATEGORY_ROWS` at that moment (valid starting point with the locked theme row).
  - **Initial switch state:** ON when the challenge already has `judgingCategories`; OFF when a mod
    edits an existing challenge that has none (prevents "edit title + save" from converting judging).
    New challenges (create): default ON, seeded with `DEFAULT_CATEGORY_ROWS`.
  - **User variant unchanged:** no toggle — `CategoryWeights` always renders, seeded as today.
- The mod submit handler must send `judgingCategories: null` when the toggle is Off (so an existing
  challenge is explicitly reverted to / kept on the default rubric), and the category array when On.
- Do NOT gate the mod editor behind the Flipt flag — mods may pre-configure categories before the
  flag is enabled per env; stored categories only affect judging once the flag is on (Task 4).

Tests / manual: mod form shows the toggle; Off → submits `null` (no conversion of an existing
null-category challenge on an unrelated save); On with no prior categories → seeds defaults incl. the
locked theme row and round-trips through Task 5; User variant behavior unchanged.

Done: mods can opt into custom categories; no accidental conversion; no broken empty state.

---

## Task 7 — Judge-prompt migration SQL (Phase 2, human-applied deliverable)

Produce a reviewed SQL/script (place under `scripts/` or a temp-admin note; surface for **manual
per-env application** — Global #7) that, for each of the 4 judges, replaces the baked per-category
`THEME/WITTINESS/HUMOR/AESTHETIC SCORING` blocks in `reviewPrompt` with the single sentinel
`{{SCORING_RUBRICS}}`, leaving persona + general scoring approach + closers + COMMENT STYLE intact.

- The removed canonical blocks must match what Task 2 stores (SFW judges). For CivChan NSFW, capture
  its variant blocks for a later `CATEGORY_RUBRICS_NSFW` population (out of scope to wire in v1).
- Deliver as idempotent, per-judge `UPDATE` statements with the exact before/after, plus a
  verification `SELECT`. Do not run it.

Done: SQL + runbook produced and surfaced; not applied.

---

## Task 8 — Historical backfill (Phase 6, D6, human-run)

Temp-admin endpoint under `src/pages/api/admin/temp/` (per repo convention: `WebhookEndpoint`,
`WEBHOOK_TOKEN`-guarded, block comment documenting actions/params, scoped + idempotent) that sets
`judgingCategories = DEFAULT_CATEGORY_ROWS` on already-run/historical challenges that have none, so
past challenges carry explicit categories. Scope each action to a bounded id set/range per call.

Done: endpoint implemented + documented; not run (surface to human for per-env execution).

**Repositioned:** with Task 9 (default-rubric fallback), the backfill is NO LONGER required for
correctness — post-migration null-category challenges self-heal via the default rubric + fixed
schema. Backfill becomes an optional "make categories explicit + editable in the mod UI" step, and
note that seeding DEFAULT categories flips a challenge from the fixed response schema to the
category (label-keyed) schema (equivalent ranking, different score-key shape). Ship it after Task 9.

---

## Task 9 — Default-rubric fallback for the sentinel (Phase 1c, CRITICAL, precedes migration)

Surfaced by Task 7: after a judge's prompt is migrated to carry `{{SCORING_RUBRICS}}`, a challenge
with `judgingCategories = null` (all 197 current daily/mod challenges, and new dailies not seeded at
creation) would leave the sentinel UNRESOLVED — the LLM would receive the literal `{{SCORING_RUBRICS}}`
with no scoring criteria. This is a correctness bug that must land in code BEFORE the Task 7 SQL is
applied to any environment.

`src/server/games/daily-challenge/generative-content.ts` (`buildFallbackMessages`, ~:357):
- Resolve the sentinel whenever it is present, using the challenge's categories if any, else
  `DEFAULT_CATEGORY_ROWS` (import from `~/shared/constants/challenge.constants`). Concretely, the
  rubric-injection categories become `effectiveCategories = categories?.length ? categories :
  DEFAULT_CATEGORY_ROWS`, passed to `injectRubrics`. `injectRubrics` is already a no-op when the
  sentinel is absent (unmigrated prompt), so this stays fully backward-compatible.
- **Keep the response-schema selection UNCHANGED** — it must still key on the *real* `categories`
  (`categories?.length ? buildCategoryReviewSchema(categories) : RESPONSE_SCHEMA`). A null-category
  challenge keeps the fixed `RESPONSE_SCHEMA` (lowercase `theme/wittiness/humor/aesthetic`) and gets
  the DEFAULT rubric blocks injected into the prompt — matching current pre-migration behavior. Do
  NOT switch a null-category challenge to the category schema.
- `DEFAULT_CATEGORY_ROWS` carries `key` for each row, so `getCategoryRubric(row.key, { nsfw })`
  reproduces the canonical theme/wittiness/humor/aesthetic blocks (i.e. the exact text the migration
  removed for the SFW judges).

Invariant to preserve/prove: (a) sentinel ABSENT → still byte-identical to today (unchanged);
(b) sentinel PRESENT + null categories → prompt contains the four default rubric blocks + fixed
`RESPONSE_SCHEMA` (equivalent to the pre-migration prompt); (c) sentinel PRESENT + real categories →
those categories' rubrics + category schema (unchanged from Task 3).

Tests: cover (a)/(b)/(c). For (b), assert the migrated-prompt-with-null-categories message contains
`THEME SCORING`…`AESTHETIC SCORING` blocks AND the fixed `RESPONSE_SCHEMA` score keys, and contains
no unresolved `{{SCORING_RUBRICS}}`.

After this lands, update the header note in
`scripts/migrations/dynamic-judging-categories-judge-prompts.sql` to record that the code-side
prerequisite is satisfied.

Done: sentinel always resolves; migration is safe to apply; tests cover all three states.
