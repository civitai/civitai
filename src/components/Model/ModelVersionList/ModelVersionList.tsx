import { ActionIcon, Box, Button, createStyles, Group, ScrollArea, ThemeIcon } from '@mantine/core';
import {
  IconAlertTriangle,
  IconBolt,
  IconBrush,
  IconChevronLeft,
  IconChevronRight,
  IconClock,
} from '@tabler/icons-react';
import { useRouter } from 'next/router';
import { useEffect, useRef, useState } from 'react';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import type { ModelById } from '~/types/router';
import { ModelVersionMenu } from '../ModelVersions/ModelVersionMenu';

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
    display: 'block',
  },
  rightArrow: {
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
    display: 'block',
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
  showToggleCoverage = false,
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
          const isTraining = !!version.trainingStatus;
          const missingFiles = !version.files.length;
          const missingPosts = !version.posts.length;
          const published = version.status === 'Published';
          const scheduled = version.status === 'Scheduled';
          const isEarlyAccess =
            version.earlyAccessEndsAt && new Date(version.earlyAccessEndsAt) > new Date();
          const hasProblem = missingFiles || missingPosts || (!published && !scheduled);
          const earlyAccessButton = (
            <ThemeIcon
              key={`early-access-${version.id}`}
              radius="sm"
              size="sm"
              color="yellow.7"
              style={{
                width: 20,
                height: 26,
                borderTopLeftRadius: 0,
                borderBottomLeftRadius: 0,
                ...(showExtraIcons
                  ? {
                      borderTopRightRadius: 0,
                      borderBottomRightRadius: 0,
                    }
                  : {}),
              }}
            >
              <IconBolt style={{ fill: theme.colors.dark[9] }} color="dark.9" size={16} />
            </ThemeIcon>
          );

          const versionButton = (
            <Button
              key={version.id}
              miw={40}
              ta="center"
              className="relative"
              variant={active ? 'filled' : theme.colorScheme === 'dark' ? 'filled' : 'light'}
              color={active ? 'blue' : 'gray'}
              onClick={() => {
                if (showExtraIcons && !currentUser?.isModerator) {
                  if (!published && isTraining) {
                    return router.push(
                      `/models/${version.modelId}/model-versions/${version.id}/wizard?step=1`
                    );
                  }

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
              style={
                isEarlyAccess
                  ? {
                      borderTopRightRadius: 0,
                      borderBottomRightRadius: 0,
                    }
                  : undefined
              }
            >
              <Group spacing={8} noWrap>
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

          if (!showExtraIcons)
            return (
              <Group key={version.id} spacing={0} noWrap>
                {versionButton} {isEarlyAccess && earlyAccessButton}
              </Group>
            );

          return (
            <Button.Group key={version.id}>
              {versionButton}
              {isEarlyAccess && earlyAccessButton}
              <ModelVersionMenu
                modelVersionId={version.id}
                modelId={version.modelId}
                postId={version.posts?.[0]?.id}
                canDelete={versions.length > 1}
                active={active}
                published={published}
                canGenerate={version.canGenerate}
                showToggleCoverage={showToggleCoverage}
              />
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
  selected?: number;
  showExtraIcons?: boolean;
  showToggleCoverage?: boolean;
};
