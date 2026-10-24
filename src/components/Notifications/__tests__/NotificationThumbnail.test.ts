// @vitest-environment happy-dom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The hook suite next door tests the VISIBILITY filter — whether the viewer may
 * see the image at all. This tests the other half, which no hook test can
 * reach: whether an image they may see is rendered uncovered. Delete the guard
 * from this component and the hook suite stays green, which is why this file
 * exists.
 */
const state = vi.hoisted(() => ({ blurLevels: 0 }));

vi.mock('~/components/BrowsingLevel/BrowsingLevelProvider', () => ({
  useBrowsingLevelContext: () => ({ blurLevels: state.blurLevels }),
}));
vi.mock('~/hooks/useCurrentUser', () => ({
  // Never the owner, never a moderator: both bypass the cover for an unrated
  // image, so a viewer who is either makes the covered cases vacuous.
  useCurrentUser: () => ({ id: 999, isModerator: false }),
}));
// Stands in for the media element itself. What is under test is WHETHER it is
// rendered, not what it renders.
vi.mock('~/components/EdgeMedia/EdgeMedia', () => ({
  EdgeMedia: () => createElement('img', { 'data-testid': 'thumbnail' }),
}));

import { NotificationThumbnail } from '~/components/Notifications/NotificationThumbnail';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const MATURE_LEVEL = 4;

const render = (image: Record<string, unknown>) => {
  const container = document.createElement('div');
  act(() => {
    createRoot(container).render(createElement(NotificationThumbnail, { image: image as never }));
  });

  return container;
};

const givenImage = (overrides: Record<string, unknown> = {}) => ({
  id: 99,
  url: 'abc-123',
  type: 'image',
  nsfwLevel: MATURE_LEVEL,
  userId: 555,
  width: 100,
  height: 100,
  hash: null,
  poi: false,
  minor: false,
  ...overrides,
});

beforeEach(() => {
  state.blurLevels = 0;
});

describe('the image on a notification row', () => {
  // The control. Without it the covered case below passes against a component
  // that renders nothing at all.
  it('shows the image when the viewer has not asked for it to be covered', () => {
    const container = render(givenImage());

    expect(container.querySelector('[data-testid="thumbnail"]')).not.toBeNull();
  });

  it('covers an image at a level the viewer blurs', () => {
    state.blurLevels = MATURE_LEVEL;

    const container = render(givenImage());

    // Not "renders a blurhash" — the hash is nullable and MediaHash renders
    // nothing without one. What must hold is that the media never appears.
    expect(container.querySelector('[data-testid="thumbnail"]')).toBeNull();
  });

  it('shows an image whose level the viewer does not blur, while blurring others', () => {
    state.blurLevels = MATURE_LEVEL;

    const container = render(givenImage({ nsfwLevel: 1 }));

    expect(container.querySelector('[data-testid="thumbnail"]')).not.toBeNull();
  });
});
