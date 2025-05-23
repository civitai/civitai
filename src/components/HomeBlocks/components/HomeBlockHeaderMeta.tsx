import React from 'react';

import { Button, Group, Text, Title, TypographyStylesProvider } from '@mantine/core';
import { NextLink as Link } from '~/components/NextLink/NextLink';
import { IconArrowRight } from '@tabler/icons-react';
import { HomeBlockMetaSchema } from '~/server/schema/home-block.schema';
import { containerQuery } from '~/utils/mantine-css-helpers';
import { ContentClamp } from '~/components/ContentClamp/ContentClamp';
import { RenderHtml } from '~/components/RenderHtml/RenderHtml';
import homeBlockClasses from '~/components/HomeBlocks/HomeBlock.module.scss';
import clsx from 'clsx';

const HomeBlockHeaderMeta = ({ metadata, htmlMode }: Props) => {
  return (
    <>
      {metadata?.title && (
        <Group
          justify="space-between"
          align="center"
          pb="md"
          className={clsx(homeBlockClasses.header, 'pr-sm md:pr-0')}
          wrap="nowrap"
        >
          <Title className={homeBlockClasses.title}>{metadata?.title}</Title>
          {metadata.link && (
            <Link legacyBehavior href={metadata.link} passHref>
              <Button
                className={homeBlockClasses.expandButton}
                component="a"
                variant="subtle"
                rightSection={<IconArrowRight size={16} />}
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
