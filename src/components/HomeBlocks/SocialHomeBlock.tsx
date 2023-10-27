import { ActionIcon, Box, createStyles, Group, Popover, Stack, Text, Title } from '@mantine/core';
import { useDebouncedState } from '@mantine/hooks';
import { IconChevronLeft, IconChevronRight, IconInfoCircle } from '@tabler/icons-react';
import { useCallback, useRef } from 'react';
import ReactMarkdown from 'react-markdown';
import { SocialBlock } from '~/components/HomeBlocks/components/SocialBlock';
import { useHomeBlockStyles } from '~/components/HomeBlocks/HomeBlock.Styles';
import { HomeBlockWrapper } from '~/components/HomeBlocks/HomeBlockWrapper';
import { useMasonryContainerContext } from '~/components/MasonryColumns/MasonryContainer';
import { SocialLinks } from '~/components/SocialLinks/SocialLinks';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { HomeBlockMetaSchema } from '~/server/schema/home-block.schema';

const useStyles = createStyles<string, { columnWidth?: number; columnGap?: number }>(
  (theme, { columnGap, columnWidth }, getRef) => ({
    root: {
      paddingTop: '32px',
      paddingBottom: '32px',
    },

    carousel: {
      [theme.fn.smallerThan('sm')]: {
        marginRight: -theme.spacing.md,
        marginLeft: -theme.spacing.md,
      },
    },
    nextButton: {
      backgroundColor: `${theme.colors.gray[0]} !important`,
      color: theme.colors.dark[9],
      opacity: 0.65,
      transition: 'opacity 300ms ease',
      zIndex: 10,

      '&:hover': {
        opacity: 1,
      },

      [theme.fn.smallerThan('sm')]: {
        display: 'none',
      },
    },

    hidden: {
      display: 'none !important',
    },

    grid: {
      display: 'grid',
      gridAutoFlow: 'column',
      columnGap: columnGap,
      gridAutoColumns: columnWidth,
      gridTemplateRows: 'auto',
      gridAutoRows: 0,
      overflowX: 'visible',
      paddingBottom: 4,

      [theme.fn.smallerThan('sm')]: {
        marginRight: -theme.spacing.md,
        marginLeft: -theme.spacing.md,
        paddingLeft: theme.spacing.md,
      },
    },
    container: {
      position: 'relative',
      '&:hover': {
        [`& .${getRef('scrollArea')}`]: {
          '&::-webkit-scrollbar': {
            opacity: 1,
          },
          '&::-webkit-scrollbar-thumb': {
            backgroundColor:
              theme.colorScheme === 'dark'
                ? theme.fn.rgba(theme.white, 0.5)
                : theme.fn.rgba(theme.black, 0.5),
          },
        },
      },
    },
    scrollArea: {
      ref: getRef('scrollArea'),
      overflow: 'auto',
      scrollSnapType: 'x mandatory',
      '&::-webkit-scrollbar': {
        background: 'transparent',
        opacity: 0,
        height: 8,
      },
      '&::-webkit-scrollbar-thumb': {
        borderRadius: 4,
      },
    },
  })
);

export const SocialHomeBlock = ({ ...props }: Props) => {
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

  const socialData = metadata.socials ?? [];
  const itemCount = socialData.length;
  const { columnWidth, columnGap, columnCount } = useMasonryContainerContext();
  const { classes, cx } = useStyles({ columnWidth, columnGap });

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
                    <ReactMarkdown
                      allowedElements={['a']}
                      unwrapDisallowed
                      className="markdown-content"
                    >
                      {metadata.description}
                    </ReactMarkdown>
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
          <ReactMarkdown allowedElements={['a']} unwrapDisallowed className="markdown-content">
            {metadata.description}
          </ReactMarkdown>
        </Text>
      )}
    </Stack>
  );

  return (
    <>
      <Box mb="md" className={classes.meta}>
        {MetaDataTop}
      </Box>
      <div className={classes.container}>
        <div className={classes.scrollArea} ref={viewportRef} onScroll={onScroll}>
          <div className={classes.grid}>
            {socialData.map((block) => {
              return <SocialBlock key={block.url} {...block} />;
            })}
          </div>
        </div>
        <ActionIcon
          className={cx(classes.nextButton, { [classes.hidden]: atStart })}
          radius="xl"
          size="md"
          color="gray"
          p={4}
          sx={{ position: 'absolute', top: '50%', left: 10 }}
          onClick={() => scroll('left')}
        >
          <IconChevronLeft />
        </ActionIcon>
        <ActionIcon
          className={cx(classes.nextButton, { [classes.hidden]: atEnd })}
          radius="xl"
          size="md"
          color="gray"
          p={4}
          sx={{ position: 'absolute', top: '50%', right: 10 }}
          onClick={() => scroll('right')}
        >
          <IconChevronRight />
        </ActionIcon>
      </div>
    </>
  );
};

type Props = { metadata: HomeBlockMetaSchema };
