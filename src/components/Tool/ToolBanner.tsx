import { Button, Title, Text } from '@mantine/core';
import { useEffect, useState } from 'react';
import { useImageQueryParams } from '~/components/Image/image.utils';
import { MasonryContainer } from '~/components/MasonryColumns/MasonryContainer';
import { trpc } from '~/utils/trpc';

export function ToolBanner() {
  const { query } = useImageQueryParams();
  const { tools: toolIds } = query;
  const selectedId = toolIds?.[0];

  const { data } = trpc.tool.getAll.useQuery(undefined, { enabled: !!toolIds?.length });
  const selected = data?.find((x) => x.id === selectedId);

  if (!data || !selected) return null;

  return (
    <div className="-mt-4 mb-3 bg-gray-1 px-3 py-6 dark:bg-dark-9">
      <MasonryContainer>
        <div className="flex max-w-md flex-col gap-2">
          <div className="flex justify-between gap-3">
            <Title order={2} className="font-semibold">
              {selected.name}
            </Title>
            {/* <div className="flex flex-wrap gap-1">
              {data
                .filter((tool) => toolIds?.includes(tool.id))
                .map((tool) => (
                  <Button
                    key={tool.id}
                    compact
                    onClick={() => setSelectedId(tool.id)}
                    variant="default"
                  >
                    {tool.name}
                  </Button>
                ))}
            </div> */}
          </div>
          <Text>{selected.description}</Text>
        </div>
      </MasonryContainer>
    </div>
  );
}
