import {
  ActionIcon,
  Badge,
  Center,
  CloseButton,
  Loader,
  LoadingOverlay,
  Modal,
  SegmentedControl,
  useMantineTheme,
} from '@mantine/core';
import { IconCheck, IconExternalLink, IconX } from '@tabler/icons-react';
import clsx from 'clsx';
import Link from 'next/link';
import { useState } from 'react';
import { useDialogContext } from '~/components/Dialog/DialogProvider';
import { EdgeMedia2 } from '~/components/EdgeMedia/EdgeMedia';
import { useQueryInfiniteKnightsNewOrderHistory } from '~/components/Games/KnightsNewOrder.utils';
import { InViewLoader } from '~/components/InView/InViewLoader';
import { MasonryContainer } from '~/components/MasonryColumns/MasonryContainer';
import { MasonryGrid } from '~/components/MasonryColumns/MasonryGrid';
import { MasonryProvider } from '~/components/MasonryColumns/MasonryProvider';
import { MasonryCard } from '~/components/MasonryGrid/MasonryCard';
import { NoContent } from '~/components/NoContent/NoContent';
import { useInView } from '~/hooks/useInView';
import { NewOrderImageRatingStatus, NsfwLevel } from '~/server/common/enums';
import { browsingLevelLabels } from '~/shared/constants/browsingLevel.constants';
import { GetJudgmentHistoryItem } from '~/types/router';

export default function JudgmentHistoryModal() {
  const dialog = useDialogContext();

  const [activeTab, setActiveTab] = useState<NewOrderImageRatingStatus | undefined>(undefined);

  const { images, isLoading, isFetching, isRefetching, hasNextPage, fetchNextPage } =
    useQueryInfiniteKnightsNewOrderHistory({ status: activeTab });

  return (
    <Modal
      {...dialog}
      transition="scale"
      size="80%"
      transitionDuration={300}
      withCloseButton={false}
      padding={0}
    >
      <div className="flex size-full max-h-full max-w-full flex-col">
        <div className="sticky top-[-48px] z-30 flex flex-col gap-1 bg-gray-0 p-5 dark:bg-dark-7">
          <div className="flex items-center justify-between">
            <h1 className="text-xl">Your Judgment History</h1>
            <CloseButton title="Close judgment history" onClick={dialog.onClose} />
          </div>
          <p className="text-sm text-gray-500">
            This is where you can view the history of your judgments. You can see the details of
            each judgment, including your rating, the final decision, and the image that was judged.
          </p>
          <SegmentedControl
            className="mt-2"
            value={activeTab ?? 'All'}
            onChange={(value) =>
              setActiveTab(value === 'All' ? undefined : (value as NewOrderImageRatingStatus))
            }
            data={[
              'All',
              NewOrderImageRatingStatus.Correct,
              NewOrderImageRatingStatus.Failed,
              NewOrderImageRatingStatus.Pending,
            ]}
          />
        </div>
        <MasonryProvider columnWidth={310} maxColumnCount={7} maxSingleColumnWidth={450}>
          <MasonryContainer py="xl">
            {isLoading ? (
              <Center>
                <Loader />
              </Center>
            ) : images.length ? (
              <div className="relative">
                <LoadingOverlay visible={isRefetching ?? false} zIndex={9} />
                <MasonryGrid
                  data={images}
                  render={JudgmentHistoryItem}
                  itemId={(data) => data.image.id}
                />
                {hasNextPage && (
                  <InViewLoader
                    loadFn={fetchNextPage}
                    loadCondition={!isFetching}
                    style={{ gridColumn: '1/-1' }}
                  >
                    <Center p="xl" mt="md">
                      <Loader />
                    </Center>
                  </InViewLoader>
                )}
              </div>
            ) : (
              <NoContent mt="lg" message="There are judgment entries" />
            )}
          </MasonryContainer>
        </MasonryProvider>
      </div>
    </Modal>
  );
}

type JudgmentHistoryProps = {
  data: GetJudgmentHistoryItem;
  height: number;
  width: number;
  index: number;
};

function JudgmentHistoryItem({ data, height }: JudgmentHistoryProps) {
  const { ref: inViewRef, inView } = useInView();
  const theme = useMantineTheme();

  const { image, rating, grantedExp, multiplier, status } = data;
  const totalExp = Math.floor(grantedExp * (multiplier ?? 1));
  const isPending = status === NewOrderImageRatingStatus.Pending;
  const isCorrect =
    status === NewOrderImageRatingStatus.Correct ||
    status === NewOrderImageRatingStatus.AcolyteCorrect;
  const borderClass = clsx(
    !isPending ? (isCorrect ? 'border border-green-5' : 'border border-red-5') : ''
  );

  return (
    <MasonryCard
      ref={inViewRef}
      className="relative"
      shadow="sm"
      style={{ minHeight: height }}
      withBorder
    >
      {inView && (
        <>
          <EdgeMedia2 src={image.url} className="h-full object-cover" type="image" width={450} />

          <ActionIcon
            component={Link}
            href={`/images/${image.id}`}
            target="_blank"
            aria-label="Open image in new tab"
            size="sm"
            variant="light"
            color="dark"
            className="absolute bottom-2 right-2 text-white"
          >
            <IconExternalLink size={16} color="currentColor" />
          </ActionIcon>

          <div className="absolute left-0 top-0 flex w-full justify-between gap-4 p-2">
            <div className="relative flex flex-col gap-1">
              <Badge
                variant="filled"
                color="gray"
                className={borderClass}
                leftSection={
                  !isPending ? (
                    isCorrect ? (
                      <IconCheck color={theme.colors.green[5]} size={18} />
                    ) : (
                      <IconX color={theme.colors.red[5]} size={18} />
                    )
                  ) : null
                }
              >
                {browsingLevelLabels[rating]}
              </Badge>
              {!isPending && !isCorrect && (
                <Badge className="mx-2 border border-blue-5" variant="filled" color="gray">
                  {browsingLevelLabels[image.nsfwLevel as NsfwLevel]}
                </Badge>
              )}
            </div>
            {!isPending && (
              <Badge
                variant="filled"
                color={!isPending ? (isCorrect ? 'green' : 'red') : 'gray'}
                leftSection="XP"
              >
                {isCorrect ? `+${totalExp}` : totalExp}
              </Badge>
            )}
          </div>
        </>
      )}
    </MasonryCard>
  );
}
