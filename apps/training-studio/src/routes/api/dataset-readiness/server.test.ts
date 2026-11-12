import { beforeEach, describe, expect, it, vi } from 'vitest';

const flag = vi.hoisted(() => ({ on: true }));
const probeBlobReadiness = vi.hoisted(() => vi.fn());
const trainingDataReady = vi.hoisted(() => vi.fn());
const claims = vi.hoisted(() => ({
  granted: Infinity,
  calls: [] as { kind: string; userId: number; want: number }[],
  givenBack: 0,
}));

// Empty: the client's dist imports a directory, which Node's ESM loader refuses; the route needs none of it.
vi.mock('@civitai/orchestration-client', () => ({}));
vi.mock('$lib/server/token', () => ({ requireToken: async () => 'token' }));
const endpoint = vi.hoisted(() => ({ set: true }));
vi.mock('$lib/server/orchestrator', () => ({
  orchestratorClient: () => ({}),
  blobHead: () => (endpoint.set ? async () => new Response(null, { status: 204 }) : undefined),
}));
vi.mock('$lib/server/axiom', () => ({ logToAxiom: vi.fn(), safeError: (e: unknown) => e }));
vi.mock('$lib/server/flipt', () => ({ isUploadReadinessOn: async () => flag.on }));
vi.mock('$lib/server/dataset-rating', () => ({
  claimDailyReturnable: async (kind: string, userId: number, want: number) => {
    claims.calls.push({ kind, userId, want });
    const granted = Math.min(want, claims.granted);
    return {
      granted,
      giveBack: async (n: number) => {
        claims.givenBack += Math.min(n, granted);
      },
    };
  },
}));
vi.mock('$lib/train-core', () => ({
  trainingDataReady: (...args: unknown[]) => trainingDataReady(...args),
}));
vi.mock('$lib/upload-readiness', () => ({
  probeBlobReadiness: (...args: unknown[]) => probeBlobReadiness(...args),
}));

const { POST } = await import('./+server');

const post = async (body: unknown) =>
  (
    await POST({
      locals: { user: { id: 7 } },
      request: new Request('http://x/api/dataset-readiness', {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    } as unknown as Parameters<typeof POST>[0])
  ).json();

beforeEach(() => {
  flag.on = true;
  endpoint.set = true;
  claims.granted = Infinity;
  claims.calls = [];
  claims.givenBack = 0;
  probeBlobReadiness.mockReset();
  trainingDataReady.mockReset();
});

describe('POST /api/dataset-readiness', () => {
  it('is off, reading nothing, when the kill switch is off', async () => {
    flag.on = false;
    expect(await post({ blobIds: ['a'] })).toEqual({ enabled: false });
    expect(probeBlobReadiness).not.toHaveBeenCalled();
  });

  it("charges the caller's allowance one unit per blob, and gives back the ones not read", async () => {
    probeBlobReadiness.mockResolvedValue({ a: 'ready' });
    expect(await post({ blobIds: ['a', 'b', 'a'] })).toEqual({
      enabled: true,
      states: { a: 'ready' },
    });
    expect(claims.calls).toEqual([{ kind: 'probes', userId: 7, want: 2 }]);
    expect(claims.givenBack).toBe(1);
  });

  it('is off past the allowance, and keeps none of it', async () => {
    claims.granted = 1;
    expect(await post({ blobIds: ['a', 'b'] })).toEqual({ enabled: false });
    expect(probeBlobReadiness).not.toHaveBeenCalled();
    expect(claims.givenBack).toBe(1);
  });

  it('is off, keeping none of the allowance, with no orchestrator endpoint', async () => {
    endpoint.set = false;
    expect(await post({ blobIds: ['a', 'b'] })).toEqual({ enabled: false });
    expect(probeBlobReadiness).not.toHaveBeenCalled();
    expect(claims.givenBack).toBe(2);
  });

  it('answers the whatif for a run', async () => {
    trainingDataReady.mockResolvedValue(false);
    expect(await post({ run: { meta: {} } })).toEqual({ enabled: true, ready: false });
    expect(claims.calls).toEqual([{ kind: 'probes', userId: 7, want: 1 }]);
  });

  it('answers null when the whatif throws, so Start is not held', async () => {
    trainingDataReady.mockRejectedValue(new Error('down'));
    expect(await post({ run: { meta: {} } })).toEqual({ enabled: true, ready: null });
  });

  it.each([[{}], [{ blobIds: [] }], [{ blobIds: [1] }], [{ run: null }]])(
    'refuses a malformed body %j',
    async (body) => {
      await expect(post(body)).rejects.toMatchObject({ status: 400 });
    }
  );
});
