import { Container, Group, Stack, Center, Loader, Text, ActionIcon } from '@mantine/core';
import { IconArrowLeft } from '@tabler/icons';
import { BackButton, NavigateBack } from '~/components/BackButton/BackButton';
import { NoContent } from '~/components/NoContent/NoContent';
import { trpc } from '~/utils/trpc';
import { slugit, getDisplayName } from '~/utils/string-helpers';
import { QS } from '~/utils/qs';
import { useRouter } from 'next/router';
import { useEffect } from 'react';
import { ResourceReviewDetailModel } from '~/server/services/resourceReview.service';
import { ResourceReviewCard } from '~/components/ResourceReview/ResourceReviewCard';
import { ResourceReviewCarousel } from '~/components/ResourceReview/ResourceReviewCarousel';

export function ResourceReviewDetail({ reviewId }: { reviewId: number }) {
  const router = useRouter();
  const { data, isLoading } = trpc.resourceReview.get.useQuery({ id: reviewId });

  const getModelUrl = (data: ResourceReviewDetailModel) =>
    `/models/${data.model.id}/${slugit(data.model.name)}`;
  const getModelWithVersionUrl = (data: ResourceReviewDetailModel) =>
    `${getModelUrl}?modelVersionId=${data.modelVersion.id}`;

  // // when a user navigates back in their browser, set the previous url with the query string model={id}
  // useEffect(() => {
  //   if (!data) return;
  //   const modelUrl = getModelUrl(data);
  //   const modelWithVersionUrl = getModelWithVersionUrl(data);
  //   router.beforePopState(({ as, url }) => {
  //     if (!as.startsWith(modelUrl)) {
  //       return false;
  //     }

  //     return true;
  //   });

  //   return () => router.beforePopState(() => true);
  // }, [reviewId, data]); // Add any state variables to dependencies array if needed.

  if (isLoading)
    return (
      <Center p="xl">
        <Loader />
      </Center>
    );
  if (!data) return <NoContent />;

  return (
    <Container>
      <Stack>
        <Group>
          <NavigateBack url={getModelWithVersionUrl(data)}>
            {({ onClick }) => (
              <Text variant="link" onClick={onClick}>
                <Group spacing="xs">
                  <IconArrowLeft />
                  {data.model.name}
                </Group>
              </Text>
            )}
          </NavigateBack>
        </Group>
        {data.user.username && (
          <ResourceReviewCarousel
            username={data.user.username}
            modelVersionId={data.modelVersion.id}
            reviewId={reviewId}
          />
        )}
      </Stack>
    </Container>
  );
}
