import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as QueueOwners from '$lib/server/queue-owners';
import { NAVIGATION } from '$lib/server/access';
import { ownableQueues } from '$lib/queue-owners';

/** Who may assign queue owners, and what reaches the write. The write itself is covered against a real
 *  database in `queue-owners.pglite.test.ts`. */

const { changeQueueOwners, listModeratorCandidates } = vi.hoisted(() => ({
  changeQueueOwners: vi.fn(),
  listModeratorCandidates: vi.fn(),
}));

vi.mock('$lib/server/db', () => ({ dbRead: {}, dbWrite: {} }));
vi.mock('$lib/server/queue-owners', async (importOriginal) => ({
  ...(await importOriginal<typeof QueueOwners>()),
  changeQueueOwners,
  listModeratorCandidates,
}));

const { actions, load } = await import('../queue-owners/+page.server');

const ADMIN = { id: 42, roles: ['moderator:admin'] };
const MOD = { id: 7, roles: ['moderator:mod-high-access'] };
const QUEUE = ownableQueues(NAVIGATION)[0].path;

const request = (fields: Record<string, string>) =>
  ({
    formData: async () => {
      const form = new FormData();
      for (const [k, v] of Object.entries(fields)) form.set(k, v);
      return form;
    },
  } as never);

const save = (
  changes: Record<string, number[]>,
  expect: Record<string, number[]> = Object.fromEntries(Object.keys(changes).map((p) => [p, []])),
  user: unknown = ADMIN
) =>
  actions.save({
    request: request({ changes: JSON.stringify(changes), expect: JSON.stringify(expect) }),
    locals: { user },
  } as never);

beforeEach(() => {
  vi.resetAllMocks();
  changeQueueOwners.mockResolvedValue({ changed: 1 });
  listModeratorCandidates.mockResolvedValue([
    { id: 7, username: 'a', roles: [] },
    { id: 8, username: 'b', roles: [] },
  ]);
});

describe('the queue owners page', () => {
  it.each([MOD, null])('refuses a non-admin the save (%o)', async (user) => {
    expect(await save({ [QUEUE]: [7] }, undefined, user)).toMatchObject({ status: 403 });
    expect(changeQueueOwners).not.toHaveBeenCalled();
  });

  it('refuses a non-admin the page itself', async () => {
    await expect(load({ locals: { user: MOD } } as never)).rejects.toMatchObject({ status: 403 });
  });

  it('saves owners on a queue, as the acting admin, with what the page showed', async () => {
    expect(await save({ [QUEUE]: [7, 8, 7] })).toMatchObject({ success: true, count: 1 });
    expect(changeQueueOwners).toHaveBeenCalledWith({
      entries: [{ path: QUEUE, owners: [7, 8] }],
      expect: { [QUEUE]: [] },
      actorId: ADMIN.id,
    });
  });

  it('refuses to add someone who is not a moderator', async () => {
    expect(await save({ [QUEUE]: [7, 99] })).toMatchObject({ status: 400 });
    expect(changeQueueOwners).not.toHaveBeenCalled();
  });

  it('keeps a former moderator already on the queue without re-checking them', async () => {
    expect(await save({ [QUEUE]: [99, 8] }, { [QUEUE]: [99] })).toMatchObject({ success: true });
    expect(changeQueueOwners).toHaveBeenCalled();
  });

  it('refuses owners on a path that is not a queue, but lets a retired one be emptied', async () => {
    expect(await save({ '/admin': [7] })).toMatchObject({ status: 400 });
    expect(await save({ '/no-longer-a-queue': [7] })).toMatchObject({ status: 400 });
    expect(changeQueueOwners).not.toHaveBeenCalled();
    expect(await save({ '/no-longer-a-queue': [] }, { '/no-longer-a-queue': [7] })).toMatchObject({
      success: true,
    });
  });

  it('refuses a change that does not say what it replaces', async () => {
    expect(await save({ [QUEUE]: [7] }, {})).toMatchObject({ status: 400 });
    expect(changeQueueOwners).not.toHaveBeenCalled();
  });

  it('turns a conflict into a refusal the page can show, not an error page', async () => {
    const { QueueOwnerConflictError } = await import('$lib/server/queue-owners');
    changeQueueOwners.mockRejectedValue(new QueueOwnerConflictError(QUEUE));
    expect(await save({ [QUEUE]: [7] })).toMatchObject({ status: 409 });
  });
});
