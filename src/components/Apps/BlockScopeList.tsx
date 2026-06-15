import { Badge, Group, Stack, Text } from '@mantine/core';
import { SCOPE_DESCRIPTIONS } from '~/server/services/blocks/scope-descriptions.constants';

/**
 * Renders a block's declared JWT scopes as a badge + friendly-description
 * list. Shared by the install/manage modal (pre-Save disclosure — UX audit
 * H3) and the /apps/installed "Apps & permissions" panel so the two surfaces
 * never drift. Unknown scopes (not in SCOPE_DESCRIPTIONS) render as a bare
 * badge with an italic "(no description)" — keeping the description map a soft
 * contract so new scopes ship without breaking the UI.
 */
export function BlockScopeList({
  scopes,
  emptyLabel = "This app doesn't claim any JWT scopes — it only consumes data from the host-bridge postMessage protocol.",
}: {
  scopes: string[];
  emptyLabel?: string;
}) {
  if (scopes.length === 0) {
    return (
      <Text size="xs" c="dimmed" fs="italic">
        {emptyLabel}
      </Text>
    );
  }
  return (
    <Stack gap={4}>
      {scopes.map((scope) => {
        const desc = SCOPE_DESCRIPTIONS[scope];
        return (
          <Group key={scope} gap="xs" wrap="nowrap" align="flex-start">
            <Badge size="sm" variant="light">
              {scope}
            </Badge>
            {desc ? (
              <Text size="xs" c="dimmed">
                {desc}
              </Text>
            ) : (
              <Text size="xs" c="dimmed" fs="italic">
                (no description)
              </Text>
            )}
          </Group>
        );
      })}
    </Stack>
  );
}
