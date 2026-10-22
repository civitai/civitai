// @vitest-environment happy-dom
import { MantineProvider, Menu } from '@mantine/core';
import * as React from 'react';
import { createRoot } from 'react-dom/client';
import type { act as actType } from 'react-dom/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as ImageUtils from '~/components/Image/image.utils';

const act = (React as unknown as { act: typeof actType }).act;
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { deleteImage, deletePost } = vi.hoisted(() => ({
  deleteImage: vi.fn(),
  deletePost: vi.fn(),
}));
vi.mock('~/components/Image/hooks/useDeleteImage', () => ({ useDeleteImage: () => deleteImage }));
vi.mock('~/components/Post/hooks/useDeletePost', () => ({ useDeletePost: () => deletePost }));

const nothing = () => null;
vi.mock('next/router', () => ({ default: { query: {}, push: vi.fn() } }));
vi.mock('~/components/Decorations/AddArtFrameMenuItem', () => ({ AddArtFrameMenuItem: nothing }));
vi.mock('~/components/Decorations/AddEventDecorationMenuItem', () => ({
  AddEventDecorationMenuItem: nothing,
}));
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
type MenuProps = React.ComponentProps<typeof ImageMenuItems>;

const image = { id: 145, postId: 900, url: 'img-145', userId: 7 } as MenuProps['image'];

let root: ReturnType<typeof createRoot> | undefined;
let host: HTMLElement | undefined;
beforeEach(() => {
  deleteImage.mockClear();
  deletePost.mockClear();
});
afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
});

function clickDelete(props: Partial<MenuProps>) {
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
            React.createElement(ImageMenuItems, { image, ...props })
          )
        )
      )
    )
  );
  const item = Array.from(host.querySelectorAll<HTMLElement>('button')).find(
    (el) => el.textContent === 'Delete'
  );
  expect(item, 'the menu has a Delete item').toBeDefined();
  act(() => item!.click());
}

// A post card's cover image stands in for the post, so its Delete must not delete just that image.
describe('image menu Delete', () => {
  it('on a post card deletes the whole post, with its image count', () => {
    clickDelete({ context: 'post', postImageCount: 3 });
    expect(deletePost).toHaveBeenCalledWith({ postId: 900, imageCount: 3 });
    expect(deleteImage).not.toHaveBeenCalled();
  });

  it('on an image deletes that image only', () => {
    clickDelete({ context: 'image' });
    expect(deleteImage).toHaveBeenCalledWith({ imageId: 145 });
    expect(deletePost).not.toHaveBeenCalled();
  });
});
