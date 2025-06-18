import { Card, Divider, Text } from '@mantine/core';
import { IconForms } from '@tabler/icons-react';
import { CopyButton } from '~/components/CopyButton/CopyButton';
import { ImageMeta } from '~/components/Image/DetailV2/ImageMeta';
import { ImageResources } from '~/components/Image/DetailV2/ImageResources';
import { encodeMetadata } from '~/utils/metadata';
import { trpc } from '~/utils/trpc';

export function ImageGenerationData({
  imageId,
  rounded = true,
}: {
  imageId: number;
  rounded?: boolean;
}) {
  const { data } = trpc.image.getGenerationData.useQuery({ id: imageId });

  const { meta, resources } = data ?? {};
  if (!meta && !resources?.length) return null;

  return (
    <Card className={`flex flex-col gap-3 ${rounded ? 'rounded-xl' : 'rounded-none'}`}>
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
                c="blue.4"
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
