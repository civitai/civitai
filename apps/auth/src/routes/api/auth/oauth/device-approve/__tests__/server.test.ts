import { describe, it, expect } from 'vitest';
import { POST } from '../+server';
import { markUnconfirmedSession } from '$lib/server/auth/unconfirmed-session';

function approve(locals: Record<string, unknown>) {
  return POST({
    request: new Request('https://auth.civitai.com/api/auth/oauth/device-approve', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    }),
    locals,
    getClientAddress: () => '203.0.113.9',
  } as never) as Promise<Response>;
}

describe('POST /api/auth/oauth/device-approve', () => {
  it('refuses an impersonation session before reading the code', async () => {
    const res = await approve({ user: { id: 7 }, impersonatedBy: 5 });
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: 'access_denied' });
  });

  it('answers 503 for a session accepted without reading the session store', async () => {
    const session = { sub: '7', jti: 'j' };
    markUnconfirmedSession(session);
    const res = await approve({ user: { id: 7 }, session });
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ error: 'temporarily_unavailable' });
  });

  it('reaches code validation for a direct session', async () => {
    const res = await approve({ user: { id: 7 }, session: { sub: '7', jti: 'j' } });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: 'invalid_request' });
  });

  it('reaches code validation with no session claims in locals', async () => {
    const res = await approve({ user: { id: 7 } });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: 'invalid_request' });
  });
});
