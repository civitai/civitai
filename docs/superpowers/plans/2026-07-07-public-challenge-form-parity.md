# Public Challenge Form Parity + Weighted Category Judging — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the public (user-created) challenge form reuse the moderator form via a `variant` prop, restrict its judge picker to CivBot/CivChan, replace open-text categories with a preset+custom **weighted** category picker (Theme mandatory + gated), and wire weighted category scoring end-to-end into the judging pipeline.

**Architecture:** One `ChallengeUpsertForm` gains `variant: 'moderator'|'user'`; the user page renders it with mod-only sections hidden and a user-only `CategoryWeights` section. The `judgingCategories` JSON column (already exists) stores `{key,label,criteria,weight}[]`; the review job passes those categories to the (already-scaffolded) `buildCategoryReviewSchema` for User-source challenges, and ranking scores them with a new theme-gated weighted function.

**Tech Stack:** Next.js 14 / TypeScript, Mantine v7, react-hook-form via `~/libs/form` `Input*` wrappers, zod, tRPC, Prisma (raw SQL for the un-slimmed columns), Vitest.

## Global Constraints

- **Feature is dark**: `userChallenges` flag = granted-only; `challengePlatform` gates the platform. No data migration for categories (JSON column) or judges (constant list).
- **Un-slimmed columns**: `Challenge.judgingCategories` (JSONB) + `Challenge.entryFee` exist in migration `20260706130000` but are **NOT** in `prisma/schema.prisma` — read them via **raw SQL** in the job, not `dbRead.challenge.findUnique`.
- **Theme is mandatory** for user challenges and its gate always applies: `THEME_DISQUALIFY_THRESHOLD=2` (→ null), `THEME_GATE_THRESHOLD=4` (→ cap at `THEME_GATE_MAX_SCORE=5.0`). Values live in `daily-challenge-scoring.ts`.
- **Judge gating by NAME**: `USER_SELECTABLE_JUDGE_NAMES = ['CivBot','CivChan']` (verified ids: CivBot 1/user 6235605, CivChan 2/user 7665867, "CivChan NSFW" 4/user 7665867 — excluded).
- **Category rules**: array `.min(1).max(4)`, exactly one `key:'theme'`, weights are integers summing to `100`.
- **Test runner is Vitest**: `pnpm vitest run <path>`. Never put tests under `src/pages`. Do not run prettier manually.
- **Score-shape divergence is the top risk**: for User-source challenges the review `score` becomes `Record<categoryLabel, number>` instead of `{theme,wittiness,humor,aesthetic}`. Every consumer of the score enumerated in Task 7 must tolerate it.

---

### Task 1: Constants — preset categories + selectable judges

**Files:**
- Modify: `src/shared/constants/challenge.constants.ts`

**Interfaces:**
- Produces: `CHALLENGE_PRESET_CATEGORIES` (record keyed by preset), `CHALLENGE_CATEGORY_KEYS` (tuple), `USER_SELECTABLE_JUDGE_NAMES` (tuple), `ChallengeCategoryKey` type.

- [ ] **Step 1: Add the constants** (append to the file, matching its existing `export const` style):

```ts
export const CHALLENGE_CATEGORY_KEYS = ['theme', 'humor', 'wittiness', 'aesthetic', 'custom'] as const;
export type ChallengeCategoryKey = (typeof CHALLENGE_CATEGORY_KEYS)[number];

// Preset judging categories offered in the public challenge form. Each carries the criteria the
// AI judge scores against. `theme` is mandatory (see the schema refine) and its gate always applies.
export const CHALLENGE_PRESET_CATEGORIES: Record<
  Exclude<ChallengeCategoryKey, 'custom'>,
  { label: string; criteria: string }
> = {
  theme: { label: 'Theme', criteria: 'How well the entry fits the challenge theme.' },
  humor: { label: 'Humor', criteria: 'How funny or amusing the entry is.' },
  wittiness: { label: 'Wittiness', criteria: 'Cleverness and wit of the concept.' },
  aesthetic: { label: 'Aesthetic', criteria: 'Overall visual quality and craft of the image.' },
};

// Judges a public-challenge creator may pick. Keyed on NAME (env-stable; excludes "CivChan NSFW",
// which shares CivChan's userId — public challenges are SFW-only).
export const USER_SELECTABLE_JUDGE_NAMES = ['CivBot', 'CivChan'] as const;
```

