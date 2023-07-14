import React from 'react';
import { HomeBlockExtended } from '~/server/controllers/home-block.controller';

type Props = { homeBlock: HomeBlockExtended };

const LeaderboardsHomeBlock = ({ homeBlock }: Props) => {
  if (!homeBlock.leaderboards) {
    return null;
  }

  console.log(homeBlock.leaderboards);

  return <div>Display leaderboards component</div>;
};

export default LeaderboardsHomeBlock;
