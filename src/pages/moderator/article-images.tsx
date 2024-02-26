import { Button, Container, Stack, Text, Title } from '@mantine/core';
import pLimit from 'p-limit';
import { useMemo, useRef, useState } from 'react';
import { getEdgeUrl } from '~/client-utils/cf-images-utils';
import { fetchBlob } from '~/utils/file-utils';
import { getDataFromFile } from '~/utils/metadata';
import { trpc } from '~/utils/trpc';
import { isDefined } from '~/utils/type-guards';

export default function ArticleImages() {
  const { data = [] } = trpc.article.getAllForImageProcessing.useQuery(undefined);
  const [complete, setComplete] = useState(0);
  const [processing, setProcessing] = useState(false);
  const [ingesting, setIngesting] = useState(false);
  const [ingested, setIngested] = useState(0);

  const createImageMutation = trpc.image.createArticleCoverImage.useMutation();
  const deleteArticleMutation = trpc.article.delete.useMutation();
  const processedRef = useRef<Record<number, boolean>>({});
  const articleImageIngestMutation = trpc.image.ingestArticleImages.useMutation();

  const toProcess = useMemo(() => data.filter(({ coverId }) => !coverId), [data]);
  const toIngest = useMemo(
    () => data.filter((x) => x.coverImage && !x.coverImage.scannedAt),
    [data]
  );

  const handleProcessImages = async () => {
    setProcessing(true);
    const limit = pLimit(10);

    await Promise.all(
      toProcess
        .filter(({ id, cover }) => !processedRef.current[id] || !cover)
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

  const handleIngestImages = async () => {
    const limit = pLimit(1);
    setIngesting(true);
    const chunkSize = 50;
    const arrays: Array<{ imageId: number; articleId: number }[]> = [];
    for (let i = 0; i < toIngest.length; i += chunkSize) {
      const chunk = toIngest
        .map((x) => {
          if (!x.coverId) return null;
          return { imageId: x.coverId, articleId: x.id };
        })
        .filter(isDefined)
        .slice(i, i + chunkSize);
      arrays.push(chunk);
    }
    await Promise.all(
      arrays.map((array) =>
        limit(async () => {
          await articleImageIngestMutation.mutateAsync(array);
          setIngested((c) => c + array.length);
        })
      )
    );

    setIngesting(false);
  };

  return (
    <Container>
      <Stack>
        <Title>Article Cover Image Processing</Title>
        <Text>This page only exists to transition article cover images to image entities</Text>
        <br />
        {!!toProcess.length && (
          <>
            <Text>Articles to process: {toProcess?.length ?? 0}</Text>
            <Text>Articles processed: {complete}</Text>
            <Button onClick={handleProcessImages} disabled={processing}>
              Start processing
            </Button>
          </>
        )}
        {!!toIngest.length && (
          <>
            <Text>Images to ingest: {toIngest?.length ?? 0}</Text>
            <Text>Queued for ingestion: {ingested}</Text>
            <Button onClick={handleIngestImages} disabled={ingesting}>
              Bulk Ingest (low priority)
            </Button>
          </>
        )}
      </Stack>
    </Container>
  );
}
