import { ActionIcon, Skeleton } from '@mantine/core';
import { HotkeyItem, useHotkeys } from '@mantine/hooks';
import { IconExternalLink } from '@tabler/icons-react';
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
import { ImageRater } from '~/components/Games/NewOrder/ImageRater';
import { MenuActions } from '~/components/Games/NewOrder/MenuActions';
import { Welcome } from '~/components/Games/NewOrder/Welcome';
import { PlayerCard } from '~/components/Games/PlayerCard';
import { PageLoader } from '~/components/PageLoader/PageLoader';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { useGameSounds } from '~/hooks/useGameSounds';
import { useStorage } from '~/hooks/useStorage';
import { NewOrderDamnedReason, NsfwLevel } from '~/server/common/enums';
import { AddImageRatingInput } from '~/server/schema/games/new-order.schema';
import { createServerSideProps } from '~/server/utils/server-side-helpers';
import { NewOrderRankType } from '~/shared/utils/prisma/enums';
import { getLoginLink } from '~/utils/login-helpers';

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

    const [damnedReason, setDamnedReason] = useState<{
      open: boolean;
      reason: NewOrderDamnedReason | null;
    }>({ open: false, reason: null });
    const [muted, setMuted] = useStorage({
      key: 'knights-new-order-muted',
      type: 'localStorage',
      defaultValue: false,
    });

    const { playerData, isLoading, joined } = useJoinKnightsNewOrder();
    const { addRating } = useAddImageRating();
    const { data, isLoading: loadingImagesQueue } = useQueryKnightsNewOrderImageQueue();

    useKnightsNewOrderListener();

    const playSound = useGameSounds({ volume: muted ? 0 : 0.5 });

    const handleAddRating = async ({
      rating,
      damnedReason,
    }: Omit<AddImageRatingInput, 'playerId' | 'imageId'>) => {
      if (!currentImage) return;

      try {
        playSound(rating === NsfwLevel.Blocked ? 'buzz' : 'point', ratingPlayBackRates[rating]);
        await addRating({ imageId: currentImage.id, rating, damnedReason });
      } catch {
        playSound('challengeFail');
      }
    };

    const handleAddDamnedReason = async ({ reason }: { reason: NewOrderDamnedReason }) => {
      setDamnedReason({ open: false, reason: null });
      await handleAddRating({ rating: NsfwLevel.Blocked, damnedReason: reason });
    };

    const hotKeys: HotkeyItem[] = damnedReason.open
      ? [
          ['1', () => handleAddDamnedReason({ reason: NewOrderDamnedReason.InappropriateMinors })],
          ['2', () => handleAddDamnedReason({ reason: NewOrderDamnedReason.RealisticMinors })],
          [
            '3',
            () => handleAddDamnedReason({ reason: NewOrderDamnedReason.InappropriateRealPerson }),
          ],
          ['4', () => handleAddDamnedReason({ reason: NewOrderDamnedReason.Bestiality })],
          ['5', () => handleAddDamnedReason({ reason: NewOrderDamnedReason.GraphicViolence })],
        ]
      : [
          ['1', () => handleAddRating({ rating: NsfwLevel.PG })],
          ['2', () => handleAddRating({ rating: NsfwLevel.PG13 })],
          ['3', () => handleAddRating({ rating: NsfwLevel.R })],
          ['4', () => handleAddRating({ rating: NsfwLevel.X })],
          ['5', () => handleAddRating({ rating: NsfwLevel.XXX })],
          ['6', () => setDamnedReason({ open: true, reason: null })],
        ];

    useHotkeys([
      ['m', () => setMuted((prev) => !prev)],
      ['Escape', () => setDamnedReason({ open: false, reason: null })],
      ...hotKeys,
    ]);

    const currentImage = data[0];

    return (
      <GameErrorBoundary>
        {!isLoading && !playerData && !joined ? (
          <Welcome />
        ) : isLoading ? (
          <PageLoader />
        ) : playerData ? (
          <div className="-mt-4 flex h-full gap-4 bg-dark-9">
            <div className="hidden h-full w-[360px] shrink-0 overflow-y-auto bg-white p-4 md:block dark:bg-dark-7">
              {currentUser && (
                <PlayerCard
                  user={currentUser}
                  rank={playerData.rank}
                  exp={playerData.stats.exp}
                  fervor={playerData.stats.fervor}
                  gold={playerData.stats.blessedBuzz}
                  showStats={playerData.rank.type !== NewOrderRankType.Acolyte}
                />
              )}
              <MenuActions />
            </div>
            <div className="flex size-full items-center justify-center gap-4 px-4 py-8 md:overflow-hidden md:px-0">
              {loadingImagesQueue && (
                <Skeleton className="h-1/2 w-full max-w-sm p-4" visible animate />
              )}
              {currentImage ? (
                <div className="flex h-full flex-col items-center justify-center gap-4">
                  <div className="flex h-full max-h-[75%] items-center justify-center">
                    <div className="relative">
                      <EdgeMedia2
                        src={currentImage.url}
                        className="size-full max-w-full rounded-lg"
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
                  </div>
                  <ImageRater
                    muted={muted}
                    onVolumeClick={() => setMuted((prev) => !prev)}
                    onRatingClick={({ rating, damnedReason }) =>
                      damnedReason
                        ? handleAddDamnedReason({ reason: damnedReason })
                        : handleAddRating({ rating })
                    }
                  />
                </div>
              ) : null}
            </div>
          </div>
        ) : null}
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
