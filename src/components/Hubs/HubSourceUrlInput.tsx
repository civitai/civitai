import { Button, Group, TextInput } from '@mantine/core';
import { IconLink } from '@tabler/icons-react';
import { useState } from 'react';
import type { UserHubSourceType } from '~/shared/utils/prisma/enums';
import { showErrorNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';

/**
 * Paste a Civitai link and get the source it names. The type is detected from the
 * URL rather than picked, and resolution happens server-side so the parser sees
 * the real domain list instead of whatever the browser is on.
 */
export function HubSourceUrlInput({
  onResolved,
  disabled,
}: {
  onResolved: (source: { type: UserHubSourceType; targetId: number; alias: string }) => void;
  disabled?: boolean;
}) {
  const [url, setUrl] = useState('');
  const utils = trpc.useUtils();
  const [resolving, setResolving] = useState(false);

  const resolve = async () => {
    const trimmed = url.trim();
    if (!trimmed) return;
    setResolving(true);
    try {
      // `fetch` serves the react-query cache when it can; a link resolves against
      // whatever the target is right now, so this one always goes to the server.
      const source = await utils.userHub.resolveSource.fetch({ url: trimmed }, { staleTime: 0 });
      if (!source) {
        showErrorNotification({
          title: 'Could not read that link',
          error: new Error(
            'Paste a link to a creator, a model, a model version or a collection on Civitai.'
          ),
        });
        return;
      }
      onResolved({ ...source, alias: source.alias ?? '' });
      setUrl('');
    } finally {
      setResolving(false);
    }
  };

  return (
    <Group gap="xs" wrap="nowrap" align="flex-start">
      <TextInput
        className="flex-1"
        size="xs"
        leftSection={<IconLink size={14} />}
        placeholder="…or paste a Civitai link"
        value={url}
        disabled={disabled}
        onChange={(event) => setUrl(event.currentTarget.value)}
        onKeyDown={(event) => {
          if (event.key !== 'Enter') return;
          event.preventDefault();
          void resolve();
        }}
      />
      <Button size="xs" variant="light" loading={resolving} disabled={disabled} onClick={resolve}>
        Add
      </Button>
    </Group>
  );
}
