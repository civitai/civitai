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
        <EdgeMedia
          src={selected.metadata.header as string}
          className="absolute left-1/2 top-1/2 h-auto min-h-full	w-full min-w-full -translate-x-1/2 -translate-y-1/2 object-cover opacity-40"
          fadeIn={false}
          original
        />
      )}
      <MasonryContainer>
        <div className="flex max-w-md flex-col gap-2">
          <div className="flex justify-between gap-3">
            <div className="flex flex-col gap-2">
              {selected.icon && <EdgeMedia width={120} src={selected.icon} />}
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
          </div>
          <Text className="text-shadow-default">{selected.description}</Text>
        </div>
      </MasonryContainer>
    </div>
  );
}
