import { Card, Divider, Text, Badge } from '@mantine/core';
import { IconChartBubble, IconForms } from '@tabler/icons-react';
import { ImageMeta } from '~/components/Image/DetailV2/ImageMeta';
import { ImageResources } from '~/components/Image/DetailV2/ImageResources';
import { LineClamp } from '~/components/LineClamp/LineClamp';
import { trpc } from '~/utils/trpc';

export function ImageProcess({ imageId }: { imageId: number }) {
  const { data } = trpc.image.getGenerationData.useQuery({ id: imageId });

  if (!data) return null;

  const { tools, techniques } = data;
  if (!tools.length || !techniques.length) return null;

  return (
    <Card className="rounded-xl flex flex-col gap-3">
      <Text className="flex items-center gap-2 font-semibold text-xl">
        <IconChartBubble />
        <span>Process</span>
      </Text>
      {!!tools.length && (
        <div className="flex flex-col">
          <div className="flex justify-between items-center">
            <Text className="text-lg font-semibold">Tools</Text>
          </div>
          <div className="flex flex-wrap gap-1">
            {tools.map(({ id, name }) => (
              <Badge key={id} size="lg" className="rounded-full normal-case">
                {name}
              </Badge>
            ))}
          </div>
        </div>
      )}
      {!!techniques.length && (
        <div className="flex flex-col">
          <div className="flex justify-between items-center">
            <Text className="text-lg font-semibold">Techniques</Text>
          </div>
          <ul className="list-none">
            {techniques.map(({ id, name, notes }) => (
              <li key={id}>
                <Text color="dimmed">{name}</Text>
                {notes && (
                  <LineClamp lineClamp={1} color="dimmed">
                    {notes}
                  </LineClamp>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
    </Card>
  );
}
