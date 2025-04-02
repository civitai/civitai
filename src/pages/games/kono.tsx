import { Button, Tooltip } from '@mantine/core';
import { IconFlag } from '@tabler/icons-react';
import { EdgeMedia2 } from '~/components/EdgeMedia/EdgeMedia';
import GameErrorBoundary from '~/components/Games/GameErrorBoundary';
import {
  ratingExplanationMap,
  useJoinKnightsNewOrder,
  useKnightsNewOrderListener,
  useQueryKnightsNewOrderImageQueue,
} from '~/components/Games/KnightsNewOrder.utils';
import { PageLoader } from '~/components/PageLoader/PageLoader';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { calculateLevelProgression } from '~/server/utils/research-utils';
import { createServerSideProps } from '~/server/utils/server-side-helpers';
import { getLoginLink } from '~/utils/login-helpers';
import { trpc } from '~/utils/trpc';

export const getServerSideProps = createServerSideProps({
  useSession: true,
  resolver: async ({ session, features, ctx }) => {
    if (!session)
      return {
        redirect: {
          destination: getLoginLink({ returnUrl: ctx.req.url, reason: 'knights-new-order' }),
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
  const queryUtils = trpc.useUtils();
  const { joinKnightsNewOrder, playerData, isLoading } = useJoinKnightsNewOrder();
  const { data, isLoading: loadingImagesQueue } = useQueryKnightsNewOrderImageQueue();

  useKnightsNewOrderListener();

  const currentImage = data[0];
  // TODO.newOrder: update this to calculate level progression based on the new order game
  const levelProgression = calculateLevelProgression(playerData?.exp ?? 0);

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
        <div className="flex flex-col gap-6">
          <h1>Current player stats</h1>
          <div className="flex gap-4">
            <p>Username: {currentUser?.username}</p>
            <p>Level: {levelProgression.level}</p>
            <p>
              Experience: {levelProgression.ratingsInLevel} / {levelProgression.ratingsForNextLevel}
            </p>
            <p>Fervor: {playerData.stats.fervor}</p>
            <p>Blessed Buzz: {playerData.stats.blessedBuzz}</p>
            <p>Rank: {playerData.rank.name}</p>
          </div>
          {currentImage ? (
            <div className="flex flex-col gap-4">
              <EdgeMedia2 src={currentImage.url} width={700} type="image" />
              <Button.Group>
                {Object.entries(ratingExplanationMap).map(([key, value]) => (
                  <Tooltip
                    key={key}
                    label={value.description}
                    position="top"
                    withArrow
                    openDelay={1000}
                    maw={300}
                    multiline
                  >
                    <Button
                      key={key}
                      variant={key === 'Blocked' ? 'filled' : 'default'}
                      color={key === 'Blocked' ? 'red' : undefined}
                      onClick={() =>
                        queryUtils.games.newOrder.getImagesQueue.setData({ limit: 100 }, (old) => {
                          // Removes the current image from the queue
                          const newQueue = old?.filter((image) => image.id !== currentImage.id);
                          return newQueue;
                        })
                      }
                      leftIcon={value.icon}
                    >
                      {key === 'Blocked' ? <IconFlag size={18} /> : key}
                    </Button>
                  </Tooltip>
                ))}
              </Button.Group>
            </div>
          ) : null}
        </div>
      ) : null}
    </GameErrorBoundary>
  );
}
