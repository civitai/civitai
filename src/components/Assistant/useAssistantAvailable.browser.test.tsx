import { beforeEach, describe, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
import { renderWithProviders } from '../../../test/component-setup';

/**
 * 🔴 THE HOOK BOTH ITS CONSUMERS MOCK.
 *
 * `AssistantButton` and `SupportMenu` each replace `useAssistantAvailable` in their
 * own suites — correctly, they are testing themselves — with the result that the
 * three-condition derivation it exists to centralise executed in NO test. Dropping
 * `|| !features.assistant` turned CivBot's footer button and its menu item on for
 * every signed-in user regardless of the flag, and the whole branch stayed green.
 *
 * A feature-flag gate is the shape that fails quietly: an absent flag reads
 * `undefined`, which is falsy on the gate's side and permissive on the query's, which
 * is why this repo carries `no-untruthy-query-gate` as a convention guard. So every
 * condition here is asserted in BOTH directions rather than only the deny side.
 */
const { mocks } = vi.hoisted(() => ({
  mocks: {
    currentUser: { value: null as { id: number } | null },
    assistant: { value: true },
    personality: { value: undefined as string | undefined },
    uuid: { value: 'uuid-1' as string | null },
  },
}));

vi.mock('~/hooks/useCurrentUser', () => ({
  useCurrentUser: () => mocks.currentUser.value,
}));

vi.mock('~/providers/FeatureFlagsProvider', () => ({
  useFeatureFlags: () => ({ assistant: mocks.assistant.value }),
}));

vi.mock('~/components/UserSettings/hooks', () => ({
  useCurrentUserSettings: () => ({ assistantPersonality: mocks.personality.value }),
}));

vi.mock('~/components/Assistant/AssistantChat', () => ({
  // The uuid lookup is env-driven and the env is not set in the test browser, so the
  // holder stands in for "this deployment has a uuid for that personality".
  getAssistantUUID: () => mocks.uuid.value,
}));

const { useAssistantAvailable } = await import('~/components/Assistant/useAssistantAvailable');

/** Renders the hook's answer so it can be read the way a consumer would see it. */
function Probe() {
  const assistant = useAssistantAvailable();
  return <span data-testid="result">{assistant ? assistant.personality : 'unavailable'}</span>;
}

const result = async () => {
  renderWithProviders(<Probe />);
  // Awaited, not read synchronously: `renderWithProviders` does not commit before it
  // returns, so a bare `.element()` here throws on a hook that works fine.
  await expect.element(page.getByTestId('result')).toBeInTheDocument();
  return page.getByTestId('result').element().textContent;
};

beforeEach(() => {
  mocks.currentUser.value = { id: 1 };
  mocks.assistant.value = true;
  mocks.personality.value = undefined;
  mocks.uuid.value = 'uuid-1';
});

describe('all three conditions have to hold', () => {
  test('a signed-in user, the flag on, and a uuid for their personality', async () => {
    expect(await result()).toBe('civbot');
  });

  test('🔴 the feature flag alone can turn it off', async () => {
    mocks.assistant.value = false;
    expect(await result()).toBe('unavailable');
  });

  test('a signed-out visitor has no chat', async () => {
    mocks.currentUser.value = null;
    expect(await result()).toBe('unavailable');
  });

  test('a deployment with no uuid for the personality has no chat', async () => {
    // The case the hook's own comment says a caller deriving only the first two
    // conditions would get wrong: it would offer a chat that then renders nothing.
    mocks.uuid.value = null;
    expect(await result()).toBe('unavailable');
  });
});

describe('the personality it reports', () => {
  test('defaults to civbot when the user has not chosen one', async () => {
    expect(await result()).toBe('civbot');
  });

  test('is the chosen one otherwise', async () => {
    // Pinned against the default above, so a hook that ignored the setting and always
    // answered 'civbot' would pass one of these and fail the other.
    mocks.personality.value = 'civchan';
    expect(await result()).toBe('civchan');
  });
});
