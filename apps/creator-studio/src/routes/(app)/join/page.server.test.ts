import { describe, expect, it, vi } from 'vitest';

const MAIN_APP_URL = 'https://main-app.test';
const TESTER_ID = 42;

vi.mock('$lib/server/creator-score', () => ({ getCreatorScore: vi.fn(async () => 1200) }));
vi.mock('$lib/server/creator-program', () => ({ getGetPaidEstimate: vi.fn(async () => null) }));
vi.mock('$lib/server/main-app', () => ({ MAIN_APP_URL, callMainApp: vi.fn() }));
// Stands in for the `creator-journey` segment: moderators plus a tester list. Like real Flipt, it
// matches on the CONTEXT, so a call that drops `fliptContext` reads as off for everyone.
vi.mock('$lib/server/flipt', async () => {
  const { buildFliptContext } = await import('@civitai/flipt/context');
  return {
    fliptContext: buildFliptContext,
    getFlipt: () => ({
      isEnabled: async (flag: string, _entityId?: string, context: Record<string, string> = {}) =>
        flag === 'creator-journey' &&
        (context.isModerator === 'true' || context.userId === String(TESTER_ID)),
    }),
  };
});

const { load } = await import('./+page.server');

async function journeyUrlFor(user: { id: number; isModerator?: boolean }) {
  const result = await load({
    parent: async () => ({ membership: { isCreatorProgramMember: false, isMember: false } }),
    locals: { user },
  } as unknown as Parameters<typeof load>[0]);
  return (result as { creatorJourneyUrl: string | null }).creatorJourneyUrl;
}

describe('/join creator journey link', () => {
  it('links a moderator to the main app journey page', async () => {
    expect(await journeyUrlFor({ id: 1, isModerator: true })).toBe(
      `${MAIN_APP_URL}/creators/journey`
    );
  });

  it('links a tester to the main app journey page', async () => {
    expect(await journeyUrlFor({ id: TESTER_ID })).toBe(`${MAIN_APP_URL}/creators/journey`);
  });

  it('hides the link from everyone else', async () => {
    expect(await journeyUrlFor({ id: 7 })).toBeNull();
  });
});
