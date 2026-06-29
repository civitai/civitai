# ModelCard multi-baseModel badge — Implementation Plan

> **For agentic workers:** Steps use checkbox (`- [ ]`) syntax for tracking. Inline execution in-session (subagent-driven not used per user request).

**Goal:** Show all distinct base models a model supports on its card badge, with the matched base leading when a base-model filter is active, in both the search page and the `/models` feed.

**Architecture:** A pure helper resolves the ordered, distinct base-model list from whichever shape the card data has (feed `baseModels`, search `versions[]`, or singular `version`), floating filter-matched bases first. `ModelTypeBadge` renders up to 3 indicator codes + `+N` with a tooltip of full names. The active filter is threaded through the existing `ModelCardContext` (search page adds the provider; feed already has it). Server feed emits a cheap distinct `baseModels` array from already-cached version data.

**Tech Stack:** React, Mantine v7, Tailwind, tRPC, Vitest.

## Global Constraints

- Base model display codes come from the existing `BaseModelIndicator` map in `ModelTypeBadge.tsx` — do not duplicate it.
- `BaseModel` type from `~/shared/constants/basemodel.constants`.
- Single-base models must render identically to today in all contexts.
- No new DB queries; reuse `dataForModelsCache` data already loaded in `getModelsRaw`.
- Vitest only (no Jest); never place test files under `src/pages`.

---

### Task 1: Server emits distinct `baseModels` on feed items

**Files:**
- Modify: `src/server/services/model.service.ts` (`getModelsRaw`, ~lines 944-1013)

**Interfaces:**
- Produces: each feed item gains `baseModels: BaseModel[]` (distinct, in version-index order, from published versions before the base-model/version-id filters). Flows to the final feed item via the existing `...model` spread in `getModelsWithImagesAndModelVersions` (line 1345/1368) — no change needed there. `UseQueryModelReturn[number]` gains `baseModels: BaseModel[]`.

- [ ] **Step 1: Compute the distinct list after the published filter, before the base-model filter**

In `getModelsRaw`, immediately after the published-status filter block (the `if (!sessionUser?.isModerator || !status?.length) { modelVersions = ... Published }` block, ~line 949) and BEFORE `if (baseModels) { ... }` (~line 951), insert:

```ts
          // Distinct base models across the model's visible versions — surfaced to
          // the card badge so it can show multi-base support and matched-first order.
          const allBaseModels = [...new Set(modelVersions.map((mv) => mv.baseModel))];
```

- [ ] **Step 2: Include it on the returned item**

In the `return { ...model, rank: {...}, modelVersions, hashes, tagsOnModels, user, cosmetic }` object (~lines 991-1013), add:

```ts
            baseModels: allBaseModels,
```

- [ ] **Step 3: Typecheck the service**

Run: `npx tsc --noEmit 2>&1 | grep model.service` — expected: no new errors referencing `model.service.ts`.

- [ ] **Step 4: Commit**

```bash
git add src/server/services/model.service.ts
git commit -m "feat(models): surface distinct baseModels on feed items"
```

---

### Task 2: Pure helper `getCardBaseModels` + tests

**Files:**
- Create: `src/components/Cards/model-card.utils.ts`
- Test: `src/components/Cards/__tests__/model-card.utils.test.ts`

**Interfaces:**
- Produces: `getCardBaseModels(data, activeBaseModels?): BaseModel[]` where
  `data: { baseModels?: BaseModel[]; versions?: { baseModel: BaseModel }[]; version?: { baseModel?: BaseModel | null } }`
  and `activeBaseModels?: string[]`. Returns ordered, de-duplicated base models with any value in `activeBaseModels` floated to the front (stable otherwise).

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, expect, it } from 'vitest';
import { getCardBaseModels } from '~/components/Cards/model-card.utils';

