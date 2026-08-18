// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as React from 'react';
import type { act as actType } from 'react-dom/test-utils';
import { createRoot } from 'react-dom/client';
import type { BuzzSpendType } from '~/shared/constants/buzz.constants';

const act = (React as unknown as { act: typeof actType }).act;

const settings = { value: {} as { hideBlueBuzzInHeader?: boolean } };
const accountTypesSeen: Array<BuzzSpendType[] | undefined> = [];

vi.mock('~/components/UserSettings/hooks', () => ({
  useCurrentUserSettings: () => settings.value,
}));

// `useAvailableBuzz` is left REAL — it holds the domain rule under test. Mocking it would make the
// on-state assert the shape of the mock.
vi.mock('~/providers/FeatureFlagsProvider', () => ({
  useFeatureFlags: () => ({ isGreen: false }),
}));

vi.mock('~/components/User/UserBuzz', () => ({
  UserBuzz: ({ accountTypes }: { accountTypes?: BuzzSpendType[] }) => {
    accountTypesSeen.push(accountTypes);
    return null;
  },
}));

import { HeaderUserBuzz } from '~/components/AppLayout/AppHeader/HeaderUserBuzz';

function render() {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const container = document.createElement('div');
  document.body.appendChild(container);
  act(() => {
    createRoot(container).render(React.createElement(HeaderUserBuzz));
  });
}

describe('HeaderUserBuzz', () => {
  beforeEach(() => {
    accountTypesSeen.length = 0;
    settings.value = {};
  });

  it('narrows the header to the domain type when blue is hidden', () => {
    settings.value = { hideBlueBuzzInHeader: true };
    render();

    expect(accountTypesSeen).toEqual([['yellow']]);
  });

  it('leaves the blended total alone when the setting is off', () => {
    render();

    // Undefined rather than a list: UserBuzz falls through to its own default, which is what the
    // header showed before this setting existed.
    expect(accountTypesSeen).toEqual([undefined]);
  });

  it('leaves the blended total alone for a user who never touched the setting', () => {
    settings.value = { hideBlueBuzzInHeader: false };
    render();

    expect(accountTypesSeen).toEqual([undefined]);
  });
});
