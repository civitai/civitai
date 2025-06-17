import React from 'react';

import { Button, Group, Text, Title } from '@mantine/core';
import { NextLink as Link } from '~/components/NextLink/NextLink';
import { IconArrowRight } from '@tabler/icons-react';
import type { HomeBlockMetaSchema } from '~/server/schema/home-block.schema';
import { ContentClamp } from '~/components/ContentClamp/ContentClamp';
import { RenderHtml } from '~/components/RenderHtml/RenderHtml';
import homeBlockClasses from '~/components/HomeBlocks/HomeBlock.module.scss';
import clsx from 'clsx';
import { TypographyStylesWrapper } from '~/components/TypographyStylesWrapper/TypographyStylesWrapper';

const HomeBlockHeaderMeta = ({ metadata, htmlMode }: Props) => {
  return (
    <>
      {metadata?.title && (
        <Group
          justify="space-between"
          align="center"
          pb="md"
          className={clsx(homeBlockClasses.header, 'pr-2 md:pr-0')}
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
              <TypographyStylesWrapper>
                <RenderHtml html={metadata?.description} />
              </TypographyStylesWrapper>
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
