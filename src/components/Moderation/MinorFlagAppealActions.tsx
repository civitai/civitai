import { Button, Group, Menu, Text, Tooltip } from '@mantine/core';
import { openConfirmModal } from '@mantine/modals';
import { appealRowState } from '~/components/Moderation/appeal-row-state';
import type { AppealLabelDecision, MinorFlagAppealRow } from '~/server/services/minor-hash.service';

export type MinorFlagAppealActionRow = Pick<
  MinorFlagAppealRow,
  | 'modelId'
  | 'modelName'
  | 'minor'
  | 'poi'
  | 'prevNsfw'
  | 'prevGalleryLevel'
  | 'flagSource'
  | 'flagConfirmedFrom'
  | 'textScanFlags'
>;

type SplitLabels = { minor: AppealLabelDecision; poi: AppealLabelDecision };

export function MinorFlagAppealActions({
  row,
  pending,
  onResolve,
}: {
  row: MinorFlagAppealActionRow;
  pending?: 'uphold' | 'overturn' | 'split';
  onResolve: (uphold: boolean, labels?: SplitLabels) => void;
}) {
  const { anyFlagged, bothFlagged } = appealRowState(row);

  const confirmSplit = (labels: SplitLabels) =>
    openConfirmModal({
      title: 'Rule on each flag',
      centered: true,
      labels: { confirm: 'Apply', cancel: 'Cancel' },
      children: (
        <Text size="sm">
          {labels.minor === 'uphold' ? 'Keep' : 'Lift'} the minor flag and{' '}
          {labels.poi === 'uphold' ? 'keep' : 'lift'} the real-person flag on{' '}
          <strong>{row.modelName}</strong>. The uploader is told their request was granted.
        </Text>
      ),
      onConfirm: () => onResolve(false, labels),
    });

  return (
    <Group gap="xs" justify="flex-end" wrap="nowrap">
      {/* Upholding a flag that is no longer in force writes nothing but still
          notifies the uploader that their request was denied — a false statement
          about a child-safety restriction. Wrapped in a span because a disabled
          button emits no pointer events for the tooltip to hang off. */}
      <Tooltip
        label="This model is no longer flagged, so there is nothing to uphold. Unflag closes the request."
        disabled={anyFlagged}
        multiline
        w={260}
        withArrow
      >
        <span>
          <Button
            size="compact-sm"
            disabled={!anyFlagged}
            loading={pending === 'uphold'}
            onClick={() =>
              openConfirmModal({
                title: 'Deny review request',
                centered: true,
                labels: { confirm: 'Keep flagged', cancel: 'Cancel' },
                children: (
                  <Text size="sm">
                    Keep <strong>{row.modelName}</strong> flagged and tell the uploader their
                    request was denied. This also records your sign-off, so a bulk rollback can no
                    longer undo the flag.
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
      {bothFlagged && (
        <Menu position="bottom-end" withinPortal>
          <Menu.Target>
            <Button size="compact-sm" variant="default" loading={pending === 'split'}>
              Split
            </Button>
          </Menu.Target>
          <Menu.Dropdown>
            <Menu.Item onClick={() => confirmSplit({ minor: 'uphold', poi: 'overturn' })}>
              Keep minor, lift real person
            </Menu.Item>
            <Menu.Item onClick={() => confirmSplit({ minor: 'overturn', poi: 'uphold' })}>
              Lift minor, keep real person
            </Menu.Item>
          </Menu.Dropdown>
        </Menu>
      )}
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
