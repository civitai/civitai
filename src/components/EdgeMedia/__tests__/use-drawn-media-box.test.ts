// @vitest-environment happy-dom
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as React from 'react';
import { createRoot } from 'react-dom/client';
import type { Root } from 'react-dom/client';
import type { act as actType } from 'react-dom/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MEDIA_OVERLAY_ATTR, useDrawnMediaBox } from '~/components/EdgeMedia/useDrawnMediaBox';

/**
 * Several overlays sit on one picture (the image detail's hat and its stickers), each measuring the
 * media through useDrawnMediaBox from a host placed after it. To whoever changes this: a host must
 * look past the other overlay hosts (MEDIA_OVERLAY_ATTR) to the media, or it measures that host's
 * border box, which fills the whole slot, and its overlay lands on the slot's corner instead of the
 * letterboxed picture's. Every overlay host on that media carries the attribute.
 */

const act = (React as unknown as { act: typeof actType }).act;
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const observed: Element[] = [];
class FakeResizeObserver {
  observe(target: Element) {
    observed.push(target);
  }
  disconnect = vi.fn();
  unobserve = vi.fn();
}

function Overlay() {
  const { hostRef } = useDrawnMediaBox(true);
  return React.createElement('div', { ref: hostRef, 'data-testid': 'host' });
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  observed.length = 0;
  vi.stubGlobal('ResizeObserver', FakeResizeObserver);
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

async function render(...between: React.ReactElement[]) {
  await act(async () => {
    root.render(
      React.createElement(
        'div',
        { style: { position: 'relative' } },
        React.createElement('img', { 'data-testid': 'media', alt: '' }),
        ...between,
        React.createElement(Overlay)
      )
    );
  });
}

const observedIds = () => observed.map((el) => el.getAttribute('data-testid'));

describe('useDrawnMediaBox finds the media past other overlays', () => {
  it('directly after the media', async () => {
    await render();
    expect(observedIds()).toEqual(['host', 'media']);
  });

  it('after other overlay hosts on the same media', async () => {
    await render(
      React.createElement('div', { key: 'a', [MEDIA_OVERLAY_ATTR]: '', 'data-testid': 'hat-host' }),
      React.createElement('div', { key: 'b', [MEDIA_OVERLAY_ATTR]: '', 'data-testid': 'other' })
    );
    expect(observedIds()).toEqual(['host', 'media']);
  });

  it('every overlay host on the image detail media carries the attribute', () => {
    for (const file of [
      'src/components/Sticker/ImageStickerOverlay.tsx',
      'src/components/Cosmetics/EventDecoration/DrawnMediaHat.tsx',
    ]) {
      const src = readFileSync(join(process.cwd(), file), 'utf8');
      expect(src, file).toMatch(/ref=\{hostRef\}\s*\{\.\.\.\{ \[MEDIA_OVERLAY_ATTR\]: '' \}\}/);
    }
  });
});
