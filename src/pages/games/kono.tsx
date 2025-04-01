import { Button } from '@mantine/core';
import GameErrorBoundary from '~/components/Games/GameErrorBoundary';
import {
  useJoinKnightsNewOrder,
  useKnightsNewOrderListener,
} from '~/components/Games/KnightsNewOrder.utils';
import { PageLoader } from '~/components/PageLoader/PageLoader';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { createServerSideProps } from '~/server/utils/server-side-helpers';
import { getLoginLink } from '~/utils/login-helpers';

export const getServerSideProps = createServerSideProps({
  useSession: true,
  resolver: async ({ session, features }) => {
    if (!session)
      return {
        redirect: {
          destination: getLoginLink({ reason: 'knights-new-order' }),
          permanent: false,
        },
      };

    if (!features?.newOrderGame)
      return {
        redirect: { destination: '/', permanent: false },
      };
  },
});

export default function KnightsNewOrderPage() {
  const currentUser = useCurrentUser();
  const { joinKnightsNewOrder, playerData, isLoading } = useJoinKnightsNewOrder();

  useKnightsNewOrderListener();

  return (
    <GameErrorBoundary>
      {!isLoading && !playerData ? (
        <div>
          <h1>Knights of New Order</h1>
          <p>Welcome to page Knights New Order</p>
          <div className="flex gap-4">
            <Button variant="outline">Learn More</Button>
            <Button onClick={() => joinKnightsNewOrder()}>Join Game</Button>
          </div>
        </div>
      ) : isLoading ? (
        <PageLoader />
      ) : playerData ? (
        <div>
          <h1>Current player stats</h1>
          <p>Player Username: {currentUser?.username}</p>
          <p>Player Level: {Math.round(playerData.stats.exp / 1000)}</p>
          <p>Player Experience: {playerData.stats.exp}</p>
          <p>Player Fervor: {playerData.stats.fervor}</p>
          <p>Player Blessed Buzz: {playerData.stats.blessedBuzz}</p>
          <p>Player Rank: {playerData.rank.name}</p>
        </div>
      ) : null}
    </GameErrorBoundary>
  );
}
