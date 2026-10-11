import { useLocalStorage } from '@mantine/hooks';
import { useRouter } from 'next/router';
import { useEffect } from 'react';
import type { UserMenuItem } from '~/components/AppLayout/AppHeader/hooks';
import { eventMenuEntries } from '~/components/Events/event-promos';
import { useEventPromos } from '~/components/Events/useEventPromos';

/** A user-menu entry per playable event, NEW until the viewer has been to the event's page. */
export function useEventMenuItems(color?: string): UserMenuItem[] {
  const { asPath } = useRouter();
  const entries = eventMenuEntries(useEventPromos());
  const [seen, setSeen] = useLocalStorage<string[]>({ key: 'event-menu-seen', defaultValue: [] });
  const markSeen = (event: string) =>
    setSeen((current) => (current.includes(event) ? current : [...current, event]));

  // However they got there: the strip, a hat, a shared link.
  const path = asPath.split(/[?#]/)[0];
  const visiting = entries.find((e) => path === e.href || path.startsWith(`${e.href}/`))?.event;
  useEffect(() => {
    if (visiting) markSeen(visiting);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visiting]);

  return entries.map((entry) => ({
    href: entry.href,
    icon: entry.icon,
    color,
    label: entry.label,
    isNew: !seen.includes(entry.event),
    onNavigate: () => markSeen(entry.event),
  }));
}
