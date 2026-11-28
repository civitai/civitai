import { describe, expect, it } from 'vitest';
import { createStrikeInput } from '~/server/api-routes/mod/strike/create';

const base = { userId: '990000001', description: 'd' };

// REST holds the same 0-point rule as tRPC (civitai/civitai#10736). Values arrive as strings.
describe('strike.create input points', () => {
  it('accepts a 0-point Copyright strike', () => {
    const result = createStrikeInput.safeParse({ ...base, reason: 'Copyright', points: '0' });
    expect(result.success).toBe(true);
    expect(result.data?.points).toBe(0);
  });

  it('refuses 0 points for any other reason', () => {
    const result = createStrikeInput.safeParse({ ...base, reason: 'TOSViolation', points: '0' });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.path).toEqual(['points']);
  });

  it('accepts a TOSViolation strike with points', () => {
    expect(
      createStrikeInput.safeParse({ ...base, reason: 'TOSViolation', points: '1' }).success
    ).toBe(true);
  });
});
