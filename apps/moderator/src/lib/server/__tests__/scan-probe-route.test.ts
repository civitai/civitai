import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The probe's two entry points: the `run` form action and the result read. Both sit behind the page
 * grant (hooks.server.ts) AND the `image.scanProbe.run` permission; this pins the second half, which
 * nothing else checks.
 */

const runProbe = vi.hoisted(() =>
  vi.fn(async (_moderatorId: number, _ids: number[]) => ({
    ok: true as const,
    submitted: 1,
    failed: 0,
    refused: [] as number[],
  }))
);
const readProbe = vi.hoisted(() => vi.fn(async () => ({ state: 'pending' as const })));
const resetBreaker = vi.hoisted(() => vi.fn(async () => 1));
const abandonInFlight = vi.hoisted(() => vi.fn(async () => 1));

vi.mock('$lib/server/db', async () => {
  const { capturingDb } = await import('../../../test/capture-sql');
  return { dbRead: capturingDb([], []), dbWrite: capturingDb([], []) };
});
vi.mock('$lib/server/scan-probe/service', () => ({ runProbe, readProbe, probeDb: () => ({}) }));
vi.mock('$lib/server/scan-probe/runs', () => ({
  recentOwnRuns: async () => [],
  trippedRuns: async () => [{ id: '9', imageId: 777009 }],
  resetBreaker,
  abandonInFlight,
  inFlightRuns: async () => [],
}));

const { actions, load } = await import('../../../routes/images/scan-probe/+page.server');
const { GET } = await import('../../../routes/images/scan-probe/runs/[runId]/+server');

const GRANT = { 'image.scanProbe.run': true };

const runEvent = (
  grants: Record<string, boolean>,
  fields: Record<string, string> = { ids: '777001', understood: 'on' }
) => {
  const form = new FormData();
  for (const [k, v] of Object.entries(fields)) form.set(k, v);
  return {
    request: { formData: async () => form },
    locals: { user: { id: 42, roles: ['moderator:staff'] }, grants },
  } as never;
};

const status = async (fn: () => unknown) => {
  try {
    await fn();
    return 200;
  } catch (e) {
    return (e as { status?: number }).status;
  }
};

beforeEach(() => {
  runProbe.mockClear();
  readProbe.mockClear();
  resetBreaker.mockClear();
  abandonInFlight.mockClear();
});

describe('load', () => {
  const loadAs = (roles: string[]) =>
    load({ locals: { user: { id: 42, roles }, grants: GRANT } } as never) as Promise<
      Record<string, unknown>
    >;

  it('tells a moderator the probe is stopped without saying which image stopped it', async () => {
    expect(await loadAs(['moderator:staff'])).toMatchObject({ stopped: true, tripped: null });
  });

  it('control: an admin sees which run and image tripped it', async () => {
    expect(await loadAs(['moderator:admin'])).toMatchObject({
      stopped: true,
      tripped: [{ id: '9', imageId: 777009 }],
    });
  });
});

describe('run action', () => {
  it('refuses without the grant and never reaches the probe', async () => {
    expect(await actions.run(runEvent({}))).toMatchObject({ status: 403 });
    expect(runProbe).not.toHaveBeenCalled();
  });

  it('refuses a holder who has not acknowledged that a hit acts on the real image', async () => {
    expect(await actions.run(runEvent(GRANT, { ids: '777001' }))).toMatchObject({
      status: 400,
      data: { error: expect.stringContaining('acts on the real image') },
    });
    expect(runProbe).not.toHaveBeenCalled();
  });

  it('refuses more ids than one run allows', async () => {
    const ids = Array.from({ length: 6 }, (_, i) => 1000 + i).join(',');
    expect(await actions.run(runEvent(GRANT, { ids, understood: 'on' }))).toMatchObject({
      status: 400,
    });
    expect(runProbe).not.toHaveBeenCalled();
  });

  it('passes a refusal through as a 409 with the refused ids, and an error as a 500', async () => {
    runProbe.mockResolvedValueOnce({ ok: false, reason: 'breaker', refused: [5] } as never);
    expect(await actions.run(runEvent(GRANT))).toMatchObject({
      status: 409,
      data: { error: expect.stringContaining('stopped'), refused: [5] },
    });
    runProbe.mockRejectedValueOnce(new Error('db down'));
    expect(await actions.run(runEvent(GRANT))).toMatchObject({ status: 500 });
  });

  it('control: a holder who acknowledged reaches the probe as themselves', async () => {
    await actions.run(runEvent(GRANT));
    expect(runProbe).toHaveBeenCalledWith(42, [777001]);
  });
});

describe('resetBreaker action', () => {
  const adminEvent = (runIds: string) => {
    const form = new FormData();
    form.set('runIds', runIds);
    return {
      request: { formData: async () => form },
      locals: { user: { id: 1, roles: ['moderator:admin'] }, grants: {} },
    } as never;
  };

  it('refuses anyone but an admin, grant or not', async () => {
    expect(await actions.resetBreaker(runEvent(GRANT))).toMatchObject({ status: 403 });
    expect(await actions.abandonInFlight(runEvent(GRANT))).toMatchObject({ status: 403 });
    expect(resetBreaker).not.toHaveBeenCalled();
    expect(abandonInFlight).not.toHaveBeenCalled();
  });

  it('control: an admin resets exactly the runs named, as themselves', async () => {
    expect(await actions.resetBreaker(adminEvent('3,4,x'))).toEqual({ reset: 1 });
    expect(resetBreaker).toHaveBeenCalledWith(expect.anything(), 1, ['3', '4']);
    expect(await actions.abandonInFlight(adminEvent('9'))).toEqual({ abandoned: 1 });
    expect(abandonInFlight).toHaveBeenCalledWith(expect.anything(), 1, ['9']);
  });

  it('reports a reset or abandon that changed nothing as a refusal, not a success', async () => {
    resetBreaker.mockResolvedValueOnce(0);
    abandonInFlight.mockResolvedValueOnce(0);
    expect(await actions.resetBreaker(adminEvent('3'))).toMatchObject({ status: 409 });
    expect(await actions.abandonInFlight(adminEvent('9'))).toMatchObject({ status: 409 });
  });
});

describe('result read', () => {
  const read = (grants: Record<string, boolean>, runId = '7') =>
    GET({ params: { runId }, locals: { user: { id: 42 }, grants } } as never);

  it('refuses without the grant', async () => {
    expect(await status(() => read({}))).toBe(403);
    expect(readProbe).not.toHaveBeenCalled();
  });

  it('refuses a malformed run id', async () => {
    expect(await status(() => read(GRANT, '7 OR 1=1'))).toBe(400);
  });

  it('control: a holder reads their run', async () => {
    const res = (await read(GRANT)) as Response;
    expect(await res.json()).toEqual({ state: 'pending' });
    expect(readProbe).toHaveBeenCalledWith('7', 42);
  });
});
