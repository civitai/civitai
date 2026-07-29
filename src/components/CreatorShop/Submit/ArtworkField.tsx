import { Box, Button, Center, Group, Stack, Text, ThemeIcon } from '@mantine/core';
import { Dropzone } from '@mantine/dropzone';
import { IconUpload } from '@tabler/icons-react';
import { ArtThumb } from '~/components/CreatorShop/Submit/ArtThumb';
import { ChecksPanel } from '~/components/CreatorShop/Submit/ChecksPanel';
import type { AutoCheck } from '~/server/schema/creator-shop.schema';
import type { CosmeticType } from '~/shared/utils/prisma/enums';

// The full artwork picker: the required-field label, one of three states
// (locked / has-art with Replace / empty dropzone), and the requirements panel.
export function ArtworkField({
  type,
  artLocked,
  localUrl,
  imageId,
  uploading,
  maxSize,
  checks,
  onDrop,
  onReplace,
}: {
  type: CosmeticType;
  artLocked: boolean;
  localUrl: string | null;
  imageId: string | null;
  uploading: boolean;
  maxSize: number;
  checks: AutoCheck[];
  onDrop: (files: File[]) => void;
  onReplace: () => void;
}) {
  return (
    <Stack gap={6}>
      <Text size="sm" fw={500}>
        Artwork <span style={{ color: 'var(--mantine-color-red-5)' }}>*</span>
      </Text>
      {artLocked ? (
        <Group>
          <ArtThumb localUrl={null} imageId={imageId} />
          <Text size="xs" c="dimmed" maw={220}>
            Artwork can&apos;t be changed after an item is published or sold. You can still update
            its title, description, and price.
          </Text>
        </Group>
      ) : localUrl || imageId ? (
        <Stack gap={6} align="center">
          <ArtThumb localUrl={localUrl} imageId={imageId} uploading={uploading} />
          <Button variant="subtle" color="red" size="xs" disabled={uploading} onClick={onReplace}>
            Replace
          </Button>
        </Stack>
      ) : (
        <Dropzone
          onDrop={onDrop}
          accept={['image/png', 'image/webp']}
          maxFiles={1}
          maxSize={maxSize}
          loading={uploading}
        >
          <Center mih={120}>
            <Stack align="center" gap={4}>
              <ThemeIcon variant="light" size="lg" color="gray">
                <IconUpload size={20} />
              </ThemeIcon>
              <Text size="sm">Drag & drop your artwork, or click to browse</Text>
            </Stack>
          </Center>
        </Dropzone>
      )}

      {!artLocked && (
        <Box mt="sm">
          <ChecksPanel type={type} maxSize={maxSize} checks={checks} />
        </Box>
      )}
    </Stack>
  );
}
