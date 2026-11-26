import type { BadgeProps } from '@mantine/core';
import { Badge } from '@mantine/core';
import { Tooltip } from '~/components/MantineOverlays';

/** For moderators, and for the owner of the article or challenge it covers. */
export function MatureRestrictedBadge({
  restricted,
  ...props
}: { restricted: boolean | null | undefined } & Omit<BadgeProps, 'children'>) {
  if (!restricted) return null;
  return (
    <Tooltip
      label="Made with a base model that restricts mature images: rated R or above, it is hidden from feeds, galleries, covers and search. Its uploader still sees it where the page is built for them, and moderators can open it by id."
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
