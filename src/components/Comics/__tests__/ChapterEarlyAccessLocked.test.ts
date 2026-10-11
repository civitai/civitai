// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as React from 'react';
import type { act as actType } from 'react-dom/test-utils';
import { createRoot, type Root } from 'react-dom/client';
import { MantineProvider } from '@mantine/core';
import type * as FeatureFlagsProvider from '~/providers/FeatureFlagsProvider';
import type * as CurrentUser from '~/hooks/useCurrentUser';
import { ChapterEarlyAccessLocked } from '~/components/Comics/ChapterEarlyAccessLocked';
import { CREATOR_JOURNEY_HREF } from '~/shared/constants/creator-journey.constants';
import { chapterEarlyAccessLockedMessage } from '~/server/utils/early-access-helpers';

const state = vi.hoisted(() => ({ features: { creatorJourney: true } }));
vi.mock('~/providers/FeatureFlagsProvider', async (importOriginal) => ({
  ...(await importOriginal<typeof FeatureFlagsProvider>()),
  useFeatureFlags: () => state.features,
}));
vi.mock('~/hooks/useCurrentUser', async (importOriginal) => ({
  ...(await importOriginal<typeof CurrentUser>()),
  useCurrentUser: () => ({ id: 1, meta: { scores: { total: 1200 } } }),
}));

const act = (React as unknown as { act: typeof actType }).act;
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | undefined;
let container: HTMLDivElement | undefined;

function render() {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() =>
    root?.render(
      React.createElement(MantineProvider, null, React.createElement(ChapterEarlyAccessLocked))
    )
  );
  const p = container.querySelector('p') as HTMLParagraphElement;
  return {
    text: p.textContent ?? '',
    hrefs: [...p.querySelectorAll('a')].map((a) => a.getAttribute('href')),
  };
}

beforeEach(() => {
  state.features = { creatorJourney: true };
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
});

describe('ChapterEarlyAccessLocked', () => {
  it('names the score and links to the journey while Creator Journey is on', () => {
    const { text, hrefs } = render();
    expect(text).toBe(`${chapterEarlyAccessLockedMessage(1200)} See your journey`);
    expect(hrefs).toEqual([CREATOR_JOURNEY_HREF]);
  });

  it('keeps the message and drops the link while Creator Journey is off', () => {
    state.features = { creatorJourney: false };
    const { text, hrefs } = render();
    expect(text).toBe(chapterEarlyAccessLockedMessage(1200));
    expect(hrefs).toEqual([]);
  });
});
