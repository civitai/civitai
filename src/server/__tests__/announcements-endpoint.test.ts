import { describe, it, expect, vi, beforeEach } from 'vitest';

// Lives here, not beside the route: Next treats every file under src/pages as a route and
// `next build` runs a route-type validator over it, so a test there fails the build in a
// step nothing else catches.
//
// This endpoint is the Creator Studio's only door. It is one auth rung below its tRPC
// twin by construction — AuthedEndpoint checks session presence, guardedProcedure checks
// onboarded and not-muted — so the checks it adds back are the whole of that door's lock.

const upsert = vi.fn(async () => ({ id: 1 }));
const remove = vi.fn(async () => ({ id: 1 }));
const allowance = vi.fn(async () => ({ eligible: true, limit: 1 }));
const features = vi.fn(() => ({ creatorAnnouncements: true }));

vi.mock('~/server/services/creator-announcement.service', () => ({
  upsertCreatorAnnouncement: (...args: unknown[]) => upsert(...(args as [])),
  deleteCreatorAnnouncement: (...args: unknown[]) => remove(...(args as [])),
}));
vi.mock('~/server/services/announcement-allowance.service', () => ({
  getAnnouncementAllowance: (...args: unknown[]) => allowance(...(args as [])),
}));
vi.mock('~/server/services/feature-flags.service', () => ({
  getFeatureFlags: (...args: unknown[]) => features(...(args as [])),
}));
vi.mock('~/server/utils/endpoint-helpers', () => ({
  // Hand the handler straight back so the test drives it directly; the session check
  // AuthedEndpoint performs is not what this file is about.
  AuthedEndpoint: (handler: unknown) => handler,
  handleEndpointError: (res: { status: (n: number) => { json: (b: unknown) => unknown } }) =>
    res.status(500).json({ error: 'handled' }),
}));

import handler from '~/pages/api/v1/announcements';

const OK_USER = { id: 7, onboarding: 0xff, muted: false, isModerator: false };

function makeRes() {
  const res = {
    statusCode: 0,
    body: undefined as unknown,
    status(code: number) {
      res.statusCode = code;
      return res;
    },
    json(body: unknown) {
      res.body = body;
      return res;
    },
  };
  return res;
}

const call = (req: Record<string, unknown>, user: Record<string, unknown> = OK_USER) => {
  const res = makeRes();
  return (handler as unknown as (r: unknown, s: unknown, u: unknown) => Promise<unknown>)(
    { query: {}, body: {}, ...req },
    res,
    user
  ).then(() => res);
};

const validBody = {
  title: 'New LoRA',
  content: 'Body text',
  domain: ['all'],
  profileOnly: false,
};

beforeEach(() => {
  vi.clearAllMocks();
  features.mockReturnValue({ creatorAnnouncements: true });
});

describe('the spoke door is not cheaper than the onsite one', () => {
  it('serves an eligible creator', async () => {
    const res = await call({ method: 'GET' });

    expect(res.statusCode).toBe(200);
    expect(allowance).toHaveBeenCalledWith(7);
  });

  it('refuses a muted creator, who guardedProcedure would refuse onsite', async () => {
    const res = await call({ method: 'POST', body: validBody }, { ...OK_USER, muted: true });

    expect(res.statusCode).toBe(500); // handleEndpointError maps the thrown TRPCError
    expect(upsert).not.toHaveBeenCalled();
  });

  it('refuses an un-onboarded creator', async () => {
    const res = await call({ method: 'POST', body: validBody }, { ...OK_USER, onboarding: 0 });

    expect(res.statusCode).toBe(500);
    expect(upsert).not.toHaveBeenCalled();
  });

  // The arm above cannot tell stamp-gating from unverified-gating, because its fixture carries both.
  // Relaxing the spoke to `!user.emailVerified` would refuse the 7.1M accounts the column was never
  // populated for, and every assertion in this file would still pass except by accident: OK_USER
  // happens to omit `emailVerified`, so the omission is what holds the invariant. This names it.
  it('serves a legacy account that is unverified but was never stamped', async () => {
    const res = await call(
      { method: 'POST', body: validBody },
      { ...OK_USER, emailVerified: null, meta: {} }
    );

    expect(res.statusCode).toBe(200);
    expect(upsert).toHaveBeenCalled();
  });

  it('refuses a creator the email gate would refuse onsite', async () => {
    const res = await call(
      { method: 'POST', body: validBody },
      { ...OK_USER, emailVerified: null, meta: { emailVerificationRequired: true } }
    );

    expect(res.statusCode).toBe(500);
    expect(upsert).not.toHaveBeenCalled();
  });

  it('refuses when the feature flag is off, so the spoke cannot outrun the rollout', async () => {
    features.mockReturnValue({ creatorAnnouncements: false });

    const res = await call({ method: 'POST', body: validBody });

    expect(upsert).not.toHaveBeenCalled();
  });
});

describe('request handling', () => {
  it('revives ISO date strings into Dates the service can store', async () => {
    await call({
      method: 'POST',
      body: { ...validBody, startsAt: '2026-09-01T00:00:00.000Z', endsAt: null },
    });

    const arg = upsert.mock.calls[0][0] as { startsAt: unknown; endsAt: unknown };
    expect(arg.startsAt).toBeInstanceOf(Date);
    // null must survive: it is how the composer clears an end date.
    expect(arg.endsAt).toBeNull();
  });

  it('passes the caller as author and forwards moderator status, never reading them from the body', async () => {
    await call({ method: 'POST', body: { ...validBody, userId: 999, isModerator: true } });

    const arg = upsert.mock.calls[0][0] as { userId: number; isModerator: boolean };
    expect(arg.userId).toBe(7);
    expect(arg.isModerator).toBe(false);
  });

  it('rejects an invalid body with 400 rather than handing it to the service', async () => {
    const res = await call({ method: 'POST', body: { title: '', content: '' } });

    expect(res.statusCode).toBe(400);
    expect(upsert).not.toHaveBeenCalled();
  });

  it('deletes by a numeric id and refuses anything else', async () => {
    const ok = await call({ method: 'DELETE', body: { id: 12 } });
    expect(ok.statusCode).toBe(200);
    expect(remove).toHaveBeenCalledWith({ id: 12, userId: 7, isModerator: false });

    remove.mockClear();
    const bad = await call({ method: 'DELETE', body: { id: 'twelve' } });
    expect(bad.statusCode).toBe(400);
    expect(remove).not.toHaveBeenCalled();
  });
});
