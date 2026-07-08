import { beforeEach, describe, expect, it, vi } from 'vitest';

// Mirror the notifications axiom-mock pattern (create.behavioral.test.ts): replace the module the seam
// imports so we capture the payload logOAuthEvent forwards, while the real Prometheus counter still runs.
const h = vi.hoisted(() => ({
  logToAxiom: vi.fn(async (_data: Record<string, unknown>, _datastream?: string) => {}),
}));
vi.mock('$lib/server/axiom', () => ({ logToAxiom: h.logToAxiom }));

import { logOAuthEvent } from '../audit-log';
import { register, oauthEventsTotal } from '$lib/server/metrics';

// Pull a labeled counter sample straight from the registry JSON (same idiom as metrics.test.ts).
async function counterValue(labels: Record<string, string>): Promise<number | undefined> {
  const metric = (await register.getMetricsAsJSON()).find((m) => m.name === 'hub_oauth_events_total');
  return metric?.values.find((v) =>
    Object.entries(labels).every(([k, val]) => (v.labels ?? {})[k] === val)
  )?.value;
}

beforeEach(() => h.logToAxiom.mockReset());

describe('logOAuthEvent', () => {
  it('dual-writes the audit event (event:"oauth-audit" + the event fields), letting the wrapper civitai-prod default apply', () => {
    logOAuthEvent({ type: 'token.issued', userId: 7, clientId: 'abc', ip: '1.2.3.4' });

    expect(h.logToAxiom).toHaveBeenCalledTimes(1);
    const [payload, datastream] = h.logToAxiom.mock.calls[0];
    // The seam forwards no explicit datastream, so the real wrapper's `civitai-prod` default applies
    // (asserted directly in axiom.test.ts). This test mocks the wrapper, so it sees the raw call args.
    expect(datastream).toBeUndefined();
    expect(payload.event).toBe('oauth-audit');
    expect(payload.type).toBe('token.issued');
    expect(payload.userId).toBe(7);
    expect(payload.clientId).toBe('abc');
    expect(payload.ip).toBe('1.2.3.4');
    expect(typeof payload.timestamp).toBe('string'); // ISO timestamp is added by the seam
  });

  it('still increments oauthEventsTotal with the dots→underscores label (metric preserved)', async () => {
    // Reference the counter once so the label child is pre-declared even on a fresh registry.
    oauthEventsTotal.inc({ type: 'token_refreshed' }, 0);
    const before = (await counterValue({ type: 'token_refreshed' })) ?? 0;

    logOAuthEvent({ type: 'token.refreshed', userId: 1 });

    expect(await counterValue({ type: 'token_refreshed' })).toBe(before + 1);
  });
});