- [ ] **Step 2: Verify it compiles** — `pnpm run typecheck` (expect the Faro deps to be installed; 0 errors in this file).

- [ ] **Step 3: Commit**

```bash
git add src/shared/constants/challenge.constants.ts
git commit -m "feat(public-challenges): preset category + selectable-judge constants"
```

---

### Task 2: Category schema (weighted, Theme-mandatory) + wire into user upsert

**Files:**
- Modify: `src/server/schema/challenge.schema.ts` (replace `challengeJudgingCategorySchema` ~359-363; update `judgingCategories` in `userChallengeUpsertBaseSchema` ~365-384)
- Test: `src/server/schema/__tests__/challenge-category.schema.test.ts` (NOT under `src/pages`)

**Interfaces:**
- Consumes: `CHALLENGE_CATEGORY_KEYS` (Task 1).
- Produces: `challengeJudgingCategorySchema` (object), `challengeJudgingCategoriesSchema` (array), `ChallengeJudgingCategory` type `{ key: ChallengeCategoryKey; label: string; criteria: string; weight: number }`.

- [ ] **Step 1: Write the failing test**

```ts
// src/server/schema/__tests__/challenge-category.schema.test.ts
import { describe, it, expect } from 'vitest';
import { challengeJudgingCategoriesSchema } from '~/server/schema/challenge.schema';

const theme = { key: 'theme', label: 'Theme', criteria: 'fit', weight: 100 } as const;

describe('challengeJudgingCategoriesSchema', () => {
  it('accepts a single mandatory Theme at 100%', () => {
    expect(challengeJudgingCategoriesSchema.safeParse([theme]).success).toBe(true);
  });
  it('accepts Theme + up to 3 more summing to 100', () => {
    const cats = [
      { key: 'theme', label: 'Theme', criteria: 'fit', weight: 40 },
      { key: 'humor', label: 'Humor', criteria: 'funny', weight: 30 },
      { key: 'custom', label: 'Color', criteria: 'palette', weight: 30 },
    ];
    expect(challengeJudgingCategoriesSchema.safeParse(cats).success).toBe(true);
  });
  it('rejects when Theme is missing', () => {
    const cats = [{ key: 'humor', label: 'Humor', criteria: 'funny', weight: 100 }];
    expect(challengeJudgingCategoriesSchema.safeParse(cats).success).toBe(false);
  });
  it('rejects when weights do not sum to 100', () => {
    const cats = [{ key: 'theme', label: 'Theme', criteria: 'fit', weight: 90 }];
    expect(challengeJudgingCategoriesSchema.safeParse(cats).success).toBe(false);
  });
  it('rejects more than 4 categories', () => {
    const cats = [
      { key: 'theme', label: 'Theme', criteria: 'x', weight: 20 },
      { key: 'humor', label: 'Humor', criteria: 'x', weight: 20 },
      { key: 'wittiness', label: 'Wittiness', criteria: 'x', weight: 20 },
      { key: 'aesthetic', label: 'Aesthetic', criteria: 'x', weight: 20 },
      { key: 'custom', label: 'Extra', criteria: 'x', weight: 20 },
    ];
    expect(challengeJudgingCategoriesSchema.safeParse(cats).success).toBe(false);
  });
  it('rejects duplicate preset keys', () => {
    const cats = [
      { key: 'theme', label: 'Theme', criteria: 'x', weight: 50 },
      { key: 'theme', label: 'Theme', criteria: 'x', weight: 50 },
    ];
    expect(challengeJudgingCategoriesSchema.safeParse(cats).success).toBe(false);
  });
});
```

