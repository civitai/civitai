// @vitest-environment happy-dom
import * as React from 'react';
import { createRoot } from 'react-dom/client';
import type { act as actType } from 'react-dom/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  BIRTHDAY_2026_ENDS_AT,
  BIRTHDAY_2026_EVENT,
  BIRTHDAY_2026_PREVIEW_FROM,
} from '~/shared/constants/birthday2026.constants';
import type * as TrpcModule from '~/utils/trpc';

/**
 * The "Add a hat" item in a content menu shows while the server says this viewer may wear the
 * event's hats. Justin and Ellie, 2026-10-09: hats are kept after the event, so the item stays once
 * the event has ended; if you are about to hide it again at the end, that reverses a product
 * decision.
 */

const act = (React as unknown as { act: typeof actType }).act;
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let access: string | undefined;
let askedWith: { enabled?: unknown } | undefined;
vi.mock('~/utils/trpc', async (importOriginal) => {
  const { makeTrpcProxy } = await import('../../../../test/trpcProxyStub');
  return {
    ...(await importOriginal<typeof TrpcModule>()),
    trpc: makeTrpcProxy({
      'event.getAccess': {
        useQuery: (_input: unknown, opts?: { enabled?: unknown }) => {
          askedWith = opts;
          return { data: opts?.enabled ? access : undefined };
        },
      },
    }),
  };
});

const { usePlayableEventDecoration } = await import(
  '~/components/Decorations/usePlayableEventDecoration'
);

let root: ReturnType<typeof createRoot> | undefined;
afterEach(() => {
  act(() => root?.unmount());
  vi.useRealTimers();
});
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  askedWith = undefined;
});

function eventShown(at: Date) {
  vi.setSystemTime(at);
  let result: ReturnType<typeof usePlayableEventDecoration>;
  function Probe() {
    result = usePlayableEventDecoration('Image');
    return null;
  }
  root = createRoot(document.createElement('div'));
  act(() => root!.render(React.createElement(Probe)));
  return result?.event;
}

const AFTER_END = new Date(BIRTHDAY_2026_ENDS_AT.getTime() + 60 * 24 * 60 * 60 * 1000);
const DURING_PREVIEW = new Date(BIRTHDAY_2026_PREVIEW_FROM.getTime() + 60 * 60 * 1000);

describe('usePlayableEventDecoration', () => {
  it.each(['preview', 'open', 'ended'])('offers the hat when the server says %s', (level) => {
    access = level;
    expect(eventShown(level === 'ended' ? AFTER_END : DURING_PREVIEW)).toBe(BIRTHDAY_2026_EVENT);
  });

  it.each([['closed'], [undefined]])('offers nothing when the server says %s', (level) => {
    access = level;
    expect(eventShown(AFTER_END)).toBeUndefined();
  });

  it('asks the server nothing before the hats are released', () => {
    access = 'open';
    expect(eventShown(new Date(BIRTHDAY_2026_PREVIEW_FROM.getTime() - 1))).toBeUndefined();
    expect(askedWith?.enabled).toBe(false);
  });
});
