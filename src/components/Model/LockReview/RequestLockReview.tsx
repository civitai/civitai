import { Anchor, Menu, Text, Tooltip } from '@mantine/core';
import { IconLock } from '@tabler/icons-react';
import { useLockReviewAction } from '~/components/Model/LockReview/useLockReviewAction';

type Model = Parameters<typeof useLockReviewAction>[0];

export function RequestLockReviewMenuItem({ model }: { model: Model }) {
  const action = useLockReviewAction(model);
  if (!action.show) return null;

  return (
    <Tooltip label={action.tooltip} disabled={!action.tooltip} position="left" withinPortal>
      <div>
        <Menu.Item
          leftSection={<IconLock size={14} stroke={1.5} />}
          disabled={action.disabled}
          onClick={action.open}
        >
          {action.label}
        </Menu.Item>
      </div>
    </Tooltip>
  );
}

/** Shown beside "Locked by moderator" on the model edit form. */
export function RequestLockReviewLink({ model }: { model: Model }) {
  const action = useLockReviewAction(model);
  if (!action.show) return null;

  if (action.disabled)
    return (
      <Tooltip label={action.tooltip} disabled={!action.tooltip} withinPortal>
        <Text size="xs" c="dimmed" span>
          {action.label}
        </Text>
      </Tooltip>
    );

  return (
    <Anchor component="button" type="button" size="xs" onClick={action.open}>
      Request review
    </Anchor>
  );
}
