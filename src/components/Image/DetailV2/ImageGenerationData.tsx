import { Card, Divider, Text } from '@mantine/core';
import { IconForms } from '@tabler/icons-react';
import { CopyButton } from '~/components/CopyButton/CopyButton';
import { ImageMeta } from '~/components/Image/DetailV2/ImageMeta';
import { ImageResources } from '~/components/Image/DetailV2/ImageResources';
import { encodeMetadata } from '~/utils/metadata';
import { trpc } from '~/utils/trpc';

export function ImageGenerationData({ imageId }: { imageId: number }) {
  const { data } = trpc.image.getGenerationData.useQuery({ id: imageId });

  const { meta, resources } = data ?? {};
  if (!meta && !resources) return null;

  return (
    <Card className="flex flex-col gap-3 rounded-xl">
      <div className="flex items-center gap-3">
        <Text className="flex items-center gap-2 text-xl font-semibold">
          <IconForms />
          <span>Generation data</span>
        </Text>
        {meta && (
          <CopyButton value={() => encodeMetadata(meta)}>
            {({ copy, copied, Icon, color }) => (
              <Text
                className="flex cursor-pointer items-center gap-1 text-xs"
                color={color}
                onClick={copy}
                data-activity="copy:image-meta"
                variant="link"
              >
                <Icon size={14} />
                <span>{copied ? 'COPIED' : 'COPY ALL'}</span>
              </Text>
            )}
          </CopyButton>
        )}
      </div>
      <ImageResources imageId={imageId} />
      {!!resources?.length && (meta?.prompt || meta?.negativePrompt) && <Divider />}
      <ImageMeta imageId={imageId} />
    </Card>
  );
}
