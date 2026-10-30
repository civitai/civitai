import { describe, expect, it } from 'vitest';
import { subscriptionBadge } from '../labels';

describe('subscriptionBadge', () => {
  it('reads live statuses as neutral, failed payments as alarms and ended ones as quiet', () => {
    expect(['active', 'trialing'].map(subscriptionBadge)).toEqual(['secondary', 'secondary']);
    expect(['past_due', 'unpaid', 'incomplete'].map(subscriptionBadge)).toEqual([
      'destructive',
      'destructive',
      'destructive',
    ]);
    expect(['canceled', 'incomplete_expired'].map(subscriptionBadge)).toEqual([
      'outline',
      'outline',
    ]);
  });

  it('does not alarm on a status it does not know', () => {
    expect(subscriptionBadge('paused')).toBe('outline');
  });
});
