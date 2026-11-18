import { describe, expect, it } from 'vitest';
import { donateToEventSchema } from '~/server/schema/event.schema';

// The route's amount: a whole, positive number of Buzz.
describe('the donation amount', () => {
  it.each([
    ['zero', 0],
    ['a negative amount', -50],
    ['a fraction', 12.5],
  ])('refuses %s', (_label, amount) => {
    expect(donateToEventSchema.safeParse({ event: 'holiday2024', amount }).success).toBe(false);
  });

  it('accepts a whole, positive amount', () => {
    expect(donateToEventSchema.safeParse({ event: 'holiday2024', amount: 100 }).success).toBe(true);
  });
});
