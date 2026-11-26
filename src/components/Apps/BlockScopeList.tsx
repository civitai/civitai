import { Badge, Group, Stack, Text } from '@mantine/core';
import { useId } from 'react';
import { blockScopeGroups } from '~/components/Apps/listingPermissions';
import { SensitiveScopeBadge } from '~/components/Apps/SensitiveScopeBadge';
import { isSensitiveBlockScope } from '~/shared/constants/block-scope.constants';
import { SCOPE_DESCRIPTIONS } from '~/server/services/blocks/scope-descriptions.constants';

/**
 * Block scope ids as a badge + description list, for surfaces where the exact id is the point:
 * today the moderator's view of a listing under review (`AppListingDetailBody`'s preview branch,
 * fed the RAW `approved_scopes`). Anything a viewer reads about their own permissions —
 * store listing, consent prompt, details modal, settings, the permissions drawer and
 * /apps/activity — uses the plain-language `ListingPermissionGroups` instead.
 *
 * Grouped and ordered by `blockScopeGroups` (the store listing's `groupListingPermissions`), with
 * the store listing's heading rule: the sensitive group is always named; the other group is named
 * only when there is a sensitive group to tell it apart from. Unknown scopes (not in
 * SCOPE_DESCRIPTIONS) render as a bare badge with an italic "(no description)", last in "Other".
 *
 * 🔴 THE SCOPE ID IS NEVER TRUNCATED. Mantine's Badge label ellipsises by default; the label
 * classes let it wrap (mid-token — an id has no spaces) and `h="auto"` lets the badge root grow
 * with it. `text-start` keeps a wrapped id from centring.
 */
export function BlockScopeList({
  scopes,
  emptyLabel = "This app doesn't request any permissions — it only consumes data from the host-bridge postMessage protocol.",
}: {
  scopes: string[];
  emptyLabel?: string;
}) {
  const groupId = useId();
  if (scopes.length === 0) {
    return (
      <Text size="xs" c="dimmed" fs="italic">
        {emptyLabel}
      </Text>
    );
  }
  const groups = blockScopeGroups(scopes);
  const hasSensitive = groups.some((g) => g.key === 'sensitive');

  return (
    <Stack gap="md" data-testid="block-scope-list">
      {groups.map((g) => {
        const named = g.key === 'sensitive' || hasSensitive;
        return (
          <Stack
            key={g.key}
            gap="xs"
            data-scope-group={g.key}
            role={named ? 'group' : undefined}
            aria-labelledby={named ? `${groupId}-${g.key}` : undefined}
          >
            {named ? (
              <Text
                id={`${groupId}-${g.key}`}
                size="sm"
                fw={600}
                c={g.key === 'sensitive' ? 'orange' : undefined}
                data-testid="block-scope-group-label"
              >
                {g.label} ({g.scopes.length})
              </Text>
            ) : null}
            {/* The gap between rows must exceed the one inside a row, or the list stops saying
                which description belongs to which id. */}
            <Stack gap="xs" role="list">
              {g.scopes.map((scope) => (
                <BlockScopeRow key={scope} scope={scope} />
              ))}
            </Stack>
          </Stack>
        );
      })}
    </Stack>
  );
}

function BlockScopeRow({ scope }: { scope: string }) {
  const desc = SCOPE_DESCRIPTIONS[scope];
  const sensitive = isSensitiveBlockScope(scope);
  return (
    <Stack gap={2} role="listitem" data-testid="block-scope-row">
      {/* `wrap="nowrap"` keeps the "Sensitive" marker beside the id it qualifies. */}
      <Group gap="xs" wrap="nowrap" align="center">
        <Badge
          size="sm"
          variant="light"
          color={sensitive ? 'orange' : undefined}
          h="auto"
          classNames={{ label: 'whitespace-normal break-all text-start' }}
          data-testid="block-scope-id"
        >
          {scope}
        </Badge>
        {sensitive && <SensitiveScopeBadge size="sm" />}
      </Group>
      {desc ? (
        <Text size="xs" c="dimmed">
          {desc}
        </Text>
      ) : (
        <Text size="xs" c="dimmed" fs="italic">
          (no description)
        </Text>
      )}
    </Stack>
  );
}
