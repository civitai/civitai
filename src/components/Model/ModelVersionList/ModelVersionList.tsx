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
  IconChevronLeft,
  IconChevronRight,
  IconClock,
} from '@tabler/icons-react';
import { acceptsBlueBuzz } from '@civitai/buzz';
import { paidAccessBuzzBackground } from '~/components/Model/ModelVersions/PaidAccessPriceBadge';
import { useRouter } from 'next/router';
import { useEffect, useRef, useState } from 'react';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import type { ModelById } from '~/types/router';
import { ModelVersionMenu } from '../ModelVersions/ModelVersionMenu';
import classes from './ModelVersionList.module.scss';
import clsx from 'clsx';
import { LegacyActionIcon } from '~/components/LegacyActionIcon/LegacyActionIcon';
import { ModelUsageControl } from '~/shared/utils/prisma/enums';
import {
  isAdditionalResourceFeeWaived,
  isEvictable,
  isGenerationDisabled,
} from '~/shared/constants/model-version-flags.constants';
import { LoadedMark } from '~/components/ResourceLoad/ResourceResidency';
import { generatorReadiness } from '~/shared/generation/generator-readiness';
import { ShellButton } from '~/components/AppLayout/ShellDs/ShellDs';

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
  ds: dsProp,
}: Props) {
  const router = useRouter();
  const currentUser = useCurrentUser();
  const features = useFeatureFlags();
  const theme = useMantineTheme();
  const colorScheme = useComputedColorScheme('dark');
  // The owner/moderator row joins each button to its `ModelVersionMenu` in a Mantine `Button.Group`,
  // whose radius rules select Mantine's button class, so that row stays on Mantine.
  const ds = !!dsProp && !showExtraIcons;

  const viewportRef = useRef<HTMLDivElement>(null);
  const selectedRef = useRef<HTMLButtonElement>(null);
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

  // Align the selected version near the start of the list (e.g. when deep-linked to a
  // non-primary version) so it's obvious instead of landing at the right edge. The
  // startPad clears the left scroll arrow; the first version clamps back to 0.
  // rAF lets layout settle before measuring.
  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      const el = selectedRef.current;
      const viewport = viewportRef.current;
      if (!el || !viewport) return;

      const startPad = 40;
      const delta =
        el.getBoundingClientRect().left - viewport.getBoundingClientRect().left - startPad;
      if (delta !== 0) viewport.scrollBy({ left: delta, behavior: 'smooth' });
    });

    return () => cancelAnimationFrame(frame);
  }, [selected, versions.length]);

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
      <ArrowBox ds={ds} className={clsx(classes.leftArrow, state.atStart && classes.hidden)}>
        <ArrowButton
          ds={ds}
          onClick={scrollLeft}
          aria-label="Scroll versions left"
          icon={<IconChevronLeft />}
        />
      </ArrowBox>
      <VersionRow ds={ds}>
        {versions.map((version) => {
          const active = selected === version.id;
          const isTraining = !!version.trainingStatus;
          const isExternalGeneration =
            version.usageControl === ModelUsageControl.ExternalGeneration;
          // ExternalGeneration versions are intentionally file-less (routed via external
          // engines), so missing files isn't a problem state for them.
          const missingFiles = !isExternalGeneration && !version.files.length;
          const missingPosts = !version.posts.length;
          const published = version.status === 'Published';
          const scheduled = version.status === 'Scheduled';
          const isEarlyAccess =
            version.paidAccess?.endsAt && new Date(version.paidAccess.endsAt) > new Date();
          const hasProblem = missingFiles || missingPosts || (!published && !scheduled);
          const earlyAccessStyle: React.CSSProperties = {
            // Coloured by the Buzz the gate takes, like the price chips on the buttons.
            background: paidAccessBuzzBackground({
              isGreen: features.isGreen,
              acceptsBlueBuzz: acceptsBlueBuzz(version.paidAccess?.terms),
            }),
            width: 20,
            height: 26,
            borderTopLeftRadius: 0,
            borderBottomLeftRadius: 0,
          };
          const earlyAccessButton = ds ? (
            <span
              key={`early-access-${version.id}`}
              className={classes.earlyAccessIcon}
              style={earlyAccessStyle}
            >
              <IconBolt style={{ fill: theme.white }} color="white" size={16} />
            </span>
          ) : (
            <ThemeIcon
              key={`early-access-${version.id}`}
              radius="sm"
              size="sm"
              style={{
                ...earlyAccessStyle,
                ...(showExtraIcons
                  ? {
                      borderTopRightRadius: 0,
                      borderBottomRightRadius: 0,
                    }
                  : {}),
              }}
            >
              <IconBolt style={{ fill: theme.white }} color="white" size={16} />
            </ThemeIcon>
          );

          const versionLabel = (
            <>
              {features.imageGeneration && generatorReadiness(version) !== 'cold' && (
                <LoadedMark readiness={generatorReadiness(version)} />
              )}
              {version.name}
            </>
          );

          const versionButton = ds ? (
            <ShellButton
              key={version.id}
              ref={active ? selectedRef : undefined}
              className="relative min-w-[calc(2.5rem*var(--mantine-scale))]"
              variant={
                active ? 'filled-blue' : colorScheme === 'dark' ? 'filled-gray' : 'light-gray'
              }
              size="compact-sm"
              onClick={() => onVersionClick(version)}
              style={
                isEarlyAccess ? { borderTopRightRadius: 0, borderBottomRightRadius: 0 } : undefined
              }
            >
              <span className="flex flex-row flex-nowrap items-center justify-start gap-[calc(0.5rem*var(--mantine-scale))]">
                {versionLabel}
              </span>
            </ShellButton>
          ) : (
            <Button
              key={version.id}
              ref={active ? selectedRef : undefined}
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
                {versionLabel}
              </Group>
            </Button>
          );

          if (ds)
            return (
              <div
                key={version.id}
                className="flex flex-row flex-nowrap items-center justify-start gap-0"
              >
                {versionButton} {isEarlyAccess && earlyAccessButton}
              </div>
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
                generationDisabled={isGenerationDisabled(version.flags ?? 0)}
                evictable={isEvictable(version.flags ?? 0)}
                additionalResourceFeeWaived={isAdditionalResourceFeeWaived(version.flags ?? 0)}
                showToggleCoverage={showToggleCoverage}
              />
            </Button.Group>
          );
        })}
      </VersionRow>
      <ArrowBox
        ds={ds}
        className={clsx(
          classes.rightArrow,
          (state.atEnd || !state.largerThanViewport) && classes.hidden
        )}
      >
        <ArrowButton
          ds={ds}
          onClick={scrollRight}
          aria-label="Scroll versions right"
          icon={<IconChevronRight />}
        />
      </ArrowBox>
    </ScrollArea>
  );
}

