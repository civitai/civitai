import { ActionIcon, Skeleton } from '@mantine/core';
import { IconExternalLink } from '@tabler/icons-react';
import clsx from 'clsx';
import Link from 'next/link';
import { useState } from 'react';
import { AppLayout } from '~/components/AppLayout/AppLayout';
import { Page } from '~/components/AppLayout/Page';
import { EdgeMedia2 } from '~/components/EdgeMedia/EdgeMedia';
import GameErrorBoundary from '~/components/Games/GameErrorBoundary';
import {
  ratingPlayBackRates,
  useAddImageRating,
  useJoinKnightsNewOrder,
  useKnightsNewOrderListener,
  useQueryKnightsNewOrderImageQueue,
} from '~/components/Games/KnightsNewOrder.utils';
import { NewOrderImageRater } from '~/components/Games/NewOrder/NewOrderImageRater';
import { NewOrderJoin } from '~/components/Games/NewOrder/NewOrderJoin';
import { PageLoader } from '~/components/PageLoader/PageLoader';
import { useGameSounds } from '~/hooks/useGameSounds';
import { useStorage } from '~/hooks/useStorage';
import { NewOrderDamnedReason, NsfwLevel } from '~/server/common/enums';
import { AddImageRatingInput } from '~/server/schema/games/new-order.schema';
import { createServerSideProps } from '~/server/utils/server-side-helpers';
import { getLoginLink } from '~/utils/login-helpers';
import { NewOrderSidebar } from '~/components/Games/NewOrder/NewOrderSidebar';
import { Meta } from '~/components/Meta/Meta';
import { IsClient } from '~/components/IsClient/IsClient';
import { calculateLevelProgression } from '~/server/utils/research-utils';
import { LevelUp } from '~/components/Games/LevelProgress/LevelUp';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { NewOrderImageRatings } from '~/components/Games/NewOrder/NewOrderImageRatings';
import { ImageGuard2 } from '~/components/ImageGuard/ImageGuard2';

let levelUpTimer: NodeJS.Timeout | null = null;

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

export default Page(
  function KnightsNewOrderPage() {
    const currentUser = useCurrentUser();

    const [muted, setMuted] = useStorage({
      key: 'knights-new-order-muted',
      type: 'localStorage',
      defaultValue: false,
      getInitialValueInEffect: false,
    });
    const [isLevelingUp, setIsLevelingUp] = useState(false);

    const playSound = useGameSounds({ volume: muted ? 0 : 0.5 });
    const { playerData, isLoading, joined } = useJoinKnightsNewOrder();
    const { addRating } = useAddImageRating();
    const { data, isLoading: loadingImagesQueue } = useQueryKnightsNewOrderImageQueue();

    useKnightsNewOrderListener();

    const handleAddRating = async ({
      rating,
      damnedReason,
    }: Omit<AddImageRatingInput, 'playerId' | 'imageId'>) => {
      if (!currentImage) return;

      try {
        playSound(rating === NsfwLevel.Blocked ? 'buzz' : 'point', ratingPlayBackRates[rating]);
        await addRating({ imageId: currentImage.id, rating, damnedReason });

        // Check for level up
        const progression = playerData ? calculateLevelProgression(playerData.stats.exp) : null;
        const shouldLevelUp =
          progression && progression.ratingsInLevel + 100 >= progression.ratingsForNextLevel;
        if (shouldLevelUp) levelUp();
      } catch {
        playSound('challengeFail');
      }
    };

    const handleAddDamnedReason = async ({ reason }: { reason: NewOrderDamnedReason }) => {
      await handleAddRating({ rating: NsfwLevel.Blocked, damnedReason: reason });
    };

    const levelUp = () => {
      setIsLevelingUp(true);
      if (!muted) playSound('levelUp');
      levelUpTimer && clearTimeout(levelUpTimer);
      levelUpTimer = setTimeout(() => setIsLevelingUp(false), 2500);
    };

    const currentImage = data[0];
    const isLandscape =
      (currentImage?.metadata?.width ?? 0) > (currentImage?.metadata?.height ?? 0);

    return (
      <GameErrorBoundary>
        <Meta
          title="Knights New Order"
          description="Join the Knights of the New Order and rate images to earn rewards."
          links={[{ rel: 'canonical', href: '/games/kono' }]}
        />
        <IsClient>
          {!isLoading && !playerData && !joined ? (
            <NewOrderJoin />
          ) : isLoading ? (
            <PageLoader />
          ) : playerData ? (
            <div className="relative -mt-3 flex h-full flex-col gap-4 bg-dark-9 p-4 md:flex-row md:p-0">
              {isLevelingUp && <LevelUp />}
              <NewOrderSidebar />
              <div className="flex size-full items-center justify-center gap-4 md:overflow-hidden">
                {loadingImagesQueue && (
                  <Skeleton className="h-1/2 w-full max-w-sm p-4" visible animate />
                )}
                {currentImage ? (
                  <div className="flex h-full max-h-[75%] flex-col items-center justify-center gap-4">
                    <ImageGuard2 image={currentImage}>
                      {() => (
                        <div
                          className={clsx(
                            'relative my-auto flex items-center justify-center',
                            isLandscape ? 'h-auto' : 'h-full'
                          )}
                        >
                          {currentUser?.isModerator && (
                            <ImageGuard2.BlurToggle
                              className="absolute left-2 top-2"
                              alwaysVisible
                            />
                          )}
                          <EdgeMedia2
                            src={currentImage.url}
                            className={clsx(
                              'max-w-full rounded-lg object-contain',
                              isLandscape ? 'h-auto' : 'h-full'
                            )}
                            type="image"
                            width={700}
                            contain
                          />
                          <ActionIcon
                            component={Link}
                            href={`/images/${currentImage.id}`}
                            target="_blank"
                            aria-label="Open image in new tab"
                            size="sm"
                            variant="light"
                            color="dark"
                            className="absolute bottom-2 right-2 text-white"
                          >
                            <IconExternalLink size={16} color="currentColor" />
                          </ActionIcon>
                        </div>
                      )}
                    </ImageGuard2>
                    <NewOrderImageRater
                      muted={muted}
                      onVolumeClick={() => setMuted((prev) => !prev)}
                      onRatingClick={({ rating, damnedReason }) =>
                        damnedReason
                          ? handleAddDamnedReason({ reason: damnedReason })
                          : handleAddRating({ rating })
                      }
                    />
                    {currentUser?.isModerator && (
                      <NewOrderImageRatings
                        imageNsfwLevel={currentImage.nsfwLevel}
                        ratings={currentImage.ratings}
                      />
                    )}
                  </div>
                ) : null}
              </div>
            </div>
          ) : null}
        </IsClient>
      </GameErrorBoundary>
    );
  },
  {
    getLayout: (page) => (
      <AppLayout scrollable={false} footer={false}>
        {page}
      </AppLayout>
    ),
  }
);
