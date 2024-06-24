import { Button, Title, Text, useMantineTheme } from '@mantine/core';
import { IconExternalLink } from '@tabler/icons-react';
import { EdgeMedia } from '~/components/EdgeMedia/EdgeMedia';
import { useImageQueryParams } from '~/components/Image/image.utils';
import { MasonryContainer } from '~/components/MasonryColumns/MasonryContainer';
import { trpc } from '~/utils/trpc';

export function ToolBanner() {
  const { query } = useImageQueryParams();
  const { tools: toolIds } = query;
  const selectedId = toolIds?.[0];

  const { data } = trpc.tool.getAll.useQuery(undefined, { enabled: !!toolIds?.length });
  const selected = data?.find((x) => x.id === selectedId);
  const theme = useMantineTheme();

  if (!data || !selected) return null;

  const hasHeader = !!selected.metadata?.header;

  return (
    <div
      className="relative -mt-4 mb-4 overflow-hidden bg-gray-1 px-3 py-6 dark:bg-dark-9"
      style={
        hasHeader
          ? {
              color: theme.white,
            }
          : undefined
      }
    >
      {hasHeader && (
        <div className="z-1 absolute left-0 top-0 size-full origin-center">
          <EdgeMedia
            src={selected.metadata.header as string}
            className="h-auto min-h-full w-full min-w-full object-cover opacity-40"
            fadeIn={false}
            original
          />
        </div>
      )}
      <MasonryContainer>
        <div className="flex max-w-md flex-col gap-2">
          <div className="flex justify-between gap-3">
            <div className="flex flex-col gap-2">
              {selected.icon && <EdgeMedia width={75} src={selected.icon} />}
              <div className="flex items-center gap-8">
                <Title order={2} className="font-semibold">
                  {selected.name}
                </Title>
                {selected.domain && (
                  <Button
                    color="blue"
                    radius="xl"
                    target="_blank"
                    rightIcon={<IconExternalLink size={18} />}
                    component="a"
                    href={selected.domain}
                    rel="nofollow noreferrer"
                  >
                    Visit
                  </Button>
                )}
              </div>
            </div>
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
