import { HomeBlockWrapper } from '~/components/HomeBlocks/HomeBlockWrapper';
import { HomeBlockGetAll } from '~/types/router';

type Props = { homeBlock: HomeBlockGetAll[number] };

export const LeaderboardsHomeBlock = ({ homeBlock }: Props) => {
  if (!homeBlock.leaderboards) {
    return null;
  }

  console.log(homeBlock.leaderboards);

  return <HomeBlockWrapper>Display leaderboards component</HomeBlockWrapper>;
};
