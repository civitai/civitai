# Public Challenge Form Parity + Weighted Category Judging

**Date:** 2026-07-07
**Branch:** `feat/public-challenges`
**Status:** Approved (design decisions locked via brainstorming)

## Problem

The public (user-created) challenge form (`UserChallengeUpsertForm`) diverged from the
moderator challenge form (`ChallengeUpsertForm`): different layout, open-text judging
categories, and any active judge selectable. Additionally, the judging categories field is
**dead** — `judgingCategories` is written to the challenge but never read; user challenges are
still AI-judged by the fixed daily rubric (`theme/wittiness/humor/aesthetic` + hardcoded
`SCORE_WEIGHTS`), so creator-defined categories have no effect on scoring.

## Goals

1. Reuse the moderator form: one `ChallengeUpsertForm` with a `variant: 'moderator' | 'user'`.
2. Restrict the user form's judge picker to **CivBot** and **CivChan** only.
3. Replace open-text categories with a **preset + custom** picker with **percentage weights**:
   - **Theme is mandatory** and always applied (its daily gate/floor carries over).
   - Up to **4 categories total**: Theme + up to 3 more from `{humor, wittiness, aesthetic, custom}`.
   - Each category has an integer weight; weights **sum to 100%**.
4. **Wire weighted category judging end-to-end** so the review is actually weighted by the
   creator's percentages (currently unwired).

## Non-goals

- No change to moderator/daily challenge judging (fixed rubric path stays as-is).
- No DB migration for judges (constant list). Category shape is a JSON column (no migration).
- Feature is dark (`userChallenges` = granted-only) → assume no existing `{name,criteria}`
  category data to migrate; ship the new shape directly.

## Decisions (locked)

| # | Decision | Choice |
|---|----------|--------|
| 1 | Scope | Full end-to-end (form + schema + judging pipeline) |
| 2 | Category model | ≤4 total, Theme mandatory, mix of presets + custom, weights=100 |
| 3 | Theme | Always present + **theme gate always applies**; others bias only |
| 4 | Judge gating | Constant list keyed on judge **name** (env-safe; excludes CivChan NSFW) |
| 5 | Form | Single `ChallengeUpsertForm` with `variant` prop |

## Design

### A. Category data model

Replace `challengeJudgingCategorySchema` in `src/server/schema/challenge.schema.ts`:

```ts
export const CHALLENGE_CATEGORY_KEYS = ['theme', 'humor', 'wittiness', 'aesthetic', 'custom'] as const;

export const challengeJudgingCategorySchema = z.object({
  key: z.enum(CHALLENGE_CATEGORY_KEYS),
  label: z.string().trim().min(1).max(50),    // preset label, or user text for custom
  criteria: z.string().trim().min(1).max(500),// preset criteria auto-filled; user text for custom
  weight: z.number().int().min(1).max(100),
});

export const challengeJudgingCategoriesSchema = z
  .array(challengeJudgingCategorySchema)
  .min(1).max(4)
  .superRefine((cats, ctx) => {
    // exactly one Theme (mandatory, always applied)
    if (cats.filter((c) => c.key === 'theme').length !== 1)
      ctx.addIssue({ code: 'custom', message: 'Theme is required and can only be selected once' });
    // preset keys unique (custom may repeat); custom labels unique/non-empty
    // weights sum to 100
    if (cats.reduce((s, c) => s + c.weight, 0) !== 100)
      ctx.addIssue({ code: 'custom', message: 'Category weights must sum to 100%' });
  });
```

`userChallengeUpsertBaseSchema.judgingCategories` uses `challengeJudgingCategoriesSchema`.

**Preset constant** (`src/shared/constants/challenge.constants.ts`):
```ts
export const CHALLENGE_PRESET_CATEGORIES = {
  theme:     { label: 'Theme',     criteria: 'How well the entry fits the challenge theme.' },
  humor:     { label: 'Humor',     criteria: 'How funny or amusing the entry is.' },
  wittiness: { label: 'Wittiness', criteria: 'Cleverness and wit of the concept.' },
  aesthetic: { label: 'Aesthetic', criteria: 'Overall visual quality and craft of the image.' },
} as const;
```

### B. Judge gating

`src/shared/constants/challenge.constants.ts`:
```ts
// Judges a public-challenge creator may pick. Keyed on judge NAME, not id/userId:
//  - autoincrement ChallengeJudge.id differs per environment (dev vs prod)
//  - CivChan and "CivChan NSFW" share userId 7665867, and public challenges are SFW-only,
//    so a userId filter would wrongly expose the NSFW judge.
// Name is the stable, seeded, SFW-correct identifier. (Verified: CivBot id=1 userId=6235605,
// CivChan id=2 userId=7665867, "CivChan NSFW" id=4 userId=7665867.)
export const USER_SELECTABLE_JUDGE_NAMES = ['CivBot', 'CivChan'] as const;
```

