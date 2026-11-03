import { describe, expect, it } from 'vitest';
import { showcaseHatSchema } from '~/server/schema/event.schema';

// The toggle and the picker share one mutation: a call must say which it is.
describe('showcaseHatSchema', () => {
  const event = 'birthday2026';

  it('takes a pick, a cleared pick, or the off switch', () => {
    expect(showcaseHatSchema.safeParse({ event, cosmeticId: 3 }).success).toBe(true);
    expect(showcaseHatSchema.safeParse({ event, cosmeticId: null }).success).toBe(true);
    expect(showcaseHatSchema.safeParse({ event, off: true }).success).toBe(true);
  });

  it('refuses both at once, and neither', () => {
    expect(showcaseHatSchema.safeParse({ event, cosmeticId: 3, off: true }).success).toBe(false);
    expect(showcaseHatSchema.safeParse({ event }).success).toBe(false);
  });
});
