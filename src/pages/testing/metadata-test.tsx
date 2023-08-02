import { Container, Title, Text, useMantineTheme } from '@mantine/core';
import { Dropzone } from '@mantine/dropzone';
import { IconPhoto, IconUpload, IconX } from '@tabler/icons-react';
import { useState } from 'react';
import { ImageMeta } from '~/components/ImageMeta/ImageMeta';
import { IMAGE_MIME_TYPE } from '~/server/common/mime-types';
import { ImageMetaProps } from '~/server/schema/image.schema';
import { getMetadata, encodeMetadata } from '~/utils/metadata';

export default function MetadataTester() {
  const theme = useMantineTheme();
  const [meta, setMeta] = useState<ImageMetaProps | undefined>();

  const onDrop = async (files: File[]) => {
    console.log(files);
    const [file] = files;
    const meta = await getMetadata(file);
    setMeta(meta);
    console.log(meta);
    const encoded = await encodeMetadata(meta);
    console.log(encoded);
  };

  return (
    <Container size={350}>
      <Title>Metadata Tester</Title>
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
      {meta && <ImageMeta meta={meta} />}
    </Container>
  );
}