- `getActiveJudgeOptions` (`challenge.service.ts`): `where: { active: true, name: { in: USER_SELECTABLE_JUDGE_NAMES } }`.
- `upsertUserChallenge` judge validation: also assert the chosen judge's `name` is in the
  allowed set (defense-in-depth; client can't smuggle another judgeId).

### C. Unified form (`variant` prop)

`ChallengeUpsertForm` gains `variant: 'moderator' | 'user'` (default `'moderator'`).
`UserChallengeUpsertForm` → `<ChallengeUpsertForm variant="user" />` thin wrapper.

- **Mod-only** (`variant === 'moderator'`): Source, Event, Eligible Models multiselect,
  Content Rating, Fixed prize mode, operationBudget/maxReviews, active/terminal field-locks.
- **User-only** (`variant === 'user'`): entry-fee section (fee + initial prize + distribution,
  Dynamic/entry-funded), `<CategoryWeights />`, restricted judge picker, forced SFW,
  `modelVersionIds: []`.
- **Shared**: Basics (title/theme/cover/description), Schedule pickers, prize distribution input.
- **Submit branches**: `variant === 'user'` → `upsertUserChallenge`; else → `upsert`.
- Extract `CategoryWeights` (user-only) as its own component: Theme row is pre-selected +
  locked (can't remove); up to 3 more rows addable from `{humor, wittiness, aesthetic, custom}`;
  each row has a weight input; live "must total 100%" indicator; custom rows expose label +
  criteria text inputs.

### D. Judging pipeline wiring (weighted, theme-gated)

**Scoring util** (`daily-challenge-scoring.ts`) — new, replaces the unused equal-weight
`calculateCategoryScore`:
```ts
export function calculateWeightedCategoryScore(
  scores: Record<string, number>,
  categories: { key: string; label: string; weight: number }[]
): number | null {
  const clamp = (v: number) => Math.min(10, Math.max(0, Number(v) || 0));
  const theme = categories.find((c) => c.key === 'theme');
  const themeScore = theme ? clamp(scores[theme.label]) : undefined;
  // Theme gate ALWAYS applies (theme is mandatory for user challenges).
  if (themeScore !== undefined && themeScore < THEME_DISQUALIFY_THRESHOLD) return null;
  const weighted = categories.reduce((s, c) => s + clamp(scores[c.label]) * (c.weight / 100), 0);
  if (themeScore !== undefined && themeScore < THEME_GATE_THRESHOLD)
    return Math.min(weighted, THEME_GATE_MAX_SCORE);
  return weighted;
}
```

**Review generation** (`daily-challenge-processing.ts:~893`, `challenge.service.ts:~2478`):
for a **User-source** challenge, pass `categories: challenge.judgingCategories` to
`generateReview` → `buildCategoryReviewSchema` emits one `0-10` score per category **label**.
Stored review `score` becomes `Record<label, number>` for user challenges.

**Winner ranking** (`daily-challenge-processing.ts:~1525`): branch on challenge source —
User → `calculateWeightedCategoryScore(score, categories)`; daily/mod → `calculateWeightedScore(score)`.

**Score-consumer audit (REQUIRED):** every reader of the review `score` / `weightedRating`
must handle the user-challenge per-category shape. Known/suspected consumers to trace:
- winner ranking (`daily-challenge-processing.ts:1525`)
- entry-prize eligibility threshold (`challenge-prize.ts` — score ≥ threshold)
- image display badge (`JudgeScoreBadge`) / any UI showing the fixed 4 sub-scores
- `sort_at` / entry metrics if they read the score
The plan includes a dedicated tracing task; any consumer assuming the fixed 4 keys must be
made source-aware or degrade gracefully.

### E. Edit mode / back-compat

- Category edit stays behind the existing lock (Scheduled + 0 entries).
- Dark feature → no data migration. If a stale `{name,criteria}` row is ever encountered by
  scoring, treat a missing weight as excluded (defensive), but do not build UI for it.

## Testing

- Schema: category refine (theme required, ≤4, sum=100, custom label rules) — vitest.
- Scoring: `calculateWeightedCategoryScore` — theme disqualify/gate/cap + weighting math.
- Form: user variant renders restricted judge list + CategoryWeights; mod variant unchanged.
- Pipeline: user-source review passes categories; ranking uses weighted category score.

## Risks

- **Score-shape divergence** (per-category vs fixed 4) is the main risk — a missed consumer
  crashes or mis-ranks. Mitigated by the audit task + source-aware branching + defensive clamps.
- Single `variant` component grows large; mitigated by extracting `CategoryWeights` and keeping
  mod-only sections behind clear guards.
