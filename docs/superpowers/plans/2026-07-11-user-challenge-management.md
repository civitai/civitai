# User Challenge Management Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a normal user see and manage the challenges they created — a "My Challenges" listing, plus edit and delete of their own challenges while still `Scheduled` with no entries.

**Architecture:** The server already supports owner reads (`getInfinite` filters `userId → createdById`, exempts the creator from the scan gate) and owner edits (`upsertUserChallenge`). This plan adds one new delete procedure (`deleteUserChallenge`, a thin owner/status-guarded wrapper over the existing `deleteChallenge` which already refunds Scheduled user challenges), a user-safe edit fetch (`getUserChallengeForEdit`), exposes the true `createdById` on the list/detail payloads, and wires the client surfaces: a nav link, a "My Challenges" mode on `/challenges`, a user edit route, and owner Edit/Delete affordances on the challenge card + detail page.

**Tech Stack:** Next.js 14 (pages router), tRPC, Prisma (PostgreSQL), Mantine v7 + Tailwind, Zustand/React-Query, Vitest for server tests.

## Global Constraints

- **Migrations are applied manually** — this plan adds NO schema/migration changes; it uses existing columns (`Challenge.createdById`, `.source`, `.status`, entries-via-collection). Never run `prisma migrate deploy`.
- **Feature gating:** every new challenge procedure is wrapped with `.use(isFlagProtected('challengePlatform'))` AND `.use(isFlagProtected('userChallenges'))`, matching `upsertUserChallenge` (`challenge.router.ts:169-174`).
- **Enums:** use string Prisma enums from `~/shared/utils/prisma/enums` (`ChallengeSource`, `ChallengeStatus`) — NOT the numeric bitwise enums.
- **DB access:** `dbRead` for reads, `dbWrite` for writes.
- **Ownership scope (hard):** every write/edit is allowed only when `source === ChallengeSource.User` AND `createdById === ctx.user.id` AND `status === ChallengeStatus.Scheduled` AND the challenge has **0 entries**. End / void / pick-winners stay moderator-only and are NOT touched.
- **Tests:** Vitest, run with `pnpm vitest run <path>`. Server service tests live in `src/server/services/__tests__/` — **never** under `src/pages`. This repo unit-tests server services, not React pages/components; client tasks verify via `pnpm run typecheck` + a manual dev-server check (the `/dev-server` skill), which is the established pattern here.
- **Owner-id correctness:** the list payload's display `createdBy.id` is `judgeUserId ?? createdById` (`challenge.service.ts:299`) — it may be the **judge**, not the creator. Owner checks MUST use the dedicated `createdById` field added in Task 2, never `createdBy.id`.

---

### Task 1: Server — `deleteUserChallenge` + `getUserChallengeForEdit` procedures

**Files:**
- Modify: `src/server/services/challenge.service.ts` (add two exported functions near `deleteChallenge`, ~line 1512)
- Modify: `src/server/routers/challenge.router.ts` (import the two fns; add two procedures)
- Test: `src/server/services/__tests__/challenge-delete-user.service.test.ts` (create)

**Interfaces:**
- Consumes: existing `deleteChallenge(id: number)` (`challenge.service.ts:1512`), `getChallengeForEdit(id: number)` (`challenge.service.ts`), `dbRead`, `throwNotFoundError`, `ChallengeSource`, `ChallengeStatus`, `TRPCError`.
- Produces:
  - `deleteUserChallenge({ id, userId }: { id: number; userId: number }): Promise<{ success: true }>`
  - `getUserChallengeForEdit({ id, userId }: { id: number; userId: number })` → same return shape as `getChallengeForEdit(id)`
  - tRPC: `challenge.deleteUserChallenge` (mutation, input `{ id }`), `challenge.getUserChallengeForEdit` (query, input `{ id }`)

- [ ] **Step 1: Write the failing test**

Create `src/server/services/__tests__/challenge-delete-user.service.test.ts`. This mirrors the mock setup in `challenge-judging-categories-gate.service.test.ts` (same repo).

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

const {
  mockDbRead,
  mockDbWrite,
  mockRefundUserChallengeFunds,
  mockQueueUpdate,
} = vi.hoisted(() => ({
  mockDbRead: {
    challenge: { findUnique: vi.fn() },
    collectionItem: { count: vi.fn().mockResolvedValue(0) },
  },
  mockDbWrite: {
    challenge: { delete: vi.fn().mockResolvedValue(undefined) },
    collection: { delete: vi.fn().mockResolvedValue(undefined) },
  },
  mockRefundUserChallengeFunds: vi.fn().mockResolvedValue({ refundedEntries: 0 }),
  mockQueueUpdate: vi.fn(),
}));

