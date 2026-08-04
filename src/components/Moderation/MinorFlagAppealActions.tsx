import { Button, Group, Text, Tooltip } from '@mantine/core';
import { openConfirmModal } from '@mantine/modals';
import type { MinorFlagAppealRow } from '~/server/services/minor-hash.service';

export type MinorFlagAppealActionRow = Pick<
  MinorFlagAppealRow,
  'modelId' | 'modelName' | 'minor' | 'prevNsfw' | 'prevGalleryLevel'
>;

export function MinorFlagAppealActions({
  row,
  pending,
  onResolve,
}: {
  row: MinorFlagAppealActionRow;
  pending?: 'uphold' | 'overturn';
  onResolve: (uphold: boolean) => void;
}) {
  return (
    <Group gap="xs" justify="flex-end" wrap="nowrap">
      {/* Upholding a flag that is no longer in force writes nothing but still
          notifies the uploader that their request was denied — a false statement
          about a child-safety restriction. Wrapped in a span because a disabled
          button emits no pointer events for the tooltip to hang off. */}
      <Tooltip
        label="This model is no longer flagged as minor, so there is nothing to uphold. Unflag closes the request."
        disabled={row.minor}
        multiline
        w={260}
        withArrow
      >
        <span>
          <Button
            size="compact-sm"
            disabled={!row.minor}
            loading={pending === 'uphold'}
            onClick={() =>
              openConfirmModal({
                title: 'Deny review request',
                centered: true,
                labels: { confirm: 'Keep flagged', cancel: 'Cancel' },
                children: (
                  <Text size="sm">
                    Keep <strong>{row.modelName}</strong> flagged as minor and tell the uploader
                    their request was denied. This also records your sign-off, so a bulk rollback
                    can no longer undo the flag.
                  </Text>
                ),
                onConfirm: () => onResolve(true),
              })
            }
          >
            Keep flagged
          </Button>
        </span>
      </Tooltip>
      <Button
        size="compact-sm"
        variant="light"
        color="red"
        loading={pending === 'overturn'}
        onClick={() =>
          openConfirmModal({
            title: 'Grant review request',
            centered: true,
            labels: { confirm: 'Unflag', cancel: 'Cancel' },
            confirmProps: { color: 'red' },
            children: (
              <Text size="sm">
                Unflag <strong>{row.modelName}</strong>, restore the settings it had before it was
                flagged
                {row.prevNsfw ? ', including its NSFW flag' : ''}
                {row.prevGalleryLevel != null ? ` and gallery level ${row.prevGalleryLevel}` : ''},
                and tell the uploader their request was granted.
              </Text>
            ),
            onConfirm: () => onResolve(false),
          })
        }
      >
        Unflag
      </Button>
    </Group>
  );
}
