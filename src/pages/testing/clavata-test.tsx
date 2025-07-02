import {
  Alert,
  Badge,
  Container,
  Group,
  Paper,
  Stack,
  Text,
  TextInput,
  Title,
  useMantineTheme,
  useComputedColorScheme,
} from '@mantine/core';
import { Dropzone } from '@mantine/dropzone';
import { IconPhoto, IconUpload, IconX } from '@tabler/icons-react';
import { useState } from 'react';
import { NotFound } from '~/components/AppLayout/NotFound';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { IMAGE_MIME_TYPE } from '~/shared/constants/mime-types';
import type { ClavataTag } from '~/server/integrations/clavata';

export default function MetadataTester() {
  const theme = useMantineTheme();
  const colorScheme = useComputedColorScheme('dark');
  const user = useCurrentUser();
  const [policyId, setPolicyId] = useState<string | undefined>(undefined);
  const [tags, setTags] = useState<ClavataTag[]>([]);
  const [error, setError] = useState<string | undefined>(undefined);
  const [isLoading, setIsLoading] = useState(false);
  const [processed, setProcessed] = useState(false);

  const onDrop = async (files: File[]) => {
    if (isLoading) {
      return;
    }

    setError(undefined);
    setIsLoading(true);
    setProcessed(false);
    const [file] = files;
    try {
      // const base64 = await getBase64(file);
      setTags([]);
      const buffer = await file.arrayBuffer();
      const base64 =
        typeof Buffer !== 'undefined'
          ? Buffer.from(buffer).toString('base64')
          : btoa(String.fromCharCode(...new Uint8Array(buffer)));

      const res = await fetch('/api/mod/clavata-image-process', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          image: base64,
          policyId: policyId,
        }),
      });

      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error ?? res.statusText);
      }

      const resJson: ClavataTag[] = await res.json();
      setTags(resJson.filter((t) => t.outcome !== 'OUTCOME_FALSE'));
    } catch (e) {
      console.error('Error processing image with Clavata:', e);
      setError('Failed to process image with Clavata: ' + (e as Error).message);
    } finally {
      setIsLoading(false);
      setProcessed(true);
    }
  };

  if (!user?.isModerator) {
    return <NotFound />;
  }

  return (
    <Container size={350}>
      <Stack>
        <Title>Clavata Tester</Title>
        <TextInput
          onChange={(e) => setPolicyId(e.currentTarget.value)}
          placeholder="Leave empty for default."
          label="Clavata Policy ID"
        />
        <Dropzone onDrop={onDrop} accept={IMAGE_MIME_TYPE} maxFiles={1} loading={isLoading}>
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
              Drag image here or click to select file
            </Text>
            <Text size="sm" c="dimmed" inline mt={7}>
              Image should not exceed 16mb
            </Text>
          </div>
        </Dropzone>

        {error && (
          <Alert color="red" title="Error while processing your request.">
            <Text inline>{error}</Text>
          </Alert>
        )}

        {tags.length > 0 ? (
          <Stack gap={4}>
            <Text size="lg" fw={700}>
              Detected Tags
            </Text>
            {tags.map((tag) => (
              <Paper withBorder radius="sm" p="xs" key={tag.tag}>
                <Group>
                  <Text>{tag.tag}</Text>
                  <Badge>({tag.confidence.toFixed(2)}%)</Badge>
                </Group>
              </Paper>
            ))}
          </Stack>
        ) : processed ? (
          <Stack gap={4}>
            <Text size="lg" fw={700}>
              Detected Tags
            </Text>
            <Text size="sm" c="dimmed">
              No tags detected within policy.
            </Text>
          </Stack>
        ) : null}
      </Stack>
    </Container>
  );
}
