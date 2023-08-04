import React from 'react';

import { Button, Group, Text, Title } from '@mantine/core';
import Link from 'next/link';
import { IconArrowRight } from '@tabler/icons-react';
import { HomeBlockMetaSchema } from '~/server/schema/home-block.schema';
import { useIsMobile } from '~/hooks/useIsMobile';
import { useHomeBlockStyles } from '~/components/HomeBlocks/HomeBlock.Styles';

const HomeBlockHeaderMeta = ({ metadata }: Props) => {
  const isMobile = useIsMobile();
  const { classes: homeBlockClasses } = useHomeBlockStyles();

  return (
    <>
      {metadata?.title && (
        <Group
          position="apart"
          align="center"
          pb="md"
          pr={isMobile ? 'md' : undefined}
          className={homeBlockClasses.header}
          noWrap
        >
          <Title className={homeBlockClasses.title}>{metadata?.title}</Title>
          {metadata.link && (
            <Link href={metadata.link} passHref>
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
      {metadata?.description && <Text mb="md">{metadata?.description}</Text>}
    </>
  );
};

type Props = { metadata: HomeBlockMetaSchema };
export { HomeBlockHeaderMeta };
