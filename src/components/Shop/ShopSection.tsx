import type { GridProps } from '@mantine/core';
import { Grid, Stack, Title, TypographyStylesProvider } from '@mantine/core';
import React from 'react';
import { getEdgeUrl } from '~/client-utils/cf-images-utils';
import { ContentClamp } from '~/components/ContentClamp/ContentClamp';
import { RenderHtml } from '~/components/RenderHtml/RenderHtml';
import classes from './ShopSection.module.scss';
import clsx from 'clsx';

const IMAGE_SECTION_WIDTH = 1288;

export function ShopSection({
  title,
  description,
  imageUrl,
  hideTitle,
  className,
  children,
}: Props) {
  const backgroundImageUrl = imageUrl
    ? getEdgeUrl(imageUrl, { width: IMAGE_SECTION_WIDTH, optimized: true })
    : undefined;

  return (
    <section className={clsx('m-3 flex flex-col gap-4', classes.section, className)}>
      <div
        className={clsx(
          classes.sectionHeaderContainer,
          backgroundImageUrl && classes.sectionHeaderContainerWithBackground
        )}
      >
        <div
          className={backgroundImageUrl ? classes.sectionHeaderContentWrap : ''}
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
          {!hideTitle && (
            <Stack mih="100%" justify="center" align="center" style={{ flexGrow: 1 }}>
              <Title order={2} className={classes.sectionTitle}>
                {title}
              </Title>
            </Stack>
          )}
        </div>
      </div>

      <Stack>
        {description && (
          <ContentClamp maxHeight={200} className={classes.sectionDescription}>
            <TypographyStylesProvider>
              <RenderHtml html={description} />
            </TypographyStylesProvider>
          </ContentClamp>
        )}
      </Stack>

      {children}
    </section>
  );
}

ShopSection.Items = function Items({ children, ...props }: GridProps) {
  return (
    <Grid mb={0} mt={0} {...props}>
      {React.Children.map(children, (child) => (
        <Grid.Col span={{ base: 12, sm: 6, md: 3 }}>{child}</Grid.Col>
      ))}
    </Grid>
  );
};

type Props = {
  children: React.ReactNode;
  title: string;
  description?: string | null;
  imageUrl?: string | null;
  hideTitle?: boolean;
  className?: string;
};
