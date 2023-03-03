import {
  Button,
  Group,
  Popover,
  Stack,
  ThemeIcon,
  Text,
  Badge,
  Box,
  Sx,
  ActionIcon,
  Tooltip,
  Menu,
} from '@mantine/core';
import { NextLink } from '@mantine/next';
import { Prisma } from '@prisma/client';
import {
  IconDotsVertical,
  IconEye,
  IconEyeOff,
  IconFlag,
  IconLock,
  IconPlus,
  IconRating18Plus,
} from '@tabler/icons';
import { useRouter } from 'next/router';
import React, { cloneElement, createContext, useContext, useState, useCallback } from 'react';
import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';
import { ReportImageNsfwButton } from '~/components/Image/ImageNsfwButton/ImageNsfwButton';

import { useCurrentUser } from '~/hooks/useCurrentUser';
import { ImageModel } from '~/server/selectors/image.selector';
import { SimpleTag } from '~/server/selectors/tag.selector';
import { useImageStore } from '~/store/images.store';
import { isDefined } from '~/utils/type-guards';

export type ImageGuardConnect = {
  entityType: 'model' | 'modelVersion' | 'review' | 'user';
  entityId: number;
};
// #region [store]
type SfwStore = {
  showingConnections: Record<string, boolean>;
  showingImages: Record<string, boolean>;
  toggleImage: (id: number) => void;
  showImages: (ids: number[]) => void;
  toggleConnection: ({ entityType, entityId }: ImageGuardConnect) => void;
};
const getConnectionKey = ({ entityId, entityType }: ImageGuardConnect) =>
  `${entityId}_${entityType}`;
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
  images: CustomImageModel[];
  connect?: ImageGuardConnect;
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

type CustomImageModel = Omit<ImageModel, 'tags'> & {
  imageNsfw?: boolean;
  tags?: SimpleTag[];
  analysis?: Prisma.JsonValue;
};

type ImageGuardProps = {
  images: CustomImageModel[];
  connect?: ImageGuardConnect;
  render: (image: CustomImageModel, index: number) => React.ReactNode;
  /** Make all images nsfw by default */
  nsfw?: boolean;
};

export function ImageGuard({ images: initialImages, connect, render }: ImageGuardProps) {
  const images = initialImages.filter(isDefined).filter((x) => x.id);

  return (
    <ImageGuardCtx.Provider value={{ images, connect }}>
      {images.map((image, index) => (
        <ImageGuardContentProvider key={image.id} image={image}>
          {render(image, index)}
        </ImageGuardContentProvider>
      ))}
    </ImageGuardCtx.Provider>
  );
}

const ImageGuardContentCtx = createContext<{
  image: CustomImageModel;
  safe: boolean;
  showToggleImage: boolean;
  showToggleConnect: boolean;
  canToggleNsfw: boolean;
  showReportNsfw: boolean;
}>({} as any);
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
  image: CustomImageModel;
}) {
  const { connect } = useImageGuardContext();
  const currentUser = useCurrentUser();
  const shouldBlur = currentUser?.blurNsfw ?? true;

  const showImage = useStore((state) => state.showingImages[image.id.toString()] ?? false);
  const showConnection = useStore((state) =>
    connect ? state.showingConnections[getConnectionKey(connect)] : undefined
  );

  const imageStore = useImageStore(
    useCallback((state) => state.images[image.id.toString()] ?? {}, [image.id])
  );

  const showing = showConnection ?? showImage;
  const nsfw = imageStore.nsfw ?? image.nsfw;
  const nsfwWithBlur = nsfw && shouldBlur;
  const unsafe = nsfwWithBlur && !showing;
  const safe = !unsafe;

  const showToggleImage = !connect && nsfw;
  const showToggleConnect = !!connect && nsfw;
  const canToggleNsfw = shouldBlur;
  // Only show the quick nsfw report if the user is logged in and is a member or moderator
  const showReportNsfw =
    safe && !nsfw && !!currentUser && (currentUser.isMember || currentUser.isModerator === true);

  return (
    <ImageGuardContentCtx.Provider
      value={{
        safe,
        showToggleImage,
        showToggleConnect,
        showReportNsfw,
        canToggleNsfw,
        image: {
          ...image,
          nsfw: nsfwWithBlur,
          imageNsfw: nsfw,
        },
      }}
    >
      {children}
    </ImageGuardContentCtx.Provider>
  );
}

ImageGuard.Unsafe = function Unsafe({ children }: { children: React.ReactNode }) {
  const { safe } = useImageGuardContentContext();
  return !safe ? <>{children}</> : null;
};

ImageGuard.Safe = function Safe({ children }: { children?: React.ReactNode }) {
  const { safe } = useImageGuardContentContext();
  return safe ? <>{children}</> : null;
};

ImageGuard.ReportNSFW = function ReportNSFW({
  position = 'top-right',
  sx,
  className,
}: {
  position?: 'static' | 'top-left' | 'top-right';
  sx?: Sx;
  className?: string;
}) {
  const { image, showReportNsfw } = useImageGuardContentContext();
  if (!showReportNsfw) return null;
  return (
    <ReportImageNsfwButton imageId={image.id}>
      {({ onClick, isLoading }) => (
        <Menu position="left-start" withArrow offset={-5}>
          <Menu.Target>
            <ActionIcon
              variant="transparent"
              loading={isLoading}
              p={0}
              onClick={(e: React.MouseEvent) => {
                e.preventDefault();
                e.stopPropagation();
              }}
              sx={{
                width: 30,
                position: 'absolute',
                top: 5,
                left: position === 'top-left' ? 5 : undefined,
                right: position === 'top-right' ? 5 : undefined,
                zIndex: 8,
              }}
            >
              <IconDotsVertical
                size={26}
                color="#fff"
                filter="drop-shadow(1px 1px 2px rgb(0 0 0 / 50%)) drop-shadow(0px 5px 15px rgb(0 0 0 / 60%))"
              />
            </ActionIcon>
          </Menu.Target>
          <Menu.Dropdown>
            <Menu.Item icon={<IconFlag size={14} stroke={1.5} />} onClick={onClick}>
              Report adult content
            </Menu.Item>
          </Menu.Dropdown>
        </Menu>
      )}
    </ReportImageNsfwButton>
  );
};

