// @vitest-environment happy-dom
import { MantineProvider, Menu } from '@mantine/core';
import * as React from 'react';
import { createRoot } from 'react-dom/client';
import type { act as actType } from 'react-dom/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type * as ImageUtils from '~/components/Image/image.utils';

const act = (React as unknown as { act: typeof actType }).act;
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// The hat item stands in as a marker carrying what the menu handed it; its own gating (event
// access, Add vs Remove) is covered in post-edit-event-card.render.test.ts.
vi.mock('~/components/Decorations/AddEventDecorationMenuItem', () => ({
  AddEventDecorationMenuItem: (props: { currentCosmetic?: { id: number } | null }) =>
    React.createElement('div', {
      'data-testid': 'hat-item',
      'data-current': props.currentCosmetic?.id ?? '',
    }),
}));
const nothing = () => null;
vi.mock('next/router', () => ({ default: { query: {} } }));
vi.mock('~/components/Decorations/AddArtFrameMenuItem', () => ({ AddArtFrameMenuItem: nothing }));
vi.mock('~/components/Profile/AddToShowcaseMenuItem', () => ({ AddToShowcaseMenuItem: nothing }));
vi.mock('~/components/MenuItems/ToggleSearchableMenuItem', () => ({
  ToggleSearchableMenuItem: nothing,
}));
vi.mock('~/components/HideImageButton/HideImageButton', () => ({ HideImageButton: nothing }));
vi.mock('~/components/HideUserButton/HideUserButton', () => ({ HideUserButton: nothing }));
vi.mock('~/components/HideUserButton/BlockUserButton', () => ({ BlockUserButton: nothing }));
vi.mock('~/components/Moderation/ModeratorLookupMenuItem', () => ({
  ModeratorLookupMenuItem: nothing,
}));
vi.mock('~/components/RemixGallery/RemixGalleryMenuItems', () => ({
  RemixGalleryMenuItems: nothing,
}));
vi.mock('~/components/LoginRedirect/LoginRedirect', () => ({ LoginRedirect: nothing }));
vi.mock('~/components/NextLink/NextLink', () => ({ NextLink: React.forwardRef(nothing) }));
vi.mock('~/components/Dialog/triggers/add-to-collection', () => ({
  openAddToCollectionModal: vi.fn(),
}));
vi.mock('~/components/Dialog/triggers/report', () => ({ openReportModal: vi.fn() }));
const mutation = () => ({ mutate: vi.fn(), isLoading: false });
vi.mock('~/components/Image/hooks/useDeleteImage', () => ({ useDeleteImage: mutation }));
vi.mock('~/components/Post/hooks/useDeletePost', () => ({ useDeletePost: mutation }));
vi.mock('~/components/Image/hooks/useRescanImage', () => ({ useRescanImage: mutation }));
vi.mock('~/components/Image/hooks/useReportTosViolation', () => ({
  useReportTosViolation: mutation,
}));
vi.mock('~/components/Image/hooks/useToggleImageFlag', () => ({ useToggleImageFlag: mutation }));
vi.mock('~/components/Image/image.utils', async (importOriginal) => ({
  ...(await importOriginal<typeof ImageUtils>()),
  useReportCsamImages: mutation,
}));
vi.mock('~/providers/FeatureFlagsProvider', () => ({ useFeatureFlags: () => ({}) }));
vi.mock('~/components/Image/ContextMenu/ImageContextMenuProvider', () => ({
  useImageContextMenuContext: () => ({}),
}));
vi.mock('~/components/Image/ImageProvider', () => ({
  useImageContext: () => ({ isOwner: true, isModerator: false }),
}));

const { ImageMenuItems } = await import('~/components/Image/ContextMenu/ImageMenuItems');
type MenuImage = React.ComponentProps<typeof ImageMenuItems>['image'];

const image = (over: Partial<MenuImage>) =>
  ({
    id: 145,
    url: 'img-145',
    name: null,
    hash: null,
    width: 512,
    height: 512,
    type: 'image',
    nsfwLevel: 1,
    userId: 7,
    ...over,
  } as MenuImage);

let root: ReturnType<typeof createRoot> | undefined;
let host: HTMLElement | undefined;
afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
});

function hatItem(over: Partial<MenuImage>) {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() =>
    root!.render(
      React.createElement(
        MantineProvider,
        null,
        React.createElement(
          Menu,
          { opened: true, withinPortal: false },
          React.createElement(Menu.Target, null, React.createElement('button', null, 'menu')),
          React.createElement(
            Menu.Dropdown,
            null,
            React.createElement(ImageMenuItems, { image: image(over) })
          )
        )
      )
    )
  );
  return host.querySelector<HTMLElement>('[data-testid="hat-item"]');
}

// An image outside a post (an article cover) is in no feed, so a hat there earns almost nothing;
// the server refuses it (event-decoration-equip.test.ts) and the menu does not offer it.
describe('image menu event hat item', () => {
  it('is offered on an image in a post', () => {
    expect(hatItem({ postId: 900 })).not.toBeNull();
  });

  it('is not offered on an image outside a post', () => {
    expect(hatItem({ postId: null })).toBeNull();
  });

  // Many feeds never select postId: leaving it out says nothing about the image.
  it('is offered when the feed did not say which post', () => {
    expect(hatItem({})).not.toBeNull();
  });

  it('stays on an image outside a post that already wears a hat, so it can come off', () => {
    const item = hatItem({
      postId: null,
      eventDecoration: { id: 3 } as MenuImage['eventDecoration'],
    });
    expect(item?.dataset.current).toBe('3');
  });
});
