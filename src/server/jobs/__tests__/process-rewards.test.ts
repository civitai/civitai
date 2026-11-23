import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  query: vi.fn<(...args: unknown[]) => Promise<unknown[]>>(async () => []),
}));

vi.mock('~/server/clickhouse/client', () => ({
  clickhouse: { $query: (...args: unknown[]) => h.query(...args), insert: vi.fn() },
}));

import { dbMock } from '~/__tests__/mocks/db.mock';
import { processRewards } from '~/server/jobs/process-rewards';

const NOW = new Date('2026-11-22T12:00:00Z');
const SETTLED = new Date(NOW.getTime() - 2 * 60 * 1000);
const runJob = () => processRewards.run({}).result;
const storeLastUpdate = (date: Date) =>
  dbMock.dbWrite.keyValue.findUnique.mockResolvedValue({
    key: 'process-rewards',
    value: date.getTime(),
  } as never);
const storedLastUpdate = () =>
  dbMock.dbWrite.keyValue.upsert.mock.calls.map(
    ([args]) => (args as { update: { value: number } }).update.value
  );

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  h.query.mockClear();
  dbMock.dbWrite.keyValue.upsert.mockClear();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('the rewards-process job', () => {
  it('reads only events older than the settle window and resumes from that cutoff', async () => {
    const lastUpdate = new Date(NOW.getTime() - 10 * 60 * 1000);
    storeLastUpdate(lastUpdate);

    await runJob();

    // `$query` is a tagged template: the values after the strings are the window bounds.
    const [, ...bounds] = h.query.mock.calls[0] as [TemplateStringsArray, ...Date[]];
    expect(bounds.map((d) => d.getTime())).toEqual([lastUpdate.getTime(), SETTLED.getTime()]);
    expect(storedLastUpdate()).toEqual([SETTLED.getTime()]);
  });

  it('waits without moving lastUpdate back when it is later than the cutoff', async () => {
    // The first run after deploy: lastUpdate is the previous run's "now".
    storeLastUpdate(new Date(NOW.getTime() - 60 * 1000));

    await runJob();

    expect(h.query).not.toHaveBeenCalled();
    expect(storedLastUpdate()).toEqual([]);
  });
});
