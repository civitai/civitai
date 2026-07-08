import { beforeEach, describe, expect, it, vi } from 'vitest';

// Unit coverage for the hub's @civitai/axiom binding (src/lib/server/axiom.ts). We mock the PACKAGE so
// `createAxiomLogger()` hands back a spy for the underlying `logToAxiom` — that lets us inspect the exact
// payload + datastream our module forwards, without exercising the real stderr→Loki / Axiom dual-writer.
//
// The load-bearing assertions here are the ALERT-COMPAT LOCK: the three error seams (hooks handleError,
// oauth/token handler, login email action) all funnel through `logAxiomError`, and the datapacket-talos
// Loki alerts match auth logs by substring —
//   {namespace="civitai-auth", app="civitai-auth"} |~ "(?i)(unhandled server error|handler error|action failed|…)" != "invalid_grant"
// Because logToAxiom emits a JSON line, those alerts keep firing ONLY IF the literal keyword survives
// serialization. Each seam passes `{ event: '<exact original label>' }`, so the serialized payload must
// still contain e.g. "unhandled server error" / "handler error" / "action failed", and must still contain
// "invalid_grant" when the error is one (so the `!= "invalid_grant"` exclusion keeps suppressing it).

const h = vi.hoisted(() => ({
  logToAxiom: vi.fn(async (_data: Record<string, unknown>, _datastream?: string) => {}),
}));

// A minimal safeError matching the package contract (name/message/stack for Errors). Function declarations
// hoist, so it's defined when the (hoisted) vi.mock factory below runs.
function safeError(e: unknown) {
  if (e instanceof Error) return { name: e.name, message: e.message, stack: e.stack };
  return { message: String(e) };
}

vi.mock('@civitai/axiom', () => ({
  createAxiomLogger: () => ({ logToAxiom: h.logToAxiom, safeError }),
  safeError,
}));

import { logAxiomError, logToAxiom } from '../axiom';

beforeEach(() => h.logToAxiom.mockReset());

describe('auth axiom binding', () => {
  it('logToAxiom defaults to the civitai-prod datastream (preserves the existing captcha path)', async () => {
    await logToAxiom({ name: 'captcha-reject' });
    expect(h.logToAxiom).toHaveBeenCalledWith({ name: 'captcha-reject' }, 'civitai-prod');
  });

  it('logToAxiom honors an explicit datastream', async () => {
    await logToAxiom({ event: 'oauth-audit' }, 'auth');
    expect(h.logToAxiom).toHaveBeenCalledWith({ event: 'oauth-audit' }, 'auth');
  });

  it('logAxiomError routes to the auth datastream with type:error, the event marker, and safeError fields', async () => {
    await logAxiomError(new Error('boom'), { event: 'unhandled server error', clientId: 'abc' });
    expect(h.logToAxiom).toHaveBeenCalledTimes(1);
    const [payload, datastream] = h.logToAxiom.mock.calls[0];
    expect(datastream).toBe('auth');
    expect(payload.type).toBe('error');
    expect(payload.event).toBe('unhandled server error');
    expect(payload.clientId).toBe('abc'); // extra context is merged
    expect(payload.message).toBe('boom'); // safeError fields land
  });

  // ALERT-COMPAT LOCK — the serialized line must carry the exact substring each Loki alert keys on.
  it.each([
    ['unhandled server error', 'unhandled server error'],
    ['[oauth/token] handler error', 'handler error'],
    ['email login action failed', 'action failed'],
  ])('seam marker %j keeps alert keyword %j in the serialized payload', async (marker, keyword) => {
    await logAxiomError(new Error('boom'), { event: marker });
    const [payload] = h.logToAxiom.mock.calls[0];
    expect(payload.event).toBe(marker);
    expect(JSON.stringify(payload)).toContain(keyword);
  });

  it('keeps "invalid_grant" in the line so the alert `!= "invalid_grant"` exclusion still suppresses it', async () => {
    const err = Object.assign(new Error('Invalid grant: authorization code is invalid'), {
      name: 'invalid_grant',
    });
    await logAxiomError(err, { event: '[oauth/token] handler error' });
    const line = JSON.stringify(h.logToAxiom.mock.calls[0][0]);
    expect(line).toContain('handler error');
    expect(line).toContain('invalid_grant');
  });

  it('swallows a logToAxiom rejection — logging can never break the caller', async () => {
    h.logToAxiom.mockRejectedValueOnce(new Error('axiom down'));
    await expect(
      logAxiomError(new Error('boom'), { event: 'unhandled server error' })
    ).resolves.toBeUndefined();
  });
});
