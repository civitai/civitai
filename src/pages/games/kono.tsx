import { ActionIcon, Button, Kbd, Skeleton, Text, Tooltip } from '@mantine/core';
import { HotkeyItem, useHotkeys } from '@mantine/hooks';
import {
  IconCrown,
  IconExternalLink,
  IconFlag,
  IconHistory,
  IconSkull,
  IconVolume,
  IconVolumeOff,
} from '@tabler/icons-react';
import Link from 'next/link';
import { useState } from 'react';
import ConfirmDialog from '~/components/Dialog/Common/ConfirmDialog';
import { dialogStore } from '~/components/Dialog/dialogStore';
import { EdgeMedia2 } from '~/components/EdgeMedia/EdgeMedia';
import GameErrorBoundary from '~/components/Games/GameErrorBoundary';
import {
  damnedReasonOptions,
  openJudgementHistoryModal,
  ratingOptions,
  ratingPlayBackRates,
  useAddImageRatingMutation,
  useJoinKnightsNewOrder,
  useKnightsNewOrderListener,
  useQueryKnightsNewOrderImageQueue,
} from '~/components/Games/KnightsNewOrder.utils';
import { PlayerCard } from '~/components/Games/PlayerCard';
import { PageLoader } from '~/components/PageLoader/PageLoader';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { useGameSounds } from '~/hooks/useGameSounds';
import { useStorage } from '~/hooks/useStorage';
import { NewOrderDamnedReason, NsfwLevel } from '~/server/common/enums';
import { AddImageRatingInput } from '~/server/schema/games/new-order.schema';
import { createServerSideProps } from '~/server/utils/server-side-helpers';
import { browsingLevelDescriptions } from '~/shared/constants/browsingLevel.constants';
import { NewOrderRankType } from '~/shared/utils/prisma/enums';
import { getLoginLink } from '~/utils/login-helpers';
import { getDisplayName } from '~/utils/string-helpers';

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

  const [damnedReason, setDamnedReason] = useState<{
    open: boolean;
    reason: NewOrderDamnedReason | null;
  }>({ open: false, reason: null });
  const [muted, setMuted] = useStorage({
    key: 'knights-new-order-muted',
    type: 'localStorage',
    defaultValue: false,
  });

  const { joinKnightsNewOrder, playerData, isLoading, joined } = useJoinKnightsNewOrder();
  const { addRating, isLoading: sendingRating } = useAddImageRatingMutation();
  const { data, isLoading: loadingImagesQueue } = useQueryKnightsNewOrderImageQueue();

  useKnightsNewOrderListener();

  const playSound = useGameSounds({ volume: muted ? 0 : 0.5 });

  const handleAddRating = async ({
    rating,
    damnedReason,
  }: Omit<AddImageRatingInput, 'playerId' | 'imageId'>) => {
    if (sendingRating || !currentImage) return;

    try {
      playSound(rating === NsfwLevel.Blocked ? 'buzz' : 'point', ratingPlayBackRates[rating]);
      await addRating({ imageId: currentImage.id, rating, damnedReason });
    } catch {
      playSound('challengeFail');
    }
  };

  const handleAddDamnedReason = async ({ reason }: { reason: NewOrderDamnedReason }) => {
    await handleAddRating({ rating: NsfwLevel.Blocked, damnedReason: reason });
    setDamnedReason({ open: false, reason: null });
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
        <div className="-mt-4 flex h-full gap-4 bg-dark-9">
          <div className="h-full w-[360px] shrink-0 overflow-y-auto bg-white p-4 dark:bg-dark-7">
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
            <div className="mt-2 flex flex-col gap-2">
              <Button
                variant="light"
                leftIcon={<IconHistory />}
                onClick={() => openJudgementHistoryModal()}
                fullWidth
              >
                Judgement History
              </Button>
              <Button
                component={Link}
                href="/leaderboard/knights-of-new-order"
                color="yellow"
                variant="light"
                leftIcon={<IconCrown />}
                fullWidth
              >
                View Leaderboard
              </Button>
              <Button
                color="red"
                variant="light"
                leftIcon={<IconSkull />}
                onClick={() => {
                  dialogStore.trigger({
                    component: ConfirmDialog,
                    type: 'dialog',
                    props: {
                      title: 'Are you sure?',
                      message: 'This will restart your career and reset all your progress.',
                      labels: { cancel: 'No', confirm: `Yes, I'm sure` },
                      onConfirm: async () => {
                        // TODO.newOrder: implement restart career
                        console.log('Restarting career...');
                      },
                      confirmProps: { color: 'red' },
                    },
                  });
                }}
                fullWidth
              >
                Restart Career
              </Button>
            </div>
          </div>
          <div className="flex h-[calc(100%-var(--footer-height)-56px)] w-full flex-col items-center justify-center gap-4 overflow-hidden">
            <Skeleton visible={loadingImagesQueue} width={700} height={525} animate>
              {currentImage ? (
                <div className="flex h-full flex-col items-center gap-4">
                  <div className="relative h-full">
                    <EdgeMedia2
                      src={currentImage.url}
                      className="h-full w-auto max-w-full rounded-lg object-contain"
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
                  <div className="flex flex-col gap-2">
                    <Button.Group>
                      {damnedReason.open
                        ? damnedReasonOptions.map((reason) => {
                            const damnedReason = NewOrderDamnedReason[reason];

                            return (
                              <Button
                                key={reason}
                                classNames={{
                                  root: 'h-auto',
                                  label: 'whitespace-normal leading-normal text-center',
                                }}
                                maw={150}
                                variant="default"
                                onClick={() => handleAddDamnedReason({ reason: damnedReason })}
                              >
                                {getDisplayName(damnedReason)}
                              </Button>
                            );
                          })
                        : ratingOptions.map((rating) => {
                            const level = NsfwLevel[rating];
                            const isBlocked = level === 'Blocked';

                            return (
                              <Tooltip
                                key={rating}
                                label={browsingLevelDescriptions[rating]}
                                position="top"
                                openDelay={1000}
                                maw={350}
                                withArrow
                                multiline
                              >
                                <Button
                                  key={rating}
                                  variant={isBlocked ? 'filled' : 'default'}
                                  color={isBlocked ? 'red' : undefined}
                                  onClick={() =>
                                    isBlocked
                                      ? setDamnedReason({ open: true, reason: null })
                                      : handleAddRating({ rating })
                                  }
                                >
                                  {isBlocked ? <IconFlag size={18} /> : level}
                                </Button>
                              </Tooltip>
                            );
                          })}
                    </Button.Group>
                    <div className="flex w-full justify-between gap-2">
                      <Text size="xs">
                        Use the numbers <Kbd>1-6</Kbd> to rate.
                        {damnedReason.open && (
                          <>
                            {' '}
                            <Kbd>Esc</Kbd> to cancel
                          </>
                        )}
                      </Text>
                      <ActionIcon
                        size="sm"
                        variant="transparent"
                        onClick={() => setMuted((prev) => !prev)}
                      >
                        {muted ? <IconVolumeOff size={16} /> : <IconVolume size={16} />}
                      </ActionIcon>
                    </div>
                  </div>
                </div>
              ) : null}
            </Skeleton>
          </div>
        </div>
      ) : null}
    </GameErrorBoundary>
  );
}
