import { describe, expect, it } from 'vitest';
import { resolveDailyCap, type SpendCap } from '../spend-cap';

const HIGH = 'moderator:mod-high-access';
const MEDIUM = 'moderator:mod-medium-access';
const role = (subject: string, usd: number): SpendCap => ({ scope: 'role', subject, usd });
const own = (id: number, usd: number): SpendCap => ({ scope: 'user', subject: String(id), usd });

describe('resolveDailyCap', () => {
  const mod = { id: 7, roles: [MEDIUM, HIGH] };

  it("takes the moderator's own cap over their roles', lower or higher", () => {
    expect(resolveDailyCap([role(HIGH, 5), own(7, 2)], mod)).toEqual({ usd: 2, from: 'user' });
    expect(resolveDailyCap([role(HIGH, 5), own(7, 9)], mod)).toEqual({ usd: 9, from: 'user' });
  });

  it('takes a $0 own cap over any role', () => {
    expect(resolveDailyCap([role(HIGH, 5), own(7, 0)], mod).usd).toBe(0);
  });

  it('takes the highest cap among the roles held, and none from roles not held', () => {
    expect(
      resolveDailyCap([role(MEDIUM, 3), role(HIGH, 2), role('moderator:other', 40)], mod)
    ).toEqual({ usd: 3, from: 'role' });
  });

  it("ignores another moderator's cap and falls back to $1", () => {
    expect(resolveDailyCap([own(8, 50)], mod)).toEqual({ usd: 1, from: 'default' });
  });
});
