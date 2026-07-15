# Challenge Playground Judge & Category Management Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let moderators toggle which AI judges are user-selectable and CRUD the judging-category library (incl. rubric prompts) from the challenge playground, replacing hardcoded/SQL-only management.

**Architecture:** Part A adds a `userSelectable` boolean to `ChallengeJudge`, resolved through a small lazy-import module (`challenge-judge.service.ts`) shared by the read path (`getActiveJudges`) and the write backstop (`upsertUserChallenge`) so the two stay in lockstep; an empty→name-whitelist fallback keeps the user form from ever showing zero judges. Part B adds a moderator-only tRPC CRUD surface + a "Categories" tab in the existing playground, reading/writing `ChallengeCategory` and busting the 5-min category cache on write.

**Tech Stack:** Next.js 14, tRPC, Prisma (Postgres), Mantine v7, Zustand, Vitest.

## Global Constraints

- Prisma schema edits go in `packages/civitai-db-schema/prisma/schema.full.prisma`, then `pnpm run db:generate`. NEVER edit the slim `schema.prisma`.
- Migrations are applied **manually per environment** — never `prisma migrate deploy`. Ship the SQL and surface it for manual apply.
- Test runner is **Vitest**: `pnpm vitest run <path>`. Never place test files under `src/pages`.
- Judge `reviewPrompt`/`userId` must never reach non-moderators (gaming risk) — gate on real `ctx.user.isModerator`, never a client flag.
- Category `rubric`/`rubricNsfw` are server-only prompt content — expose them ONLY through moderator procedures, never the public `getJudgingCategories`.
- Keep the `USER_SELECTABLE_JUDGE_NAMES` constant (`src/shared/constants/challenge.constants.ts:157`) — it is the rollout fallback list.
- Form fields use `Input*` wrappers from `~/libs/form` only inside RHF forms; the playground panels use plain Mantine components with local state (existing playground pattern), so plain Mantine `Switch`/`TextInput`/`Textarea` are correct there.

---

## Task 1: Add `userSelectable` column to `ChallengeJudge`

**Files:**
- Modify: `packages/civitai-db-schema/prisma/schema.full.prisma` (`ChallengeJudge` model)
- Create: `prisma/migrations/20260715000000_challenge_judge_user_selectable/migration.sql`

**Interfaces:**
- Produces: `ChallengeJudge.userSelectable: boolean` (Prisma + `packages/civitai-db-schema/src/models.ts` after generate).

- [ ] **Step 1: Add the field to the full schema**

In the `ChallengeJudge` model in `schema.full.prisma`, add alongside `active`:

```prisma
  userSelectable Boolean @default(false)
```

- [ ] **Step 2: Regenerate the slim schema + client + models**

Run: `pnpm run db:generate`
Expected: no error; `packages/civitai-db-schema/src/models.ts` `ChallengeJudge` interface now includes `userSelectable: boolean`.

- [ ] **Step 3: Write the committed migration SQL**

Create `prisma/migrations/20260715000000_challenge_judge_user_selectable/migration.sql`:

```sql
-- ChallengeJudge.userSelectable: DB-driven "offer this judge to users in the create form".
-- Applied manually per environment. Seed the two historically-whitelisted judges so the
-- switch to a DB-driven filter is behaviour-preserving; the app also falls back to the
-- USER_SELECTABLE_JUDGE_NAMES name whitelist when no row has userSelectable = true.
ALTER TABLE "ChallengeJudge" ADD COLUMN "userSelectable" BOOLEAN NOT NULL DEFAULT false;

UPDATE "ChallengeJudge" SET "userSelectable" = true WHERE name IN ('CivBot', 'CivChan');
```

- [ ] **Step 4: Commit**

```bash
git add packages/civitai-db-schema/prisma/schema.full.prisma packages/civitai-db-schema/prisma/schema.prisma packages/civitai-db-schema/src/models.ts prisma/migrations/20260715000000_challenge_judge_user_selectable/migration.sql
git commit -m "feat(challenges): add ChallengeJudge.userSelectable column + migration"
```

---

## Task 2: `getUserSelectableJudges()` resolver + tests

