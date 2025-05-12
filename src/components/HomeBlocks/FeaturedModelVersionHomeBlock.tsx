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
import { useMemo } from 'react';
import { ModelCard } from '~/components/Cards/ModelCard';
import { useApplyHiddenPreferences } from '~/components/HiddenPreferences/useApplyHiddenPreferences';

import { HomeBlockWrapper } from '~/components/HomeBlocks/HomeBlockWrapper';
import { ImagesProvider } from '~/components/Image/Providers/ImagesProvider';
import { CustomMarkdown } from '~/components/Markdown/CustomMarkdown';
import { NextLink as Link } from '~/components/NextLink/NextLink';
import { ReactionSettingsProvider } from '~/components/Reaction/ReactionSettingsProvider';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { HomeBlockMetaSchema } from '~/server/schema/home-block.schema';
import { shuffle } from '~/utils/array-helpers';
import { trpc } from '~/utils/trpc';
import classes from '~/components/HomeBlocks/HomeBlock.module.scss';

type Props = { homeBlockId: number; metadata: Pick<HomeBlockMetaSchema, 'title' | 'description'> };

export const FeaturedModelVersionHomeBlock = ({ ...props }: Props) => {
  return (
    <HomeBlockWrapper py={32}>
      <FeaturedModelVersionHomeBlockContent {...props} />
    </HomeBlockWrapper>
  );
};

const ROWS = 2;
const ITEMS_PER_ROW = 7;

const FeaturedModelVersionHomeBlockContent = ({ homeBlockId, metadata }: Props) => {
  const features = useFeatureFlags();
  const currentUser = useCurrentUser();

  const { data: homeBlock, isLoading } = trpc.homeBlock.getHomeBlock.useQuery(
    { id: homeBlockId },
    { trpc: { context: { skipBatch: true } } }
  );

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
    const itemsToShow = ITEMS_PER_ROW * ROWS;
    return filtered.slice(0, itemsToShow);
  }, [filtered]);
 

  const title = metadata.title ?? 'Featured Models';
  const useGrid = metadata.description && !currentUser;

  const MetaDataTop = (
    <Stack
      gap="sm"
      style={{
        '--count': items.length ?? 0,
        '--rows': ROWS,
      }}
    >
      <Group gap="xs" justify="space-between" className={classes.header}>
        <Group wrap="nowrap">
          <Title className={classes.title} order={1} lineClamp={1}>
            {title}{' '}
          </Title>
          {currentUser && metadata.description && (
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
                <Group gap="sm">
                  <Link legacyBehavior href="/models" passHref>
                    <Anchor size="sm">
                      <Group gap={4}>
                        <Text inherit>Explore all models</Text>
                        <IconArrowRight size={16} />
                      </Group>
                    </Anchor>
                  </Link>
                  {features.auctions && (
                    <Link legacyBehavior href="/auctions" passHref>
                      <Anchor size="sm">
                        <Group gap={4}>
                          <Text inherit>View auctions</Text>
                          <IconArrowRight size={16} />
                        </Group>
                      </Anchor>
                    </Link>
                  )}
                </Group>
              </Popover.Dropdown>
            </Popover>
          )}
        </Group>
        <Link legacyBehavior href="/models" passHref>
          <Button
            className={classes.expandButton}
            component="a"
            variant="subtle"
            rightIcon={<IconArrowRight size={16} />}
          >
            Explore all models
          </Button>
        </Link>
      </Group>
      {useGrid && (
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
        <ThemeIcon size={50} variant="light" color="gray">
          <IconCategory />
        </ThemeIcon>
        <Title className={classes.title} order={1} lineClamp={1}>
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
      <div>
        <Group gap="sm">
          <Link legacyBehavior href="/models" passHref>
            <Button
              size="md"
              component="a"
              variant="light"
              color="gray"
              rightIcon={<IconArrowRight size={16} />}
            >
              Explore all models
            </Button>
          </Link>
          {features.auctions && (
            <Link legacyBehavior href="/auctions" passHref>
              <Button
                size="md"
                component="a"
                variant="light"
                color="gray"
                rightIcon={<IconArrowRight size={16} />}
              >
                View auctions
              </Button>
            </Link>
          )}
        </Group>
      </div>
    </Stack>
  );

  return (
    <>
      <Box mb="md" className={cx({ [classes.meta]: useGrid })}>
        {MetaDataTop}
      </Box>
      {isLoading || loadingPreferences ? (
        <div className={classes.grid}>
          {useGrid && <div className={classes.gridMeta}>{MetaDataGrid}</div>}
          {Array.from({ length: ITEMS_PER_ROW * ROWS }).map((_, index) => (
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
    </>
  );
};
