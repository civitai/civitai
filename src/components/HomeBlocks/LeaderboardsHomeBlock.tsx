import React from 'react';
import { HomeBlockExtended } from '~/server/controllers/home-block.controller';
import HomeBlockWrapper from '~/components/HomeBlocks/HomeBlockWrapper';

type Props = { homeBlock: HomeBlockExtended };

const LeaderboardsHomeBlock = ({ homeBlock }: Props) => {
  if (!homeBlock.leaderboards) {
    return null;
  }

  console.log(homeBlock.leaderboards);

  return <HomeBlockWrapper>Display leaderboards component</HomeBlockWrapper>;
};

export default LeaderboardsHomeBlock;