**Files:**
- Create: `src/server/services/challenge-judge.service.ts`
- Test: `src/server/services/__tests__/challenge-judge.service.test.ts`

**Interfaces:**
- Produces: `getUserSelectableJudges(): Promise<UserSelectableJudge[]>` where `UserSelectableJudge = { id: number; name: string; bio: string | null }`. Returns judges with `active && userSelectable`; if none, falls back to `active && name ∈ USER_SELECTABLE_JUDGE_NAMES`.

- [ ] **Step 1: Write the failing test**

Create `src/server/services/__tests__/challenge-judge.service.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest';

const findMany = vi.fn();
vi.mock('~/server/db/client', () => ({
  dbRead: { challengeJudge: { findMany: (...args: unknown[]) => findMany(...args) } },
}));

import { getUserSelectableJudges } from '~/server/services/challenge-judge.service';

beforeEach(() => findMany.mockReset());

describe('getUserSelectableJudges', () => {
  it('returns active userSelectable judges when any exist (single query)', async () => {
    findMany.mockResolvedValueOnce([{ id: 1, name: 'CivBot', bio: null }]);
    const res = await getUserSelectableJudges();
    expect(res).toEqual([{ id: 1, name: 'CivBot', bio: null }]);
    expect(findMany).toHaveBeenCalledTimes(1);
    expect(findMany.mock.calls[0][0].where).toEqual({ active: true, userSelectable: true });
  });

  it('falls back to the name whitelist when no judge is userSelectable', async () => {
    findMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ id: 2, name: 'CivChan', bio: 'hi' }]);
    const res = await getUserSelectableJudges();
    expect(res).toEqual([{ id: 2, name: 'CivChan', bio: 'hi' }]);
    expect(findMany).toHaveBeenCalledTimes(2);
    expect(findMany.mock.calls[1][0].where.name.in).toEqual(
      expect.arrayContaining(['CivBot', 'CivChan'])
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/server/services/__tests__/challenge-judge.service.test.ts`
Expected: FAIL — cannot resolve `~/server/services/challenge-judge.service`.

- [ ] **Step 3: Write the implementation**

Create `src/server/services/challenge-judge.service.ts`:

```ts
import { USER_SELECTABLE_JUDGE_NAMES } from '~/shared/constants/challenge.constants';

export type UserSelectableJudge = { id: number; name: string; bio: string | null };

// The set of judges offered to non-moderators in the challenge create form. Primary source is the
// ChallengeJudge.userSelectable column; when an environment has not yet applied/seeded that column
// (migrations are manual here) NO row is userSelectable, so we fall back to the historical name
// whitelist — the user form must never render zero judges. dbRead is imported lazily so this module
// (and its unit test) stays out of the full server module graph.
export async function getUserSelectableJudges(): Promise<UserSelectableJudge[]> {
  const { dbRead } = await import('~/server/db/client');
  const select = { id: true, name: true, bio: true } as const;
  const orderBy = { name: 'asc' } as const;

  const selectable = await dbRead.challengeJudge.findMany({
    where: { active: true, userSelectable: true },
    orderBy,
    select,
  });
  if (selectable.length) return selectable;

  return dbRead.challengeJudge.findMany({
    where: { active: true, name: { in: [...USER_SELECTABLE_JUDGE_NAMES] } },
    orderBy,
    select,
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/server/services/__tests__/challenge-judge.service.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/server/services/challenge-judge.service.ts src/server/services/__tests__/challenge-judge.service.test.ts
git commit -m "feat(challenges): userSelectable judge resolver with whitelist fallback"
```

---

## Task 3: Route `getActiveJudges` (non-moderator) through the resolver

**Files:**
- Modify: `src/server/services/challenge.service.ts` (`getActiveJudges`, ~line 2479; imports near top)

**Interfaces:**
- Consumes: `getUserSelectableJudges` from Task 2.

- [ ] **Step 1: Import the resolver**

Near the other `~/server/services/*` imports at the top of `challenge.service.ts`, add:

```ts
import { getUserSelectableJudges } from '~/server/services/challenge-judge.service';
```

