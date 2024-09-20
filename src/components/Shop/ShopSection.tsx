import { Box, createStyles, Grid, Stack, Title, TypographyStylesProvider } from '@mantine/core';
import React from 'react';
import { getEdgeUrl } from '~/client-utils/cf-images-utils';
import { ContentClamp } from '~/components/ContentClamp/ContentClamp';
import { RenderHtml } from '~/components/RenderHtml/RenderHtml';
import { CosmeticShopSectionMeta } from '~/server/schema/cosmetic-shop.schema';

const IMAGE_SECTION_WIDTH = 1288;

const useStyles = createStyles((theme, _params, getRef) => {
  const sectionRef = getRef('section');

  return {
    section: {
      ref: sectionRef,
      overflow: 'hidden',
      position: 'relative',

      [`& + .${sectionRef}`]: {
        marginTop: theme.spacing.xl * 3,
      },
    },

    sectionHeaderContainer: {
      overflow: 'hidden',
      position: 'relative',
      height: 250,
    },

    sectionHeaderContainerWithBackground: {
      background: 'transparent',
      borderRadius: theme.radius.md,
    },

    sectionDescription: {
      padding: `0 ${theme.spacing.sm}px ${theme.spacing.sm}px`,
      p: {
        fontSize: 18,
        lineHeight: 1.3,
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
      top: 0,
      left: 0,
    },

    sectionTitle: {
      color: theme.white,
      width: '100%',
      padding: theme.spacing.lg,
      paddingLeft: 8,
      paddingRight: 8,
      textShadow: `3px 0px 7px rgba(0,0,0,0.8), -3px 0px 7px rgba(0,0,0,0.8), 0px 4px 7px rgba(0,0,0,0.8)`,
      maxWidth: 400,
      fontSize: 48,
      lineHeight: 1.1,
      ['@container (min-width: 500px)']: {
        fontSize: 64,
        maxWidth: 500,
      },
    },
  };
});

export function ShopSection({ title, image, items, meta }: Props) {
  const { classes, cx } = useStyles();
  const backgroundImageUrl = image
    ? getEdgeUrl(image.url, { width: IMAGE_SECTION_WIDTH, optimized: true })
    : undefined;

  return (
    <Stack className={classes.section} m="sm">
      <Box
        className={cx(classes.sectionHeaderContainer, {
          [classes.sectionHeaderContainerWithBackground]: !!image,
        })}
      >
        <Box
          className={cx({ [classes.sectionHeaderContentWrap]: !!image })}
          style={
            backgroundImageUrl
              ? {
                  backgroundImage: `url(${backgroundImageUrl})`,
                  backgroundPosition: 'left center',
                  backgroundSize: 'cover',
                }
              : undefined
          }
        >
          {!meta?.hideTitle && (
            <Stack mih="100%" justify="center" align="center" style={{ flexGrow: 1 }}>
              <Title order={2} className={classes.sectionTitle} align="center">
                {title}
              </Title>
            </Stack>
          )}
        </Box>
      </Box>

      <Stack>
        {description && (
          <ContentClamp maxHeight={200} className={classes.sectionDescription}>
            <TypographyStylesProvider>
              <RenderHtml html={description} />
            </TypographyStylesProvider>
          </ContentClamp>
        )}
      </Stack>

      <Grid mb={0} mt={0}>
        {items.map((item) => {
          const { shopItem } = item;
          return (
            <Grid.Col span={12} sm={6} md={3} key={shopItem.id}>
              <CosmeticShopItem item={shopItem} sectionItemCreatedAt={item.createdAt} />
            </Grid.Col>
          );
        })}
      </Grid>
    </Stack>
  );
}

ShopSection.Header = function Header({ children, ...props }: { children: React.ReactNode }) {
  const { classes, cx } = useStyles();
  return (
    <Box
      className={cx(classes.sectionHeaderContainer, {
        [classes.sectionHeaderContainerWithBackground]: !!image,
      })}
    >
      <Box
        className={cx({ [classes.sectionHeaderContentWrap]: !!image })}
        style={
          backgroundImageUrl
            ? {
                backgroundImage: `url(${backgroundImageUrl})`,
                backgroundPosition: 'left center',
                backgroundSize: 'cover',
              }
            : undefined
        }
      >
        {!meta?.hideTitle && (
          <Stack mih="100%" justify="center" align="center" style={{ flexGrow: 1 }}>
            <Title order={2} className={classes.sectionTitle} align="center">
              {title}
            </Title>
          </Stack>
        )}
      </Box>
    </Box>
  );
};

ShopSection.Description = function Description() {};

ShopSection.Item = function Item() {};

type Props = { title: string; image?: any; items: any[]; meta?: CosmeticShopSectionMeta };
