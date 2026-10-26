import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockEnv = vi.hoisted(() => ({
  NEXT_PUBLIC_CIVITAI_LINK: undefined as string | undefined,
  NEXT_PUBLIC_LOCAL_TRACKER_ENABLED: undefined as string | undefined,
}));
vi.mock('~/env/client', () => ({ env: mockEnv }));
vi.mock('~/env/other', () => ({ isProd: true, isDev: false }));
vi.mock('../FeatureFlagsProvider', () => ({
  useFeatureFlags: () => ({ isGreen: true, isBlue: false, isRed: false }),
}));
vi.mock('~/components/Consent/consent.context', () => ({
  useThirdPartyConsent: () => ({ allowed: true }),
}));
vi.mock('@next/third-parties/google', () => ({ GoogleAnalytics: () => null }));

import { GoogleAnalytics } from '../GoogleAnalytics';

// The component's hooks are mocked, so calling it directly returns what it would render.
describe('GoogleAnalytics on a local origin', () => {
  beforeEach(() => {
    mockEnv.NEXT_PUBLIC_LOCAL_TRACKER_ENABLED = undefined;
  });

  it('renders nothing on a local origin in a production build', () => {
    mockEnv.NEXT_PUBLIC_CIVITAI_LINK = 'http://localhost:3000';
    expect(GoogleAnalytics()).toBeNull();
  });

  it('renders again once the local opt-in is set', () => {
    mockEnv.NEXT_PUBLIC_CIVITAI_LINK = 'http://localhost:3000';
    mockEnv.NEXT_PUBLIC_LOCAL_TRACKER_ENABLED = 'true';
    expect(GoogleAnalytics()).not.toBeNull();
  });

  // Positive control: a deployed origin keeps its analytics.
  it('renders on a deployed origin', () => {
    mockEnv.NEXT_PUBLIC_CIVITAI_LINK = 'https://civitai.com';
    expect(GoogleAnalytics()).not.toBeNull();
  });
});
