import { Button, Container, Stack, Text, Title } from '@mantine/core';
import pLimit from 'p-limit';
import { useRef, useState } from 'react';
import { getEdgeUrl } from '~/client-utils/cf-images-utils';
import { fetchBlob } from '~/utils/file-utils';
import { getDataFromFile } from '~/utils/metadata';
import { trpc } from '~/utils/trpc';

export default function ArticleImages() {
  const { data } = trpc.article.getAllForImageProcessing.useQuery(undefined);
  const [complete, setComplete] = useState(0);
  const [processing, setProcessing] = useState(false);

  const createImageMutation = trpc.image.createArticleCoverImage.useMutation();
  const deleteArticleMutation = trpc.article.delete.useMutation();
  const processedRef = useRef<Record<number, boolean>>({});

  const handleProcessImages = async () => {
    if (!data) return;
    setProcessing(true);
    const limit = pLimit(10);

    await Promise.all(
      data
        .filter(({ id, coverId, cover }) => !processedRef.current[id] || !coverId || !cover)
        .map(({ id, cover, userId }) =>
          limit(async () => {
            if (!cover) return;
            processedRef.current[id] = true;
            const lastIndex = cover.lastIndexOf('/');
            const name = cover.substring(lastIndex + 1);
            const blob = await fetchBlob(getEdgeUrl(cover, { name }));
            if (!blob) {
              await deleteArticleMutation.mutateAsync({ id });
              return;
            }

            const file = new File([blob], name, { type: blob.type });
            const data = await getDataFromFile(file);
            if (!data) return;
            const { id: coverId } = await createImageMutation.mutateAsync({
              entityType: 'Article',
              entityId: id,
              ...data,
              url: cover,
              userId,
            });
            setComplete((c) => c + 1);
            return { articleId: id, coverId };
          })
        )
    );
    setProcessing(false);
  };

  return (
    <Container>
      <Stack>
        <Title>Article Cover Image Processing</Title>
        <Text>This page only exists to transition article cover images to image entities</Text>
        <br />
        <Text>Articles to process: {data?.length ?? 0}</Text>
        {!!data?.length && (
          <>
            <Text>Articles processed: {complete}</Text>
            <Button onClick={handleProcessImages} disabled={processing}>
              Start processing
            </Button>
          </>
        )}
      </Stack>
    </Container>
  );
}
