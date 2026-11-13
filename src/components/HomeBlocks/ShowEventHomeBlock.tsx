import { Button } from '@mantine/core';
import { IconHome } from '@tabler/icons-react';
import { useNavBannersDismissed } from '~/components/AppLayout/NavAnnouncementSlot/nav-banners-dismissed';
import {
  eventHomeBlockCollapseId,
  eventHomeBlockDismissId,
  eventHomeBlockDisplay,
} from '~/components/HomeBlocks/scored-event-home-block.utils';

/** The way back for a viewer who hid the event's home block: the home page has no trace of it. */
export function ShowEventHomeBlock({ event, title }: { event: string; title: string }) {
  const { dismissed, restore } = useNavBannersDismissed();
  if (eventHomeBlockDisplay(event, dismissed) !== 'hidden') return null;

  return (
    <Button
      variant="subtle"
      color="gray"
      size="compact-sm"
      leftSection={<IconHome size={14} />}
      onClick={() => restore(eventHomeBlockDismissId(event), eventHomeBlockCollapseId(event))}
      data-testid="show-event-home-block"
    >
      Show {title} on my home page
    </Button>
  );
}
