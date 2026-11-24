import { Button } from '@mantine/core';
import { IconHome } from '@tabler/icons-react';
import { useNavBannersDismissed } from '~/components/AppLayout/NavAnnouncementSlot/nav-banners-dismissed';
import {
  eventHomeBlockCollapseId,
  eventHomeBlockDismissId,
  eventHomeBlockDisplay,
  flagRaceHomeKey,
} from '~/components/HomeBlocks/scored-event-home-block.utils';

/**
 * The way back for a viewer who hid the event's home block, or its home Flag Race row: the home page
 * has no trace of either.
 */
export function ShowEventHomeBlock({ event, title }: { event: string; title: string }) {
  return (
    <>
      <ShowHidden id={event} title={title} testId="show-event-home-block" />
      <ShowHidden
        id={flagRaceHomeKey(event)}
        title="the Flag Race"
        testId="show-flag-race-home-row"
      />
    </>
  );
}

function ShowHidden({ id, title, testId }: { id: string; title: string; testId: string }) {
  const { dismissed, restore } = useNavBannersDismissed();
  if (eventHomeBlockDisplay(id, dismissed) !== 'hidden') return null;

  return (
    <Button
      variant="subtle"
      color="gray"
      size="compact-sm"
      leftSection={<IconHome size={14} />}
      onClick={() => restore(eventHomeBlockDismissId(id), eventHomeBlockCollapseId(id))}
      data-testid={testId}
    >
      Show {title} on my home page
    </Button>
  );
}
