import { beforeEach, describe, expect, it, vi } from 'vitest';
import { clickupWebhookSchema } from '~/server/schema/bug.schema';
import type { ClickupWebhookPayload } from '~/server/schema/bug.schema';
import { dbMock } from '~/__tests__/mocks/db.mock';

type BugUpdateArgs = { where: { id: number }; data: { status?: string; resolvedAt?: Date | null } };

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
const bugWriteFindMany = dbMock.dbWrite.bug.findMany;
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
  // reset, not clear: `...Once` queues survive clearAllMocks and would otherwise
  // bleed a previous test's return value into this one.
  bugFindMany.mockReset();
  bugWriteFindMany.mockReset();
  bugUpdate.mockReset();
  bugFindMany.mockResolvedValue([]);
  bugWriteFindMany.mockResolvedValue([]);
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

  // `-`/`_` matter: a ClickUp custom task id (DEV-1234) must parse rather than
  // read as "no link at all", which is silent.
  it('accepts a bare task id and a custom task id', () => {
    expect(clickupTaskIdFromUrl(TASK_ID)).toBe(TASK_ID);
    expect(clickupTaskIdFromUrl('https://app.clickup.com/t/9008/DEV-1234')).toBe('DEV-1234');
  });

  it('is null when there is no link and when the segment is not an id', () => {
    expect(clickupTaskIdFromUrl(null)).toBeNull();
    expect(clickupTaskIdFromUrl('')).toBeNull();
    expect(clickupTaskIdFromUrl('https://app.clickup.com/t/not an id')).toBeNull();
  });
});

describe('clickupDoneStatusFromPayload', () => {
  const payload = (after: unknown, field = 'status'): ClickupWebhookPayload => ({
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

  // The trap this guards: a QA flow with Resolved -> Verified -> Closed would
  // publicly mark the board entry fixed the moment it reached the FIRST of them.
  it('does not treat a done-SOUNDING name as done when ClickUp typed it otherwise', () => {
    expect(
      clickupDoneStatusFromPayload(payload({ status: 'Resolved', type: 'custom' }))
    ).toBeNull();
    expect(
      clickupDoneStatusFromPayload(payload({ status: 'Complete', type: 'custom' }))
    ).toBeNull();
  });

  // ClickUp sends an array for tag/watcher edits and a number for priority. A
  // schema that rejected those would fail the whole delivery, dropping the status
  // item beside them — and repeated failures disable the webhook at ClickUp.
  it('reads the status item even when other history items carry other shapes', () => {
    const mixed = {
      event: 'taskUpdated',
      task_id: TASK_ID,
      history_items: [
        { field: 'tag', after: [{ name: 'known-issue' }] },
        { field: 'priority', after: 2 },
        { field: 'status', after: { status: 'complete', type: 'closed' } },
      ],
    };
    const parsed = clickupWebhookSchema.safeParse(mixed);

    expect(parsed.success).toBe(true);
    expect(clickupDoneStatusFromPayload(parsed.data as ClickupWebhookPayload)).toBe('complete');
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
    // On BOTH clients, so this proves the segment filter rather than an empty read.
    bugFindMany.mockResolvedValue([row(NEIGHBOUR_BUG, NEIGHBOUR_TASK_ID)]);
    bugWriteFindMany.mockResolvedValue([row(NEIGHBOUR_BUG, NEIGHBOUR_TASK_ID)]);

    const result = await resolveBugsByClickupTaskId({ taskId: TASK_ID });

    expect(result.matched).toEqual([]);
    expect(result.resolved).toEqual([]);
    expect(bugUpdate).not.toHaveBeenCalled();
  });

  // A moderator can link an entry seconds before the task completes; the read
  // replica may not have it yet, and ClickUp never redelivers a 200.
  it('re-checks the writer when the replica returns nothing', async () => {
    bugFindMany.mockResolvedValue([]);
    bugWriteFindMany.mockResolvedValue([row(OPEN_BUG, TASK_ID)]);

    const result = await resolveBugsByClickupTaskId({ taskId: TASK_ID });

    expect(result.resolved).toEqual([{ id: OPEN_BUG, previousStatus: 'Open' }]);
  });

  it('closes the remaining entries when one of them cannot be closed', async () => {
    bugFindMany.mockResolvedValue([
      row(CLOSED_BUG, TASK_ID, { status: 'Open' }),
      row(OPEN_BUG, TASK_ID),
    ]);
    bugUpdate.mockRejectedValueOnce(new Error('row vanished'));

    const result = await resolveBugsByClickupTaskId({ taskId: TASK_ID });

    expect(result.failed.map((f) => f.id)).toEqual([CLOSED_BUG]);
    expect(result.resolved).toEqual([{ id: OPEN_BUG, previousStatus: 'Open' }]);
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
