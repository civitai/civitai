import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MantineProvider } from '@mantine/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as TrpcModule from '~/utils/trpc';
import type * as UserHoverCardModule from '~/components/UserAvatar/UserHoverCard';

const state = vi.hoisted(() => ({
  currentUser: null as { id: number } | null,
  hoverCapable: false,
  useQuery: vi.fn((..._a: unknown[]) => ({
    data: undefined as unknown,
    isLoading: false,
    isError: false,
  })),
}));

vi.mock('~/hooks/useCurrentUser', () => ({ useCurrentUser: () => state.currentUser }));

vi.mock('~/components/UserAvatar/UserHoverCard', async (importOriginal) => ({
  ...(await importOriginal<typeof UserHoverCardModule>()),
  useHoverCapable: () => state.hoverCapable,
}));

vi.mock('~/utils/trpc', async (importOriginal) => ({
  ...(await importOriginal<typeof TrpcModule>()),
  trpc: { reaction: { getImageReactors: { useQuery: state.useQuery } } },
}));

const { ImageReactorsPreview, ImageReactorsList } = await import(
  '~/components/Reaction/ImageReactorsPreview'
);
const { CREATOR_STUDIO_URL } = await import('~/shared/constants/creator-studio.constants');

const OWNER = 100;
const IMAGE_ID = 555;
const BAR = '<span data-bar="reactions">bar</span>';

const render = (el: Parameters<typeof createElement>[0], props: Record<string, unknown>) =>
  renderToStaticMarkup(createElement(MantineProvider, null, createElement(el, props)));

const renderPreview = () =>
  render(ImageReactorsPreview, {
    imageId: IMAGE_ID,
    ownerId: OWNER,
    children: createElement('span', { 'data-bar': 'reactions' }, 'bar'),
  });

beforeEach(() => {
  state.useQuery.mockClear();
  state.currentUser = null;
  state.hoverCapable = false;
});

// Server render only: Mantine's Portal renders nothing here, so opening the dropdowns is covered by
// ImageReactorsPreview.browser.test.tsx, not by this file.
describe('ImageReactorsPreview — owner only, nothing fetched at render', () => {
  it.each([
    ['signed out, touch', null, false],
    ['signed out, hover', null, true],
    ['another user, touch', { id: 7 }, false],
    ['another user, hover', { id: 7 }, true],
  ])('%s: renders the bar untouched and makes no request', (_, user, hover) => {
    state.currentUser = user;
    state.hoverCapable = hover;

    const html = renderPreview();

    expect(html).toBe(render(() => createElement('span', { 'data-bar': 'reactions' }, 'bar'), {}));
    expect(html).not.toMatch(/Who reacted/);
    expect(state.useQuery).not.toHaveBeenCalled();
  });

  it('owner on touch: a "Who reacted" button beside the bar, and nothing fetched at render', () => {
    state.currentUser = { id: OWNER };

    const html = renderPreview();

    expect(html).toContain(BAR);
    expect(html).toMatch(/<button[^>]*aria-label="Who reacted"/);
    expect(state.useQuery).not.toHaveBeenCalled();
  });

  it('owner on hover: the bar is the hover target, and nothing fetched at render', () => {
    state.currentUser = { id: OWNER };
    state.hoverCapable = true;

    const html = renderPreview();

    expect(html).toContain(BAR);
    expect(html).not.toMatch(/aria-label="Who reacted"/);
    expect(state.useQuery).not.toHaveBeenCalled();
  });
});

describe('ImageReactorsList', () => {
  it('asks for this image, says how it is ordered, and links to Creator Studio', () => {
    state.useQuery.mockReturnValueOnce({ data: [], isLoading: false, isError: false });

    const html = render(ImageReactorsList, { imageId: IMAGE_ID });

    expect(state.useQuery).toHaveBeenCalledWith({ id: IMAGE_ID });
    expect(html).toContain('Newest accounts first');
    expect(html).toContain('No reactions yet.');
    expect(html).toContain(`href="${CREATOR_STUDIO_URL}/analytics/content/image/${IMAGE_ID}"`);
  });
});
