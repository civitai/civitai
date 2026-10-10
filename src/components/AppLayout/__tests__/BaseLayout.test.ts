import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as FullScreen from '~/components/ImageGeneration/useGenerationPanelFullScreen';
import type * as OnboardingUtils from '~/components/Onboarding/onboarding.utils';
import type * as ResourceResidency from '~/components/ResourceLoad/ResourceResidency';
import type * as CurrentUser from '~/hooks/useCurrentUser';
import type * as GenerationPanelStore from '~/store/generation-panel.store';
import { BaseLayout } from '~/components/AppLayout/BaseLayout';

const state = vi.hoisted(() => ({
  pathname: '/models',
  opened: true,
  fullScreen: true as boolean | undefined,
  user: {} as Record<string, unknown> | undefined,
  onboardingSteps: [] as string[],
}));

vi.mock('next/router', () => ({ useRouter: () => ({ pathname: state.pathname }) }));
vi.mock('next/dynamic', () => ({ default: () => () => null }));
vi.mock('~/components/Meta/MetaPWA', () => ({ MetaPWA: () => null }));
vi.mock('~/components/Notifications/PushRegistrationManager', () => ({
  PushRegistrationManager: () => null,
}));
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
