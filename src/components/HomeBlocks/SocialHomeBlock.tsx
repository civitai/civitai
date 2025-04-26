import { ActionIcon, Box, Group, Popover, Stack, Text, Title } from '@mantine/core';
import { useDebouncedState } from '@mantine/hooks';
import { IconChevronLeft, IconChevronRight, IconInfoCircle } from '@tabler/icons-react';
import { useCallback, useMemo, useRef } from 'react';
import { CustomMarkdown } from '~/components/Markdown/CustomMarkdown';
import { SocialBlock, SocialBlockProps } from '~/components/HomeBlocks/components/SocialBlock';
import { useHomeBlockStyles } from '~/components/HomeBlocks/HomeBlock.Styles';
import { HomeBlockWrapper } from '~/components/HomeBlocks/HomeBlockWrapper';
import { useMasonryContext } from '~/components/MasonryColumns/MasonryProvider';
import { SocialLinks } from '~/components/SocialLinks/SocialLinks';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { useIsLive } from '~/hooks/useIsLive';
import { HomeBlockMetaSchema } from '~/server/schema/home-block.schema';
import classes from './SocialHomeBlock.module.scss';

export const SocialHomeBlock = ({ showAds, ...props }: Props) => {
  if (!props.metadata.socials?.length) return null;

  return (
    <HomeBlockWrapper py={32}>
      <SocialHomeBlockContent {...props} />
    </HomeBlockWrapper>
  );
};

const SocialHomeBlockContent = ({ metadata }: Props) => {
  const currentUser = useCurrentUser();
  const { classes: homeBlockClasses } = useHomeBlockStyles();

  const socialData = metadata.socials;
  const itemCount = socialData?.length ?? 0;
  const isLive = useIsLive();
  const { columnWidth, columnGap, columnCount } = useMasonryContext();

  // ---------------------
  // Snap Scrolling with buttons
  // ---------------------
  const [{ atStart, atEnd }, setScrollState] = useDebouncedState<{
    atStart: boolean;
    atEnd: boolean;
  }>({ atStart: true, atEnd: itemCount <= columnCount }, 300);
  const viewportRef = useRef<HTMLDivElement>(null);
  const scroll = useCallback(
    (dir: 'right' | 'left') => {
      if (!viewportRef.current) return;
      const scrollValue = (columnWidth + columnGap) * (dir === 'right' ? 1 : -1) * columnCount;
      const dest = viewportRef.current.scrollLeft + scrollValue;

      let nearestSnap = Math.round(dest / (columnWidth + columnGap)) * (columnWidth + columnGap);
      if (nearestSnap < 0) nearestSnap = 0;
      else if (nearestSnap > viewportRef.current.scrollWidth)
        nearestSnap = viewportRef.current.scrollWidth;

      viewportRef.current.scrollTo({
        left: nearestSnap,
        behavior: 'smooth',
      });
    },
    [viewportRef, columnWidth, columnGap, columnCount]
  );
  const onScroll = useCallback(
    ({ currentTarget }: React.UIEvent<HTMLDivElement>) => {
      const atStart = currentTarget.scrollLeft === 0;
      const atEnd =
        currentTarget.scrollLeft >= currentTarget.scrollWidth - currentTarget.offsetWidth;
      setScrollState({ atStart, atEnd });
    },
    [setScrollState]
  );

  const MetaDataTop = (
    <Stack spacing="sm">
      <Group spacing="xs" position="apart">
        <Group noWrap>
          <Title className={homeBlockClasses.title} order={1} lineClamp={1}>
            {metadata.title}{' '}
          </Title>
          {!metadata.descriptionAlwaysVisible && currentUser && metadata.description && (
            <Popover withArrow width={380}>
              <Popover.Target>
                <Box
                  display="inline-block"
                  sx={{ lineHeight: 0.3, cursor: 'pointer' }}
                  color="white"
                >
                  <IconInfoCircle size={20} />
                </Box>
              </Popover.Target>
              <Popover.Dropdown maw="100%">
                <Text weight={500} size="lg" mb="xs">
                  {metadata.title}
                </Text>
                {metadata.description && (
                  <Text size="sm" mb="xs">
                    <CustomMarkdown allowedElements={['a']} unwrapDisallowed>
                      {metadata.description}
                    </CustomMarkdown>
                  </Text>
                )}
                <Group spacing={4}>
                  <SocialLinks />
                </Group>
              </Popover.Dropdown>
            </Popover>
          )}
        </Group>
        <Group spacing={4}>
          <SocialLinks include={['instagram', 'youtube', 'twitter']} size={36} iconSize={28} />
        </Group>
      </Group>
      {metadata.description && (metadata.descriptionAlwaysVisible || !currentUser) && (
        <Text>
          <CustomMarkdown allowedElements={['a']} unwrapDisallowed>
            {metadata.description}
          </CustomMarkdown>
        </Text>
      )}
    </Stack>
  );

  const blocks = useMemo(() => {
    const blocks: SocialBlockProps[] = socialData ?? [];
    if (typeof window === 'undefined') return blocks;
    if (isLive) {
      blocks.unshift({
        type: 'twitch',
        url: 'civitai',
      });
    }
    return blocks;
  }, [socialData, isLive]);

  return (
    <Stack spacing="xl">
      {MetaDataTop}
      <div className={classes.container}>
        <div className={classes.scrollArea} ref={viewportRef} onScroll={onScroll}>
          <div
            className={classes.grid}
            style={
              {
                '--column-gap': `${columnGap}px`,
                '--column-width': `${columnWidth}px`,
              } as React.CSSProperties
            }
          >
            {blocks.map((block) => (
              <SocialBlock key={block.url} {...block} />
            ))}
          </div>
        </div>
        {!atStart && (
          <ActionIcon
            className={classes.nextButton}
            size="lg"
            radius="xl"
            variant="filled"
            onClick={() => scroll('left')}
            style={{ left: 0, top: '50%', transform: 'translateY(-50%)' }}
          >
            <IconChevronLeft size={20} />
          </ActionIcon>
        )}
        {!atEnd && (
          <ActionIcon
            className={classes.nextButton}
            size="lg"
            radius="xl"
            variant="filled"
            onClick={() => scroll('right')}
            style={{ right: 0, top: '50%', transform: 'translateY(-50%)' }}
          >
            <IconChevronRight size={20} />
          </ActionIcon>
        )}
      </div>
    </Stack>
  );
};

type Props = { metadata: HomeBlockMetaSchema; showAds?: boolean };

