import { Alert, Badge, Card, Center, Drawer, Loader, Stack, Text } from '@mantine/core';
import { IconInbox } from '@tabler/icons-react';
import { useMemo } from 'react';
import { GeneratedImage } from '~/components/ImageGeneration/GeneratedImage';
import { GenerationDetails } from '~/components/ImageGeneration/GenerationDetails';
import { GenerationStatusBadge } from '~/components/ImageGeneration/GenerationStatusBadge';
import { BlobData } from '~/components/ImageGeneration/utils/BlobData';
import { InViewLoader } from '~/components/InView/InViewLoader';
import { IntersectionObserverProvider } from '~/components/IntersectionObserver/IntersectionObserverProvider';
import { LineClamp } from '~/components/LineClamp/LineClamp';
import { ScrollArea } from '~/components/ScrollArea/ScrollArea';
import { useAppContext } from '~/providers/AppProvider';
import type {
  NormalizedGeneratedImageResponse,
  NormalizedGeneratedImageStep,
} from '~/server/services/orchestrator';
import { WORKFLOW_TAGS } from '~/shared/constants/generation.constants';
import { formatDateMin } from '~/utils/date-helpers';
import { trpc } from '~/utils/trpc';

type UserGenerationsDrawerProps = {
  opened: boolean;
  onClose: () => void;
  userId: number;
  username?: string;
};

export function UserGenerationsDrawer({
  opened,
  onClose,
  userId,
  username,
}: UserGenerationsDrawerProps) {
  const { domain } = useAppContext();

  const { data, isLoading, fetchNextPage, hasNextPage, isFetching, isRefetching, isError, error } =
    trpc.orchestrator.queryUserGeneratedImages.useInfiniteQuery(
      {
        userId,
        tags: [WORKFLOW_TAGS.GENERATION],
      },
      {
        getNextPageParam: (lastPage) => (lastPage ? lastPage.nextCursor : 0),
        enabled: opened,
      }
    );

  const flatData = useMemo(
    () =>
      data?.pages.flatMap((x) =>
        (x.items ?? []).map((workflow) => {
          const steps = workflow.steps.map((step) => {
            const images = step.images
              .filter((image) => {
                const imageMeta = step.metadata?.images?.[image.id];
                return !imageMeta?.hidden;
              })
              .map(
                (image) =>
                  new BlobData({
                    data: image,
                    step: step,
                    allowMatureContent: workflow.allowMatureContent,
                    domain,
                    nsfwEnabled: true, // Moderators should see all content
                  })
              );
            return { ...step, images };
          });
          return { ...workflow, steps };
        })
      ) ?? [],
    [data, domain]
  );

  return (
    <Drawer
      opened={opened}
      onClose={onClose}
      title={`Generations: ${username ?? `User #${userId}`}`}
      position="right"
      size="xl"
      padding={0}
      classNames={{ body: 'h-full' }}
    >
      <ScrollArea className="h-full p-4">
        <IntersectionObserverProvider id="user-generations-drawer">
          {isError && (
            <Alert color="red">
              <Text ta="center">Could not retrieve generation requests</Text>
              {error && (
                <Text ta="center" size="xs">
                  {error.data && `Status ${error.data?.httpStatus}:`} {error.message}
                </Text>
              )}
            </Alert>
          )}

          {isLoading && (
            <Center p="xl">
              <Loader />
            </Center>
          )}

          {!isLoading && !flatData.length && (
            <div className="flex h-full flex-col items-center justify-center gap-3">
              <Stack gap="xs" align="center" py="16">
                <IconInbox size={64} stroke={1} />
                <Text size="md" ta="center">
                  No generations found
                </Text>
                <Text size="sm" c="dimmed">
                  This user has no generation history in the last 30 days.
                </Text>
              </Stack>
            </div>
          )}

          {!isLoading && flatData.length > 0 && (
            <div className="flex flex-col gap-2">
              {flatData.map((request) => (
                <UserGenerationItem key={request.id} request={request} />
              ))}
              {hasNextPage && (
                <InViewLoader
                  loadFn={fetchNextPage}
                  loadCondition={!isFetching && !isRefetching && hasNextPage}
                >
                  <Center style={{ height: 60 }}>
                    <Loader />
                  </Center>
                </InViewLoader>
              )}
            </div>
          )}
        </IntersectionObserverProvider>
      </ScrollArea>
    </Drawer>
  );
}

type GenerationRequest = NormalizedGeneratedImageResponse & {
  steps: Array<NormalizedGeneratedImageStep & { images: BlobData[] }>;
};

function UserGenerationItem({ request }: { request: GenerationRequest }) {
  const step = request.steps[0];
  const { status } = request;
  const { params } = step;
  const images = step.images;

  const completedCount = images.filter((x) => x.status === 'succeeded').length;
  const processingCount = images.filter((x) => x.status === 'processing').length;

  const { prompt, ...details } = params;

  const { data: workflowDefinitions } = trpc.generation.getWorkflowDefinitions.useQuery();
  const workflowDefinition = workflowDefinitions?.find((x) => x.key === params.workflow);

  const displayImages = images.filter((x) => !x.blockedReason);
  const blockedCount = images.length - displayImages.length;

  return (
    <Card withBorder px="xs">
      <Card.Section py={4} inheritPadding withBorder>
        <div className="flex flex-wrap items-center gap-1">
          {!!images.length && (
            <GenerationStatusBadge
              status={request.status}
              complete={completedCount}
              processing={processingCount}
              quantity={images.length}
              tooltipLabel={status}
              progress
            />
          )}
          <Text size="xs" c="dimmed">
            {formatDateMin(request.createdAt)}
          </Text>
          {blockedCount > 0 && (
            <Badge size="xs" color="red" variant="light">
              {blockedCount} blocked
            </Badge>
          )}
        </div>
      </Card.Section>

      <div className="flex flex-col gap-3 py-3">
        {prompt && <LineClamp lh={1.3}>{prompt}</LineClamp>}

        <div className="-my-2 flex gap-2">
          {workflowDefinition && (
            <Badge radius="sm" color="violet" size="sm">
              {workflowDefinition.label}
            </Badge>
          )}
        </div>

        {displayImages.length > 0 && (
          <div className="grid grid-cols-3 gap-2">
            {displayImages.map((image, index) => (
              <GeneratedImage
                key={index}
                image={image}
                request={request as NormalizedGeneratedImageResponse}
                step={step}
              />
            ))}
          </div>
        )}
      </div>

      <Card.Section withBorder className="-mx-2">
        <GenerationDetails
          label="Additional Details"
          params={details}
          labelWidth={150}
          paperProps={{ radius: 0, style: { borderWidth: '1px 0 0 0' } }}
        />
      </Card.Section>
    </Card>
  );
}