- [ ] **Step 2: Replace the non-moderator branch body**

In `getActiveJudges`, replace the non-moderator query block (currently the `dbRead.challengeJudge.findMany({ where: { active: true, name: { in: [...USER_SELECTABLE_JUDGE_NAMES] } }, ... })` and its `.map`) with:

```ts
  const rows = await getUserSelectableJudges();
  return rows.map((r) => ({ ...r, userId: null, reviewPrompt: null }));
```

Leave the moderator branch (all `active` judges + sensitive fields) unchanged.

- [ ] **Step 3: Verify types**

Run: `pnpm run typecheck`
Expected: completes with no new errors in `challenge.service.ts`. (`USER_SELECTABLE_JUDGE_NAMES` may now be unused in this file — if the linter/typecheck flags it, remove only its import from `challenge.service.ts`; the constant itself stays defined and is used by the resolver + backstop.)

- [ ] **Step 4: Commit**

```bash
git add src/server/services/challenge.service.ts
git commit -m "feat(challenges): getActiveJudges resolves user judges via userSelectable"
```

---

## Task 4: Route the `upsertUserChallenge` judge backstop through the resolver

**Files:**
- Modify: `src/server/services/challenge.service.ts` (`upsertUserChallenge`, ~lines 1383-1388)

**Interfaces:**
- Consumes: `getUserSelectableJudges` from Task 2 (imported in Task 3).

- [ ] **Step 1: Replace the backstop query**

Replace:

```ts
  const judge = await dbRead.challengeJudge.findFirst({
    where: { id: judgeId, active: true, name: { in: [...USER_SELECTABLE_JUDGE_NAMES] } },
    select: { id: true },
  });
  if (!judge) throw new TRPCError({ code: 'BAD_REQUEST', message: 'Selected judge is not available.' });
```

with:

```ts
  // Read/write parity: the judge must be in exactly the set the user picker offered (Task 2),
  // including the whitelist fallback — never a separate query that could drift from the form.
  const selectableJudges = await getUserSelectableJudges();
  if (judgeId != null && !selectableJudges.some((j) => j.id === judgeId))
    throw new TRPCError({ code: 'BAD_REQUEST', message: 'Selected judge is not available.' });
```

- [ ] **Step 2: Verify types**

Run: `pnpm run typecheck`
Expected: no new errors.

- [ ] **Step 3: Commit**

```bash
git add src/server/services/challenge.service.ts
git commit -m "feat(challenges): upsertUserChallenge judge backstop uses userSelectable resolver"
```

---

## Task 5: Persist `userSelectable` through the judge upsert API

**Files:**
- Modify: `src/server/schema/challenge.schema.ts` (`upsertJudgeSchema`, ~line 613)
- Modify: `src/server/services/challenge.service.ts` (`upsertJudge` ~line 2914, `getJudgeById` ~line 2872)

**Interfaces:**
- Produces: `upsertJudgeSchema` accepts `userSelectable?: boolean`; `getJudgeById` returns `userSelectable`.

- [ ] **Step 1: Add the field to the schema**

In `upsertJudgeSchema`, add after `active: z.boolean().optional(),`:

```ts
  userSelectable: z.boolean().optional(),
```

- [ ] **Step 2: Write it in `upsertJudge`**

In `upsertJudge`, add to the `create` object (after `active: data.active ?? true,`):

```ts
      userSelectable: data.userSelectable ?? false,
```

and to the `update` object (alongside the other guarded spreads):

```ts
      ...(data.userSelectable !== undefined && { userSelectable: data.userSelectable }),
```

- [ ] **Step 3: Return it from `getJudgeById`**

In `getJudgeById`'s `select`, add:

```ts
      userSelectable: true,
```

- [ ] **Step 4: Verify types**

Run: `pnpm run typecheck`
Expected: no new errors.

- [ ] **Step 5: Commit**

```bash
git add src/server/schema/challenge.schema.ts src/server/services/challenge.service.ts
git commit -m "feat(challenges): read/write userSelectable through judge upsert API"
```

---

## Task 6: Playground UI — "Selectable by users" switch

