import { Badge } from '@mantine/core';

/** Open slots left on a capped offering; nothing for an uncapped one. */
export function ServiceSlotsBadge({ slotsOpen }: { slotsOpen: number | null }) {
  if (slotsOpen == null) return null;
  const full = slotsOpen === 0;
  return (
    <Badge color={full ? 'gray' : 'green'} variant="light" radius="sm">
      {full ? 'Fully booked' : `${slotsOpen} slot${slotsOpen === 1 ? '' : 's'} open`}
    </Badge>
  );
}
