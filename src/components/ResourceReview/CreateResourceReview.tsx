import { trpc } from '~/utils/trpc';

export function CreateResourceReview({
  userId,
  modelVersionId,
  modelId,
}: {
  userId: number;
  modelVersionId: number;
  modelId: number;
}) {
  const { mutate, isLoading } = trpc.resourceReview.create.useMutation({
    onSuccess: async () => {
      //TODO - invalidation
    },
  });

  return <></>;
}
