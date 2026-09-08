import { MeiliSearchTimeOutError } from 'meilisearch';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Index creation is a QUEUED Meilisearch task, so waiting on it is waiting for queue position rather
 * than for work. `getOrCreateIndex` used to call `client.waitForTask` bare, which takes the client
 * default of 5s and never retries — so a `search-index-sync-*-reset` fired while the queue had a
 * backlog threw MeiliSearchTimeOutError about four minutes in and built nothing, while the creation
 * task sat enqueued and made the dead job look like a running one.
 *
 * These pin that a creation wait survives a timeout instead of ending the job. They do NOT claim the
 * reset is immune to a long backlog: the retry budget is finite (~75s) and one images batch on prod
 * has taken 51 minutes. A quiet queue is still a precondition.
 */

vi.mock('~/server/meilisearch/client', () => ({ searchClient: null, metricsSearchClient: null }));
import { getOrCreateIndex } from '~/server/meilisearch/util';
import { redisMock } from '~/__tests__/mocks/redis.mock';
import { loggingMock } from '~/__tests__/mocks/logging.mock';

const notFound = Object.assign(new Error('index_not_found'), { code: 'index_not_found' });

function fakeClient({ timeouts }: { timeouts: number }) {
  let remaining = timeouts;
  const index = { uid: 'test_index', update: vi.fn() };
  return {
    created: false,
    getIndex: vi.fn(function (this: any) {
      // Not found until createIndex has run — the branch under test.
      return this.created ? Promise.resolve(index) : Promise.reject(notFound);
    }),
    createIndex: vi.fn(function (this: any) {
      this.created = true;
      return Promise.resolve({ taskUid: 42 });
    }),
    waitForTasks: vi.fn(() => {
      if (remaining-- > 0) return Promise.reject(new MeiliSearchTimeOutError(''));
      return Promise.resolve([{ uid: 42, status: 'succeeded' }]);
    }),
    // Deliberately absent: waitForTask. The old implementation called it, so a revert fails here by
    // name rather than by a vague timeout.
  } as any;
}

// Fake timers are what keep a REVERT fast. getOrCreateIndex is wrapped in withRetries(fn, 3, 60000),
// so anything that throws out of it sleeps 3 x 60s of real time — a revert took over 2 minutes per
// test before this, which reads as a wedged runner rather than a failure. Do not drop them.
async function createIndexWith(client: any) {
  const pending = getOrCreateIndex('test_index', { primaryKey: 'id' }, client);
  pending.catch(() => undefined);
  await vi.runAllTimersAsync();
  return pending;
}

describe('getOrCreateIndex — creation waits for a queued task', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });
  afterEach(() => vi.useRealTimers());

  it('returns the index when the creation task resolves immediately', async () => {
    const client = fakeClient({ timeouts: 0 });
    const index = await createIndexWith(client);

    expect(index).toBeTruthy();
    expect(client.createIndex).toHaveBeenCalledTimes(1);
    expect(client.waitForTasks).toHaveBeenCalledTimes(1);
  });

  it('survives a timed-out wait and retries rather than failing the job', async () => {
    // Two timeouts then success. Under the old bare `waitForTask` there was no second attempt at all.
    const client = fakeClient({ timeouts: 2 });
    const index = await createIndexWith(client);

    expect(index).toBeTruthy();
    expect(client.waitForTasks).toHaveBeenCalledTimes(3);
  });

  // Do not relax this to toHaveBeenCalled(): the first wait uses the caller's client either way, so
  // only the exact count can see the retry dropping it. Dropped, the retry hits a null searchClient,
  // returns [] as if the tasks succeeded, and this reads 1.
  it('forwards the caller-supplied client on RETRY, not only on the first attempt', async () => {
    const client = fakeClient({ timeouts: 1 });
    await createIndexWith(client);

    expect(client.waitForTasks).toHaveBeenCalledTimes(2);
  });
});
