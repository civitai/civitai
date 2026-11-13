import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as Email from '@civitai/email';
import type * as Invites from '$lib/server/oauth/invites';

const mocks = vi.hoisted(() => ({
  authenticatedConfidentialClient: vi.fn(),
  inviteSender: vi.fn(),
  newAccountRefusal: vi.fn(),
  checkRateLimit: vi.fn(),
  isRateLimited: vi.fn(),
  send: vi.fn(),
  isEmailConfigured: vi.fn(),
}));

vi.mock('@civitai/email', async (importOriginal) => ({
  ...(await importOriginal<typeof Email>()),
  isEmailConfigured: mocks.isEmailConfigured,
}));
vi.mock('$lib/server/db/db', () => ({ db: {} }));
vi.mock('$lib/server/redis', () => ({ getRedis: () => null }));
vi.mock('$lib/server/oauth/client-auth', () => ({
  authenticatedConfidentialClient: mocks.authenticatedConfidentialClient,
}));
vi.mock('$lib/server/oauth/invites', async (importOriginal) => ({
  ...(await importOriginal<typeof Invites>()),
  inviteSender: mocks.inviteSender,
}));
vi.mock('$lib/server/auth/invite-tokens', () => ({
  issueInvite: vi.fn(async (_invite: unknown, deliver: (token: string) => Promise<void>) => {
    await deliver('raw-token');
    return { expiresAt: new Date(0) };
  }),
}));
vi.mock('$lib/server/auth/signup-rules', () => ({ newAccountRefusal: mocks.newAccountRefusal }));
vi.mock('$lib/server/oauth/first-party', () => ({
  buildPostLoginOriginCheck: vi.fn(async () => (origin: string) => origin !== UNTRUSTED),
}));
vi.mock('$lib/server/auth/users', () => ({ userExistsByEmail: vi.fn(async () => false) }));
vi.mock('$lib/server/auth/rate-limit', () => ({
  checkRateLimit: mocks.checkRateLimit,
  isRateLimited: mocks.isRateLimited,
}));
vi.mock('$lib/server/email/invite.email', () => ({ inviteEmail: { send: mocks.send } }));
vi.mock('$lib/server/oauth/audit-log', () => ({ logOAuthEvent: vi.fn() }));
vi.mock('$lib/server/axiom', () => ({ logAxiomError: vi.fn() }));
vi.mock('$lib/server/metrics', () => ({ blockedEmailDomainSignupsTotal: { inc: vi.fn() } }));

import { POST } from '../+server';

const ORIGIN = 'https://advertising.civitai.com';
// Registered for the app, but not a host the post-login redirect follows.
const UNTRUSTED = 'https://ads.example.net';
const VALID = { email: 'Bob@Example.com', returnUrl: `${ORIGIN}/invite/abc` };

async function invite(body: Record<string, unknown>) {
  const request = new Request('https://auth.civitai.com/api/auth/invite', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const res = await POST({ request, url: new URL(request.url) } as never);
  return { status: res.status, body: await res.json() };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.authenticatedConfidentialClient.mockResolvedValue({ id: 'ads', tokenRateLimit: null });
  mocks.inviteSender.mockResolvedValue({
    id: 'ads',
    name: 'Civitai Advertising',
    allowedOrigins: [ORIGIN, UNTRUSTED],
  });
  mocks.newAccountRefusal.mockResolvedValue(null);
  mocks.checkRateLimit.mockResolvedValue(true);
  mocks.isRateLimited.mockResolvedValue(false);
  mocks.isEmailConfigured.mockReturnValue(true);
});

describe('POST /api/auth/invite', () => {
  it('emails the link to the recipient and never returns it to the caller', async () => {
    const res = await invite({ ...VALID, invitedBy: 'Alice', message: 'join "Acme"' });
    expect(res.status).toBe(202);
    expect(JSON.stringify(res.body)).not.toContain('raw-token');
    expect(mocks.send).toHaveBeenCalledOnce();
    const sent = mocks.send.mock.calls[0][0];
    expect(sent.to).toBe('Bob@example.com');
    expect(sent.appName).toBe('Civitai Advertising');
    expect(new URL(sent.url).searchParams.get('token')).toBe('raw-token');
    expect(new URL(sent.url).origin).toBe('https://auth.civitai.com');
  });

  it('refuses bad client credentials', async () => {
    mocks.authenticatedConfidentialClient.mockResolvedValue(null);
    expect((await invite(VALID)).status).toBe(401);
    expect(mocks.send).not.toHaveBeenCalled();
  });

  it('refuses a client that is not an enabled confidential system app', async () => {
    mocks.inviteSender.mockResolvedValue(null);
    expect((await invite(VALID)).status).toBe(403);
    expect(mocks.send).not.toHaveBeenCalled();
  });

  it.each([
    ['another origin', 'https://evil.example/invite/abc'],
    ['a lookalike host', 'https://advertising.civitai.com.evil.example/x'],
    ['a relative path', '/invite/abc'],
    ['a registered origin the hub will not redirect to', `${UNTRUSTED}/invite/abc`],
  ])('refuses a returnUrl on %s', async (_label, returnUrl) => {
    expect((await invite({ ...VALID, returnUrl })).status).toBe(400);
    expect(mocks.send).not.toHaveBeenCalled();
  });

  it('refuses an address that is not a plain email', async () => {
    expect((await invite({ ...VALID, email: 'Bob <bob@example.com>' })).status).toBe(400);
    expect(mocks.send).not.toHaveBeenCalled();
  });

  it('refuses an address that may not start an account', async () => {
    mocks.newAccountRefusal.mockResolvedValue('blockedDomain');
    expect((await invite(VALID)).status).toBe(403);
    expect(mocks.send).not.toHaveBeenCalled();
  });

  it('refuses over-long invitedBy and message text', async () => {
    expect((await invite({ ...VALID, invitedBy: 'a'.repeat(101) })).status).toBe(400);
    expect((await invite({ ...VALID, message: 'a'.repeat(201) })).status).toBe(400);
    expect(mocks.send).not.toHaveBeenCalled();
  });

  it('refuses once rate limited', async () => {
    mocks.isRateLimited.mockResolvedValue(true);
    expect((await invite(VALID)).status).toBe(429);
    expect(mocks.send).not.toHaveBeenCalled();
  });
});

describe('POST /api/auth/invite without email configured', () => {
  it('answers 503 rather than a 202 for an invite nobody will receive', async () => {
    mocks.isEmailConfigured.mockReturnValue(false);
    expect((await invite(VALID)).status).toBe(503);
    expect(mocks.send).not.toHaveBeenCalled();
  });
});

describe('POST /api/auth/invite rate limiting', () => {
  it('counts a sent invite against the recipient, case-insensitively', async () => {
    await invite(VALID);
    expect(mocks.checkRateLimit).toHaveBeenCalledWith(
      'invite-recipient',
      'bob@example.com',
      expect.any(Number),
      expect.any(Number)
    );
  });

  it('does not count an attempt whose email failed to send', async () => {
    mocks.send.mockRejectedValueOnce(new Error('SMTP refused'));
    expect((await invite(VALID)).status).toBe(500);
    expect(mocks.checkRateLimit).not.toHaveBeenCalled();
  });
});
