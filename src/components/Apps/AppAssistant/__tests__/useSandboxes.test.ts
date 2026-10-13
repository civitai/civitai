import { describe, expect, it } from 'vitest';
import { AssistantTokenError } from '~/components/Apps/AppAssistant/assistantToken';
import { SandboxApiError } from '~/components/Apps/AppAssistant/sandboxClient';
import { shouldRetrySandboxList } from '~/components/Apps/AppAssistant/useSandboxes';

describe('shouldRetrySandboxList', () => {
  it('never retries a revoked assistant', () => {
    const revoked = new AssistantTokenError('Turn on App Assistant', 403, 'consent_required');
    expect(shouldRetrySandboxList(0, revoked)).toBe(false);
  });

  it.each([
    ['another token refusal', new AssistantTokenError('Not available', 403)],
    ['a service outage', new SandboxApiError('down', 503, 'unavailable')],
  ])('retries %s up to three times', (_label, error) => {
    expect([0, 1, 2, 3].map((n) => shouldRetrySandboxList(n, error))).toEqual([
      true,
      true,
      true,
      false,
    ]);
  });
});