- [ ] **Step 2: Run it, expect fail** — `pnpm vitest run src/server/schema/__tests__/challenge-category.schema.test.ts` (fails: `challengeJudgingCategoriesSchema` not exported).

- [ ] **Step 3: Implement the schema** — replace the old `challengeJudgingCategorySchema` (~359-363) with:

```ts
import { CHALLENGE_CATEGORY_KEYS } from '~/shared/constants/challenge.constants'; // add to imports

export const challengeJudgingCategorySchema = z.object({
  key: z.enum(CHALLENGE_CATEGORY_KEYS),
  label: z.string().trim().min(1).max(50),
  criteria: z.string().trim().min(1).max(500),
  weight: z.number().int().min(1).max(100),
});
export type ChallengeJudgingCategory = z.infer<typeof challengeJudgingCategorySchema>;

export const challengeJudgingCategoriesSchema = z
  .array(challengeJudgingCategorySchema)
  .min(1)
  .max(4)
  .superRefine((cats, ctx) => {
    if (cats.filter((c) => c.key === 'theme').length !== 1)
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Theme is required exactly once' });
    const presetKeys = cats.filter((c) => c.key !== 'custom').map((c) => c.key);
    if (new Set(presetKeys).size !== presetKeys.length)
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Each preset category can be used once' });
    if (cats.reduce((s, c) => s + c.weight, 0) !== 100)
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Category weights must sum to 100%' });
  });
```

Update `userChallengeUpsertBaseSchema.judgingCategories` from
`z.array(challengeJudgingCategorySchema).min(1).max(8)` to `challengeJudgingCategoriesSchema`.

- [ ] **Step 4: Run tests, expect pass** — `pnpm vitest run src/server/schema/__tests__/challenge-category.schema.test.ts`.

- [ ] **Step 5: Commit**

```bash
git add src/server/schema/challenge.schema.ts src/server/schema/__tests__/challenge-category.schema.test.ts
git commit -m "feat(public-challenges): weighted judging-category schema (theme mandatory, sum=100)"
```

---

### Task 3: Weighted category scoring util (theme-gated)

**Files:**
- Modify: `src/server/games/daily-challenge/daily-challenge-scoring.ts` (add function; keep the existing `calculateWeightedScore`/`calculateCategoryScore`)
- Test: `src/server/games/daily-challenge/daily-challenge-scoring.test.ts` (append cases)

**Interfaces:**
- Produces: `calculateWeightedCategoryScore(scores: Record<string, number>, categories: { key: string; label: string; weight: number }[]): number | null`.

- [ ] **Step 1: Write failing tests** (append to the existing test file):

```ts
import { calculateWeightedCategoryScore } from './daily-challenge-scoring';

describe('calculateWeightedCategoryScore', () => {
  const cats = [
    { key: 'theme', label: 'Theme', weight: 50 },
    { key: 'humor', label: 'Humor', weight: 50 },
  ];
  it('weights by percentage', () => {
    expect(calculateWeightedCategoryScore({ Theme: 8, Humor: 4 }, cats)).toBeCloseTo(6);
  });
  it('disqualifies (null) when theme < 2 (matches daily rubric)', () => {
    expect(calculateWeightedCategoryScore({ Theme: 1, Humor: 10 }, cats)).toBeNull();
  });
  it('does NOT disqualify at exactly theme 2 (but caps at 5)', () => {
    expect(calculateWeightedCategoryScore({ Theme: 2, Humor: 10 }, cats)).toBe(5);
  });
  it('caps at 5 when theme < 4', () => {
    expect(calculateWeightedCategoryScore({ Theme: 3, Humor: 10 }, cats)).toBe(5);
  });
  it('clamps out-of-range category scores to 0-10', () => {
    expect(calculateWeightedCategoryScore({ Theme: 20, Humor: -5 }, cats)).toBeCloseTo(5);
  });
});
```

- [ ] **Step 2: Run, expect fail** — `pnpm vitest run src/server/games/daily-challenge/daily-challenge-scoring.test.ts`.

