import { describe, it, expect } from 'vitest';
import { familyClaims, familyId } from '../family';

describe('familyClaims', () => {
  const impersonating = {
    jti: 'child',
    sid: 'root',
    iat0: 1_000,
    impersonatedBy: 100,
    impExp: 9_000,
  };

  it('refresh preserves sid, iat0, impersonatedBy, impExp', () => {
    expect(familyClaims(impersonating, { now: 5_000 })).toEqual({
      sid: 'root',
      iat0: 1_000,
      impersonatedBy: 100,
      impExp: 9_000,
    });
  });

  it('a root session is its own family, and its children name it', () => {
    const root = { jti: 'root', ...familyClaims(null, { now: 5_000 }) };
    expect(root).toEqual({ jti: 'root', iat0: 5_000 });
    expect(familyId(root)).toBe('root');
    expect(familyClaims(root, { now: 6_000 })).toEqual({ sid: 'root', iat0: 5_000 });
  });

  it('switching or exiting drops the impersonation claims but keeps the lineage', () => {
    expect(familyClaims(impersonating, { clearImpersonation: true })).toEqual({
      sid: 'root',
      iat0: 1_000,
    });
  });

  it('starts the 90-day window now for a parent minted before lineage existed', () => {
    expect(familyClaims({ jti: 'legacy' }, { now: 5_000 })).toEqual({ sid: 'legacy', iat0: 5_000 });
  });
});
