import { Container, Select, Skeleton, Stack } from '@mantine/core';
import { useRouter } from 'next/router';
import { ContentClamp } from '~/components/ContentClamp/ContentClamp';
import { RenderHtml } from '~/components/RenderHtml/RenderHtml';
import { getResourceReviewPagedSchema } from '~/server/schema/resourceReview.schema';
import { createServerSideProps } from '~/server/utils/server-side-helpers';
import { removeEmpty } from '~/utils/object-helpers';
import { QS } from '~/utils/qs';
import { trpc } from '~/utils/trpc';

export const getServerSideProps = createServerSideProps({
  useSSG: true,
  resolver: async ({ ctx, ssg }) => {
    const params = (ctx.params ?? {}) as { id: string };
    const result = getResourceReviewPagedSchema.safeParse({ modelId: params.id, ...ctx.query });
    if (!result.success) return { notFound: true };

    await Promise.all([
      ssg?.resourceReview.getPaged.prefetch(result.data),
      ssg?.model.getSimple.prefetch({ id: result.data.modelId }),
      ssg?.model.getVersions.prefetch({ id: result.data.modelId }),
    ]);
  },
});

export default function ModelReviews() {
  const router = useRouter();
  const modelId = router.query.id;
  const queryParams = getResourceReviewPagedSchema.parse({ modelId, ...router.query });

  const { data: model, isLoading: loadingModel } = trpc.model.getSimple.useQuery({
    id: queryParams.modelId,
  });
  const { data: versions, isLoading: loadingVersions } = trpc.model.getVersions.useQuery({
    id: queryParams.modelId,
  });
  const { data: resourceReviews, isLoading: loadingResourceReviews } =
    trpc.resourceReview.getPaged.useQuery(queryParams);

  const handleModelVersionChange = (value: string | null) => {
    router.replace(
      {
        query: removeEmpty({
          ...router.query,
          modelVersionId: value ? Number(value) : undefined,
          page: 1,
        }),
      },
      undefined,
      { shallow: true }
    );
  };

  const Model = loadingModel ? (
    <>
      <Skeleton />
    </>
  ) : (
    <></>
  );

  console.log(router.query.modelVersionId);

  const Versions = loadingVersions ? (
    <Skeleton />
  ) : !!versions?.length ? (
    <Select
      placeholder="Select a model version"
      clearable
      data={versions.map((version) => ({ label: version.name, value: version.id.toString() }))}
      value={(router.query.modelVersionId as string) ?? null}
      onChange={handleModelVersionChange}
    />
  ) : null;

  return (
    <Container>
      <Stack>{Versions}</Stack>

      <Stack>
        {resourceReviews?.items.map((review) => (
          <Stack key={review.id}>
            {review.details && (
              <ContentClamp maxHeight={300}>
                <RenderHtml html={review.details} />
              </ContentClamp>
            )}
          </Stack>
        ))}
      </Stack>
    </Container>
  );
}
