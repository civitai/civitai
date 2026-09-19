import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as ExcludedUsers from '~/server/services/metric-excluded-users.service';
import { loggingMock } from '~/__tests__/mocks/logging.mock';

/**
 * The one test that runs the notification runner end to end with the REAL processors and
 * reads the SQL they emit.
 *
 * The reaction milestones cannot read the exclusion list themselves — the processor files
 * are in the client graph — so the runner reads it and passes it in. A source guard pins
 * the spelling of that hand-off and was shown not to pin its value: eight mutations
 * shipped the milestones unfiltered with the guard green, among them a shadowing
 * `const excludedUserIds = []` inside the loop, `excludedUserIds.length = 0` after the
 * read, a processor that ignores its input, and the filter moved into the `affected` CTE,
 * where it only narrows which entities are revisited while the COUNT stays unfiltered.
 * Every one of those changes what reaches Postgres, so this asserts on that.
 */

const EXCLUDED = [7, 9];
const FILTER = `r."userId" NOT IN (${EXCLUDED.join(',')})`;

const h = vi.hoisted(() => ({
  captured: [] as string[],
}));

vi.mock('~/server/jobs/job', () => ({
  createJob: (name: string, cron: string, fn: (e: unknown) => Promise<unknown>) => ({
    name,
    cron,
    run: () => fn({ checkIfCanceled: () => undefined, on: () => undefined }),
  }),
  getJobDate: vi.fn().mockResolvedValue([new Date(0), vi.fn()]),
}));

vi.mock('~/server/services/metric-excluded-users.service', async (importOriginal) => ({
  ...(await importOriginal<typeof ExcludedUsers>()),
  getMetricExcludedUserIds: vi.fn().mockResolvedValue(EXCLUDED),
}));

vi.mock('~/server/db/pgDb', () => ({
  pgDbRead: {
    cancellableQuery: vi.fn(async (sql: string) => {
      h.captured.push(sql);
      return { result: async () => [], cancel: async () => undefined };
    }),
  },
}));

const { sendNotificationsJob } = await import('~/server/jobs/send-notifications');

/**
 * The counting CTE of a milestone query. The filter has to land HERE: the `affected` CTE
 * above it only chooses which entities to revisit, so a filter there is valid SQL that
 * still counts every excluded reaction.
 */
function countingCte(sql: string) {
  const start = sql.indexOf('affected_value AS (');
  expect(start, 'the milestone query no longer has an affected_value CTE').toBeGreaterThan(-1);
  const end = sql.indexOf('), ', start);
  return sql.slice(start, end === -1 ? undefined : end);
}

function milestoneSql(key: string) {
  const sql = h.captured.filter((s) => s.includes(`'${key}'`));
  expect(sql, `${key} issued no query — did its prepareQuery throw?`).toHaveLength(1);
  return sql[0];
}

beforeEach(() => {
  h.captured.length = 0;
  loggingMock.logToAxiom.mockClear();
});

describe('send-notifications passes the exclusion list to the reaction milestones', () => {
  it.each(['article-reaction-milestone', 'bounty-reaction-milestone'])(
    '%s filters the reactors it COUNTS',
    async (key) => {
      await sendNotificationsJob.run();

      const sql = milestoneSql(key);
      expect(countingCte(sql), 'the filter is not in the CTE that counts').toContain(FILTER);
      expect(sql.split(FILTER).length - 1, 'the filter appears more than once').toBe(1);
    }
  );

  it('runs without any processor throwing', async () => {
    // The runner swallows a per-processor throw and logs it, so without this a milestone
    // whose SQL no longer builds would read as "issued no query" rather than as a failure.
    await sendNotificationsJob.run();

    const errors = loggingMock.logToAxiom.mock.calls
      .map(([arg]: [{ type?: string; details?: unknown; message?: string }]) => arg)
      .filter((arg) => arg.type === 'error');
    expect(errors).toEqual([]);
  });
});