vi.mock('~/server/db/client', () => ({ dbRead: mockDbRead, dbWrite: mockDbWrite }));
vi.mock('~/server/games/daily-challenge/challenge-funding', () => ({
  chargeInitialPrize: vi.fn(),
  refundUserChallengeFunds: mockRefundUserChallengeFunds,
}));
vi.mock('~/server/search-index', () => ({
  collectionsSearchIndex: { queueUpdate: mockQueueUpdate },
}));
vi.mock('~/utils/logging', () => ({ createLogger: vi.fn(() => vi.fn()) }));

const { deleteUserChallenge } = await import('~/server/services/challenge.service');
const { ChallengeSource, ChallengeStatus } = await import('~/shared/utils/prisma/enums');

const OWNER = 42;
const makeChallenge = (o: Record<string, unknown> = {}) => ({
  id: 1,
  source: ChallengeSource.User,
  createdById: OWNER,
  status: ChallengeStatus.Scheduled,
  collectionId: 100,
  ...o,
});

describe('deleteUserChallenge', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDbRead.collectionItem.count.mockResolvedValue(0);
  });

  it('owner + Scheduled + 0 entries: refunds and deletes', async () => {
    mockDbRead.challenge.findUnique.mockResolvedValue(makeChallenge());
    const res = await deleteUserChallenge({ id: 1, userId: OWNER });
    expect(res).toEqual({ success: true });
    expect(mockRefundUserChallengeFunds).toHaveBeenCalledWith(1);
    expect(mockDbWrite.challenge.delete).toHaveBeenCalledWith({ where: { id: 1 } });
    expect(mockDbWrite.collection.delete).toHaveBeenCalledWith({ where: { id: 100 } });
  });

  it('rejects non-owner', async () => {
    mockDbRead.challenge.findUnique.mockResolvedValue(makeChallenge({ createdById: 999 }));
    await expect(deleteUserChallenge({ id: 1, userId: OWNER })).rejects.toThrow(
      /your own challenges/i
    );
    expect(mockDbWrite.challenge.delete).not.toHaveBeenCalled();
  });

  it('rejects non-User source', async () => {
    mockDbRead.challenge.findUnique.mockResolvedValue(
      makeChallenge({ source: ChallengeSource.System })
    );
    await expect(deleteUserChallenge({ id: 1, userId: OWNER })).rejects.toThrow();
    expect(mockDbWrite.challenge.delete).not.toHaveBeenCalled();
  });

  it('rejects non-Scheduled status', async () => {
    mockDbRead.challenge.findUnique.mockResolvedValue(
      makeChallenge({ status: ChallengeStatus.Active })
    );
    await expect(deleteUserChallenge({ id: 1, userId: OWNER })).rejects.toThrow();
    expect(mockDbWrite.challenge.delete).not.toHaveBeenCalled();
  });

  it('rejects when entries exist', async () => {
    mockDbRead.challenge.findUnique.mockResolvedValue(makeChallenge());
    mockDbRead.collectionItem.count.mockResolvedValue(3);
    await expect(deleteUserChallenge({ id: 1, userId: OWNER })).rejects.toThrow(/entries/i);
    expect(mockDbWrite.challenge.delete).not.toHaveBeenCalled();
  });

  it('missing challenge throws NOT_FOUND', async () => {
    mockDbRead.challenge.findUnique.mockResolvedValue(null);
    await expect(deleteUserChallenge({ id: 1, userId: OWNER })).rejects.toThrow(/not found/i);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/server/services/__tests__/challenge-delete-user.service.test.ts`
Expected: FAIL — `deleteUserChallenge` is not exported from the service.

- [ ] **Step 3: Add `deleteUserChallenge` and `getUserChallengeForEdit` to the service**

In `src/server/services/challenge.service.ts`, immediately **after** the existing `deleteChallenge` function (which ends at ~line 1559), add:

```ts
// User-scoped delete: a creator may delete their own challenge only while it is still Scheduled
// with no entries (no entry fees collected). Delegates to deleteChallenge, which already refunds
// the creator's escrowed prize for Scheduled User challenges before removing challenge + collection.
export async function deleteUserChallenge({ id, userId }: { id: number; userId: number }) {
  const existing = await dbRead.challenge.findUnique({
    where: { id },
    select: { source: true, createdById: true, status: true, collectionId: true },
  });
  if (!existing) throw throwNotFoundError('Challenge not found');
  if (existing.source !== ChallengeSource.User)
    throw new TRPCError({ code: 'FORBIDDEN', message: 'This challenge cannot be deleted here.' });
  if (existing.createdById !== userId)
    throw new TRPCError({ code: 'FORBIDDEN', message: 'You can only delete your own challenges.' });
  if (existing.status !== ChallengeStatus.Scheduled)
    throw new TRPCError({
      code: 'PRECONDITION_FAILED',
      message: 'A published challenge can no longer be deleted.',
    });
  if (existing.collectionId) {
    const entryCount = await dbRead.collectionItem.count({
      where: { collectionId: existing.collectionId },
    });
    if (entryCount > 0)
      throw new TRPCError({
        code: 'PRECONDITION_FAILED',
        message: 'This challenge already has entries and can no longer be deleted.',
      });
  }
  // deleteChallenge re-reads status and only refunds/deletes a Scheduled row, so a race with the
  // activation job fails safe (blocks Active) rather than double-refunding.
  return deleteChallenge(id);
}

// User-safe fetch for the edit form. getChallengeForEdit is moderator-only; this guards ownership
// first, then returns the same shape. User challenges have judgingPrompt = null, so nothing
// moderator-sensitive is exposed.
export async function getUserChallengeForEdit({ id, userId }: { id: number; userId: number }) {
  const existing = await dbRead.challenge.findUnique({
    where: { id },
    select: { source: true, createdById: true, status: true },
  });
  if (!existing) throw throwNotFoundError('Challenge not found');
  if (existing.source !== ChallengeSource.User || existing.createdById !== userId)
    throw new TRPCError({ code: 'FORBIDDEN', message: 'You can only edit your own challenges.' });
  if (existing.status !== ChallengeStatus.Scheduled)
    throw new TRPCError({
      code: 'PRECONDITION_FAILED',
      message: 'A published challenge can no longer be edited.',
    });
  return getChallengeForEdit(id);
}
```

Confirm `throwNotFoundError` is already imported in this file (it is used by `upsertUserChallenge`). If a lint/type error says otherwise, import it from `~/server/utils/errorHandling`.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/server/services/__tests__/challenge-delete-user.service.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Wire the router procedures**

In `src/server/routers/challenge.router.ts`, add the two service fns to the import block from `~/server/services/challenge.service` (alongside `deleteChallenge`, `getChallengeForEdit`, `upsertUserChallenge`):

```ts
  deleteUserChallenge,
  getUserChallengeForEdit,
```

Then add these two procedures. Put `getUserChallengeForEdit` right after the moderator `getForEdit` (`:149-152`), and `deleteUserChallenge` right after the `upsertUserChallenge` mutation (`:169-174`):

```ts
  // User: fetch own Scheduled challenge for editing (owner-guarded in the service).
  getUserChallengeForEdit: protectedProcedure
    .input(getByIdSchema)
    .use(isFlagProtected('challengePlatform'))
    .use(isFlagProtected('userChallenges'))
    .query(({ input, ctx }) => getUserChallengeForEdit({ id: input.id, userId: ctx.user.id })),
```

```ts
  // User: delete own Scheduled, entry-free challenge (refunds escrowed prize). Owner/status guards
  // enforced in the service.
  deleteUserChallenge: protectedProcedure
    .meta({ requiredScope: TokenScope.SocialWrite, blockApiKeys: true })
    .input(getByIdSchema)
    .use(isFlagProtected('challengePlatform'))
    .use(isFlagProtected('userChallenges'))
    .mutation(({ input, ctx }) => deleteUserChallenge({ id: input.id, userId: ctx.user.id })),
```

`getByIdSchema` and `TokenScope` are already imported in this file.

- [ ] **Step 6: Typecheck + commit**

Run: `pnpm run typecheck` (expect it to complete with no new errors — needs the 8GB heap the script sets; do not use bare `tsc`).

```bash
git add src/server/services/challenge.service.ts src/server/routers/challenge.router.ts src/server/services/__tests__/challenge-delete-user.service.test.ts
git commit -m "feat(challenges): add user deleteUserChallenge + getUserChallengeForEdit procedures"
```

---

### Task 2: Server — expose true `createdById` on list-item + detail payloads

**Files:**
- Modify: `src/server/services/challenge.service.ts` (list-item mapping ~line 271-306; its item type ~line 197-215; and `getChallengeDetail`'s select + return)

**Interfaces:**
- Consumes: existing raw query field `c."createdById"` (already selected at `challenge.service.ts:238`).
- Produces: a top-level `createdById: number` on each list item returned by `getInfiniteChallenges`, and on the object returned by `getChallengeDetail`. This is the field all client owner checks use.

- [ ] **Step 1: Add `createdById` to the list-item return**

In `src/server/services/challenge.service.ts`, in the `getInfiniteChallenges` `items.map(...)` return object (starts at line 271), add a line next to `source`:

```ts
      source: item.source,
      createdById: item.createdById,
```

If the mapped-item TypeScript type (the `type` around line 197-215 describing each `item`) does not already include `createdById: number`, it does — the raw select at line 238 provides it — but if the return's inferred type needs it declared, add `createdById: number;` there too.

- [ ] **Step 2: Add `createdById` to the detail payload**

Find `getChallengeDetail` in the same file. Locate its Prisma/SQL select and the object it returns to the client. Ensure the challenge's raw creator id flows through as a top-level `createdById: number`:
- If the select already reads `createdById` (for building `createdBy`), add `createdById` to the returned object.
- Verify the field is present in the client type after the change:

Run: `grep -n "createdById" src/server/services/challenge.service.ts`
Expected: new references in both `getInfiniteChallenges`' return and `getChallengeDetail`'s return.

- [ ] **Step 3: Typecheck**

Run: `pnpm run typecheck`
Expected: completes; the tRPC output types for `getInfinite` items and `getById`/detail now include `createdById`. (Consumers are added in Tasks 5-6.)

- [ ] **Step 4: Commit**

```bash
git add src/server/services/challenge.service.ts
git commit -m "feat(challenges): expose true createdById on list + detail payloads for owner checks"
```

---

### Task 3: Client — `useDeleteUserChallenge` hook

**Files:**
- Modify: `src/components/Challenge/challenge.utils.ts` (add the mutation hook alongside the existing query hooks)

**Interfaces:**
- Consumes: `trpc.challenge.deleteUserChallenge`, `trpc.useUtils()`, `showSuccessNotification`/`showErrorNotification` (match how other hooks in this file surface notifications — check the file's existing imports and reuse them).
- Produces: `useDeleteUserChallenge()` → `{ deleteChallenge: (id: number) => Promise<void>, deleting: boolean }`.

- [ ] **Step 1: Add the hook**

In `src/components/Challenge/challenge.utils.ts`, add:

```ts
export function useDeleteUserChallenge() {
  const utils = trpc.useUtils();
  const mutation = trpc.challenge.deleteUserChallenge.useMutation({
    onSuccess: async () => {
      await utils.challenge.getInfinite.invalidate();
    },
  });

  const deleteChallenge = async (id: number) => {
    await mutation.mutateAsync({ id });
  };

  return { deleteChallenge, deleting: mutation.isLoading };
}
```

Match the file's existing error/success notification convention: if other mutations in this file (or `useMutateBounty` in `bounty.utils.ts`) attach `showErrorNotification` in `onError` and `showSuccessNotification` in `onSuccess`, do the same here with the message "Challenge deleted — your escrowed Buzz has been refunded." Use whichever notification helpers are already imported in `challenge.utils.ts`.

- [ ] **Step 2: Typecheck**

Run: `pnpm run typecheck`
Expected: completes; `trpc.challenge.deleteUserChallenge` resolves (added in Task 1).

- [ ] **Step 3: Commit**

```bash
git add src/components/Challenge/challenge.utils.ts
git commit -m "feat(challenges): add useDeleteUserChallenge mutation hook"
```

---

### Task 4: Client — `ChallengeContextMenu` component (owner Edit + Delete)

**Files:**
- Create: `src/components/Challenge/ChallengeContextMenu.tsx`

**Interfaces:**
- Consumes: `useDeleteUserChallenge` (Task 3), `useCurrentUser`, `ChallengeSource`/`ChallengeStatus`, `ActionIconDotsVertical`, Mantine `Menu`, `openConfirmModal`/`closeAllModals`.
- Produces: `ChallengeContextMenu` — shows Edit (link → `/challenges/${id}/edit`) and Delete (confirm modal → `useDeleteUserChallenge`) only when the viewer owns a `source=User`, `Scheduled` challenge. Renders nothing otherwise.

```tsx
type Props = MenuProps & {
  challenge: { id: number; createdById: number; source: ChallengeSource; status: ChallengeStatus };
  buttonProps?: ActionIconProps;
};
```

- [ ] **Step 1: Create the component**

Create `src/components/Challenge/ChallengeContextMenu.tsx` (mirrors `src/components/Bounty/BountyContextMenu.tsx`, trimmed to Edit + Delete):

```tsx
import type { ActionIconProps, MenuProps } from '@mantine/core';
import { Menu } from '@mantine/core';
import { closeAllModals, openConfirmModal } from '@mantine/modals';
import { IconEdit, IconTrash } from '@tabler/icons-react';
import { useRouter } from 'next/router';
import { NextLink as Link } from '~/components/NextLink/NextLink';
import { ActionIconDotsVertical } from '~/components/Cards/components/ActionIconDotsVertical';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { useDeleteUserChallenge } from '~/components/Challenge/challenge.utils';
import { ChallengeSource, ChallengeStatus } from '~/shared/utils/prisma/enums';

type Props = MenuProps & {
  challenge: { id: number; createdById: number; source: ChallengeSource; status: ChallengeStatus };
  buttonProps?: ActionIconProps;
};

export function ChallengeContextMenu({ challenge, buttonProps, ...menuProps }: Props) {
  const currentUser = useCurrentUser();
  const router = useRouter();
  const { deleteChallenge, deleting } = useDeleteUserChallenge();

  const canManage =
    !!currentUser &&
    currentUser.id === challenge.createdById &&
    challenge.source === ChallengeSource.User &&
    challenge.status === ChallengeStatus.Scheduled;

  if (!canManage) return null;

  return (
    <Menu {...menuProps}>
      <Menu.Target>
        <ActionIconDotsVertical
          onClick={(e: React.MouseEvent<HTMLButtonElement>) => {
            e.preventDefault();
            e.stopPropagation();
          }}
          {...buttonProps}
        />
      </Menu.Target>
      <Menu.Dropdown>
        <Link legacyBehavior href={`/challenges/${challenge.id}/edit`} passHref>
          <Menu.Item component="a" leftSection={<IconEdit size={14} stroke={1.5} />}>
            Edit
          </Menu.Item>
        </Link>
        <Menu.Item
          color="red"
          leftSection={<IconTrash size={14} stroke={1.5} />}
          disabled={deleting}
          onClick={(e: React.MouseEvent) => {
            e.stopPropagation();
            e.preventDefault();
            openConfirmModal({
              title: 'Delete challenge',
              children:
                'Delete this challenge? Your escrowed prize Buzz will be refunded. This cannot be undone.',
              centered: true,
              closeOnConfirm: false,
              labels: { cancel: 'No, keep it', confirm: 'Delete challenge' },
              confirmProps: { color: 'red' },
              onConfirm: async () => {
                try {
                  await deleteChallenge(challenge.id);
                  closeAllModals();
                  const atDetails = router.pathname === '/challenges/[id]/[[...slug]]';
                  if (atDetails) await router.push('/challenges');
                } catch {
                  // notification is surfaced by the mutation's onError
                }
              },
            });
          }}
        >
          Delete
        </Menu.Item>
      </Menu.Dropdown>
    </Menu>
  );
}
```

- [ ] **Step 2: Typecheck**

Run: `pnpm run typecheck`
Expected: completes.

- [ ] **Step 3: Commit**

```bash
git add src/components/Challenge/ChallengeContextMenu.tsx
git commit -m "feat(challenges): add ChallengeContextMenu (owner Edit/Delete)"
```

---

### Task 5: Client — render owner menu on `ChallengeCard`

**Files:**
- Modify: `src/components/Cards/ChallengeCard.tsx` (destructure `createdById`; render `ChallengeContextMenu` in the header's empty right slot)

**Interfaces:**
- Consumes: `ChallengeContextMenu` (Task 4), the new `createdById` field on the card data (Task 2).
- Produces: an owner-only action menu on each card. No prop threading — the menu self-gates via `createdById`/`source`/`status`, so it appears on any feed (including the owner-filtered "My Challenges" view from Task 7).

- [ ] **Step 1: Destructure `createdById`**

In `src/components/Cards/ChallengeCard.tsx`, add `createdById` to the destructure block (~lines 88-95, where `status`, `source`, `createdBy` are pulled from `data`):

```tsx
    status,
    source,
    createdById,
    ...
    createdBy,
```

- [ ] **Step 2: Render the menu in the header right slot**

The header (`~lines 118-148`) is a `<div className="flex w-full justify-between">` whose right side is currently empty. Add the menu as the right child. Import it at the top:

```tsx
import { ChallengeContextMenu } from '~/components/Challenge/ChallengeContextMenu';
```

Then, as the last child inside the header flex `<div>` (after the left badges `<div className="flex gap-1">…</div>`):

```tsx
        <ChallengeContextMenu
          challenge={{ id, createdById, source, status }}
          challenge-position="bottom-end"
          position="bottom-end"
          withinPortal
        />
```

(Remove the stray `challenge-position` line — that was a copy artifact; keep only `position="bottom-end"` and `withinPortal`.) `id` is already destructured from `data`; if not, add it. The component returns `null` for non-owners, so non-owned cards are visually unchanged.

- [ ] **Step 3: Typecheck**

Run: `pnpm run typecheck`
Expected: completes.

- [ ] **Step 4: Manual verification**

Start the dev server (via the `/dev-server` skill). As a user with the `userChallenges` flag: create a challenge, then open `/challenges`. On your own Scheduled challenge card the ⋮ menu shows Edit + Delete; on others (and on non-Scheduled) no menu appears.

- [ ] **Step 5: Commit**

```bash
git add src/components/Cards/ChallengeCard.tsx
git commit -m "feat(challenges): show owner Edit/Delete menu on ChallengeCard"
```

---

### Task 6: Client — owner Edit/Delete on the challenge detail page

**Files:**
- Modify: `src/pages/challenges/[id]/[[...slug]].tsx` (add an owner branch to the existing context menu; add a user-delete handler)

**Interfaces:**
- Consumes: `useDeleteUserChallenge` (Task 3), the detail payload's `createdById` (Task 2), existing `isScheduled`/`currentUser`/`ChallengeSource` already in scope.
- Produces: a non-moderator creator sees Edit + Delete on their own Scheduled challenge's ⋮ menu.

- [ ] **Step 1: Add owner state + handler**

Near the top of the component (where `handleDelete` is defined at line 290), add:

```tsx
  const { deleteChallenge: deleteOwnChallenge } = useDeleteUserChallenge();
  const isOwner =
    !!currentUser &&
    currentUser.id === challenge.createdById &&
    challenge.source === ChallengeSource.User;
  const canManageOwn = isOwner && !currentUser?.isModerator && isScheduled;

  const handleOwnerDelete = () => {
    openConfirmModal({
      title: 'Delete challenge',
      children:
        'Delete this challenge? Your escrowed prize Buzz will be refunded. This cannot be undone.',
      centered: true,
      closeOnConfirm: false,
      labels: { cancel: 'No, keep it', confirm: 'Delete challenge' },
      confirmProps: { color: 'red' },
      onConfirm: async () => {
        try {
          await deleteOwnChallenge(challenge.id);
          closeAllModals();
          await router.push('/challenges');
        } catch {
          // notification surfaced by the mutation
        }
      },
    });
  };
```

Import at the top of the file if not already present: `import { useDeleteUserChallenge } from '~/components/Challenge/challenge.utils';` and ensure `openConfirmModal`, `closeAllModals` from `@mantine/modals` are imported (the mod path already uses confirm modals — reuse the existing import if present).

- [ ] **Step 2: Widen the menu's visibility condition**

The menu wrapper renders only when `(currentUser?.isModerator || canReport)` (line 337). Change it to also open for an owner-manager:

```tsx
              {(currentUser?.isModerator || canReport || canManageOwn) && (
```

- [ ] **Step 3: Add the owner Edit/Delete branch**

Inside `<Menu.Dropdown>` (after the moderator `{currentUser?.isModerator && (…)}` block that ends at line 417, before the `{canReport && (…)}` block at line 418), insert:

```tsx
                    {canManageOwn && (
                      <>
                        <Menu.Label>Actions</Menu.Label>
                        <Menu.Item
                          leftSection={<IconPencil size={14} stroke={1.5} />}
                          component={Link}
                          href={`/challenges/${challenge.id}/edit`}
                        >
                          Edit Challenge
                        </Menu.Item>
                        <Menu.Item
                          leftSection={<IconTrash size={14} />}
                          color="red"
                          onClick={handleOwnerDelete}
                        >
                          Delete
                        </Menu.Item>
                      </>
                    )}
```

`IconPencil`, `IconTrash`, and `Link` are already imported in this file (used by the moderator branch).

- [ ] **Step 4: Typecheck**

Run: `pnpm run typecheck`
Expected: completes.

- [ ] **Step 5: Manual verification**

As the creator (non-mod) of a Scheduled user challenge, open `/challenges/<id>` → ⋮ shows Edit + Delete. Delete refunds Buzz and redirects to `/challenges`. Editing while the challenge is Active or after entries exist is not offered (menu items hidden) and the server proc rejects it if forced.

- [ ] **Step 6: Commit**

```bash
git add "src/pages/challenges/[id]/[[...slug]].tsx"
git commit -m "feat(challenges): owner Edit/Delete on challenge detail page"
```

---

### Task 7: Client — user edit route `/challenges/[id]/edit`

**Files:**
- Create: `src/pages/challenges/[id]/edit.tsx`

**Interfaces:**
- Consumes: `trpc.challenge.getUserChallengeForEdit` (Task 1), `ChallengeUpsertForm` with `variant="user"` and a `challenge` prop.
- Produces: an owner-only edit page. The server proc enforces owner + `source=User` + `Scheduled`; the page renders the user-variant form pre-filled.

- [ ] **Step 1: Create the page**

Create `src/pages/challenges/[id]/edit.tsx` (mirrors `src/pages/moderator/challenges/[id]/edit.tsx`, using the user fetch + `variant="user"`):

```tsx
import { Center, Container, Loader } from '@mantine/core';
import { useRouter } from 'next/router';
import { Meta } from '~/components/Meta/Meta';
import { ChallengeUpsertForm } from '~/components/Challenge/ChallengeUpsertForm';
import { NotFound } from '~/components/AppLayout/NotFound';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { createServerSideProps } from '~/server/utils/server-side-helpers';
import { ChallengeSource } from '~/shared/utils/prisma/enums';
import { trpc } from '~/utils/trpc';

export default function EditUserChallengePage() {
  const router = useRouter();
  const features = useFeatureFlags();
  const challengeId = Number(router.query.id);

  const { data: challenge, isLoading } = trpc.challenge.getUserChallengeForEdit.useQuery(
    { id: challengeId },
    { enabled: !!challengeId && !isNaN(challengeId), retry: false }
  );

  if (!features.challengePlatform || !features.userChallenges) return <NotFound />;

  if (isLoading) {
    return (
      <Center py="xl">
        <Loader size="xl" />
      </Center>
    );
  }

  if (!challenge) return <NotFound />;

  const challengeForForm = {
    id: challenge.id,
    title: challenge.title,
    description: challenge.description,
    theme: challenge.theme,
    invitation: challenge.invitation,
    coverImage: challenge.coverImage
      ? { id: challenge.coverImage.id, url: challenge.coverImage.url }
      : null,
    modelVersionIds: challenge.modelVersionIds ?? [],
    nsfwLevel: challenge.nsfwLevel,
    allowedNsfwLevel: challenge.allowedNsfwLevel ?? 1,
    judgeId: challenge.judge?.id ?? null,
    eventId: challenge.eventId ?? null,
    judgingPrompt: challenge.judgingPrompt,
    reviewPercentage: challenge.reviewPercentage,
    maxEntriesPerUser: challenge.maxEntriesPerUser,
    entryPrizeRequirement: challenge.entryPrizeRequirement ?? 10,
    prizePool: challenge.prizePool,
    operationBudget: challenge.operationBudget ?? 0,
    reviewCostType: challenge.reviewCostType ?? 'None',
    reviewCost: challenge.reviewCost ?? 0,
    startsAt: new Date(challenge.startsAt),
    endsAt: new Date(challenge.endsAt),
    visibleAt: new Date(challenge.visibleAt),
    status: challenge.status,
    source: challenge.source,
    prizes: challenge.prizes,
    entryPrize: challenge.entryPrize,
    prizeMode: challenge.prizeMode,
    basePrizePool: challenge.basePrizePool,
    buzzPerAction: challenge.buzzPerAction,
    poolTrigger: challenge.poolTrigger,
    maxPrizePool: challenge.maxPrizePool,
    prizeDistribution: challenge.prizeDistribution,
    themeElements: challenge.themeElements,
    judgingCategories: challenge.judgingCategories ?? undefined,
    entryFee: challenge.entryFee,
    maxParticipants: challenge.maxParticipants,
    initialPrizeBuzz:
      challenge.source === ChallengeSource.User ? challenge.basePrizePool : undefined,
  };

  return (
    <>
      <Meta title={`Edit Challenge: ${challenge.title}`} deIndex />
      <Container size="lg" py="md">
        <ChallengeUpsertForm variant="user" challenge={challengeForForm} />
      </Container>
    </>
  );
}

export const getServerSideProps = createServerSideProps({
  useSession: true,
  resolver: async ({ session, features, ctx }) => {
    if (!features?.challengePlatform || !features?.userChallenges) return { notFound: true };
    if (!session)
      return {
        redirect: {
          destination: `/login?returnUrl=${encodeURIComponent(ctx.resolvedUrl)}`,
          permanent: false,
        },
      };
  },
});
```

The `challengeForForm` shape is copied verbatim from the moderator edit page (`src/pages/moderator/challenges/[id]/edit.tsx:48-90`), so the fields match what `getChallengeForEdit` returns. If typecheck flags a field name mismatch against `getUserChallengeForEdit`'s inferred type (same underlying fetch), fix that field to match the moderator page's usage.

- [ ] **Step 2: Typecheck**

Run: `pnpm run typecheck`
Expected: completes.

- [ ] **Step 3: Manual verification**

As the creator of a Scheduled user challenge, visit `/challenges/<id>/edit` → the user-variant form loads pre-filled; saving updates the challenge (and, per `upsertUserChallenge`, re-queues a scan). As a non-owner, the server proc returns FORBIDDEN and the page shows NotFound.

- [ ] **Step 4: Commit**

```bash
git add "src/pages/challenges/[id]/edit.tsx"
git commit -m "feat(challenges): add user-facing challenge edit route"
```

---

### Task 8: Client — "My Challenges" mode on `/challenges`

**Files:**
- Modify: `src/pages/challenges/index.tsx` (render a My-Challenges view when `?engagement=created`)

**Interfaces:**
- Consumes: `ChallengesInfinite` with `filters={{ userId, status, source, ... }}`, `useCurrentUser`, `ChallengeStatus`/`ChallengeSource`.
- Produces: a signed-in creator's own challenges, filtered by a status SegmentedControl. The `getInfinite` `userId` filter (`challenge.service.ts:384`) restricts to `createdById = self` and exempts the creator from the scan gate, so pre-scan Scheduled challenges show.

- [ ] **Step 1: Add the My-Challenges branch**

In `src/pages/challenges/index.tsx`, inside `ChallengesPage` (after `currentUser` is read, ~line 48), add:

```tsx
  const mine = router.query.engagement === 'created';
  const [myStatus, setMyStatus] = useState<'Scheduled' | 'Active' | 'Completed'>('Scheduled');

  const myStatusFilters: Record<string, Partial<GetInfiniteChallengesInput>> = {
    Scheduled: { status: [ChallengeStatus.Scheduled], includeEnded: false },
    Active: { status: [ChallengeStatus.Active], includeEnded: false },
    Completed: { status: [ChallengeStatus.Completed], includeEnded: true },
  };
```

Add the imports if missing: `useState` from `react`; `ChallengeStatus` from `~/shared/utils/prisma/enums`; `SegmentedControl`, `Title`, `Stack` from `@mantine/core`; and `GetInfiniteChallengesInput` type from `~/server/schema/challenge.schema` (type-only import). `ChallengeSource` and `ChallengesInfinite` are already imported.

Then, near the top of the returned JSX (before the featured/daily/community sections), short-circuit into the My-Challenges view:

```tsx
  if (mine) {
    if (!currentUser) return <NotFound />;
    return (
      <MasonryContainer>
        <Stack gap="xl" align="flex-start">
          <Title>My Challenges</Title>
          <SegmentedControl
            radius="xl"
            data={['Scheduled', 'Active', 'Completed']}
            value={myStatus}
            onChange={(v) => setMyStatus(v as 'Scheduled' | 'Active' | 'Completed')}
          />
          <ChallengesInfinite
            filters={{
              userId: currentUser.id,
              source: [ChallengeSource.User],
              excludeEventChallenges: true,
              ...myStatusFilters[myStatus],
            }}
          />
        </Stack>
      </MasonryContainer>
    );
  }
```

Use whatever container the existing page body uses (check the return: if it wraps sections in `MasonryContainer`, mirror that; otherwise use the same layout wrapper the community feed already sits in). `NotFound` is imported in the moderator edit page's pattern — import from `~/components/AppLayout/NotFound` if not already present.

- [ ] **Step 2: Typecheck**

Run: `pnpm run typecheck`
Expected: completes.

- [ ] **Step 3: Manual verification**

Signed in with the flag: visit `/challenges?engagement=created` → "My Challenges" with a Scheduled/Active/Completed toggle listing only your challenges (including a just-created, not-yet-scanned Scheduled one). Signed out → NotFound. Plain `/challenges` (no param) is unchanged.

- [ ] **Step 4: Commit**

```bash
git add src/pages/challenges/index.tsx
git commit -m "feat(challenges): add My Challenges view on /challenges"
```

---

### Task 9: Client — "My Challenges" nav link

**Files:**
- Modify: `src/components/AppLayout/AppHeader/hooks.tsx` (add a user-menu entry)

**Interfaces:**
- Consumes: existing menu-item shape (`href`/`as`/`visible`/`icon`/`color`/`label`), `features.userChallenges`, `IconTrophy`.
- Produces: a "My Challenges" link in the user dropdown → `/challenges?engagement=created`.

- [ ] **Step 1: Add the menu entry**

In `src/components/AppLayout/AppHeader/hooks.tsx`, next to the "My Bounties" entry (`:121-128`), add:

```tsx
        {
          href: '/challenges?engagement=created',
          as: '/challenges',
          visible: features.challengePlatform && features.userChallenges,
          icon: IconTrophy,
          color: theme.colors.yellow[getPrimaryShade(theme, colorScheme ?? 'dark')],
          label: 'My Challenges',
        },
```

`IconTrophy` is already imported in this file (used by the "Create a Challenge" entry at `:364`). If `theme.colors.yellow` is not a valid key here, reuse the same color expression the "Create a Challenge" entry uses.

- [ ] **Step 2: Typecheck**

Run: `pnpm run typecheck`
Expected: completes.

- [ ] **Step 3: Manual verification**

Signed in with the flag → user dropdown shows "My Challenges" linking to the Task 8 view. Flag off → hidden.

- [ ] **Step 4: Commit**

```bash
git add src/components/AppLayout/AppHeader/hooks.tsx
git commit -m "feat(challenges): add My Challenges nav link"
```

---

## Self-Review

**Spec coverage:**
- View own challenges → Tasks 8 (My Challenges view) + 9 (nav) + 2 (createdById) ✓
- Edit while Scheduled → Task 7 (edit route) + Task 1 (`getUserChallengeForEdit`) + existing `upsertUserChallenge` ✓
- Delete while Scheduled + 0 entries + refund → Task 1 (`deleteUserChallenge`), surfaced in Tasks 4/5/6 ✓
- End/void/pick-winners stay mod-only → untouched (no task modifies them) ✓
- Owner affordances on card + detail → Tasks 5, 6 ✓
- Bounties parallel work → explicitly out of scope (spec follow-up), no task ✓

**Placeholder scan:** No TBD/TODO. One deliberate copy-artifact call-out in Task 5 Step 2 (the stray `challenge-position` line) is flagged for removal in the same step. Detail-payload `createdById` (Task 2 Step 2) is a locate-then-add step because `getChallengeDetail`'s exact return block wasn't quoted here — the field to add and a verification grep are given.

**Type consistency:** `deleteUserChallenge`/`getUserChallengeForEdit` signatures identical across service (Task 1) and router (Task 1) and client hook/pages (Tasks 3, 7). `createdById: number` added in Task 2 is consumed as `challenge.createdById` in Tasks 4/5/6. `useDeleteUserChallenge` returns `{ deleteChallenge, deleting }` in Task 3, consumed with those exact names in Tasks 4/6. `ChallengeContextMenu` prop `challenge: { id, createdById, source, status }` (Task 4) matches the object passed in Task 5.

**Known soft spots (verify during implementation, not blockers):**
- Task 2: the detail return block must actually forward `createdById`; the grep in Step 2 confirms it.
- Task 7 & 8 imports (`NotFound`, `MasonryContainer`, `useState`, `GetInfiniteChallengesInput`) — add per the actual current import list of each file.
- `challenge.utils.ts` notification helpers (Task 3) — reuse whatever that file already imports.
