import {
  Box,
  Button,
  Group,
  ScrollArea,
  ThemeIcon,
  useComputedColorScheme,
  useMantineTheme,
} from '@mantine/core';
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
import classes from './ModelVersionList.module.scss';
import clsx from 'clsx';
import { LegacyActionIcon } from '~/components/LegacyActionIcon/LegacyActionIcon';
import { ModelStatus } from '~/shared/utils/prisma/enums';

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
  const router = useRouter();
  const currentUser = useCurrentUser();
  const features = useFeatureFlags();
  const theme = useMantineTheme();
  const colorScheme = useComputedColorScheme('dark');

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
      <Box className={clsx(classes.leftArrow, state.atStart && classes.hidden)}>
        <LegacyActionIcon
          className={classes.arrowButton}
          variant="transparent"
          radius="xl"
          onClick={scrollLeft}
        >
          <IconChevronLeft />
        </LegacyActionIcon>
      </Box>
      <Group gap={4} wrap="nowrap">
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
              variant={active ? 'filled' : colorScheme === 'dark' ? 'filled' : 'light'}
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
              leftSection={
                showExtraIcons && (hasProblem || scheduled) ? (
                  <ThemeIcon
                    color="yellow"
                    variant="light"
                    radius="xl"
                    size="sm"
                    style={{ backgroundColor: 'transparent' }}
                  >
                    {hasProblem ? <IconAlertTriangle size={14} /> : <IconClock size={14} />}
                  </ThemeIcon>
                ) : undefined
              }
              size="compact-sm"
              style={
                isEarlyAccess
                  ? {
                      borderTopRightRadius: 0,
                      borderBottomRightRadius: 0,
                    }
                  : undefined
              }
            >
              <Group gap={8} wrap="nowrap">
                {features.imageGeneration &&
                  version.canGenerate &&
                  version.status !== ModelStatus.Draft && (
                    <ThemeIcon
                      title="This version is available for image generation"
                      color="cyan"
                      variant="light"
                      radius="xl"
                      size="sm"
                      style={{ backgroundColor: 'transparent' }}
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
              <Group key={version.id} gap={0} wrap="nowrap">
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
        className={clsx(
          classes.rightArrow,
          (state.atEnd || !state.largerThanViewport) && classes.hidden
        )}
      >
        <LegacyActionIcon
          className={classes.arrowButton}
          variant="transparent"
          radius="xl"
          onClick={scrollRight}
        >
          <IconChevronRight />
        </LegacyActionIcon>
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
