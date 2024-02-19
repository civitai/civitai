import { Text, useMantineTheme } from '@mantine/core';
import pLimit from 'p-limit';
import { useEffect, useRef, useState } from 'react';
import { getEdgeUrl } from '~/client-utils/cf-images-utils';
import { fetchBlob } from '~/utils/file-utils';
import { getDataFromFile } from '~/utils/metadata';
import { trpc } from '~/utils/trpc';
import { isDefined } from '~/utils/type-guards';
import produce from 'immer';

const limit = pLimit(10);
export default function Test() {
  const theme = useMantineTheme();
  const queryUtils = trpc.useUtils();
  const filters = { limit: 10, missingCover: true, includeDrafts: true };
  const { data } = trpc.article.getAllForImageProcessing.useQuery(undefined);
  const [complete, setComplete] = useState(0);

  const createImageMutation = trpc.image.createArticleCoverImage.useMutation();
  const deleteArticleMutation = trpc.article.delete.useMutation();
  const processedRef = useRef<Record<number, boolean>>({});

  useEffect(() => {
    async function getFileData() {
      if (!data) return;

      const fileData = await Promise.all(
        data
          .filter(({ id, coverId, cover }) => !processedRef.current[id] || !coverId || !cover)
          .map(({ id, cover }) =>
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
              });
              setComplete((c) => c + 1);
              return { articleId: id, coverId };
            })
          )
      );

      return fileData.filter(isDefined);
    }
    getFileData();
  }, [data]);

  return (
    <>
      <Text>Complete: {complete}</Text>
    </>
  );
}
