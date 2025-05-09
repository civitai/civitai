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
  useMantineColorScheme,
} from '@mantine/core';
import { Dropzone } from '@mantine/dropzone';
import { IconPhoto, IconUpload, IconX } from '@tabler/icons-react';
import { useEffect, useState } from 'react';
import { ImageMeta } from '~/components/ImageMeta/ImageMeta';
import { isDev, isProd } from '~/env/other';
import { IMAGE_MIME_TYPE } from '~/server/common/mime-types';
import { ImageMetaProps } from '~/server/schema/image.schema';
import { getMetadata, encodeMetadata } from '~/utils/metadata';
import { auditMetaData } from '~/utils/metadata/audit';

export default function MetadataTester() {
  const theme = useMantineTheme();
  const { colorScheme } = useMantineColorScheme();
  const [meta, setMeta] = useState<ImageMetaProps | undefined>();
  const [nsfw, setNsfw] = useState<boolean>(false);
  const nodeJson = useGlobalValue('nodeJson');
  const exif = useGlobalValue('exif');

  const onDrop = async (files: File[]) => {
    console.log(files);
    const [file] = files;
    const meta = await getMetadata(file);
    setMeta(meta);
    console.log(meta);
    const encoded = await encodeMetadata(meta);
    console.log(encoded);
    const result = auditMetaData(meta, nsfw);
    console.log(result);
  };

  return (
    <Container size={350}>
      <Stack>
        <Title>Metadata Tester</Title>
        <Switch checked={nsfw} onChange={() => setNsfw((c) => !c)} label="NSFW" />
        <Dropzone onDrop={onDrop} accept={IMAGE_MIME_TYPE} maxFiles={1}>
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
            <Text size="sm" color="dimmed" inline mt={7}>
              Attach as many files as you like, each file should not exceed 5mb
            </Text>
          </div>
        </Dropzone>
        {meta && (
          <>
            {meta.resources && (
              <Card withBorder p="sm">
                {(meta.resources as any[]).map((resource) => (
                  <Card.Section key={resource.id} inheritPadding py="xs" withBorder>
                    <Group gap={4}>
                      <Text size="sm" weight={500}>
                        {resource.name}
                      </Text>
                      <Badge color="blue" size="xs">
                        {resource.type}
                        {resource.weight && <> {resource.weight}</>}
                      </Badge>
                      <Text size="xs" color="dimmed" ml="auto">
                        {resource.hash}
                      </Text>
                    </Group>
                  </Card.Section>
                ))}
              </Card>
            )}
            {/* <ImageMeta meta={meta} /> */}
          </>
        )}
        {nodeJson && (
          <Card withBorder p="sm">
            <Card.Section p="sm" py="xs" withBorder>
              <Text weight={500}>Node JSON</Text>
            </Card.Section>
            <Card.Section p="sm">
              <pre className="text-xs">{JSON.stringify(nodeJson, null, 2)}</pre>
            </Card.Section>
          </Card>
        )}
        {exif && (
          <Card withBorder p="sm">
            <Card.Section p="sm" py="xs" withBorder>
              <Text weight={500}>EXIF</Text>
            </Card.Section>
            <Card.Section p="sm">
              <pre className="text-xs">{JSON.stringify(exif, null, 2)}</pre>
            </Card.Section>
          </Card>
        )}
      </Stack>
    </Container>
  );
}

// # region global listener

function useGlobalValue(key: string) {
  if (typeof window === 'undefined' || isProd) return null;
  const windowKey = key as keyof Window;
  const [value, setValue] = useState(window[windowKey]);

  useEffect(() => {
    const handler = () => {
      setValue(window[windowKey]);
    };

    // Attach a listener for changes to the global variable
    window.addEventListener('globalValueChange', handler);

    // Cleanup listener on unmount
    return () => {
      window.removeEventListener('globalValueChange', handler);
    };
  }, [key]);

  return value;
}

// # endregion
