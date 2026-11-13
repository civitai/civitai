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

// Detected by the refusal's limit id, so a daily limit changed in config is still linked.
const dailyRefusal = "You've reached today's limit of 25 posts.";
const clampRefusal = 'New accounts have a lower hourly posting limit on their first day.';
const retryAt = '2030-02-03T16:12:00.000Z';
const refusal = (message: string, id: string) => ({
  message,
  data: { rateLimit: { id, retryAfterSeconds: 900, retryAt } },
});
const daily = refusal(dailyRefusal, 'posts.daily');
const clamp = refusal(clampRefusal, 'posts.hourly');

beforeEach(() => {
  showErrorNotification.mockClear();
  features.creatorJourney = true;
});

describe('showCreatePostError', () => {
  it('links the daily limit to the journey and keeps the notification open', () => {
    showCreatePostError(daily, { journey: true });

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
    expect(reason.textContent).toMatch(
      /^You've reached today's limit of 25 posts\. Try again at .+\. See your journey$/
    );
    expect([...reason.querySelectorAll('a')].map((a) => a.getAttribute('href'))).toEqual([
      CREATOR_JOURNEY_HREF,
    ]);
    act(() => root.unmount());
  });

  it('links any posts.daily refusal, and no other limit worded like one', () => {
    showCreatePostError(refusal('Posting paused for today.', 'posts.daily'), { journey: true });
    expect(showErrorNotification.mock.calls[0][0].autoClose).toBe(false);

    showCreatePostError(refusal(dailyRefusal, 'posts.hourly'), { journey: true });
    expect(showErrorNotification.mock.calls[1][0].reason).toBeUndefined();
  });

  it('leaves every other error as it was', () => {
    showCreatePostError(clamp, {
      journey: true,
      title: 'Failed to create review post',
    });

    const [args] = showErrorNotification.mock.calls[0];
    expect(args).toMatchObject({ title: 'Failed to create review post' });
    expect(args.autoClose).toBeUndefined();
    expect(args.reason).toBeUndefined();
    expect(args.error.message).toBe(clampRefusal);
  });

  it('adds the retry time from the refusal meta to the linked daily limit', () => {
    showCreatePostError(daily, { journey: true });

    const [args] = showErrorNotification.mock.calls[0];
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
    const text = el.querySelector('[data-reason]')?.textContent ?? '';
    expect(text.startsWith(`${dailyRefusal} Try again at `)).toBe(true);
    expect(text).toMatch(/Try again at .+\. See your journey$/);
    act(() => root.unmount());
  });

  it('hands the refusal meta on to the toast when the limit is not linked', () => {
    showCreatePostError(clamp, { journey: true });

    expect(showErrorNotification.mock.calls[0][0].error).toBe(clamp);
  });

  it('does not link the daily limit while Creator Journey is off', () => {
    showCreatePostError(daily, { journey: false });

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
    show?.(daily, 'Failed to create review post');
    act(() => root.unmount());

    expect(showErrorNotification.mock.calls[0][0].autoClose).toBe(autoClose);
    expect(showErrorNotification.mock.calls[0][0].title).toBe('Failed to create review post');
  });
});
