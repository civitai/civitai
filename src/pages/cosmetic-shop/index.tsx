import {
  Badge,
  Button,
  Card,
  Center,
  Chip,
  Container,
  Divider,
  Group,
  Image,
  Loader,
  MantineColor,
  Paper,
  Progress,
  Stack,
  Text,
  Title,
  createStyles,
  HoverCard,
  Box,
  Grid,
} from '@mantine/core';
import { IconAlertCircle, IconBrandSpeedtest, IconCircleCheck } from '@tabler/icons-react';
import { IconCheck } from '@tabler/icons-react';
import { IconArrowUpRight } from '@tabler/icons-react';
import { useState } from 'react';
import { ContentClamp } from '~/components/ContentClamp/ContentClamp';
import { DaysFromNow } from '~/components/Dates/DaysFromNow';
import { Meta } from '~/components/Meta/Meta';
import { NoContent } from '~/components/NoContent/NoContent';
import { UserAvatar } from '~/components/UserAvatar/UserAvatar';
import { BuildBudget, BuildFeatures } from '~/server/schema/build-guide.schema';
import { trpc } from '~/utils/trpc';
import { env } from '~/env/client.mjs';
import dayjs from 'dayjs';
import { createServerSideProps } from '~/server/utils/server-side-helpers';
import { useQueryShop } from '~/components/CosmeticShop/cosmetic-shop.util';
import { ImageCSSAspectRatioWrap } from '~/components/Profile/ImageCSSAspectRatioWrap';
import { constants } from '~/server/common/constants';
import { ImageGuard2 } from '~/components/ImageGuard/ImageGuard2';
import { MediaHash } from '~/components/ImageHash/ImageHash';
import { ImagePreview } from '~/components/ImagePreview/ImagePreview';
import { containerQuery } from '~/utils/mantine-css-helpers';
import { useIsMobile } from '~/hooks/useIsMobile';
import { RenderHtml } from '~/components/RenderHtml/RenderHtml';
import { CosmeticShopItemGetById } from '~/types/router';
import { CurrencyBadge } from '~/components/Currency/CurrencyBadge';
import { Currency } from '@prisma/client';
import { CosmeticSample } from '~/pages/moderator/cosmetic-store/cosmetics';

const buildBudgets = Object.keys(BuildBudget) as BuildBudget[];
const processors = ['AMD', 'Intel'] as const;

type State = {
  selectedBudget: BuildBudget;
  selectedProcessor: (typeof processors)[number];
};

const useStyles = createStyles((theme) => ({
  section: {
    overflow: 'hidden',
    position: 'relative',

    [theme.fn.smallerThan('sm')]: {
      padding: theme.spacing.md,
    },
  },

  sectionHeaderContainer: {
    overflow: 'hidden',
    position: 'relative',

    [theme.fn.smallerThan('sm')]: {
      marginLeft: -theme.spacing.md,
      marginRight: -theme.spacing.md,
    },
  },

  sectionHeaderContainerWithBackground: {
    height: 0,
    paddingBottom: `${(constants.cosmeticShop.sectionImageAspectRatio * 100).toFixed(3)}%`,
    background: 'transparent',

    [theme.fn.smallerThan('sm')]: {
      paddingBottom: `${(constants.cosmeticShop.sectionImageMobileAspectRatio * 100).toFixed(3)}%`,
    },
  },

  backgroundImage: {
    position: 'absolute',
    top: 0,
    left: 0,
    width: '100%',
    height: '100%',
    opacity: 0.4,
    zIndex: -1,
  },

  sectionHeaderContentWrap: {
    position: 'absolute',
    zIndex: 1,
    width: '100%',
    height: '100%',
  },

  sectionTitle: {
    color: theme.colorScheme === 'dark' ? theme.white : theme.black,
    [theme.fn.smallerThan('sm')]: {
      fontSize: 18,
    },
  },

  hideMobile: {
    [theme.fn.smallerThan('sm')]: {
      display: 'none',
    },
  },
  hideDesktop: {
    [theme.fn.largerThan('sm')]: {
      display: 'none',
    },
  },
}));

export const getServerSideProps = createServerSideProps({
  useSSG: true,
  resolver: async ({ ssg }) => {
    await ssg?.cosmeticShop.getShop.prefetch();
  },
});

