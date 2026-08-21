import { Badge, Button, Group, Loader, Stack, Text, TextInput } from '@mantine/core';
import { useDebouncedValue } from '@mantine/hooks';
import { IconAlertTriangle, IconLink } from '@tabler/icons-react';
import { useState } from 'react';
import { UserHubSourceType } from '~/shared/utils/prisma/enums';
import { trpc } from '~/utils/trpc';

const sourceLabels: Record<UserHubSourceType, string> = {
  [UserHubSourceType.User]: 'Creator',
  [UserHubSourceType.Model]: 'Model',
  [UserHubSourceType.ModelVersion]: 'Version',
  [UserHubSourceType.Collection]: 'Collection',
};

/**
 * Paste a Civitai link and get the source it names. The type is detected from the
 * URL rather than picked, and resolution happens server-side so the parser sees
 * the real domain list instead of whatever the browser is on.
 *
 * The link is resolved as you type and what it resolved to is shown before you
 * commit: a URL is opaque, and a model link with a version in its query resolves
 * to the version rather than the model, which nobody would guess from the text.
 */
export function HubSourceUrlInput({
  onResolved,
  disabled,
}: {
  onResolved: (source: { type: UserHubSourceType; targetId: number; alias: string }) => void;
  disabled?: boolean;
}) {
  const [url, setUrl] = useState('');
  const [debounced] = useDebouncedValue(url.trim(), 400);

  const { data: resolved, isFetching } = trpc.userHub.resolveSource.useQuery(
    { url: debounced },
    { enabled: !!debounced }
  );

  const add = () => {
    if (!resolved) return;
    onResolved({ ...resolved, alias: resolved.alias ?? `#${resolved.targetId}` });
    setUrl('');
  };

  return (
    <Stack gap={6}>
      <Group gap="xs" wrap="nowrap" align="flex-start">
        <TextInput
          className="flex-1"
          size="xs"
          leftSection={<IconLink size={14} />}
          rightSection={isFetching ? <Loader size={14} /> : undefined}
          placeholder="…or paste a Civitai link"
          value={url}
          disabled={disabled}
          onChange={(event) => setUrl(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (event.key !== 'Enter') return;
            event.preventDefault();
            add();
          }}
        />
        <Button size="xs" variant="light" disabled={disabled || !resolved} onClick={add}>
          Add
        </Button>
      </Group>

      {!!debounced && !isFetching && !resolved && (
        <Group gap={4} wrap="nowrap" c="dimmed">
          <IconAlertTriangle size={14} className="shrink-0" />
          <Text size="xs">
            Not a link we recognise. Try a creator, model, version or collection page.
          </Text>
        </Group>
      )}

      {!!resolved && (
        <Group gap="xs" wrap="nowrap" className="min-w-0">
          <Text size="xs" c="dimmed" className="shrink-0">
            Adding
          </Text>
          <Badge size="sm" variant="light" className="shrink-0">
            {sourceLabels[resolved.type]}
          </Badge>
          <Text size="xs" lineClamp={1}>
            {resolved.alias ?? `#${resolved.targetId}`}
          </Text>
        </Group>
      )}
    </Stack>
  );
}
