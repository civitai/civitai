import type { BadgeProps } from '@mantine/core';
import { Badge } from '@mantine/core';
import { Tooltip } from '~/components/MantineOverlays';

/** Moderator screens only; never a user-facing page. */
export function MatureRestrictedBadge({
  restricted,
  ...props
}: { restricted: boolean | null | undefined } & Omit<BadgeProps, 'children'>) {
  if (!restricted) return null;
  return (
    <Tooltip
      label="Made with a base model that restricts mature images: rated R or above, the site hides it from everyone but its uploader and moderators opening it by id."
      multiline
      w={260}
      withinPortal
    >
      <Badge color="orange" variant="filled" {...props}>
        MatureRestricted
      </Badge>
    </Tooltip>
  );
}
