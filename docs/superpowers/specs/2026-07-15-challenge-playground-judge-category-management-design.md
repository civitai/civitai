# Challenge Playground: Judge & Category Management

**Date**: 2026-07-15
**Status**: Approved (design)
**Feature**: Make challenge judges toggleable to users, and add judging-category CRUD, both from the moderator playground (`/moderator/challenges/playground`).

## Background

From a feedback session (Justin ↔ Manuel), one of the agreed future improvements to the challenge platform: give moderators a way to (a) turn individual AI judges on/off for user-created challenges without a code change, and (b) manage the judging-category library (categories + their scoring-rubric prompts) from the same playground instead of editing the DB directly.

Today:

- **Judge visibility** is a hardcoded name whitelist — `USER_SELECTABLE_JUDGE_NAMES = ['CivBot', 'CivChan']` (`src/shared/constants/challenge.constants.ts:157`). Applied in `getActiveJudges` (`challenge.service.ts:2479`, non-moderator branch) and re-checked as a write backstop in `upsertUserChallenge` (`challenge.service.ts:~1384`). There is **no** `public`/`userSelectable` column on `ChallengeJudge`; only `active`.
- **Categories** (`ChallengeCategory`) have **no CRUD tRPC/UI**. Rows + rich `rubric`/`rubricNsfw` prompt text are seeded via gitignored SQL per environment. `challenge-category.service.ts` reads them with a 5-min in-process cache and a preset-constant fallback.
- The **playground** (`/moderator/challenges/playground` → `PlaygroundPage.tsx`) is a moderator-only 3-panel page: `JudgeListPanel` (left) | `ActivityPanel` (center) | `JudgeSettingsPanel` (right). Judge create/edit already flows through `challenge.upsertJudge`.

## Goals

1. **Part A** — DB-driven judge user-selectability, toggled from the playground, replacing the hardcoded whitelist as the primary source with the whitelist retained as a safety fallback.
2. **Part B** — Category CRUD (list/create/edit/soft-hide) from a new "Categories" tab in the playground, including the server-only rubric prompt text.

## Non-goals (v1)

- Hard-delete of categories (soft-hide via `active` only).
- Drag-to-reorder UI (edit the integer `sortOrder` field directly).
- Per-judge NSFW rubric assignment; historical challenge backfill.
- Rich-text rubric editor (plain `Textarea`).

---

## Part A — Judge "user-selectable" toggle

### Data model
Add to `ChallengeJudge` (edit `packages/civitai-db-schema/prisma/schema.full.prisma`, then `pnpm run db:generate` — never edit the slim schema):

```prisma
userSelectable Boolean @default(false)
```

Committed migration (`prisma/migrations/<ts>_challenge_judge_user_selectable/migration.sql`) adds the column. A **manual seed** must run per environment (migrations are applied by hand here — surface to the user):

```sql
UPDATE "ChallengeJudge" SET "userSelectable" = true WHERE name IN ('CivBot', 'CivChan');
```

### Read path — `getActiveJudges` (non-moderator branch)
```
rows = dbRead.challengeJudge.findMany({ where: { active: true, userSelectable: true }, ... })
if (rows.length === 0)
  rows = dbRead.challengeJudge.findMany({ where: { active: true, name: { in: USER_SELECTABLE_JUDGE_NAMES } }, ... })
```
The empty→whitelist fallback guarantees the user create form never shows zero judges during a rollout where an env hasn't applied the seed. Moderator branch (all `active` judges) is unchanged.

### Write path — `upsertUserChallenge` backstop
Replace the direct whitelist re-query with a check against the **same resolved user-selectable set** that the read path returns (call the shared resolver / `getActiveJudges({ isModerator: false })` and assert the chosen `judgeId` is a member). This keeps read and write in lockstep — a judge that appears in the picker is exactly a judge that passes the backstop, including under the fallback.

### Schema / service
- `upsertJudgeSchema` (`challenge.schema.ts:613`): add `userSelectable: z.boolean().optional()`.
- `upsertJudge` (`challenge.service.ts:2898`): write `userSelectable` in both `create` (default `false`) and `update` (guarded by `!== undefined`).
- `getJudgeById` (`challenge.service.ts:2872`): add `userSelectable: true` to `select`.

