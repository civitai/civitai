import { Button, Group, Stack, Text } from '@mantine/core';
import { trpc } from '~/utils/trpc';

/**
 * The per-source half of `apps:storage:import`, one row per source with a Remove. "Not allowed"
 * also covers a grant a later version widened past, and Remove still deletes it.
 */
export function StorageImportGrants({
  appBlockId,
  appName,
}: {
  appBlockId: string;
  appName: string;
}) {
  const utils = trpc.useUtils();
  const query = trpc.blocks.getStorageImports.useQuery({ appBlockId });
  const revoke = trpc.blocks.revokeStorageImport.useMutation({
    onSettled: () => {
      void utils.blocks.getStorageImports.invalidate({ appBlockId });
    },
  });
  const imports = query.data?.imports ?? [];
  if (imports.length === 0) return null;
  return (
    <Stack gap={4} data-testid="storage-import-grants">
      <Text size="xs" fw={600}>
        Your data in other apps
      </Text>
      {imports.map((i) => (
        <Group key={i.from} justify="space-between" wrap="nowrap" gap="xs">
          <Text size="xs">
            {appName} {i.access === 'readwrite' ? 'reads and changes' : 'reads'} your{' '}
            {i.collections.join(', ')} in <strong>{i.sourceName ?? i.from}</strong>
            {i.granted ? '' : ' — not allowed'}
          </Text>
          {i.hasGrant && i.sourceAppBlockId ? (
            <Button
              size="compact-xs"
              variant="subtle"
              color="red"
              loading={
                revoke.isPending && revoke.variables?.sourceAppBlockId === i.sourceAppBlockId
              }
              onClick={() =>
                revoke.mutate({ appBlockId, sourceAppBlockId: i.sourceAppBlockId as string })
              }
            >
              Remove
            </Button>
          ) : null}
        </Group>
      ))}
      {revoke.error ? (
        <Text size="xs" c="red">
          {revoke.error.message}
        </Text>
      ) : null}
    </Stack>
  );
}
