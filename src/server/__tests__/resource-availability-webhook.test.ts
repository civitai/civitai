import { beforeEach, describe, expect, it, vi } from 'vitest';
import '~/__tests__/mocks/logging.mock';
import { dbMock } from '~/__tests__/mocks/db.mock';
const executeRaw = dbMock.dbWrite.$executeRaw;
const queryRaw = dbMock.dbWrite.$queryRaw;
dbMock.dbWrite.$executeRaw.mockImplementation(async () => 0);
dbMock.dbWrite.$queryRaw.mockImplementation(async () => [] as { id: number; modelId: number }[]);

/**
 * The orchestrator's load/unload webhook writes `ModelVersion.generatorLoaded` directly, so the
 * things worth pinning are the ones whose failure is silent: that it refuses an unauthenticated
 * call, that residency comes from `workersAvailable` rather than the `loaded` flag beside it, and
 * that it honours the same kill switch as the sync job it supplements.
 */

const { env, isFlipt, queueUpdate } = vi.hoisted(() => ({
  env: { WEBHOOK_TOKEN: 'shhh', LOGGING: '' },
  isFlipt: vi.fn(async () => true),
  queueUpdate: vi.fn(async () => undefined),
}));

vi.mock('~/env/server', () => ({ env }));
vi.mock('~/server/prom/http-errors', () => ({ instrumentApiResponse: vi.fn() }));
vi.mock('~/server/flipt/client', () => ({
  isFlipt,
  FLIPT_FEATURE_FLAGS: { SYNC_GENERATOR_LOADED_RESOURCES: 'sync-generator-loaded-resources' },
}));
vi.mock('~/server/search-index', () => ({ modelsSearchIndex: { queueUpdate } }));

const handler = (await import('~/pages/api/webhooks/resource-availability')).default;

type Event = { air: string; workersAvailable: number; loaded?: boolean };

function call(events: Event[], { secret = 'shhh', method = 'POST' } = {}) {
  const req = {
    method,
    headers: secret === undefined ? {} : { 'x-webhook-secret': secret },
    body: { events },
  } as never;
  let statusCode = 0;
  let payload: Record<string, unknown> | undefined;
  const res = {
    status(code: number) {
      statusCode = code;
      return res;
    },
    json(data: Record<string, unknown>) {
      payload = data;
      return res;
    },
    setHeader: () => res,
    end: () => res,
  };
  return Promise.resolve(handler(req, res as never)).then(() => ({ statusCode, payload }));
}

/** `328553@1144039` — the version is what the column is keyed by. */
const air = (versionId: number) => `urn:air:sdxl:lora:civitai:328553@${versionId}`;

/** The rows the handler will find for those versions. */
function versionsExist(...ids: number[]) {
  queryRaw.mockResolvedValue(ids.map((id) => ({ id, modelId: id * 10 })));
}

/**
 * The ids of one `setLoaded` call, by the boolean it wrote. A tagged template calls the mock as
 * `(strings, ...values)`, so the values are positional: `[strings, loaded, ids]`.
 */
function writtenWith(loaded: boolean) {
  const call = executeRaw.mock.calls.find((args) => args[1] === loaded);
  return call?.[2] as number[] | undefined;
}

describe('resource-availability webhook', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    env.WEBHOOK_TOKEN = 'shhh';
    isFlipt.mockResolvedValue(true);
    queryRaw.mockResolvedValue([]);
  });

  it('refuses a call with the wrong secret, and writes nothing', async () => {
    versionsExist(1144039);

    const { statusCode } = await call([{ air: air(1144039), workersAvailable: 3 }], {
      secret: 'wrong',
    });

    expect(statusCode).toBe(401);
    expect(executeRaw).not.toHaveBeenCalled();
  });

  it('refuses every call while the secret is unset, rather than accepting them', async () => {
    env.WEBHOOK_TOKEN = '';

    const { statusCode } = await call([{ air: air(1144039), workersAvailable: 3 }], {
      secret: undefined,
    });

    expect(statusCode).toBe(503);
    expect(executeRaw).not.toHaveBeenCalled();
  });

  /**
   * The payload carries both fields and they can disagree in principle; `workersAvailable` is the
   * one the orchestrator stands behind. Reading `loaded` instead passes every other test here.
   */
  it('takes residency from workersAvailable, not the loaded flag beside it', async () => {
    versionsExist(1, 2);

    await call([
      { air: air(1), workersAvailable: 0, loaded: true },
      { air: air(2), workersAvailable: 3, loaded: false },
    ]);

    expect(writtenWith(true)).toEqual([2]);
    expect(writtenWith(false)).toEqual([1]);
  });

  it('queues the parent models for reindex, so the picker stops answering from the old value', async () => {
    versionsExist(1);

    await call([{ air: air(1), workersAvailable: 3 }]);

    expect(queueUpdate).toHaveBeenCalledWith([{ id: 10, action: expect.anything() }]);
  });

  it('ignores an AIR this site holds no version for', async () => {
    versionsExist(1);

    const { statusCode, payload } = await call([
      { air: air(1), workersAvailable: 3 },
      { air: air(999), workersAvailable: 3 },
    ]);

    expect(statusCode).toBe(200);
    expect(payload).toMatchObject({ events: 2, acted: 1 });
    expect(writtenWith(true)).toEqual([1]);
  });

  // The flag's documented meaning is that the column FREEZES while it is off. A webhook writing
  // anyway would leave that kill switch holding nothing.
  it('writes nothing while the sync flag is off', async () => {
    isFlipt.mockResolvedValue(false);
    versionsExist(1);

    const { statusCode, payload } = await call([{ air: air(1), workersAvailable: 3 }]);

    expect(statusCode).toBe(200);
    expect(payload).toMatchObject({ skipped: 'flag off' });
    expect(executeRaw).not.toHaveBeenCalled();
    expect(queueUpdate).not.toHaveBeenCalled();
  });

  it('rejects a payload that is not the agreed shape', async () => {
    const { statusCode } = await call([{ air: air(1) } as never]);

    expect(statusCode).toBe(400);
    expect(executeRaw).not.toHaveBeenCalled();
  });

  it('answers 405 to anything but POST', async () => {
    const { statusCode } = await call([], { method: 'GET' });

    expect(statusCode).toBe(405);
  });
});
