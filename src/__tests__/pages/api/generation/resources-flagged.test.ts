import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as AuthSession from '~/server/auth/get-server-auth-session';

const { mockGetResourceData, session } = vi.hoisted(() => ({
  mockGetResourceData: vi.fn(),
  session: { user: undefined as undefined | { id: number; isModerator: boolean } },
}));

vi.mock('~/server/utils/endpoint-helpers', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  PublicEndpoint: (handler: unknown) => handler,
}));
vi.mock('~/server/services/generation/generation.service', () => ({
  getResourceData: mockGetResourceData,
}));
vi.mock('~/server/services/feature-flags.service', () => ({
  getFeatureFlagsLazy: () => ({}),
}));
vi.mock('~/server/auth/get-server-auth-session', async (importOriginal) => ({
  ...(await importOriginal<typeof AuthSession>()),
  getServerAuthSession: vi.fn(async () => (session.user ? { user: session.user } : null)),
}));

import handler from '~/pages/api/generation/resources';

/** `GET /api/generation/resources` leaves out resources of a model flagged `poi`. */

const OWNER = 7;
const FLAGGED = { id: 100, model: { poi: true, userId: OWNER } };
const CONTROL = { id: 200, model: { poi: false, userId: 8 } };

async function request() {
  mockGetResourceData.mockResolvedValue([FLAGGED, CONTROL]);
  const json = vi.fn();
  const res = { status: vi.fn(() => ({ json })), headersSent: false };
  await (handler as (req: unknown, res: unknown) => Promise<void>)(
    { method: 'GET', query: { ids: ['100', '200'] }, headers: {} },
    res
  );
  return (json.mock.calls.at(-1)?.[0] as { id: number }[]).map((r) => r.id);
}

beforeEach(() => {
  vi.clearAllMocks();
  session.user = undefined;
});

describe('GET /api/generation/resources', () => {
  it.each([
    ['anonymous', undefined, [CONTROL.id]],
    ['a non-owner', { id: 9, isModerator: false }, [CONTROL.id]],
    ['the owner', { id: OWNER, isModerator: false }, [FLAGGED.id, CONTROL.id]],
    ['a moderator', { id: 1, isModerator: true }, [FLAGGED.id, CONTROL.id]],
  ])('%s gets the resources it may see', async (_label, user, expected) => {
    session.user = user;
    expect(await request()).toEqual(expected);
  });
});