describe('getCardBaseModels', () => {
  it('prefers feed baseModels array, deduped in order', () => {
    expect(
      getCardBaseModels({ baseModels: ['Pony', 'SD 1.5', 'Pony'] as any })
    ).toEqual(['Pony', 'SD 1.5']);
  });

  it('falls back to versions[] when baseModels absent', () => {
    expect(
      getCardBaseModels({ versions: [{ baseModel: 'Pony' }, { baseModel: 'Illustrious' }] as any })
    ).toEqual(['Pony', 'Illustrious']);
  });

  it('falls back to singular version when others absent', () => {
    expect(getCardBaseModels({ version: { baseModel: 'SD 1.5' } as any })).toEqual(['SD 1.5']);
  });

  it('floats matched base models to the front, stable otherwise', () => {
    expect(
      getCardBaseModels({ baseModels: ['Pony', 'SD 1.5', 'Illustrious'] as any }, ['SD 1.5'])
    ).toEqual(['SD 1.5', 'Pony', 'Illustrious']);
  });

  it('is a no-op for a single base model', () => {
    expect(getCardBaseModels({ baseModels: ['Pony'] as any }, ['SD 1.5'])).toEqual(['Pony']);
  });

  it('returns empty array when no base model anywhere', () => {
    expect(getCardBaseModels({})).toEqual([]);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm vitest run src/components/Cards/__tests__/model-card.utils.test.ts`
Expected: FAIL — `getCardBaseModels` not exported.

- [ ] **Step 3: Implement the helper**

```ts
import type { BaseModel } from '~/shared/constants/basemodel.constants';

type CardBaseModelData = {
  baseModels?: BaseModel[] | null;
  versions?: { baseModel?: BaseModel | null }[] | null;
  version?: { baseModel?: BaseModel | null } | null;
};

export function getCardBaseModels(
  data: CardBaseModelData,
  activeBaseModels?: string[]
): BaseModel[] {
  const source =
    data.baseModels ??
    data.versions?.map((v) => v.baseModel) ??
    (data.version?.baseModel ? [data.version.baseModel] : []);

  const distinct: BaseModel[] = [];
  for (const bm of source) {
    if (bm && !distinct.includes(bm)) distinct.push(bm);
  }

  if (!activeBaseModels?.length || distinct.length < 2) return distinct;

  const matched = distinct.filter((bm) => activeBaseModels.includes(bm));
  const rest = distinct.filter((bm) => !activeBaseModels.includes(bm));
  return [...matched, ...rest];
}
```

- [ ] **Step 4: Run to verify pass**

Run: `pnpm vitest run src/components/Cards/__tests__/model-card.utils.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add src/components/Cards/model-card.utils.ts src/components/Cards/__tests__/model-card.utils.test.ts
git commit -m "feat(models): add getCardBaseModels helper"
```

---

### Task 3: `ModelTypeBadge` multi-baseModel render

**Files:**
- Modify: `src/components/Model/ModelTypeBadge/ModelTypeBadge.tsx`

**Interfaces:**
- Consumes: nothing new.
- Produces: `ModelTypeBadge` accepts optional `baseModels?: BaseModel[]`. When it resolves to 2+ distinct indicator codes, renders up to 3 codes + `+N` with a Tooltip of full base-model names; otherwise unchanged single-indicator behavior.

- [ ] **Step 1: Add the multi-render path**

Update the `Props` type:

```ts
type Props = Omit<BadgeProps, 'children'> & {
  type: ModelType;
  baseModel: BaseModel;
  baseModels?: BaseModel[];
};
```

Add `Tooltip` to the mantine import. In the component, compute the indicator codes from `baseModels` (falling back to `[baseModel]`), dedup by code, and branch:

```tsx
export function ModelTypeBadge({ type, baseModel, baseModels, ...badgeProps }: Props) {
  const bases = baseModels?.length ? baseModels : [baseModel];

  // Dedup by short code (e.g. SD 1.4 + SD 1.5 -> one "SD1"), preserving order.
  const seen = new Set<string>();
  const codes: { base: BaseModel; node: React.ReactNode | string }[] = [];
  for (const base of bases) {
    const node = BaseModelIndicator[base];
    if (node == null) continue;
    const key = typeof node === 'string' ? node : base;
    if (seen.has(key)) continue;
    seen.add(key);
    codes.push({ base, node });
  }

  const MAX = 3;
  const visible = codes.slice(0, MAX);
  const overflow = codes.length - visible.length;

  return (
    <Badge
      variant="light"
      radius="xl"
      {...badgeProps}
      classNames={{ label: 'flex items-center gap-2' }}
    >
      <Text size="xs" tt="capitalize" fw="bold">
        {getDisplayName(type)}
      </Text>

      {visible.length > 0 && (
        <>
          <Divider className="border-l-white/30 border-r-black/20" orientation="vertical" />
          <Tooltip label={bases.join(', ')} withinPortal>
            <span className="flex items-center gap-2">
              {visible.map(({ base, node }) =>
                typeof node === 'string' ? (
                  <Text key={base} size="xs" inherit>
                    {node}
                  </Text>
                ) : (
                  <span key={base} className="flex items-center">
                    {node}
                  </span>
                )
              )}
              {overflow > 0 && (
                <Text size="xs" inherit c="dimmed">
                  +{overflow}
                </Text>
              )}
            </span>
          </Tooltip>
        </>
      )}
    </Badge>
  );
}
```

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit 2>&1 | grep ModelTypeBadge` — expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/components/Model/ModelTypeBadge/ModelTypeBadge.tsx
git commit -m "feat(models): render multiple base models in ModelTypeBadge"
```

---

### Task 4: `ModelCardContext` carries `activeBaseModels`

**Files:**
- Modify: `src/components/Cards/ModelCardContext.tsx`

**Interfaces:**
- Produces: context value type gains `activeBaseModels?: string[]`; `useModelCardContext()` returns it (or undefined when no provider).

- [ ] **Step 1: Extend the context type**

Add `activeBaseModels?: string[];` to the `Context` type (alongside `useModelVersionRedirect?: boolean`).

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit 2>&1 | grep ModelCardContext` — expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/components/Cards/ModelCardContext.tsx
git commit -m "feat(models): add activeBaseModels to ModelCardContext"
```

---

### Task 5: Wire `ModelCard` to helper + context + badge

**Files:**
- Modify: `src/components/Cards/ModelCard.tsx`

**Interfaces:**
- Consumes: `getCardBaseModels` (Task 2), `activeBaseModels` from `useModelCardContext()` (Task 4), `ModelTypeBadge` `baseModels` prop (Task 3).

- [ ] **Step 1: Compute and pass baseModels**

Import `getCardBaseModels`. Inside `ModelCardContent`, read `activeBaseModels` from the existing `useModelCardContext()` call, then:

```tsx
const cardBaseModels = getCardBaseModels(data as any, activeBaseModels);
```

Update the badge usage (line ~131-135):

```tsx
            <ModelTypeBadge
              className={clsx(cardClasses.infoChip, cardClasses.chip)}
              type={data.type}
              baseModel={data.version.baseModel}
              baseModels={cardBaseModels}
            />
```

(`data as any` covers the search-runtime `versions` field absent from the feed TS type; the feed `baseModels` field is typed from Task 1.)

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit 2>&1 | grep ModelCard.tsx` — expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/components/Cards/ModelCard.tsx
git commit -m "feat(models): pass distinct baseModels to ModelCard badge"
```

---

### Task 6: Provide `activeBaseModels` on the search page

**Files:**
- Modify: `src/pages/search/models.tsx`

**Interfaces:**
- Consumes: `ModelCardContextProvider` (from `~/components/Cards/ModelCardContext`), the active `versions.baseModel` refinement.

- [ ] **Step 1: Read the active refinement and wrap the results grid**

In the component rendering the `MasonryGrid` of `ModelCard`s (the `ModelsHitList` area), read the current refinement values for `versions.baseModel` via `useInstantSearch().uiState[MODELS_SEARCH_INDEX]?.refinementList?.['versions.baseModel']` (the page already imports `useInstantSearch`), then wrap the grid:

```tsx
const activeBaseModels =
  useInstantSearch().uiState[MODELS_SEARCH_INDEX]?.refinementList?.['versions.baseModel'] ?? [];

// ...
<ModelCardContextProvider value={{ activeBaseModels }}>
  <MasonryGrid /* ...existing props... */ />
</ModelCardContextProvider>
```

Import `ModelCardContextProvider` and `MODELS_SEARCH_INDEX` if not already imported.

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit 2>&1 | grep 'search/models'` — expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/pages/search/models.tsx
git commit -m "feat(search): provide active base-model filter to model cards"
```

---

### Task 7: Provide `activeBaseModels` on the feed

**Files:**
- Modify: `src/components/Model/Infinite/ModelsInfinite.tsx`

**Interfaces:**
- Consumes: existing `ModelCardContextProvider` and `filters?.baseModels`.

- [ ] **Step 1: Pass the filter into the existing provider**

Find the `ModelCardContextProvider` (~line 54-56) and add `activeBaseModels` to its value:

```tsx
<ModelCardContextProvider value={{ useModelVersionRedirect, activeBaseModels: filters?.baseModels }}>
```

(Preserve any existing value fields; `filters` already reads `useModelFilters()` merged with overrides.)

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit 2>&1 | grep ModelsInfinite` — expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/components/Model/Infinite/ModelsInfinite.tsx
git commit -m "feat(models): provide active base-model filter to feed cards"
```

---

## Self-Review

- Spec coverage: ModelTypeBadge (T3), helper (T2), ModelCardContext (T4), ModelCard (T5), search wiring (T6), feed wiring (T7), server emit (T1), types (T1 auto + T5 `as any` for search `versions`), tests (T2; Ladle story optional — manual visual check via component-preview after). All covered.
- Placeholder scan: every code step has concrete code. OK.
- Type consistency: `getCardBaseModels` signature identical across T2/T5; `baseModels` field name consistent T1/T2/T3/T5; `activeBaseModels` consistent T4/T5/T6/T7.
