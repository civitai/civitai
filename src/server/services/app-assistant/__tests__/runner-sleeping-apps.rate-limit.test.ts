import { describe, expect, it, vi } from 'vitest';
import {
  answerSleepingApps,
  type RunnerSleepingDeps,
} from '~/server/services/app-assistant/runner-sleeping-apps';
import type { SessionUser } from '~/types/session';

/**
 * The runner's sleeping-apps routes answer their per-user limit with the house 429: the
 * `rateLimit` meta (an abuse limit: the id and the wait, no counts) beside the route's own
 * `{ error, code }`, and the wait for `Retry-After`.
 */

const USER = { id: 7 } as SessionUser;

function deps(allow: RunnerSleepingDeps['allow']): RunnerSleepingDeps {
  return {
    user: async () => ({ refusal: null, user: USER }),
    enabled: async () => true,
    hibernation: async () => ({} as never),
    list: vi.fn(async () => []),
    wakeSeed: vi.fn(),
    allow,
  };
}

describe('answerSleepingApps past the per-user limit', () => {
  it('429 with the limiter’s own wait, and lists nothing', async () => {
    const d = deps(async () => ({ retryAfterSeconds: 42 }));
    const answer = await answerSleepingApps(USER.id, d);
    expect(answer).toEqual({
      status: 429,
      json: {
        error: 'Too many requests for your apps; try again later',
        code: 'rate_limited',
        rateLimit: {
          retryAfterSeconds: 42,
          retryAt: expect.any(String),
          id: 'apps.sleeping-reads',
          kind: 'abuse',
        },
      },
      retryAfterSeconds: 42,
    });
    expect(d.list).not.toHaveBeenCalled();
  });

  it('a limiter that names no wait answers the whole hour', async () => {
    const answer = await answerSleepingApps(
      USER.id,
      deps(async () => false)
    );
    expect(answer.status).toBe(429);
    expect(answer.retryAfterSeconds).toBe(3600);
    expect((answer.json as { rateLimit: { retryAfterSeconds: number } }).rateLimit).toMatchObject({
      retryAfterSeconds: 3600,
      id: 'apps.sleeping-reads',
    });
  });

  it('CONTROL: within the limit the apps are listed', async () => {
    const answer = await answerSleepingApps(
      USER.id,
      deps(async () => true)
    );
    expect(answer).toEqual({ status: 200, json: { apps: [] } });
  });
});
