import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TokenScope } from '~/shared/constants/token-scope.constants';

/**
 * feed-go's serve-side parity replay (`~/server/trpc/feed-go-parity-replay`) re-asks this app for an
 * answer feed-go already served. Its call must not reach the per-procedure metrics
 * (`civitai_app_trpc_procedure_duration_seconds`, the call-traffic and caller counters): after a
 * procedure moves to Go, the replays would otherwise be a large share of what reads as Node's calls
 * and latency. Driven through the real `publicProcedure` chain with the histogram switch on; the
 * call without the marker is the positive control (the same chain observes it once).
 */
const h = vi.hoisted(() => {
  process.env.TRPC_PROCEDURE_METRICS = 'true';
  return { recordTrpcCall: vi.fn() };
});
vi.mock('~/server/prom/route-traffic.metrics', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  recordTrpcCall: h.recordTrpcCall,
}));

import { trpcProcedureDuration } from '~/server/prom/client';
import { publicProcedure, router } from '~/server/trpc';

const appRouter = router({ q: publicProcedure.query(() => 1) });

function call(headers: Record<string, string>) {
  return appRouter
    .createCaller({
      user: undefined,
      acceptableOrigin: true,
      tokenScope: TokenScope.Full,
      apiKeyId: null,
      req: { headers },
      res: { setHeader: () => undefined },
      cache: { edgeTTL: 0 },
      features: {},
      track: { action: vi.fn(() => Promise.resolve(true)) },
    } as never)
    .q()
    .catch(() => undefined);
}

describe('procedure metrics and the feed-go parity replay', () => {
  beforeEach(() => {
    vi.mocked(trpcProcedureDuration.observe).mockClear();
    h.recordTrpcCall.mockClear();
  });

  it('counts an ordinary call (the positive control)', async () => {
    await call({ host: 'civitai.com' });
    expect(trpcProcedureDuration.observe).toHaveBeenCalledTimes(1);
    expect(vi.mocked(trpcProcedureDuration.observe).mock.calls[0][0]).toEqual({ path: 'q' });
    expect(h.recordTrpcCall).toHaveBeenCalledTimes(1);
  });

  it('does not count a call carrying the replay marker', async () => {
    await call({ host: 'civitai.com', 'x-feed-go-parity-replay': '1' });
    expect(trpcProcedureDuration.observe).not.toHaveBeenCalled();
    expect(h.recordTrpcCall).not.toHaveBeenCalled();
  });
});
