import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as FormActions from '$lib/server/text-scan-tests/form-actions';

vi.mock('$lib/server/db', () => ({ dbRead: {}, dbWrite: {} }));
vi.mock('$app/server', () => ({ getRequestEvent: vi.fn() }));
vi.mock('$lib/server/moderator-db', () => ({ getModeratorDb: () => ({}) }));
const formActions = vi.hoisted(() => ({
  editCaseAction: vi.fn(async () => ({ success: true })),
  removeCaseAction: vi.fn(async () => ({ success: true })),
  archiveSetAction: vi.fn(async () => ({ success: true })),
  rerunAction: vi.fn(async () => ({ started: {} })),
  cancelAction: vi.fn(async () => ({ cancelled: 1 })),
}));
vi.mock('$lib/server/text-scan-tests/form-actions', async (importOriginal) => ({
  ...(await importOriginal<typeof FormActions>()),
  ...formActions,
}));

const setPage = await import('../+page.server');
const runPage = await import('../runs/[runId]/+page.server');

type ActionEvent = Parameters<(typeof setPage.actions)['editCase']>[0];
const event = (grants: Record<string, boolean>) =>
  ({
    request: { formData: async () => new FormData() },
    locals: { user: { id: 1, roles: [] }, grants },
  } as unknown as ActionEvent);
const call = (action: unknown, grants: Record<string, boolean> = {}) =>
  (action as (e: ActionEvent) => Promise<unknown>)(event(grants));

beforeEach(() => vi.clearAllMocks());

describe('grants', () => {
  it('editing, removing and archiving need textScan.testSets.edit', async () => {
    for (const action of ['editCase', 'removeCase', 'archiveSet'] as const)
      expect(await call(setPage.actions[action])).toMatchObject({ status: 403 });
    expect(await call(runPage.actions.editCase)).toMatchObject({ status: 403 });
    expect(formActions.editCaseAction).not.toHaveBeenCalled();
    expect(formActions.removeCaseAction).not.toHaveBeenCalled();
    expect(formActions.archiveSetAction).not.toHaveBeenCalled();
  });

  it('with the edit grant, the case and set edits go through', async () => {
    const edit = { 'textScan.testSets.edit': true };
    for (const action of ['editCase', 'removeCase', 'archiveSet'] as const)
      await call(setPage.actions[action], edit);
    await call(runPage.actions.editCase, edit);
    expect(formActions.editCaseAction).toHaveBeenCalledTimes(2);
    expect(formActions.removeCaseAction).toHaveBeenCalledOnce();
    expect(formActions.archiveSetAction).toHaveBeenCalledOnce();
  });

  it('re-running errors and cancelling need only the page grant', async () => {
    await call(runPage.actions.rerunErrors);
    await call(runPage.actions.cancelRun);
    await call(setPage.actions.cancelRun);
    expect(formActions.rerunAction).toHaveBeenCalledOnce();
    expect(formActions.cancelAction).toHaveBeenCalledTimes(2);
  });
});
