import { Button, Center, Group, Stack, Text, ThemeIcon } from '@mantine/core';
import { Dropzone } from '@mantine/dropzone';
import { IconUpload } from '@tabler/icons-react';
import { ArtThumb } from '~/components/CreatorShop/Submit/ArtThumb';
import { PackCoverTiles } from '~/components/CreatorShop/Pack/PackCoverTiles';

/**
 * A pack's cover is a storefront image, not a cosmetic anyone receives — so it
 * carries none of the artwork rules a cosmetic does. No transparency, no badge
 * dimensions, and no requirement to provide one at all: without a cover the card
 * shows what's inside instead, which is arguably the more useful picture.
 */
export function PackCoverField({
  localUrl,
  imageId,
  uploading,
  tiles,
  maxSize,
  onDrop,
  onClear,
}: {
  localUrl: string | null;
  imageId: string | null;
  uploading: boolean;
  /** Member artwork, used for the preview when there's no cover. */
  tiles: string[];
  maxSize: number;
  onDrop: (files: File[]) => void;
  onClear: () => void;
}) {
  const hasCover = !!(localUrl || imageId);

  return (
    <Stack gap={6}>
      <Group justify="space-between" align="baseline">
        <Text size="sm" fw={500}>
          Cover image
        </Text>
        <Text size="xs" c="dimmed">
          Optional
        </Text>
      </Group>
      <Text size="xs" c="dimmed">
        Shown on the shop card and the pack&apos;s page. Buyers don&apos;t receive it — they get
        what&apos;s inside. Square works best; anything else is cropped to fit.
      </Text>

      {hasCover ? (
        <Stack gap={6} align="center">
          <ArtThumb localUrl={localUrl} imageId={imageId} uploading={uploading} />
          <Button variant="subtle" color="red" size="xs" disabled={uploading} onClick={onClear}>
            Remove
          </Button>
        </Stack>
      ) : (
        <Stack gap={8}>
          <Dropzone
            onDrop={onDrop}
            accept={['image/png', 'image/webp', 'image/jpeg']}
            maxFiles={1}
            maxSize={maxSize}
            loading={uploading}
          >
            <Center mih={100}>
              <Stack align="center" gap={4}>
                <ThemeIcon variant="light" size="lg" color="gray">
                  <IconUpload size={20} />
                </ThemeIcon>
                <Text size="sm">Drag & drop a cover, or click to browse</Text>
              </Stack>
            </Center>
          </Dropzone>
          {!!tiles.length && (
            <Group gap="xs" align="center">
              <PackCoverTiles tiles={tiles} size={64} />
              <Text size="xs" c="dimmed">
                Without a cover, your pack shows its contents like this.
              </Text>
            </Group>
          )}
        </Stack>
      )}
    </Stack>
  );
}
