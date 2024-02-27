import { Badge, BadgeProps, Group, Text, createStyles, Center, Alert } from '@mantine/core';
import { IconEye, IconEyeOff } from '@tabler/icons-react';
import Router from 'next/router';
import React, { createContext, useCallback, useContext } from 'react';
import { create } from 'zustand';
import { ConfirmDialog } from '~/components/Dialog/Common/ConfirmDialog';
import { dialogStore } from '~/components/Dialog/dialogStore';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { constants } from '~/server/common/constants';
import { NsfwLevel } from '~/server/common/enums';
import {
  BrowsingLevel,
  browsingLevelLabels,
  nsfwBrowsingLevelsFlag,
} from '~/shared/constants/browsingLevel.constants';
import { Flags } from '~/shared/utils';
import { useImageStore } from '~/store/image.store';

type ImageProps = {
  id: number;
  nsfwLevel: NsfwLevel;
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

type ConnectProps =
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
  browsingLevel: BrowsingLevel;
  imageId: number;
  key: string | null;
} | null>(null);

function useImageGuardContext() {
  const context = useContext(ImageGuardCtx);
  if (!context) throw new Error('missing ImageGuardProvider');
  return context;
}

export function ImageGuard2({
  image,
  children,
  connectId,
  connectType,
}: {
  image: ImageProps;
  children: (show: boolean) => React.ReactNode;
} & ConnectProps) {
  const currentUser = useCurrentUser();
  const showImage = useShowImagesStore(useCallback((state) => state[image.id], [image.id]));
  const key = getConnectionKey({ connectType, connectId });

  const { tosViolation } = useImageStore(image);

  const showConnect = useShowConnectionStore(
    useCallback((state) => (key ? state[key] : undefined), [key])
  );

  const nsfw = Flags.hasFlag(nsfwBrowsingLevelsFlag, image.nsfwLevel);
  const shouldBlur = currentUser?.blurNsfw ?? true;
  const safe = !nsfw ? true : !shouldBlur;
  const show = safe || (showConnect ?? showImage);

  return (
    <ImageGuardCtx.Provider
      value={{ safe, show, browsingLevel: image.nsfwLevel as number, imageId: image.id, key }}
    >
      {tosViolation ? (
        <Center w="100%" h="100%">
          <Alert color="red">TOS Violation</Alert>
        </Center>
      ) : (
        children(show)
      )}
    </ImageGuardCtx.Provider>
  );
}

function BlurToggle({
  className,
  children,
  ...badgeProps
}: Omit<BadgeProps, 'children'> & {
  children?: (toggle: (e: React.MouseEvent<HTMLElement, MouseEvent>) => void) => React.ReactElement;
}) {
  const currentUser = useCurrentUser();
  const { safe, show, browsingLevel, imageId, key } = useImageGuardContext();
  const { classes, cx } = useStyles();

  if (safe) return null;

  const toggle = (event: React.MouseEvent<HTMLElement, MouseEvent>) =>
    toggleShow({ event, isAuthed: !!currentUser, key, imageId });

  if (children) {
    return children(toggle);
  }

  return (
    <Badge
      component="button"
      className={cx(classes.badge, className)}
      {...badgeProps}
      onClick={toggle}
    >
      <Group spacing={5} noWrap>
        <Text className={classes.text} component="span" weight="bold">
          {browsingLevelLabels[browsingLevel]}
        </Text>
        {show ? (
          <IconEyeOff size={14} strokeWidth={2.5} />
        ) : (
          <IconEye size={14} strokeWidth={2.5} />
        )}
      </Group>
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

const useStyles = createStyles((theme) => ({
  badge: {
    cursor: 'pointer',
    userSelect: 'none',
    backgroundColor: theme.fn.rgba(theme.colors.red[9], 0.6),
    color: 'white',
    backdropFilter: 'blur(7px)',
    boxShadow: '1px 2px 3px -1px rgba(37,38,43,0.2)',
  },
  text: {
    whiteSpace: 'nowrap',
    borderRight: '1px solid rgba(0,0,0,.15)',
    boxShadow: '0 1px 0 1px rgba(255,255,255,.1)',
    paddingRight: 5,
    lineHeight: 1,
  },
}));

ImageGuard2.BlurToggle = BlurToggle;
