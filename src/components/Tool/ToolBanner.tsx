import { Button, Title, useMantineTheme } from '@mantine/core';
import { IconBrush, IconExternalLink } from '@tabler/icons-react';
import { getEdgeUrl } from '~/client-utils/cf-images-utils';
import { EdgeMedia } from '~/components/EdgeMedia/EdgeMedia';
import { useImageFilters } from '~/components/Image/image.utils';
import { CustomMarkdown } from '~/components/Markdown/CustomMarkdown';
import { MasonryContainer } from '~/components/MasonryColumns/MasonryContainer';
import { useQueryTools } from '~/components/Tool/tools.utils';
import { useTrackEvent } from '~/components/TrackView/track.utils';
import type { FilterKeys } from '~/providers/FiltersProvider';
import { generationGraphPanel } from '~/store/generation-graph.store';
import { slugit } from '~/utils/string-helpers';

export function ToolBanner({
  filterType = 'images',
  slug,
}: {
  filterType?: FilterKeys<'images' | 'videos'>;
  slug?: string;
}) {
  const { tools: toolIds } = useImageFilters(filterType);
  const selectedId = toolIds?.[0];

  const { tools } = useQueryTools({
    filters: { include: ['unlisted'] },
    options: { enabled: !!toolIds?.length || !!slug },
  });
  const selected = tools?.find((x) => x.id === selectedId || slugit(x.name) === slug);
  const theme = useMantineTheme();
  const { trackAction } = useTrackEvent();

  if (!tools || !selected) return null;

  const hasHeader = !!selected.bannerUrl;

  return (
    <div
      className="relative -mt-4 mb-4 overflow-hidden bg-gray-1 dark:bg-dark-9"
      style={hasHeader ? { color: theme.white } : undefined}
    >
      <MasonryContainer
        style={
          hasHeader
            ? {
                backgroundImage: `url(${getEdgeUrl(selected.bannerUrl as string, {
                  original: true,
                })})`,
                backgroundSize: 'cover',
                backgroundPosition: 'center',
                backgroundRepeat: 'no-repeat',
                backgroundColor: 'rgba(0,0,0,0.6)',
                backgroundBlendMode: 'darken',
              }
            : undefined
        }
      >
        <div className="flex h-full max-w-md flex-col gap-2 py-6">
          <div className="flex justify-between gap-3">
            <div className="flex flex-col gap-2">
              {selected.icon && <EdgeMedia width={120} src={selected.icon} />}
              <div className="flex items-center gap-8">
                <Title order={2} className="font-semibold">
                  {selected.name}
                </Title>
                {/* {/* {selected.domain && (
                  <Button
                    color="blue"
                    radius="xl"
                    target="_blank"
                    rightSection={<IconExternalLink size={18} />}
                    component="a"
                    href={selected.domain}
                    rel="nofollow noreferrer"
                  >
                    Visit
                  </Button>
                )} */}
                {selected.alias && (
                  <Button
                    color="blue"
                    radius="xl"
                    rightSection={<IconBrush size={18} />}
                    data-activity="create:tool-banner"
                    onClick={() => {
                      // Top-of-funnel telemetry. The Tool banner's Generate
                      // button opens the panel with no input — semantically
                      // a Create entry-point (the tool's alias gets resolved
                      // into a prompt later). We don't have a modelVersionId
                      // here (tools are a separate abstraction); the source
                      // tag is what the dashboard joins on.
                      trackAction({
                        type: 'Model_Create_Click',
                        details: { source: 'create:tool-banner' },
                      }).catch(() => undefined);
                      generationGraphPanel.open();
                    }}
                  >
                    Generate
                  </Button>
                )}
              </div>
            </div>
          </div>
          {selected.description && (
            <CustomMarkdown
              allowedElements={['a']}
              className="markdown-content text-shadow-default"
              unwrapDisallowed
            >
              {selected.description}
            </CustomMarkdown>
          )}
        </div>
      </MasonryContainer>
    </div>
  );
}
