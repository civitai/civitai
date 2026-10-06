import { beforeEach, describe, expect, it, vi } from 'vitest';

const MAIN_APP_URL = 'https://main-app.test';
const JOURNEY_URL = `${MAIN_APP_URL}/creators/journey`;
const TESTER_ID = 42;

type Segment = (context: Record<string, string>) => boolean | null;
const modsAndTesters: Segment = (context) =>
  context.isModerator === 'true' || context.userId === String(TESTER_ID);
let segment: Segment = modsAndTesters;

vi.mock('$lib/server/creator-score', () => ({ getCreatorScore: vi.fn(async () => 1200) }));
vi.mock('$lib/server/creator-program', () => ({ getGetPaidEstimate: vi.fn(async () => null) }));
vi.mock('$lib/server/main-app', () => ({ MAIN_APP_URL, callMainApp: vi.fn() }));
// Stands in for Flipt: answers only for the `creator-journey` key, and like the real segment it
// matches on the CONTEXT, so a call that drops `fliptContext` reads as off for everyone. `null` is
// what the real client returns while unreachable or before the flag exists.
vi.mock('$lib/server/flipt', async () => {
  const { buildFliptContext } = await import('@civitai/flipt/context');
  return {
    fliptContext: buildFliptContext,
    getFlipt: () => ({
      ensureInitialized: async () => undefined,
      isEnabledSync: (flag: string, _entityId?: string, context: Record<string, string> = {}) =>
        flag === 'creator-journey' ? segment(context) : null,
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
  beforeEach(() => {
    segment = modsAndTesters;
  });

  it('links a moderator to the main app journey page', async () => {
    expect(await journeyUrlFor({ id: 1, isModerator: true })).toBe(JOURNEY_URL);
  });

  it('links a tester to the main app journey page', async () => {
    expect(await journeyUrlFor({ id: TESTER_ID })).toBe(JOURNEY_URL);
  });

  it('hides the link from everyone else', async () => {
    expect(await journeyUrlFor({ id: 7 })).toBeNull();
  });

  // While Flipt answers, the main app follows it over the role check, so a moderator outside the
  // segment gets a 404 there and must get no link here.
  it('follows Flipt over the moderator role when Flipt answers', async () => {
    segment = (context) => context.userId === String(TESTER_ID);
    expect(await journeyUrlFor({ id: 1, isModerator: true })).toBeNull();
  });

  // The main app falls back to availability ['mod'] when Flipt has no answer, so moderators still
  // reach the page and must still get the link.
  it('falls back to moderators only when Flipt has no answer', async () => {
    segment = () => null;
    expect(await journeyUrlFor({ id: 1, isModerator: true })).toBe(JOURNEY_URL);
    expect(await journeyUrlFor({ id: TESTER_ID })).toBeNull();
  });
});
