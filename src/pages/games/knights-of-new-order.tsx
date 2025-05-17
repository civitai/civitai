import { useRef, useState } from 'react';
import { ActionIcon, Button, Card, Loader, Select, ThemeIcon } from '@mantine/core';
import { IconExternalLink } from '@tabler/icons-react';
import clsx from 'clsx';
import Link from 'next/link';
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
import { NewOrderSidebar } from '~/components/Games/NewOrder/NewOrderSidebar';
import { Meta } from '~/components/Meta/Meta';
import { IsClient } from '~/components/IsClient/IsClient';
import { getLevelProgression } from '~/server/utils/game-helpers';
import { LevelUp } from '~/components/Games/LevelProgress/LevelUp';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { NewOrderImageRatings } from '~/components/Games/NewOrder/NewOrderImageRatings';
import { ImageGuard2 } from '~/components/ImageGuard/ImageGuard2';
import { RankUp } from '~/components/Games/LevelProgress/RankUp';
import { newOrderConfig } from '~/server/common/constants';
import { NewOrderBetaBanner } from '~/components/Games/NewOrder/NewOrderBetaBanner';
import { NewOrderRankType } from '~/shared/utils/prisma/enums';
import { LegacyActionIcon } from '~/components/LegacyActionIcon/LegacyActionIcon';

let levelUpTimer: NodeJS.Timeout | null = null;
let rankUpTimer: NodeJS.Timeout | null = null;

