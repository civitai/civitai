import {
  ActionIcon,
  Badge,
  Box,
  Button,
  Group,
  HoverCard,
  Menu,
  Popover,
  Stack,
  Sx,
  Text,
  ThemeIcon,
} from '@mantine/core';
import { NextLink } from '@mantine/next';
import { NsfwLevel } from '@prisma/client';
import {
  IconAlertTriangle,
  IconCheck,
  IconDotsVertical,
  IconEye,
  IconEyeOff,
  IconFlag,
  IconLock,
  IconPencil,
  IconPlus,
  IconX,
} from '@tabler/icons-react';
import Router, { useRouter } from 'next/router';
import React, { cloneElement, createContext, useCallback, useContext, useState } from 'react';
import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';

import { HideUserButton } from '~/components/HideUserButton/HideUserButton';
import { LoginRedirect } from '~/components/LoginRedirect/LoginRedirect';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { nsfwLevelUI } from '~/libs/moderation';
import { openContext } from '~/providers/CustomModalsProvider';
import { RoutedContextLink } from '~/providers/RoutedContextProvider';
import { isNsfwImage } from '~/server/common/model-helpers';
import { ReportEntity } from '~/server/schema/report.schema';
import { SimpleUser } from '~/server/selectors/user.selector';
import { useImageStore } from '~/store/images.store';
import { trpc } from '~/utils/trpc';
import { isDefined } from '~/utils/type-guards';