**Files:**
- Modify: `src/components/Challenge/Playground/playground.store.ts` (judge draft type + defaults)
- Modify: `src/components/Challenge/Playground/JudgeSettingsPanel.tsx`
- Modify: `src/components/Challenge/Playground/CreateJudgeModal.tsx`

**Interfaces:**
- Consumes: `upsertJudge`/`getJudgeById` `userSelectable` from Task 5.

- [ ] **Step 1: Add `userSelectable` to the judge draft store**

In `playground.store.ts`, add `userSelectable: boolean` to the judge draft/settings type and default it to `false` wherever a blank judge draft is initialized, and include it where the store hydrates from `getJudgeById`.

- [ ] **Step 2: Add the Switch to `JudgeSettingsPanel`**

Import `Switch` from `@mantine/core` (add to the existing import if not present). Near the `active` control (or the top of the settings form), render:

```tsx
<Switch
  label="Selectable by users"
  description="Show this judge in the user challenge-create form"
  checked={draft.userSelectable ?? false}
  onChange={(e) => setDraft({ userSelectable: e.currentTarget.checked })}
/>
```

(Use the panel's existing draft getter/setter names — match how the `active`/`bio` fields are wired in this file.) Ensure `userSelectable` is included in the object passed to the `upsertJudge` mutation on save.

- [ ] **Step 3: Add the Switch to `CreateJudgeModal`**

Mirror Step 2 in `CreateJudgeModal.tsx`: add local form state `userSelectable` (default `false`), render the same `Switch`, and include `userSelectable` in the `upsertJudge` payload.

- [ ] **Step 4: Manual verification**

Start the dev server (via the `/dev-server` skill). As a moderator, open `/moderator/challenges/playground`:
1. Toggle "Selectable by users" ON for an active judge that is NOT `CivBot`/`CivChan`, save. In a second tab, open the user challenge-create form (`/challenges/create`) and confirm the judge now appears in the judge picker.
2. Toggle it OFF, save, reload the create form → judge is gone (and the two seeded judges remain, via the DB rows or the fallback).
Expected: both hold.

- [ ] **Step 5: Commit**

```bash
git add src/components/Challenge/Playground/playground.store.ts src/components/Challenge/Playground/JudgeSettingsPanel.tsx src/components/Challenge/Playground/CreateJudgeModal.tsx
git commit -m "feat(challenges): playground switch to toggle judge user-selectability"
```

---

## Task 7: Category upsert schema + theme-guard

**Files:**
- Modify: `src/server/schema/challenge.schema.ts` (new `upsertChallengeCategorySchema` near the other judging-category schemas, ~line 359)
- Modify: `src/server/services/challenge-category.service.ts` (add `assertCategoryActiveAllowed`)
- Test: `src/server/services/__tests__/challenge-category.service.test.ts` (append)

**Interfaces:**
- Produces: `upsertChallengeCategorySchema` / `UpsertChallengeCategoryInput`; `assertCategoryActiveAllowed(key: string, active: boolean): void` (throws `BAD_REQUEST` when deactivating `theme`).

- [ ] **Step 1: Write the failing test (append to the category service test)**

Append to `src/server/services/__tests__/challenge-category.service.test.ts`:

```ts
import { assertCategoryActiveAllowed } from '~/server/services/challenge-category.service';

describe('assertCategoryActiveAllowed', () => {
  it('rejects deactivating the theme category', () => {
    expect(() => assertCategoryActiveAllowed('theme', false)).toThrow(/theme category cannot/i);
  });
  it('allows deactivating a non-theme category', () => {
    expect(() => assertCategoryActiveAllowed('humor', false)).not.toThrow();
  });
  it('allows keeping theme active', () => {
    expect(() => assertCategoryActiveAllowed('theme', true)).not.toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/server/services/__tests__/challenge-category.service.test.ts`
Expected: FAIL — `assertCategoryActiveAllowed` is not exported.

- [ ] **Step 3: Add the guard to the category service**

In `src/server/services/challenge-category.service.ts` (it already imports `TRPCError`), add:

```ts
// Every challenge's judgingCategories requires exactly one `theme` (judgingCategoryRefinements),
// so the theme category must never be soft-hidden or removed — it would break create for all users.
export function assertCategoryActiveAllowed(key: string, active: boolean) {
  if (key === 'theme' && !active)
    throw new TRPCError({ code: 'BAD_REQUEST', message: 'The theme category cannot be deactivated.' });
}
```

- [ ] **Step 4: Add the zod schema**

In `challenge.schema.ts`, after `challengeJudgingCategoriesSchema` (~line 359), add:

```ts
// Moderator: create/update a ChallengeCategory library row (playground Categories tab).
// `key` is the PK and the join key on stored Challenge.judgingCategories, so it is create-only.
export type UpsertChallengeCategoryInput = z.infer<typeof upsertChallengeCategorySchema>;
export const upsertChallengeCategorySchema = z.object({
  key: z.string().trim().min(1).max(50),
  label: z.string().trim().min(1).max(100),
  group: z.string().trim().min(1).max(50),
  criteria: z.string().trim().min(1).max(500),
  rubric: z.string().optional().nullable(),
  rubricNsfw: z.string().optional().nullable(),
  sortOrder: z.number().int().default(0),
  active: z.boolean().default(true),
});
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm vitest run src/server/services/__tests__/challenge-category.service.test.ts`
Expected: PASS (all prior + 3 new).

- [ ] **Step 6: Commit**

```bash
git add src/server/schema/challenge.schema.ts src/server/services/challenge-category.service.ts src/server/services/__tests__/challenge-category.service.test.ts
git commit -m "feat(challenges): category upsert schema + theme deactivation guard"
```

---

## Task 8: Category read/write service functions

**Files:**
- Modify: `src/server/services/challenge-category.service.ts`

**Interfaces:**
- Consumes: `assertCategoryActiveAllowed` (Task 7), `clearChallengeCategoryCache` (existing), `UpsertChallengeCategoryInput` (Task 7), `ChallengeCategoryRow` (existing).
- Produces: `getChallengeCategoriesFull(): Promise<ChallengeCategoryRow[]>` (fresh, moderator-only, incl. rubric text); `upsertChallengeCategory(input): Promise<ChallengeCategoryRow>`.

- [ ] **Step 1: Add a type-only import for the input type**

At the top of `challenge-category.service.ts`, extend the existing schema type import:

```ts
import type {
  ChallengeJudgingCategory,
  UpsertChallengeCategoryInput,
} from '~/server/schema/challenge.schema';
```

- [ ] **Step 2: Add the read + write functions**

Append to `challenge-category.service.ts`:

```ts
/** Full category rows incl. server-only rubric text — MODERATOR ONLY. Reads fresh (bypasses the
 *  public 5-min cache) so the playground always shows current state. */
export async function getChallengeCategoriesFull(): Promise<ChallengeCategoryRow[]> {
  const { dbRead } = await import('~/server/db/client');
  return dbRead.challengeCategory.findMany({
    orderBy: [{ sortOrder: 'asc' }, { label: 'asc' }],
  });
}

/** Create or update a category library row, then bust the in-process category cache. In-process
 *  only — other instances refresh within the 5-min TTL (acceptable for a mod config surface). */
export async function upsertChallengeCategory(
  input: UpsertChallengeCategoryInput
): Promise<ChallengeCategoryRow> {
  assertCategoryActiveAllowed(input.key, input.active);
  const { dbWrite } = await import('~/server/db/client');
  const { key, ...data } = input;
  const row = await dbWrite.challengeCategory.upsert({
    where: { key },
    create: { key, ...data },
    update: data,
  });
  clearChallengeCategoryCache();
  return row;
}
```

- [ ] **Step 3: Verify types**

Run: `pnpm run typecheck`
Expected: no new errors. (Prisma's `challengeCategory.upsert` accepts `rubric`/`rubricNsfw` as `string | null`.)

- [ ] **Step 4: Commit**

```bash
git add src/server/services/challenge-category.service.ts
git commit -m "feat(challenges): moderator category read (full) + upsert with cache bust"
```

---

## Task 9: tRPC endpoints for category CRUD

**Files:**
- Modify: `src/server/routers/challenge.router.ts`

**Interfaces:**
- Consumes: `getChallengeCategoriesFull`, `upsertChallengeCategory` (Task 8), `upsertChallengeCategorySchema` (Task 7).
- Produces: `challenge.getChallengeCategories` (moderator query), `challenge.upsertChallengeCategory` (moderator mutation).

- [ ] **Step 1: Add imports**

Add the service functions to the existing `~/server/services/challenge-category.service` import (or a new import line), and add `upsertChallengeCategorySchema` to the `~/server/schema/challenge.schema` import.

- [ ] **Step 2: Add the procedures**

Near the existing `getJudgingCategories` / `upsertJudge` procedures in `challenge.router.ts`, add:

```ts
  getChallengeCategories: moderatorProcedure.query(() => getChallengeCategoriesFull()),
  upsertChallengeCategory: moderatorProcedure
    .input(upsertChallengeCategorySchema)
    .mutation(({ input }) => upsertChallengeCategory(input)),
```

- [ ] **Step 3: Verify types**

Run: `pnpm run typecheck`
Expected: no new errors; `trpc.challenge.getChallengeCategories` / `trpc.challenge.upsertChallengeCategory` resolve.

- [ ] **Step 4: Commit**

```bash
git add src/server/routers/challenge.router.ts
git commit -m "feat(challenges): tRPC moderator endpoints for category CRUD"
```

---

## Task 10: Playground "Judges | Categories" tab switcher

**Files:**
- Modify: `src/components/Challenge/Playground/PlaygroundPage.tsx`
- Create: `src/components/Challenge/Playground/CategoriesPanel.tsx` (empty shell here; filled in Task 11)

**Interfaces:**
- Produces: `<CategoriesPanel />` mounted under the Categories tab.

- [ ] **Step 1: Create a placeholder `CategoriesPanel`**

Create `src/components/Challenge/Playground/CategoriesPanel.tsx`:

```tsx
import { Center, Text } from '@mantine/core';

export function CategoriesPanel() {
  return (
    <Center py="xl">
      <Text c="dimmed">Category management</Text>
    </Center>
  );
}
```

- [ ] **Step 2: Add the tab switcher to `PlaygroundPage`**

Wrap the current 3-panel `Flex` (the Judges view) and the new `CategoriesPanel` in Mantine `Tabs`, keeping the existing `challengePlatform` + `isModerator` gates above it. Replace the `return (...)` body with:

```tsx
  return (
    <Tabs defaultValue="judges" keepMounted={false} h="100%">
      <Tabs.List>
        <Tabs.Tab value="judges">Judges</Tabs.Tab>
        <Tabs.Tab value="categories">Categories</Tabs.Tab>
      </Tabs.List>

      <Tabs.Panel value="judges">
        <Flex
          h="calc(100vh - var(--header-height) - var(--footer-height) - 110px)"
          gap={0}
          style={{ overflow: 'hidden' }}
        >
          {/* existing Left / Center / Right Card panels unchanged */}
        </Flex>
      </Tabs.Panel>

      <Tabs.Panel value="categories">
        <CategoriesPanel />
      </Tabs.Panel>
    </Tabs>
  );
```

Move the three existing `<Card>...</Card>` panels verbatim into the `judges` `Tabs.Panel`'s `Flex`. Add `Tabs` to the `@mantine/core` import and `import { CategoriesPanel } from './CategoriesPanel';`. (The height offset is bumped `68 → 110` to account for the tab list; adjust if the layout clips.)

- [ ] **Step 3: Manual verification**

Dev server, `/moderator/challenges/playground`: the page shows Judges/Categories tabs; Judges tab is the unchanged 3-panel playground; Categories tab shows the placeholder.
Expected: both render, no layout break.

- [ ] **Step 4: Commit**

```bash
git add src/components/Challenge/Playground/PlaygroundPage.tsx src/components/Challenge/Playground/CategoriesPanel.tsx
git commit -m "feat(challenges): playground Judges/Categories tab switcher"
```

---

## Task 11: Category management panel (list + editor)

**Files:**
- Modify: `src/components/Challenge/Playground/CategoriesPanel.tsx`

**Interfaces:**
- Consumes: `trpc.challenge.getChallengeCategories`, `trpc.challenge.upsertChallengeCategory` (Task 9).

- [ ] **Step 1: Implement the panel**

Replace `CategoriesPanel.tsx` with a list (left) + editor (right). New rows use an empty `key` input (create); selecting a row loads it for edit with `key` read-only:

```tsx
import { useState } from 'react';
import {
  ActionIcon, Badge, Button, Card, Flex, Group, NumberInput, ScrollArea, Stack, Switch,
  Text, TextInput, Textarea,
} from '@mantine/core';
import { IconPlus } from '@tabler/icons-react';
import { showNotification } from '@mantine/notifications';
import { trpc } from '~/utils/trpc';

type Draft = {
  key: string; label: string; group: string; criteria: string;
  rubric: string; rubricNsfw: string; sortOrder: number; active: boolean;
  isNew: boolean;
};

const blank: Draft = {
  key: '', label: '', group: 'Universal', criteria: '',
  rubric: '', rubricNsfw: '', sortOrder: 0, active: true, isNew: true,
};

export function CategoriesPanel() {
  const utils = trpc.useUtils();
  const { data: categories, isLoading } = trpc.challenge.getChallengeCategories.useQuery();
  const [draft, setDraft] = useState<Draft | null>(null);

  const upsert = trpc.challenge.upsertChallengeCategory.useMutation({
    onSuccess: async () => {
      await utils.challenge.getChallengeCategories.invalidate();
      showNotification({ message: 'Category saved', color: 'green' });
    },
    onError: (e) => showNotification({ message: e.message, color: 'red' }),
  });

  const set = (patch: Partial<Draft>) => setDraft((d) => (d ? { ...d, ...patch } : d));

  const save = () => {
    if (!draft) return;
    upsert.mutate({
      key: draft.key.trim(),
      label: draft.label.trim(),
      group: draft.group.trim(),
      criteria: draft.criteria.trim(),
      rubric: draft.rubric.trim() || null,
      rubricNsfw: draft.rubricNsfw.trim() || null,
      sortOrder: draft.sortOrder,
      active: draft.active,
    });
  };

  return (
    <Flex h="calc(100vh - var(--header-height) - var(--footer-height) - 110px)" gap={0} style={{ overflow: 'hidden' }}>
      <Card withBorder radius={0} p={0} h="100%" style={{ width: 280, minWidth: 280, borderRight: 0, overflow: 'hidden' }}>
        <Stack gap={0} h="100%">
          <Group justify="space-between" p="sm">
            <Text fw={600}>Categories</Text>
            <ActionIcon variant="light" onClick={() => setDraft({ ...blank })} title="Add category">
              <IconPlus size={16} />
            </ActionIcon>
          </Group>
          <ScrollArea style={{ flex: 1 }}>
            <Stack gap={0}>
              {isLoading && <Text c="dimmed" p="sm">Loading…</Text>}
              {categories?.map((c) => (
                <Group
                  key={c.key}
                  justify="space-between"
                  p="sm"
                  style={{ cursor: 'pointer' }}
                  onClick={() =>
                    setDraft({
                      key: c.key, label: c.label, group: c.group, criteria: c.criteria,
                      rubric: c.rubric ?? '', rubricNsfw: c.rubricNsfw ?? '',
                      sortOrder: c.sortOrder, active: c.active, isNew: false,
                    })
                  }
                >
                  <div>
                    <Text size="sm">{c.label}</Text>
                    <Text size="xs" c="dimmed">{c.key} · {c.group}</Text>
                  </div>
                  {!c.active && <Badge size="xs" color="gray">off</Badge>}
                </Group>
              ))}
            </Stack>
          </ScrollArea>
        </Stack>
      </Card>

      <Card withBorder radius={0} p="md" h="100%" style={{ flex: 1, minWidth: 0, overflow: 'auto' }}>
        {!draft ? (
          <Text c="dimmed">Select a category or add a new one.</Text>
        ) : (
          <Stack>
            <TextInput
              label="Key"
              description="Stable id, e.g. dread. Cannot be changed after creation."
              value={draft.key}
              disabled={!draft.isNew}
              onChange={(e) => set({ key: e.currentTarget.value })}
            />
            <TextInput label="Label" value={draft.label} onChange={(e) => set({ label: e.currentTarget.value })} />
            <TextInput label="Group" value={draft.group} onChange={(e) => set({ group: e.currentTarget.value })} />
            <Textarea label="Criteria (client-visible one-liner)" autosize minRows={2} value={draft.criteria} onChange={(e) => set({ criteria: e.currentTarget.value })} />
            <Textarea label="Rubric (server-only scoring block)" autosize minRows={4} value={draft.rubric} onChange={(e) => set({ rubric: e.currentTarget.value })} />
            <Textarea label="Rubric NSFW (optional override)" autosize minRows={4} value={draft.rubricNsfw} onChange={(e) => set({ rubricNsfw: e.currentTarget.value })} />
            <NumberInput label="Sort order" value={draft.sortOrder} onChange={(v) => set({ sortOrder: typeof v === 'number' ? v : 0 })} />
            <Switch
              label="Active"
              checked={draft.active}
              disabled={draft.key === 'theme'}
              onChange={(e) => set({ active: e.currentTarget.checked })}
            />
            <Group>
              <Button onClick={save} loading={upsert.isLoading}>Save</Button>
              <Button variant="default" onClick={() => setDraft(null)}>Cancel</Button>
            </Group>
          </Stack>
        )}
      </Card>
    </Flex>
  );
}
```

- [ ] **Step 2: Verify types**

Run: `pnpm run typecheck`
Expected: no new errors.

- [ ] **Step 3: Manual verification**

Dev server, `/moderator/challenges/playground` → Categories tab:
1. "Add category" → set key `dread`, label `Dread`, group `Horror`, criteria + rubric, Save → appears in the list.
2. Open the user challenge-create form → the new category is selectable in `CategoryWeights`.
3. Edit an existing category's rubric, Save → no error; `key` field is read-only on edit.
4. Try to toggle `theme` inactive → the Active switch is disabled (and the server rejects it if forced).
Expected: all hold.

- [ ] **Step 4: Commit**

```bash
git add src/components/Challenge/Playground/CategoriesPanel.tsx
git commit -m "feat(challenges): category management panel in playground"
```

---

## Post-implementation

- [ ] Run the full new/affected unit tests: `pnpm vitest run src/server/services/__tests__/challenge-judge.service.test.ts src/server/services/__tests__/challenge-category.service.test.ts` → all pass.
- [ ] `pnpm run typecheck` clean.
- [ ] **Surface the migration for manual apply** (repo convention): tell the user the `prisma/migrations/20260715000000_challenge_judge_user_selectable/migration.sql` (ALTER + `UPDATE ... WHERE name IN ('CivBot','CivChan')`) must be applied by hand to preview/staging/prod. Until applied, the whitelist fallback keeps `CivBot`/`CivChan` working.
- [ ] Open a PR against `main` (not stacked).

## Self-Review notes

- **Spec coverage:** Part A DB (T1), resolver+fallback (T2), read wire (T3), write backstop parity (T4), API field (T5), UI toggle (T6). Part B schema+guard (T7), service (T8), router (T9), tab (T10), panel (T11). Cache caveat documented in T8. Theme-guard in T7/T11. Migration ops in Post-implementation.
- **Type consistency:** `getUserSelectableJudges → UserSelectableJudge{id,name,bio}` consumed identically in T3/T4; `upsertChallengeCategorySchema`/`UpsertChallengeCategoryInput` consumed in T8/T9; `getChallengeCategoriesFull`/`upsertChallengeCategory` names consistent T8→T9→T11.
- **Manual-verify tasks** (T6, T10, T11 UI) are explicitly manual because the playground uses local-state Mantine components, not unit-testable pure logic; the testable cores (judge fallback, theme-guard) are unit-tested in T2/T7.
