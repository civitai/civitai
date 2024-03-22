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
} from '@mantine/core';
import { Dropzone } from '@mantine/dropzone';
import { IconPhoto, IconUpload, IconX } from '@tabler/icons-react';
import { useState } from 'react';
import { ImageMeta } from '~/components/ImageMeta/ImageMeta';
import { IMAGE_MIME_TYPE } from '~/server/common/mime-types';
import { ImageMetaProps } from '~/server/schema/image.schema';
import { getMetadata, encodeMetadata } from '~/utils/metadata';
import { auditMetaData } from '~/utils/metadata/audit';

export default function MetadataTester() {
  const theme = useMantineTheme();
  const [meta, setMeta] = useState<ImageMetaProps | undefined>();
  const [nsfw, setNsfw] = useState<boolean>(false);

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
              color={theme.colors[theme.primaryColor][theme.colorScheme === 'dark' ? 4 : 6]}
            />
          </Dropzone.Accept>
          <Dropzone.Reject>
            <IconX
              size={50}
              stroke={1.5}
              color={theme.colors.red[theme.colorScheme === 'dark' ? 4 : 6]}
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
                    <Group spacing={4}>
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
            <ImageMeta meta={meta} />
          </>
        )}
      </Stack>
    </Container>
  );
}
