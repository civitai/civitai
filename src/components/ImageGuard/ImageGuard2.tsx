import { Badge, BadgeProps, Text, createStyles, Center, Alert, Button, Stack } from '@mantine/core';
import { IconEye, IconEyeOff } from '@tabler/icons-react';
import Router from 'next/router';
import React, { createContext, useCallback, useContext } from 'react';
import { create } from 'zustand';
import { ConfirmDialog } from '~/components/Dialog/Common/ConfirmDialog';
import { openSetBrowsingLevelModal } from '~/components/Dialog/dialog-registry';
import { dialogStore } from '~/components/Dialog/dialogStore';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { constants } from '~/server/common/constants';
import { NsfwLevel } from '~/server/common/enums';
import {
  browsingLevelLabels,
  nsfwBrowsingLevelsFlag,
  getIsSafeBrowsingLevel,
} from '~/shared/constants/browsingLevel.constants';
import { Flags } from '~/shared/utils';
import { useImageStore } from '~/store/image.store';

type ImageProps = {
  id: number;
  nsfwLevel?: number;
  userId?: number;
  user?: { id: number };
  url?: string | null;
};

type ConnectId = string | number;
type ConnectType =
  | 'model'
  | 'modelVersion'
  | 'review'
  | 'user'
  | 'post'
  | 'collectionItem'
  | 'collection'
  | 'bounty'
  | 'bountyEntry'
  | 'club'
  | 'article';

export type ImageGuardConnect = { connectType: ConnectType; connectId: ConnectId };

export type ConnectProps =
  | { connectType?: never; connectId?: never }
  | { connectType: ConnectType; connectId: ConnectId };

const useShowConnectionStore = create<Record<string, boolean>>(() => ({}));
const useShowImagesStore = create<Record<number, boolean>>(() => ({}));
const useLimitedToggleCountStore = create<number>(() => 0);

function getConnectionKey({
  connectId,
  connectType,
}: {
  connectType?: ConnectType;
  connectId?: ConnectId;
}) {
  if (!connectId || !connectType) return null;
  return `${connectId}_${connectType}`;
}

const ImageGuardCtx = createContext<{
  safe: boolean;
  show: boolean;
  browsingLevel: NsfwLevel;
  imageId: number;
  key: string | null;
  nsfw: boolean;
  userId?: number;
} | null>(null);

function useImageGuardContext() {
  const context = useContext(ImageGuardCtx);
  if (!context) throw new Error('missing ImageGuardProvider');
  return context;
}

type UseImageGuardProps = {
  image: ImageProps;
} & ConnectProps;

function useImageGuard({ image, connectId, connectType }: UseImageGuardProps) {
  const currentUser = useCurrentUser();
  const showImage = useShowImagesStore(useCallback((state) => state[image.id], [image.id]));
  const key = getConnectionKey({ connectType, connectId });
  const { nsfwLevel = 0, ...rest } = useImageStore(image);

  const showConnect = useShowConnectionStore(
    useCallback((state) => (key ? state[key] : undefined), [key])
  );

  const userId = image.userId ?? image.user?.id;
  const showUnprocessed = !nsfwLevel && (currentUser?.isModerator || userId === currentUser?.id);
  const nsfw = Flags.hasFlag(nsfwBrowsingLevelsFlag, nsfwLevel);
  const shouldBlur = (currentUser?.blurNsfw ?? true) && !showUnprocessed;
  const safe = !nsfw ? true : !shouldBlur;
  const show = safe || (showConnect ?? showImage);

  return {
    safe,
    show,
    browsingLevel: nsfwLevel,
    imageId: image.id,
    key,
    nsfw,
    userId,
    ...rest,
  };
}