type ToggleStatus = 'show' | 'hide';
type ToggleProps = {
  children: ({ status }: { status: ToggleStatus }) => React.ReactElement;
};

ImageGuard.ToggleImage = function ToggleImage({
  position = 'top-left',
  sx,
  className,
}: {
  position?: 'static' | 'top-left' | 'top-right';
  sx?: Sx;
  className?: string;
}) {
  const { image, showToggleImage, canToggleNsfw } = useImageGuardContentContext();
  const showImage = useStore((state) => state.showingImages[image.id.toString()]);
  const toggleImage = useStore((state) => state.toggleImage);

  if (!showToggleImage) return null;

  return (
    <ImageGuardPopover>
      <Badge
        color="red"
        variant="filled"
        size="sm"
        px={6}
        sx={(theme) => ({
          cursor: canToggleNsfw ? 'pointer' : undefined,
          userSelect: 'none',
          ...(position !== 'static'
            ? {
                position: 'absolute',
                top: theme.spacing.xs,
                left: position === 'top-left' ? theme.spacing.xs : undefined,
                right: position === 'top-right' ? theme.spacing.xs : undefined,
                zIndex: 10,
              }
            : {}),
          ...(sx && sx instanceof Function ? sx(theme) : sx),
        })}
        className={className}
        onClick={canToggleNsfw ? () => toggleImage(image.id) : undefined}
      >
        <Group spacing={5} noWrap>
          <Text
            weight="bold"
            sx={{
              whiteSpace: 'nowrap',
              ...(canToggleNsfw
                ? {
                    borderRight: '1px solid rgba(0,0,0,.15)',
                    boxShadow: '0 1px 0 1px rgba(255,255,255,.1)',
                    paddingRight: 5,
                  }
                : {}),
            }}
            component="span"
          >
            18
            <Box component="span" sx={{ marginLeft: 1 }}>
              <IconPlus size={8} strokeWidth={5} />
            </Box>
          </Text>
          {canToggleNsfw &&
            (showImage ? (
              <IconEyeOff size={14} strokeWidth={2.5} />
            ) : (
              <IconEye size={14} strokeWidth={2.5} />
            ))}
        </Group>
      </Badge>
    </ImageGuardPopover>
  );
};

ImageGuard.ToggleConnect = function ToggleConnect({
  position = 'top-left',
  sx,
  className,
}: {
  position?: 'static' | 'top-left' | 'top-right';
  sx?: Sx;
  className?: string;
}) {
  // const currentUser = useCurrentUser();
  // const { blurNsfw: toggleable } = currentUser ?? {};
  const { connect } = useImageGuardContext();
  const { image, showToggleConnect, canToggleNsfw } = useImageGuardContentContext();
  const showImage = useStore((state) => state.showingImages[image?.id.toString()] ?? false);
  const showConnect = useStore((state) =>
    connect ? state.showingConnections[getConnectionKey(connect)] : false
  );
  const toggleConnect = useStore((state) => state.toggleConnection);

  // const showToModerator = image.imageNsfw && isModerator;
  // if (!connect || (!image.nsfw && !showToModerator)) return null;
  if (!showToggleConnect) return null;

  const showing = showConnect ?? showImage;
  return (
    <ImageGuardPopover>
      <Badge
        color="red"
        variant="filled"
        size="sm"
        px={6}
        sx={(theme) => ({
          cursor: canToggleNsfw ? 'pointer' : undefined,
          userSelect: 'none',
          ...(position !== 'static'
            ? {
                position: 'absolute',
                top: theme.spacing.xs,
                left: position === 'top-left' ? theme.spacing.xs : undefined,
                right: position === 'top-right' ? theme.spacing.xs : undefined,
                zIndex: 10,
              }
            : {}),
          ...(sx && sx instanceof Function ? sx(theme) : sx),
        })}
        className={className}
        onClick={canToggleNsfw && connect ? () => toggleConnect(connect) : undefined}
      >
        <Group spacing={5} noWrap>
          <Text
            weight="bold"
            sx={{
              whiteSpace: 'nowrap',
              ...(canToggleNsfw
                ? {
                    borderRight: '1px solid rgba(0,0,0,.15)',
                    boxShadow: '0 1px 0 1px rgba(255,255,255,.1)',
                    paddingRight: 5,
                  }
                : {}),
            }}
            component="span"
          >
            18
            <Box component="span" sx={{ marginLeft: 1 }}>
              <IconPlus size={8} strokeWidth={5} />
            </Box>
          </Text>
          {canToggleNsfw &&
            (showing ? (
              <IconEyeOff size={14} strokeWidth={2.5} />
            ) : (
              <IconEye size={14} strokeWidth={2.5} />
            ))}
        </Group>
      </Badge>
    </ImageGuardPopover>
  );
};

function ImageGuardPopover({ children }: { children: React.ReactElement }) {
  const user = useCurrentUser();
  const isAuthenticated = !!user;
  const { image } = useImageGuardContentContext();
  const [opened, setOpened] = useState(false);
  const router = useRouter();

  if (image.nsfw && !isAuthenticated)
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
                You must be logged in to view adult content
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
