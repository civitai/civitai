import { beforeEach, describe, expect, it, vi } from 'vitest';

const dismissHiddenNotices = vi.hoisted(() => vi.fn());
vi.mock('$lib/server/db', () => ({ db: {} }));
vi.mock('$lib/server/image-url', () => ({ imageUrl: (key: string) => key }));
vi.mock('$lib/server/queue/runtime', () => ({
  queueDeps: { now: () => new Date('2026-12-15T12:00:00Z') },
}));
vi.mock('$lib/server/daily/daily.service', () => ({}));
vi.mock('$lib/server/smites/runtime', () => ({ feedSecret: () => 'secret', resetDeps: {} }));
vi.mock('$lib/server/hidden/runtime', () => ({ hiddenSettings: () => ({ rate: 1 }) }));
vi.mock('$lib/server/smites/smites.service', () => ({}));
vi.mock('$lib/server/hidden/hidden.service', async (original) => ({
  ...(await original<typeof import('$lib/server/hidden/hidden.service')>()),
  dismissHiddenNotices,
}));
vi.mock('$lib/server/queue/queue.service', () => ({ castVote: vi.fn(), getFeed: vi.fn() }));
vi.mock('$lib/server/yesno/vote', () => ({ castYesNoVote: vi.fn() }));
vi.mock('$lib/server/yesno/feed', () => ({ pickYesNo: vi.fn() }));
vi.mock('$lib/server/yesno/runtime', () => ({ yesNoConfig: () => ({ share: 0, stretch: 8 }) }));

const { actions } = await import('./+page.server');

const dismiss = (keys: string[]) => {
  const body = new FormData();
  for (const key of keys) body.append('notice', key);
  return actions.dismissNotices({
    request: new Request('http://knights.test/play', { method: 'POST', body }),
    locals: { user: { id: 7 } },
  } as never);
};

beforeEach(() => dismissHiddenNotices.mockReset());

describe('dismissNotices action', () => {
  it('marks seen only the notices the toast says it showed', async () => {
    await dismiss(['-3:1765800001000', 'junk']);
    expect(dismissHiddenNotices).toHaveBeenCalledWith({}, 7, expect.any(Date), [
      { itemId: -3, createdAt: new Date(1765800001000) },
    ]);
  });

  it('dismisses every notice for a page that sends no keys', async () => {
    await dismiss([]);
    expect(dismissHiddenNotices).toHaveBeenCalledWith({}, 7, expect.any(Date), undefined);
  });
});