- [ ] **Step 3: Implement** (add below `calculateWeightedScore`; reuse the existing `THEME_*` constants):

```ts
/**
 * Ranking score for user-created challenges with weighted, creator-defined categories.
 * Scores are keyed by category LABEL (the key the AI review schema emits). Theme is mandatory,
 * so its gate rules always apply: theme <= disqualify → null; theme < gate → cap.
 */
export function calculateWeightedCategoryScore(
  scores: Record<string, number>,
  categories: { key: string; label: string; weight: number }[]
): number | null {
  const clamp = (v: number) => Math.min(10, Math.max(0, Number(v) || 0));
  const theme = categories.find((c) => c.key === 'theme');
  const themeScore = theme ? clamp(scores[theme.label]) : undefined;
  if (themeScore !== undefined && themeScore < THEME_DISQUALIFY_THRESHOLD) return null;
  const weighted = categories.reduce((sum, c) => sum + clamp(scores[c.label]) * (c.weight / 100), 0);
  if (themeScore !== undefined && themeScore < THEME_GATE_THRESHOLD)
    return Math.min(weighted, THEME_GATE_MAX_SCORE);
  return weighted;
}
```

> Note: matches the daily rubric exactly — `< THEME_DISQUALIFY_THRESHOLD` (theme 1 → null; theme 2 → not disqualified but capped at 5 since `2 < THEME_GATE_THRESHOLD`).

- [ ] **Step 4: Run, expect pass** — same command.

- [ ] **Step 5: Commit**

```bash
git add src/server/games/daily-challenge/daily-challenge-scoring.ts src/server/games/daily-challenge/daily-challenge-scoring.test.ts
git commit -m "feat(public-challenges): theme-gated weighted category scoring"
```

---

### Task 4: Restrict user judge picker to CivBot/CivChan

**Files:**
- Modify: `src/server/services/challenge.service.ts` — `getActiveJudgeOptions` (~1386-1392) and `upsertUserChallenge` judge validation (~1142-1149)

**Interfaces:**
- Consumes: `USER_SELECTABLE_JUDGE_NAMES` (Task 1).

- [ ] **Step 1: Filter the options** — in `getActiveJudgeOptions`, add the name filter and import the constant:

```ts
// import USER_SELECTABLE_JUDGE_NAMES from '~/shared/constants/challenge.constants'
where: { active: true, name: { in: [...USER_SELECTABLE_JUDGE_NAMES] } },
```

- [ ] **Step 2: Validate on submit** — in `upsertUserChallenge`, change the judge lookup to also require an allowed name and select `name`:

```ts
const judge = await dbRead.challengeJudge.findFirst({
  where: { id: judgeId, active: true, name: { in: [...USER_SELECTABLE_JUDGE_NAMES] } },
  select: { id: true },
});
if (!judge)
  throw new TRPCError({ code: 'BAD_REQUEST', message: 'Selected judge is not available.' });
```

- [ ] **Step 3: Verify** — `pnpm run typecheck` (0 errors in this file).

- [ ] **Step 4: Commit**

```bash
git add src/server/services/challenge.service.ts
git commit -m "feat(public-challenges): restrict user judge picker to CivBot/CivChan"
```

---

### Task 5: Pass categories into review generation for User-source challenges

**Files:**
- Modify: `src/server/games/daily-challenge/generative-content.ts` — `generateReview` (~268+): when `input.categories?.length`, bypass the reviewTemplate path so the category schema is used.
- Modify: `src/server/jobs/daily-challenge-processing.ts` — the challenge SELECT (~585-608) to also fetch `source` + `judgingCategories`; the `generateReview` call (~893) to pass `categories` for User-source.

**Interfaces:**
- Consumes: `GenerateReviewInput.categories?: {name;criteria}[]` (already exists), `buildCategoryReviewSchema` (already exists).

- [ ] **Step 1: Make the template path yield to categories** — in `generateReview`, guard the template branch so categories win:

