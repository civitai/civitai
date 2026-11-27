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

const ROW = { id: 4321, createdAt: new Date('2026-03-14T12:00:00Z') };
type NoticeImage = React.ComponentProps<typeof OwnerBlockedImageNotice>['image'];

/** Renders `image` whole, unlike `render`, which fixes its id and has no upload date. */
function renderRow(image: NoticeImage) {
  act(() => {
    root.render(
      React.createElement(
        MantineProvider,
        null,
        React.createElement(
          'div',
          { 'data-notice': '' },
          React.createElement(OwnerBlockedImageNotice, { image })
        )
      )
    );
  });
  return notice();
}

describe('OwnerBlockedImageNotice names the image', () => {
  it.each([
    ['the appealable banner', { canAppeal: true }],
    ['the neutral notice', { canAppeal: false }],
  ])('%s carries the upload date', (_, data) => {
    state.appealState = { data, isError: false };
    const el = renderRow({ ...ROW, blockedFor: 'moderated', needsReview: null });
    expect(el.textContent).toContain('Uploaded Mar 14, 2026');
  });

  it('reads the same for every block it cannot appeal, with the date present', () => {
    state.appealState = { data: { canAppeal: false }, isError: false };
    const refused = renderRow({ ...ROW, blockedFor: 'moderated' }).innerHTML;
    expect(refused).toContain('Uploaded Mar 14, 2026');
    for (const reason of [
      { blockedFor: 'tos' },
      { blockedFor: 'CSAM' },
      { blockedFor: 'AiNotVerified' },
      { blockedFor: 'moderated', needsReview: 'appeal' },
      { blockedFor: 'moderated', needsReview: 'csam' },
    ]) {
      expect({ reason, html: renderRow({ ...ROW, ...reason }).innerHTML }).toEqual({
        reason,
        html: refused,
      });
    }
  });

  it('reads the same whether the image is still in a post or not', () => {
    // The page hands the notice the whole row, `postId` included.
    const inPost = { ...ROW, blockedFor: 'tos', postId: 987 };
    const noPost = { ...ROW, blockedFor: 'tos', postId: null };
    for (const data of [{ canAppeal: false }, { canAppeal: true }]) {
      state.appealState = { data, isError: false };
      const html = renderRow(inPost).innerHTML;
      expect(renderRow(noPost).innerHTML).toBe(html);
      expect(notice().querySelector('a[href^="/posts/"]')).toBeNull();
    }
  });

  it('adds nothing for a row with no upload date', () => {
    state.appealState = { data: { canAppeal: false }, isError: false };
    expect(renderRow({ id: 4321, blockedFor: 'tos' }).textContent).not.toContain('Uploaded');
  });
});
