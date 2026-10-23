import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as ConsentUtils from '~/components/Consent/consent.utils';

/**
 * The consent rule — a cookie decision wins, otherwise a signed-in viewer has accepted through
 * the Terms of Service — is legal policy. It lives in `consent.utils` once, and both gates that
 * apply it (`CAConsentManager` on a server render, `ShellConsentGate` on a shell boot) must call
 * that one function rather than carry a copy.
 */

const h2 = vi.hoisted(() => ({
  decision: vi.fn(),
  context: vi.fn(),
}));

vi.mock('~/components/Consent/consent.utils', async (importOriginal) => {
  const actual = await importOriginal<typeof ConsentUtils>();
  h2.decision.mockImplementation(actual.initialConsentDecision);
  h2.context.mockImplementation(actual.requiredConsentContext);
  return {
    ...actual,
    initialConsentDecision: h2.decision,
    requiredConsentContext: h2.context,
  };
});

const { CAConsentManager } = await import('~/components/Consent/CAConsentManager');
const { ShellConsentGate } = await import('~/components/Consent/ShellConsentGate');
const { useThirdPartyConsent } = await import('~/components/Consent/consent.context');
const { initialConsentDecision } = await import('~/components/Consent/consent.utils');

const CALIFORNIA = { countryCode: 'US', regionCode: 'CA', fullLocationCode: 'US:CA' };

function Probe() {
  const { consent, required, allowed } = useThirdPartyConsent();
  return h('i', {
    'data-c': String(consent),
    'data-r': String(required),
    'data-a': String(allowed),
  });
}

beforeEach(() => {
  h2.decision.mockClear();
  h2.context.mockClear();
});

describe('one consent rule for both gates', () => {
  it('the rule itself', () => {
    expect(initialConsentDecision('rejected', true)).toBe('rejected');
    expect(initialConsentDecision('accepted', false)).toBe('accepted');
    expect(initialConsentDecision(null, true)).toBe('accepted');
    expect(initialConsentDecision(null, false)).toBeNull();
  });

  it('CAConsentManager decides through it', () => {
    const html = renderToStaticMarkup(
      h(CAConsentManager, { initialConsent: null, loggedIn: true }, h(Probe))
    );
    expect(h2.decision).toHaveBeenCalledWith(null, true);
    expect(h2.context).toHaveBeenCalled();
    expect(html).toContain('data-c="accepted" data-r="true" data-a="true"');
  });

  it('ShellConsentGate decides through it once the region is known', () => {
    const html = renderToStaticMarkup(
      h(
        ShellConsentGate,
        { pending: false, region: CALIFORNIA, initialConsent: null, loggedIn: true },
        h(Probe)
      )
    );
    expect(h2.decision).toHaveBeenCalledWith(null, true);
    expect(h2.context).toHaveBeenCalled();
    expect(html).toContain('data-c="accepted" data-r="true" data-a="true"');
  });

  it('control: a pending ShellConsentGate decides nothing yet', () => {
    const html = renderToStaticMarkup(
      h(
        ShellConsentGate,
        { pending: true, region: undefined, initialConsent: null, loggedIn: true },
        h(Probe)
      )
    );
    expect(h2.decision).not.toHaveBeenCalled();
    expect(html).toContain('data-r="false" data-a="false"');
  });
});