function ArrowBox({
  ds,
  className,
  children,
}: {
  ds: boolean;
  className: string;
  children: React.ReactNode;
}) {
  return ds ? (
    <div className={className}>{children}</div>
  ) : (
    <Box className={className}>{children}</Box>
  );
}

function ArrowButton({
  ds,
  onClick,
  icon,
  'aria-label': ariaLabel,
}: {
  ds: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  'aria-label': string;
}) {
  if (ds)
    return (
      <ShellButton
        className={classes.arrowButton}
        variant="transparent-gray"
        icon="md"
        radius="xl"
        onClick={onClick}
        aria-label={ariaLabel}
      >
        {icon}
      </ShellButton>
    );
  return (
    <LegacyActionIcon
      className={classes.arrowButton}
      variant="transparent"
      radius="xl"
      onClick={onClick}
      aria-label={ariaLabel}
    >
      {icon}
    </LegacyActionIcon>
  );
}

function VersionRow({ ds, children }: { ds: boolean; children: React.ReactNode }) {
  return ds ? (
    <div className="flex flex-row flex-nowrap items-center justify-start gap-[calc(0.25rem*var(--mantine-scale))]">
      {children}
    </div>
  ) : (
    <Group gap={4} wrap="nowrap">
      {children}
    </Group>
  );
}

type Props = {
  /** `@civitai/components` markup in place of Mantine (`modelPageDesignSystemMarkup`). */
  ds?: boolean;
  versions: ModelById['modelVersions'];
  onVersionClick: (version: ModelById['modelVersions'][number]) => void;
  selected?: number;
  showExtraIcons?: boolean;
  showToggleCoverage?: boolean;
};
