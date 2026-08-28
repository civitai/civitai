import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  consumeVerificationToken: vi.fn().mockResolvedValue(true),
  findOrCreateUserByEmail: vi.fn().mockResolvedValue({ id: 7 }),
  establishSession: vi.fn().mockResolvedValue(undefined),
  buildPostLoginOriginCheck: vi.fn().mockResolvedValue(() => true),
}));

vi.mock('$lib/server/auth/email-tokens', () => ({
  consumeVerificationToken: h.consumeVerificationToken,
}));
vi.mock('$lib/server/auth/users', () => ({
  findOrCreateUserByEmail: h.findOrCreateUserByEmail,
}));
vi.mock('$lib/server/auth/session', () => ({ establishSession: h.establishSession }));
vi.mock('$lib/server/oauth/first-party', () => ({
  buildPostLoginOriginCheck: h.buildPostLoginOriginCheck,
}));
// `normalizeEmailAddress` is pure, but its blocklist module also exposes DB-backed helpers.
// Keep the real normalizer in this route test while preventing that unrelated DB module from booting.
vi.mock('$lib/server/db/db', () => ({ db: {} }));

import { GET } from '../+server';

function makeEvent(email: string) {
  const url = new URL('https://auth.civitai.com/login/email/verify');
  url.searchParams.set('token', 'valid-token');
  url.searchParams.set('email', email);

  return { url, cookies: {} } as Parameters<typeof GET>[0];
}

beforeEach(() => {
  vi.clearAllMocks();
  h.consumeVerificationToken.mockResolvedValue(true);
  h.findOrCreateUserByEmail.mockResolvedValue({ id: 7 });
  h.establishSession.mockResolvedValue(undefined);
  h.buildPostLoginOriginCheck.mockResolvedValue(() => true);
});

describe('email magic-link verification', () => {
  it('preserves uppercase characters in the local part when validating the issued token', async () => {
    await expect(GET(makeEvent('User@Example.COM'))).rejects.toMatchObject({ status: 302 });

    expect(h.consumeVerificationToken).toHaveBeenCalledWith('User@example.com', 'valid-token');
    expect(h.findOrCreateUserByEmail).toHaveBeenCalledWith('User@example.com');
  });
});
