import { Badge, Popover, Text, UnstyledButton } from '@mantine/core';
import type { MouseEvent } from 'react';
import clsx from 'clsx';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';

/**
 * The label on every paid promotion. A tap target rather than a hover card, so
 * the explanation reaches a phone too.
 */
export function SponsoredBadge({
  className,
  kind,
}: {
  className?: string;
  kind: 'post' | 'model';
}) {
  const features = useFeatureFlags();
  if (!features.creatorPromotions) return null;

  return (
    <Popover width={260} withArrow withinPortal position="bottom-start">
      <Popover.Target>
        <UnstyledButton
          className={clsx('z-10', className)}
          aria-label="Sponsored: why am I seeing this?"
          onClick={(event: MouseEvent) => {
            event.preventDefault();
            event.stopPropagation();
          }}
        >
          <Badge size="sm" radius="sm" variant="filled" color="yellow.7">
            Sponsored
          </Badge>
        </UnstyledButton>
      </Popover.Target>
      <Popover.Dropdown px="md" py={8}>
        <Text size="sm" fw={600}>
          Why am I seeing this?
        </Text>
        <Text size="xs">
          A creator paid Buzz to show this {kind} here. The owner of this page reviewed it, accepted
          it, and earns from it.
        </Text>
      </Popover.Dropdown>
    </Popover>
  );
}
