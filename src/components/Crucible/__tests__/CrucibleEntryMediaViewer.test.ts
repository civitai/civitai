// @vitest-environment happy-dom
import { MantineProvider } from '@mantine/core';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CrucibleEntryMedia } from '~/components/Crucible/CrucibleEntryMediaViewer';

const mediaProps = vi.hoisted(() => [] as Array<Record<string, unknown>>);
vi.mock('~/components/EdgeMedia/EdgeMedia', () => ({
  EdgeMedia2: (props: { src: string; type: string }) => {
    mediaProps.push(props);
    return createElement(props.type === 'video' ? 'video' : 'img', { 'data-src': props.src });
  },
}));

const { CrucibleEntryMediaViewer } = await import('~/components/Crucible/CrucibleEntryMediaViewer');

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const item = (entryId: number, type: 'image' | 'video' = 'image'): CrucibleEntryMedia => ({
  entryId,
  url: `media-${entryId}`,
  name: null,
  type,
  metadata: null,
});
const media = [item(1), item(2, 'video'), item(3)];

let container: HTMLDivElement;
let root: Root;
const onIndexChange = vi.fn();
const onClose = vi.fn();

beforeEach(() => {
  onIndexChange.mockReset();
  onClose.mockReset();
  mediaProps.length = 0;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

const renderViewer = (index: number | null, hasMore = false) =>
  act(() =>
    root.render(
      createElement(
        MantineProvider,
        // No transitions or portals, so the modal renders synchronously.
        { env: 'test' },
        createElement(CrucibleEntryMediaViewer, { media, index, hasMore, onIndexChange, onClose })
      )
    )
  );

const shown = () => {
  const viewer = document.querySelector('[data-testid="crucible-entry-media-viewer"]');
  if (!viewer) return null;
  return {
    media: viewer.querySelector('[data-src]')?.getAttribute('data-src'),
    position: viewer.querySelector('p')?.textContent,
  };
};
const button = (label: string) => {
  const found = document.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
  if (!found) throw new Error(`no ${label} button`);
  return found;
};
const press = (label: string) => act(() => button(label).click());
const key = (name: 'ArrowLeft' | 'ArrowRight', target: Element = document.documentElement) =>
  act(() => {
    target.dispatchEvent(new KeyboardEvent('keydown', { key: name, bubbles: true }));
  });

describe('CrucibleEntryMediaViewer', () => {
  it('renders nothing while closed', () => {
    renderViewer(null);

    expect(shown()).toBeNull();
  });

  it('stops at the first entry', () => {
    renderViewer(0);

    expect(shown()).toEqual({ media: 'media-1', position: '1 / 3' });
    expect(button('Previous entry').disabled).toBe(true);
    press('Previous entry');
    key('ArrowLeft');
    expect(onIndexChange).not.toHaveBeenCalled();
  });

  it('stops at the last entry', () => {
    renderViewer(2);

    expect(shown()).toEqual({ media: 'media-3', position: '3 / 3' });
    expect(button('Next entry').disabled).toBe(true);
    press('Next entry');
    key('ArrowRight');
    expect(onIndexChange).not.toHaveBeenCalled();
  });

  it('steps forward and back with the buttons and the arrow keys', () => {
    renderViewer(1);

    press('Next entry');
    press('Previous entry');
    key('ArrowRight');
    key('ArrowLeft');
    expect(onIndexChange.mock.calls).toEqual([[2], [0], [2], [0]]);
  });

  it("leaves the arrow keys to a focused video's own controls", () => {
    renderViewer(1);
    const video = document.querySelector('video');
    if (!video) throw new Error('video did not render');

    key('ArrowRight', video);
    expect(onIndexChange).not.toHaveBeenCalled();
  });

  it('autoplays a video, since nothing else starts it inside the modal', () => {
    renderViewer(1);

    expect(mediaProps.at(-1)).toMatchObject({
      src: 'media-2',
      videoProps: expect.objectContaining({ autoPlay: true }),
    });
  });

  it('says when more entries exist than it holds', () => {
    renderViewer(2, true);

    expect(shown()?.position).toBe('3 / 3+');
  });

  it('closes', () => {
    renderViewer(0);

    press('Close entry viewer');
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
