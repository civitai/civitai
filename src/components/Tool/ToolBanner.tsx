import { Button, Title, Text } from '@mantine/core';
import { useEffect, useState } from 'react';
import { MasonryContainer } from '~/components/MasonryColumns/MasonryContainer';
import { useFiltersContext } from '~/providers/FiltersProvider';
import { trpc } from '~/utils/trpc';

export function ToolBanner() {
  const toolIds = useFiltersContext((state) => state.images.tools);
  const [selectedId, setSelectedId] = useState(toolIds?.[0] ?? null);

  const { data } = trpc.tool.getAll.useQuery(undefined, { enabled: !!toolIds?.length });

  useEffect(() => {
    if (!toolIds) {
      setSelectedId(null);
    } else if (!selectedId || !toolIds.includes(selectedId)) {
      setSelectedId(toolIds[0]);
    }
  }, [toolIds, selectedId]);

  const selected = data?.find((x) => x.id === selectedId);

  if (!data || !selected) return null;

  return (
    <div className="-mt-4 p-4">
      <MasonryContainer>
        <div className="flex flex-col gap-3">
          <div className="flex justify-between gap-3">
            <Title order={2} className="font-semibold">
              {selected.name}
            </Title>
            <div className="flex flex-wrap gap-1">
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
            </div>
          </div>
          <Text>{selected.description}</Text>
        </div>
      </MasonryContainer>
    </div>
  );
}
