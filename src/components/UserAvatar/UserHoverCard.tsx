import type { Popover } from '@mantine/core';
import { HoverCard, Skeleton, Stack, Text } from '@mantine/core';
import dynamic from 'next/dynamic';
import type { ReactElement, ReactNode } from 'react';
import { createContext, useContext, useSyncExternalStore } from 'react';
import type { UserWithCosmetics } from '~/server/selectors/user.selector';
import { trpc } from '~/utils/trpc';
import { HOVER_CLOSE_DELAY_MS, HOVER_DELAY_MS } from './hover-card.constants';

// Loaded with the hover, not with the page. The creator card drags in profile
// cosmetics, live metrics and edge media, and a feed renders dozens of avatars
// that nobody hovers.
const SmartCreatorCard = dynamic(() =>
  import('~/components/CreatorCard/CreatorCard').then((m) => m.SmartCreatorCard)
);

/**
 * Wide enough that the creator card's top row never wraps — rank badge, up to
 * three stat badges and the cosmetic badge need about 385px.
 */
export const HOVER_CARD_WIDTH = 400;

// Defined in their own module so a consumer that wants only the timing does not
// take this component with it; re-exported here because every existing importer
// reads them from this path.
export { HOVER_CLOSE_DELAY_MS, HOVER_DELAY_MS } from './hover-card.constants';

/**
 * Above Mantine's default popover layer. A hover card is frequently rendered
 * inside another popover's target — the collection collaborator stack, for one
 * — and at equal z-index the portal mounted first loses, which put the creator
 * card behind the popover it was opened from.
 */
export const HOVER_CARD_Z_INDEX = 305;

/** Lets a scroll handler tell scrolling inside the card from scrolling the page. */
export const CREATOR_HOVER_DROPDOWN_CLASS = 'creator-hover-dropdown';

const NestedContext = createContext(false);

/** Suppresses hover cards inside a hover card. Read by `UserHoverCard`. */
export const useNestedHoverCard = () => useContext(NestedContext);

let hoverQuery: MediaQueryList | undefined;
const getHoverQuery = () => {
  hoverQuery ??= window.matchMedia('(hover: hover) and (pointer: fine)');
  return hoverQuery;
};

// One MediaQueryList and one subscription for the whole page, not one per
// avatar — a feed renders these by the hundred.
const subscribeHover = (onChange: () => void) => {
  const query = getHoverQuery();
  query.addEventListener('change', onChange);
  return () => query.removeEventListener('change', onChange);
};

/**
 * Hover cards are for pointers that hover. A touch tap synthesises `mouseover`
 * with no reliable `mouseout`, so on a phone the card opens on a tap meant for
 * the link underneath and then has no gesture that dismisses it.
 */
export function useHoverCapable() {
  return useSyncExternalStore(
    subscribeHover,
    () => getHoverQuery().matches,
    () => false
  );
}

/**
 * Peek at a creator without leaving the page.
 *
 * `withRoles` is off because the target is frequently a plain div, and even
 * where it is a button the dialog it would announce cannot be opened from the
 * keyboard — a hover card has no focus trigger.
 */
export function UserHoverCard({
  user,
  disabled,
  children,
}: {
  user: Pick<Partial<UserWithCosmetics>, 'id' | 'deletedAt'>;
  disabled?: boolean;
  children: ReactElement;
}) {
  const nested = useNestedHoverCard();
  const hoverCapable = useHoverCapable();
  const userId = user.id;

  if (disabled || nested || !hoverCapable || !userId || userId < 1 || !!user.deletedAt)
    return children;

  return (
    <HoverCard
      width={HOVER_CARD_WIDTH}
      shadow="sm"
      withArrow
      withinPortal
      withRoles={false}
      zIndex={HOVER_CARD_Z_INDEX}
      openDelay={HOVER_DELAY_MS}
      closeDelay={HOVER_CLOSE_DELAY_MS}
      position="bottom-start"
      offset={4}
    >
      <HoverCard.Target>{children}</HoverCard.Target>
      <CreatorHoverDropdown component={HoverCard.Dropdown}>
        <HoverCreatorCard userId={userId} />
      </CreatorHoverDropdown>
    </HoverCard>
  );
}

/**
 * The dropdown shared by the avatar and mention hover cards, so the two can't
 * drift on chrome or on nesting.
 *
 * The creator card carries its own padding and fills the dropdown edge to edge.
 * Its border is dropped rather than the dropdown's, so there is one outline
 * instead of two nested ones a pixel apart.
 */
export function CreatorHoverDropdown({
  component: Dropdown,
  children,
  onMouseEnter,
  onMouseLeave,
}: {
  component: typeof HoverCard.Dropdown | typeof Popover.Dropdown;
  children: ReactNode;
  onMouseEnter?: () => void;
  onMouseLeave?: () => void;
}) {
  return (
    <Dropdown
      p={0}
      className={`${CREATOR_HOVER_DROPDOWN_CLASS} max-w-[calc(100vw-2rem)] overflow-hidden`}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
    >
      <NestedContext.Provider value={true}>{children}</NestedContext.Provider>
    </Dropdown>
  );
}

/**
 * The creator card with its empty state held back.
 *
 * Given only an id it renders zeroed stats and a `[deleted]` name until its own
 * `getCreator` query lands — fine on a page, wrong in a dropdown that opens
 * already populated. This runs the same query first (same key, so the card's is
 * a cache hit) and shows the card only once there is something to show.
 *
 * A username-only mention costs the id lookup here too.
 */
export function HoverCreatorCard({
  userId,
  username,
  expectUsername,
}: {
  userId?: number | null;
  username?: string | null;
  /**
   * Refuse to show a creator other than this one. Set where the identity that
   * was verified (a mention's link target) isn't the one the query is keyed on.
   */
  expectUsername?: string | null;
}) {
  const { data, isLoading, isError } = trpc.user.getCreator.useQuery(
    userId ? { id: userId } : { username: username as string },
    { enabled: !!userId || !!username, staleTime: 5 * 60_000 }
  );

  const mismatched =
    !!expectUsername &&
    !!data?.username &&
    data.username.toLowerCase() !== expectUsername.toLowerCase();

  // Falling through on failure would show the zeroed `[deleted]` card the
  // skeleton exists to hide, which reads as an answer rather than a failure.
  if (isError || mismatched || (!isLoading && !userId && !data))
    return (
      <Text size="sm" c="dimmed" p="md">
        Couldn&apos;t load this creator.
      </Text>
    );

  const id = userId ?? data?.id;
  if (isLoading || !id) return <CreatorCardSkeleton />;

  return <SmartCreatorCard user={{ id }} withBorder={false} />;
}

/**
 * Shaped like the card it stands in for — banner, avatar, name, stat row — so
 * the dropdown doesn't resize under the cursor when the data lands, which on a
 * hover card can move the target out from under you.
 */
function CreatorCardSkeleton() {
  return (
    <Stack gap={0}>
      <Skeleton height={80} radius={0} />
      <div className="flex items-center gap-3 p-3">
        <Skeleton height={60} circle />
        <Stack gap={6} className="flex-1">
          <Skeleton height={14} width="55%" />
          <Skeleton height={10} width="35%" />
        </Stack>
      </div>
    </Stack>
  );
}
