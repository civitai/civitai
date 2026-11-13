import {
  Alert,
  Anchor,
  Button,
  Container,
  Group,
  Paper,
  SimpleGrid,
  Stack,
  TagsInput,
  Text,
  Textarea,
  TextInput,
  Title,
} from '@mantine/core';
import { IconAlertCircle, IconApps, IconLink } from '@tabler/icons-react';
import { EdgeMedia } from '~/components/EdgeMedia/EdgeMedia';
import { POST_TAG_LIMIT } from '~/server/common/constants';

export type IntentComposeValues = { title: string; description: string; tags: string[] };

export type IntentComposeSheetProps = {
  media: { url: string; type: 'image' | 'video' }[];
  values: IntentComposeValues;
  onChange: (values: IntentComposeValues) => void;
  appName?: string;
  itemName?: string;
  sourceLink?: string;
  primaryLabel: string;
  onPrimary: () => void;
  onOpenEditor?: () => void;
  busy?: 'primary' | 'editor';
  error?: string;
};

export function IntentComposeSheet({
  media,
  values,
  onChange,
  appName,
  itemName,
  sourceLink,
  primaryLabel,
  onPrimary,
  onOpenEditor,
  busy,
  error,
}: IntentComposeSheetProps) {
  const set = (patch: Partial<IntentComposeValues>) => onChange({ ...values, ...patch });

  return (
    <Container size="xs" px="md" my="lg">
      <Stack gap="md">
        <Stack gap={6}>
          <Title order={2}>Create a post</Title>
          {appName && (
            <Group gap={6} wrap="nowrap">
              <IconApps size={16} className="shrink-0" />
              <Text size="sm" c="dimmed" className="truncate">
                Shared from{' '}
                {itemName && (
                  <>
                    <strong>{itemName}</strong> on{' '}
                  </>
                )}
                <strong>{appName}</strong>
              </Text>
            </Group>
          )}
        </Stack>

        <Paper withBorder radius="md" p="xs" className="bg-gray-1 dark:bg-dark-6">
          <SimpleGrid cols={media.length > 1 ? 2 : 1} spacing="xs">
            {media.map((item) => (
              <div
                key={item.url}
                className="overflow-hidden rounded-md bg-gray-2 dark:bg-dark-7"
                data-testid="intent-media"
              >
                <EdgeMedia
                  src={item.url}
                  type={item.type}
                  className="mx-auto block max-h-[50vh] w-full object-contain"
                />
              </div>
            ))}
          </SimpleGrid>
        </Paper>

        <TextInput
          label="Title"
          placeholder="Add a title"
          value={values.title}
          maxLength={255}
          onChange={(e) => set({ title: e.currentTarget.value })}
        />
        <Textarea
          label="Description"
          placeholder="Say something about it"
          autosize
          minRows={3}
          maxRows={10}
          value={values.description}
          onChange={(e) => set({ description: e.currentTarget.value })}
        />
        <TagsInput
          label="Tags"
          placeholder={values.tags.length >= POST_TAG_LIMIT ? undefined : 'Add a tag'}
          maxTags={POST_TAG_LIMIT}
          value={values.tags}
          onChange={(tags) => set({ tags })}
        />

        {sourceLink && (
          <Group gap={6} wrap="nowrap">
            <IconLink size={16} className="shrink-0" />
            <Text size="sm" c="dimmed" className="shrink-0">
              Source
            </Text>
            <Anchor
              size="sm"
              href={sourceLink}
              target="_blank"
              rel="ugc nofollow noopener noreferrer"
              className="truncate"
            >
              {sourceLink}
            </Anchor>
          </Group>
        )}

        {error && (
          <Alert color="red" icon={<IconAlertCircle size={16} />}>
            {error}
          </Alert>
        )}

        <Stack gap="xs">
          <Button
            size="md"
            fullWidth
            onClick={onPrimary}
            loading={busy === 'primary'}
            disabled={!!busy}
          >
            {primaryLabel}
          </Button>
          {onOpenEditor && (
            <Button
              size="md"
              fullWidth
              variant="default"
              onClick={onOpenEditor}
              loading={busy === 'editor'}
              disabled={!!busy}
            >
              Open in editor
            </Button>
          )}
        </Stack>
        <Text size="xs" c="dimmed" ta="center">
          Your post is rated and checked like any upload once it is posted.
        </Text>
      </Stack>
    </Container>
  );
}