```ts
// was: if (input.config.reviewTemplate) { ...template... }
if (input.config.reviewTemplate && !input.categories?.length) {
  // ...existing template path...
}
```
This routes User-source (categories present) through `buildFallbackMessages`, which already switches to `buildCategoryReviewSchema`.

- [ ] **Step 2: Fetch source + categories in the job** — extend the raw SQL SELECT at ~585-608 to add `"source"` and `"judgingCategories"` to both the column list and the TS row type. Parse `judgingCategories` (JSONB → array). It is `{key,label,criteria,weight}[]` for user challenges, else null.

- [ ] **Step 3: Pass categories to generateReview** — at the call ~893, when `challengeRecord.source === 'User'` and categories exist, add:

```ts
categories: userCategories?.map((c) => ({ name: c.label, criteria: c.criteria })),
```
(where `userCategories` is the parsed `judgingCategories`; `name` = category `label`, so the emitted score keys match the labels used by ranking in Task 6.)

- [ ] **Step 4: Verify** — `pnpm run typecheck`.

- [ ] **Step 5: Commit**

```bash
git add src/server/games/daily-challenge/generative-content.ts src/server/jobs/daily-challenge-processing.ts
git commit -m "feat(public-challenges): review user challenges with their weighted categories"
```

---

### Task 6: Source-aware winner ranking (weighted category for User challenges)

**Files:**
- Modify: `src/server/jobs/daily-challenge-processing.ts` — `getJudgedEntries` (SQL ~1446-1449 + JS ~1521-1532).

**Interfaces:**
- Consumes: `calculateWeightedCategoryScore` (Task 3), the parsed `judgingCategories` + `source` (Task 5).

- [ ] **Step 1: Read `getJudgedEntries` end-to-end** to see its inputs (challengeId, collectionId) and how it's called from `reviewEntriesForChallenge`. Thread the challenge `source` + parsed `categories` into it (add params).

- [ ] **Step 2: Branch by source.** For daily/mod (source !== 'User') keep the existing fixed-key SQL ordering + `calculateWeightedScore(score)` — unchanged. For User source:
  - Do **not** use the fixed-key SQL weighted expression (its keys are NULL). Instead select the entries with their raw `note` JSON (no SQL weighting), then in JS: parse `score`, compute `weightedRating = calculateWeightedCategoryScore(score, categories)`, drop `null`, pick the best entry per user (`Map<userId, bestEntry>`), sort by `weightedRating` desc, `slice(0, config.finalReviewAmount)`.

```ts
// User-source ranking sketch (inside getJudgedEntries)
const ranked = rawEntries
  .map((e) => {
    const { score, summary } = JSON.parse(e.note);
    return { ...e, summary, score, weightedRating: calculateWeightedCategoryScore(score, categories) };
  })
  .filter((e): e is typeof e & { weightedRating: number } => e.weightedRating !== null);
const bestPerUser = new Map<number, (typeof ranked)[number]>();
for (const e of ranked) {
  const cur = bestPerUser.get(e.userId);
  if (!cur || e.weightedRating > cur.weightedRating) bestPerUser.set(e.userId, e);
}
return [...bestPerUser.values()]
  .sort((a, b) => b.weightedRating - a.weightedRating)
  .slice(0, config.finalReviewAmount);
```

- [ ] **Step 3: Verify** — `pnpm run typecheck`. (No unit test harness for the job; correctness is covered by the scoring unit tests in Task 3 + manual verification in Task 11.)

- [ ] **Step 4: Commit**

```bash
git add src/server/jobs/daily-challenge-processing.ts
git commit -m "feat(public-challenges): rank user challenge winners by weighted category score"
```

---

### Task 7: Make score consumers tolerant of category-keyed scores

**Files:**
- Modify: `src/server/games/daily-challenge/daily-challenge.utils.ts` — `parseJudgeScore` (~413-421)
- Modify: `src/components/Image/JudgeScoreBadge/JudgeScoreBadge.tsx` (~14-19, 48, 125, 129)
- Modify: `src/components/Challenge/Playground/ReviewImageActivity.tsx` (~21-34) — widen `ReviewResult.score` type only

