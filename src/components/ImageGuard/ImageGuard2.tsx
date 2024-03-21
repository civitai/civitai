import { Badge, BadgeProps, Text, createStyles, Center, Alert, Button, Stack } from '@mantine/core';
import { IconEye, IconEyeOff } from '@tabler/icons-react';
import Router from 'next/router';
import React, { createContext, useCallback, useContext, useMemo } from 'react';
import { create } from 'zustand';
import { ConfirmDialog } from '~/components/Dialog/Common/ConfirmDialog';
import { dialogStore } from '~/components/Dialog/dialogStore';
import { useHiddenPreferencesContext } from '~/components/HiddenPreferences/HiddenPreferencesProvider';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { getTagDisplayName } from '~/libs/tags';
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
  // tags?: number[];
  // tagIds?: number[];
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
  browsingLevel: NsfwLevel;
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
  explain = true,
}: {
  image: ImageProps;
  children: (show: boolean) => React.ReactElement | null;
  explain?: boolean;
} & ConnectProps) {
  const nsfwLevel = image.nsfwLevel ?? 0;
  const currentUser = useCurrentUser();
  const showImage = useShowImagesStore(useCallback((state) => state[image.id], [image.id]));
  const key = getConnectionKey({ connectType, connectId });
  const { classes } = useBadgeStyles({ browsingLevel: nsfwLevel });
  // Disable display of the moderated tags
  // const { moderatedTags } = useHiddenPreferencesContext();
  // const tags = useMemo(() => {
  //   const imageTags = image.tags ?? image.tagIds ?? [];
  //   return moderatedTags
  //     .filter((x) => x.nsfwLevel === nsfwLevel && imageTags.includes(x.id))
  //     .map((x) => getTagDisplayName(x.name));
  // }, [image.tags, image.tagIds, moderatedTags, nsfwLevel]);

  const { tosViolation } = useImageStore(image);

  const showConnect = useShowConnectionStore(
    useCallback((state) => (key ? state[key] : undefined), [key])
  );

  const userId = image.userId ?? image.user?.id;
  const showUnprocessed =
    !image.nsfwLevel && (currentUser?.isModerator || userId === currentUser?.id);
  const nsfw = Flags.hasFlag(nsfwBrowsingLevelsFlag, nsfwLevel);
  const shouldBlur = (currentUser?.blurNsfw ?? true) && !showUnprocessed;
  const safe = !nsfw ? true : !shouldBlur;
  const show = safe || (showConnect ?? showImage);

  return (
    <ImageGuardCtx.Provider
      value={{ safe, show, browsingLevel: nsfwLevel, imageId: image.id, key }}
    >
      {!show && explain && (
        <BlurToggle>
          {(toggle) => (
            <Center className="absolute z-10 transform -translate-x-1/2 -translate-y-[60%] top-1/2 left-1/2 flex flex-col w-full text-white">
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
                  {browsingLevelLabels[nsfwLevel as NsfwLevel]}
                </Badge>
                {/* {tags.length ? (
                  <Text
                    size="xs"
                    className="text-shadow-sm shadow-black/50 opacity-70 leading-tight text-center px-5"
                  >
                    {tags.join(', ')}
                  </Text>
                ) : null} */}
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
        children(show)
      )}
    </ImageGuardCtx.Provider>
  );
}

export function BrowsingLevelBadge({
  browsingLevel,
  ...badgeProps
}: {
  browsingLevel?: number;
} & BadgeProps) {
  const { classes } = useBadgeStyles({ browsingLevel });
  if (!browsingLevel) return null;

  return (
    <Badge classNames={classes} {...badgeProps}>
      {browsingLevelLabels[browsingLevel as NsfwLevel]}
    </Badge>
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
  const { classes, cx } = useBadgeStyles({ browsingLevel });

  const toggle = (event: React.MouseEvent<HTMLElement, MouseEvent>) =>
    toggleShow({ event, isAuthed: !!currentUser, key, imageId });

  if (children) {
    return children(toggle);
  }

  if (!browsingLevel) return null;

  if (safe)
    return currentUser?.isModerator ? (
      <Badge classNames={classes} className={className}>
        {browsingLevelLabels[browsingLevel]}
      </Badge>
    ) : null;

  const Icon = show ? (
    <IconEyeOff size={14} strokeWidth={2.5} />
  ) : (
    <IconEye size={14} strokeWidth={2.5} />
  );

  return (
    <Badge
      component="button"
      classNames={classes}
      className={cx(className, 'cursor-pointer')}
      {...badgeProps}
      onClick={toggle}
      // rightSection={withLabel ? Icon : null}
    >
      {/* {withLabel ? browsingLevelLabels[browsingLevel] : Icon} */}
      {Icon}
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
    ? theme.fn.rgba('#000', 0.31)
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
    rightSection: {
      borderLeft: '1px solid rgba(0,0,0,.15)',
      paddingLeft: 5,
      marginRight: -2,
    },
  };
});

ImageGuard2.BlurToggle = BlurToggle;
