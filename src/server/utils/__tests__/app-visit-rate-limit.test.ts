import { describe, expect, it } from 'vitest';

import {
  APP_VISIT_RATE_LIMIT_MAX,
  APP_VISIT_RATE_LIMIT_WINDOW_SECONDS,
  appVisitRateLimitKey,
} from '~/server/utils/app-visit-rate-limit';

describe('app visit rate limit', () => {
  it('is 60 per 60 s — the store reads’ window', () => {
    expect(APP_VISIT_RATE_LIMIT_MAX).toBe(60);
    expect(APP_VISIT_RATE_LIMIT_WINDOW_SECONDS).toBe(60);
  });

  it('keys a signed-in user by id and everyone else by ip, in disjoint namespaces', () => {
    const user = appVisitRateLimitKey(7, '203.0.113.5');
    const anon = appVisitRateLimitKey(null, '203.0.113.5');
    expect(user).toContain('app-visit:rate-limit:user:7');
    expect(anon).toContain('app-visit:rate-limit:ip:203.0.113.5');
    expect(user).not.toBe(anon);
    // `!= null`, not truthiness: a user id of 0 is still a user bucket.
    expect(appVisitRateLimitKey(0, '203.0.113.5')).toContain(':user:0');
  });
});