**Goal:** user-challenge feed images (category-keyed score) must not render `NaN`/`undefined` or crash. Full weighted-badge display is out of scope — degrade gracefully.

- [ ] **Step 1:** In `JudgeScoreBadge`, detect a category-keyed score: if the score object lacks the fixed `theme/wittiness/humor/aesthetic` keys, render the dynamic `Object.entries(score)` rows (0-10 each) and, since per-image weights aren't available, show the **mean** of present values as the headline (do not call `calculateWeightedScore`, which would return NaN). Keep the existing fixed path unchanged when the 4 keys are present.

- [ ] **Step 2:** In `ReviewImageActivity.tsx`, widen `ReviewResult.score` to `Record<string, number>` (rendering already uses `Object.entries` + `SCORE_COLORS[key] ?? 'blue'`, so no render change needed).

- [ ] **Step 3:** `parseJudgeScore` stays a passthrough but update its return type to `JudgeScore | Record<string, number> | null` so consumers are forced to handle both shapes.

- [ ] **Step 4: Verify** — `pnpm run typecheck` (fix any consumer the widened type surfaces; the Task-7 files are the known set).

- [ ] **Step 5: Commit**

```bash
git add src/server/games/daily-challenge/daily-challenge.utils.ts src/components/Image/JudgeScoreBadge/JudgeScoreBadge.tsx src/components/Challenge/Playground/ReviewImageActivity.tsx
git commit -m "fix(public-challenges): tolerate category-keyed judge scores in UI/parse"
```

---

### Task 8: `CategoryWeights` form component

**Files:**
- Create: `src/components/Challenge/CategoryWeights.tsx`

**Interfaces:**
- Consumes: `CHALLENGE_PRESET_CATEGORIES`, `CHALLENGE_CATEGORY_KEYS` (Task 1); react-hook-form context via `useFormContext` from `~/libs/form` (match how other `Input*` components read context).
- Produces: default export `CategoryWeights` that reads/writes a form field `judgingCategories: {key,label,criteria,weight}[]`.

- [ ] **Step 1: Build the component.** Behavior:
  - Theme row is always present, pre-selected, **not removable** (label "Theme", criteria from preset, weight editable).
  - "Add category" lets the user add up to 3 more rows; each row picks an unused preset (`humor`/`wittiness`/`aesthetic`) or `custom`.
  - Preset rows auto-fill `label`+`criteria` from `CHALLENGE_PRESET_CATEGORIES` (read-only criteria). Custom rows expose editable `label` (≤50) + `criteria` (≤500).
  - Each row has an integer weight `InputNumber` (0-100). Show a live total with a red hint when `≠ 100`.
  - Enforce max 4 rows total; disable "Add" at 4.
  - Write the assembled array to the `judgingCategories` form field on every change (use `useFormContext().setValue('judgingCategories', ...)`), and register it so RHF validation (the zod schema) runs on submit.

- [ ] **Step 2: Render check** — use the `component-preview` skill (Ladle) OR verify via typecheck + the manual run in Task 11. Confirm: Theme locked, add/remove works, total indicator flips at 100.

- [ ] **Step 3: Commit**

```bash
git add src/components/Challenge/CategoryWeights.tsx
git commit -m "feat(public-challenges): CategoryWeights form section (theme locked, weights=100)"
```

---

### Task 9: `ChallengeUpsertForm` gains `variant` prop

**Files:**
- Modify: `src/components/Challenge/ChallengeUpsertForm.tsx`

**Interfaces:**
- Consumes: `CategoryWeights` (Task 8); user constants + entry-fee helpers from `challenge.constants.ts`.
- Props become `{ challenge?: ChallengeForEdit; variant?: 'moderator' | 'user' }` (default `'moderator'`).

- [ ] **Step 1: Add the prop + derive `isUser = variant === 'user'`.**

