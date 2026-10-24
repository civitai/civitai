import { Menu, Tooltip } from '@mantine/core';
import { IconInfoCircle } from '@tabler/icons-react';
import React from 'react';
import { LegacyActionIcon } from '~/components/LegacyActionIcon/LegacyActionIcon';
import { env } from '~/env/client';

/** The one place the moderator app's base is joined to a path built by `~/shared/constants/moderator-app`. */
export const moderatorAppUrl = (path: string) => `${env.NEXT_PUBLIC_MODERATOR_APP_URL}${path}`;

/**
 * 🔴 `stopPropagation` is load-bearing, not defensive. These open from inside a `NextLink` card, and
 * React propagates events out of the dropdown's portal through the React tree — so without it the
 * card's link handler takes the click, calls `preventDefault()` and routes to the card instead. The
 * symptom is a link that works only via "open in new tab", because next/link ignores modified clicks.
 */
const swallowCardClick = (e: React.MouseEvent) => e.stopPropagation();

/** A `Menu.Item` linking out to the moderator app. */
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
      onClick={swallowCardClick}
      leftSection={<IconInfoCircle size={14} stroke={1.5} />}
      href={moderatorAppUrl(path)}
    >
      {children}
    </Menu.Item>
  );
}

/** The same link where there is no menu to put it in — a row of badges or icons. */
export function ModeratorLookupIcon({ path, label }: { path: string; label: string }) {
  return (
    <Tooltip label={label} withArrow>
      <LegacyActionIcon
        component="a"
        href={moderatorAppUrl(path)}
        target="_blank"
        rel="noreferrer"
        onClick={swallowCardClick}
        variant="subtle"
        size="sm"
        color="gray"
        aria-label={label}
      >
        <IconInfoCircle size={14} stroke={1.5} />
      </LegacyActionIcon>
    </Tooltip>
  );
}
