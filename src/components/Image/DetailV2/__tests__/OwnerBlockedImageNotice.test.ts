// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as React from 'react';
import type { act as actType } from 'react-dom/test-utils';
import { createRoot, type Root } from 'react-dom/client';
import { MantineProvider } from '@mantine/core';
import type * as TrpcModule from '~/utils/trpc';

/** What the owner of a moderator-blocked image is told, by what the server says of the appeal. */

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

const REFUSED = "This image has been removed from public view and can't be appealed.";

let container: HTMLDivElement;
let root: Root;

function render() {
  act(() => {
    root.render(
      React.createElement(
        MantineProvider,
        null,
        React.createElement(
          'div',
          { 'data-notice': '' },
          React.createElement(OwnerBlockedImageNotice, { imageId: 1 })
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
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe('OwnerBlockedImageNotice', () => {
  it('shows the blocked banner and the appeal link when the appeal would be accepted', () => {
    state.appealState = { data: { canAppeal: true }, isError: false };
    const text = render();
    expect(text).toContain('Blocked by moderators');
    expect(text).toContain('appeal this removal');
    expect(text).not.toContain(REFUSED);
  });

  it('shows only the neutral line, with no banner or link, when the appeal would be refused', () => {
    state.appealState = { data: { canAppeal: false }, isError: false };
    expect(render()).toBe(REFUSED);
    expect(notice().querySelector('a, button')).toBeNull();
  });

  it('shows the neutral line when the check fails', () => {
    state.appealState = { data: undefined, isError: true };
    expect(render()).toBe(REFUSED);
    expect(notice().querySelector('a, button')).toBeNull();
  });

  it('shows nothing while the check loads', () => {
    state.appealState = { data: undefined, isError: false };
    expect(render()).toBe('');
  });
});
