import { describe, expect, it } from 'vitest';
import { banReasonOptions } from '~/utils/user-helpers';

describe('banReasonOptions', () => {
  it('offers no reason only the system sets', () => {
    const values = banReasonOptions().map((o) => o.value);
    expect(values).not.toContain('Chargeback');
    expect(values).toContain('Other');
  });
});
