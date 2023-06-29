import {
  ActionIcon,
  Box,
  Button,
  Group,
  Menu,
  ScrollArea,
  ThemeIcon,
  createStyles,
} from '@mantine/core';
import { NextLink } from '@mantine/next';
import {
  IconAlertTriangle,
  IconBan,
  IconBrush,
  IconChevronLeft,
  IconChevronRight,
  IconClock,
  IconDotsVertical,
  IconEdit,
  IconFileSettings,
  IconPhotoEdit,
  IconTrash,
} from '@tabler/icons-react';
import { useRouter } from 'next/router';
import { useEffect, useRef, useState } from 'react';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { openContext } from '~/providers/CustomModalsProvider';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';

import { openRoutedContext } from '~/providers/RoutedContextProvider';
import { ModelById } from '~/types/router';

const useStyles = createStyles((theme) => ({
  scrollContainer: { position: 'relative' },

  arrowButton: {
    '&:active': {
      transform: 'none',
    },
  },

  hidden: {
    display: 'none !important',
  },

  leftArrow: {
    display: 'none',
    position: 'absolute',
    left: 0,
    top: '50%',
    transform: 'translateY(-50%)',
    paddingRight: theme.spacing.xl,
    zIndex: 12,
    backgroundImage: theme.fn.gradient({
      from: theme.colorScheme === 'dark' ? theme.colors.dark[7] : 'white',
      to: 'transparent',
      deg: 90,
    }),

    [theme.fn.largerThan('md')]: {
      display: 'block',
    },
  },
  rightArrow: {
    display: 'none',
    position: 'absolute',
    right: 0,
    top: '50%',
    transform: 'translateY(-50%)',
    paddingLeft: theme.spacing.xl,
    zIndex: 12,
    backgroundImage: theme.fn.gradient({
      from: theme.colorScheme === 'dark' ? theme.colors.dark[7] : 'white',
      to: 'transparent',
      deg: 270,
    }),

    [theme.fn.largerThan('md')]: {
      display: 'block',
    },
  },
  viewport: {
    overflowX: 'scroll',
    overflowY: 'hidden',
  },
}));

type State = {
  scrollPosition: { x: number; y: number };
  atStart: boolean;
  atEnd: boolean;
  largerThanViewport: boolean;
};

