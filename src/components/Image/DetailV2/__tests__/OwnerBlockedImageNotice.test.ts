// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as React from 'react';
import type { act as actType } from 'react-dom/test-utils';
import { createRoot, type Root } from 'react-dom/client';
import { MantineProvider } from '@mantine/core';
import type * as TrpcModule from '~/utils/trpc';

/** What the owner of a blocked image is told, by the block and what the server says of the appeal. */

const act = (React as unknown as { act: typeof actType }).act;
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const state = vi.hoisted(() => ({
  appealState: { data: undefined, isError: false } as {
    data: { canAppeal: boolean } | undefined;
    isError: boolean;
  },
  asked: [] as unknown[],
}));

vi.mock('~/utils/trpc', async (importOriginal) => {
  const { makeTrpcProxy } = await import('../../../../../test/trpcProxyStub');
  return {
    ...(await importOriginal<typeof TrpcModule>()),
    trpc: makeTrpcProxy({
      'image.getAppealState': {
        useQuery: (input: unknown, opts?: { enabled?: boolean }) => {
          // A disabled query still returns what the cache holds, so the answer is returned anyway.
          if (opts?.enabled !== false) state.asked.push(input);
          return state.appealState;
        },
      },
      'report.getLatestAppeal': { useQuery: () => ({ data: null, isLoading: false }) },
    }),
  };
});

import {
  IMAGE_REMOVED_TEXT,
  IMAGE_REMOVED_TITLE,
  OwnerBlockedImageNotice,
} from '~/components/Image/DetailV2/OwnerBlockedImageNotice';

type ImageState = { blockedFor?: string | null; needsReview?: string | null };
const MODERATED: ImageState = { blockedFor: 'moderated', needsReview: null };

let container: HTMLDivElement;
let root: Root;

function render(image: ImageState = MODERATED) {
  act(() => {
    root.render(
      React.createElement(
        MantineProvider,
        null,
        React.createElement(
          'div',
          { 'data-notice': '' },
          React.createElement(OwnerBlockedImageNotice, { image: { id: 4321, ...image } })
        )
      )
    );
  });
  return notice().textContent ?? '';
}

// MantineProvider writes its own <style> into the container, so read only the notice's slot.
const notice = () => container.querySelector('[data-notice]') as HTMLElement;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  state.asked = [];
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe('OwnerBlockedImageNotice', () => {
  it('asks about the image it is shown for', () => {
    state.appealState = { data: undefined, isError: false };
    render();
    expect(state.asked).toEqual([{ id: 4321 }]);
  });

  it('shows the blocked banner and the appeal link when the appeal would be accepted', () => {
    state.appealState = { data: { canAppeal: true }, isError: false };
    const text = render();
    expect(text).toContain('Blocked by moderators');
    expect(text).toContain('appeal this removal');
    expect(text).not.toContain(IMAGE_REMOVED_TITLE);
  });

  it('shows the same neutral notice, with no link, for every block the owner cannot appeal', () => {
    // A moderator block the server refuses must not read differently from any other block.
    state.appealState = { data: { canAppeal: false }, isError: false };
    expect(render()).toBe(IMAGE_REMOVED_TITLE + IMAGE_REMOVED_TEXT);
    const refused = notice().innerHTML;
    expect(notice().querySelector('a, button')).toBeNull();

    // These never ask the server, and a cached yes must not reach them.
    state.appealState = { data: { canAppeal: true }, isError: false };
    for (const image of [
      { blockedFor: 'tos' },
      { blockedFor: 'CSAM' },
      { blockedFor: 'AiNotVerified' },
      { blockedFor: 'moderated', needsReview: 'appeal' },
      { blockedFor: 'moderated', needsReview: 'csam' },
    ]) {
      render(image);
      expect({ image, html: notice().innerHTML }).toEqual({ image, html: refused });
    }
    expect(state.asked).toEqual([{ id: 4321 }]);
  });

  it('shows the neutral notice when the check fails', () => {
    state.appealState = { data: undefined, isError: true };
    expect(render()).toBe(IMAGE_REMOVED_TITLE + IMAGE_REMOVED_TEXT);
    expect(notice().querySelector('a, button')).toBeNull();
  });

  it('shows nothing while the check loads, or on an image that is not blocked', () => {
    state.appealState = { data: undefined, isError: false };
    expect(render()).toBe('');
    state.appealState = { data: { canAppeal: false }, isError: false };
    expect(render({ blockedFor: null, needsReview: 'minor' })).toBe('');
  });
});
