import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ClickupWebhookPayload } from '~/server/schema/bug.schema';
import { dbMock } from '~/__tests__/mocks/db.mock';

type BugUpdateArgs = { where: { id: number }; data: { status?: string; resolvedAt?: Date | null } };
type HistoryItem = NonNullable<ClickupWebhookPayload['history_items']>[number];

/**
 * Distinct ids throughout: a value arriving in the wrong place cannot pass by
 * colliding with the right one. TASK_ID is a strict prefix of NEIGHBOUR_TASK_ID
 * because that is the collision a `contains` lookup makes by itself.
 */
const TASK_ID = '868kfwm3j';
const NEIGHBOUR_TASK_ID = '868kfwm3jx';
const OPEN_BUG = 41;
const NEIGHBOUR_BUG = 52;
const CLOSED_BUG = 63;

const bugFindMany = dbMock.dbRead.bug.findMany;
const bugFindUnique = dbMock.dbRead.bug.findUnique;
const bugUpdate = dbMock.dbWrite.bug.update;

vi.mock('~/server/clickhouse/client', () => ({ clickhouse: null }));

const { clickupDoneStatusFromPayload, clickupTaskIdFromUrl, resolveBugsByClickupTaskId } =
  await import('~/server/services/bug.service');

const url = (taskId: string) => `https://app.clickup.com/t/8459928/${taskId}`;

const row = (
  id: number,
  taskId: string,
  over: Partial<{ status: string; resolvedAt: Date }> = {}
) => ({
  id,
  status: 'Open',
  resolvedAt: null,
  clickupUrl: url(taskId),
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  bugUpdate.mockImplementation(async ({ where, data }: BugUpdateArgs) => ({
    id: where.id,
    ...data,
  }));
  bugFindUnique.mockResolvedValue({ status: 'Open', resolvedAt: null });
});

describe('clickupTaskIdFromUrl', () => {
  it('reads the task segment, ignoring query and trailing slash', () => {
    expect(clickupTaskIdFromUrl(url(TASK_ID))).toBe(TASK_ID);
    expect(clickupTaskIdFromUrl(`${url(TASK_ID)}/?block=abc#c`)).toBe(TASK_ID);
  });

  // Justin's note on the ticket: entries may carry a bare task id rather than a
  // full link, so both spellings have to resolve to the same task.
  it('accepts a bare task id', () => {
    expect(clickupTaskIdFromUrl(TASK_ID)).toBe(TASK_ID);
  });

  it('is null when there is no link and when the segment is not an id', () => {
    expect(clickupTaskIdFromUrl(null)).toBeNull();
    expect(clickupTaskIdFromUrl('')).toBeNull();
    expect(clickupTaskIdFromUrl('https://app.clickup.com/t/not an id')).toBeNull();
  });
});

describe('clickupDoneStatusFromPayload', () => {
  const payload = (after: HistoryItem['after'], field = 'status'): ClickupWebhookPayload => ({
    event: 'taskStatusUpdated',
    task_id: TASK_ID,
    history_items: [{ field, after }],
  });

  it("takes ClickUp's status type as authoritative, whatever the status is named", () => {
    expect(clickupDoneStatusFromPayload(payload({ status: 'shipped', type: 'closed' }))).toBe(
      'shipped'
    );
    expect(clickupDoneStatusFromPayload(payload({ status: 'shipped', type: 'open' }))).toBeNull();
  });

  it('falls back to the board closed-status list for a bare status string', () => {
    expect(clickupDoneStatusFromPayload(payload('complete'))).toBe('complete');
    expect(clickupDoneStatusFromPayload(payload('in progress'))).toBeNull();
  });

  it('ignores non-status history items and empty payloads', () => {
    expect(
      clickupDoneStatusFromPayload(payload({ status: 'complete', type: 'closed' }, 'assignee'))
    ).toBeNull();
    expect(clickupDoneStatusFromPayload({ event: 'taskUpdated' })).toBeNull();
  });
});

describe('resolveBugsByClickupTaskId', () => {
  it('closes the entry linked to the completed task', async () => {
    bugFindMany.mockResolvedValue([row(OPEN_BUG, TASK_ID)]);

    const result = await resolveBugsByClickupTaskId({ taskId: TASK_ID });

    expect(result.resolved).toEqual([{ id: OPEN_BUG, previousStatus: 'Open' }]);
    expect(bugUpdate).toHaveBeenCalledTimes(1);
    const { where, data } = bugUpdate.mock.calls[0][0];
    expect(where.id).toBe(OPEN_BUG);
    expect(data.status).toBe('Complete');
    expect(data.resolvedAt).toBeInstanceOf(Date);
  });

  it('leaves an entry whose task merely starts with this id alone', async () => {
    bugFindMany.mockResolvedValue([row(NEIGHBOUR_BUG, NEIGHBOUR_TASK_ID)]);

    const result = await resolveBugsByClickupTaskId({ taskId: TASK_ID });

    expect(result.matched).toEqual([]);
    expect(result.resolved).toEqual([]);
    expect(bugUpdate).not.toHaveBeenCalled();
  });

  it('does not re-stamp an entry that is already closed', async () => {
    bugFindMany.mockResolvedValue([
      row(CLOSED_BUG, TASK_ID, { status: 'Complete', resolvedAt: new Date('2026-08-01') }),
    ]);

    const result = await resolveBugsByClickupTaskId({ taskId: TASK_ID });

    expect(result.skipped).toEqual([CLOSED_BUG]);
    expect(result.resolved).toEqual([]);
    expect(bugUpdate).not.toHaveBeenCalled();
  });
});
