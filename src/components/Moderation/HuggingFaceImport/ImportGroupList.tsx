import { Anchor, Badge, Group, Stack, Text } from '@mantine/core';
import type { ReactNode } from 'react';
import { DaysFromNow } from '~/components/Dates/DaysFromNow';
import { ImportItemCard } from '~/components/Moderation/HuggingFaceImport/ImportItemCard';
import { RenameGroupControl } from '~/components/Moderation/HuggingFaceImport/RenameGroupControl';
import type { ImportActions } from '~/components/Moderation/HuggingFaceImport/use-import-actions';
import { byGroup } from '~/components/Moderation/HuggingFaceImport/utils';
import dayjs from '~/shared/utils/dayjs';
import type { HuggingFaceImportView } from '~/server/services/huggingface-import.service';
import { formatBytes } from '~/utils/number-helpers';

const STALE_DAYS = 60;

/**
 * Imports as a list of groups, each holding its files. The group is the unit a moderator works in —
 * a repo is queued as one batch and attached to one version — so it is what carries the repo,
 * revision and rename control, and the files below it carry only themselves.
 */
export function ImportGroupList({
  rows,
  actions,
  groupAction,
}: {
  rows: HuggingFaceImportView[];
  actions: ImportActions;
  /** Rendered at the end of a group's header — the unattached tab deletes a whole group there. */
  groupAction?: (items: HuggingFaceImportView[]) => ReactNode;
}) {
  return (
    <Stack gap="lg">
      {byGroup(rows).map((group) => (
        <Stack key={`${group.groupName}:${group.repo}:${group.revision}`} gap="xs">
          <Group gap="xs" wrap="wrap">
            <Text fw={600} size="sm">
              {group.groupName}
            </Text>
            <RenameGroupControl
              repo={group.repo}
              revision={group.revision}
              groupName={group.groupName}
            />
            {/* The revision, not the branch someone pasted: a branch moves, and this is the commit
                the files actually came from. */}
            <Anchor
              size="xs"
              target="_blank"
              href={`https://huggingface.co/${group.repo}/tree/${group.revision}`}
              title={`Open ${group.repo} at ${group.revision}`}
            >
              <Badge size="xs" variant="light" color="gray" style={{ cursor: 'pointer' }}>
                {group.repo}
              </Badge>
            </Anchor>
            <Badge size="xs" variant="light">
              {group.revision.slice(0, 7)}
            </Badge>
            <Text size="xs" c="dimmed">
              {group.items.length} file{group.items.length === 1 ? '' : 's'} ·{' '}
              {formatBytes(group.bytes)} · imported <DaysFromNow date={group.oldest} />
            </Text>
            {dayjs().diff(dayjs(group.oldest), 'day') >= STALE_DAYS && (
              <Badge size="xs" color="red">
                stale
              </Badge>
            )}
            {groupAction && <Group ml="auto">{groupAction(group.items)}</Group>}
          </Group>

          {group.items.map((row) => (
            <ImportItemCard key={row.id} row={row} {...actions} />
          ))}
        </Stack>
      ))}
    </Stack>
  );
}