export function ImageGuard2({
  image,
  children,
  explain = true,
  ...connectProps
}: {
  image: ImageProps;
  children: (show: boolean) => React.ReactElement | null;
  explain?: boolean;
} & ConnectProps) {
  const state = useImageGuard({ image, ...connectProps });
  const { show, browsingLevel, tosViolation } = state;

  return (
    <ImageGuardCtx.Provider value={state}>
      <ImageGuardContentInner
        show={show}
        browsingLevel={browsingLevel}
        tosViolation={tosViolation}
        explain={explain}
      >
        {children(show)}
      </ImageGuardContentInner>
    </ImageGuardCtx.Provider>
  );
}

function ImageGuardContentInner({
  show,
  explain,
  browsingLevel,
  tosViolation,
  children,
}: {
  show: boolean;
  explain?: boolean;
  browsingLevel: number;
  tosViolation?: boolean;
  children: React.ReactNode;
}) {
  const { classes } = useBadgeStyles({ browsingLevel });
  return (
    <>
      {!show && explain && (
        <BlurToggle>
          {(toggle) => (
            <Center className="absolute z-20 transform -translate-x-1/2 -translate-y-[60%] top-1/2 left-1/2 flex flex-col text-white">
              <Stack align="center" spacing="sm" w="100%">
                <Text size="sm" className="text-shadow-sm shadow-black/50">
                  This image is rated
                </Text>
                <Badge
                  color="red"
                  size="xl"
                  classNames={classes}
                  className="shadow shadow-black/30 min-w-[32px] text-center"
                >
                  {browsingLevelLabels[browsingLevel as NsfwLevel]}
                </Badge>
                <Button
                  onClick={toggle}
                  radius="xl"
                  sx={(theme) => ({
                    color: theme.colorScheme === 'dark' ? theme.white : theme.colors.gray[9],
                    backgroundColor: theme.fn.rgba(
                      theme.colorScheme === 'dark' ? theme.colors.dark[6] : theme.colors.gray[0],
                      0.6
                    ),
                    boxShadow: theme.shadows.sm,
                    '&:hover': {
                      backgroundColor: theme.fn.rgba(
                        theme.colorScheme === 'dark' ? theme.colors.dark[6] : theme.colors.gray[0],
                        0.7
                      ),
                    },
                  })}
                >
                  Show
                </Button>
              </Stack>
            </Center>
          )}
        </BlurToggle>
      )}
      {tosViolation ? (
        <Center w="100%" h="100%">
          <Alert color="red">TOS Violation</Alert>
        </Center>
      ) : (
        children
      )}
    </>
  );
}

export function BrowsingLevelBadge({
  browsingLevel,
  className,
  sfwClassName,
  nsfwClassName,
  ...badgeProps
}: {
  browsingLevel?: number;
} & BadgeProps & { onClick?: () => void; sfwClassName?: string; nsfwClassName?: string }) {
  const { classes, cx } = useBadgeStyles({ browsingLevel });
  if (!browsingLevel) return null;
  const nsfw = Flags.hasFlag(nsfwBrowsingLevelsFlag, browsingLevel);

  const badgeClass = cx(className, {
    [sfwClassName ? sfwClassName : '']: !nsfw,
    [nsfwClassName ? nsfwClassName : '']: nsfw,
  });

  return (
    <Badge classNames={classes} className={badgeClass} {...badgeProps}>
      {browsingLevelLabels[browsingLevel as NsfwLevel]}
    </Badge>
  );
}

