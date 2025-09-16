import type { BadgeProps } from '@mantine/core';
import { Alert, Badge, Button, Text } from '@mantine/core';
import { IconEye, IconEyeOff } from '@tabler/icons-react';
import clsx from 'clsx';
import Router from 'next/router';
import React, { createContext, useCallback, useContext } from 'react';
import { create } from 'zustand';
import { useBrowsingLevelContext } from '~/components/BrowsingLevel/BrowsingLevelProvider';
import ConfirmDialog from '~/components/Dialog/Common/ConfirmDialog';
import { openSetBrowsingLevelModal } from '~/components/Dialog/dialog-registry';
import { dialogStore } from '~/components/Dialog/dialogStore';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { constants } from '~/server/common/constants';
import { NsfwLevel } from '~/server/common/enums';
import {
  browsingLevelLabels,
  getIsSafeBrowsingLevel,
  nsfwBrowsingLevelsFlag,
} from '~/shared/constants/browsingLevel.constants';
import { Flags } from '~/shared/utils/flags';
import { useImageStore } from '~/store/image.store';
import classes from './ImageGuard.module.css';

type ImageProps = {
  id: number;
  nsfwLevel?: number;
  userId?: number;
  user?: { id: number };
  url?: string | null;
};

type ConnectId = string | number;
export type ConnectType =
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
  const { blurLevels } = useBrowsingLevelContext();
  const showImage = useShowImagesStore(useCallback((state) => state[image.id], [image.id]));
  const key = getConnectionKey({ connectType, connectId });
  const { nsfwLevel = 0, ...rest } = useImageStore(image);
  const blurNsfw = Flags.hasFlag(blurLevels, nsfwLevel);

  const showConnect = useShowConnectionStore(
    useCallback((state) => (key ? state[key] : undefined), [key])
  );

  const userId = image.userId ?? image.user?.id;
  const showUnprocessed = !nsfwLevel && (currentUser?.isModerator || userId === currentUser?.id);
  const nsfw = Flags.hasFlag(nsfwBrowsingLevelsFlag, nsfwLevel);
  const shouldBlur = blurNsfw && !showUnprocessed;
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
  inView,
  ...connectProps
}: {
  image: ImageProps;
  children: (show: boolean) => React.ReactElement | null;
  explain?: boolean;
  inView?: boolean;
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
        inView={inView}
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
  inView,
}: {
  show: boolean;
  explain?: boolean;
  browsingLevel: number;
  tosViolation?: boolean;
  children: React.ReactNode;
  inView?: boolean;
}) {
  return (
    <>
      {(inView === undefined || inView) && !show && explain && (
        <BlurToggle>
          {(toggle) => (
            <div
              className="pointer-events-none absolute left-1/2 top-1/2 z-20 flex flex-col items-center gap-2 text-white"
              style={{ transform: 'translate(-50%, -60%)' }}
            >
              <Text size="sm" className="shadow-black/50 text-shadow-sm">
                This image is rated
              </Text>
              <Badge
                color="red"
                size="xl"
                classNames={{ root: getBrowsingLevelClass(classes.root, browsingLevel) }}
                className="min-w-[32px] text-center shadow shadow-black/30"
              >
                {browsingLevelLabels[browsingLevel as NsfwLevel]}
              </Badge>
              <Button className={classes.showButton} onClick={toggle} radius="xl">
                Show
              </Button>
            </div>
          )}
        </BlurToggle>
      )}
      {tosViolation ? (
        <div className="flex size-full items-center justify-center">
          <Alert color="red">TOS Violation</Alert>
        </div>
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
  const nsfw = Flags.hasFlag(nsfwBrowsingLevelsFlag, browsingLevel ?? NsfwLevel.XXX);

  const badgeClass = clsx(className, {
    [sfwClassName ? sfwClassName : '']: !nsfw,
    [nsfwClassName ? nsfwClassName : '']: nsfw,
  });

  return (
    <Badge
      classNames={{ root: getBrowsingLevelClass(classes.root, browsingLevel) }}
      className={badgeClass}
      {...badgeProps}
    >
      {browsingLevelLabels[browsingLevel as NsfwLevel] ?? '?'}
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

  const toggle = (event: React.MouseEvent<HTMLElement, MouseEvent>) =>
    toggleShow({ event, isAuthed: !!currentUser, key, imageId });

  if (children) {
    return children(toggle);
  }

  if (!browsingLevel) return null;

  const badgeClass = clsx(className, {
    [sfwClassName ? sfwClassName : '']: !nsfw,
    [nsfwClassName ? nsfwClassName : '']: nsfw,
  });

  if (safe || alwaysVisible) {
    const isOwnerOrModerator = currentUser?.isModerator || (userId && currentUser?.id === userId);
    return isOwnerOrModerator || alwaysVisible ? (
      <Badge
        classNames={{ root: getBrowsingLevelClass(classes.root, browsingLevel) }}
        className={badgeClass}
        onClick={
          isOwnerOrModerator
            ? (e: React.MouseEvent) => {
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
      classNames={{ ...classNames, root: getBrowsingLevelClass(classes.root, browsingLevel) }}
      className={clsx(badgeClass, 'pointer-events-auto cursor-pointer')}
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
          <Text size="sm" fw={500} style={{ flex: 1 }}>
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

function getBrowsingLevelClass(className?: string, browsingLevel?: number) {
  return clsx(className, { [classes.red]: !getIsSafeBrowsingLevel(browsingLevel ?? 0) });
}