export function ModelVersionList({
  versions,
  selected,
  showExtraIcons,
  onVersionClick,
  onDeleteClick,
}: Props) {
  const { classes, cx, theme } = useStyles();
  const router = useRouter();
  const currentUser = useCurrentUser();
  const features = useFeatureFlags();

  const viewportRef = useRef<HTMLDivElement>(null);
  const [state, setState] = useState<State>({
    scrollPosition: { x: 0, y: 0 },
    atStart: true,
    atEnd: false,
    largerThanViewport: false,
  });

  const scrollLeft = () => viewportRef.current?.scrollBy({ left: -200, behavior: 'smooth' });
  const scrollRight = () => viewportRef.current?.scrollBy({ left: 200, behavior: 'smooth' });

  useEffect(() => {
    if (viewportRef.current) {
      const newValue = viewportRef.current.scrollWidth > viewportRef.current.offsetWidth;

      if (newValue !== state.largerThanViewport)
        setState((state) => ({ ...state, largerThanViewport: newValue }));
    }
  }, [state.largerThanViewport]);

  return (
    <ScrollArea
      className={classes.scrollContainer}
      classNames={classes}
      viewportRef={viewportRef}
      onScrollPositionChange={(scrollPosition) =>
        setState((state) => ({
          ...state,
          scrollPosition,
          largerThanViewport:
            !!viewportRef.current &&
            viewportRef.current.scrollWidth > viewportRef.current.offsetWidth,
          atStart: scrollPosition.x === 0,
          atEnd:
            !!viewportRef.current &&
            scrollPosition.x >=
              viewportRef.current.scrollWidth - viewportRef.current.offsetWidth - 1,
        }))
      }
      type="never"
    >
      <Box className={cx(classes.leftArrow, state.atStart && classes.hidden)}>
        <ActionIcon
          className={classes.arrowButton}
          variant="transparent"
          radius="xl"
          onClick={scrollLeft}
        >
          <IconChevronLeft />
        </ActionIcon>
      </Box>
      <Group spacing={4} noWrap>
        {versions.map((version) => {
          const active = selected === version.id;
          const missingFiles = !version.files.length;
          const missingPosts = !version.posts.length;
          const published = version.status === 'Published';
          const scheduled = version.status === 'Scheduled';
          const hasProblem = missingFiles || missingPosts || (!published && !scheduled);

          const versionButton = (
            <Button
              key={version.id}
              miw={40}
              ta="center"
              variant={active ? 'filled' : theme.colorScheme === 'dark' ? 'filled' : 'light'}
              color={active ? 'blue' : 'gray'}
              onClick={() => {
                if (showExtraIcons) {
                  if (missingFiles)
                    return router.push(
                      `/models/${version.modelId}/model-versions/${version.id}/wizard?step=2`
                    );
                  if (missingPosts)
                    return router.push(
                      `/models/${version.modelId}/model-versions/${version.id}/wizard?step=3`
                    );
                }

                return onVersionClick(version);
              }}
              leftIcon={
                showExtraIcons && (hasProblem || scheduled) ? (
                  <ThemeIcon
                    color="yellow"
                    variant="light"
                    radius="xl"
                    size="sm"
                    sx={{ backgroundColor: 'transparent' }}
                  >
                    {hasProblem ? <IconAlertTriangle size={14} /> : <IconClock size={14} />}
                  </ThemeIcon>
                ) : undefined
              }
              compact
            >
              <Group spacing={8}>
                {features.imageGeneration && version.canGenerate && (
                  <ThemeIcon
                    title="This version is available for image generation"
                    color="cyan"
                    variant="light"
                    radius="xl"
                    size="sm"
                    sx={{ backgroundColor: 'transparent' }}
                  >
                    <IconBrush size={16} stroke={2.5} />
                  </ThemeIcon>
                )}
                {version.name}
              </Group>
            </Button>
          );

          if (!showExtraIcons) return versionButton;

          return (
            <Button.Group key={version.id}>
              {versionButton}
              <Menu withinPortal>
                <Menu.Target>
                  <Button
                    variant={active ? 'filled' : theme.colorScheme === 'dark' ? 'filled' : 'light'}
                    px={4}
                    color={active ? 'blue' : 'gray'}
                    onClick={(e) => {
                      e.stopPropagation();
                      e.preventDefault();
                    }}
                    compact
                  >
                    <IconDotsVertical size={14} />
                  </Button>
                </Menu.Target>
                <Menu.Dropdown>
                  {versions.length > 1 && (
                    <Menu.Item
                      color="red"
                      icon={<IconTrash size={14} stroke={1.5} />}
                      onClick={(e) => {
                        e.stopPropagation();
                        e.preventDefault();
                        onDeleteClick(version.id);
                      }}
                    >
                      Delete version
                    </Menu.Item>
                  )}
                  {currentUser?.isModerator && published && (
                    <Menu.Item
                      color="yellow"
                      icon={<IconBan size={14} stroke={1.5} />}
                      onClick={() =>
                        openContext('unpublishModel', {
                          modelId: version.modelId,
                          versionId: version.id,
                        })
                      }
                    >
                      Unpublish as Violation
                    </Menu.Item>
                  )}
                  <Menu.Item
                    // component={NextLink}
                    icon={<IconEdit size={14} stroke={1.5} />}
                    onClick={(e) => {
                      e.stopPropagation();
                      openRoutedContext('modelVersionEdit', {
                        modelVersionId: version.id,
                      });
                    }}
                    // href={`/models/${version.modelId}/model-versions/${version.id}/edit`}
                  >
                    Edit details
                  </Menu.Item>
                  <Menu.Item
                    icon={<IconFileSettings size={14} stroke={1.5} />}
                    onClick={(e) => {
                      e.stopPropagation();
                      openRoutedContext('filesEdit', {
                        modelVersionId: version.id,
                      });
                    }}
                  >
                    Manage files
                  </Menu.Item>
                  {version.posts.length > 0 && (
                    <Menu.Item
                      component={NextLink}
                      icon={<IconPhotoEdit size={14} stroke={1.5} />}
                      onClick={(e) => e.stopPropagation()}
                      href={`/posts/${version.posts[0].id}/edit`}
                    >
                      Manage images
                    </Menu.Item>
                  )}
                </Menu.Dropdown>
              </Menu>
            </Button.Group>
          );
        })}
      </Group>
      <Box
        className={cx(
          classes.rightArrow,
          (state.atEnd || !state.largerThanViewport) && classes.hidden
        )}
      >
        <ActionIcon
          className={classes.arrowButton}
          variant="transparent"
          radius="xl"
          onClick={scrollRight}
        >
          <IconChevronRight />
        </ActionIcon>
      </Box>
    </ScrollArea>
  );
}

type Props = {
  versions: ModelById['modelVersions'];
  onVersionClick: (version: ModelById['modelVersions'][number]) => void;
  onDeleteClick: (versionId: number) => void;
  selected?: number;
  showExtraIcons?: boolean;
};