### UI
- `JudgeSettingsPanel.tsx` + `CreateJudgeModal.tsx`: add a Mantine `Switch` "Selectable by users", bound to the draft store, persisted via `upsertJudge`.
- `getActiveJudges` is uncached (direct `dbRead`), so no Redis/cache bust is needed for the toggle to take effect.

### Keep
`USER_SELECTABLE_JUDGE_NAMES` stays — it is now the documented fallback seed list, not dead code.

---

## Part B — Category management tab

### Layout
Wrap `PlaygroundPage` content in a tab switcher: **Judges** (the existing 3-panel layout, untouched) | **Categories**. Persist the active tab in a `?tab=` query param. The mod/feature gating in `PlaygroundPage` stays as-is and covers both tabs.

### Categories tab
Mirror the judge pattern:
- `CategoryListPanel` (left) — lists categories from a new moderator query, "Add Category" button, active/inactive indicator.
- `CategorySettingsPanel` (right) — edit form for the selected/new category, using a draft-store pattern like `JudgeSettingsPanel`.

### tRPC (moderatorProcedure) + service
- `challenge.getChallengeCategories` → new service fn returning **full** rows (`key,label,group,criteria,rubric,rubricNsfw,sortOrder,active`). Reads `dbRead` **fresh** (bypasses the 5-min public cache — moderators need current state; rubric text is mod-only and must not leak to the public `getJudgingCategories`).
- `challenge.upsertChallengeCategory` → `dbWrite.challengeCategory.upsert({ where: { key }, create, update })`, then `clearChallengeCategoryCache()` so the picker/resolver see the change within-process immediately.

### Schema — `upsertChallengeCategorySchema`
```
key:        z.string().trim().min(1).max(50)   // PK; immutable on edit (create-only)
label:      z.string().min(1).max(100)
group:      z.string().min(1).max(50)
criteria:   z.string().min(1).max(500)          // client-visible one-liner
rubric:     z.string().optional().nullable()    // server-only rich scoring block
rubricNsfw: z.string().optional().nullable()    // server-only NSFW override
sortOrder:  z.number().int().default(0)
active:     z.boolean().default(true)
```
New keys are free-form: the per-challenge input schema validates `key` against the DB library at resolve time (`challengeJudgingCategoryInputSchema`, no static enum), so a newly created active category becomes user-pickable with no other code change.

### Guards
- Reject `active: false` (and any future delete) on the `theme` category — every challenge's `judgingCategories` requires exactly one `theme` (`judgingCategoryRefinements`); deactivating it would break `resolveJudgingCategories` for all new challenges.
- On edit, `key` is not mutable (it's the PK and the join key on stored `Challenge.judgingCategories`).

### Cache caveat
`clearChallengeCategoryCache()` clears the **in-process** module cache only. Other server instances pick up changes within the existing 5-min TTL. Acceptable for a moderator config surface; called out so it isn't mistaken for a bug.

---

## Testing

**Unit**
- `getActiveJudges`: non-mod with ≥1 `userSelectable` returns exactly those; with none, falls back to the name whitelist.
- `upsertUserChallenge` backstop: accepts a judge that is in the resolved user-selectable set (incl. via fallback), rejects one that isn't — parity with the read path.
- `upsertChallengeCategory`: upsert writes rows and busts the cache; `theme` deactivation is rejected.

**Manual**
- Playground: toggle "Selectable by users" on a non-whitelisted active judge → it appears in the user create-form judge picker; toggle off → gone.
- Categories tab: create a new active category → it appears in the user create-form `CategoryWeights` picker and is selectable; edit its rubric → judging uses it (sentinel-migrated env).

## Operations
- The `userSelectable` column migration is **applied manually per environment** (repo convention). Ship the committed migration + the `UPDATE ... WHERE name IN ('CivBot','CivChan')` seed, and surface both for preview/staging/prod apply.
- **Resilience scope — user create form only.** The whitelist fallback in `getUserSelectableJudges` (try/catch on the `userSelectable` column) keeps the *user* create form and the `upsertUserChallenge` backstop working before the migration is applied. It does **not** cover the moderator playground: `getJudgeById` selects `userSelectable` and `upsertJudge` writes it, so those hard-depend on the column. **The `userSelectable` `ALTER TABLE` must land with or before the deploy for the judge playground to load/save judges** — treat it as a deploy-ordering requirement, not a fully-degrading path.
