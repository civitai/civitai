import {
  Container,
  Title,
  Text,
  useMantineTheme,
  Switch,
  Stack,
  Badge,
  Card,
  Group,
  Divider,
  useComputedColorScheme,
} from '@mantine/core';
import { Dropzone } from '@mantine/dropzone';
import { IconPhoto, IconUpload, IconX } from '@tabler/icons-react';
import { useEffect, useState } from 'react';
import { isProd } from '~/env/other';
import { IMAGE_MIME_TYPE, VIDEO_MIME_TYPE } from '~/shared/constants/mime-types';
import type { ImageMetaProps } from '~/server/schema/image.schema';
import { blobToFile } from '~/utils/file-utils';
import { createImageElement } from '~/utils/image-utils';
import { imageToJpegBlob } from '~/shared/utils/canvas-utils';
import { preprocessFile } from '~/utils/media-preprocessors';
import { getMetadata, encodeMetadata, ExifParser } from '~/utils/metadata';
import { auditMetaData } from '~/utils/metadata/audit';

export default function MetadataTester() {
  const theme = useMantineTheme();
  const colorScheme = useComputedColorScheme('dark');
  const [meta, setMeta] = useState<ImageMetaProps | undefined>();
  const [nsfw, setNsfw] = useState<boolean>(false);

  const onDrop = async (files: File[]) => {
    const type = files[0].type;
    if (IMAGE_MIME_TYPE.includes(type as (typeof IMAGE_MIME_TYPE)[number])) {
      // const [file] = files;
      const jpegBlob = await imageToJpegBlob(files[0]);
      const file = await blobToFile(jpegBlob);
      // const [file] = files;

      const parser = await ExifParser(file);
      const parsed = parser.parse();
      console.log({ parsed });
      const meta = await parser.getMetadata();
      const encoded = parser.encode(meta);
      // const meta = await getMetadata(file);
      setMeta(meta);

      const img = await createImageElement(file);
      console.log({ img });

      console.log({ meta });
      // const encoded = await encodeMetadata(meta);
      console.log({ encoded });
      const result = auditMetaData(meta, nsfw);
      console.log({ result });
    }
    const metadata = await preprocessFile(files[0]);
    console.log({ metadata });
  };

  const resources = (meta?.resources ?? []) as any[];

  return (
    <Container size={350}>
      <Stack>
        <Title>Metadata Tester</Title>
        <Switch checked={nsfw} onChange={() => setNsfw((c) => !c)} label="NSFW" />
        <Dropzone
          onDrop={onDrop}
          accept={[...IMAGE_MIME_TYPE, ...VIDEO_MIME_TYPE]}
          maxFiles={1}
          maxSize={50 * 1024 ** 2}
        >
          <Dropzone.Accept>
            <IconUpload
              size={50}
              stroke={1.5}
              color={theme.colors[theme.primaryColor][colorScheme === 'dark' ? 4 : 6]}
            />
          </Dropzone.Accept>
          <Dropzone.Reject>
            <IconX
              size={50}
              stroke={1.5}
              color={theme.colors.red[colorScheme === 'dark' ? 4 : 6]}
            />
          </Dropzone.Reject>
          <Dropzone.Idle>
            <IconPhoto size={50} stroke={1.5} />
          </Dropzone.Idle>

          <div>
            <Text size="xl" inline>
              Drag images here or click to select files
            </Text>
            <Text size="sm" c="dimmed" inline mt={7}>
              Attach as many files as you like, each file should not exceed 50mb
            </Text>
          </div>
        </Dropzone>
        {meta && (
          <>
            {!!resources.length && (
              <Card withBorder p="sm">
                {resources.map((resource, i) => (
                  <Card.Section key={i} inheritPadding py="xs" withBorder>
                    <Group gap={4}>
                      <Text size="sm" fw={500}>
                        {resource.name}
                      </Text>
                      <Badge color="blue" size="xs">
                        {resource.type}
                        {resource.weight && <> {resource.weight}</>}
                      </Badge>
                      <Text size="xs" c="dimmed" ml="auto">
                        {resource.hash}
                      </Text>
                    </Group>
                  </Card.Section>
                ))}
              </Card>
            )}
          </>
        )}
        <GlobalValueCard name="nodeJson" />
        <GlobalValueCard name="exif" />
      </Stack>
    </Container>
  );
}

function GlobalValueCard({ name }: { name: string }) {
  const [value, setValue] = useState<any>();

  useEffect(() => {
    const handler = () => {
      setValue(window[name as keyof Window]);
    };

    // Attach a listener for changes to the global variable
    window.addEventListener('globalValueChange', handler);

    // Cleanup listener on unmount
    return () => {
      window.removeEventListener('globalValueChange', handler);
    };
  }, [name]);

  if (typeof window === 'undefined' || isProd || !value) return null;

  return (
    <Card withBorder p="sm">
      <Card.Section p="sm" py="xs" withBorder>
        <Text weight={500}>{name}</Text>
      </Card.Section>
      <Card.Section p="sm">
        <pre className="text-xs">{JSON.stringify(value, null, 2)}</pre>
      </Card.Section>
    </Card>
  );
}
// # endregion
