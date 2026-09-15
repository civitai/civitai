import { Button, Group, Menu, Text, Tooltip } from '@mantine/core';
import { useLocalStorage } from '@mantine/hooks';
import { IconCaretDown, IconPointFilled } from '@tabler/icons-react';
import clsx from 'clsx';
import { useRouter } from 'next/router';
import { useMemo, useState } from 'react';
import { NextLink as Link } from '~/components/NextLink/NextLink';
import { navIcons } from '~/components/HomeContentToggle/nav-icons';
import { navRegistry, type NavRegistryEntry } from '~/components/HomeContentToggle/nav-registry';
import { resolveNavItems } from '~/components/HomeContentToggle/resolve-nav-items';
import { useCurrentUserSettings } from '~/components/UserSettings/hooks';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { getDisplayName } from '~/utils/string-helpers';
import { trpc } from '~/utils/trpc';
import { isDefined } from '~/utils/type-guards';
import classes from './HomeContentToggle.module.css';

/**
 * The user's resolved sub nav. Placement comes from their saved config rather than the viewport —
 * the container queries that used to move `grouped` items in and out of the More menu by width
 * are gone, and `defaultPlacement` in the registry carries what they used to decide.
 */
export function useResolvedNav() {
  const features = useFeatureFlags();
  const currentUser = useCurrentUser();
  const settings = useCurrentUserSettings();

  return useMemo(
    () => resolveNavItems(navRegistry, { features, isAuthed: !!currentUser }, settings.navigation),
    [features, currentUser, settings.navigation]
  );
}

export function HomeTabs() {
  const router = useRouter();
  const activePath = router.pathname.split('/')[1] || 'home';
  const { bar, more, showLabels } = useResolvedNav();

  const [moreOpened, setMoreOpened] = useState(false);
  const [lastSeenChangelog] = useLocalStorage<number>({
    key: 'last-seen-changelog',
    defaultValue: 0,
    getInitialValueInEffect: false,
  });
  const { data: latestChangelog } = trpc.changelog.getLatest.useQuery();

  const hasUnreadChangelog = (latestChangelog ?? 0) > lastSeenChangelog;
  const isActive = (entry: NavRegistryEntry) =>
    entry.activeMatch
      ? router.pathname.startsWith(entry.activeMatch)
      : activePath === entry.key || (activePath === 'changelog' && entry.key === 'updates');

  const dot = (entry: NavRegistryEntry, className?: string) => {
    if (entry.key === 'updates' && hasUnreadChangelog)
      return <IconPointFilled color="green" size={10} className={className} />;
    if (entry.new && entry.new > new Date())
      return <IconPointFilled color="green" size={10} aria-label="New" className={className} />;
    return null;
  };

  return (
    // Horizontal padding only, and it is load-bearing: `overflow-x: auto` clips at the padding box,
    // and an outline contributes no scrollable overflow, so without it the first pill's focus ring
    // is cut on the left and the last control's on the right with no way to scroll them into view.
    // No VERTICAL padding — it would make the bar taller on every page, which Justin declined on
    // review and which is not worth paying site-wide for a ring edge. The vertical ring is
    // therefore clipped outright: the row's height is its 32px children exactly, so unlike before
    // (when the 36px More button left 2px of slack) none of it shows.
    //
    // Not `px-1`: Mantine's ring is a `2px` outline at `calc(0.125rem * var(--mantine-scale))`
    // offset, so a pure-rem class matches the ink only at a 16px root with scale 1. 4px at
    // defaults.
    //
    // `flex-1` keeps `SubNav2`'s feed filters on this same line. That container wraps, and a
    // wrapping container places items at their flex BASIS before shrinking any of them, so at the
    // default `basis: auto` this row's ~1334px of content does not fit and the filters wrap to a
    // second line. `basis: 0` lets both share the line and this row absorb the shortfall by
    // scrolling. `shrink-0` on the More button below is the other half: the shrink then lands on
    // the children, and More is the one that collapses — to an empty 28px circle.
    <div className="flex flex-1 items-center gap-1 overflow-x-auto overflow-y-hidden px-[calc(0.125rem*var(--mantine-scale,1)+2px)] text-black dark:text-white">
      {bar.map((entry) => {
        const label = getDisplayName(entry.key);
        // Mantine's `disabled` only gates the Transition, not the portal — a disabled Tooltip
        // still appends a div to document.body per item and pays useFloating on every render of
        // a component that re-renders on every navigation. Nobody has a saved config on day one,
        // so `showLabels` is true for everyone: wrap only when the tooltip can actually open.
        const button = (
          <Button
            key={entry.key}
            variant="default"
            component={Link}
            href={entry.url}
            // Icon-only tabs lose their accessible name with the text, so it moves to the label.
            aria-label={showLabels ? undefined : label}
            className={clsx('h-8 overflow-visible rounded-full border-none py-2', {
              ['pl-3 pr-4']: showLabels,
              ['px-3']: !showLabels,
              ['bg-gray-4 dark:bg-dark-4']: isActive(entry),
              [classes.tabHighlight]: entry.key === 'shop',
            })}
            classNames={{ label: 'flex gap-2 items-center capitalize overflow-visible' }}
          >
            {navIcons[entry.key]({ size: 16 })}
            {showLabels && <span className="text-base font-medium capitalize">{label}</span>}
            {dot(entry, '-ml-1 -mr-2')}
          </Button>
        );

        return showLabels ? (
          button
        ) : (
          <Tooltip
            key={entry.key}
            // The SAME `capitalize` transform the pill's label uses, rather than a title-cased
            // copy of the string — a helper would be a second source of casing free to drift
            // from the CSS, which is what made the tooltip read "models" beside a pill reading
            // "Models".
            label={<span className="capitalize">{label}</span>}
            withinPortal
          >
            {button}
          </Tooltip>
        );
      })}
      {more.length > 0 && (
        <Menu position="bottom-end" onChange={setMoreOpened}>
          <Menu.Target>
            <Button
              radius="xl"
              size="sm"
              color="gray"
              variant="subtle"
              data-active={moreOpened}
              className={clsx('h-8 shrink-0', classes.moreButton)}
            >
              <Group gap={4} wrap="nowrap">
                More
                <IconCaretDown size={16} fill="currentColor" />
              </Group>
            </Button>
          </Menu.Target>
          <Menu.Dropdown>
            {more.map((entry) => (
              <Link legacyBehavior key={entry.key} href={entry.url} passHref>
                <Menu.Item
                  component="a"
                  leftSection={navIcons[entry.key]({ size: 16 })}
                  className={clsx(
                    entry.classes
                      ?.map((c) =>
                        classes.hasOwnProperty(c) ? classes[c as keyof typeof classes] : null
                      )
                      .filter(isDefined)
                  )}
                >
                  <Group gap={4} wrap="nowrap">
                    <Text tt="capitalize">{getDisplayName(entry.key)}</Text>
                    {dot(entry)}
                  </Group>
                </Menu.Item>
              </Link>
            ))}
          </Menu.Dropdown>
        </Menu>
      )}
    </div>
  );
}
