import { useLocalStorage } from '@mantine/hooks';
import { useEffect } from 'react';
import type { UserMenuItem } from '~/components/AppLayout/AppHeader/hooks';
import { eventMenuEntries } from '~/components/Events/event-promos';
import { useEventPromos } from '~/components/Events/useEventPromos';

const useSeenEvents = () => useLocalStorage<string[]>({ key: 'event-menu-seen', defaultValue: [] });

/** A user-menu entry per playable event, NEW until the viewer has been to the event's pages. */
export function useEventMenuItems(color?: string): UserMenuItem[] {
  const [seen] = useSeenEvents();
  return eventMenuEntries(useEventPromos()).map((entry) => ({
    href: entry.href,
    icon: entry.icon,
    color,
    label: entry.label,
    isNew: !seen.includes(entry.event),
  }));
}

/** On the event's own pages, so a visit by any route clears the menu's NEW. */
export function useMarkEventVisited(event: string) {
  const [, setSeen] = useSeenEvents();
  useEffect(() => {
    setSeen((current) => (current.includes(event) ? current : [...current, event]));
  }, [event, setSeen]);
}
