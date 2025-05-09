import React from 'react';

import { Button, Group, Text, Title, TypographyStylesProvider } from '@mantine/core';
import { NextLink as Link } from '~/components/NextLink/NextLink';
import { IconArrowRight } from '@tabler/icons-react';
import { HomeBlockMetaSchema } from '~/server/schema/home-block.schema';
import { useHomeBlockStyles } from '~/components/HomeBlocks/HomeBlock.Styles';
import { containerQuery } from '~/utils/mantine-css-helpers';
import { ContentClamp } from '~/components/ContentClamp/ContentClamp';
import { RenderHtml } from '~/components/RenderHtml/RenderHtml';

const HomeBlockHeaderMeta = ({ metadata, htmlMode }: Props) => {
  const { classes: homeBlockClasses } = useHomeBlockStyles();

  return (
    <>
      {metadata?.title && (
        <Group
          justify="space-between"
          align="center"
          pb="md"
          sx={(theme) => ({
            [containerQuery.smallerThan('sm')]: {
              paddingRight: theme.spacing.md,
            },
          })}
          className={homeBlockClasses.header}
          wrap="nowrap"
        >
          <Title className={homeBlockClasses.title}>{metadata?.title}</Title>
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
      )}
      {metadata?.description && (
        <>
          {htmlMode ? (
            <ContentClamp maxHeight={200}>
              <TypographyStylesProvider>
                <RenderHtml html={metadata?.description} />
              </TypographyStylesProvider>
            </ContentClamp>
          ) : (
            <Text mb="md">{metadata?.description}</Text>
          )}
        </>
      )}
    </>
  );
};

type Props = { metadata: HomeBlockMetaSchema; htmlMode?: boolean };
export { HomeBlockHeaderMeta };
