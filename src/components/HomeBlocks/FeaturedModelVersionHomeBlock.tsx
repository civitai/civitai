import {
  Anchor,
  AspectRatio,
  Box,
  Button,
  Group,
  Popover,
  Skeleton,
  Stack,
  Text,
  ThemeIcon,
  Title,
} from '@mantine/core';
import { IconArrowRight, IconCategory, IconInfoCircle } from '@tabler/icons-react';
import { Fragment, useMemo } from 'react';
import { ModelCard } from '~/components/Cards/ModelCard';
import { useApplyHiddenPreferences } from '~/components/HiddenPreferences/useApplyHiddenPreferences';
import {
  useHomeBlockGridStyles,
  useHomeBlockStyles,
} from '~/components/HomeBlocks/HomeBlock.Styles';
import { HomeBlockWrapper } from '~/components/HomeBlocks/HomeBlockWrapper';
import { ImagesProvider } from '~/components/Image/Providers/ImagesProvider';
import { CustomMarkdown } from '~/components/Markdown/CustomMarkdown';
import { NextLink as Link } from '~/components/NextLink/NextLink';
import { ReactionSettingsProvider } from '~/components/Reaction/ReactionSettingsProvider';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { HomeBlockMetaSchema } from '~/server/schema/home-block.schema';
import { shuffle } from '~/utils/array-helpers';
import { trpc } from '~/utils/trpc';

type Props = { homeBlockId: number; metadata: HomeBlockMetaSchema; showAds?: boolean };

export const FeaturedModelVersionHomeBlock = ({ showAds, ...props }: Props) => {
  return (
    <HomeBlockWrapper py={32}>
      <FeaturedModelVersionHomeBlockContent {...props} />
    </HomeBlockWrapper>
  );
};

const ITEMS_PER_ROW = 7;
const FeaturedModelVersionHomeBlockContent = ({ homeBlockId, metadata }: Props) => {
  const { data: homeBlock, isLoading } = trpc.homeBlock.getHomeBlock.useQuery(
    { id: homeBlockId },
    { trpc: { context: { skipBatch: true } } }
  );

  const rows = metadata.collection?.rows ?? 2;

  const { classes: homeBlockClasses } = useHomeBlockStyles();
  const currentUser = useCurrentUser();

  const { featuredModels } = homeBlock ?? {};

  const shuffled = useMemo(() => {
    if (!featuredModels) return [];
    return shuffle(featuredModels);
  }, [featuredModels]);

  const { loadingPreferences, items: filtered } = useApplyHiddenPreferences({
    type: `models`,
    data: shuffled,
  });

  const items = useMemo(() => {
    const itemsToShow = ITEMS_PER_ROW * rows;
    return filtered.slice(0, itemsToShow);
  }, [filtered, rows]);

  const { classes, cx } = useHomeBlockGridStyles({
    count: items.length ?? 0,
    rows,
  });

  const title = metadata.title ?? 'Boosted Models';

  const MetaDataTop = (
    <Stack spacing="sm">
      <Group spacing="xs" position="apart" className={homeBlockClasses.header}>
        <Group noWrap>
          <Title className={homeBlockClasses.title} order={1} lineClamp={1}>
            {title}{' '}
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
                  {title}
                </Text>
                {metadata.description && (
                  <Text size="sm" mb="xs">
                    <CustomMarkdown allowedElements={['a']} unwrapDisallowed>
                      {metadata.description}
                    </CustomMarkdown>
                  </Text>
                )}
                {metadata.link && (
                  <Link legacyBehavior href={metadata.link} passHref>
                    <Anchor size="sm">
                      <Group spacing={4}>
                        <Text inherit>{metadata.linkText ?? 'View All'} </Text>
                        <IconArrowRight size={16} />
                      </Group>
                    </Anchor>
                  </Link>
                )}
              </Popover.Dropdown>
            </Popover>
          )}
        </Group>
        {metadata.link && (
          <Link legacyBehavior href={metadata.link} passHref>
            <Button
              className={homeBlockClasses.expandButton}
              component="a"
              variant="subtle"
              rightIcon={<IconArrowRight size={16} />}
            >
              {metadata.linkText ?? 'View All'}
            </Button>
          </Link>
        )}
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

  const MetaDataGrid = (
    <Stack justify="center">
      <Group align="center">
        {metadata.withIcon && (
          <ThemeIcon size={50} variant="light" color="gray">
            <IconCategory />
          </ThemeIcon>
        )}
        <Title className={homeBlockClasses.title} order={1} lineClamp={1}>
          {title}
        </Title>
      </Group>
      {metadata.description && (
        <Text maw={520}>
          <CustomMarkdown allowedElements={['a']} unwrapDisallowed>
            {metadata.description}
          </CustomMarkdown>
        </Text>
      )}
      {metadata.link && (
        <div>
          <Link legacyBehavior href={metadata.link} passHref>
            <Button
              size="md"
              component="a"
              variant="light"
              color="gray"
              rightIcon={<IconArrowRight size={16} />}
            >
              {metadata.linkText ?? 'View All'}
            </Button>
          </Link>
        </div>
      )}
    </Stack>
  );

  const useGrid =
    metadata.description &&
    !metadata.stackedHeader &&
    (!currentUser || metadata.descriptionAlwaysVisible);

  return (
    <>
      <Box mb="md" className={cx({ [classes.meta]: useGrid })}>
        {MetaDataTop}
      </Box>
      {isLoading || loadingPreferences ? (
        <div className={classes.grid}>
          {useGrid && <div className={classes.gridMeta}>{MetaDataGrid}</div>}
          {Array.from({ length: ITEMS_PER_ROW * rows }).map((_, index) => (
            <AspectRatio ratio={7 / 9} key={index} className="m-2">
              <Skeleton width="100%" />
            </AspectRatio>
          ))}
        </div>
      ) : (
        <div className={classes.grid}>
          <ImagesProvider hideReactionCount={false} images={undefined}>
            <ReactionSettingsProvider
              settings={{
                hideReactionCount: false,
                hideReactions: false,
              }}
            >
              {useGrid && <div className={classes.gridMeta}>{MetaDataGrid}</div>}
              {items.map((item) => (
                <div key={item.id} className="p-2">
                  <ModelCard data={item} />
                </div>
              ))}
            </ReactionSettingsProvider>
          </ImagesProvider>
        </div>
      )}

      {metadata.footer && (
        <Stack mt="md">
          <Text size="sm" mb="xs">
            <CustomMarkdown allowedElements={['a']} unwrapDisallowed>
              {metadata.footer}
            </CustomMarkdown>
          </Text>
        </Stack>
      )}
    </>
  );
};
