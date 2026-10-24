// @vitest-environment happy-dom
import { describe, expect, it, vi, beforeEach } from 'vitest';
import * as React from 'react';
import { isValidElement } from 'react';
import type { act as actType } from 'react-dom/test-utils';
import { createRoot } from 'react-dom/client';
import { MantineProvider } from '@mantine/core';
import { CREATOR_JOURNEY_HREF } from '~/shared/constants/creator-journey.constants';
import type * as FeatureFlagsProvider from '~/providers/FeatureFlagsProvider';
import type * as Notifications from '~/utils/notifications';
import { showCreatePostError, useShowCreatePostError } from '~/components/Post/showCreatePostError';
import { CacheTTL } from '~/server/common/constants';
import { postRateLimits } from '~/server/schema/post.schema';

const showErrorNotification = vi.hoisted(() => vi.fn());
const features = vi.hoisted(() => ({ creatorJourney: true }));

vi.mock('~/providers/FeatureFlagsProvider', async (importOriginal) => ({
  ...(await importOriginal<typeof FeatureFlagsProvider>()),
  useFeatureFlags: () => features,
}));

vi.mock('~/utils/notifications', async (importOriginal) => ({
  ...(await importOriginal<typeof Notifications>()),
  showErrorNotification,
}));

const dailyRefusal = postRateLimits.find((rule) => rule.period === CacheTTL.day)?.errorMessage;
const clampRefusal = postRateLimits.find((rule) => rule.period !== CacheTTL.day)?.errorMessage;

beforeEach(() => {
  showErrorNotification.mockClear();
  features.creatorJourney = true;
});

describe('showCreatePostError', () => {
  it('links the daily limit to the journey and keeps the notification open', () => {
    expect(dailyRefusal).toBeDefined();
    showCreatePostError(dailyRefusal as string, { journey: true });

    const [args] = showErrorNotification.mock.calls[0];
    expect(args.title).toBe('Failed to create post');
    expect(args.autoClose).toBe(false);
    expect(isValidElement(args.reason)).toBe(true);
    const el = document.createElement('div');
    const root = createRoot(el);
    const act = (React as unknown as { act: typeof actType }).act;
    act(() =>
      root.render(
        React.createElement(
          MantineProvider,
          null,
          React.createElement('span', { 'data-reason': '' }, args.reason)
        )
      )
    );
    const reason = el.querySelector('[data-reason]') as HTMLElement;
    expect(reason.textContent).toBe(`${dailyRefusal} See your journey`);
    expect([...reason.querySelectorAll('a')].map((a) => a.getAttribute('href'))).toEqual([
      CREATOR_JOURNEY_HREF,
    ]);
    act(() => root.unmount());
  });

  it('leaves every other error as it was', () => {
    expect(clampRefusal).toBeDefined();
    showCreatePostError(clampRefusal as string, {
      journey: true,
      title: 'Failed to create review post',
    });

    const [args] = showErrorNotification.mock.calls[0];
    expect(args).toMatchObject({ title: 'Failed to create review post' });
    expect(args.autoClose).toBeUndefined();
    expect(args.reason).toBeUndefined();
    expect(args.error.message).toBe(clampRefusal);
  });

  it('does not link the daily limit while Creator Journey is off', () => {
    showCreatePostError(dailyRefusal as string, { journey: false });

    const [args] = showErrorNotification.mock.calls[0];
    expect(args.reason).toBeUndefined();
    expect(args.autoClose).toBeUndefined();
    expect(args.error.message).toBe(dailyRefusal);
  });

  it.each([
    [true, false],
    [false, undefined],
  ])('the hook reads Creator Journey for the viewer (on: %s)', (on, autoClose) => {
    features.creatorJourney = on;
    const act = (React as unknown as { act: typeof actType }).act;
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    let show: ReturnType<typeof useShowCreatePostError> | undefined;
    function Probe() {
      show = useShowCreatePostError();
      return null;
    }
    const root = createRoot(document.createElement('div'));
    act(() => root.render(React.createElement(Probe)));
    show?.(dailyRefusal as string, 'Failed to create review post');
    act(() => root.unmount());

    expect(showErrorNotification.mock.calls[0][0].autoClose).toBe(autoClose);
    expect(showErrorNotification.mock.calls[0][0].title).toBe('Failed to create review post');
  });
});
