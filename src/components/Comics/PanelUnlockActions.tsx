import { Button, Text } from '@mantine/core';
import { IconExternalLink } from '@tabler/icons-react';
import { NSFW_CAPPED, NSFW_CAPPED_MESSAGE } from '~/shared/orchestrator/workflow-data';

/**
 * The CTA on a single-image panel in `RequireUnlock`. A capped output gets none: the yellow unlock
 * never lifts the workflow's rating cap, on this domain or on red.
 */
export function PanelUnlockActions({
  blockedReason,
  isGreen,
  unlockHref,
  isUnlocking,
  onUnlock,
}: {
  blockedReason: string | undefined;
  isGreen: boolean;
  unlockHref: string | null;
  isUnlocking: boolean;
  onUnlock: () => void;
}) {
  if (blockedReason === NSFW_CAPPED)
    return (
      <Text size="xs" c="dimmed" ta="center" px="xs">
        {NSFW_CAPPED_MESSAGE}
      </Text>
    );

  if (isGreen)
    return (
      <>
        <Text size="xs" c="dimmed" ta="center" px="xs">
          This generation can only be viewed on civitai.red.
        </Text>
        {unlockHref ? (
          <Button
            component="a"
            href={unlockHref}
            target="_blank"
            rel="noreferrer nofollow"
            size="compact-xs"
            color="red"
            variant="light"
            radius="xl"
            leftSection={<IconExternalLink size={12} />}
            onClick={(e: React.MouseEvent) => e.stopPropagation()}
          >
            Unlock on civitai.red
          </Button>
        ) : null}
      </>
    );

  return (
    <>
      <Text size="xs" c="dimmed" ta="center" px="xs">
        Unlock this content with{' '}
        <Text component="span" c="yellow" inherit>
          yellow
        </Text>{' '}
        Buzz!
      </Text>
      <Button
        size="compact-xs"
        color="yellow"
        variant="light"
        radius="xl"
        loading={isUnlocking}
        onClick={(e: React.MouseEvent) => {
          e.stopPropagation();
          onUnlock();
        }}
      >
        Unlock
      </Button>
    </>
  );
}
