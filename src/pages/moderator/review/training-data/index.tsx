import { Button, Center, Group, Loader, Text, Title, Tooltip, Badge } from '@mantine/core';
import { IconRefresh } from '@tabler/icons-react';
import { useRouter } from 'next/router';
import { useMemo } from 'react';
import { InViewLoader } from '~/components/InView/InViewLoader';
import { LegacyActionIcon } from '~/components/LegacyActionIcon/LegacyActionIcon';
import { Meta } from '~/components/Meta/Meta';
import { NextLink as Link } from '~/components/NextLink/NextLink';
import { NoContent } from '~/components/NoContent/NoContent';
import FourOhFour from '~/pages/404';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { formatDate } from '~/utils/date-helpers';
import { showErrorNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';

export default function ReviewTrainingDataPage() {
  const features = useFeatureFlags();
  const router = useRouter();
  const queryUtils = trpc.useUtils();

  // TODO maybe hook into orchestrator and pull Gate
  const { data, isFetching, hasNextPage, fetchNextPage, isInitialLoading } =
    trpc.moderator.modelVersions.query.useInfiniteQuery(
      { limit: 20, trainingStatus: 'Paused' },
      { getNextPageParam: (lastPage) => lastPage.nextCursor }
    );

  const recheckTrainingStatusMutation = trpc.modelVersion.recheckTrainingStatus.useMutation({
    onSuccess: async () => {
      await queryUtils.moderator.modelVersions.invalidate();
    },
    onError: (error) => {
      showErrorNotification({
        title: 'Failed to recheck training status',
        error: new Error(error.message),
      });
    },
  });

  const handleRecheckTrainingStatus = (modelVersionId: number) => {
    queryUtils.moderator.modelVersions.invalidate();
  };

  const flatData = useMemo(() => data?.pages.flatMap((x) => x.items), [data]);

  if (!features.reviewTrainingData) return <FourOhFour />;

  return (
    <>
      <Meta title="Moderator | Review Training Data" deIndex />
      <div className="container max-w-sm p-3">
        <Title order={1}>Review training data</Title>
        {isInitialLoading ? (
          <Center py="lg">
            <Loader />
          </Center>
        ) : !flatData || flatData.length === 0 ? (
          <Center py="lg">
            <NoContent message="None to review" />
          </Center>
        ) : (
          <div className="flex flex-col gap-3">
            {flatData?.map((item) => {
              return (
                <div key={item.id} className="flex items-center justify-between gap-3 p-3 card">
                  <div className="flex flex-col items-center">
                    <Text lineClamp={1}>
                      {item.model.name} - {item.name}
                    </Text>
                    <Text c="dimmed" size="xs">
                      Created: {formatDate(item.createdAt)}
                    </Text>
                    <Text c="dimmed" size="xs">
                      WorkflowId: {item.workflowId}
                    </Text>
                  </div>
                  <Group>
                    <Button size="compact-sm" component={Link} href={`${router.asPath}/${item.id}`}>
                      Review
                    </Button>

                    <Tooltip label="Recheck Training Status" withArrow>
                      <LegacyActionIcon
                        variant="light"
                        size="md"
                        radius="xl"
                        loading={
                          recheckTrainingStatusMutation.isLoading &&
                          recheckTrainingStatusMutation.variables?.id === item.id
                        }
                        onClick={() => handleRecheckTrainingStatus(item.id)}
                      >
                        <IconRefresh size={16} />
                      </LegacyActionIcon>
                    </Tooltip>
                  </Group>
                </div>
              );
            })}
          </div>
        )}
        {hasNextPage && (
          <InViewLoader loadFn={fetchNextPage} loadCondition={!isFetching}>
            <div className="mt-3 flex justify-center p-3">
              <Loader />
            </div>
          </InViewLoader>
        )}
      </div>
    </>
  );
}
