import { beforeEach, describe, expect, it, vi } from 'vitest';

// The Redis client comes from the canonical shared mock.
vi.mock('~/server/redis/fail-open-log', () => ({ logSysRedisFailOpen: vi.fn() }));

import { trackRouter } from '../track.router';
import { TokenScope } from '~/shared/constants/token-scope.constants';

const track = { action: vi.fn(), search: vi.fn(), view: vi.fn() };

const caller = () =>
  trackRouter.createCaller({
    acceptableOrigin: true,
    user: { id: 1 },
    apiKeyId: null,
    tokenScope: TokenScope.Full,
    req: { headers: {} } as never,
    res: { setHeader: () => undefined } as never,
    cache: { edgeTTL: 0 },
    features: { canViewNsfw: false } as never,
    track: track as never,
  } as never);

const codeOf = (p: Promise<unknown>) =>
  p.then(
    () => 'OK',
    (e: { code?: string }) => e.code ?? 'UNKNOWN'
  );

// Literal limits: 64K for search filters, 256K for view details and a whole action.
const FILTERS_CAP = 65_536;
const DETAILS_CAP = 262_144;

const cancel = (pad: number) => ({
  type: 'Membership_Cancel' as const,
  details: { reason: 'r', from: 'f', note: 'x'.repeat(pad) },
});
const search = (pad: number) => ({
  query: 'cat',
  index: 'models',
  filters: { note: 'x'.repeat(pad) },
});
const view = (pad: number) => ({
  type: 'ModelView' as const,
  entityType: 'Model' as const,
  entityId: 1,
  details: { note: 'x'.repeat(pad) },
});

describe('track router free-form payload caps', () => {
  beforeEach(() => vi.clearAllMocks());

  it('addAction accepts an action over the filters cap and refuses one over its own cap', async () => {
    expect(await codeOf(caller().addAction(cancel(DETAILS_CAP)))).toBe('BAD_REQUEST');
    expect(track.action).not.toHaveBeenCalled();
    // A large action, well over the filters cap, reaches the tracker.
    expect(await codeOf(caller().addAction(cancel(2 * FILTERS_CAP)))).toBe('OK');
    expect(track.action).toHaveBeenCalledTimes(1);
  });

  it('addView accepts details over the filters cap and refuses details over its own cap', async () => {
    expect(await codeOf(caller().addView(view(DETAILS_CAP)))).toBe('BAD_REQUEST');
    expect(track.view).not.toHaveBeenCalled();
    expect(await codeOf(caller().addView(view(2 * FILTERS_CAP)))).toBe('OK');
    expect(track.view).toHaveBeenCalledTimes(1);
  });

  it('trackSearch refuses filters over the cap before the tracker sees them', async () => {
    expect(await codeOf(caller().trackSearch(search(FILTERS_CAP)))).toBe('BAD_REQUEST');
    expect(track.search).not.toHaveBeenCalled();
    expect(await codeOf(caller().trackSearch(search(10)))).toBe('OK');
    expect(track.search).toHaveBeenCalledTimes(1);
  });
});
