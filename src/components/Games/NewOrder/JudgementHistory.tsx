import {
  ActionIcon,
  Badge,
  Center,
  Loader,
  LoadingOverlay,
  SegmentedControl,
  useMantineTheme,
} from '@mantine/core';
import { IconCheck, IconExternalLink, IconX } from '@tabler/icons-react';
import clsx from 'clsx';
import Link from 'next/link';
import { useState } from 'react';
import { useDialogContext } from '~/components/Dialog/DialogProvider';
import { PageModal } from '~/components/Dialog/Templates/PageModal';
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
import { GetJudgementHistoryItem } from '~/types/router';

export default function JudgementHistoryModal() {
  const dialog = useDialogContext();

  const [activeTab, setActiveTab] = useState<NewOrderImageRatingStatus | undefined>();

  const { images, isLoading, isRefetching, hasNextPage, fetchNextPage } =
    useQueryInfiniteKnightsNewOrderHistory({ status: activeTab });

  return (
    <PageModal
      {...dialog}
      transition="scale"
      title={
        <div className="flex flex-col gap-1">
          <h1 className="text-xl">Your Judgement History</h1>
          <p className="text-sm text-gray-500">
            This is where you can view the history of your judgements. You can see the details of
            each judgement, including your rating, the final decision, and the image that was
            judged.
          </p>
        </div>
      }
      transitionDuration={300}
      fullScreen
    >
      <SegmentedControl
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
                render={JudgementHistoryItem}
                itemId={(data) => data.image.id}
              />
              {hasNextPage && (
                <InViewLoader
                  loadFn={fetchNextPage}
                  loadCondition={!isRefetching && hasNextPage}
                  style={{ gridColumn: '1/-1' }}
                >
                  <Center p="xl" mt="md">
                    <Loader />
                  </Center>
                </InViewLoader>
              )}
            </div>
          ) : (
            <NoContent mt="lg" message="" />
          )}
        </MasonryContainer>
      </MasonryProvider>
    </PageModal>
  );
}

type JudgementHistoryProps = {
  data: GetJudgementHistoryItem;
  height: number;
  width: number;
  index: number;
};

function JudgementHistoryItem({ data, height }: JudgementHistoryProps) {
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