function BlurToggle({
  className,
  classNames,
  children,
  sfwClassName,
  nsfwClassName,
  color,
  alwaysVisible,
  ...badgeProps
}: Omit<BadgeProps, 'children'> & {
  children?: (toggle: (e: React.MouseEvent<HTMLElement, MouseEvent>) => void) => React.ReactElement;
  sfwClassName?: string;
  nsfwClassName?: string;
  alwaysVisible?: boolean;
}) {
  const currentUser = useCurrentUser();
  const { safe, show, browsingLevel, imageId, key, nsfw, userId } = useImageGuardContext();
  const { classes, cx } = useBadgeStyles({ browsingLevel });

  const toggle = (event: React.MouseEvent<HTMLElement, MouseEvent>) =>
    toggleShow({ event, isAuthed: !!currentUser, key, imageId });

  if (children) {
    return children(toggle);
  }

  if (!browsingLevel) return null;

  const badgeClass = cx(className, {
    [sfwClassName ? sfwClassName : '']: !nsfw,
    [nsfwClassName ? nsfwClassName : '']: nsfw,
  });

  if (safe) {
    const isOwnerOrModerator = currentUser?.isModerator || (userId && currentUser?.id === userId);
    return isOwnerOrModerator || alwaysVisible ? (
      <Badge
        classNames={classes}
        className={badgeClass}
        onClick={
          isOwnerOrModerator
            ? (e) => {
                e.preventDefault();
                e.stopPropagation();
                openSetBrowsingLevelModal({ imageId, nsfwLevel: browsingLevel });
              }
            : undefined
        }
        color={!nsfw ? color : undefined}
        {...badgeProps}
      >
        {browsingLevelLabels[browsingLevel]}
      </Badge>
    ) : null;
  }

  return (
    <Badge
      component="button"
      classNames={{ ...classes, ...classNames }}
      className={cx(badgeClass, 'cursor-pointer')}
      {...badgeProps}
      onClick={toggle}
    >
      {show ? <IconEyeOff size={14} strokeWidth={2.5} /> : <IconEye size={14} strokeWidth={2.5} />}
    </Badge>
  );
}

function toggleShow({
  event,
  isAuthed,
  key,
  imageId,
}: {
  event: React.MouseEvent<HTMLElement, MouseEvent>;
  isAuthed: boolean;
  key: string | null;
  imageId: number;
}) {
  event.preventDefault();
  event.stopPropagation();
  const limitedToggleCount = useLimitedToggleCountStore.getState();
  const hasHitLimit = limitedToggleCount >= constants.imageGuard.noAccountLimit;

  // handle limited toggles for unauthenticated users
  if (!isAuthed && hasHitLimit) {
    dialogStore.trigger({
      id: 'limited-toggle-modal',
      component: ConfirmDialog,
      props: {
        message: (
          <Text size="sm" weight={500} sx={{ flex: 1 }}>
            Login now to continue viewing mature content and unblur everything.
          </Text>
        ),
        onConfirm: () => Router.push(`/login?returnUrl=${Router.asPath}&reason=blur-toggle`),
        labels: { cancel: 'Cancel', confirm: 'Continue' },
      },
    });
  }

  if (!hasHitLimit) {
    if (key) useShowConnectionStore.setState((state) => ({ [key]: !state[key] }));
    else useShowImagesStore.setState((state) => ({ [imageId]: !state[imageId] }));
  }

  // increment unauthed user toggle count
  if (!isAuthed) {
    useLimitedToggleCountStore.setState((state) => state + 1);
  }
}

const useBadgeStyles = createStyles((theme, params: { browsingLevel?: number }) => {
  const backgroundColor = getIsSafeBrowsingLevel(params.browsingLevel ?? 0)
    ? undefined
    : theme.fn.rgba(theme.colors.red[9], 0.6);
  return {
    root: {
      userSelect: 'none',
      backgroundColor,
      color: 'white',
      paddingLeft: 8,
      paddingRight: 8,

      '& > span': {
        lineHeight: 1,
      },
    },
  };
});

ImageGuard2.BlurToggle = BlurToggle;

export function ImageGuardContent({
  image,
  children,
  explain = true,
  ...connectProps
}: {
  image: ImageProps;
  explain?: boolean;
  children: (show: boolean) => React.ReactElement | null;
} & ConnectProps) {
  const state = useImageGuard({ image, ...connectProps });
  const { show, browsingLevel, tosViolation } = state;

  return (
    <ImageGuardContentInner
      show={show}
      browsingLevel={browsingLevel}
      tosViolation={tosViolation}
      explain={explain}
    >
      {children(show)}
    </ImageGuardContentInner>
  );
}
