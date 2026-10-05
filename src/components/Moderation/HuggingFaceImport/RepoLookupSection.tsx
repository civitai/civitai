import {
  Alert,
  Anchor,
  Badge,
  Button,
  Card,
  Checkbox,
  Group,
  Stack,
  Text,
  TextInput,
  Title,
} from '@mantine/core';
import { useState } from 'react';
import { showErrorNotification, showSuccessNotification } from '~/utils/notifications';
import { formatBytes } from '~/utils/number-helpers';
import { trpc } from '~/utils/trpc';

const WEIGHT_EXTENSIONS = /\.(safetensors|sft|ckpt|pt|pth|bin|gguf|onnx)$/i;

export function RepoLookupSection() {
  const [source, setSource] = useState('');
  const [selected, setSelected] = useState<string[]>([]);
  const [groupName, setGroupName] = useState('');
  const queryUtils = trpc.useUtils();

  const lookup = trpc.huggingFaceImport.lookup.useMutation({
    onSuccess: (data) => {
      // Weights we don't already hold are what "import this model" means; configs and duplicates opt in.
      // Prefilled from the repo and settable only here: no UI renames a group after Import.
      setGroupName(data.repo.split('/').pop() ?? data.repo);
      setSelected(
        data.files.filter((f) => WEIGHT_EXTENSIONS.test(f.path) && !f.existing).map((f) => f.path)
      );
    },
    onError: (error) =>
      showErrorNotification({ title: 'Lookup failed', error: new Error(error.message) }),
  });

  const enqueue = trpc.huggingFaceImport.enqueue.useMutation({
    onSuccess: async (result) => {
      showSuccessNotification({
        title: 'Queued',
        message: `${result.queued} file(s) queued${
          result.skipped ? `, ${result.skipped} already queued` : ''
        }.`,
      });
      await queryUtils.huggingFaceImport.getAll.invalidate();
    },
    onError: (error) =>
      showErrorNotification({ title: 'Could not queue', error: new Error(error.message) }),
  });

  const repo = lookup.data;

  return (
    <Card withBorder padding="lg">
      <Stack gap="md">
        <Stack gap={4}>
          <Title order={4}>Import from Hugging Face</Title>
          <Text c="dimmed" size="sm">
            Paste a model URL. Files transfer server-side; nothing downloads to your machine.
          </Text>
        </Stack>

        <Group align="flex-end" wrap="nowrap">
          <TextInput
            className="flex-1"
            label="Model URL"
            placeholder="https://huggingface.co/owner/name"
            value={source}
            onChange={(event) => setSource(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && source.trim()) lookup.mutate({ source });
            }}
          />
          <Button
            onClick={() => lookup.mutate({ source })}
            loading={lookup.isPending}
            disabled={!source.trim()}
          >
            Look up
          </Button>
        </Group>

        {repo && (
          <Stack gap="sm">
            <Group gap="xs">
              <Anchor href={`https://huggingface.co/${repo.repo}`} target="_blank" size="sm">
                {repo.repo}
              </Anchor>
              <Badge size="sm" variant="light">
                {repo.revision.slice(0, 7)}
              </Badge>
              {repo.license && (
                <Badge size="sm" variant="light" color="gray">
                  {repo.license}
                </Badge>
              )}
              {repo.gated && (
                <Badge size="sm" color="orange">
                  gated
                </Badge>
              )}
            </Group>

            {repo.gated && (
              <Alert color="orange">
                This repo is gated. Importing it needs a server token whose Hugging Face account has
                accepted its terms — check the license before mirroring it here.
              </Alert>
            )}

            <TextInput
              label="Group name"
              description="What this batch is called when attaching its files later. It can't be changed after Import."
              value={groupName}
              onChange={(event) => setGroupName(event.currentTarget.value)}
            />

            <Checkbox.Group value={selected} onChange={setSelected}>
              <Stack gap={4}>
                {repo.files.map((file) => (
                  <Checkbox
                    key={file.path}
                    value={file.path}
                    label={
                      <Group gap="xs" wrap="nowrap">
                        <Text size="sm">{file.path}</Text>
                        <Text size="xs" c="dimmed">
                          {formatBytes(file.size)}
                        </Text>
                        {file.existing && (
                          <Badge size="xs" color="teal" variant="light">
                            already stored as {file.existing.name}
                          </Badge>
                        )}
                      </Group>
                    }
                  />
                ))}
              </Stack>
            </Checkbox.Group>

            <Group justify="flex-end">
              <Button
                loading={enqueue.isPending}
                disabled={!selected.length || !groupName.trim()}
                onClick={() =>
                  enqueue.mutate({
                    repo: repo.repo,
                    revision: repo.revision,
                    paths: selected,
                    groupName: groupName.trim() || undefined,
                  })
                }
              >
                Import {selected.length} file{selected.length === 1 ? '' : 's'}
              </Button>
            </Group>
          </Stack>
        )}
      </Stack>
    </Card>
  );
}
