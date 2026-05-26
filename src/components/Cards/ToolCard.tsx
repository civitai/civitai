import { Avatar, Badge, Button, Card, Image, Text, ThemeIcon } from '@mantine/core';
import { IconTools } from '@tabler/icons-react';
import Link from 'next/link';
import { getEdgeUrl } from '~/client-utils/cf-images-utils';
import { EdgeMedia2 } from '~/components/EdgeMedia/EdgeMedia';
import { CustomMarkdown } from '~/components/Markdown/CustomMarkdown';
import { useTrackEvent } from '~/components/TrackView/track.utils';
import { generationGraphPanel } from '~/store/generation-graph.store';
import type { ToolGetAllModel } from '~/types/router';
import { slugit } from '~/utils/string-helpers';

export function ToolCard({ data }: Props) {
  const sluggifiedName = slugit(data.name);
  const { trackAction } = useTrackEvent();

  return (
    <Link
      href={`/tools/${sluggifiedName}?tools=${data.id}`}
      as={`/tools/${sluggifiedName}`}
      passHref
      legacyBehavior
    >
      <Card component="a" radius="md" withBorder>
        <Card.Section className="h-48">
          {data.bannerUrl ? (
            <EdgeMedia2
              className="size-full max-w-full object-cover"
              src={data.bannerUrl}
              width={1920}
              type="image"
            />
          ) : (
            <Image
              src="/images/civitai-default-account-bg.png"
              alt="default creator card background decoration"
              w="100%"
              h="100%"
              styles={{
                root: { objectFit: 'cover', height: '100% !important' },
              }}
            />
          )}
        </Card.Section>
        <div className="mt-4 flex flex-col items-start gap-4">
          <div className="flex flex-1 items-center gap-4">
            {data.icon ? (
              <Avatar
                src={getEdgeUrl(data.icon ?? undefined, { type: 'image', width: 40 })}
                size={40}
                radius="xl"
              />
            ) : (
              <ThemeIcon size="xl" radius="xl" variant="light">
                <IconTools />
              </ThemeIcon>
            )}
            <div className="flex flex-col">
              <Text size="lg" fw={600}>
                {data.name}
              </Text>
              <Text size="sm" c="dimmed">
                {data.company}
              </Text>
            </div>
          </div>
          <Badge size="sm" radius="xl">
            {data.type}
          </Badge>
          {data.description && (
            <Text component="div" lineClamp={3}>
              <CustomMarkdown allowedElements={[]} unwrapDisallowed>
                {data.description}
              </CustomMarkdown>
            </Text>
          )}
          {data.alias && (
            <Button
              data-activity="create:tool-card"
              onClick={(e: React.MouseEvent) => {
                e.preventDefault();
                e.stopPropagation();
                // Top-of-funnel telemetry. ToolCard is rendered on the /tools
                // index — clicking Generate opens the panel with no input
                // (tool alias is resolved later). Same Create semantics as
                // ToolBanner; distinguished by source tag for surface volume.
                trackAction({
                  type: 'Model_Create_Click',
                  details: { source: 'create:tool-card' },
                }).catch(() => undefined);
                generationGraphPanel.open();
              }}
              fullWidth
            >
              Generate
            </Button>
          )}
        </div>
      </Card>
    </Link>
  );
}

type Props = {
  data: Omit<ToolGetAllModel, 'bannerUrl' | 'priority'> & { bannerUrl?: string | null };
};