export const getServerSideProps = createServerSideProps({
  useSession: true,
  resolver: async ({ features }) => {
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

    const levelNoticeRef = useRef<HTMLDivElement>(null);
    const [isLevelingUp, setIsLevelingUp] = useState(false);
    const [isRankingUp, setIsRankingUp] = useState(false);
    const [prevHistory, setPrevHistory] = useState<number[]>([]);
    const [selectedQueue, setSelectedQueue] = useState<NewOrderRankType | 'Inquisitor' | null>(
      null
    );
    const filters = selectedQueue ? { queueType: selectedQueue } : undefined;

    const playSound = useGameSounds({ volume: muted ? 0 : 0.5 });
    const { playerData, isLoading, joined } = useJoinKnightsNewOrder();
    const { addRating, skipRating } = useAddImageRating({ filters });
    const {
      data,
      isLoading: loadingImagesQueue,
      refetch,
      isRefetching,
    } = useQueryKnightsNewOrderImageQueue(filters);
    const filteredData = data.filter((image) => !prevHistory.includes(image.id));

    useKnightsNewOrderListener({
      onRankUp: () => {
        setIsRankingUp(true);
        if (!muted) playSound('challengePass');
        rankUpTimer && clearTimeout(rankUpTimer);
        rankUpTimer = setTimeout(() => setIsRankingUp(false), 2000);
      },
    });

    const handleAddRating = async ({
      rating,
      damnedReason,
    }: Omit<AddImageRatingInput, 'playerId' | 'imageId'>) => {
      if (!currentImage || !playerData) return;

      const isCorrectRating = currentImage.nsfwLevel === rating;
      const isBlocked = rating === NsfwLevel.Blocked;
      const isAcolyte = playerData.rankType === NewOrderRankType.Acolyte;

      setPrevHistory((prev) => [...prev, currentImage.id]);
      if (isBlocked || (!isCorrectRating && isAcolyte)) {
        playSound('buzz');
      } else {
        playSound('point', ratingPlayBackRates[rating]);
      }

      // Update level notice
      if (levelNoticeRef.current && rating !== NsfwLevel.Blocked) {
        const innerText = NsfwLevel[rating] ?? '';

        levelNoticeRef.current.innerText = innerText;
        levelNoticeRef.current.style.display = 'block';
        setTimeout(() => {
          if (levelNoticeRef.current) levelNoticeRef.current.style.display = 'none';
        }, 200);
      }

      // Check for level up
      const progression = getLevelProgression(playerData.stats.exp);
      const gainedExp = rating === currentImage.nsfwLevel ? newOrderConfig.baseExp : 0;
      const shouldLevelUp =
        progression && progression.xpIntoLevel + gainedExp >= progression.xpForNextLevel;
      if (shouldLevelUp) levelUp();

      await addRating({ imageId: currentImage.id, rating, damnedReason }).catch(() => null); // errors are handled in the hook

      handleFetchNextBatch();
    };

    const handleAddDamnedReason = async ({ reason }: { reason: NewOrderDamnedReason }) => {
      await handleAddRating({ rating: NsfwLevel.Blocked, damnedReason: reason });
    };

    const handleFetchNextBatch = () => {
      if (filteredData.length <= 1 && !isRefetching) {
        playSound('challenge');
        refetch();
      }
    };

    const handleSkipRating = async () => {
      if (!currentImage) return;

      playSound('undo');
      await skipRating({ imageId: currentImage.id });
      handleFetchNextBatch();
    };

    const levelUp = () => {
      setIsLevelingUp(true);
      if (!muted) playSound('levelUp');
      levelUpTimer && clearTimeout(levelUpTimer);
      levelUpTimer = setTimeout(() => setIsLevelingUp(false), 2000);
    };

    const currentImage = filteredData[0];

    return (
      <GameErrorBoundary>
        <Meta
          title="Knights of New Order"
          description="Join the Knights of the New Order and rate images to earn rewards."
          links={[{ rel: 'canonical', href: '/games/knights-of-new-order' }]}
        />
        <IsClient>
          {(!isLoading && !playerData) || !joined ? (
            <NewOrderJoin />
          ) : isLoading ? (
            <PageLoader />
          ) : playerData ? (
            <div className="relative -mt-3 flex h-[calc(100%-44px)] flex-col gap-4 bg-gray-2 p-4 @md:flex-row @md:p-0 dark:bg-dark-9">
              <NewOrderBetaBanner />
              <NewOrderSidebar />
              <div className="relative flex size-full items-center justify-center gap-4 overflow-hidden p-0 @md:h-auto @md:p-4">
                {isLevelingUp && <LevelUp className="absolute" />}
                {isRankingUp && <RankUp className="absolute" />}
                {currentUser?.isModerator && (
                  <Select
                    className="absolute right-2 top-2 z-10 w-[200px] max-w-full"
                    placeholder="Select a queue"
                    value={selectedQueue}
                    data={[...Object.keys(NewOrderRankType), 'Inquisitor']}
                    onChange={(value) => setSelectedQueue(value as NewOrderRankType)}
                  />
                )}
                {loadingImagesQueue || isRefetching ? (
                  <Loader variant="bars" size="xl" />
                ) : currentImage ? (
                  <div className="relative flex size-full max-w-sm flex-col items-center justify-center gap-4 overflow-hidden">
                    <ImageGuard2 image={currentImage} explain={false}>
                      {() => (
                        <div
                          className={clsx(
                            'relative my-auto flex max-h-[85%] max-w-full items-center justify-center @md:my-0'
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
                            className={clsx('h-full max-w-full rounded-lg object-contain')}
                            type="image"
                            width={700}
                            contain
                          />
                          {playerData.rankType !== NewOrderRankType.Acolyte && (
                            <LegacyActionIcon
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
                            </LegacyActionIcon>
                          )}
                        </div>
                      )}
                    </ImageGuard2>
                    <Card
                      ref={levelNoticeRef}
                      id="rating"
                      shadow="sm"
                      radius="sm"
                      className="absolute left-1/2 top-1/2 z-10 -translate-x-1/2 -translate-y-1/2 p-4 text-5xl font-medium text-white"
                      style={{ display: 'none' }}
                      withBorder
                    >
                      PG
                    </Card>
                    <NewOrderImageRater
                      muted={muted}
                      onVolumeClick={() => setMuted((prev) => !prev)}
                      onSkipClick={handleSkipRating}
                      onRatingClick={({ rating, damnedReason }) =>
                        damnedReason
                          ? handleAddDamnedReason({ reason: damnedReason })
                          : handleAddRating({ rating })
                      }
                    />
                    {currentUser?.isModerator && (
                      <NewOrderImageRatings
                        imageId={currentImage.id}
                        imageNsfwLevel={currentImage.nsfwLevel}
                        ratings={currentImage.ratings}
                      />
                    )}
                  </div>
                ) : (
                  <div className="flex max-w-sm flex-col items-center justify-center gap-4">
                    <ThemeIcon size={96} radius={999} variant="light">
                      <span className="text-4xl">🎉</span>
                    </ThemeIcon>
                    <div className="text-center">
                      <p className="text-lg">
                        Hooray! Looks like you have rated all images in the queue.
                      </p>
                      <p className="text-lg">Come back later or refresh to get new ones!</p>
                    </div>
                    <Button radius="xl" onClick={() => refetch()} loading={isRefetching}>
                      Refresh now
                    </Button>
                  </div>
                )}
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
