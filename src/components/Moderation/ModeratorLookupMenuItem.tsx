import { Menu } from '@mantine/core';
import { IconInfoCircle } from '@tabler/icons-react';
import React from 'react';
import { env } from '~/env/client';

/**
 * A `Menu.Item` linking out to the moderator app.
 *
 * 🔴 `stopPropagation` is load-bearing, not defensive. These menus open from inside a `NextLink` card,
 * and React propagates events out of the dropdown's portal through the React tree — so without it the
 * card's link handler takes the click, calls `preventDefault()` and routes to the card instead. The
 * symptom is a link that works only via "open in new tab", because next/link ignores modified clicks.
 */
export function ModeratorLookupMenuItem({
  path,
  children,
}: {
  /** A builder result from `~/shared/constants/moderator-app` — a path, never a full URL. */
  path: string;
  children: React.ReactNode;
}) {
  return (
    <Menu.Item
      component="a"
      target="_blank"
      onClick={(e: React.MouseEvent) => e.stopPropagation()}
      leftSection={<IconInfoCircle size={14} stroke={1.5} />}
      href={`${env.NEXT_PUBLIC_MODERATOR_APP_URL}${path}`}
    >
      {children}
    </Menu.Item>
  );
}
