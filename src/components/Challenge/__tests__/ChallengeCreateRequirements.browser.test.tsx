import { describe, expect, test } from 'vitest';
// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { renderWithProviders } from '../../../../test/component-setup';
import { ChallengeCreateRequirements } from '~/components/Challenge/ChallengeCreateRequirements';

const eligibility = (requirements: Record<string, unknown>[]) =>
  ({ canCreate: false, requirements } as Parameters<
    typeof ChallengeCreateRequirements
  >[0]['eligibility']);

describe('ChallengeCreateRequirements — creation limits', () => {
  test('names how many can run at once on each tier when the active limit blocks', async () => {
    renderWithProviders(
      <ChallengeCreateRequirements
        noun="crucible"
        eligibility={eligibility([{ key: 'activeLimit', met: false, activeCount: 1, limit: 1 }])}
      />
    );

    await expect
      .poll(() => document.body.textContent)
      .toContain('Free 1, Founder and Bronze 2, Silver 3, Gold 5');
    expect(document.body.textContent).toContain('running at once');
  });

  test('describes the create limit as a rolling 24 hours, not a daily allowance', async () => {
    renderWithProviders(
      <ChallengeCreateRequirements
        noun="crucible"
        eligibility={eligibility([{ key: 'dailyLimit', met: false, recentCount: 5, limit: 5 }])}
      />
    );

    await expect.poll(() => document.body.textContent).toContain('any 24 hours');
    expect(document.body.textContent).not.toMatch(/daily/i);
  });
});
