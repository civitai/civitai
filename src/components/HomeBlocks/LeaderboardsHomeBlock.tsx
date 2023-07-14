import React from 'react';
import { HomeBlockExtended } from '~/server/controllers/home-block.controller';
import HomeBlockWrapper from '~/components/HomeBlocks/HomeBlockWrapper';
import { createStyles, Group, Title } from '@mantine/core';
import { HomeBlockMetaSchema } from '~/server/schema/home-block.schema';
import Link from 'next/link';

type Props = { homeBlock: HomeBlockExtended };

const useStyles = createStyles((theme) => ({
  root: {
    background:
      theme.colorScheme === 'dark'
        ? theme.colors.dark[8]
        : theme.fn.darken(theme.colors.gray[0], 0.01),
  },
}));
const LeaderboardsHomeBlock = ({ homeBlock }: Props) => {
  const { classes } = useStyles();

  if (!homeBlock.leaderboards) {
    return null;
  }

  const { leaderboards } = homeBlock;
  const metadata = homeBlock.metadata as HomeBlockMetaSchema;

  console.log(homeBlock.leaderboards);

  return (
    <HomeBlockWrapper className={classes.root}>
      {metadata?.title && (
        <Group align="space-between">
          <Title>{metadata?.title}</Title>
          {metadata.link && metadata.linkText && (
            <Link href={metadata.link} passHref>
              {metadata.linkText}
            </Link>
          )}
        </Group>
      )}
      <Group></Group>
    </HomeBlockWrapper>
  );
};

export default LeaderboardsHomeBlock;