- [ ] **Step 2: Gate mod-only sections** behind `!isUser` (JSX guards): Model Version Selection (425-432), Prizes Fixed-mode block + prizeMode toggle (mod keeps Fixed/Dynamic; user is Dynamic/entry-funded only), Event (766-782), Source (785-800), Paid Reviews (reviewCostType/reviewCost, 685-725), operationBudget. For `isUser`, `source` is forced `ChallengeSource.User`, `allowedNsfwLevel = sfwBrowsingLevelsFlag`, `modelVersionIds = []`.

- [ ] **Step 3: Add user-only sections** when `isUser`: an entry-fee section (`entryFee`, `initialPrizeBuzz`, prize `dist1/2/3` — reuse the existing distribution inputs) and `<CategoryWeights />`. Restrict the judge `InputSelect` data to `getJudgeOptions` (the already-restricted user query) when `isUser`; keep `getJudges` (mod) otherwise. Hide the `judgingPrompt` override for `isUser` (users can't reprompt).

- [ ] **Step 4: Branch the submit.** Extract the current mod payload build into the `!isUser` path. For `isUser`, build the `upsertUserChallenge` payload (title/description/theme/coverImage/judgeId/`judgingCategories`/`entryFee`/`initialPrizeBuzz`/`prizeDistribution`/`maxParticipants`/`maxEntriesPerUser`/`startsAt`/`endsAt`, forced SFW + empty models) and call `trpc.challenge.upsertUserChallenge`. Keep the schema `.superRefine`-free date/dist validation inline as the mod form already does.

- [ ] **Step 5: Verify** — `pnpm run typecheck`; confirm the mod form still compiles with `variant` defaulted.

- [ ] **Step 6: Commit**

```bash
git add src/components/Challenge/ChallengeUpsertForm.tsx
git commit -m "feat(public-challenges): ChallengeUpsertForm variant prop (moderator|user)"
```

---

### Task 10: Point the user page at the unified form

**Files:**
- Modify: `src/components/Challenge/UserChallengeUpsertForm.tsx` → becomes a thin wrapper (or delete + update the import in `src/pages/challenges/create.tsx`).

- [ ] **Step 1:** Replace the body of `UserChallengeUpsertForm` with `return <ChallengeUpsertForm variant="user" />;` (keep the export name so `create.tsx` import is unchanged), removing the now-dead local schema/fields.

- [ ] **Step 2: Verify** — `pnpm run typecheck`.

- [ ] **Step 3: Commit**

```bash
git add src/components/Challenge/UserChallengeUpsertForm.tsx
git commit -m "feat(public-challenges): user create page uses unified ChallengeUpsertForm"
```

---

### Task 11: End-to-end verification

**Files:** none (verification only)

- [ ] **Step 1:** `pnpm run typecheck` — 0 errors.
- [ ] **Step 2:** `pnpm vitest run src/server/schema/__tests__/challenge-category.schema.test.ts src/server/games/daily-challenge/daily-challenge-scoring.test.ts` — all pass.
- [ ] **Step 3:** Use the `dev-server` skill to run the app; as a granted user open `/challenges/create`. Confirm: layout mirrors the mod form; judge picker shows only CivBot + CivChan; Theme row is locked; adding categories + weights enforces sum=100; submit creates a Scheduled user challenge.
- [ ] **Step 4:** Sanity-check the moderator form (`/moderator/challenges/create`) still renders + submits unchanged (variant defaults to moderator).
- [ ] **Step 5:** Optionally exercise judging via the testing endpoints / a manual `reviewEntriesForChallenge` run on a seeded user challenge and confirm the review uses category keys and ranking respects weights + the theme gate.

---

## Self-Review notes

- **Spec coverage:** form parity (T8-10), judge restriction (T4), preset+weighted categories (T1,T2,T8), theme mandatory+gate (T2,T3), end-to-end judging (T5,T6), consumer robustness (T7). ✓
- **Score-shape risk:** every consumer from the investigation is addressed in T7; ranking in T6; generation in T5.
- **Threshold parity:** Task 3 uses `< THEME_DISQUALIFY_THRESHOLD` (identical to daily `calculateWeightedScore`).
