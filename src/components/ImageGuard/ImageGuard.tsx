import { Button, Group, Popover, Stack, ThemeIcon, Text } from '@mantine/core';
import { NextLink } from '@mantine/next';
import { IconLock } from '@tabler/icons';
import router from 'next/router';
import React, { cloneElement, createContext, useContext, useState } from 'react';
import create from 'zustand';
import { immer } from 'zustand/middleware/immer';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { ImageModel } from '~/server/selectors/image.selector';
type Connection = {
  entityType: 'model';
  entityId: number;
};
// #region [store]
type SfwStore = {
  showingConnections: Record<string, boolean>;
  showingImages: Record<string, boolean>;
  toggleImage: (id: number) => void;
  showImages: (ids: number[]) => void;
  toggleConnection: ({ entityType, entityId }: Connection) => void;
};
const getConnectionKey = ({ entityId, entityType }: Connection) => `${entityId}_${entityType}`;
const useStore = create<SfwStore>()(
  immer((set) => ({
    showingConnections: {},
    showingImages: {},

    toggleImage: (id) => {
      set((state) => {
        state.showingImages[id.toString()] = !state.showingImages[id.toString()];
      });
    },
    showImages: (ids) => {
      set((state) => {
        ids.map((id) => (state.showingImages[id.toString()] = true));
      });
    },
    toggleConnection: (args) => {
      set((state) => {
        const key = getConnectionKey(args);
        state.showingConnections[key] = !state.showingConnections[key];
      });
    },
  }))
);
// #endregion

// #region [ImageGuardContext]
type ImageGuardState = {
  images: ImageModel[];
  nsfw?: boolean;
  connect?: Connection;
};
const ImageGuardCtx = createContext<ImageGuardState>({} as any);
const useImageGuardContext = () => {
  const context = useContext(ImageGuardCtx);
  if (!context) throw new Error('useImageGuardContext can only be used inside ImageGuardCtx');
  return context;
};
// #endregion

/**NOTES**
  - `connect` allows our images to be managed by a parent entity.
    - use case: home page, model card, toggle image - since I don't have all the images yet, I need to be able to still manage nsfw state for all the images without having the knowledge of which images are nsfw
*/

type ImageGuardProps = {
  images: ImageModel[];
  connect?: Connection;
  render: (image: ImageModel, index?: number) => React.ReactNode;
  /** Make all images nsfw by default */
  nsfw?: boolean;
};

export function ImageGuard({
  images: initialImages,
  connect,
  render,
  nsfw: globalNsfw,
}: ImageGuardProps) {
  const user = useCurrentUser();
  const shouldBlur = user?.blurNsfw ?? true;

  const showConnection = useStore((state) =>
    connect ? state.showingConnections[getConnectionKey(connect)] : undefined
  );

  // alter image nsfw - only allow to be true if shouldBlur is true
  const images = initialImages.map((image) => {
    const nsfw = (globalNsfw || image.nsfw) && shouldBlur;
    return { ...image, nsfw };
  });

  // if the showConnection is true, set nsfw = false for all images
  const connectedImages =
    showConnection !== undefined
      ? images.map((image) => ({ ...image, nsfw: showConnection ? false : image.nsfw }))
      : images;

  return (
    <ImageGuardCtx.Provider value={{ images: connectedImages, nsfw: globalNsfw, connect }}>
      {connectedImages.map((image, index) => (
        <ImageGuardContentProvider key={index} image={image}>
          {render(image, index)}
        </ImageGuardContentProvider>
      ))}
    </ImageGuardCtx.Provider>
  );
}

const ImageGuardContentCtx = createContext<{ image: ImageModel }>({} as any);
const useImageGuardContentContext = () => {
  const context = useContext(ImageGuardContentCtx);
  if (!context)
    throw new Error('useImageGuardContentContext can only be used inside ImageGuardContentCtx');
  return context;
};
function ImageGuardContentProvider({
  children,
  image,
}: {
  children: React.ReactNode;
  image: ImageModel;
}) {
  return (
    <ImageGuardContentCtx.Provider value={{ image }}>{children}</ImageGuardContentCtx.Provider>
  );
}

ImageGuard.Unsafe = function Unsafe({ children }: { children: React.ReactNode }) {
  const { image } = useImageGuardContentContext();
  const showImage = useStore((state) => state.showingImages[image.id.toString()] ?? false);

  if (!image.nsfw) return null;
  return image.nsfw && !showImage ? <>{children}</> : null;
};

ImageGuard.Safe = function Safe({ children }: { children: React.ReactNode }) {
  const { image } = useImageGuardContentContext();
  const showImage = useStore((state) => state.showingImages[image.id.toString()] ?? false);

  return image.nsfw && !showImage ? null : <>{children}</>;
};

ImageGuard.ToggleImage = function ToggleImage({ children }: { children: React.ReactElement }) {
  const { image } = useImageGuardContentContext();
  const toggleImage = useStore((state) => state.toggleImage);

  if (!image.nsfw) return null;

  return (
    <ImageGuardPopover>
      {cloneElement(children, { onClick: () => toggleImage(image.id) })}
    </ImageGuardPopover>
  );
};

ImageGuard.ToggleConnect = function ToggleConnect({ children }: { children: React.ReactElement }) {
  const { connect, nsfw } = useImageGuardContext();
  const toggleConnect = useStore((state) => state.toggleConnection);

  if (!connect || !nsfw) return null;

  return (
    <ImageGuardPopover>
      {cloneElement(children, { onClick: () => toggleConnect(connect) })}
    </ImageGuardPopover>
  );
};

ImageGuard.ShowAll = function ShowAll({ children }: { children: React.ReactElement }) {
  const { images } = useImageGuardContext();
  const { image } = useImageGuardContentContext();
  const showImages = useStore((state) => state.showImages);

  if (!image.nsfw) return null;

  return (
    <ImageGuardPopover>
      {cloneElement(children, { onClick: () => showImages(images.map((x) => x.id)) })}
    </ImageGuardPopover>
  );
};

function ImageGuardPopover({ children }: { children: React.ReactElement }) {
  const user = useCurrentUser();
  const isAuthenticated = !!user;
  const { nsfw } = useImageGuardContext();
  const { image } = useImageGuardContentContext();
  const [opened, setOpened] = useState(false);

  if ((nsfw || image.nsfw) && !isAuthenticated)
    return (
      <Popover
        width={300}
        position="bottom"
        opened={opened}
        withArrow
        closeOnClickOutside
        withinPortal
      >
        <Popover.Target>
          {cloneElement(children, {
            onClick: (e: React.MouseEvent) => {
              e.stopPropagation();
              e.preventDefault();
              e.nativeEvent.stopImmediatePropagation();
              setOpened((o) => !o);
            },
          })}
        </Popover.Target>
        <Popover.Dropdown>
          <Stack spacing="xs">
            <Group>
              <ThemeIcon color="red" size="xl" variant="outline">
                <IconLock />
              </ThemeIcon>
              <Text size="sm" weight={500} sx={{ flex: 1 }}>
                You must be logged in to view NSFW content
              </Text>
            </Group>

            <Button size="xs" component={NextLink} href={`/login?returnUrl=${router.asPath}`}>
              Login
            </Button>
          </Stack>
        </Popover.Dropdown>
      </Popover>
    );

  return cloneElement(children, {
    onClick: (e: React.MouseEvent) => {
      e.stopPropagation();
      e.preventDefault();
      e.nativeEvent.stopImmediatePropagation();
      children.props.onClick?.();
    },
  });
}
