// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as React from 'react';
import type { act as actType } from 'react-dom/test-utils';
import { createRoot, type Root } from 'react-dom/client';
import { MantineProvider } from '@mantine/core';
import type * as TrpcModule from '~/utils/trpc';

/** The owner's notice names which image it is about, from the row, the same way for every block. */

const act = (React as unknown as { act: typeof actType }).act;
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const state = vi.hoisted(() => ({
  appealState: { data: undefined, isError: false } as {
    data: { canAppeal: boolean } | undefined;
    isError: boolean;
  },
}));

vi.mock('~/utils/trpc', async (importOriginal) => {
  const { makeTrpcProxy } = await import('../../../../../test/trpcProxyStub');
  return {
    ...(await importOriginal<typeof TrpcModule>()),
    trpc: makeTrpcProxy({
      'image.getAppealState': { useQuery: () => state.appealState },
      'report.getLatestAppeal': { useQuery: () => ({ data: null, isLoading: false }) },
    }),
  };
});

import { OwnerBlockedImageNotice } from '~/components/Image/DetailV2/OwnerBlockedImageNotice';

type NoticeImage = React.ComponentProps<typeof OwnerBlockedImageNotice>['image'];
const ROW = { id: 4321, createdAt: new Date('2026-03-14T12:00:00Z'), postId: 987 };

let container: HTMLDivElement;
let root: Root;

function render(image: NoticeImage) {
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

const notice = () => container.querySelector('[data-notice]') as HTMLElement;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe('OwnerBlockedImageNotice names the image', () => {
  it.each([
    ['the appealable banner', { canAppeal: true }],
    ['the neutral notice', { canAppeal: false }],
  ])('%s carries the upload date and links the post', (_, data) => {
    state.appealState = { data, isError: false };
    const el = render({ ...ROW, blockedFor: 'moderated', needsReview: null });
    expect(el.textContent).toContain('Uploaded Mar 14, 2026');
    expect(el.querySelector('a[href="/posts/987"]')?.textContent).toBe('post #987');
  });

  it('reads the same for every block it cannot appeal, with the identity present', () => {
    state.appealState = { data: { canAppeal: false }, isError: false };
    const refused = render({ ...ROW, blockedFor: 'moderated' }).innerHTML;
    expect(refused).toContain('post #987');
    for (const reason of [
      { blockedFor: 'tos' },
      { blockedFor: 'CSAM' },
      { blockedFor: 'AiNotVerified' },
      { blockedFor: 'moderated', needsReview: 'appeal' },
      { blockedFor: 'moderated', needsReview: 'csam' },
    ]) {
      expect({ reason, html: render({ ...ROW, ...reason }).innerHTML }).toEqual({
        reason,
        html: refused,
      });
    }
  });

  it('adds nothing for a row with neither field', () => {
    state.appealState = { data: { canAppeal: false }, isError: false };
    const el = render({ id: 4321, blockedFor: 'tos' });
    expect(el.textContent).not.toContain('Uploaded');
    expect(el.querySelector('a')).toBeNull();
  });
});
