import { describe, expect, it } from 'vitest';
import { collectStepWarnings } from '~/server/services/orchestrator/step-warnings';

const retiring = {
  code: 'modelDeprecated' as const,
  message: 'Model X is retiring',
  retiresAt: '2026-10-01T00:00:00Z',
  replacement: 'Model Y',
};

describe('collectStepWarnings', () => {
  it('returns each distinct warning once across steps', () => {
    const other = { code: 'modelDeprecated' as const, message: 'Model Z is retiring' };
    // A warning repeated across steps arrives JSON-parsed, so the copies are never the same
    // reference — identity de-duplication would leave both on screen.
    const copy = { ...retiring, retiresAt: '2026-11-01T00:00:00Z' };
    const steps = [{ warnings: [retiring] }, { warnings: [copy, other] }];

    expect(collectStepWarnings(steps)).toEqual([retiring, other]);
  });

  it('is empty for steps without warnings', () => {
    expect(collectStepWarnings([{}, { warnings: null }, { warnings: [] }])).toEqual([]);
    expect(collectStepWarnings(undefined)).toEqual([]);
  });

  it('skips shapes the orchestrator types do not promise', () => {
    const steps = [null, { warnings: 'nope' }, { warnings: [null, { code: 'x' }, retiring] }];

    expect(collectStepWarnings(steps)).toEqual([retiring]);
  });
});