export type ImageGuardConnect = {
  entityType: 'model' | 'modelVersion' | 'review' | 'user' | 'post';
  entityId: string | number;
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
  images: ImageProps[];
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

// export type CustomImageModel = Omit<ImageModel, 'tags'> & {
//   imageNsfw?: boolean;
//   tags?: SimpleTag[];
//   analysis?: Prisma.JsonValue;
// };

type ImageProps = {
  id: number;
  nsfw: NsfwLevel;
  imageNsfw?: boolean;
  postId?: number | null;
  width?: number | null;
  height?: number | null;
  needsReview?: string | null;
  userId?: number;
  user?: SimpleUser;
};

type ImageGuardProps<T extends ImageProps> = {
  images: T[];
  connect?: ImageGuardConnect;
  render: (image: T, index: number) => React.ReactNode;
  /** Make all images nsfw by default */
  nsfw?: boolean;
};

export function ImageGuard<T extends ImageProps>({
  images: initialImages,
  connect,
  render,
}: ImageGuardProps<T>) {
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
  image: ImageProps;
  safe: boolean;
  showToggleImage: boolean;
  showToggleConnect: boolean;
  canToggleNsfw: boolean;
  showReportNsfw: boolean;
  isOwner: boolean;
  isModerator: boolean;
} | null>(null);
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
  image: ImageProps;
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
  const userId: number | undefined = (image as any).userId ?? (image as any).user?.id;
  const isOwner = userId === currentUser?.id;
  const isModerator = currentUser?.isModerator ?? false;
  const showing = showConnection ?? showImage;
  const nsfw = imageStore.nsfw ?? isNsfwImage(image);
  const nsfwWithBlur = nsfw && shouldBlur;
  const unsafe = nsfwWithBlur && !showing;
  const safe = !unsafe;

  const showToggleImage = !connect && nsfw;
  const showToggleConnect = !!connect && nsfw;
  const canToggleNsfw = shouldBlur;
  // Only show the quick nsfw report if the user is logged in
  const showReportNsfw = !!currentUser;

  return (
    <ImageGuardContentCtx.Provider
      value={{
        safe,
        showToggleImage,
        showToggleConnect,
        showReportNsfw,
        canToggleNsfw,
        image,
        isOwner,
        isModerator,
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

ImageGuard.Report = function ReportImage({
  position = 'top-right',
}: {
  position?: 'static' | 'top-left' | 'top-right';
}) {
  const router = useRouter();
  const currentUser = useCurrentUser();
  const { image, showReportNsfw, isOwner, isModerator } = useImageGuardContentContext();
  const [needsReview, setNeedsReview] = useState(image.needsReview);

  const moderateImagesMutation = trpc.image.moderate.useMutation();
  const handleModerate = async (accept: boolean) => {
    if (!isModerator) return;
    moderateImagesMutation.mutate({
      ids: [image.id],
      needsReview: accept ? null : undefined,
      delete: !accept ? true : undefined,
    });
    setNeedsReview(null);
  };
  // if (!showReportNsfw) return null;

  const handleClick = (e: React.SyntheticEvent) => {
    e.preventDefault();
    e.stopPropagation();
    openContext('report', { entityType: ReportEntity.Image, entityId: image.id });
  };

  const handleEditClick = (e: React.SyntheticEvent) => {
    e.preventDefault();
    e.stopPropagation();
    Router.push(`/posts/${image.postId}/edit`);
  };

  let NeedsReviewBadge = needsReview && (
    <ThemeIcon size="lg" color="yellow">
      <IconAlertTriangle strokeWidth={2.5} size={26} />
    </ThemeIcon>
  );

  if (needsReview && isModerator)
    NeedsReviewBadge = (
      <Menu position="bottom">
        <Menu.Target>
          <Box>{NeedsReviewBadge}</Box>
        </Menu.Target>
        <Menu.Dropdown>
          <Menu.Item
            onClick={() => handleModerate(true)}
            icon={<IconCheck size={14} stroke={1.5} />}
          >
            Approve
          </Menu.Item>
          <Menu.Item onClick={() => handleModerate(false)} icon={<IconX size={14} stroke={1.5} />}>
            Reject
          </Menu.Item>
        </Menu.Dropdown>
      </Menu>
    );
  else if (needsReview) {
    NeedsReviewBadge = (
      <HoverCard width={200} withArrow>
        <HoverCard.Target>{NeedsReviewBadge}</HoverCard.Target>
        <HoverCard.Dropdown p={8}>
          <Stack spacing={0}>
            <Text weight="bold" size="xs">
              Flagged for review
            </Text>
            <Text size="xs">
              {`This image won't be visible to other users until it's reviewed by our moderators.`}
            </Text>
          </Stack>
        </HoverCard.Dropdown>
      </HoverCard>
    );
  }

  const menuItems: React.ReactElement[] = [];
  if (!isOwner)
    menuItems.push(
      <LoginRedirect reason="report-content" key="report">
        <Menu.Item icon={<IconFlag size={14} stroke={1.5} />} onClick={handleClick}>
          Report image
        </Menu.Item>
      </LoginRedirect>
    );

  if (currentUser && (isOwner || isModerator) && image.postId)
    menuItems.push(
      <Menu.Item
        icon={<IconPencil size={14} stroke={1.5} />}
        onClick={handleEditClick}
        key="edit-post"
      >
        Edit Image Post
      </Menu.Item>
    );

  if (image.postId && !router.query.postId)
    menuItems.push(
      <RoutedContextLink modal="postDetailModal" postId={image.postId} key="view-post">
        <Menu.Item icon={<IconEye size={14} stroke={1.5} />}>View Post</Menu.Item>
      </RoutedContextLink>
    );

  const userId = image.userId ?? image.user?.id;
  if (userId) menuItems.push(<HideUserButton key="hide-button" as="menu-item" userId={userId} />);

  if (!menuItems) return null;

  return (
    <Group
      spacing={4}
      sx={{
        position: 'absolute',
        top: 5,
        left: position === 'top-left' ? 5 : undefined,
        right: position === 'top-right' ? 5 : undefined,
        zIndex: 8,
      }}
    >
      {NeedsReviewBadge}
      {!!menuItems.length && (
        <Menu position="left-start" withArrow offset={-5}>
          <Menu.Target>
            <ActionIcon
              variant="transparent"
              p={0}
              onClick={(e: React.MouseEvent) => {
                e.preventDefault();
                e.stopPropagation();
              }}
              sx={{ width: 30 }}
            >
              <IconDotsVertical
                size={26}
                color="#fff"
                filter="drop-shadow(1px 1px 2px rgb(0 0 0 / 50%)) drop-shadow(0px 5px 15px rgb(0 0 0 / 60%))"
              />
            </ActionIcon>
          </Menu.Target>
          <Menu.Dropdown>{menuItems}</Menu.Dropdown>
        </Menu>
      )}
    </Group>
  );
};

const NsfwBadge = ({
  showImage,
  position,
  sx,
  className,
  onClick,
}: {
  showImage: boolean;
  onClick: () => void;
  position?: 'static' | 'top-left' | 'top-right';
  sx?: Sx;
  className?: string;
}) => {
  const { image, canToggleNsfw } = useImageGuardContentContext();
  const { color, label, shade } = nsfwLevelUI[image.nsfw] ?? nsfwLevelUI[NsfwLevel.X];

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
          backgroundColor: theme.fn.rgba(theme.colors[color][shade], 0.6),
          color: 'white',
          backdropFilter: 'blur(7px)',
          boxShadow: '1px 2px 3px -1px rgba(37,38,43,0.2)',
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
        onClick={canToggleNsfw ? () => onClick() : undefined}
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
            {label}
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

ImageGuard.ToggleImage = function ToggleImage(props: {
  position?: 'static' | 'top-left' | 'top-right';
  sx?: Sx;
  className?: string;
}) {
  const { image, showToggleImage, canToggleNsfw } = useImageGuardContentContext();
  const showImage = useStore((state) => state.showingImages[image.id.toString()]);
  const toggleImage = useStore((state) => state.toggleImage);

  if (!showToggleImage || !canToggleNsfw) return null;

  return <NsfwBadge showImage={showImage} onClick={() => toggleImage(image.id)} {...props} />;
};

ImageGuard.ToggleConnect = function ToggleConnect(props: {
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
  if (!showToggleConnect || !canToggleNsfw) return null;

  const showing = showConnect ?? showImage;
  return (
    <NsfwBadge
      showImage={showing}
      onClick={() => (connect ? toggleConnect(connect) : undefined)}
      {...props}
    />
  );
};

function ImageGuardPopover({ children }: { children: React.ReactElement }) {
  const user = useCurrentUser();
  const isAuthenticated = !!user;
  const { image } = useImageGuardContentContext();
  const [opened, setOpened] = useState(false);
  const router = useRouter();
  const nsfw = isNsfwImage(image);
  const accountRequired = nsfw;

  if (accountRequired && !isAuthenticated)
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
                You must be logged in to view this content
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

ImageGuard.Content = function ImageGuardContent({
  children,
}: {
  children: ({ safe }: { safe: boolean }) => React.ReactElement;
}) {
  const { safe } = useImageGuardContentContext();
  return children({ safe });
};
