# Account Deletion Image Choice Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a user deleting their account choose between deleting their images immediately and putting them through the ban-style block + 7-day grace period, mirroring the existing "wipe my models" choice.

**Architecture:** `deleteUser` records the choice in `User.meta.imageRemoval` (a `Json` column — no migration) and returns fast; it never touches images inline, because blocking a 784K-image account would time out the mutation for exactly the same reason hard-deleting inline would. The existing `remove-deleted-user-images` drain job reads that mode per user and either hard-deletes (today's behavior) or bulk-blocks. Blocking arms machinery that already exists end to end: the `trg_blocked_image_delete_queue` trigger enqueues `JobQueue(BlockedImageDelete)`, and `remove-blocked-images` hard-deletes plus purges S3 seven days later, counting from `updatedAt`.

**Tech Stack:** TypeScript, Prisma (raw SQL via `$queryRaw`), Vitest, Mantine v7, Zod.

## Global Constraints

- Builds on PR #3488, branch `feat/account-deletion-image-removal`. Do not branch fresh.
- Test runner is **Vitest**, not Jest: `pnpm vitest run <path>`.
- Never put test files under `src/pages`.
- **No migration.** `User.meta` is an existing `Json` column.
- Blocking must use exactly the values the ban path uses (`user.service.ts:1807-1814`): `ingestion: 'Blocked'`, `nsfwLevel: NsfwLevel.Blocked`, `blockedFor: BlockedReason.Moderated`. Both enums come from `~/server/common/enums`. Any other `blockedFor` value changes which retention branch `remove-blocked-images` applies.
- Only ever block images that are `ingestion <> 'Blocked'`, matching `toggleBan`. Re-blocking an already-blocked image would re-fire the trigger and restart its 7-day clock.
- Every destructive or state-changing statement must stay gated on the account still being deleted, matching the existing job's pattern — the worklist is read off a replica.
- Absent `meta.imageRemoval` means **immediate**. The 1.3M backlog accounts never made a choice and must keep today's hard-delete behavior.
- Repo comment guidelines: default to no comment; comment only the non-obvious "why"; never narrate the next line; no change-log or banner comments.

## Known-accepted behavior

The grace branch leaves the S3 object and its CDN URL fully reachable for the whole 7 days — blocking is a database-only state change. This was raised and accepted by the product owner. Task 3 records it in the spec so it is not rediscovered as a bug.

## File Structure

| File | Responsibility |
|---|---|
| `src/server/schema/user.schema.ts` (modify) | Add `removeImages` to `deleteUserSchema` |
| `src/server/services/user.service.ts` (modify) | `imageRemovalMode()` helper; `deleteUser` records the mode in `meta` |
| `src/server/services/__tests__/image-removal-mode.test.ts` (create) | Tests for the pure helper |
| `src/server/jobs/remove-deleted-user-images.ts` (modify) | Mode-aware worklist and per-user branch |
| `src/server/jobs/__tests__/remove-deleted-user-images.test.ts` (modify) | Tests for the block branch |
| `src/components/Account/DeleteCard.tsx` (modify) | The image choice modal |
| `docs/account-deletion-image-removal.md` (modify) | Document both branches and the accepted CDN window |

---

### Task 1: Record the choice

**Files:**
- Modify: `src/server/schema/user.schema.ts:192-196`
- Modify: `src/server/services/user.service.ts` (the `deleteUser` function, currently at `:1028`)
- Test: `src/server/services/__tests__/image-removal-mode.test.ts`

**Interfaces:**
- Produces: `export type ImageRemovalMode = 'grace' | 'immediate'` and `export function imageRemovalMode(removeImages?: boolean): ImageRemovalMode`, both from `~/server/services/user.service`. Task 2 relies on the string values `'grace'` and `'immediate'` appearing in `User.meta.imageRemoval`.

- [ ] **Step 1: Write the failing test**

Create `src/server/services/__tests__/image-removal-mode.test.ts`. The helper lives in its own module, `src/server/utils/image-removal-mode.ts`, so this test does not have to boot `user.service`'s import graph — that file pulls in Prisma, Redis, ClickHouse and the event-engine submodule at import time, which is why the one existing service test in this repo needs a large proxy-mock scaffold.

```ts
import { describe, it, expect } from 'vitest';
import { imageRemovalMode } from '~/server/utils/image-removal-mode';

describe('imageRemovalMode', () => {
  it('returns grace only when the user explicitly opted to keep their images', () => {
    expect(imageRemovalMode(false)).toBe('grace');
  });

  it('returns immediate when the user opted to delete them', () => {
    expect(imageRemovalMode(true)).toBe('immediate');
  });

  // The 1.3M backlog accounts and any API caller that omits the field must keep
  // today's hard-delete behavior.
  it('returns immediate when the choice is absent', () => {
    expect(imageRemovalMode(undefined)).toBe('immediate');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/hackstreetboy/Projects/civitai-account-deletion-image-removal && pnpm vitest run src/server/services/__tests__/image-removal-mode.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Add the schema field**

In `src/server/schema/user.schema.ts`, extend `deleteUserSchema`:

```ts
export const deleteUserSchema = z.object({
  id: z.number(),
  username: usernameSchema.optional(),
  removeModels: z.boolean().optional(),
  removeImages: z.boolean().optional(),
});
```

- [ ] **Step 4: Add the helper**

Create `src/server/utils/image-removal-mode.ts`:

```ts
export type ImageRemovalMode = 'grace' | 'immediate';

/** Absent means immediate: backlog accounts predate the choice and must keep hard-delete. */
export function imageRemovalMode(removeImages?: boolean): ImageRemovalMode {
  return removeImages === false ? 'grace' : 'immediate';
}
```

- [ ] **Step 5: Record the mode in `deleteUser`**

In `src/server/services/user.service.ts`, import the helper and `UserMeta`, then destructure `removeImages` from the input and merge the mode into the existing `dbWrite.user.update` call inside the `$transaction`. The user row is already being updated there — add `meta` to that same `data` object rather than issuing a second write:

```ts
export const deleteUser = async ({ id, username, removeModels, removeImages }: DeleteUserInput) => {
  const user = await dbWrite.user.findFirst({
    where: { username, id },
    select: { id: true, meta: true },
  });
  if (!user) throw throwNotFoundError('Could not find user');

  const meta = { ...((user.meta ?? {}) as UserMeta), imageRemoval: imageRemovalMode(removeImages) };
```

and in the `dbWrite.user.update` call within the transaction, add `meta` alongside the existing fields:

```ts
      data: {
        deletedAt: new Date(),
        email: null,
        username: null,
        paddleCustomerId: null,
        image: null,
        profilePictureId: null,
        meta,
      },
```

Also add `imageRemoval` to the `userMeta` zod schema in `src/server/schema/user.schema.ts:420-440` so the type stays honest:

```ts
  imageRemoval: z.enum(['grace', 'immediate']).optional(),
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `cd /Users/hackstreetboy/Projects/civitai-account-deletion-image-removal && pnpm vitest run src/server/services/__tests__/image-removal-mode.test.ts`
Expected: PASS, 3 tests.

- [ ] **Step 7: Commit**

```bash
git add src/server/schema/user.schema.ts src/server/services/user.service.ts src/server/utils/image-removal-mode.ts src/server/services/__tests__/image-removal-mode.test.ts
git commit -m "feat(account-deletion): record the user's image-removal choice"
```

---

### Task 2: Mode-aware drain job

**Files:**
- Modify: `src/server/jobs/remove-deleted-user-images.ts`
- Test: `src/server/jobs/__tests__/remove-deleted-user-images.test.ts`

**Interfaces:**
- Consumes: `User.meta.imageRemoval` holding `'grace'` or `'immediate'` (Task 1); absent means immediate.
- Produces: nothing consumed downstream.

**Read the existing test file before starting.** It uses a hand-written harness that interprets the SQL text of each `$queryRaw`/`$executeRaw` against mutable fixtures. You will need to extend the fixtures with `meta` and each image with `ingestion`, and teach the harness the two new predicates. Keep the harness's existing style — it reads comparison operators out of the SQL rather than assuming them, and that property is deliberate.

- [ ] **Step 1: Write the failing tests**

Add to `src/server/jobs/__tests__/remove-deleted-user-images.test.ts`, matching the file's existing fixture and helper conventions:

```ts
describe('grace mode', () => {
  it('blocks a grace user images instead of deleting them', async () => {
    // A grace user with 150 unblocked images.
    seedUser({ id: 7, imageRemoval: 'grace', images: 150 });

    const result = await run();

    expect(mockDeleteImages).not.toHaveBeenCalled();
    expect(blockedImageIds()).toHaveLength(150);
    expect(blockedRows()[0]).toMatchObject({
      ingestion: 'Blocked',
      blockedFor: 'moderated',
    });
    expect(result.blockedImages).toBe(150);
  });

  it('leaves a grace user posts alone', async () => {
    seedUser({ id: 7, imageRemoval: 'grace', images: 10, posts: 5 });

    await run();

    // Posts follow the images out via CleanIfEmpty once remove-blocked-images
    // purges them at day 7; deleting them now would strand the grace window.
    expect(remainingPosts(7)).toHaveLength(5);
  });

  it('does not reselect a grace user whose images are all blocked', async () => {
    seedUser({ id: 7, imageRemoval: 'grace', images: 10, posts: 5 });

    await run();
    mockDeleteImages.mockClear();
    const second = await run();

    expect(second.blockedImages).toBe(0);
    expect(second.deletedImages).toBe(0);
  });

  it('skips images that are already blocked so their 7-day clock is not restarted', async () => {
    seedUser({ id: 7, imageRemoval: 'grace', images: 10, alreadyBlocked: 4 });

    const result = await run();

    expect(result.blockedImages).toBe(6);
  });

  it('hard-deletes a user with no recorded choice', async () => {
    seedUser({ id: 7, images: 10 });

    const result = await run();

    expect(result.deletedImages).toBe(10);
    expect(result.blockedImages).toBe(0);
  });

  it('charges blocked images against the budget', async () => {
    mockSysRedis.get.mockResolvedValue('100');
    seedUser({ id: 7, imageRemoval: 'grace', images: 250 });

    const result = await run();

    expect(result.blockedImages).toBe(100);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /Users/hackstreetboy/Projects/civitai-account-deletion-image-removal && pnpm vitest run src/server/jobs/__tests__/remove-deleted-user-images.test.ts`
Expected: FAIL — the job has no grace branch and returns no `blockedImages`.

- [ ] **Step 3: Make the worklist mode-aware**

In `src/server/jobs/remove-deleted-user-images.ts`, add the import:

```ts
import { BlockedReason, NsfwLevel } from '~/server/common/enums';
```

Change the `Candidate` type and both worklist queries. The candidate now carries its mode:

```ts
type Candidate = { id: number; deletedAt: Date; mode: 'grace' | 'immediate' };
```

Both queries select the mode and change their work predicate. A grace user has outstanding work only while they still own an unblocked image — their posts are not this job's to delete. Apply this to the fresh query:

```sql
      SELECT u.id, u."deletedAt",
             COALESCE(u.meta->>'imageRemoval', 'immediate') AS mode
      FROM "User" u
      WHERE u."deletedAt" IS NOT NULL
        AND u."deletedAt" >= ${freshMark}
        AND (
          EXISTS (
            SELECT 1 FROM "Image" i
            WHERE i."userId" = u.id AND i.ingestion <> 'Blocked'::"ImageIngestionStatus"
          )
          OR (
            COALESCE(u.meta->>'imageRemoval', 'immediate') <> 'grace'
            AND EXISTS (SELECT 1 FROM "Post" p WHERE p."userId" = u.id)
          )
        )
      ORDER BY u."deletedAt" ASC
      LIMIT ${USERS_PER_RUN}
```

and identically to the backlog query, keeping its existing `<= ${backlogCursor}`, `< ${freshMark}` bounds and `ORDER BY u."deletedAt" DESC`.

- [ ] **Step 4: Add the block branch**

Add a `blockUserImages` function alongside `drainUser`, and extend `UserDrain` with `blockedImages: number` (initialize it to `0` in every existing return in `drainUser`):

```ts
async function blockUserImages(
  userId: number,
  budget: number,
  isCanceled: () => boolean
): Promise<UserDrain> {
  let blockedImages = 0;
  let budgetUsed = 0;

  try {
    const images = await dbWrite.$queryRaw<{ id: number }[]>`
      SELECT i.id
      FROM "Image" i
      JOIN "User" u ON u.id = i."userId" AND u."deletedAt" IS NOT NULL
      WHERE i."userId" = ${userId}
        AND i.ingestion <> 'Blocked'::"ImageIngestionStatus"
      LIMIT ${budget}
    `;

    for (const batch of chunk(
      images.map((i) => i.id),
      DELETE_BATCH_SIZE
    )) {
      if (isCanceled())
        return { deletedImages: 0, blockedImages, budgetUsed, drained: false, canceled: true };

      // Re-blocking an already-blocked image refires the trigger and restarts its 7-day clock,
      // so the predicate has to survive into the UPDATE and not just the fetch above.
      blockedImages += await dbWrite.$executeRaw`
        UPDATE "Image"
        SET ingestion = 'Blocked'::"ImageIngestionStatus",
            "nsfwLevel" = ${NsfwLevel.Blocked},
            "blockedFor" = ${BlockedReason.Moderated}
        WHERE id IN (${Prisma.join(batch)})
          AND "userId" = ${userId}
          AND ingestion <> 'Blocked'::"ImageIngestionStatus"
          AND EXISTS (SELECT 1 FROM "User" u WHERE u.id = ${userId} AND u."deletedAt" IS NOT NULL)
      `;
      budgetUsed += batch.length;
    }

    const [state] = await dbWrite.$queryRaw<{ hasUnblocked: boolean }[]>`
      SELECT EXISTS (
        SELECT 1 FROM "Image" i
        WHERE i."userId" = ${userId} AND i.ingestion <> 'Blocked'::"ImageIngestionStatus"
      ) AS "hasUnblocked"
    `;

    return {
      deletedImages: 0,
      blockedImages,
      budgetUsed,
      drained: !state.hasUnblocked,
      canceled: false,
    };
  } catch (error) {
    return { deletedImages: 0, blockedImages, budgetUsed, drained: false, canceled: false, error };
  }
}
```

- [ ] **Step 5: Branch in `drainPage` and thread the counter**

In `drainPage`, dispatch on the candidate's mode and accumulate the new counter:

```ts
    const result =
      user.mode === 'grace'
        ? await blockUserImages(user.id, remaining, isCanceled)
        : await drainUser(user.id, remaining, isCanceled);
```

Add `blockedImages` to `drainPage`'s accumulator and return type, mirroring `deletedImages`. Then in the job body accumulate it across the fresh and backlog runs, add it to the `logToAxiom` payload, and include it in the returned object. The paused early-return becomes `{ paused: true, deletedImages: 0, blockedImages: 0, deletedUsers: 0 }`.

- [ ] **Step 6: Run tests to verify they pass**

Run: `cd /Users/hackstreetboy/Projects/civitai-account-deletion-image-removal && pnpm vitest run src/server/jobs/__tests__/remove-deleted-user-images.test.ts`
Expected: PASS — the 28 existing tests plus the 6 new ones.

- [ ] **Step 7: Verify the new tests discriminate**

For each of the three most important new behaviors, break the implementation, confirm the covering test goes RED, then restore it and confirm GREEN. Record the evidence in your report.

- Remove `AND ingestion <> 'Blocked'` from the `UPDATE` in `blockUserImages` → the already-blocked test must fail.
- Change the `drainPage` dispatch to always call `drainUser` → the grace tests must fail.
- Remove the `<> 'grace'` guard from the worklist's post branch → the "leaves posts alone" test must fail.

- [ ] **Step 8: Commit**

```bash
git add src/server/jobs/remove-deleted-user-images.ts src/server/jobs/__tests__/remove-deleted-user-images.test.ts
git commit -m "feat(account-deletion): block images for users who chose the grace period"
```

---

### Task 3: The choice in the UI, and the docs

**Files:**
- Modify: `src/components/Account/DeleteCard.tsx`
- Modify: `docs/account-deletion-image-removal.md`

**Interfaces:**
- Consumes: `removeImages?: boolean` on the `user.delete` tRPC input (Task 1).

- [ ] **Step 1: Add the image modal**

`DeleteCard.tsx` currently chains: membership warning → type-DELETE confirm → "Wipe your models?" → mutate. Add a fourth step between the models modal and the mutation, following the existing modal pattern in that file exactly (same `Modal` props, same button layout).

Replace `handleWipeDecision` so it stores the models answer and opens the image modal instead of mutating:

```tsx
  const [wipeModels, setWipeModels] = useState(false);
  const [imagesModalOpen, setImagesModalOpen] = useState(false);

  const handleWipeDecision = (wipe: boolean) => {
    setWipeModels(wipe);
    setWipeModalOpen(false);
    setTimeout(() => setImagesModalOpen(true), 200);
  };

  const handleImageDecision = (removeImages: boolean) => {
    setImagesModalOpen(false);
    if (currentUser) {
      deleteAccountMutation.mutateAsync({
        id: currentUser.id,
        removeModels: wipeModels,
        removeImages,
      });
    }
  };
```

and add the modal itself:

```tsx
      <Modal
        opened={imagesModalOpen}
        onClose={() => setImagesModalOpen(false)}
        title="Your images"
        centered
      >
        <Stack>
          <Text>
            Your images will be removed either way. Choose whether that happens now or after a
            7-day window in which they are hidden but can still be restored by support.
          </Text>
          <Group justify="space-between">
            <Button variant="default" onClick={handleCancelAll}>
              Stop! Go back!
            </Button>
            <Group>
              <Button color="red" onClick={() => handleImageDecision(true)}>
                Delete now
              </Button>
              <Button color="red" variant="outline" onClick={() => handleImageDecision(false)}>
                Delete after 7 days
              </Button>
            </Group>
          </Group>
        </Stack>
      </Modal>
```

Extend `handleCancelAll` to also close this modal and reset `wipeModels`.

**The copy above is a proposal, not a settled requirement** — the product owner explicitly said the wording is undecided. It is written to avoid claiming images are "kept" when both branches end in deletion. Flag it in your report for review rather than treating it as final.

- [ ] **Step 2: Verify the flow renders**

Run: `cd /Users/hackstreetboy/Projects/civitai-account-deletion-image-removal && pnpm run typecheck`
Expected: exit 0, no errors in `DeleteCard.tsx`.

There is no existing test for `DeleteCard`, and adding a component-test harness for it is out of scope here. State in your report that this step was verified by typecheck and reading only.

- [ ] **Step 3: Update the spec**

In `docs/account-deletion-image-removal.md`, replace the "Scope: every image the user owns" decision section to describe both branches, and add to Consequences:

```
- The grace branch is a database-only state change. The S3 object and its CDN URL stay fully
  reachable by direct link for the whole 7 days, because `ingestion='Blocked'` hides content in
  the application but does not touch storage. Raised and accepted by the product owner.
- Both branches end in deletion. "Grace" buys a 7-day window in which the images are hidden and
  a moderator can still reverse the block, not indefinite retention. This differs from
  `removeModels: false`, which keeps models live permanently.
```

- [ ] **Step 4: Commit**

```bash
git add src/components/Account/DeleteCard.tsx docs/account-deletion-image-removal.md
git commit -m "feat(account-deletion): let users choose immediate or delayed image removal"
```

---

## Out of scope, still open

These are tracked from the code review of PR #3488 and are deliberately not part of this plan:

- `bustCachesForPosts` throws on an empty id list (`post.service.ts:1284`), which orphans S3 objects for the ~12% of accounts owning only postless images. **This blocks enabling the job at any rate** and belongs in its own PR since it is shared pre-existing code.
- No CSAM-report guard on the worklist.
- Post deletion is outside the budget.
- One large account can monopolize a whole run.
