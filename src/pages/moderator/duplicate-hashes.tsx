import { dbRead } from '~/server/db/client';
import { createServerSideProps } from '~/server/utils/server-side-helpers';
import type { InferGetServerSidePropsType } from 'next';
import { NextLink } from '~/components/NextLink/NextLink';
import { Text, Pagination, Badge, SegmentedControl } from '@mantine/core';
import { useState, useMemo } from 'react';
import { env } from '~/env/client';
import { ModelStatus } from '~/shared/utils/prisma/enums';

export const getServerSideProps = createServerSideProps({
  useSSG: true,
  useSession: true,
  resolver: async () => {
    const duplicates = await dbRead.$queryRaw<
      {
        hash: string;
        items: {
          createdAt: string;
          modelId: number;
          modelVersionId: number;
          status: ModelStatus;
        }[];
      }[]
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
        m.id "modelId",
        mv.status
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
            'status', "status",
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
      items: items.map(({ createdAt, modelId, modelVersionId, status }) => ({
        createdAt: createdAt,
        url: `${env.NEXT_PUBLIC_BASE_URL}/models/${modelId}?modelVersionId=${modelVersionId}`,
        status,
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
  const [filters, setFilters] = useState<{ page: number; status: 'All' | 'Draft' }>({
    page: 1,
    status: 'All',
  });

  const items = useMemo(() => {
    return duplicates.filter(({ items }) =>
      filters.status !== 'All' ? items.some((x) => x.status === filters.status) : true
    );
  }, [duplicates, filters.status]);

  const pageSize = 10;
  const pages = Math.ceil(items.length / pageSize);

  function handleSetStatus(status: 'All' | 'Draft') {
    setFilters({ page: 1, status });
  }

  function handleSetPage(page: number) {
    setFilters((state) => ({ ...state, page }));
  }

  const pageItems = items.slice(pageSize * (filters.page - 1), pageSize * filters.page);

  return (
    <div className="container max-w-sm">
      <h1 className="text-4xl font-bold">Duplicate Model Hashes</h1>
      <SegmentedControl
        data={['All', 'Draft']}
        onChange={(status) => handleSetStatus(status as 'All' | 'Draft')}
        value={filters.status}
      />
      <ul role="list" className="divide-y divide-gray-4 dark:divide-dark-5">
        {pageItems.map(({ hash, items }) => (
          <li key={hash} className="flex flex-col gap-1 p-1 py-2">
            {items
              .map(({ createdAt, url, status }) => ({
                createdAt: new Date(createdAt),
                url,
                status,
              }))
              .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
              .map(({ url, createdAt, status }, index) => {
                return (
                  <div key={index} className="flex gap-1">
                    {status !== ModelStatus.Published && (
                      <Badge color="yellow" radius="sm">
                        {status}
                      </Badge>
                    )}
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
      <Pagination total={pages} value={filters.page} onChange={handleSetPage} />
    </div>
  );
}
