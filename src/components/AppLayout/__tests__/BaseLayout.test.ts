import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as FullScreen from '~/components/ImageGeneration/useGenerationPanelFullScreen';
import type * as OnboardingUtils from '~/components/Onboarding/onboarding.utils';
import type * as ResourceResidency from '~/components/ResourceLoad/ResourceResidency';
import type * as CurrentUser from '~/hooks/useCurrentUser';
import type * as FeatureFlagsProvider from '~/providers/FeatureFlagsProvider';
import type * as GenerationPanelStore from '~/store/generation-panel.store';
import { BaseLayout } from '~/components/AppLayout/BaseLayout';

const state = vi.hoisted(() => ({
  pathname: '/models',
  opened: true,
  fullScreen: true as boolean | undefined,
  user: {} as Record<string, unknown> | undefined,
  onboardingSteps: [] as string[],
  music: true,
}));

vi.mock('next/router', () => ({ useRouter: () => ({ pathname: state.pathname }) }));
vi.mock('next/dynamic', () => ({ default: () => () => null }));
vi.mock('~/components/Meta/MetaPWA', () => ({ MetaPWA: () => null }));
vi.mock('~/components/Notifications/PushRegistrationManager', () => ({
  PushRegistrationManager: () => null,
}));
vi.mock('~/components/Notifications/PushOptInPrompt', () => ({ PushOptInPrompt: () => null }));
// renderToString reads a zustand store's INITIAL state, so setState can't open the panel.
vi.mock('~/store/generation-panel.store', async (importOriginal) => ({
  ...(await importOriginal<typeof GenerationPanelStore>()),
  useGenerationPanelStore: (select: (s: { opened: boolean }) => unknown) =>
    select({ opened: state.opened }),
}));
vi.mock('~/components/ImageGeneration/useGenerationPanelFullScreen', async (importOriginal) => ({
  ...(await importOriginal<typeof FullScreen>()),
  useGenerationPanelFullScreen: () => state.fullScreen,
}));
vi.mock('~/hooks/useCurrentUser', async (importOriginal) => ({
  ...(await importOriginal<typeof CurrentUser>()),
  useCurrentUser: () => state.user,
}));
vi.mock('~/components/Onboarding/onboarding.utils', async (importOriginal) => ({
  ...(await importOriginal<typeof OnboardingUtils>()),
  useGetRequiredOnboardingSteps: () => state.onboardingSteps,
}));
vi.mock('~/providers/FeatureFlagsProvider', async (importOriginal) => ({
  ...(await importOriginal<typeof FeatureFlagsProvider>()),
  useOptionalFeatureFlags: () => ({ music: state.music }),
}));
vi.mock('~/components/MusicPlayer/MusicPlayerSlot', () => ({
  MusicPlayerSlot: ({ enabled }: { enabled: boolean }) =>
    createElement('i', { 'data-music-slot': String(enabled) }),
}));
vi.mock('~/components/ResourceLoad/ResourceResidency', async (importOriginal) => ({
  ...(await importOriginal<typeof ResourceResidency>()),
  useRefreshResidencyOnOpen: vi.fn(),
}));

const HIDDEN = '[content-visibility:hidden]';
const render = () =>
  renderToString(createElement(BaseLayout, null, createElement('p', null, 'page')));

describe('BaseLayout hides the page under a full-screen generator', () => {
  beforeEach(() => {
    Object.assign(state, {
      pathname: '/models',
      opened: true,
      fullScreen: true,
      user: {},
      onboardingSteps: [],
    });
  });

  it('hides it while the generator covers it', () => {
    expect(render()).toContain(HIDDEN);
  });

  it('shows it when the generator sits beside it', () => {
    state.fullScreen = false;
    expect(render()).not.toContain(HIDDEN);
  });

  it('shows it when the generator is closed', () => {
    state.opened = false;
    expect(render()).not.toContain(HIDDEN);
  });

  it('shows it on /generate, where the page IS the generator', () => {
    state.pathname = '/generate';
    expect(render()).not.toContain(HIDDEN);
  });

  it('shows the ban screen, which gets no generator', () => {
    state.user = { bannedAt: new Date() };
    expect(render()).not.toContain(HIDDEN);
  });

  it('shows onboarding, which gets no generator', () => {
    state.onboardingSteps = ['tos'];
    expect(render()).not.toContain(HIDDEN);
  });
});

describe('BaseLayout places the music player', () => {
  beforeEach(() => {
    Object.assign(state, {
      pathname: '/models',
      opened: false,
      fullScreen: false,
      user: {},
      onboardingSteps: [],
      music: true,
    });
  });

  it('switches it on with the music flag, after the page, so it is the last row', () => {
    const html = render();
    expect(html).toContain('data-music-slot="true"');
    expect(html.indexOf('data-music-slot')).toBeGreaterThan(html.indexOf('<p>page</p>'));
  });

  it('keeps it off without the flag', () => {
    state.music = false;
    expect(render()).toContain('data-music-slot="false"');
  });

  it('keeps it off for a banned user and during onboarding, like the generator', () => {
    state.user = { bannedAt: new Date() };
    expect(render()).toContain('data-music-slot="false"');
    state.user = {};
    state.onboardingSteps = ['tos'];
    expect(render()).toContain('data-music-slot="false"');
  });
});
