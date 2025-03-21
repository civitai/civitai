import { dbRead } from '~/server/db/client';
import { createServerSideProps } from '~/server/utils/server-side-helpers';
import { InferGetServerSidePropsType } from 'next';
import { NextLink } from '~/components/NextLink/NextLink';
import { Text, Pagination } from '@mantine/core';
import { useState } from 'react';

export const getServerSideProps = createServerSideProps({
  useSSG: true,
  useSession: true,
  resolver: async ({ ctx, ssg }) => {
    const duplicates = await dbRead.$queryRaw<
      { hash: string; items: { createdAt: string; modelId: number; modelVersionId: number }[] }[]
    >`
    WITH model_file_hashes AS (
      SELECT
        mfh.hash
      FROM "ModelFileHash" mfh
      JOIN "ModelFile" mf on mf.id = mfh."fileId"
      WHERE mfh.type = 'AutoV2'
      AND mf.type = 'Model'
      GROUP BY mfh.hash
      HAVING COUNT(*) > 1
    ),
    model_data AS (
      SELECT
        mfh.hash,
        mfh."createdAt",
        mv.id "modelVersionId",
        m.id "modelId"
      FROM "ModelFileHash" mfh
      JOIN "ModelFile" mf ON mfh."fileId" = mf.id
      JOIN "ModelVersion" mv ON mf."modelVersionId" = mv.id
      JOIN "Model" m ON mv."modelId" = m.id
      WHERE mfh.type = 'AutoV2'
      AND m.status NOT IN ('Deleted', 'Unpublished', 'UnpublishedViolation')
      AND mfh.hash IN (SELECT * FROM model_file_hashes)
      ORDER BY mfh.hash, "createdAt"
    ),
    unique_model_data AS (
      SELECT
        hash,
        json_agg(
          json_build_object(
            'createdAt', "createdAt",
            'modelId', "modelId",
            'modelVersionId', "modelVersionId"
          )
        ) items
      FROM model_data
      GROUP BY hash
      HAVING COUNT(*) > 1
    )
    select * from unique_model_data
    `;

    // array_agg(concat('https://civitai.com/models/', "modelId", '?modelVersionId=', "modelVersionId")) urls

    const items = duplicates.map(({ hash, items }) => ({
      hash,
      items: items.map(({ createdAt, modelId, modelVersionId }) => ({
        createdAt: createdAt,
        url: `https://civitai.com/models/${modelId}?modelVersionId=${modelVersionId}`,
      })),
    }));

    // console.dir(values.slice(0, 10), { depth: null });

    return {
      props: {
        duplicates: items,
      },
    };
  },
});

export default function DuplicatHashesPage({
  duplicates,
}: InferGetServerSidePropsType<typeof getServerSideProps>) {
  const [page, setPage] = useState(1);

  const pageSize = 10;
  const pages = Math.ceil(duplicates.length / pageSize);

  const pageItems = duplicates.slice(pageSize * (page - 1), pageSize * page);

  return (
    <div className="container max-w-sm">
      <h1 className="text-4xl font-bold">Duplicate Model Hashes</h1>
      <ul role="list" className="divide-y divide-gray-4 dark:divide-dark-5">
        {pageItems.map(({ hash, items }) => (
          <li key={hash} className="flex flex-col gap-1 p-1 py-2">
            {items
              .map(({ createdAt, url }) => ({ createdAt: new Date(createdAt), url }))
              .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
              .map(({ url, createdAt }, index) => {
                return (
                  <div key={index} className="flex gap-1">
                    <Text size="sm">{createdAt.toLocaleDateString()}</Text>
                    <Text size="sm" variant="link" component={NextLink} href={url} target="_blank">
                      {url}
                    </Text>
                  </div>
                );
              })}
          </li>
        ))}
      </ul>
      <Pagination total={pages} page={page} onChange={setPage} />
    </div>
  );
}