export const CosmeticShopItem = ({ item }: { item: CosmeticShopItemGetById }) => {
  const cosmetic = item.cosmetic;
  return (
    <Card shadow="xs" radius="md">
      <Stack spacing="md">
        <Stack spacing="md">
          <Center mb="lg">
            <CosmeticSample cosmetic={cosmetic} size="md" />
          </Center>

          <Group spacing={4}>
            <Title order={3}>{item.title}</Title>
            <CurrencyBadge
              currency={Currency.BUZZ}
              unitAmount={item.unitAmount}
              // @ts-ignore
              variant="transparent"
              px={0}
            />
          </Group>
          {item.description && (
            <ContentClamp maxHeight={200}>
              <RenderHtml html={item.description} />
            </ContentClamp>
          )}
          <Button color="gray" radius="xl">
            Preview
          </Button>
        </Stack>
      </Stack>
    </Card>
  );
};

export default function CosmeticShopMain() {
  const { classes, cx } = useStyles();
  const [state, setState] = useState<State>({ selectedBudget: 'Mid', selectedProcessor: 'AMD' });
  const { cosmeticShopSections, isLoading } = useQueryShop();
  const isMobile = useIsMobile();

  return (
    <>
      <Meta
        title="Civitai Cosmetic Shop | Created with Love & AI"
        description="Civitai Cosmetic Shop is a place where you can find the best cosmetic products to really express youself."
        links={[{ href: `${env.NEXT_PUBLIC_BASE_URL}/builds`, rel: 'canonical' }]}
      />
      <Container size="xl">
        <Stack spacing="xl">
          <Stack spacing={0}>
            <Title>Civitai Cosmetic Shop</Title>
            <Text size="sm" color="dimmed" mb="sm">
              Any cosmetic purchases directly contributes to Civitai ❤️
            </Text>
          </Stack>
          {isLoading && !cosmeticShopSections ? (
            <Center p="xl">
              <Loader />
            </Center>
          ) : cosmeticShopSections ? (
            cosmeticShopSections.map((section) => {
              const { image, items } = section;

              return (
                <Stack key={section.id} className={classes.section}>
                  <Box
                    className={cx(classes.sectionHeaderContainer, {
                      [classes.sectionHeaderContainerWithBackground]: !!image,
                    })}
                  >
                    {image && (
                      <ImageCSSAspectRatioWrap
                        aspectRatio={
                          isMobile
                            ? constants.cosmeticShop.sectionImageMobileAspectRatio
                            : constants.cosmeticShop.sectionImageAspectRatio
                        }
                        style={{ borderRadius: 0 }}
                        className={classes.backgroundImage}
                      >
                        <ImagePreview
                          image={image}
                          edgeImageProps={{ width: 450 }}
                          radius="md"
                          style={{ width: '100%', height: '100%' }}
                          aspectRatio={0}
                        />
                      </ImageCSSAspectRatioWrap>
                    )}
                    <Box className={cx({ [classes.sectionHeaderContentWrap]: !!image })}>
                      <Stack p="md" mih="100%" justify="center" style={{ flexGrow: 1 }}>
                        <Group position="apart">
                          <Title order={2} className={classes.sectionTitle}>
                            {section.title}
                          </Title>
                          <Button color="gray" radius="xl" className={classes.hideMobile}>
                            View All <IconArrowUpRight />
                          </Button>
                        </Group>
                      </Stack>
                    </Box>
                  </Box>

                  <Stack>
                    {section.description && (
                      <ContentClamp maxHeight={200}>
                        <RenderHtml html={section.description} />
                      </ContentClamp>
                    )}
                  </Stack>

                  <Grid>
                    {items.map((item) => {
                      const { shopItem } = item;
                      return (
                        <Grid.Col span={6} md={3} key={shopItem.id}>
                          <CosmeticShopItem item={shopItem} />
                        </Grid.Col>
                      );
                    })}
                  </Grid>
                </Stack>
              );
            })
          ) : (
            <NoContent message="We couldn't match what you're looking for. Please try again later." />
          )}
        </Stack>
      </Container>
    </>
  );
}
